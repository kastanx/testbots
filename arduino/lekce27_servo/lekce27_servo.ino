// LaskaKit Maxi Starter Kit v2 - Lekce 27 (Servo)
// Wiring: brown -> GND, red -> 5V, orange (signal) -> D9
// Sweeps 0 -> 160 -> 0 degrees in 1-degree steps.

#include <Servo.h>

Servo myservo;
const int servoPin = 9;

int pos = 0;

void setup() {
  myservo.attach(servoPin);
}

void loop() {
  for (pos = 0; pos <= 160; pos += 1) {
    myservo.write(pos);
    delay(15);  // give the servo time to reach the position
  }
  for (pos = 160; pos >= 0; pos -= 1) {
    myservo.write(pos);
    delay(15);
  }
}
