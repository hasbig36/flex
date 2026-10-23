#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Flex installer for Ubuntu 22.04 / 24.04
#
#  On your PC:     scp flex.zip root@SERVER:/root/
#  On the server:  apt install -y unzip && unzip -o /root/flex.zip -d /opt && sudo bash /opt/flex/install.sh
#
#  It asks a few questions, then:
#    - installs Docker, Caddy (HTTPS) and the firewall
#    - sets up the media engine (admin account, libraries, API key) automatically
#    - connects to Splynx and runs the first sync
#    - only lets your own networks open the app
#  Safe to run again: it keeps your existing settings unless you change them.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FLEX_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$FLEX_DIR/.env"
CRED_FILE="/root/flex-credentials.txt"
MEDIA_DIR="${MEDIA_DIR:-/srv/media}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "Run with sudo:  sudo bash $0"
[ -f "$FLEX_DIR/docker-compose.yml" ] || die "Run this from the unzipped flex folder (docker-compose.yml not found)."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Tested on Ubuntu 22.04/24.04; you are on ${PRETTY_NAME:-unknown}."

# ── read/write .env values ───────────────────────────────────────────────────
[ -f "$ENV_FILE" ] || cp "$FLEX_DIR/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"
getenv() { python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
for line in open(path, encoding="utf-8"):
    if line.startswith(key + "="):
        print(line.split("=", 1)[1].rstrip("\n")); break
PY
}
setenv() { python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().split("\n")
for i, l in enumerate(lines):
    if l.startswith(key + "="):
        lines[i] = f"{key}={val}"; break
else:
    lines.append(f"{key}={val}")
open(path, "w", encoding="utf-8").write("\n".join(lines))
PY
}
ask() {   # ask VAR "Question" "default" [secret]
  local var="$1" q="$2" def="$3" secret="${4:-}" cur val
  cur="${!var:-}"; [ -n "$cur" ] && { printf -v "$var" '%s' "$cur"; return; }   # given as environment variable
  if [ -n "$secret" ] && [ -n "$def" ]; then q="$q [keep current]"; elif [ -n "$def" ]; then q="$q [$def]"; fi
  if [ -n "$secret" ]; then read -r -s -p "  $q: " val; echo; else read -r -p "  $q: " val; fi
  printf -v "$var" '%s' "${val:-$def}"
}

bold "Flex setup"
echo "  Press Enter to accept the value in [brackets]."
ask DOMAIN           "Web address for the app, e.g. tv.your-isp.co.ke (blank = use the IP, no HTTPS)" "$(getenv FLEX_DOMAIN)"
ask CERT_EMAIL       "Email for HTTPS certificate notices (optional)" "$(getenv FLEX_CERT_EMAIL)"
ask SPLYNX_URL       "Splynx address, e.g. https://splynx.your-isp.co.ke" "$(getenv SPLYNX_URL)"
ask SPLYNX_API_KEY   "Splynx API key" "$(getenv SPLYNX_API_KEY)"
ask SPLYNX_API_SECRET "Splynx API secret" "$(getenv SPLYNX_API_SECRET)" secret
ask ALLOWED_NETWORKS "Networks allowed to use the app (comma-separated, blank = everyone)" "$(getenv ALLOWED_NETWORKS || true)"
ALLOWED_NETWORKS="${ALLOWED_NETWORKS:-}"
ask BRAND_NAME       "App name customers see" "$(getenv BRAND_NAME)"
ask BRAND_SUPPORT    "Support line shown in the app" "$(getenv BRAND_SUPPORT)"
ask UPGRADE_URL      "Link for 'Upgrade my plan' (your customer portal)" "$(getenv UPGRADE_URL)"
ask LIVETV_M3U       "Live TV playlist URL (blank = none for now)" "$(getenv LIVETV_M3U)"
ask LIVETV_EPG       "TV guide (XMLTV) URL (blank = none)" "$(getenv LIVETV_EPG)"

[ -n "$SPLYNX_URL" ] && [ -n "$SPLYNX_API_KEY" ] && [ -n "$SPLYNX_API_SECRET" ] || die "Splynx address, key and secret are required."
SPLYNX_URL="${SPLYNX_URL%/}"

setenv FLEX_DOMAIN "$DOMAIN";             setenv FLEX_CERT_EMAIL "$CERT_EMAIL"
setenv SPLYNX_URL "$SPLYNX_URL";          setenv SPLYNX_API_KEY "$SPLYNX_API_KEY"; setenv SPLYNX_API_SECRET "$SPLYNX_API_SECRET"
setenv ALLOWED_NETWORKS "$ALLOWED_NETWORKS"
setenv BRAND_NAME "$BRAND_NAME";          setenv BRAND_SUPPORT "$BRAND_SUPPORT"; setenv UPGRADE_URL "$UPGRADE_URL"
setenv LIVETV_M3U "$LIVETV_M3U";          setenv LIVETV_EPG "$LIVETV_EPG"
setenv MEDIA_PATH "$MEDIA_DIR"
setenv PORTAL_PORT "127.0.0.1:8080"       # only Caddy can reach the app directly
setenv ENGINE_ADMIN_BIND "127.0.0.1"      # engine admin only via SSH tunnel
[ -n "$(getenv ADMIN_TOKEN)" ] || setenv ADMIN_TOKEN "$(openssl rand -hex 24)"
if [ -z "$(getenv DIRECTOR_PASSWORD)" ]; then
  setenv DIRECTOR_PASSWORD "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
fi
if [ -n "$DOMAIN" ]; then setenv COOKIE_SECURE true; else setenv COOKIE_SECURE false; fi
ok "Settings saved to $ENV_FILE"

# ── packages ─────────────────────────────────────────────────────────────────
bold "Installing Docker, Caddy and the firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates unzip ufw openssl python3 gnupg >/dev/null
if ! apt-get install -y -qq caddy >/dev/null 2>&1; then          # Ubuntu 22.04 has no caddy package: use Caddy's own repository
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null 2>&1
docker compose version >/dev/null || die "Docker Compose is missing."
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) and Caddy ready"

mkdir -p "$MEDIA_DIR/Movies" "$MEDIA_DIR/TV Shows" "$MEDIA_DIR/Kids" "$MEDIA_DIR/Premium Movies"
ok "Film folders in $MEDIA_DIR"

# ── firewall ─────────────────────────────────────────────────────────────────
bold "Firewall"
# keep whatever port you are connected on now, so the firewall can't lock you out
SSH_PORT="${SSH_CONNECTION:-}"; SSH_PORT="${SSH_PORT##* }"   # empty under sudo, which clears SSH_CONNECTION
[ -n "$SSH_PORT" ] || SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
SSH_PORT="${SSH_PORT:-22}"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "$SSH_PORT"/tcp comment 'SSH' >/dev/null
ufw delete allow 443/tcp >/dev/null 2>&1 || true     # remove any older "443 from everyone" rule
IFS=',' read -r -a NETS <<< "${ALLOWED_NETWORKS// /}"
web_from() {   # web_from PORT
  if [ ${#NETS[@]} -gt 0 ] && [ -n "${NETS[0]}" ]; then
    for n in "${NETS[@]}"; do ufw allow from "$n" to any port "$1" proto tcp comment 'Flex customers' >/dev/null; done
  else
    ufw allow "$1"/tcp comment 'Flex' >/dev/null
  fi
}
if [ -n "$DOMAIN" ]; then
  ufw allow 80/tcp comment 'HTTPS certificates + redirect' >/dev/null    # Let's Encrypt must reach port 80
  web_from 443
else
  web_from 80
fi
ufw --force enable >/dev/null
ok "Open: SSH ($SSH_PORT), web $( [ -n "$DOMAIN" ] && echo '80 for certificates, 443' || echo 80 ) from ${ALLOWED_NETWORKS:-everyone}"
warn "SSH is open to all. To limit it later: ufw allow from 102.216.116.0/24 to any port $SSH_PORT && ufw delete allow $SSH_PORT/tcp"

# ── HTTPS front door ─────────────────────────────────────────────────────────
bold "Web address"
{
  if [ -n "$CERT_EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$CERT_EMAIL"; fi
  if [ -n "$DOMAIN" ]; then printf '%s {\n' "$DOMAIN"; else printf ':80 {\n'; fi
  printf '\tencode gzip\n\treverse_proxy 127.0.0.1:8080\n}\n'
} > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null 2>&1; systemctl restart caddy
ok "Caddy serving ${DOMAIN:-http://$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')}"

# ── media engine ─────────────────────────────────────────────────────────────
bold "Media engine"
cd "$FLEX_DIR"
docker compose up -d jellyfin >/dev/null 2>&1
JF=http://127.0.0.1:8096
for i in $(seq 1 60); do curl -fsS "$JF/System/Info/Public" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$JF/System/Info/Public" >/dev/null || die "Media engine did not start. Check: docker compose logs jellyfin"
HDR='MediaBrowser Client="Flex Installer", Device="install", DeviceId="flex-install", Version="1.0"'
WIZARD_DONE=$(curl -fsS "$JF/System/Info/Public" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("StartupWizardCompleted",False))')

if [ "$WIZARD_DONE" != "True" ]; then
  JF_ADMIN_USER="flexadmin"
  JF_ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  curl -fsS -X POST "$JF/Startup/Configuration" -H "Authorization: $HDR" -H 'Content-Type: application/json' \
    -d '{"UICulture":"en-US","MetadataCountryCode":"KE","PreferredMetadataLanguage":"en"}' >/dev/null
  curl -fsS "$JF/Startup/User" -H "Authorization: $HDR" >/dev/null || true
  curl -fsS -X POST "$JF/Startup/User" -H "Authorization: $HDR" -H 'Content-Type: application/json' \
    -d "{\"Name\":\"$JF_ADMIN_USER\",\"Password\":\"$JF_ADMIN_PASS\"}" >/dev/null
  curl -fsS -X POST "$JF/Startup/RemoteAccess" -H "Authorization: $HDR" -H 'Content-Type: application/json' \
    -d '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}' >/dev/null || true
  curl -fsS -X POST "$JF/Startup/Complete" -H "Authorization: $HDR" >/dev/null
  printf 'Flex media engine admin\n  user: %s\n  password: %s\n  open with: ssh -L 8096:127.0.0.1:8096 root@THIS-SERVER  then http://localhost:8096\n' \
    "$JF_ADMIN_USER" "$JF_ADMIN_PASS" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  ok "Admin account created (saved in $CRED_FILE)"
else
  JF_ADMIN_USER=$(sed -n 's/^  user: //p' "$CRED_FILE" 2>/dev/null || true)
  JF_ADMIN_PASS=$(sed -n 's/^  password: //p' "$CRED_FILE" 2>/dev/null || true)
  ok "Already set up"
fi

if [ -z "$(getenv JELLYFIN_API_KEY)" ]; then
  [ -n "${JF_ADMIN_USER:-}" ] && [ -n "${JF_ADMIN_PASS:-}" ] || die "Engine is set up but I don't have its admin login. Create an API key in the engine (Dashboard > API Keys), then: echo JELLYFIN_API_KEY=... and re-run."
  TOKEN=$(curl -fsS -X POST "$JF/Users/AuthenticateByName" -H "Authorization: $HDR" -H 'Content-Type: application/json' \
    -d "{\"Username\":\"$JF_ADMIN_USER\",\"Pw\":\"$JF_ADMIN_PASS\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessToken"])')
  AUTH="$HDR, Token=\"$TOKEN\""
  # libraries (names must match config/packages.yaml)
  EXISTING=$(curl -fsS "$JF/Library/VirtualFolders" -H "Authorization: $AUTH" | python3 -c 'import json,sys;print("|".join(f["Name"] for f in json.load(sys.stdin)))')
  add_lib() {   # add_lib "Name" type folder
    case "|$EXISTING|" in *"|$1|"*) return;; esac
    local q; q=$(python3 -c 'import sys,urllib.parse as u;print(u.urlencode({"name":sys.argv[1],"collectionType":sys.argv[2],"refreshLibrary":"false"}))' "$1" "$2")
    curl -fsS -X POST "$JF/Library/VirtualFolders?$q" -H "Authorization: $AUTH" -H 'Content-Type: application/json' \
      -d "{\"LibraryOptions\":{\"EnableRealtimeMonitor\":true,\"PathInfos\":[{\"Path\":\"$3\"}]}}" >/dev/null && ok "Library: $1"
  }
  add_lib "Movies" movies "/media/Movies"
  add_lib "TV Shows" tvshows "/media/TV Shows"
  add_lib "Kids" movies "/media/Kids"
  add_lib "Premium Movies" movies "/media/Premium Movies"
  curl -fsS -X POST "$JF/Auth/Keys?app=Flex" -H "Authorization: $AUTH" >/dev/null
  KEY=$(curl -fsS "$JF/Auth/Keys" -H "Authorization: $AUTH" | python3 -c 'import json,sys
items=[k for k in json.load(sys.stdin)["Items"] if k.get("AppName")=="Flex"]
print(items[-1]["AccessToken"] if items else "")')
  [ -n "$KEY" ] || die "Could not create the media engine API key."
  setenv JELLYFIN_API_KEY "$KEY"
  ok "API key created for Flex"
fi

# ── Splynx check ─────────────────────────────────────────────────────────────
bold "Splynx"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SPLYNX_URL/api/2.0/admin/customers/customer?limit=1" || echo 000)
case "$code" in
  401|200) ok "Splynx reachable at $SPLYNX_URL" ;;
  000)     warn "Can't reach $SPLYNX_URL from this server. Check the address and that Splynx allows this server." ;;
  *)       warn "Splynx answered HTTP $code. Continuing; the sync log will show details." ;;
esac

# ── start everything ─────────────────────────────────────────────────────────
bold "Starting Flex"
docker compose up -d --build 2>&1 | tail -n 4
sleep 5
bold "Checking the Splynx API key"
docker compose exec -T splynx-sync python sync.py check || warn "Fix the items above (in Splynx), then run: cd $FLEX_DIR && docker compose exec splynx-sync python sync.py check"
docker compose exec -T splynx-sync python sync.py once 2>&1 | tail -n 6 || warn "First sync reported a problem (see above)."

grep -q "^Director page" "$CRED_FILE" 2>/dev/null || printf 'Director page (approves Premium)\n  address: /director\n  password: %s\n' "$(getenv DIRECTOR_PASSWORD)" >> "$CRED_FILE"
chmod 600 "$CRED_FILE" 2>/dev/null || true
bold "Done"
URL=$( [ -n "$DOMAIN" ] && echo "https://$DOMAIN" || echo "http://$(curl -s -4 --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')" )
echo "  App:            $URL"
echo "  Allowed from:   ${ALLOWED_NETWORKS:-everyone}"
echo "  Director page:  $URL/director   (password: $(getenv DIRECTOR_PASSWORD))"
echo "  Engine admin:   ssh -L 8096:127.0.0.1:8096 root@THIS-SERVER, then http://localhost:8096 (login in $CRED_FILE)"
echo "  Films go in:    $MEDIA_DIR/Movies/Title (Year)/Title (Year).mp4"
echo "  Sync log:       cd $FLEX_DIR && docker compose logs -f splynx-sync"
[ -n "$DOMAIN" ] && echo "  DNS:            make sure $DOMAIN points to this server, or HTTPS can't be issued."
echo
