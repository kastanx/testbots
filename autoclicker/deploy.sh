#!/bin/bash
# Push this folder to the Pi and install it. Run from your laptop (Git Bash works).
#   ./deploy.sh                          -> clicker@clicker.local
#   ./deploy.sh clicker@192.168.0.131    -> explicit host (preferred)
set -euo pipefail

TARGET="${1:-clicker@clicker.local}"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "==> deploying to $TARGET"
tar -czf - -C "$SRC" \
    hid-gadget.sh autoclicker.py rival600.py hidplay.py gadget-mode.sh install.sh systemd networkmanager \
    hid-gadget.default.example \
  | ssh "$TARGET" '
      set -e
      rm -rf ~/autoclicker && mkdir -p ~/autoclicker
      tar -xzf - -C ~/autoclicker

      # stdin is the tarball, so a password-prompting sudo would hang here.
      if ! sudo -n true 2>/dev/null; then
          echo "" >&2
          echo "sudo needs a password on this Pi. Run the install by hand instead:" >&2
          echo "    ssh -t '"$TARGET"' \"sudo bash ~/autoclicker/install.sh\"" >&2
          exit 1
      fi

      sudo bash ~/autoclicker/install.sh
    '
