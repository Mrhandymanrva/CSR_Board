#!/usr/bin/env bash
# Wallboard kiosk launcher — Raspberry Pi OS / Debian / Ubuntu.
# Install:  sudo cp scripts/kiosk.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/kiosk.sh
set -euo pipefail

BOARD_URL="${BOARD_URL:?set BOARD_URL, e.g. https://wallboard.up.railway.app/board?k=TOKEN}"

# Keep the panel awake. A call center TV that blanks after 10 minutes is useless.
xset s off
xset -dpms
xset s noblank

command -v unclutter >/dev/null && unclutter -idle 0 &

# Clear the "Chrome didn't shut down correctly" bar, which otherwise covers
# the top of the board after every power cut.
PROFILE="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PROFILE" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PROFILE" || true
fi

exec chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --app="$BOARD_URL"
