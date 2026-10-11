#!/bin/bash
# Run ON the Pi as root. Idempotent. Reboots only if the kernel config changed.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt
NEEDS_REBOOT=0

echo "==> enabling USB device mode"
if ! grep -q '^dtoverlay=dwc2,dr_mode=peripheral' "$CONFIG_TXT"; then
    echo 'dtoverlay=dwc2,dr_mode=peripheral' >> "$CONFIG_TXT"
    echo "    added dwc2 overlay to $CONFIG_TXT"
    NEEDS_REBOOT=1
fi

for mod in dwc2 libcomposite; do
    if ! grep -qx "$mod" /etc/modules; then
        echo "$mod" >> /etc/modules
        echo "    added $mod to /etc/modules"
        NEEDS_REBOOT=1
    fi
done

echo "==> installing files"
install -m 755 "$SRC/hid-gadget.sh"  /usr/local/bin/hid-gadget.sh
install -m 755 "$SRC/autoclicker.py" /usr/local/bin/autoclicker.py
install -m 755 "$SRC/rival600.py"    /usr/local/bin/rival600.py
install -m 644 "$SRC/hidplay.py"     /usr/local/bin/hidplay.py
install -m 755 "$SRC/gadget-mode.sh" /usr/local/bin/gadget-mode
install -m 644 "$SRC/systemd/hid-gadget.service"  /etc/systemd/system/hid-gadget.service
install -m 644 "$SRC/systemd/rival600.service"    /etc/systemd/system/rival600.service

# Never clobber identity settings the user has already tuned.
if [ ! -f /etc/default/hid-gadget ]; then
    install -m 644 "$SRC/hid-gadget.default.example" /etc/default/hid-gadget
    echo "    wrote /etc/default/hid-gadget (defaults)"
else
    echo "    kept existing /etc/default/hid-gadget"
fi
install -m 644 "$SRC/systemd/autoclicker.service" /etc/systemd/system/autoclicker.service

echo "==> turning WiFi power saving off"
# A dozing radio makes the first request after an idle spell wait for it to
# wake: /moveclick started up to 0.4 s late. NetworkManager applies the conf
# whenever it connects; iw switches it off now, without dropping the link.
if [ -d /etc/NetworkManager/conf.d ]; then
    install -m 644 "$SRC/networkmanager/wifi-powersave-off.conf" /etc/NetworkManager/conf.d/wifi-powersave-off.conf
    nmcli general reload conf >/dev/null 2>&1 || true
else
    echo "    no NetworkManager here: off only until the next reboot"
fi
for dev in /sys/class/net/*/wireless; do
    [ -e "$dev" ] || continue
    ifc=$(basename "$(dirname "$dev")")
    iw dev "$ifc" set power_save off 2>/dev/null || true
    echo "    $ifc: $(iw dev "$ifc" get power_save 2>/dev/null || echo "power save state unknown")"
done

echo "==> enabling services"
systemctl daemon-reload
# Keep whichever mouse identity is set up (gadget-mode); Logitech on a first install.
MODE=logitech
if systemctl is-enabled --quiet rival600.service 2>/dev/null; then MODE=rival600; fi
if [ "$MODE" = rival600 ]; then
    systemctl enable rival600.service autoclicker.service
else
    systemctl enable hid-gadget.service autoclicker.service
fi
echo "    mouse identity: $MODE (switch with: sudo gadget-mode rival600|logitech)"

if [ "$NEEDS_REBOOT" = 1 ]; then
    echo
    echo "Kernel config changed - rebooting to load dwc2. Back in ~30s."
    echo "After reboot:  curl -i -X POST http://clicker.local:8080/click"
    sleep 2
    reboot
else
    /usr/local/bin/gadget-mode "$MODE"
    echo
    systemctl --no-pager --lines=0 status autoclicker.service || true
    echo
    echo "Ready:  curl -i -X POST http://clicker.local:8080/click"
fi
