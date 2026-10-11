#!/bin/bash
# Build the USB HID mouse gadget in configfs and bind it to the UDC.
#
# Idempotent: if a gadget matching the wanted descriptor is already bound it
# exits 0. If the descriptor has changed it tears the old one down and rebuilds,
# because configfs attributes cannot be edited while the gadget is bound.
#
# Override any of the identity values in /etc/default/hid-gadget, then:
#     sudo systemctl restart hid-gadget
set -euo pipefail

GADGET=/sys/kernel/config/usb_gadget/autoclicker

# Defaults: the Linux Foundation gadget IDs. These identify the device as a
# generic Linux USB gadget. Override in /etc/default/hid-gadget.
VENDOR_ID=0x1d6b
PRODUCT_ID=0x0104
DEVICE_REV=0x0100
MANUFACTURER="autoclicker"
PRODUCT="USB HID Mouse"
SERIAL="0123456789"
MAX_POWER=250

[ -f /etc/default/hid-gadget ] && . /etc/default/hid-gadget

# 52-byte mouse report descriptor: 3 button bits + 5 bits padding, then
# relative X, Y and Wheel bytes -> 4-byte reports. Retail optical mice expose a
# wheel, so a descriptor without one contradicts the identity claimed in
# /etc/default/hid-gadget.
REPORT_LENGTH=4
REPORT_DESC='\x05\x01\x09\x02\xa1\x01\x09\x01\xa1\x00\x05\x09\x19\x01\x29\x03\x15\x00\x25\x01\x95\x03\x75\x01\x81\x02\x95\x01\x75\x05\x81\x03\x05\x01\x09\x30\x09\x31\x09\x38\x15\x81\x25\x7f\x75\x08\x95\x03\x81\x06\xc0\xc0'

# sysfs prints IDs as lowercase 0x%04x; normalise ours so comparisons hold
# whatever format the config file used.
norm() {
    local v="$1"
    case "$v" in
        0x*|0X*) ;;
        0[0-9]*)
            echo "ID '$v' has a leading zero, which is read as octal." >&2
            echo "Write hex IDs as 0x${v#0}, or use plain decimal." >&2
            exit 1 ;;
        *[!0-9]*)
            echo "ID '$v' is not a number. Use 0xNNNN or decimal." >&2
            exit 1 ;;
    esac
    printf '0x%04x' "$(( v ))"
}
VENDOR_ID=$(norm "$VENDOR_ID")
PRODUCT_ID=$(norm "$PRODUCT_ID")
DEVICE_REV=$(norm "$DEVICE_REV")

want_sig="$VENDOR_ID|$PRODUCT_ID|$DEVICE_REV|$MANUFACTURER|$PRODUCT|$SERIAL|$MAX_POWER|$REPORT_LENGTH"

current_sig() {
    [ -d "$GADGET" ] || return 1
    printf '%s|%s|%s|%s|%s|%s|%s|%s' \
        "$(cat "$GADGET/idVendor" 2>/dev/null)" \
        "$(cat "$GADGET/idProduct" 2>/dev/null)" \
        "$(cat "$GADGET/bcdDevice" 2>/dev/null)" \
        "$(cat "$GADGET/strings/0x409/manufacturer" 2>/dev/null)" \
        "$(cat "$GADGET/strings/0x409/product" 2>/dev/null)" \
        "$(cat "$GADGET/strings/0x409/serialnumber" 2>/dev/null)" \
        "$(cat "$GADGET/configs/c.1/MaxPower" 2>/dev/null)" \
        "$(cat "$GADGET/functions/hid.usb0/report_length" 2>/dev/null)"
}

teardown() {
    [ -d "$GADGET" ] || return 0
    echo "" > "$GADGET/UDC" 2>/dev/null || true
    rm -f  "$GADGET/configs/c.1/hid.usb0"
    rmdir  "$GADGET/configs/c.1/strings/0x409" 2>/dev/null || true
    rmdir  "$GADGET/configs/c.1"               2>/dev/null || true
    rmdir  "$GADGET/functions/hid.usb0"        2>/dev/null || true
    rmdir  "$GADGET/strings/0x409"             2>/dev/null || true
    rmdir  "$GADGET"                           2>/dev/null || true
}

modprobe libcomposite

# configfs is normally mounted by systemd; mount it ourselves if it is not.
if ! mountpoint -q /sys/kernel/config; then
    mount -t configfs none /sys/kernel/config
fi

# configfs files always report a size, so test the content: empty means the
# gadget exists but isn't bound (e.g. after gadget-mode rival600).
if [ -f "$GADGET/UDC" ] && [ -n "$(cat "$GADGET/UDC")" ]; then
    if [ "$(current_sig)" = "$want_sig" ]; then
        echo "gadget already bound to $(cat "$GADGET/UDC") as $VENDOR_ID:$PRODUCT_ID"
        exit 0
    fi
    echo "descriptor changed, rebuilding gadget"
fi
teardown

mkdir -p "$GADGET"
cd "$GADGET"

echo "$VENDOR_ID"  > idVendor
echo "$PRODUCT_ID" > idProduct
echo "$DEVICE_REV" > bcdDevice
echo 0x0200        > bcdUSB

mkdir -p strings/0x409
# An empty SERIAL leaves the descriptor unset, which is what most retail mice
# do - they report no serial number at all.
if [ -n "$SERIAL" ]; then
    echo "$SERIAL" > strings/0x409/serialnumber
fi
echo "$MANUFACTURER" > strings/0x409/manufacturer
echo "$PRODUCT"      > strings/0x409/product

mkdir -p configs/c.1/strings/0x409
echo "HID mouse"  > configs/c.1/strings/0x409/configuration
echo "$MAX_POWER" > configs/c.1/MaxPower

mkdir -p functions/hid.usb0
echo 2 > functions/hid.usb0/protocol       # 2 = mouse
echo 1 > functions/hid.usb0/subclass       # 1 = boot interface
echo "$REPORT_LENGTH" > functions/hid.usb0/report_length
printf "$REPORT_DESC" > functions/hid.usb0/report_desc

[ -e configs/c.1/hid.usb0 ] || ln -s functions/hid.usb0 configs/c.1/

# The UDC can take a moment to appear after dwc2 loads.
for _ in $(seq 1 20); do
    UDC=$(ls /sys/class/udc 2>/dev/null | head -n1 || true)
    [ -n "$UDC" ] && break
    sleep 0.5
done

if [ -z "${UDC:-}" ]; then
    echo "no UDC in /sys/class/udc - is dtoverlay=dwc2,dr_mode=peripheral set in config.txt?" >&2
    exit 1
fi

echo "$UDC" > UDC
echo "gadget bound to $UDC as $VENDOR_ID:$PRODUCT_ID \"$MANUFACTURER\" \"$PRODUCT\" (${REPORT_LENGTH}-byte reports)"
