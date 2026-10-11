// ServoCtl - control hobby servos from a PC over USB serial.
//
// Wiring (LaskaKit Maxi Starter Kit v2, Lekce 27): brown -> GND, red -> 5V, orange -> signal.
// Servo 1's signal goes to D9, servo 2's to D10 (SERVO_PINS below).
//
// Protocol: 115200 baud, one text command per line, case-insensitive. An "N:" prefix picks
// the servo ("2:A 90"); without one a command goes to servo 1. "*:" means every servo for
// X, OFF, ON, C, H and W. Every command gets exactly one reply line starting with "OK" or
// "ERR", in the order the commands were sent. Lines starting with '#' are informational
// (banner, HELP). Lines starting with '!' are events: "! done servo=N pos=<deg>" when a
// servo's motion has finished.
// Full documentation: README.md in the parent folder.

#include <Servo.h>
#include <EEPROM.h>
#include <stddef.h>

#define FW_VERSION "2.0"

const uint8_t SERVO_PINS[] = {9, 10};
const uint8_t NUM_SERVOS = sizeof(SERVO_PINS);
const long BAUD = 115200;

// Absolute pulse-width bounds in microseconds; nothing outside this range is ever sent.
const int HARD_MIN_US = 500;
const int HARD_MAX_US = 2500;

const unsigned long MAX_MS = 3600000UL;  // longest accepted duration (1 hour)

// EEPROM holds a magic number and then one checksummed record per servo, so adding a
// servo later keeps the saved settings of the others.
const uint16_t EE_MAGIC = 0x53C2;  // change whenever the Config layout changes
const int EE_FIRST_RECORD = 4;

struct Config {
  int16_t minUs;  // pulse width at 0 degrees
  int16_t maxUs;  // pulse width at `range` degrees; may be below minUs to reverse direction
  float range;    // degrees covered between minUs and maxUs
  float lo, hi;   // soft limits in degrees
  float speed;    // deg/s for A, STEP, U, C, H and TAP; 0 = as fast as the servo can
  float home;     // angle taken at power-up
  uint8_t ease;   // 1 = smooth start/stop for M and SWEEP
};

struct Record {
  Config cfg;
  uint8_t checksum;
};

enum Mode : uint8_t { M_IDLE, M_MOVE, M_SWEEP, M_TAP };

struct Channel {
  Config cfg;
  Servo servo;
  bool attached;
  float curUs;    // pulse width being output right now
  int writtenUs;  // last value handed to the Servo library
  // The active segment moves curUs from segFrom to segTo over segDur milliseconds.
  bool segActive;
  float segFrom, segTo;
  unsigned long segStart, segDur;
  bool segEase;
  Mode mode;
  float swA, swB;              // sweep ends, us
  unsigned long swLeg;         // ms per leg
  unsigned long swCyclesLeft;  // 0 = forever
  uint8_t swPhase;             // 0 = approaching A, 1 = A->B, 2 = B->A
  float tapBack;               // where TAP returns to, us
  unsigned long tapHold;
  uint8_t tapPhase;  // 0 = going out, 1 = holding, 2 = coming back
};

Channel ch[NUM_SERVOS];

const uint8_t ALL = 0xFF;  // selector value for "*:"

bool waitPending = false;
uint8_t waitTarget;  // servo index, or ALL
bool waitHasDeadline;
unsigned long waitDeadline;

char line[64];
uint8_t lineLen = 0;
bool lineOverflow = false;

const uint8_t MAX_TOKENS = 6;  // servo prefix + command + up to 4 arguments
char *tok[MAX_TOKENS];
uint8_t ntok;
uint8_t sel;    // servo index the command is for, or ALL
bool selGiven;  // the command had an "N:" or "*:" prefix

// Settings and EEPROM

uint8_t checksumOf(const uint8_t *p, size_t len) {
  uint8_t sum = 0;
  while (len--) sum = (uint8_t)((sum << 1) | (sum >> 7)) ^ *p++;
  return sum;
}

int recordAddr(uint8_t i) { return EE_FIRST_RECORD + i * sizeof(Record); }

void setDefaults(Config &c) {
  c.minUs = 544;  // same mapping as Servo.write(): 0 deg = 544 us, 180 deg = 2400 us
  c.maxUs = 2400;
  c.range = 180;
  c.lo = 0;
  c.hi = 180;
  c.speed = 0;
  c.home = 90;
  c.ease = 0;
}

bool configValid(const Config &c) {
  if (c.minUs < HARD_MIN_US || c.minUs > HARD_MAX_US || c.maxUs < HARD_MIN_US || c.maxUs > HARD_MAX_US) return false;
  if (abs(c.maxUs - c.minUs) < 100) return false;
  // Written as positive checks so NaN fails them too.
  if (!(c.range > 0 && c.range <= 360)) return false;
  if (!(c.lo >= 0 && c.lo < c.hi && c.hi <= c.range)) return false;
  if (!(c.speed >= 0 && c.speed <= 10000)) return false;
  if (!(c.home >= c.lo && c.home <= c.hi)) return false;
  return c.ease <= 1;
}

// Servo i's stored settings; false when there are none, or they are damaged.
bool readStored(uint8_t i, Config &out) {
  uint16_t magic;
  EEPROM.get(0, magic);
  if (magic != EE_MAGIC) return false;
  Record r;
  EEPROM.get(recordAddr(i), r);
  if (r.checksum != checksumOf((const uint8_t *)&r.cfg, sizeof r.cfg) || !configValid(r.cfg)) return false;
  out = r.cfg;
  return true;
}

void writeStored(uint8_t i) {
  EEPROM.put(0, EE_MAGIC);
  Record r;
  r.cfg = ch[i].cfg;
  r.checksum = checksumOf((const uint8_t *)&r.cfg, sizeof r.cfg);
  EEPROM.put(recordAddr(i), r);  // put() only rewrites bytes that changed
}

// True when servo i's settings in use are exactly the ones stored in EEPROM.
bool isSaved(uint8_t i) {
  Config c;
  return readStored(i, c) && memcmp(&c, &ch[i].cfg, sizeof c) == 0;
}

float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
float degToUs(const Config &c, float deg) { return c.minUs + deg * (c.maxUs - c.minUs) / c.range; }
float usToDeg(const Config &c, float us) { return (us - c.minUs) * c.range / (c.maxUs - c.minUs); }
float posDeg(uint8_t i) { return usToDeg(ch[i].cfg, ch[i].curUs); }

float limitDeg(const Config &c, float deg, bool &clamped) {
  float v = clampf(deg, c.lo, c.hi);
  if (v != deg) clamped = true;
  return v;
}

// Servo output

void output(Channel &c) {
  int us = (int)(c.curUs + 0.5f);
  if (us != c.writtenUs) {
    c.servo.writeMicroseconds(us);
    c.writtenUs = us;
  }
}

void ensureAttached(uint8_t i) {
  Channel &c = ch[i];
  if (c.attached) return;
  // Load the pulse width before attaching so the first pulse is already the right one
  // (otherwise the library starts with 1500 us and the servo twitches to the middle).
  c.writtenUs = -1;
  output(c);
  c.servo.attach(SERVO_PINS[i], HARD_MIN_US, HARD_MAX_US);
  c.attached = true;
  c.writtenUs = -1;  // pre-attach writes are clamped to 544-2400, so write again with the real limits
  output(c);
}

void relax(uint8_t i) {
  Channel &c = ch[i];
  if (!c.attached) return;
  // Detaching mid-pulse leaves the pin stuck HIGH (the library never ends that pulse),
  // so let the current pulse finish first.
  unsigned long t0 = micros();
  while (digitalRead(SERVO_PINS[i]) == HIGH && micros() - t0 < 3000) {}
  c.servo.detach();
  digitalWrite(SERVO_PINS[i], LOW);
  c.attached = false;
}

// Motion

float targetUs(const Channel &c) { return c.segActive ? c.segTo : c.curUs; }

unsigned long speedMs(const Channel &c, float fromUs, float toUs) {
  if (c.cfg.speed <= 0) return 0;
  return (unsigned long)(fabs(usToDeg(c.cfg, toUs) - usToDeg(c.cfg, fromUs)) * 1000.0f / c.cfg.speed + 0.5f);
}

void startSegment(Channel &c, float toUs, unsigned long ms, bool ease) {
  c.segFrom = c.curUs;
  c.segTo = toUs;
  c.segStart = millis();
  c.segDur = ms;
  c.segEase = ease;
  c.segActive = true;  // zero-length segments still finish in updateMotion() so sequences advance
}

void startMotion(uint8_t i, Mode m, float toUs, unsigned long ms, bool ease) {
  ensureAttached(i);
  ch[i].mode = m;
  startSegment(ch[i], toUs, ms, ease);
}

void stopMotion(Channel &c) {
  c.segActive = false;
  c.mode = M_IDLE;
}

// Called when a segment ends: queue the next step of a sweep or tap, or go idle.
void nextSegment(Channel &c) {
  if (c.mode == M_SWEEP) {
    if (c.swPhase == 2 && c.swCyclesLeft && --c.swCyclesLeft == 0) {
      c.mode = M_IDLE;
      return;
    }
    c.swPhase = (c.swPhase == 1) ? 2 : 1;
    startSegment(c, c.swPhase == 1 ? c.swB : c.swA, c.swLeg, c.cfg.ease);
  } else if (c.mode == M_TAP && c.tapPhase == 0) {
    c.tapPhase = 1;
    startSegment(c, c.curUs, c.tapHold, false);
  } else if (c.mode == M_TAP && c.tapPhase == 1) {
    c.tapPhase = 2;
    startSegment(c, c.tapBack, speedMs(c, c.curUs, c.tapBack), false);
  } else {
    c.mode = M_IDLE;
  }
}

void updateMotion(uint8_t i) {
  Channel &c = ch[i];
  if (!c.segActive) return;
  unsigned long t = millis() - c.segStart;
  if (t >= c.segDur) {
    c.curUs = c.segTo;
    c.segActive = false;
  } else {
    float p = (float)t / c.segDur;
    if (c.segEase) p = 0.5f - 0.5f * cos(PI * p);
    c.curUs = c.segFrom + (c.segTo - c.segFrom) * p;
  }
  output(c);
  if (c.segActive) return;
  nextSegment(c);
  if (c.mode == M_IDLE) {
    Serial.print(F("! done servo="));
    Serial.print(i + 1);
    Serial.print(F(" pos="));
    Serial.println(posDeg(i), 1);
  }
}

// The servos a command acts on: the selected one, or all of them for "*:".
uint8_t selFirst() { return sel == ALL ? 0 : sel; }
uint8_t selEnd() { return sel == ALL ? NUM_SERVOS : sel + 1; }

bool isIdle(uint8_t target) {
  for (uint8_t i = 0; i < NUM_SERVOS; i++)
    if ((target == ALL || target == i) && ch[i].mode != M_IDLE) return false;
  return true;
}

// "OK pos=45.0" for one servo, "OK pos1=45.0 pos2=90.0" for all of them.
void printPos(uint8_t target) {
  Serial.print(F("OK"));
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    if (target != ALL && target != i) continue;
    Serial.print(F(" pos"));
    if (target == ALL) Serial.print(i + 1);
    Serial.print('=');
    Serial.print(posDeg(i), 1);
  }
  Serial.println();
}

void checkWait() {
  if (!waitPending) return;
  if (isIdle(waitTarget)) {
    waitPending = false;
    printPos(waitTarget);
  } else if (waitHasDeadline && (long)(millis() - waitDeadline) >= 0) {
    waitPending = false;
    Serial.println(F("ERR timeout"));
  }
}

// Replies and parsing

bool is(PGM_P name) { return strcmp_P(tok[0], name) == 0; }

bool parseNum(const char *s, float &out) {
  char *end;
  double v = strtod(s, &end);
  if (end == s || *end != '\0' || isnan(v) || isinf(v)) return false;
  out = v;
  return true;
}

bool num(uint8_t i, float &out) {
  if (parseNum(tok[i], out)) return true;
  Serial.print(F("ERR not a number: "));
  Serial.println(tok[i]);
  return false;
}

bool msArg(uint8_t i, unsigned long &out) {
  float v;
  if (!num(i, v)) return false;
  if (v < 0 || v > MAX_MS) {
    Serial.println(F("ERR time must be 0-3600000 ms"));
    return false;
  }
  out = (unsigned long)(v + 0.5f);
  return true;
}

bool argCount(uint8_t lo, uint8_t hi) {
  uint8_t n = ntok - 1;
  if (n >= lo && n <= hi) return true;
  Serial.print(F("ERR "));
  Serial.print(tok[0]);
  Serial.println(n < lo ? F(" needs more arguments (send HELP)") : F(" takes fewer arguments (send HELP)"));
  return false;
}

void printTarget(uint8_t i, float us, bool clamped, unsigned long ms) {
  Serial.print(F("OK target="));
  Serial.print(usToDeg(ch[i].cfg, us), 1);
  Serial.print(F(" us="));
  Serial.print((int)(us + 0.5f));
  Serial.print(F(" ms="));
  Serial.print(ms);
  if (clamped) Serial.print(F(" clamped"));
  Serial.println();
}

const __FlashStringHelper *modeName(Mode m) {
  switch (m) {
    case M_MOVE: return F("move");
    case M_SWEEP: return F("sweep");
    case M_TAP: return F("tap");
    default: return F("idle");
  }
}

void printStatus(uint8_t i) {
  Channel &c = ch[i];
  Serial.print(F("OK servo="));
  Serial.print(i + 1);
  Serial.print(F(" pin="));
  Serial.print(SERVO_PINS[i]);
  Serial.print(F(" pos="));
  Serial.print(posDeg(i), 1);
  Serial.print(F(" target="));
  Serial.print(usToDeg(c.cfg, targetUs(c)), 1);
  Serial.print(F(" us="));
  Serial.print((int)(c.curUs + 0.5f));
  Serial.print(F(" moving="));
  Serial.print(c.mode != M_IDLE);
  Serial.print(F(" mode="));
  Serial.print(modeName(c.mode));
  Serial.print(F(" attached="));
  Serial.print(c.attached);
  Serial.print(F(" speed="));
  Serial.print(c.cfg.speed, 1);
  Serial.print(F(" ease="));
  Serial.print(c.cfg.ease);
  Serial.print(F(" lo="));
  Serial.print(c.cfg.lo, 1);
  Serial.print(F(" hi="));
  Serial.print(c.cfg.hi, 1);
  Serial.print(F(" home="));
  Serial.print(c.cfg.home, 1);
  Serial.print(F(" min_us="));
  Serial.print(c.cfg.minUs);
  Serial.print(F(" max_us="));
  Serial.print(c.cfg.maxUs);
  Serial.print(F(" range="));
  Serial.print(c.cfg.range, 1);
  Serial.print(F(" saved="));
  Serial.println(isSaved(i));
}

void printPins() {
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    if (i) Serial.print(',');
    Serial.print(SERVO_PINS[i]);
  }
}

void printInfo() {
  Serial.print(F("OK version=" FW_VERSION " servos="));
  Serial.print(NUM_SERVOS);
  Serial.print(F(" pins="));
  printPins();
  Serial.println();
}

void printHelp() {
  Serial.print(F("# ServoCtl " FW_VERSION " - servos on pins "));
  printPins();
  Serial.println(F(". One command per line, case-insensitive."));
  Serial.print(F(
    "#   N: in front picks the servo (2:A 90), default 1. *: = all, for X OFF ON C H W\n"
    "#   A <deg>   or just <deg>     go to angle (at SPEED)\n"
    "#   M <deg> <ms>                move to angle in exactly <ms> milliseconds\n"
    "#   STEP <deg>                  move relative to the current target, e.g. STEP -5\n"
    "#   U <us>                      raw pulse width 500-2500 us (ignores LIMITS)\n"
    "#   C | H                       go to center | home\n"
    "#   SWEEP <a> <b> [ms] [n]      sweep a<->b, ms per leg (1000), n cycles (0 = forever)\n"
    "#   TAP <deg> [ms]              go to angle, hold ms (200), come back\n"
    "#   X | STOP                    stop where it is\n"
    "#   W [ms] | WAIT [ms]          reply when motion finishes (optional timeout)\n"
    "#   OFF | ON                    relax the servo (no pulses) | hold position again\n"
    "#   SPEED [deg/s]               speed for A/STEP/U/C/H/TAP, 0 = as fast as possible\n"
    "#   EASE [ON|OFF]               smooth start/stop for M and SWEEP\n"
    "#   LIMITS [lo hi | OFF]        soft angle limits\n"
    "#   CAL [min_us max_us [range]] pulse width at 0 deg and at the max angle\n"
    "#   SETHOME [deg]               power-up angle (default: current)\n"
    "#   SAVE | LOAD | DEFAULTS      settings in EEPROM - all servos, or one with N:\n"
    "#   ? | STATUS    INFO    PING    HELP\n"
    "#   Event lines: ! done servo=N pos=<deg>  when a servo finishes a motion\n"));
  Serial.println(F("OK"));
}

// Commands

// Starts servo i toward `deg` at its SPEED; returns the target pulse width.
float goTo(uint8_t i, float deg, bool &clamped, unsigned long &ms) {
  Channel &c = ch[i];
  float us = degToUs(c.cfg, limitDeg(c.cfg, deg, clamped));
  ms = speedMs(c, c.curUs, us);
  startMotion(i, M_MOVE, us, ms, false);
  return us;
}

void cmdGoto(uint8_t i, float deg) {
  bool clamped = false;
  unsigned long ms;
  float us = goTo(i, deg, clamped, ms);
  printTarget(i, us, clamped, ms);
}

void cmdCenterHome(bool center) {
  if (!argCount(0, 0)) return;
  if (sel != ALL) {
    cmdGoto(sel, center ? ch[sel].cfg.range / 2 : ch[sel].cfg.home);
    return;
  }
  Serial.print(F("OK"));
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    bool clamped = false;
    unsigned long ms;
    float us = goTo(i, center ? ch[i].cfg.range / 2 : ch[i].cfg.home, clamped, ms);
    Serial.print(F(" target"));
    Serial.print(i + 1);
    Serial.print('=');
    Serial.print(usToDeg(ch[i].cfg, us), 1);
  }
  Serial.println();
}

void cmdSweep(uint8_t i) {
  Channel &c = ch[i];
  float a, b, leg = 1000, cycles = 0;
  if (!argCount(2, 4) || !num(1, a) || !num(2, b)) return;
  if (ntok > 3 && !num(3, leg)) return;
  if (ntok > 4 && !num(4, cycles)) return;
  if (leg < 1 || leg > MAX_MS) {
    Serial.println(F("ERR leg time must be 1-3600000 ms"));
    return;
  }
  if (cycles < 0 || cycles > 1000000 || cycles != (long)cycles) {
    Serial.println(F("ERR cycles must be a whole number 0-1000000"));
    return;
  }
  bool clamped = false;
  a = limitDeg(c.cfg, a, clamped);
  b = limitDeg(c.cfg, b, clamped);
  if (fabs(a - b) < 0.1) {
    Serial.println(F("ERR sweep ends must differ"));
    return;
  }
  c.swA = degToUs(c.cfg, a);
  c.swB = degToUs(c.cfg, b);
  c.swLeg = (unsigned long)leg;
  c.swCyclesLeft = (unsigned long)cycles;
  c.swPhase = 0;
  // Reach the first end at the same average speed as the sweep itself.
  float approach = fabs(posDeg(i) - a) / fabs(b - a) * leg;
  startMotion(i, M_SWEEP, c.swA, (unsigned long)clampf(approach, 0, MAX_MS), c.cfg.ease);
  Serial.print(F("OK sweep a="));
  Serial.print(a, 1);
  Serial.print(F(" b="));
  Serial.print(b, 1);
  Serial.print(F(" leg="));
  Serial.print(c.swLeg);
  Serial.print(F(" cycles="));
  if (c.swCyclesLeft) Serial.print(c.swCyclesLeft);
  else Serial.print(F("forever"));
  if (clamped) Serial.print(F(" clamped"));
  Serial.println();
}

void cmdTap(uint8_t i) {
  Channel &c = ch[i];
  float a;
  unsigned long hold = 200;
  if (!argCount(1, 2) || !num(1, a)) return;
  if (ntok > 2 && !msArg(2, hold)) return;
  bool clamped = false;
  float us = degToUs(c.cfg, limitDeg(c.cfg, a, clamped));
  if (c.mode != M_TAP) c.tapBack = targetUs(c);  // repeated taps keep returning to the original spot
  c.tapHold = hold;
  c.tapPhase = 0;
  startMotion(i, M_TAP, us, speedMs(c, c.curUs, us), false);
  Serial.print(F("OK tap target="));
  Serial.print(usToDeg(c.cfg, us), 1);
  Serial.print(F(" hold="));
  Serial.print(hold);
  Serial.print(F(" back="));
  Serial.print(usToDeg(c.cfg, c.tapBack), 1);
  if (clamped) Serial.print(F(" clamped"));
  Serial.println();
}

void cmdWait() {
  unsigned long timeout = 0;
  if (!argCount(0, 1)) return;
  if (ntok > 1 && !msArg(1, timeout)) return;
  for (uint8_t i = selFirst(); i < selEnd(); i++) {
    if (ch[i].mode == M_SWEEP && ch[i].swCyclesLeft == 0) {
      Serial.print(F("ERR servo "));
      Serial.print(i + 1);
      Serial.println(F(" sweeps forever - send STOP first"));
      return;
    }
  }
  if (isIdle(sel)) {
    printPos(sel);
    return;
  }
  waitPending = true;
  waitTarget = sel;
  waitHasDeadline = ntok > 1;
  waitDeadline = millis() + timeout;
}

void cmdLimits(uint8_t i) {
  Config &c = ch[i].cfg;
  float a, b;
  if (!argCount(0, 2)) return;
  if (ntok == 2) {
    if (strcmp_P(tok[1], PSTR("OFF")) != 0) {
      Serial.println(F("ERR use LIMITS <lo> <hi> or LIMITS OFF"));
      return;
    }
    c.lo = 0;
    c.hi = c.range;
  } else if (ntok == 3) {
    if (!num(1, a) || !num(2, b)) return;
    if (!(a >= 0 && a < b && b <= c.range)) {
      Serial.print(F("ERR need 0 <= lo < hi <= "));
      Serial.println(c.range, 1);
      return;
    }
    c.lo = a;
    c.hi = b;
  }
  c.home = clampf(c.home, c.lo, c.hi);
  Serial.print(F("OK lo="));
  Serial.print(c.lo, 1);
  Serial.print(F(" hi="));
  Serial.println(c.hi, 1);
}

void cmdCal(uint8_t i) {
  Config &c = ch[i].cfg;
  if (!argCount(0, 3)) return;
  if (ntok == 2) {
    Serial.println(F("ERR use CAL <min_us> <max_us> [range_deg]"));
    return;
  }
  if (ntok >= 3) {
    float a, b, r = c.range;
    if (!num(1, a) || !num(2, b) || (ntok == 4 && !num(3, r))) return;
    if (a < HARD_MIN_US || a > HARD_MAX_US || b < HARD_MIN_US || b > HARD_MAX_US || fabs(a - b) < 100) {
      Serial.println(F("ERR pulse widths must be 500-2500 us and at least 100 us apart"));
      return;
    }
    if (!(r >= 1 && r <= 360)) {
      Serial.println(F("ERR range must be 1-360 deg"));
      return;
    }
    bool fullRange = c.lo == 0 && c.hi == c.range;
    c.minUs = (int16_t)(a + 0.5f);
    c.maxUs = (int16_t)(b + 0.5f);
    c.range = r;
    if (fullRange || c.hi > r) c.hi = r;
    if (c.lo >= c.hi) c.lo = 0;
    c.home = clampf(c.home, c.lo, c.hi);
  }
  Serial.print(F("OK min_us="));
  Serial.print(c.minUs);
  Serial.print(F(" max_us="));
  Serial.print(c.maxUs);
  Serial.print(F(" range="));
  Serial.println(c.range, 1);
}

// SAVE, LOAD and DEFAULTS act on every servo, or on one when an "N:" prefix is given.
void cmdStore() {
  if (!argCount(0, 0)) return;
  uint8_t first = selGiven ? selFirst() : 0;
  uint8_t end = selGiven ? selEnd() : NUM_SERVOS;
  if (is(PSTR("SAVE"))) {
    for (uint8_t i = first; i < end; i++) writeStored(i);
    Serial.println(F("OK saved"));
  } else if (is(PSTR("LOAD"))) {
    Config loaded[NUM_SERVOS];
    for (uint8_t i = first; i < end; i++) {
      if (!readStored(i, loaded[i])) {
        Serial.print(F("ERR no saved settings for servo "));
        Serial.println(i + 1);
        return;
      }
    }
    for (uint8_t i = first; i < end; i++) ch[i].cfg = loaded[i];
    Serial.println(F("OK loaded"));
  } else {
    for (uint8_t i = first; i < end; i++) setDefaults(ch[i].cfg);
    Serial.println(F("OK defaults restored (send SAVE to keep them)"));
  }
}

void dispatch() {
  float a;
  unsigned long ms;

  // Board-wide commands; SAVE, LOAD and DEFAULTS also take an "N:" prefix.
  if (is(PSTR("PING"))) {
    if (argCount(0, 0)) Serial.println(F("OK pong"));
    return;
  }
  if (is(PSTR("HELP"))) {
    printHelp();
    return;
  }
  if (is(PSTR("INFO"))) {
    if (argCount(0, 0)) printInfo();
    return;
  }
  if (is(PSTR("SAVE")) || is(PSTR("LOAD")) || is(PSTR("DEFAULTS"))) {
    cmdStore();
    return;
  }

  // Commands that also work on all servos at once ("*:").
  if (is(PSTR("X")) || is(PSTR("STOP"))) {
    if (!argCount(0, 0)) return;
    for (uint8_t i = selFirst(); i < selEnd(); i++) stopMotion(ch[i]);
    printPos(sel);
    return;
  }
  if (is(PSTR("OFF")) || is(PSTR("RELAX")) || is(PSTR("DETACH"))) {
    if (!argCount(0, 0)) return;
    for (uint8_t i = selFirst(); i < selEnd(); i++) {
      stopMotion(ch[i]);
      relax(i);
    }
    Serial.println(F("OK relaxed"));
    return;
  }
  if (is(PSTR("ON")) || is(PSTR("ATTACH"))) {
    if (!argCount(0, 0)) return;
    for (uint8_t i = selFirst(); i < selEnd(); i++) ensureAttached(i);
    printPos(sel);
    return;
  }
  if (is(PSTR("C")) || is(PSTR("CENTER")) || is(PSTR("H")) || is(PSTR("HOME"))) {
    cmdCenterHome(tok[0][0] == 'C');
    return;
  }
  if (is(PSTR("W")) || is(PSTR("WAIT"))) {
    cmdWait();
    return;
  }

  // Everything else is for one servo.
  if (sel == ALL) {
    Serial.println(F("ERR *: only works with X, OFF, ON, C, H and W"));
    return;
  }
  uint8_t i = sel;
  Channel &c = ch[i];

  if (parseNum(tok[0], a)) {  // a bare number means "go to this angle"
    if (argCount(0, 0)) cmdGoto(i, a);
  } else if (is(PSTR("A")) || is(PSTR("ANGLE"))) {
    if (argCount(1, 1) && num(1, a)) cmdGoto(i, a);
  } else if (is(PSTR("M")) || is(PSTR("MOVE"))) {
    if (argCount(2, 2) && num(1, a) && msArg(2, ms)) {
      bool clamped = false;
      float us = degToUs(c.cfg, limitDeg(c.cfg, a, clamped));
      startMotion(i, M_MOVE, us, ms, c.cfg.ease);
      printTarget(i, us, clamped, ms);
    }
  } else if (is(PSTR("STEP"))) {
    if (argCount(1, 1) && num(1, a)) cmdGoto(i, usToDeg(c.cfg, targetUs(c)) + a);
  } else if (is(PSTR("U")) || is(PSTR("US"))) {
    if (argCount(1, 1) && num(1, a)) {
      float us = clampf(a, HARD_MIN_US, HARD_MAX_US);
      ms = speedMs(c, c.curUs, us);
      startMotion(i, M_MOVE, us, ms, false);
      printTarget(i, us, us != a, ms);
    }
  } else if (is(PSTR("SWEEP"))) {
    cmdSweep(i);
  } else if (is(PSTR("T")) || is(PSTR("TAP"))) {
    cmdTap(i);
  } else if (is(PSTR("SPEED"))) {
    if (!argCount(0, 1)) return;
    if (ntok == 2) {
      if (!num(1, a)) return;
      if (!(a == 0 || (a >= 0.1 && a <= 10000))) {
        Serial.println(F("ERR speed must be 0 or 0.1-10000 deg/s"));
        return;
      }
      c.cfg.speed = a;
    }
    Serial.print(F("OK speed="));
    Serial.println(c.cfg.speed, 1);
  } else if (is(PSTR("EASE"))) {
    if (!argCount(0, 1)) return;
    if (ntok == 2) {
      if (strcmp_P(tok[1], PSTR("ON")) == 0 || strcmp_P(tok[1], PSTR("1")) == 0) c.cfg.ease = 1;
      else if (strcmp_P(tok[1], PSTR("OFF")) == 0 || strcmp_P(tok[1], PSTR("0")) == 0) c.cfg.ease = 0;
      else {
        Serial.println(F("ERR use EASE ON or EASE OFF"));
        return;
      }
    }
    Serial.print(F("OK ease="));
    Serial.println(c.cfg.ease);
  } else if (is(PSTR("LIMITS")) || is(PSTR("LIM"))) {
    cmdLimits(i);
  } else if (is(PSTR("CAL"))) {
    cmdCal(i);
  } else if (is(PSTR("SETHOME"))) {
    if (!argCount(0, 1)) return;
    a = posDeg(i);
    if (ntok == 2 && !num(1, a)) return;
    bool clamped = false;
    c.cfg.home = limitDeg(c.cfg, a, clamped);
    Serial.print(F("OK home="));
    Serial.print(c.cfg.home, 1);
    if (clamped) Serial.print(F(" clamped"));
    Serial.println();
  } else if (is(PSTR("?")) || is(PSTR("STATUS"))) {
    if (argCount(0, 0)) printStatus(i);
  } else {
    Serial.print(F("ERR unknown command: "));
    Serial.print(tok[0]);
    Serial.println(F(" (send HELP)"));
  }
}

// Strips an "N:" or "*:" prefix, either glued to the command ("2:A") or on its own ("2: A").
bool parseSelector() {
  sel = 0;
  selGiven = false;
  char *colon = strchr(tok[0], ':');
  if (!colon) return true;
  *colon = '\0';
  selGiven = true;
  if (strcmp(tok[0], "*") == 0) {
    sel = ALL;
  } else {
    char *end;
    long n = strtol(tok[0], &end, 10);
    if (end == tok[0] || *end || n < 1 || n > NUM_SERVOS) {
      Serial.print(F("ERR no servo "));
      Serial.print(tok[0]);
      Serial.print(F(" - servos are 1-"));
      Serial.println(NUM_SERVOS);
      return false;
    }
    sel = n - 1;
  }
  if (colon[1]) {
    tok[0] = colon + 1;
  } else {
    for (uint8_t i = 1; i < ntok; i++) tok[i - 1] = tok[i];
    if (--ntok == 0) {
      Serial.println(F("ERR command missing after the servo prefix"));
      return false;
    }
  }
  return true;
}

void handleLine(char *s) {
  bool tooMany = false;
  ntok = 0;
  for (char *t = strtok(s, " \t,"); t; t = strtok(NULL, " \t,")) {
    if (ntok == MAX_TOKENS) {
      tooMany = true;
      break;
    }
    tok[ntok++] = t;
  }
  if (ntok == 0) return;
  if (waitPending) {  // a new command ends a pending WAIT, which keeps the replies in order
    waitPending = false;
    Serial.println(F("ERR wait interrupted"));
  }
  for (uint8_t i = 0; i < ntok; i++)
    for (char *p = tok[i]; *p; p++) *p = toupper(*p);
  if (tooMany) Serial.println(F("ERR too many arguments"));
  else if (parseSelector()) dispatch();
}

void readSerial() {
  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (c == '\t') c = ' ';
    if (c == '\n' || c == '\r') {
      if (lineOverflow) {
        if (waitPending) {
          waitPending = false;
          Serial.println(F("ERR wait interrupted"));
        }
        Serial.println(F("ERR line too long"));
      } else if (lineLen > 0) {
        line[lineLen] = '\0';
        handleLine(line);
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (c == '\b' || c == 127) {  // backspace from interactive terminals
      if (lineLen > 0) lineLen--;
    } else if (c < 32 || c > 126) {
      // Drop other control and non-ASCII bytes, e.g. the 0xF0 glitch bytes the Uno's
      // USB chip sends every time a PC opens the port.
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    } else {
      lineOverflow = true;
    }
  }
}

void setup() {
  Serial.begin(BAUD);
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    if (!readStored(i, ch[i].cfg)) setDefaults(ch[i].cfg);
    ch[i].curUs = degToUs(ch[i].cfg, ch[i].cfg.home);
    ensureAttached(i);
  }
  Serial.print(F("# ServoCtl " FW_VERSION " ready - servos on pins "));
  printPins();
  Serial.println(F(". Send HELP for commands."));
}

void loop() {
  readSerial();
  for (uint8_t i = 0; i < NUM_SERVOS; i++) updateMotion(i);
  checkWait();
}
