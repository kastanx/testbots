#!/bin/bash
# Switch the Pi between its two USB mouse identities. Run as root.
#
#   gadget-mode rival600   -> SteelSeries Rival 600 look-alike (rival600.service)
#   gadget-mode logitech   -> the original Logitech gadget (hid-gadget.service)
#   gadget-mode            -> show which one is active
#
# Only one can own the USB port at a time; the clicker follows the switch
# through /etc/default/autoclicker.
set -euo pipefail

LOGITECH_UDC=/sys/kernel/config/usb_gadget/autoclicker/UDC

case "${1:-}" in
    rival600)
        systemctl disable --now hid-gadget.service >/dev/null 2>&1 || true
        # hid-gadget.service has no stop action: unbind its gadget by hand
        # (configfs answers "No such device" if it isn't bound - that's fine).
        if [ -e "$LOGITECH_UDC" ]; then echo "" > "$LOGITECH_UDC" 2>/dev/null || true; fi
        systemctl enable rival600.service
        systemctl restart rival600.service      # also picks up a newly installed rival600.py
        # The Rival's mouse reports have no report ID: 8 bytes, buttons first.
        printf '%s\n' "CLICK_HID_SOCKET=/run/rival600/mouse.sock" \
                      "CLICK_REPORT_LENGTH=8" > /etc/default/autoclicker
        ;;
    logitech)
        systemctl disable --now rival600.service >/dev/null 2>&1 || true
        : > /etc/default/autoclicker
        systemctl enable hid-gadget.service
        systemctl restart hid-gadget.service
        ;;
    "")
        if systemctl is-active --quiet rival600.service; then echo rival600
        elif systemctl is-active --quiet hid-gadget.service; then echo logitech
        else echo none; fi
        exit 0
        ;;
    *)
        echo "usage: gadget-mode rival600|logitech" >&2
        exit 1
        ;;
esac

systemctl restart autoclicker.service
echo "mouse identity: $1"
