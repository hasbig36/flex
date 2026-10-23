#!/usr/bin/env python3
"""
Turn your Flex .env into a RouterOS script that sets up the containers.

Everything on the router (app, sync and media engine):
  python3 mikrotik/make-rsc.py --disk usb1 --listen-ip 41.90.10.2 --office-subnet 192.168.88.0/24 \
      --domain tv.your-isp.co.ke > flex.rsc

App and sync on the router, media engine on a separate PC (recommended for most routers):
  python3 mikrotik/make-rsc.py --disk usb1 --listen-ip 41.90.10.2 \
      --engine-url http://192.168.88.20:8096 --domain tv.your-isp.co.ke > flex.rsc

Then upload flex.rsc to the router and run:  /import flex.rsc
The script contains your API keys: delete it from the router and your PC afterwards.
"""
import argparse
import datetime
import ipaddress
import os
import sys

PLACEHOLDER = "SET-AFTER-ENGINE-SETUP"
SKIP_KEYS = {"PORTAL_PORT", "ENGINE_ADMIN_BIND", "MEDIA_PATH"}   # docker-compose only


def read_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k] = v
    return env


def q(value):
    """Quote a value for a RouterOS script string."""
    s = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return f'"{s}"'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", default=".env", help="your filled-in .env file (default: .env)")
    ap.add_argument("--disk", required=True, help="router disk name as shown in /disk print, e.g. usb1, nvme1, disk1")
    ap.add_argument("--arch", default="arm64", choices=["arm64", "amd64", "arm"], help="matches build-images.sh")
    ap.add_argument("--listen-ip", required=True, help="router IP that customers open the app on (public or customer-facing)")
    ap.add_argument("--port", type=int, default=8080, help="app port when not using --domain (default 8080)")
    ap.add_argument("--domain", help="public name for HTTPS, e.g. tv.your-isp.co.ke (adds a Caddy container with free Let's Encrypt certificates)")
    ap.add_argument("--engine-url", help="use a media engine on another machine, e.g. http://192.168.88.20:8096 (skips the engine container)")
    ap.add_argument("--office-subnet", default="192.168.88.0/24", help="subnet allowed to open the engine admin page (default 192.168.88.0/24)")
    ap.add_argument("--subnet", default="172.20.0.0/24", help="internal container network (default 172.20.0.0/24)")
    ap.add_argument("--dns", help="DNS server for the containers (default: the router itself on the container network)")
    ap.add_argument("--jellyfin-image", default="jellyfin/jellyfin:10.10.7")
    ap.add_argument("--caddy-image", default="caddy:2.8.4")
    a = ap.parse_args()

    if not os.path.exists(a.env):
        sys.exit(f"Can't find {a.env}. Run this from the flex folder after filling in .env")
    env = read_env(a.env)
    for need in ("SPLYNX_URL", "SPLYNX_API_KEY", "SPLYNX_API_SECRET"):
        if not env.get(need):
            sys.exit(f"{need} is empty in {a.env}. Fill it in first.")
    if a.arch == "arm" and not a.engine_url:
        sys.exit("The media engine has no 32-bit ARM version. Use --engine-url to point at a separate PC.")

    net = ipaddress.ip_network(a.subnet)
    hosts = list(net.hosts())
    gw, ip_portal, ip_sync, ip_engine, ip_caddy = (str(h) for h in hosts[:5])
    plen = net.prefixlen
    dns = a.dns or gw
    D = a.disk.strip("/")
    base = f"{D}/flex"
    engine_url = a.engine_url.rstrip("/") if a.engine_url else f"http://{ip_engine}:8096"
    local_engine = not a.engine_url

    L = []
    w = L.append
    w(f"# Flex for RouterOS 7 containers, generated {datetime.date.today()}")
    w(f"# Disk: {D}   Arch: {a.arch}   Container network: {a.subnet}")
    w(f"# Media engine: {'on this router' if local_engine else engine_url}")
    w("# Contains API keys. Delete this file from the router after /import.")
    w("")
    w("# ── registry and temp folder (big images are unpacked on the disk, not in RAM) ──")
    w(f"/container/config/set registry-url=https://registry-1.docker.io tmpdir={base}/tmp")
    w("")
    w("# ── container network ──")
    w(f'/interface/bridge/add name=flex-br comment="Flex containers"')
    w(f"/ip/address/add address={gw}/{plen} interface=flex-br")
    vets = [("mh-portal", ip_portal), ("mh-sync", ip_sync)]
    if local_engine:
        vets.append(("mh-engine", ip_engine))
    if a.domain:
        vets.append(("mh-https", ip_caddy))
    for name, ip in vets:
        w(f"/interface/veth/add name={name} address={ip}/{plen} gateway={gw}")
        w(f"/interface/bridge/port/add bridge=flex-br interface={name}")
    w('# let the containers use the router for DNS like any LAN device (ignored if there is no LAN list)')
    w(':do { /interface/list/member/add list=LAN interface=flex-br } on-error={ :put "No LAN interface list, skipped" }')
    w(f'/ip/firewall/nat/add chain=srcnat action=masquerade src-address={a.subnet} comment="Flex containers out"')
    w("")
    w("# ── customers reach the app ──")
    if a.domain:
        for port in (80, 443):
            w(f'/ip/firewall/nat/add chain=dstnat action=dst-nat protocol=tcp dst-address={a.listen_ip} dst-port={port} '
              f'to-addresses={ip_caddy} to-ports={port} comment="Flex HTTPS"')
        w("# Port 80/443 on this IP now go to Flex. If you use WebFig on this IP, move it: /ip/service/set www port=8081")
    else:
        w(f'/ip/firewall/nat/add chain=dstnat action=dst-nat protocol=tcp dst-address={a.listen_ip} dst-port={a.port} '
          f'to-addresses={ip_portal} to-ports=8080 comment="Flex app"')
    if local_engine:
        w("")
        w("# ── staff reach the media engine admin page, from the office only ──")
        w(f'/ip/firewall/nat/add chain=dstnat action=dst-nat protocol=tcp dst-address-type=local dst-port=8096 '
          f'src-address={a.office_subnet} to-addresses={ip_engine} to-ports=8096 comment="Flex engine admin (office only)"')
        w(f"# From the office, open http://<any router IP>:8096")
    w("")

    # environment
    w("# ── settings (from your .env) ──")
    common = {k: v for k, v in env.items() if k not in SKIP_KEYS and v != ""}
    if not common.get("JELLYFIN_API_KEY"):
        common["JELLYFIN_API_KEY"] = PLACEHOLDER
    common["JELLYFIN_URL"] = engine_url
    common["STATE_FILE"] = "/data/state.json"
    common.setdefault("TZ", "Africa/Nairobi")
    portal_env = dict(common, PORT="8080", SESSIONS_FILE="/data/portal-sessions.json")
    if a.domain:
        portal_env.setdefault("COOKIE_SECURE", "true")
    sync_env = dict(common, PACKAGES_FILE="/config/packages.yaml")
    for lst, envmap in (("mh-portal", portal_env), ("mh-sync", sync_env)):
        for k in sorted(envmap):
            w(f"/container/envs/add list={lst} key={k} value={q(envmap[k])}")
    if local_engine:
        w(f'/container/envs/add list=mh-engine key=TZ value={q(common["TZ"])}')
    w("")

    # mounts
    w("# ── folders on the router disk ──")
    w(f"/container/mounts/add list=mh-portal src={base}/data dst=/data")
    w(f"/container/mounts/add list=mh-portal src={base}/config dst=/config")
    w(f"/container/mounts/add list=mh-sync src={base}/data dst=/data")
    w(f"/container/mounts/add list=mh-sync src={base}/config dst=/config")
    if local_engine:
        w(f"/container/mounts/add list=mh-engine src={base}/engine/config dst=/config")
        w(f"/container/mounts/add list=mh-engine src={base}/engine/cache dst=/cache")
        w(f"/container/mounts/add list=mh-engine src={D}/media dst=/media")
    if a.domain:
        w(f"/container/mounts/add list=mh-https src={base}/https dst=/data")
    w("")

    # containers
    w("# ── containers ──")
    if local_engine:
        w(f"/container/add name=flex-engine remote-image={a.jellyfin_image} interface=mh-engine "
          f"root-dir={base}/root/engine mountlists=mh-engine envlist=mh-engine dns={dns} hostname=engine "
          f"start-on-boot=yes logging=yes")
    w(f"/container/add name=flex-portal file={base}/images/flex-portal-{a.arch}.tar interface=mh-portal "
      f"root-dir={base}/root/portal mountlists=mh-portal envlist=mh-portal dns={dns} hostname=portal "
      f"start-on-boot=yes logging=yes")
    w(f"/container/add name=flex-sync file={base}/images/flex-sync-{a.arch}.tar interface=mh-sync "
      f"root-dir={base}/root/sync mountlists=mh-sync envlist=mh-sync dns={dns} hostname=sync "
      f"start-on-boot=yes logging=yes")
    if a.domain:
        w(f"/container/add name=flex-https remote-image={a.caddy_image} interface=mh-https "
          f"root-dir={base}/root/https mountlists=mh-https dns={dns} hostname=https "
          f'cmd={q(f"caddy reverse-proxy --from {a.domain} --to {ip_portal}:8080")} '
          f"start-on-boot=yes logging=yes")
    w("")
    w("# ── wait for images to unpack, then start (can take several minutes on first install) ──")
    names = (["flex-engine"] if local_engine else []) + ["flex-portal", "flex-sync"] + (["flex-https"] if a.domain else [])
    w(':foreach n in={' + ";".join(f'"{n}"' for n in names) + '} do={')
    w('  :local tries 0')
    w('  :local st "extracting"')
    w('  :while (($st = "extracting") && ($tries < 180)) do={')
    w('    :do { :set st [/container/get [find where name=$n] status] } on-error={ :set st "unknown" }')
    w('    :if ($st = "extracting") do={ :delay 5s; :set tries ($tries + 1) }')
    w('  }')
    w('  :do { /container/start [find where name=$n]; :put ("started " . $n) } on-error={ :put ("could not start " . $n . ", check /log print where topics~\\"container\\"") }')
    w('  :delay 3s')
    w('}')
    w(':put "Flex containers created. Next steps: mikrotik/README.md, step 6."')
    print("\n".join(L))


if __name__ == "__main__":
    main()
