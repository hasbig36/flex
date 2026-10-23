#!/bin/sh
# Pull the latest Flex and restart:  sudo ./update.sh
# Your settings (.env), packages.yaml changes, customer data and media engine setup are kept.
set -e
cd "$(dirname "$0")"
backup="/root/flex-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -a .env config "$backup"/ 2>/dev/null || true
git stash push --quiet -- config/packages.yaml 2>/dev/null || true   # keep your local plan edits
git pull --ff-only
git stash pop --quiet 2>/dev/null || true
# fetch the latest Android app, if configured
APK_URL=$(grep -E '^APP_APK_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -n "$APK_URL" ]; then
  mkdir -p apps
  if curl -fsSL --max-time 300 -o apps/flex.apk.new "$APK_URL"; then mv apps/flex.apk.new apps/flex.apk; echo "Android app updated."
  else rm -f apps/flex.apk.new; echo "Could not download the Android app from $APK_URL (kept the current one)."; fi
fi
docker compose up -d --build
docker image prune -f >/dev/null
docker compose exec -T splynx-sync python sync.py check || true
echo "Updated to $(git log -1 --format='%h %s'). Backup of your settings: $backup"
