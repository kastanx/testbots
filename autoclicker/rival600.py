#!/usr/bin/env python3
"""A USB device that looks like a SteelSeries Rival 600, built on FunctionFS.

Runs on the Pi as root. It builds the gadget in configfs, serves the device's
interfaces from user space, binds to the USB controller, and keeps running
until stopped (Ctrl+C / SIGTERM), when it unbinds and removes the gadget.

What the host sees, taken from the real mouse (read on the PC through the USB
hub driver):

  device   1038:1724 rev 2.33, USB 2.0, class 0/0/0, ep0 64 bytes, full speed,
           "SteelSeries" / "SteelSeries Rival 600", no serial number
  config   3 interfaces, bus powered + remote wakeup, 200 mA, no string
  if 0     HID, vendor channel (SteelSeries Engine/GG), 1 interrupt IN, 32 bytes
  if 1     HID boot mouse, 1 interrupt IN, 9 bytes
  if 2     HID keyboard/consumer extra input, 1 interrupt IN, 9 bytes
           every endpoint polled every 1 ms; bcdHID 1.11

The interface, HID and endpoint descriptors below are those bytes, unchanged,
so the configuration descriptor the host reads is identical to the real one.

Report descriptors can't be read raw from the PC, so they're rebuilt from what
Windows' HID parser made of the real ones - same collections, report IDs,
usages, sizes and ranges - at exactly the lengths the real HID descriptors
declare (37, 98 and 76 bytes). On Windows, SteelSeries' own driver (sshid)
handles interface 1 and adds a keyboard collection to it (report 2), for the
real mouse and this one alike.

Left over from the Linux gadget framework, and only visible to USB descriptor
viewers: the device descriptor's serial-number string index is 3 (the real
mouse has 0; the string itself is empty, so Windows still sees no serial), it
answers the device-qualifier request (the real mouse stalls it), and it stalls
string requests 3 and 4 (the real firmware answers those with its
configuration and device descriptors).

Mouse input: send 8-byte mouse reports - buttons, X (16-bit), Y (16-bit),
wheel, pan, a spare byte, no report ID: byte 0 is the buttons, so a stray
leading 0x01 presses the left button - as datagrams to the UNIX socket
RIVAL_SOCKET.
Movements with clicks go to RIVAL_PLAY_SOCKET instead, where the movement
playing can also be steered (see PLAY_SOCKET_PATH). Each report is written to
interface 1's endpoint; the answer is b"ok" once the host has read it, b"down"
if the host isn't reading (not configured, or suspended), b"busy" if it didn't
read it within 250 ms (it's still delivered - only the newest waiting report
is, so a late "button down" is always followed by its "button up").

Every control request from the host is logged.
"""

import errno
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

import hidplay

GADGET = os.environ.get("RIVAL_GADGET", "/sys/kernel/config/usb_gadget/rival600")
FUNCTION = "rival600"
FFS = os.environ.get("RIVAL_FFS", "/dev/ffs-rival600")
SOCKET_PATH = os.environ.get("RIVAL_SOCKET", "/run/rival600/mouse.sock")
# Movements with clicks (autoclicker's /moveclick): a stream socket taking
# b"PLAY", a u32 count and count x (u32 t_ms, u8 buttons, i16 dx, i16 dy);
# it plays them and answers with one line of JSON. b"PLY2" is the same with a
# u32 end_ms (the movement's last ms) after the count. b"STER", a u32 length
# and that much JSON steers the movement playing (hidplay.Playback.handle:
# {"press": [dx, dy], "ms"} from its start, {"cancel": true}, {"peek": true});
# one line of JSON back. Each connection is served on its own thread, so a
# steer gets in while a movement plays.
PLAY_SOCKET_PATH = os.environ.get("RIVAL_PLAY_SOCKET", "/run/rival600/play.sock")
PLAY_EVENT = struct.Struct("<IBhh")
MAX_PLAY_EVENTS = 200000
MAX_STEER_BYTES = 4096

# ---- descriptors, byte for byte from the real mouse ---------------------------

HID_DESCS = [
    bytes.fromhex("092111010001222500"),   # if 0: bcdHID 1.11, report descriptor 37 bytes
    bytes.fromhex("092111010001226200"),   # if 1: 98 bytes
    bytes.fromhex("092111010001224c00"),   # if 2: 76 bytes
]
INTERFACES = [
    bytes.fromhex("090400000103000000"),   # if 0: HID, no boot protocol
    bytes.fromhex("090401000103010200"),   # if 1: HID, boot, mouse
    bytes.fromhex("090402000103000000"),   # if 2: HID, no boot protocol
]
ENDPOINTS_FS = [
    bytes.fromhex("07058103200001"),       # 0x81 interrupt IN, 32 bytes, every 1 ms
    bytes.fromhex("07058203090001"),       # 0x82 interrupt IN,  9 bytes, every 1 ms
    bytes.fromhex("07058303090001"),       # 0x83 interrupt IN,  9 bytes, every 1 ms
]
# Never used - the gadget is held to full speed like the real mouse - but
# FunctionFS wants a high-speed set too. bInterval 4 is 1 ms at high speed.
ENDPOINTS_HS = [ep[:6] + b"\x04" for ep in ENDPOINTS_FS]

# ---- report descriptors, rebuilt from Windows' parse of the real ones ---------

REPORT_DESCS = [
    # if 0, 37 bytes: vendor collection FFC0:01 - 32-byte input F0, 32-byte
    # output F1, 578-byte feature F2, all on usage page FFC1, no report IDs.
    bytes.fromhex(
        "06c0ff0901a101"
        "06c1ff150026ff007508"
        "952009f08102"
        "952009f19102"
        "96420209f2b102"
        "c0"
    ),
    # if 1, 98 bytes: a mouse WITHOUT a report ID - 8-byte reports: buttons
    # (5 + 3 padding bits), 16-bit X and Y, 8-bit wheel and AC pan, a spare
    # byte. That's the raw layout the real mouse sends - measured: on Windows
    # SteelSeries' sshid driver takes 8-byte reports (7 are ignored), reads
    # byte 0 as the buttons and X/Y from bytes 1-4, and itself presents report
    # IDs 1 (mouse), 2 (keyboard) and 3 (consumer) whatever this descriptor
    # says. Explicit physical/unit items (all zero, changing nothing) fill it
    # to the 98 bytes the HID descriptor declares.
    bytes.fromhex(
        "05010902a101"                              # mouse
        "0901a100"                                  # pointer
        "35004500550064"                            # physical 0, unit exponent 0, unit 0 (empty item)
        "05091901290515002501" "75019505" "8102"    # buttons 1-5
        "75039501" "8101"                           # 3 bits padding
        "3500450055006500"                          # physical 0, unit 0
        "05010930093116008026ff7f" "75109502" "8106"  # X, Y: 16-bit relative
        "5500"                                      # unit exponent 0
        "09381580257f75089501" "8106"               # wheel: 8-bit relative
        "050c0a3802" "1580257f75089501" "8106"      # AC pan: 8-bit relative
        "8101"                                      # spare byte
        "c0c0"
    ),
    # if 2, 76 bytes: keyboard (report 1) - 8 modifier bits, a reserved byte,
    # 6-key array 0-255 - and consumer control (report 2), one 16-bit usage
    # 0-0xFFF plus 16 bits of padding.
    bytes.fromhex(
        "05010906a1018501"                          # keyboard, report 1
        "050719e029e715002501750195088102"          # 8 modifier bits
        "950175088101"                              # reserved byte
        "950675081500" "26ff00050719002aff008100"   # 6-key array 0-255
        "c0"
        "050c0901a1018502"                          # consumer control, report 2
        "19002aff0f150026ff0f75109501" "8100"       # one 16-bit usage 0-0xFFF
        "8101"                                      # 16 bits padding
        "c0"
    ),
]

for _i, (_rd, _hd) in enumerate(zip(REPORT_DESCS, HID_DESCS)):
    _declared = struct.unpack_from("<H", _hd, 7)[0]
    assert len(_rd) == _declared, f"report descriptor {_i}: {len(_rd)} bytes, HID descriptor says {_declared}"

MOUSE_INTERFACE = 1
MOUSE_REPORT_LENGTH = 8      # buttons + X + Y (16-bit each) + wheel + pan + spare, no report ID

# ---- FunctionFS ---------------------------------------------------------------

DESCRIPTORS_MAGIC_V2 = 3
STRINGS_MAGIC = 2
HAS_FS_DESC = 1
HAS_HS_DESC = 2
EVENT_SIZE = 12
EVENT_NAMES = {0: "BIND", 1: "UNBIND", 2: "ENABLE", 3: "DISABLE", 4: "SETUP", 5: "SUSPEND", 6: "RESUME"}


def ffs_descriptors():
    fs = [d for i in range(3) for d in (INTERFACES[i], HID_DESCS[i], ENDPOINTS_FS[i])]
    hs = [d for i in range(3) for d in (INTERFACES[i], HID_DESCS[i], ENDPOINTS_HS[i])]
    body = struct.pack("<II", len(fs), len(hs)) + b"".join(fs) + b"".join(hs)
    return struct.pack("<III", DESCRIPTORS_MAGIC_V2, 12 + len(body), HAS_FS_DESC | HAS_HS_DESC) + body


def ffs_strings():
    # No interface strings: the real mouse has none (every iInterface is 0).
    return struct.pack("<IIII", STRINGS_MAGIC, 16, 0, 0)


def log(msg):
    print(time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d} {msg}", flush=True)


# ---- configfs -----------------------------------------------------------------

def put(path, value):
    with open(path, "w") as fh:
        fh.write(str(value))


def sh(*cmd):
    subprocess.run(cmd, check=True)


def udc_name():
    names = os.listdir("/sys/class/udc")
    if not names:
        sys.exit("no USB device controller in /sys/class/udc - is dtoverlay=dwc2,dr_mode=peripheral set?")
    return names[0]


def other_gadget_bound(udc):
    root = "/sys/kernel/config/usb_gadget"
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if path == GADGET:
            continue
        try:
            with open(os.path.join(path, "UDC")) as fh:
                if fh.read().strip() == udc:
                    return name
        except OSError:
            pass
    return None


def gadget_up():
    sh("modprobe", "libcomposite")
    sh("modprobe", "usb_f_fs")
    g = GADGET
    os.makedirs(g, exist_ok=True)
    put(f"{g}/idVendor", "0x1038")
    put(f"{g}/idProduct", "0x1724")
    put(f"{g}/bcdDevice", "0x0233")
    put(f"{g}/bcdUSB", "0x0200")
    put(f"{g}/bDeviceClass", "0")
    put(f"{g}/bDeviceSubClass", "0")
    put(f"{g}/bDeviceProtocol", "0")
    put(f"{g}/bMaxPacketSize0", "64")
    put(f"{g}/max_speed", "full-speed")
    os.makedirs(f"{g}/strings/0x409", exist_ok=True)
    put(f"{g}/strings/0x409/manufacturer", "SteelSeries")
    put(f"{g}/strings/0x409/product", "SteelSeries Rival 600")
    os.makedirs(f"{g}/configs/c.1", exist_ok=True)
    put(f"{g}/configs/c.1/MaxPower", "200")
    put(f"{g}/configs/c.1/bmAttributes", "0xa0")
    os.makedirs(f"{g}/functions/ffs.{FUNCTION}", exist_ok=True)
    link = f"{g}/configs/c.1/ffs.{FUNCTION}"
    if not os.path.islink(link):
        os.symlink(f"{g}/functions/ffs.{FUNCTION}", link)
    os.makedirs(FFS, exist_ok=True)
    if not os.path.ismount(FFS):
        sh("mount", "-t", "functionfs", FUNCTION, FFS)


def gadget_down():
    g = GADGET
    try:
        put(f"{g}/UDC", "\n")
    except OSError:
        pass
    if os.path.ismount(FFS):
        subprocess.run(["umount", FFS])
    for path, op in ((f"{g}/configs/c.1/ffs.{FUNCTION}", os.remove),
                     (f"{g}/configs/c.1", os.rmdir),
                     (f"{g}/functions/ffs.{FUNCTION}", os.rmdir),
                     (f"{g}/strings/0x409", os.rmdir),
                     (g, os.rmdir)):
        try:
            op(path)
        except OSError:
            pass


# ---- the device ---------------------------------------------------------------

class Rival:
    def __init__(self):
        self.enabled = False
        self.suspended = False
        self.ep0 = None
        self.mouse_ep = None
        self.idle = {}           # (interface, report id) -> idle rate
        self.protocol = {}       # interface -> 0 boot / 1 report
        # Mouse reports: the newest one waiting, as (sequence, report), handed
        # to the writer thread; done_seq is the sequence last written.
        self.cv = threading.Condition()
        self.pending = None
        self.seq = 0
        self.done_seq = 0
        # Held for every write to the mouse endpoint, and for a whole playback.
        self.ep_lock = threading.Lock()
        self.playback = None     # the hidplay.Playback playing now, for steers

    def can_send(self):
        return self.enabled and not self.suspended

    def close(self):
        for fd in (self.mouse_ep, self.ep0):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        self.mouse_ep = self.ep0 = None

    # Control requests addressed to our interfaces.
    def setup(self, req_type, req, value, index, length):
        what = f"SETUP {req_type:02x} {req:02x} {value:04x} {index:04x} {length:04x}"
        iface = index & 0xff
        if iface > 2:
            log(f"{what} -> stall (no interface {iface})")
            return self.stall(req_type)
        kind = (req_type >> 5) & 3   # 0 standard, 1 class, 2 vendor

        if kind == 0 and req == 0x06 and req_type == 0x81:
            dtype = value >> 8
            if dtype == 0x22:
                data = REPORT_DESCS[iface]
                log(f"{what} -> report descriptor if{iface}: {min(length, len(data))} of {len(data)} bytes")
                return self.reply(data[:length])
            if dtype == 0x21:
                log(f"{what} -> HID descriptor if{iface}")
                return self.reply(HID_DESCS[iface][:length])
            log(f"{what} -> stall (descriptor type {dtype:#x})")
            return self.stall(req_type)

        if kind == 0 and req == 0x00 and req_type == 0x81:          # GET_STATUS (interface)
            log(f"{what} -> interface status 0")
            return self.reply(b"\x00\x00"[:length])

        if kind == 1:
            if req == 0x0a:                                          # SET_IDLE
                self.idle[(iface, value & 0xff)] = value >> 8
                log(f"{what} -> SET_IDLE if{iface} report {value & 0xff} rate {value >> 8}")
                return self.ack()
            if req == 0x02:                                          # GET_IDLE
                log(f"{what} -> GET_IDLE if{iface}")
                return self.reply(bytes([self.idle.get((iface, value & 0xff), 0)])[:length])
            if req == 0x0b:                                          # SET_PROTOCOL
                self.protocol[iface] = value & 1
                log(f"{what} -> SET_PROTOCOL if{iface} {'report' if value & 1 else 'boot'}")
                return self.ack()
            if req == 0x03:                                          # GET_PROTOCOL
                log(f"{what} -> GET_PROTOCOL if{iface}")
                return self.reply(bytes([self.protocol.get(iface, 1)])[:length])
            if req == 0x09:                                          # SET_REPORT
                data = os.read(self.ep0, length) if length else b""
                if not length:
                    os.read(self.ep0, 0)
                log(f"{what} -> SET_REPORT if{iface} type {value >> 8} id {value & 0xff}: {data.hex()}")
                return None
            if req == 0x01:                                          # GET_REPORT
                log(f"{what} -> stall (GET_REPORT if{iface} type {value >> 8} id {value & 0xff})")
                return self.stall(req_type)

        log(f"{what} -> stall (unhandled)")
        return self.stall(req_type)

    def reply(self, data):
        os.write(self.ep0, data)

    def ack(self):
        os.read(self.ep0, 0)

    def stall(self, req_type):
        # FunctionFS: the opposite direction to the request halts ep0.
        try:
            if req_type & 0x80:
                os.read(self.ep0, 0)
            else:
                os.write(self.ep0, b"")
        except OSError:
            pass

    def events(self):
        while True:
            try:
                buf = os.read(self.ep0, EVENT_SIZE * 8)
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                raise
            for off in range(0, len(buf), EVENT_SIZE):
                ev = buf[off:off + EVENT_SIZE]
                if len(ev) < EVENT_SIZE:
                    break
                req_type, req, value, index, length, etype = struct.unpack("<BBHHHB", ev[:9])
                name = EVENT_NAMES.get(etype, str(etype))
                if etype == 4:
                    try:
                        self.setup(req_type, req, value, index, length)
                    except OSError as exc:
                        log(f"SETUP {req_type:02x} {req:02x} {value:04x} {index:04x} {length:04x} failed: {exc}")
                    continue
                if etype == 2:
                    self.enabled = True
                    self.suspended = False
                elif etype in (1, 3):
                    self.enabled = False
                elif etype == 5:
                    self.suspended = True
                elif etype == 6:
                    self.suspended = False
                log(f"event {name}")

    # ---- mouse reports from other processes ----

    def writer(self):
        while True:
            with self.cv:
                while self.pending is None:
                    self.cv.wait()
                (seq, report), self.pending = self.pending, None
            try:
                with self.ep_lock:
                    os.write(self.mouse_ep, report)     # returns once the host has read it
            except (OSError, TypeError) as exc:
                log(f"mouse report failed: {exc}")
                continue
            with self.cv:
                self.done_seq = seq
                self.cv.notify_all()

    def send_mouse(self, report):
        if not self.can_send():
            return b"down"
        with self.cv:
            self.seq += 1
            seq = self.seq
            # Replaces any report still waiting: only the newest goes out, so a
            # late "button down" is always followed by its "button up".
            self.pending = (seq, report)
            self.cv.notify_all()
            if self.cv.wait_for(lambda: self.done_seq >= seq, timeout=0.25):
                return b"ok"
        return b"busy"

    # ---- movements with clicks ----

    def mouse_report(self, buttons, dx, dy):
        dx = max(-32768, min(32767, dx))
        dy = max(-32768, min(32767, dy))
        os.write(self.mouse_ep, struct.pack("<Bhhbbb", buttons, dx, dy, 0, 0, 0))

    def play(self, events, end_ms=None):
        if not self.can_send():
            return {"ok": False, "error": "host isn't reading the mouse (not configured or suspended)"}
        with self.ep_lock:
            pb = hidplay.Playback(events, end_ms)
            self.playback = pb
            try:
                stats = pb.play(self.mouse_report)
            except OSError as exc:
                try:
                    self.mouse_report(0, 0, 0)      # never leave the button pressed
                except OSError:
                    pass
                return {"ok": False, "error": f"mouse report failed: {exc}"}
            finally:
                self.playback = None
        return {"ok": True, **stats}

    def steer(self, req):
        pb = self.playback
        if pb is None:
            return {"ok": False, "error": "nothing is playing"}
        return pb.handle(req)

    def serve_play(self):
        os.makedirs(os.path.dirname(PLAY_SOCKET_PATH), exist_ok=True)
        try:
            os.unlink(PLAY_SOCKET_PATH)
        except FileNotFoundError:
            pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(PLAY_SOCKET_PATH)
        os.chmod(PLAY_SOCKET_PATH, 0o660)
        srv.listen(8)
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=self.serve_play_conn, args=(conn,), daemon=True).start()

    def serve_play_conn(self, conn):
        with conn:
            try:
                conn.settimeout(5)
                head = self.read_exact(conn, 8)
                kind = head[:4]
                count = struct.unpack_from("<I", head, 4)[0]
                if kind == b"STER" and count <= MAX_STEER_BYTES:
                    result = self.steer(json.loads(self.read_exact(conn, count)))
                elif kind in (b"PLAY", b"PLY2") and count <= MAX_PLAY_EVENTS:
                    end_ms = struct.unpack("<I", self.read_exact(conn, 4))[0] if kind == b"PLY2" else None
                    data = self.read_exact(conn, count * PLAY_EVENT.size)
                    events = [PLAY_EVENT.unpack_from(data, i * PLAY_EVENT.size) for i in range(count)]
                    result = self.play(events, end_ms)
                    log(f"played {count} events: {json.dumps(result)}")
                else:
                    raise ValueError("bad play request")
            except (OSError, ValueError, struct.error) as exc:
                result = {"ok": False, "error": str(exc)}
            try:
                conn.sendall(json.dumps(result).encode() + b"\n")
            except OSError:
                pass

    @staticmethod
    def read_exact(conn, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = conn.recv(min(65536, n - len(buf)))
            if not chunk:
                raise ValueError("play request cut short")
            buf += chunk
        return bytes(buf)

    def serve_mouse(self):
        threading.Thread(target=self.writer, daemon=True).start()
        threading.Thread(target=self.serve_play, daemon=True).start()
        os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o660)
        while True:
            report, peer = sock.recvfrom(64)
            # Buttons outside 0-31 (5 buttons) mean a malformed report - e.g. one
            # with a report ID in front - which would press the wrong buttons.
            if len(report) != MOUSE_REPORT_LENGTH or report[0] > 0x1f:
                answer = b"bad"
            else:
                answer = self.send_mouse(report)
            if peer:
                try:
                    sock.sendto(answer, peer)
                except OSError:
                    pass


def main():
    if os.geteuid() != 0:
        sys.exit("run as root")
    udc = udc_name()
    other = other_gadget_bound(udc)
    if other:
        sys.exit(f"gadget '{other}' is bound to {udc} - stop it first (systemctl stop hid-gadget, "
                 f"or: echo '' > /sys/kernel/config/usb_gadget/{other}/UDC)")

    gadget_up()
    rival = Rival()

    def stop(*_):
        log("stopping")
        rival.close()        # the FunctionFS mount can't be unmounted while ep files are open
        gadget_down()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        rival.ep0 = os.open(os.path.join(FFS, "ep0"), os.O_RDWR)
        os.write(rival.ep0, ffs_descriptors())
        os.write(rival.ep0, ffs_strings())
        # FunctionFS numbers the endpoint files in descriptor order.
        rival.mouse_ep = os.open(os.path.join(FFS, f"ep{MOUSE_INTERFACE + 1}"), os.O_WRONLY)
        threading.Thread(target=rival.serve_mouse, daemon=True).start()
        put(f"{GADGET}/UDC", udc)
        log(f"bound to {udc} as 1038:1724 SteelSeries Rival 600 (full speed); mouse reports on {SOCKET_PATH}")
        rival.events()
    except Exception as exc:
        log(f"fatal: {exc}")
        rival.close()
        gadget_down()
        raise


if __name__ == "__main__":
    main()
