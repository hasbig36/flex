#!/usr/bin/env python3
"""
Flex ⇄ Splynx sync service.

Every SYNC_INTERVAL seconds it:
  1. Reads customers and their media services (tariffs) from the Splynx API.
  2. Works out each customer's entitlements from config/packages.yaml
     (movie libraries, live-TV channel groups, max simultaneous streams).
  3. Creates / updates / suspends / removes the matching account in the
     media engine (Jellyfin, kept private behind the portal).
  4. Writes /data/state.json, which the customer portal reads to decide
     who can log in and which live channels they may open.

Commands:
  python sync.py run          loop forever (default, used by Docker)
  python sync.py once         one sync pass, then exit
  python sync.py dry-run      show what would change, change nothing
  python sync.py show LOGIN   print a customer's entitlements (and access code in local auth mode)
  python sync.py check        test the Splynx API key, its permissions and the media engine key
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import string
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

import requests
import yaml

# ───────────────────────────── configuration ──────────────────────────────

def env(name: str, default: str | None = None, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        sys.exit(f"[config] Missing required environment variable {name}")
    return val or ""


SPLYNX_URL = env("SPLYNX_URL", required=True).rstrip("/")          # https://splynx.example.com
SPLYNX_API_KEY = env("SPLYNX_API_KEY", required=True)
SPLYNX_API_SECRET = env("SPLYNX_API_SECRET", required=True)
SPLYNX_AUTH = env("SPLYNX_AUTH", "signature")                      # signature | basic
SPLYNX_VERIFY_TLS = env("SPLYNX_VERIFY_TLS", "true").lower() != "false"

JELLYFIN_URL = env("JELLYFIN_URL", "http://jellyfin:8096").rstrip("/")
JELLYFIN_API_KEY = env("JELLYFIN_API_KEY", required=True)

PACKAGES_FILE = env("PACKAGES_FILE", "/config/packages.yaml")
STATE_FILE = env("STATE_FILE", "/data/state.json")
APPROVALS_FILE = env("APPROVALS_FILE", os.path.join(os.path.dirname(STATE_FILE) or ".", "approvals.json"))
SYNC_INTERVAL = int(env("SYNC_INTERVAL", "300"))
USER_PREFIX = env("MEDIA_USER_PREFIX", "sx_")
DELETE_AFTER_DAYS = int(env("DELETE_AFTER_DAYS", "30"))            # 0 = never delete, only disable
SUSPEND_ON_BLOCKED = env("SUSPEND_ON_BLOCKED", "true").lower() != "false"
AUTH_MODE = env("AUTH_MODE", "splynx")                              # splynx | local
WRITEBACK_ATTRIBUTE = env("SPLYNX_ACCESS_CODE_ATTRIBUTE", "")       # e.g. media_access_code (local mode)
CONCURRENCY = int(env("SYNC_CONCURRENCY", "8"))

logging.basicConfig(
    level=env("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(message)s",
)
log = logging.getLogger("sync")


# ───────────────────────────── Splynx client ──────────────────────────────

class Splynx:
    """Minimal Splynx REST API v2 client (admin API key)."""

    def __init__(self) -> None:
        self.base = f"{SPLYNX_URL}/api/2.0/"
        self.s = requests.Session()
        self.s.verify = SPLYNX_VERIFY_TLS
        self._nonce = int(time.time() * 100)

    def _auth_header(self) -> str:
        if SPLYNX_AUTH == "basic":
            import base64
            tok = base64.b64encode(f"{SPLYNX_API_KEY}:{SPLYNX_API_SECRET}".encode()).decode()
            return f"Basic {tok}"
        # Splynx-EA signature: HMAC-SHA256(secret, nonce + key), upper-case hex
        self._nonce = max(self._nonce + 1, int(time.time() * 100))
        sig = hmac.new(
            SPLYNX_API_SECRET.encode(), f"{self._nonce}{SPLYNX_API_KEY}".encode(), hashlib.sha256
        ).hexdigest().upper()
        return f"Splynx-EA (key={SPLYNX_API_KEY}&nonce={self._nonce}&signature={sig})"

    def get(self, path: str, params: dict | None = None, none_on_404: bool = False):
        for attempt in range(4):
            r = self.s.get(self.base + path, params=params,
                           headers={"Authorization": self._auth_header()}, timeout=30)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 404:
                return None if none_on_404 else []
            r.raise_for_status()
            return r.json() if r.content else []
        r.raise_for_status()

    def put(self, path: str, body: dict):
        r = self.s.put(self.base + path, json=body,
                       headers={"Authorization": self._auth_header()}, timeout=30)
        r.raise_for_status()

    def list_all(self, path: str, params: dict | None = None, page: int = 500) -> list[dict]:
        """Page through a collection; safe whether or not the API honours limit/offset."""
        out, seen, offset = [], set(), 0
        while True:
            p = dict(params or {}, limit=page, offset=offset)
            rows = self.get(path, p) or []
            if isinstance(rows, dict):
                rows = list(rows.values())
            new = [r for r in rows if r.get("id") not in seen]
            if not new:
                break
            for r in new:
                seen.add(r.get("id"))
            out.extend(new)
            if len(rows) < page:
                break
            offset += page
        return out

    def customers(self) -> list[dict]:
        return self.list_all("admin/customers/customer")

    # Newer Splynx calls add-on plans "Recurring" (recurring-services, tariffs/recurring);
    # older versions call them "Custom". "custom" and "recurring" both try both names.
    ALIASES = {"custom": ["recurring", "custom"], "recurring": ["recurring", "custom"]}
    _resolved: dict[str, str] = {}

    def _service_paths(self, kind: str) -> list[str]:
        if kind in self._resolved:
            return [self._resolved[kind]]
        return self.ALIASES.get(kind, [kind])

    def services(self, customer_id, kind: str) -> list[dict]:
        for name in self._service_paths(kind):
            rows = self.get(f"admin/customers/customer/{customer_id}/{name}-services", none_on_404=True)
            if rows is None:
                continue                          # this Splynx doesn't use that name
            self._resolved.setdefault(kind, name)
            return list(rows.values()) if isinstance(rows, dict) else (rows or [])
        return []

    def tariff_names(self, kind: str) -> dict[str, str]:
        name = kind
        for cand in self._service_paths(kind):
            if self.get(f"admin/tariffs/{cand}", {"limit": 1}, none_on_404=True) is not None:
                name = cand
                break
        try:
            rows = self.list_all(f"admin/tariffs/{name}")
        except requests.HTTPError as e:
            log.warning("Could not read %s tariffs (%s); name matching disabled", kind, e)
            return {}
        return {str(t.get("id")): str(t.get("title") or t.get("name") or "") for t in rows}

    def set_customer_attribute(self, customer_id, name: str, value: str) -> None:
        self.put(f"admin/customers/customer/{customer_id}", {"additional_attributes": {name: value}})


# ───────────────────────────── Jellyfin client ────────────────────────────

class MediaEngine:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({
            "X-Emby-Token": JELLYFIN_API_KEY,
            "Authorization": f'MediaBrowser Token="{JELLYFIN_API_KEY}", Client="Flex Sync", '
                             f'Device="sync", DeviceId="flex-sync", Version="1.0"',
        })

    def _req(self, method: str, path: str, **kw):
        r = self.s.request(method, JELLYFIN_URL + path, timeout=30, **kw)
        r.raise_for_status()
        return r.json() if r.content and "json" in r.headers.get("content-type", "") else None

    def users(self) -> list[dict]:
        return self._req("GET", "/Users") or []

    def libraries(self) -> dict[str, str]:
        """library name (lower-case) -> library id"""
        rows = self._req("GET", "/Library/VirtualFolders") or []
        return {r["Name"].lower(): r["ItemId"] for r in rows if r.get("ItemId")}

    def create_user(self, name: str, password: str) -> dict:
        return self._req("POST", "/Users/New", json={"Name": name, "Password": password})

    def set_password(self, user_id: str, password: str) -> None:
        self._req("POST", f"/Users/{user_id}/Password", json={"ResetPassword": True})
        self._req("POST", f"/Users/{user_id}/Password", json={"CurrentPw": "", "NewPw": password})

    def set_policy(self, user: dict, *, disabled: bool, folders: list[str]) -> None:
        pol = dict(user.get("Policy") or {})
        pol.update({
            "IsAdministrator": False,
            "IsHidden": True,
            "IsDisabled": disabled,
            "EnableAllFolders": False,
            "EnabledFolders": folders,
            "EnableAllChannels": False,
            "EnabledChannels": [],
            "EnableLiveTvAccess": False,       # live TV is served & policed by the portal
            "EnableLiveTvManagement": False,
            "EnableContentDeletion": False,
            "EnableContentDownloading": False,
            "EnablePublicSharing": False,
            "EnableRemoteControlOfOtherUsers": False,
            "EnableSharedDeviceControl": False,
            "EnableMediaPlayback": True,
            "EnableRemoteAccess": True,
            "EnableUserPreferenceAccess": False,
            # 0 = unlimited logins; the portal enforces the plan's stream limit
            # across live TV and movies together, so customers can still sign in
            # on several devices.
            "MaxActiveSessions": 0,
        })
        self._req("POST", f"/Users/{user['Id']}/Policy", json=pol)

    def delete_user(self, user_id: str) -> None:
        self._req("DELETE", f"/Users/{user_id}")


# ───────────────────────────── helpers ────────────────────────────────────

def load_packages() -> dict:
    with open(PACKAGES_FILE, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    cfg.setdefault("tariffs", {})
    cfg.setdefault("tariff_names", {})
    cfg.setdefault("packages", {})
    cfg.setdefault("service_types", ["recurring"])
    cfg["tariffs"] = {str(k): v for k, v in (cfg["tariffs"] or {}).items()}
    cfg["tariff_names"] = {str(k).lower(): v for k, v in (cfg["tariff_names"] or {}).items()}
    return cfg


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": 1, "customers": {}}


def save_state(state: dict) -> None:
    state["login_index"] = {
        c["login"].lower(): cid for cid, c in state["customers"].items() if c.get("login")
    }
    d = os.path.dirname(STATE_FILE) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".state.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o640)
    os.replace(tmp, STATE_FILE)


def gen_secret(n: int = 24) -> str:
    return secrets.token_urlsafe(n)


def gen_access_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def media_username(login: str, cid: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", login or "")[:40] or "cust"
    return f"{USER_PREFIX}{clean}_{cid}"


def service_is_live(svc: dict) -> bool:
    if str(svc.get("status", "")).lower() != "active":
        return False
    today = date.today().isoformat()
    start = str(svc.get("start_date") or "")
    end = str(svc.get("end_date") or "")
    if start and not start.startswith("0000") and start > today:
        return False
    if end and not end.startswith("0000") and end < today:
        return False
    return True


def load_approvals() -> dict:
    """Director decisions, written by the Flex director page: {key: {decision, by, at, note}}."""
    try:
        with open(APPROVALS_FILE, encoding="utf-8") as f:
            return json.load(f) or {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def entitlements_for(services: list[dict], cfg: dict, names: dict[str, str],
                     cid: str = "", approvals: dict | None = None) -> dict:
    """Work out what a customer may watch. Packages marked requires_approval only count
    once the director has approved that exact Splynx service; until then the customer
    gets the package's while_pending packages instead."""
    approvals = approvals or {}
    packages: list[str] = []
    requests_: list[dict] = []
    pending: list[str] = []

    def add(p):
        if p not in packages:
            packages.append(p)

    for svc in services:
        if not service_is_live(svc):
            continue
        tid = str(svc.get("tariff_id", ""))
        pk = cfg["tariffs"].get(tid)
        if pk is None:
            pk = cfg["tariff_names"].get(names.get(tid, "").lower())
        for p in pk or []:
            spec = cfg["packages"].get(p) or {}
            if not spec.get("requires_approval"):
                add(p)
                continue
            key = f"{cid}:{svc.get('id')}:{p}"
            decision = (approvals.get(key) or {}).get("decision")
            if decision == "approved":
                add(p)
                continue
            if p not in pending:
                pending.append(p)
            for fb in spec.get("while_pending", []) or []:
                add(fb)
            requests_.append({
                "key": key, "package": p, "package_label": spec.get("label", p),
                "service_id": svc.get("id"), "tariff_id": tid,
                "tariff": names.get(tid) or svc.get("description") or f"Tariff {tid}",
                "price": svc.get("unit_price"), "start_date": svc.get("start_date"),
                "decision": decision or "pending",
            })

    libs, groups, streams = [], [], 0
    for p in packages:
        spec = cfg["packages"].get(p)
        if not spec:
            log.warning("Tariff refers to unknown package '%s' (check packages.yaml)", p)
            continue
        for lib in spec.get("libraries", []) or []:
            if lib not in libs:
                libs.append(lib)
        for g in spec.get("channel_groups", []) or []:
            if g not in groups:
                groups.append(g)
        streams += int(spec.get("max_streams", 1) or 0)
    return {"packages": packages, "libraries": libs, "channel_groups": groups,
            "max_streams": streams, "pending_approval": pending, "_requests": requests_}


# ───────────────────────────── the sync pass ──────────────────────────────

def sync_once(dry_run: bool = False) -> dict:
    t0 = time.time()
    cfg = load_packages()
    state = load_state()
    sx, jf = Splynx(), MediaEngine()

    customers = sx.customers()
    log.info("Splynx: %d customers", len(customers))

    names: dict[str, str] = {}
    if cfg["tariff_names"]:
        for kind in cfg["service_types"]:
            names.update(sx.tariff_names(kind))

    # Only customers that could ever be entitled are worth a services call
    candidates = [c for c in customers if str(c.get("category", "")).lower() != "lead"]

    def fetch(c: dict):
        svcs = []
        for kind in cfg["service_types"]:
            try:
                svcs += sx.services(c["id"], kind)
            except requests.HTTPError as e:
                log.warning("Customer %s: cannot read %s services: %s", c["id"], kind, e)
        return c, svcs

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(fetch, candidates))

    libraries = jf.libraries()
    missing_libs: set[str] = set()
    users_by_name = {u["Name"].lower(): u for u in jf.users()}

    stats = {"active": 0, "suspended": 0, "created": 0, "updated": 0, "deleted": 0, "unchanged": 0,
             "awaiting_approval": 0}
    seen: set[str] = set()
    approvals = load_approvals()
    old_requests = state.get("approval_requests", {})
    approval_requests: dict[str, dict] = {}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for cust, svcs in results:
        cid = str(cust["id"])
        ent = entitlements_for(svcs, cfg, names, cid, approvals)
        reqs = ent.pop("_requests")
        has_media = bool(ent["packages"])
        prev = state["customers"].get(cid)
        if not has_media and not prev and not reqs:
            continue                                     # never had media – ignore
        for r in reqs:                                   # director approval queue
            old = old_requests.get(r["key"], {})
            r.update({"customer_id": cid, "login": cust.get("login", ""), "name": cust.get("name", ""),
                      "customer_status": str(cust.get("status", "")).lower(),
                      "first_seen": old.get("first_seen") or now})
            if not old and r["decision"] == "pending":
                log.info("Customer %s (%s): %s is waiting for director approval",
                         cid, r["login"], r["package_label"])
            approval_requests[r["key"]] = r
        if ent["pending_approval"]:
            stats["awaiting_approval"] += 1
        seen.add(cid)

        status = str(cust.get("status", "")).lower()
        # Splynx statuses: new, active, blocked, disabled ("Inactive" in the UI)
        allowed = has_media and (status == "active" or (status == "blocked" and not SUSPEND_ON_BLOCKED))

        rec = prev or {
            "splynx_id": cid,
            "jellyfin_username": media_username(cust.get("login", ""), cid),
            "jellyfin_password": gen_secret(),
            "created_at": now,
        }
        if AUTH_MODE == "local" and not rec.get("access_code"):
            rec["access_code"] = gen_access_code()
            if WRITEBACK_ATTRIBUTE and not dry_run:
                try:
                    sx.set_customer_attribute(cid, WRITEBACK_ATTRIBUTE, rec["access_code"])
                except requests.HTTPError as e:
                    log.warning("Customer %s: could not write access code to Splynx: %s", cid, e)

        new_view = {
            "login": cust.get("login", ""),
            "name": cust.get("name", ""),
            "email": cust.get("email", ""),
            "customer_status": status,
            "active": allowed,
            **ent,
        }
        if not allowed and has_media:
            new_view["suspended_reason"] = f"account {status}"
        elif not has_media and ent["pending_approval"]:
            new_view["suspended_reason"] = "awaiting approval"
        elif not has_media:
            new_view["suspended_reason"] = "no media plan"
        else:
            new_view.pop("suspended_reason", None)
            rec.pop("suspended_reason", None)

        # also re-provision if the engine lost the account (reinstall, restored backup...)
        missing_in_engine = rec.get("jellyfin_username", "").lower() not in users_by_name
        changed = (any(rec.get(k) != v for k, v in new_view.items())
                   or not rec.get("jellyfin_user_id") or missing_in_engine)
        rec.update(new_view)

        if allowed:
            stats["active"] += 1
            rec.pop("disabled_since", None)
        else:
            stats["suspended"] += 1
            rec.setdefault("disabled_since", now)

        folder_ids = []
        for lib in ent["libraries"]:
            lid = libraries.get(lib.lower())
            if lid:
                folder_ids.append(lid)
            else:
                missing_libs.add(lib)

        # delete long-suspended accounts
        if (not allowed and DELETE_AFTER_DAYS > 0 and rec.get("disabled_since")
                and (datetime.now(timezone.utc) - datetime.fromisoformat(rec["disabled_since"])).days
                >= DELETE_AFTER_DAYS):
            log.info("Customer %s (%s): removing media account (suspended %s+ days)",
                     cid, rec["login"], DELETE_AFTER_DAYS)
            if not dry_run:
                u = users_by_name.get(rec["jellyfin_username"].lower())
                if u:
                    jf.delete_user(u["Id"])
                state["customers"].pop(cid, None)
            stats["deleted"] += 1
            continue

        if not changed:
            stats["unchanged"] += 1
            state["customers"][cid] = rec
            continue

        log.info("Customer %s (%s): %s packages=%s streams=%s",
                 cid, rec["login"], "ACTIVE" if allowed else "SUSPENDED",
                 ",".join(ent["packages"]) or "-", ent["max_streams"])
        if dry_run:
            continue

        user = users_by_name.get(rec["jellyfin_username"].lower())
        if not user:
            user = jf.create_user(rec["jellyfin_username"], rec["jellyfin_password"])
            stats["created"] += 1
        else:
            stats["updated"] += 1
            if not prev:      # adopt an orphan account left over from an earlier install
                jf.set_password(user["Id"], rec["jellyfin_password"])
        jf.set_policy(user, disabled=not allowed, folders=folder_ids)
        rec["jellyfin_user_id"] = user["Id"]
        rec["updated_at"] = now
        state["customers"][cid] = rec

    # customers deleted from Splynx entirely
    for cid in [c for c in state["customers"] if c not in seen]:
        rec = state["customers"][cid]
        log.info("Customer %s (%s): no longer in Splynx — removing", cid, rec.get("login"))
        if not dry_run:
            u = users_by_name.get(rec["jellyfin_username"].lower())
            if u:
                jf.delete_user(u["Id"])
            state["customers"].pop(cid)
        stats["deleted"] += 1

    if missing_libs:
        log.warning("Libraries named in packages.yaml but not found in the media engine: %s",
                    ", ".join(sorted(missing_libs)))

    stats["seconds"] = round(time.time() - t0, 1)
    state["last_sync"] = {"at": now, "ok": True, **stats,
                          "missing_libraries": sorted(missing_libs)}
    state["packages"] = {k: {"label": v.get("label", k),
                             "channel_groups": v.get("channel_groups", []),
                             "libraries": v.get("libraries", [])}
                         for k, v in cfg["packages"].items()}
    state["upsell"] = cfg.get("upsell", {})
    state["approval_requests"] = approval_requests
    if not dry_run:
        save_state(state)
    log.info("Sync done in %ss: %s", stats["seconds"],
             ", ".join(f"{k}={v}" for k, v in stats.items() if k != "seconds"))
    return stats


def mark_failure(err: Exception) -> None:
    state = load_state()
    state.setdefault("last_sync", {})
    state["last_sync"].update({"ok": False, "error": str(err)[:500],
                               "failed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    try:
        save_state(state)
    except OSError:
        pass


def check() -> bool:
    """Test every connection Flex needs and explain what to fix."""
    ok_all = True
    def line(good, what, fix=""):
        nonlocal ok_all
        ok_all &= good
        print(("  OK    " if good else "  FAIL  ") + what + ("" if good or not fix else f"\n        -> {fix}"))
    sx = Splynx()
    print(f"Splynx: {SPLYNX_URL}")
    def status(path, params=None):
        try:
            r = sx.s.get(sx.base + path, params=params, headers={"Authorization": sx._auth_header()}, timeout=20)
            return r.status_code, (r.json() if r.content and "json" in r.headers.get("content-type", "") else None)
        except requests.RequestException as e:
            return 0, str(e)
    code, body = status("admin/customers/customer", {"limit": 1})
    if code == 0:
        line(False, "Reach Splynx", f"cannot connect ({body}). Check SPLYNX_URL and that this server can reach it.")
        return False
    if code == 401:
        line(False, "API key accepted", "Splynx rejected the key. Check SPLYNX_API_KEY / SPLYNX_API_SECRET, that the key is enabled, "
             "and that this server's IP is in the key's allowed IPs.")
        return False
    line(code == 200, "Read customers", "give the key permission: Customers > Customers (list and view).")
    first = (body or [None])[0] if isinstance(body, list) else None
    cfg = load_packages()
    for kind in cfg["service_types"]:
        found = None
        for name in Splynx.ALIASES.get(kind, [kind]):
            c, b = status(f"admin/tariffs/{name}", {"limit": 1000})
            if c != 404:
                found = (name, c, b); break
        if not found:
            line(False, f"Read {kind} tariffs", "this Splynx has no such tariff type; check service_types in packages.yaml")
            continue
        name, c, b = found
        line(c == 200, f"Read {name} tariffs", f"give the key permission: Tariffs > {name.capitalize()} (list and view).")
        if c == 200 and isinstance(b, list):
            titles = {str(t.get("id")): t.get("title") for t in b}
            for tid in cfg["tariffs"]:
                line(tid in titles, f"Tariff {tid} exists" + (f" ({titles[tid]})" if tid in titles else ""),
                     f"tariff ID {tid} in packages.yaml is not in Splynx")
        if first:
            c, _ = status(f"admin/customers/customer/{first['id']}/{name}-services")
            line(c == 200, f"Read customer {name} services", f"give the key permission: Customers > {name.capitalize()} services (list and view).")
    try:
        r = MediaEngine().s.get(JELLYFIN_URL + "/Users", timeout=10)
        line(r.status_code == 200, f"Media engine key ({JELLYFIN_URL})", f"engine answered {r.status_code}; check JELLYFIN_API_KEY")
    except requests.RequestException as e:
        line(False, f"Reach media engine ({JELLYFIN_URL})", str(e))
    print("\nAll good." if ok_all else "\nFix the items marked FAIL, then run this again.")
    return ok_all


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "once":
        sync_once()
    elif cmd == "check":
        sys.exit(0 if check() else 1)
    elif cmd == "dry-run":
        sync_once(dry_run=True)
    elif cmd == "show":
        if len(sys.argv) < 3:
            sys.exit("usage: sync.py show LOGIN")
        st = load_state()
        cid = st.get("login_index", {}).get(sys.argv[2].lower())
        if not cid:
            sys.exit("No media account for that login (yet).")
        rec = {k: v for k, v in st["customers"][cid].items() if k != "jellyfin_password"}
        print(json.dumps(rec, indent=2))
    elif cmd == "run":
        log.info("Flex sync starting — every %ss, auth mode %s", SYNC_INTERVAL, AUTH_MODE)
        while True:
            try:
                sync_once()
            except Exception as e:                       # keep running; portal keeps last good state
                log.exception("Sync failed: %s", e)
                mark_failure(e)
            # sleep, but react within seconds when the director approves or rejects something
            def mtime():
                try:
                    return os.stat(APPROVALS_FILE).st_mtime
                except OSError:
                    return 0
            seen_mtime, waited = mtime(), 0
            while waited < SYNC_INTERVAL:
                time.sleep(5); waited += 5
                if mtime() != seen_mtime:
                    log.info("Director decision received, syncing now")
                    break
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
