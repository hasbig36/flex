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
docker compose up -d --build
docker image prune -f >/dev/null
docker compose exec -T splynx-sync python sync.py check || true
echo "Updated to $(git log -1 --format='%h %s'). Backup of your settings: $backup"
