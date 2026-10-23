# Flex: TV and movies for your internet customers, controlled from Splynx

Flex gives your customers a branded streaming app with movies, series and live TV.
Splynx decides who gets in and what they can watch: add a TV tariff to a customer and
their access appears within minutes; block them for non-payment and it pauses.

```
 Customers (phone / laptop / smart-TV browser)
        │  https://tv.your-isp.co.ke
        ▼
 ┌──────────────┐  reads access rules   ┌──────────────┐  every 5 min  ┌────────┐
 │    Portal    │◄──── state.json ──────│ Splynx sync  │──── API ─────►│ Splynx │
 │ (your brand) │                       └──────┬───────┘               └────────┘
 └──────┬───────┘                              │ creates / pauses accounts
        │ movies & series                      ▼
        └──────────────────────────────► Media engine (Jellyfin, private)
        │ live channels                        stores, scans and converts video files
        └──────────────────────────────► Your IPTV source (M3U)
```

Three containers:

| Container | What it does |
|---|---|
| `portal` | The customer app: sign-in, home screen, live TV guide, player, "My plan". It checks access on every request, enforces the screen limit across live TV and movies, and hides the media engine and your stream sources from customers. |
| `splynx-sync` | Reads customers and their TV tariffs from the Splynx API and works out each customer's packages. It then creates, updates, pauses or removes their media account. |
| `jellyfin` | The media engine behind the scenes. It scans your movie and series folders, fetches posters and descriptions, and converts video for browsers. Customers never see it. |

---

## Quick install (Ubuntu 22.04 / 24.04)

On the server:

```bash
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/hasbig36/flex /opt/flex
cd /opt/flex
sudo ./install.sh          # asks a few questions, then sets everything up
sudo ./update.sh           # later: pull the latest version and restart (settings are kept)
```

The installer asks for your web address, Splynx details and allowed networks. Then it:

- installs Docker, HTTPS (Caddy) and the firewall
- sets up the media engine (admin account, libraries and API key) by itself
- runs the first Splynx sync

The logins it creates (media engine admin, director password) are saved in `/root/flex-credentials.txt`. You can run it again any time; it keeps your settings.

## Only your customers' networks

Set `ALLOWED_NETWORKS` in `.env`, for example:

```
ALLOWED_NETWORKS=102.216.116.0/24,102.216.117.0/24
```

Anyone else gets a "works on our network only" page that shows their address. The block applies everywhere: sign-in, films, live TV and pictures. Blocked addresses are logged as `[access] blocked …`. The installer also limits the HTTPS port to these networks in the firewall. Port 80 stays open so the certificate can renew, but it only redirects to HTTPS.

If customers reach the server through private or CGNAT addresses (10.x, 100.64.x) rather than your public ranges, add those ranges too. The blocked page shows the address the server actually sees.

## Running on a MikroTik router

To run Flex as RouterOS 7 containers instead of Docker on a server, follow [mikrotik/README.md](mikrotik/README.md). It includes a script that builds the router images and one that writes the RouterOS setup script from your `.env`.

## 1. What you need

- A Linux server with Docker and Docker Compose. 4 cores and 8 GB RAM is fine for a start; transcoding is the heavy part (see [Sizing](#sizing)).
- Your video files, organised as `Movies/Title (Year)/Title (Year).mkv` and `TV Shows/Series/Season 01/…`.
- An IPTV source as an M3U playlist (from your headend, a licensed provider or a TV-over-IP encoder), and optionally an XMLTV guide.
- A Splynx admin API key.
- **Rights to distribute** every channel and film you put on the platform to your subscribers.

## 2. Set up Splynx

1. **Tariffs.** Under *Tariff plans → Recurring* (called *Custom* in older Splynx), create one tariff per TV product, for example:
   `TV Basic` (KES 300/mo), `TV Premium` (KES 800/mo), `Sports Add-on` (KES 500/mo), `Kids` (KES 200/mo).
   Note each tariff's ID.
2. **API key.** Under *Administration → Main → API keys*, create a key named `Flex`. Give it read access to:
   - Customers: customer, custom services (and internet services if you bundle TV into internet plans)
   - Tariffs: custom (and internet if bundling)

   Write access on Customers is only needed for the optional access-code write-back in local sign-in mode.
3. **Selling it.** Add the TV tariff to a customer as a service, like any other add-on. It is billed by Splynx as usual.

The sync treats a customer as entitled when **all** of these hold:

- The customer's status is **Active**. Blocked customers are paused when `SUSPEND_ON_BLOCKED=true`.
- At least one TV service is **Active**.
- Today falls between that service's start and end dates.

## 3. Map tariffs to packages

Edit `config/packages.yaml`. This is the one place that decides who can watch what:

```yaml
tariffs:            # Splynx tariff ID -> packages it unlocks
  101: [basic]
  102: [basic, premium]
  103: [sports]

packages:
  basic:
    label: "TV Basic"
    libraries: ["Movies", "TV Shows"]        # library names in the media engine
    channel_groups: ["News", "Local"]        # group-title in your M3U
    max_streams: 1                           # screens at once
  sports:
    label: "Sports Add-on"
    channel_groups: ["Sports"]
    max_streams: 1                           # add-ons ADD screens
```

- A customer with several TV services gets everything from all of them combined.
- You can match tariffs by name instead of ID with `tariff_names:`.
- Changes apply on the next sync. No restart is needed.

Channel groups come from your M3U playlist:

```
#EXTINF:-1 tvg-id="citizen.ke" tvg-logo="https://…/citizen.png" tvg-chno="2" group-title="Local",Citizen TV
http://headend.local/citizen/index.m3u8
```

Streams can be HLS (`.m3u8`, recommended) or raw MPEG-TS. Customers never see these URLs: the portal relays the stream and checks access on every segment.

## 4. Install

```bash
git clone <this folder> /opt/flex && cd /opt/flex
cp .env.example .env
nano .env                                   # Splynx URL + key, media path, M3U, brand
```

**First, set up the media engine (one time):**

```bash
docker compose up -d jellyfin
ssh -L 8096:127.0.0.1:8096 you@server       # from your PC, then open http://localhost:8096
```

1. Run the setup wizard and create an **admin** account with a strong password. This is for your staff only.
2. Add libraries pointing at `/media/Movies`, `/media/TV Shows` and so on. Name them exactly as you named them in `packages.yaml`.
3. Under *Dashboard → API Keys*, create a key named `Flex` and put it in `.env` as `JELLYFIN_API_KEY`.
4. Under *Dashboard → Playback*, enable hardware acceleration if your server has an Intel or AMD GPU, and uncomment `devices:` in `docker-compose.yml`.

**Then start everything:**

```bash
docker compose up -d --build
docker compose logs -f splynx-sync          # watch the first sync
```

Expected log output:

```
Splynx: 2140 customers
Customer 318 (amina): ACTIVE packages=basic,premium streams=4
Sync done in 6.2s: active=212, suspended=9, created=221, updated=0, deleted=0, unchanged=0
```

**Put it on HTTPS.** Add a reverse proxy in front of port 8080, for example Caddy:

```
tv.your-isp.co.ke {
    reverse_proxy 127.0.0.1:8080
}
```

## 5. Day-to-day

| You do in Splynx | Customer sees |
|---|---|
| Add `TV Basic` service | Can sign in within `SYNC_INTERVAL`, with Basic channels and libraries |
| Add `Sports Add-on` | Sports channels unlock, plus one more screen |
| Customer becomes Blocked (unpaid) | Kicked out of playback at the next sync, with an "access paused" screen that links to your customer portal |
| Customer pays and is Active again | Access returns, with watch history intact |
| Stop or remove the TV service | Access paused. The account is deleted after `DELETE_AFTER_DAYS`. |
| Customer deleted from Splynx | Media account removed |

Useful commands:

```bash
docker compose exec splynx-sync python sync.py once          # sync now
docker compose exec splynx-sync python sync.py dry-run       # preview changes, change nothing
docker compose exec splynx-sync python sync.py show amina    # one customer's packages
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://tv.your-isp.co.ke/api/admin/status
```

`/api/admin/status` returns the last sync result, active customers, signed-in sessions, live streams and channel count. Point your monitoring at it. `lastSync.ok=false` means Splynx or the engine was unreachable. In that case customers keep their last-known access until the next good sync.

`missing_libraries` in the status lists library names from `packages.yaml` that don't exist in the engine. Fix the spelling on one side.

## 6. Sign-in options

- **`AUTH_MODE=splynx`** (default): customers use their Splynx customer portal login and password. The portal checks them against Splynx using `POST /api/2.0/admin/auth/tokens` with `auth_type=customer`. Nothing new to remember, and password resets go through your existing portal.
- **`AUTH_MODE=local`**: each customer gets an 8-character access code. Support can read it with `sync.py show LOGIN`. If you set `SPLYNX_ACCESS_CODE_ATTRIBUTE`, it is also written into a Splynx additional field, so it appears on the customer's page in Splynx.

## 7. Branding

Set these in `.env` and restart the portal with `docker compose up -d portal`:

- `BRAND_NAME`, `BRAND_TAGLINE`
- `BRAND_ACCENT`: buttons, progress bars and highlights. Text colour on the accent adjusts automatically.
- `BRAND_LOGO_URL`: an SVG or PNG, about 30 px tall, used in place of the name.
- `BRAND_SUPPORT`: shown on sign-in, paused and plan screens.
- `UPGRADE_URL`: the "Upgrade my plan" button. Locked channels appear with a lock as an upgrade teaser; turn that off with `upsell.show_locked_channels: false`.

The app works in any modern browser on phones, laptops and smart TVs, and can be installed to the home screen as an app.

## Sizing

- **Live TV:** the portal relays the stream without re-encoding it, so cost is bandwidth only. Bandwidth is roughly bitrate × viewers, so 200 viewers × 4 Mbps ≈ 800 Mbps of on-net traffic.
- **Movies:** files already in H.264/AAC are repackaged almost for free. Other formats (HEVC, DTS and so on) are converted live:
  - about 2–4 simultaneous 1080p streams per 4 CPU cores
  - 15+ with an Intel iGPU (Quick Sync)
  
  Keep your library in H.264/AAC MP4 or MKV where you can.
- **Scaling:** run the portal on more machines behind a load balancer. They only need to share the `/data` volume.

## Security notes

- The media engine is never published to the internet. Each customer's engine token stays on the server and is added to requests there.
- Live segments are only fetched from the hosts in your playlist (plus `LIVETV_ALLOWED_HOSTS`), so the portal can't be used as an open proxy.
- Sign-in is rate-limited per IP to 10 tries per 15 minutes. Session cookies are HttpOnly and SameSite=Lax, and become Secure behind HTTPS.
- `/data/state.json` holds generated engine passwords (and access codes in local mode). It is readable only by the containers.

## Files

```
docker-compose.yml        the three services
.env.example              all settings, commented
config/packages.yaml      tariff → package → channels / libraries / screens
splynx-sync/sync.py       Splynx → media engine provisioning
mikrotik/                 RouterOS container setup: image build + .rsc generator
portal/src/server.js      customer API, sign-in, access checks, stream relay
portal/src/livetv.js      M3U playlist and XMLTV guide loader
portal/src/jellyfin.js    media engine client
portal/public/            the customer app (HTML/CSS/JS, no build step)
```
