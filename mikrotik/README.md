# Running Flex on a MikroTik router (RouterOS containers)

RouterOS 7 can run containers. Flex has three parts, and they suit a router differently:

| Part | What it needs | On a MikroTik? |
|---|---|---|
| Customer app (`portal`) | About 100 MB RAM. It relays video, so it uses some CPU per viewer. | Yes |
| Splynx sync | About 50 MB RAM, and wakes every 5 minutes | Yes |
| Media engine (Jellyfin) | 1–2 GB RAM, plenty of disk, and CPU or GPU for converting video | Only on a big router, and only with H.264 files |

The media engine is the hard part. Routers have no graphics chip, so they can't convert video quickly. The engine is fine on a router only when your films are already **H.264 video with AAC audio** (most `.mp4` files): then it just repackages them, which is light work. HEVC/x265, 10-bit or 4K files need a full conversion, and a single viewer can max out a router's CPU.

## Pick a layout

**A. App and sync on the router, media engine on a small PC.** Recommended for most ISPs.
- Suitable routers: any arm64 or x86 router with at least 1 GB RAM and a USB 3 or NVMe disk, for example an RB5009.
- The media engine runs on a mini PC with an Intel CPU (Quick Sync handles about 15 streams), using the normal `docker compose` setup with only the `jellyfin` service.
- Copying films to the PC over the network is easy.

**B. Everything on the router.**
- Suitable routers: arm64 or x86 with 4 GB RAM or more, for example a CCR2116, or CHR on a server.
- Films must be H.264/AAC (see [Preparing films](#preparing-films)).
- Expect a handful of movie viewers at once. Live TV relaying is lighter.

Either way, customers see exactly the same app.

---

## 1. Check the router

In a terminal (Winbox → New Terminal):

```
/system/resource/print        # architecture-name should be arm64 or x86_64, plus free memory
/disk/print                   # note your disk name: usb1, nvme1, disk1 ...
```

- Use the **latest stable RouterOS 7**.
- Plug in a fast disk: a USB 3 SSD or NVMe. A slow USB stick makes everything slow.
- Format the disk as **ext4** in Winbox → System → Disks → Format. This erases it.

## 2. Install the container package and allow containers

1. Download the **Extra packages** zip for your RouterOS version and architecture from mikrotik.com/download.
2. Upload `container-7.xx-arm64.npk` (or the x86 version) to Files, then reboot.
3. Allow containers. This needs physical access to the router:

   ```
   /system/device-mode/update container=yes
   ```

   When asked, press the router's **reset button** briefly, or on x86 do a full power-off and power-on. Without this, containers won't start.

## 3. Build the two Flex images on your PC

On any PC with Docker Desktop, in the `flex` folder, run the line for your PC:

```
./mikrotik/build-images.sh arm64                                              # macOS / Linux
powershell -ExecutionPolicy Bypass -File mikrotik\build-images.ps1 arm64      # Windows
```

- Use `amd64` for CHR or an x86 router.
- Use `arm` for older 32-bit routers. These support layout A only.

This creates `mikrotik/out/flex-portal-arm64.tar` and `flex-sync-arm64.tar`. The media engine and the HTTPS helper are downloaded by the router itself from Docker Hub.

## 4. Copy files to the router disk

Using Winbox → Files (drag and drop), or `scp`:

| File | Put it in |
|---|---|
| `flex-portal-arm64.tar`, `flex-sync-arm64.tar` | `usb1/flex/images/` |
| `config/packages.yaml` (your tariff mapping) | `usb1/flex/config/` |
| `channels.m3u` / `epg.xml`, if you use files rather than URLs | `usb1/flex/config/` |
| Films (layout B only) | `usb1/media/Movies/Title (Year)/Title (Year).mp4` |

Replace `usb1` with your disk name.

If a folder doesn't exist yet, create it with `/file/add type=directory name=usb1/flex/images`, or create it in Winbox.

For many films in layout B, Winbox is too slow. Turn on the router's SMB file sharing for `usb1/media` (Winbox → IP → SMB) and copy films from an office PC.

## 5. Generate and run the setup script

First fill in `.env` (copy `.env.example`) as in the main README. On the PC, run the command that matches your layout.

Layout A (media engine on a PC at 192.168.88.20):

```
python3 mikrotik/make-rsc.py --disk usb1 --listen-ip 41.90.10.2 \
    --engine-url http://192.168.88.20:8096 --domain tv.your-isp.co.ke > flex.rsc
```

Layout B (everything on the router):

```
python3 mikrotik/make-rsc.py --disk usb1 --listen-ip 41.90.10.2 \
    --office-subnet 192.168.88.0/24 --domain tv.your-isp.co.ke > flex.rsc
```

The options:

- `--listen-ip`: the router address customers will use. It can be a public IP, or an IP on the customer network.
- `--domain`: adds free, automatic HTTPS. Point the DNS record of that name at `--listen-ip` first, and make sure ports 80 and 443 reach the router from the internet.
  - Without `--domain`, the app runs on plain HTTP on port 8080. Avoid that on public networks, because customers type their Splynx password into it.
  - Port 80 and 443 on that IP will go to Flex. If you use WebFig on the same IP, move it first: `/ip/service/set www port=8081`.
- `--office-subnet`: only this network can open the media engine's admin page.

Upload `flex.rsc` to the router and run:

```
/import flex.rsc
```

The script then:

- creates a container network (172.20.0.0/24) and the NAT rules
- loads your settings and mounts the disk folders
- creates the containers and starts them once they've unpacked. The first run can take several minutes.

**Delete `flex.rsc` afterwards** (from the router and your PC), because it contains your API keys.

## 6. Finish the media engine setup (layout B, or on your PC for layout A)

1. From the office, open `http://<router IP>:8096` and run the setup wizard:
   - Create a staff admin account.
   - Add libraries: Movies → `/media/Movies`, TV Shows → `/media/TV Shows`, and so on. The names must match `packages.yaml`.
2. Go to Dashboard → API Keys, create a key named `Flex`, and copy it.
3. On the router, save the key and restart the sync:

   ```
   /container/envs/set [find where list=mh-sync key=JELLYFIN_API_KEY] value="paste-the-key-here"
   /container/stop [find where name=flex-sync]
   /container/start [find where name=flex-sync]
   ```

4. Check that it worked:

   ```
   /log/print where topics~"container"
   ```

   You should see: `Sync done in 2.1s: active=212, suspended=9, created=221 ...`

5. Open `https://tv.your-isp.co.ke` (or `http://<listen-ip>:8080`) and sign in as a test customer.

## Day to day

| Task | Command |
|---|---|
| See what's running | `/container/print` |
| Logs | `/log/print where topics~"container"` |
| Run a sync now | `/container/shell flex-sync`, then `python sync.py once` |
| Preview what the sync would change | `/container/shell flex-sync`, then `python sync.py dry-run` |
| Change a setting | `/container/envs/set [find where list=mh-portal key=BRAND_NAME] value="New name"`, then stop and start that container |
| Change tariffs or packages | Edit `usb1/flex/config/packages.yaml`. It's picked up on the next sync, with no restart. |

**Updating Flex:**

1. Build new images on the PC and upload them over the old ones.
2. Remove the container: `/container/stop [find where name=flex-portal]`, then `/container/remove [find where name=flex-portal]`.
3. Add it again by running the matching `/container/add …` line from a freshly generated `flex.rsc`.

Customer data in `usb1/flex/data` is kept.

## Preparing films

For layout B, convert films to H.264/AAC once, on a PC, with `ffmpeg`:

```
ffmpeg -i "input.mkv" -map 0:v:0 -map 0:a:0 -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p \
       -c:a aac -b:a 160k -ac 2 -movflags +faststart "Salt Roads (2022).mp4"
```

Put subtitles next to the film as `Salt Roads (2022).en.srt`. Files that are already H.264 `.mp4` need nothing.

## Troubleshooting

| Problem | What to do |
|---|---|
| `could not start` after import | Check that device-mode is enabled (step 2) and the disk has free space. Then `/log/print where topics~"container"`. |
| The engine image won't download | The router needs internet access and DNS. Test with `/ping registry-1.docker.io`. |
| Sync log shows `401` from the media engine | `JELLYFIN_API_KEY` is still the placeholder. Do step 6. |
| Sync log shows errors from Splynx | Check `SPLYNX_URL` and the API key's permissions. The router must be able to reach Splynx. |
| HTTPS doesn't come up | The domain's DNS must point to `--listen-ip`, and ports 80 and 443 must reach the router. Look for `flex-https` in the logs. |
| Films stutter with several viewers | The router CPU is converting video. Use H.264 files, or move the media engine to a PC (layout A). |
| Customers can't reach the app | Check that the NAT rule's `dst-address` is the IP they actually use, and that your firewall allows `dstnat` traffic. MikroTik's default rules do. |
