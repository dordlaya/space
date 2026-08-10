#!/usr/bin/env python3
"""Space Map — server-authoritative edition (FastAPI + WebSockets).

The SERVER owns the one true world: users/stars, probes, collisions and growth
all live in this process. A single asyncio task ticks the simulation ~30x/sec
and broadcasts JSON snapshots to every connected client over a WebSocket
(/ws). Clients are thin renderers — they draw snapshots and send input
(join / login / reset) back via plain HTTP. Result: every tab/browser sees the
*same* probes, the same growth, the same board.

Concurrency model (important): everything runs on ONE asyncio event loop. The
sim task and the request handlers are cooperative coroutines, so there is no
preemption between awaits and therefore NO locks are needed — a handler that
mutates the world runs to completion before the next tick can start. The only
blocking work (writing roster.json) is handed to a thread executor, and only
ever operates on already-serialized bytes, never on live state.

Endpoints
  WS   /ws               live world snapshots (server->client); client may also
                         send messages here (reserved for future viewport input)
  GET  /api/state        one-shot JSON snapshot (debug)
  GET  /api/health       cheap liveness/readiness (no roster serialization)
  POST /api/register     {"name","email","password"} -> {ok, id, name} | {ok:false,error}
  POST /api/login        {"identifier","password"} auth by email OR username -> {ok,id,name}
  POST /api/status       {"id": N, "value": bool} toggle your star online/offline
  POST /api/boost        {"id": N}            Heartbeat: self pull -> 100% for 1 min
  POST /api/jam          {"attacker": A, "target": T}  -25% pull on T for 1 min
  POST /api/reset        clear all users

Auth note: email is NOT verified against any real mail system — only a light
format check. Passwords are stored salted+hashed (pbkdf2_hmac/sha256).
  (everything else)      static files (index.html, main.js, style.css, ...)

Persistence: roster (name, position, radius, hits, createdAt, loggedIn) is
stored via a pluggable backend selected by STORE_BACKEND:
  * "json"   (default) — the whole roster as one JSON file at $DATA_DIR/roster.json.
  * "valkey"           — Valkey-native, under keys prefixed with VALKEY_PREFIX:
                           {prefix}:user:{id}  HASH   one per user
                           {prefix}:order      LIST   user ids in insertion order
                           {prefix}:rev / :seq STRING revision + id counters
                         Only *changed* users are written each save (per-user
                         dirty tracking), so one login/collision touches one hash.
Probes are ephemeral. Single writer -> growth is safe to persist.

Valkey-ready: the broadcast path goes through Hub.publish() and the sim is the
sole writer. To scale out later, publish snapshots to Valkey (Redis) pub/sub and
have each replica's WS fan-out subscribe — the Sim stays single-writer.

Env: STORE_BACKEND ("json" | "valkey"), VALKEY_URL, VALKEY_PREFIX, DATA_DIR (data
folder), BIND (host, default 127.0.0.1), PORT (default 5173).
"""
import asyncio
import contextlib
import hashlib
import json
import math
import os
import random
import re
import secrets
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --- paths / config ---------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
ROSTER_PATH = os.path.join(DATA_DIR, "roster.json")
# Render (and most PaaS) inject PORT and RENDER; bind all interfaces there.
_default_bind = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
HOST = os.environ.get("BIND", _default_bind)
PORT = int(os.environ.get("PORT", "5173"))

# Persistence backend: "json" (default — local file on $DATA_DIR) or "valkey"
# (a Redis-compatible server). Flip with STORE_BACKEND=valkey. When valkey, the
# roster is stored Valkey-natively: one hash per user under VALKEY_PREFIX (see
# ValkeyStore) so a single user's change doesn't rewrite the whole set.
STORE_BACKEND = os.environ.get("STORE_BACKEND", "json").strip().lower()
VALKEY_URL = os.environ.get(
    "VALKEY_URL", "redis://valkey.valkey.svc.cluster.local:6379")
VALKEY_PREFIX = os.environ.get("VALKEY_PREFIX", "spacemap")

TICK_HZ = 30                 # simulation + broadcast rate
SAVE_EVERY = 5.0             # seconds between roster autosaves when dirty

# Simulation constants — mirror the client CONFIG so behaviour is identical.
MAX_SPEED = 90.0
WANDER_STRENGTH = 2.6
EDGE_MARGIN = 120.0
EDGE_FORCE = 140.0
USER_RADIUS = 10.0
USER_ATTRACTION = 26.0
USER_GROWTH = 2.5
MAX_USER_RADIUS = 46.0
STAR_MIN_GAP = 12.0
PULL_FADE = 3.0
PROBE_RADIUS = 6.0
PROBE_RATIO = 0.10   # max probes = the BIGGER of 10% of active users...
MIN_PROBES = 10      # ...or this floor (so there are always at least 10)
MAX_PROBES_CAP = 60  # ...but never more than this (keeps payload + physics sane)
# Spawn cadence also scales with activity: interval = BASE / active_users,
# clamped. At ~10 active users this equals the classic 10s; busier maps spawn
# faster, quiet maps slower.
SPAWN_BASE = 100.0   # seconds x users (10 active -> 10s, 100 active -> 1s)
SPAWN_MIN = 0.5      # fastest allowed spawn interval (seconds)
SPAWN_MAX = 10.0     # slowest allowed spawn interval (seconds)
SECTOR_SIZE = 560.0
SECTOR_COLS = 4
SECTOR_PAD = 70.0
STARS_PER_SECTOR = 10
PULL_MIN = 0.05

# --- pull-force gameplay ----------------------------------------------------
# A logged-in star pulls at half strength by default; abilities move it around.
BASE_PULL = 0.5              # steady-state pull for a logged-in star
BOOST_PULL = 1.0            # pull while a Heartbeat boost is active
BOOST_DURATION_MS = 60_000   # Heartbeat lasts 1 minute...
BOOST_COOLDOWN_MS = 600_000  # ...then the button is locked for the rest of 10 min
JAM_REDUCTION = 0.25         # each active jam knocks 25% off the target's pull
JAM_DURATION_MS = 60_000     # a jam bites for 1 minute...
JAM_COOLDOWN_MS = 1_800_000  # ...and the same attacker can't re-jam it for 30 min

# --- auth (email + password) ------------------------------------------------
# Email is NOT checked against any real mail system — just a light format test.
PW_MIN_LEN = 4
PBKDF2_ITERS = 120_000
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match((email or "").strip()))


def hash_password(password: str) -> str:
    """Salted PBKDF2-HMAC-SHA256, encoded as algo$iters$salt_hex$hash_hex."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS)
    return f"pbkdf2_sha256${PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = (encoded or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 bytes.fromhex(salt_hex), int(iters))
        return secrets.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False

# Spatial grid: bucket users into square cells so per-tick physics is O(probes)
# instead of O(probes x users). The cell must be >= the largest interaction
# distance (max star radius + probe radius + gap) so a 3x3 neighbourhood is
# guaranteed to contain every star that could collide with / crowd a probe.
GRID_CELL = 120.0

# Snapshot splitting: probes (tiny, fast-moving) go out every tick, but the big
# users array only rides along a few times per second (or immediately when the
# roster changes). This is what keeps 1000+ user maps cheap to serialize/send.
USER_BROADCAST_EVERY = 6     # ticks between forced user broadcasts (~5Hz @30)


def now_ms():
    return int(time.time() * 1000)


# --- broadcast hub: one snapshot fanned out to all WebSocket clients ---------
class Hub:
    """Async latest-value broadcast. Each connection waits for a newer seq.

    This is the seam for a future Valkey backend: publish() would additionally
    PUBLISH to a channel, and a subscriber would call publish() on remote frames.
    """

    def __init__(self):
        self._cond = asyncio.Condition()
        self._seq = 0
        self._data = "{}"

    @property
    def seq(self) -> int:
        return self._seq

    async def publish(self, data: str):
        async with self._cond:
            self._data = data
            self._seq += 1
            self._cond.notify_all()

    async def wait(self, last_seq: int, timeout: float):
        """Return (seq, data) once a newer snapshot exists, or (last_seq, None)
        on timeout so the caller can keep the connection warm."""
        async with self._cond:
            try:
                await asyncio.wait_for(
                    self._cond.wait_for(lambda: self._seq != last_seq), timeout)
            except asyncio.TimeoutError:
                return last_seq, None
            return self._seq, self._data


hub = Hub()


# --- persistence backends ---------------------------------------------------
# A store exposes:
#   load()                       -> {"rev", "users":[record...]} | None
#   save_full(bytes)             (mode="full")    whole-roster write
#   save_changes(payload)        (mode="granular") only-changed-users write
# Every record is {id,name,fx,fy,r,hits,createdAt,loggedIn}. Saves are always
# called from a thread executor on immutable data, so a slow backend never
# blocks the event loop or touches live sim state.
class JsonStore:
    """Local-file roster store: atomic whole-file write to $DATA_DIR/roster.json."""
    kind = "json"
    mode = "full"

    def describe(self):
        return f"json:{ROSTER_PATH}"

    def load(self):
        try:
            with open(ROSTER_PATH, "rb") as f:
                raw = f.read()
        except (FileNotFoundError, OSError):
            return None
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(data, dict):
            return None
        return {"rev": int(data.get("rev", 0)), "users": data.get("users", [])}

    def save_full(self, data: bytes) -> bool:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = ROSTER_PATH + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        # os.replace is atomic, but on Windows it can transiently fail with
        # PermissionError if an AV/indexer holds the target open. Retry a bit.
        for attempt in range(6):
            try:
                os.replace(tmp, ROSTER_PATH)
                return True
            except PermissionError:
                if attempt == 5:
                    print("warn: roster save deferred (file locked)", flush=True)
                    return False
                time.sleep(0.02)
        return False


class ValkeyStore:
    """Valkey-native roster: one HASH per user + an order LIST + rev/seq keys.

    Keys (all under VALKEY_PREFIX):
      {prefix}:user:{id}  HASH   name, email, pw, fx, fy, r, hits, createdAt, loggedIn
      {prefix}:order      LIST   user ids in insertion order (drives sectors)
      {prefix}:rev        STRING roster revision
      {prefix}:seq        STRING last user-id counter

    Only changed users are HSET on each save, so a login/collision writes a
    single hash instead of the whole roster. redis-py is protocol-compatible
    with Valkey; the client connects lazily, so construction succeeds even when
    Valkey is briefly unreachable, and load/save degrade gracefully.
    """
    kind = "valkey"
    mode = "granular"

    def __init__(self, url: str, prefix: str):
        try:
            import redis  # redis-py is protocol-compatible with Valkey
        except ImportError as e:
            raise RuntimeError(
                "STORE_BACKEND=valkey requires the 'redis' package "
                "(it's in requirements.txt; run pip install redis)") from e
        self.url = url
        self.prefix = prefix
        self._known = set()   # ids already present in the order LIST
        # decode_responses -> str in/out; short timeouts so a flaky Valkey
        # never wedges the save thread.
        self.client = redis.Redis.from_url(
            url, decode_responses=True, socket_connect_timeout=3,
            socket_timeout=3, retry_on_timeout=True, health_check_interval=30)

    # -- key helpers --
    def _k(self, *parts):
        return ":".join((self.prefix, *parts))

    def describe(self):
        return f"valkey:{self.url} prefix={self.prefix}"

    def load(self):
        try:
            order = self.client.lrange(self._k("order"), 0, -1)
            rev = self.client.get(self._k("rev"))
            seq = self.client.get(self._k("seq"))
        except Exception as e:  # connection/timeout/etc — start empty, don't die
            print(f"warn: valkey load failed ({e}); starting with empty roster",
                  flush=True)
            return None
        users = []
        if order:
            pipe = self.client.pipeline(transaction=False)
            for uid in order:
                pipe.hgetall(self._k("user", uid))
            for uid, h in zip(order, pipe.execute()):
                if not h:
                    continue
                users.append({
                    "id": int(uid),
                    "name": h.get("name", ""),
                    "fx": float(h.get("fx", 0.0)),
                    "fy": float(h.get("fy", 0.0)),
                    "r": float(h.get("r", USER_RADIUS)),
                    "hits": int(h.get("hits", 0)),
                    "createdAt": int(h.get("createdAt", 0)),
                    "loggedIn": h.get("loggedIn") == "1",
                    "email": h.get("email", ""),
                    "pw": h.get("pw", ""),
                })
                self._known.add(int(uid))
        return {"rev": int(rev or 0),
                "seq": int(seq) if seq is not None else 0,
                "users": users}

    def save_changes(self, payload) -> bool:
        try:
            pipe = self.client.pipeline(transaction=False)
            if payload["reset"]:
                self._clear()
                self._known.clear()
            for rec in payload["users"]:
                uid = rec["id"]
                pipe.hset(self._k("user", str(uid)), mapping={
                    "name": rec["name"], "fx": rec["fx"], "fy": rec["fy"],
                    "r": rec["r"], "hits": rec["hits"],
                    "createdAt": rec["createdAt"],
                    "loggedIn": 1 if rec["loggedIn"] else 0,
                    "email": rec.get("email", ""), "pw": rec.get("pw", ""),
                })
                if uid not in self._known:
                    # Users are only ever appended (never reordered/individually
                    # removed), so the order list only grows at the tail.
                    pipe.rpush(self._k("order"), uid)
                    self._known.add(uid)
            pipe.set(self._k("rev"), payload["rev"])
            pipe.set(self._k("seq"), payload["seq"])
            pipe.execute()
            return True
        except Exception as e:  # caller keeps the changes dirty and retries
            print(f"warn: valkey save failed ({e}); will retry", flush=True)
            return False

    def _clear(self):
        ids = self.client.lrange(self._k("order"), 0, -1)
        pipe = self.client.pipeline(transaction=False)
        for uid in ids:
            pipe.delete(self._k("user", uid))
        pipe.delete(self._k("order"), self._k("rev"), self._k("seq"))
        pipe.execute()


def _make_store():
    if STORE_BACKEND == "valkey":
        return ValkeyStore(VALKEY_URL, VALKEY_PREFIX)
    return JsonStore()


store = _make_store()


# --- the authoritative world ------------------------------------------------
class Sim:
    def __init__(self):
        self.users = []          # list of dicts (see _new_user)
        self.probes = []
        self.rev = 0             # bumps on roster membership / login changes
        self.collisions = 0
        self.user_seq = 0
        self.probe_seq = 0
        self.spawn_timer = SPAWN_MAX
        self.dirty = False
        # Per-user dirty tracking: ids whose persisted fields changed since the
        # last save (used by the granular Valkey backend to write only those).
        # _reset_pending signals the store to clear everything on the next save.
        self._dirty_users = set()
        self._reset_pending = False
        # Spatial grid over user positions; rebuilt only when the roster changes
        # (positions are otherwise static — only r/pullForce mutate in place, and
        # the grid stores live references so those are always current).
        self._grid = {}
        self._grid_dirty = True
        self._grid_max_r = 8
        self._any_active = False
        self._load()
        self.position_users()
        self.spawn_probe()       # the map is always alive, even with 0 users

    # -- geometry (identical math to the client) --
    @staticmethod
    def sector_origin(i):
        col = i % SECTOR_COLS
        row = i // SECTOR_COLS
        return col * SECTOR_SIZE, row * SECTOR_SIZE

    def sector_count(self):
        return max(1, math.ceil(len(self.users) / STARS_PER_SECTOR))

    def world_size(self):
        n = self.sector_count()
        cols = min(n, SECTOR_COLS)
        rows = math.ceil(n / SECTOR_COLS)
        return cols * SECTOR_SIZE, rows * SECTOR_SIZE

    def position_users(self):
        pad = SECTOR_PAD
        span = SECTOR_SIZE - pad * 2
        for i, u in enumerate(self.users):
            u["sector"] = i // STARS_PER_SECTOR
            ox, oy = self.sector_origin(u["sector"])
            u["x"] = ox + pad + u["fx"] * span
            u["y"] = oy + pad + u["fy"] * span

    def place_star_fraction(self, sector_index):
        pad = SECTOR_PAD
        span = SECTOR_SIZE - pad * 2
        ox, oy = self.sector_origin(sector_index)
        want = 2 * USER_RADIUS + STAR_MIN_GAP
        others = [u for u in self.users if u["sector"] == sector_index]
        best = (random.random(), random.random())
        best_nearest = -1.0
        for _ in range(40):
            fx, fy = random.random(), random.random()
            x = ox + pad + fx * span
            y = oy + pad + fy * span
            nearest = math.inf
            for o in others:
                d = math.hypot(o["x"] - x, o["y"] - y)
                nearest = min(nearest, d)
            if nearest >= want:
                return fx, fy
            if nearest > best_nearest:
                best_nearest = nearest
                best = (fx, fy)
        return best

    # -- spatial grid -------------------------------------------------------
    def _rebuild_grid(self):
        g = {}
        for u in self.users:
            key = (int(u["x"] // GRID_CELL), int(u["y"] // GRID_CELL))
            g.setdefault(key, []).append(u)
        self._grid = g
        self._grid_dirty = False

    def _neighbor_cells(self, x, y):
        cx, cy = int(x // GRID_CELL), int(y // GRID_CELL)
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                cell = self._grid.get((gx, gy))
                if cell:
                    yield cell

    def allowed_radius(self, u):
        # Only stars in the 3x3 neighbourhood can crowd this one (GRID_CELL is
        # larger than any possible centre-to-centre crowding distance).
        cap = MAX_USER_RADIUS
        for cell in self._neighbor_cells(u["x"], u["y"]):
            for o in cell:
                if o is u:
                    continue
                d = math.hypot(o["x"] - u["x"], o["y"] - u["y"])
                cap = min(cap, d - o["r"] - STAR_MIN_GAP)
        return cap

    # -- entities --
    def _new_user(self, d):
        logged_in = bool(d.get("loggedIn", False))
        # Reuse a persisted id when loading; otherwise mint the next one.
        uid = d.get("id")
        if uid is None:
            self.user_seq += 1
            uid = self.user_seq
        else:
            uid = int(uid)
        return {
            "id": uid,
            "name": d.get("name", f"User{uid}"),
            "fx": float(d.get("fx", random.random())),
            "fy": float(d.get("fy", random.random())),
            "r": float(d.get("r", USER_RADIUS)),
            "hits": int(d.get("hits", 0)),
            "createdAt": int(d.get("createdAt", now_ms())),
            "loggedIn": logged_in,
            # Credentials: email (login handle, not verified) + hashed password.
            "email": (d.get("email") or "").strip(),
            "pw": d.get("pw", ""),
            "pullForce": BASE_PULL if logged_in else 0.0,
            "pulse": 0.0,
            "x": 0.0, "y": 0.0, "sector": 0,
            # Transient ability state (not persisted): last Heartbeat activation,
            # and {attacker_id: activated_at_ms} for jams landed on this star.
            "boostAt": 0,
            "jams": {},
        }

    def register(self, name, email, password):
        """Create an account + drop its planet. Enforces unique name AND email,
        a light email-format check, and a minimum password length. Password is
        stored salted+hashed. Mutation only — the caller persists."""
        name = (name or "").strip()
        email = (email or "").strip()
        key = name.lower()
        ekey = email.lower()
        if not key:
            return {"ok": False, "error": "empty"}
        if not valid_email(email):
            return {"ok": False, "error": "bad_email"}
        if len(password or "") < PW_MIN_LEN:
            return {"ok": False, "error": "weak_password"}
        if any(u["name"].strip().lower() == key for u in self.users):
            return {"ok": False, "error": "name_taken"}
        if any((u.get("email") or "").lower() == ekey for u in self.users):
            return {"ok": False, "error": "email_taken"}
        sector = len(self.users) // STARS_PER_SECTOR
        u = self._new_user({"name": name[:16] or None, "email": email,
                            "pw": hash_password(password),
                            "loggedIn": True, "createdAt": now_ms()})
        fx, fy = self.place_star_fraction(sector)
        u["fx"], u["fy"] = fx, fy
        self.users.append(u)
        self.position_users()
        self._grid_dirty = True
        self.rev += 1
        self._mark_user_dirty(u["id"])
        return {"ok": True, "id": u["id"], "name": u["name"]}

    def authenticate(self, identifier, password):
        """Log in by email OR username + password; brings the star online.
        Returns a generic error on any failure so accounts can't be enumerated."""
        ident = (identifier or "").strip().lower()
        if not ident:
            return {"ok": False, "error": "invalid_credentials"}
        u = next((x for x in self.users
                  if x["name"].strip().lower() == ident
                  or (x.get("email") or "").lower() == ident), None)
        if u is None or not verify_password(password or "", u.get("pw") or ""):
            return {"ok": False, "error": "invalid_credentials"}
        if not u["loggedIn"]:
            u["loggedIn"] = True
            self.rev += 1
            self._mark_user_dirty(u["id"])
        return {"ok": True, "id": u["id"], "name": u["name"]}

    def set_logged_in(self, uid, value):
        for u in self.users:
            if u["id"] == uid:
                u["loggedIn"] = bool(value)
                self.rev += 1
                self._mark_user_dirty(uid)
                return {"ok": True}
        return {"ok": False, "error": "not_found"}

    # -- abilities (transient, not persisted) --
    def _active_jams(self, u, now):
        """Count jams currently biting this star, pruning stale entries."""
        jams = u.get("jams")
        if not jams:
            return 0
        count = 0
        for aid, at in list(jams.items()):
            if now - at >= JAM_COOLDOWN_MS:
                del jams[aid]                 # cooldown over — forget it entirely
            elif now - at < JAM_DURATION_MS:
                count += 1                    # still actively reducing pull
        return count

    def _pull_target(self, u, now):
        """The pull force this star is easing toward, given login + abilities."""
        if not u["loggedIn"]:
            return 0.0
        boosting = u["boostAt"] and now - u["boostAt"] < BOOST_DURATION_MS
        base = BOOST_PULL if boosting else BASE_PULL
        return max(0.0, base - JAM_REDUCTION * self._active_jams(u, now))

    def activate_boost(self, uid):
        now = now_ms()
        for u in self.users:
            if u["id"] == uid:
                if not u["loggedIn"]:
                    return {"ok": False, "error": "offline"}
                ready_at = u["boostAt"] + BOOST_COOLDOWN_MS if u["boostAt"] else 0
                if now < ready_at:
                    return {"ok": False, "error": "cooldown", "readyAt": ready_at}
                u["boostAt"] = now
                self.rev += 1                 # push the fresh boostAt to clients now
                return {"ok": True,
                        "boostUntil": now + BOOST_DURATION_MS,
                        "readyAt": now + BOOST_COOLDOWN_MS}
        return {"ok": False, "error": "not_found"}

    def jam(self, attacker_id, target_id):
        if attacker_id == target_id:
            return {"ok": False, "error": "self"}
        now = now_ms()
        attacker = next((u for u in self.users if u["id"] == attacker_id), None)
        target = next((u for u in self.users if u["id"] == target_id), None)
        if target is None:
            return {"ok": False, "error": "not_found"}
        if attacker is None or not attacker["loggedIn"]:
            return {"ok": False, "error": "offline"}
        last = target["jams"].get(attacker_id)
        if last is not None and now - last < JAM_COOLDOWN_MS:
            return {"ok": False, "error": "cooldown",
                    "cooldownUntil": last + JAM_COOLDOWN_MS}
        target["jams"][attacker_id] = now
        self.rev += 1                         # reflect the reduced pull promptly
        return {"ok": True,
                "jamUntil": now + JAM_DURATION_MS,
                "cooldownUntil": now + JAM_COOLDOWN_MS}

    def reset(self):
        self.users = []
        self.probes = []
        self._grid_dirty = True
        self.rev += 1
        self._dirty_users.clear()
        self._reset_pending = True
        self.dirty = True
        return {"ok": True}

    def _mark_user_dirty(self, uid):
        self._dirty_users.add(uid)
        self.dirty = True

    def active_users(self):
        return sum(1 for u in self.users if u["loggedIn"])

    def max_probes(self):
        # Cap = the bigger of 10% of active users or MIN_PROBES, but never more
        # than MAX_PROBES_CAP (huge rosters shouldn't flood the wire/physics).
        return min(MAX_PROBES_CAP,
                   max(MIN_PROBES, int(self.active_users() * PROBE_RATIO)))

    def spawn_interval(self):
        # Fewer active users -> slower spawns; more -> faster. Inverse of the
        # active count, clamped to [SPAWN_MIN, SPAWN_MAX].
        active = max(1, self.active_users())
        return max(SPAWN_MIN, min(SPAWN_MAX, SPAWN_BASE / active))

    def spawn_probe(self):
        if len(self.probes) >= self.max_probes():
            return
        bw, bh = self.world_size()
        m = EDGE_MARGIN
        angle = random.random() * math.tau
        self.probe_seq += 1
        self.probes.append({
            "id": self.probe_seq,
            "x": m + random.random() * max(1.0, bw - m * 2),
            "y": m + random.random() * max(1.0, bh - m * 2),
            "vx": math.cos(angle) * MAX_SPEED * 0.6,
            "vy": math.sin(angle) * MAX_SPEED * 0.6,
            "wander": angle,
            "hue": 180 + random.random() * 80,
        })

    def nearest_active_user(self, x, y):
        # Ring search outward from the probe's cell. Because stars are dense,
        # the nearest active one is almost always within a ring or two, so this
        # is effectively O(1) per probe instead of O(users). Assumes at least
        # one active user exists (callers gate on self._any_active).
        g = self._grid
        if not g:
            return None
        cx, cy = int(x // GRID_CELL), int(y // GRID_CELL)
        best, best_d = None, math.inf
        r = 0
        while r <= self._grid_max_r:
            for gx in range(cx - r, cx + r + 1):
                for gy in range(cy - r, cy + r + 1):
                    if max(abs(gx - cx), abs(gy - cy)) != r:
                        continue  # only the outer ring at radius r
                    cell = g.get((gx, gy))
                    if not cell:
                        continue
                    for u in cell:
                        if u["pullForce"] <= PULL_MIN:
                            continue
                        d = (u["x"] - x) ** 2 + (u["y"] - y) ** 2
                        if d < best_d:
                            best_d, best = d, u
            # A candidate found at ring r is only guaranteed nearest once the
            # closest possible point of the next ring is farther than it.
            if best is not None and (r * GRID_CELL) ** 2 > best_d:
                break
            r += 1
        return best

    # -- the tick --
    def update(self, dt):
        # The cap can shrink when users log out — trim any excess probes.
        cap = self.max_probes()
        while len(self.probes) > cap:
            self.probes.pop()

        self.spawn_timer -= dt
        if self.spawn_timer <= 0:
            self.spawn_probe()
            self.spawn_timer = self.spawn_interval()

        ease = min(1.0, dt * PULL_FADE)
        now = now_ms()
        any_active = False
        for u in self.users:
            target = self._pull_target(u, now)
            u["pullForce"] += (target - u["pullForce"]) * ease
            if u["pullForce"] > PULL_MIN:
                any_active = True
            if u["pulse"] > 0:
                u["pulse"] = max(0.0, u["pulse"] - dt * 2.2)

        bw, bh = self.world_size()
        # (Re)build the spatial grid only when the roster changed. Ring search
        # is bounded by the grid's extent so it can't spin over empty space.
        if self._grid_dirty:
            self._rebuild_grid()
        self._grid_max_r = int(max(bw, bh) // GRID_CELL) + 2
        self._any_active = any_active

        for p in self.probes:
            ax = ay = 0.0
            p["wander"] += (random.random() - 0.5) * WANDER_STRENGTH * dt * 2
            ax += math.cos(p["wander"]) * MAX_SPEED
            ay += math.sin(p["wander"]) * MAX_SPEED

            if p["x"] < EDGE_MARGIN:
                ax += EDGE_FORCE * (1 - p["x"] / EDGE_MARGIN)
            if p["x"] > bw - EDGE_MARGIN:
                ax -= EDGE_FORCE * (1 - (bw - p["x"]) / EDGE_MARGIN)
            if p["y"] < EDGE_MARGIN:
                ay += EDGE_FORCE * (1 - p["y"] / EDGE_MARGIN)
            if p["y"] > bh - EDGE_MARGIN:
                ay -= EDGE_FORCE * (1 - (bh - p["y"]) / EDGE_MARGIN)

            near = self.nearest_active_user(p["x"], p["y"]) if any_active else None
            if near:
                dx, dy = near["x"] - p["x"], near["y"] - p["y"]
                d = math.hypot(dx, dy) or 1.0
                force = USER_ATTRACTION * near["pullForce"]
                ax += (dx / d) * force
                ay += (dy / d) * force

            p["vx"] += ax * dt
            p["vy"] += ay * dt
            speed = math.hypot(p["vx"], p["vy"])
            if speed > MAX_SPEED:
                p["vx"] = (p["vx"] / speed) * MAX_SPEED
                p["vy"] = (p["vy"] / speed) * MAX_SPEED
            p["x"] += p["vx"] * dt
            p["y"] += p["vy"] * dt

        self._detect_collisions()

    def _detect_collisions(self):
        # Only stars in the probe's 3x3 grid neighbourhood can be within range.
        for i in range(len(self.probes) - 1, -1, -1):
            p = self.probes[i]
            hit = None
            for cell in self._neighbor_cells(p["x"], p["y"]):
                for u in cell:
                    if u["pullForce"] <= PULL_MIN:
                        continue
                    rr = PROBE_RADIUS + u["r"]
                    if (p["x"] - u["x"]) ** 2 + (p["y"] - u["y"]) ** 2 <= rr * rr:
                        hit = u
                        break
                if hit:
                    break
            if hit:
                hit["hits"] += 1
                hit["pulse"] = 1.0
                new_r = min(hit["r"] + USER_GROWTH, self.allowed_radius(hit))
                if new_r > hit["r"]:
                    hit["r"] = new_r
                self.collisions += 1
                self._mark_user_dirty(hit["id"])
                del self.probes[i]

    # -- snapshot --
    def snapshot(self, include_users=True):
        """Build a snapshot dict.

        Probes + live metrics are always included (they change every tick and
        are cheap). The big users array is optional: it only rides along on the
        low-rate "user broadcast" ticks and whenever the roster changes, which
        is what keeps large maps affordable to serialize/send.
        """
        snap = {
            "t": now_ms(),
            "collisions": self.collisions,
            "maxProbes": self.max_probes(),
            "spawnInterval": round(self.spawn_interval(), 2),
            "probes": [{
                "id": p["id"], "x": round(p["x"], 1), "y": round(p["y"], 1),
                "hue": round(p["hue"], 1),
            } for p in self.probes],
        }
        if include_users:
            bw, bh = self.world_size()
            snap["rev"] = self.rev
            snap["world"] = {"w": round(bw, 1), "h": round(bh, 1)}
            snap["users"] = [{
                "id": u["id"], "name": u["name"],
                "x": round(u["x"], 1), "y": round(u["y"], 1),
                "r": round(u["r"], 2), "hits": u["hits"],
                "loggedIn": u["loggedIn"], "pull": round(u["pullForce"], 3),
                "pulse": round(u["pulse"], 3), "createdAt": u["createdAt"],
                "sector": u["sector"], "boostAt": u["boostAt"],
            } for u in self.users]
        return snap

    def tick(self, dt, include_users):
        """Advance the sim; return (serialized snapshot str, current rev)."""
        self.update(dt)
        snap = self.snapshot(include_users=include_users)
        return json.dumps(snap, separators=(",", ":")), self.rev

    # -- persistence --
    @staticmethod
    def _persist_record(u):
        """The subset of a user that gets persisted (a plain, copyable dict)."""
        return {
            "id": u["id"], "name": u["name"], "fx": u["fx"], "fy": u["fy"],
            "r": u["r"], "hits": u["hits"], "createdAt": u["createdAt"],
            "loggedIn": u["loggedIn"],
            "email": u.get("email", ""), "pw": u.get("pw", ""),
        }

    def _load(self):
        snap = store.load()
        if not snap:
            return
        self.rev = int(snap.get("rev", 0))
        max_id = 0
        for d in snap.get("users", []):
            u = self._new_user(d)
            self.users.append(u)
            max_id = max(max_id, u["id"])
        # Never re-issue an id that already exists on disk / in Valkey.
        self.user_seq = max(self.user_seq, int(snap.get("seq", 0)), max_id)

    def roster_bytes(self):
        """Serialize the whole persistable roster to bytes (JSON backend). Called
        on the event loop; the bytes are what gets handed to the writer thread."""
        payload = {
            "rev": self.rev,
            "users": [self._persist_record(u) for u in self.users],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")

    def drain_changes(self):
        """Snapshot the pending changes for the granular (Valkey) backend and
        clear the dirty state. Called on the event loop so it's race-free."""
        reset = self._reset_pending
        users = []
        if not reset:
            by_id = {u["id"]: u for u in self.users}
            for uid in self._dirty_users:
                u = by_id.get(uid)
                if u is not None:
                    users.append(self._persist_record(u))
        payload = {"rev": self.rev, "seq": self.user_seq,
                   "reset": reset, "users": users}
        self._dirty_users = set()
        self._reset_pending = False
        self.dirty = False
        return payload

    def requeue_changes(self, payload):
        """Re-mark a failed granular save so the next autosave retries it."""
        if payload.get("reset"):
            self._reset_pending = True
        for rec in payload.get("users", []):
            self._dirty_users.add(rec["id"])
        self.dirty = True


sim = Sim()


async def persist_now():
    """Snapshot on the loop, write via the store on a thread. No lock: the data
    handed to the writer thread is an immutable copy, so it never touches live
    state. JSON writes the whole roster; Valkey writes only changed users."""
    loop = asyncio.get_running_loop()
    if store.mode == "granular":
        payload = sim.drain_changes()
        try:
            ok = await loop.run_in_executor(None, store.save_changes, payload)
            if not ok:
                sim.requeue_changes(payload)
        except Exception:
            sim.requeue_changes(payload)  # retry on the next autosave
    else:
        data = sim.roster_bytes()
        sim.dirty = False
        sim._dirty_users.clear()
        sim._reset_pending = False
        try:
            ok = await loop.run_in_executor(None, store.save_full, data)
            if not ok:
                sim.dirty = True
        except Exception:
            sim.dirty = True  # try again on the next autosave


# --- simulation task (single event loop, no locks) --------------------------
async def sim_loop():
    step = 1.0 / TICK_HZ
    last = time.perf_counter()
    save_accum = 0.0
    tick_i = 0
    last_sent_rev = -1
    while True:
        start = time.perf_counter()
        dt = start - last
        last = start
        if dt > 0.05:
            dt = 0.05

        # Include the heavy users array only every Nth tick, or immediately when
        # the roster changed (join/login/reset bump sim.rev) so those feel live.
        tick_i += 1
        include_users = (tick_i % USER_BROADCAST_EVERY == 0) or (sim.rev != last_sent_rev)
        data, rev = sim.tick(dt, include_users)
        if include_users:
            last_sent_rev = rev
        await hub.publish(data)

        save_accum += dt
        if save_accum >= SAVE_EVERY:
            if sim.dirty:
                await persist_now()
            save_accum = 0.0

        sleep_for = step - (time.perf_counter() - start)
        await asyncio.sleep(sleep_for if sleep_for > 0 else 0)


# --- FastAPI app ------------------------------------------------------------
@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(sim_loop())
    print(f"space-map (FastAPI/WS) http://{HOST}:{PORT}  "
          f"(tick {TICK_HZ}Hz, store: {store.describe()})", flush=True)
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        # Best-effort final save so a graceful shutdown doesn't lose the roster.
        if sim.dirty:
            if store.mode == "granular":
                store.save_changes(sim.drain_changes())
            else:
                store.save_full(sim.roster_bytes())


app = FastAPI(title="Space Map (authoritative)", lifespan=lifespan)


class RegisterReq(BaseModel):
    name: str = ""
    email: str = ""
    password: str = ""


class LoginReq(BaseModel):
    identifier: str = ""    # email OR username
    password: str = ""


class StatusReq(BaseModel):
    id: int
    value: bool = True


class BoostReq(BaseModel):
    id: int


class JamReq(BaseModel):
    attacker: int
    target: int


@app.get("/api/health")
async def api_health():
    # Deliberately cheap — no roster serialization — so probes stay light even
    # with thousands of users.
    return {"ok": True, "users": len(sim.users), "probes": len(sim.probes),
            "rev": sim.rev, "store": store.kind}


@app.get("/api/state")
async def api_state():
    return JSONResponse(sim.snapshot(include_users=True))


@app.post("/api/register")
async def api_register(req: RegisterReq):
    res = sim.register(req.name, req.email, req.password)
    if res.get("ok"):
        await persist_now()
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


@app.post("/api/login")
async def api_login(req: LoginReq):
    res = sim.authenticate(req.identifier, req.password)
    if res.get("ok"):
        await persist_now()
    return JSONResponse(res, status_code=200 if res.get("ok") else 401)


@app.post("/api/status")
async def api_status(req: StatusReq):
    # Toggle your own star online/offline (Go Live / Go Dark). No password —
    # this is a session action on an already-authenticated star.
    res = sim.set_logged_in(req.id, req.value)
    if res.get("ok"):
        await persist_now()
    return JSONResponse(res, status_code=200 if res.get("ok") else 404)


@app.post("/api/boost")
async def api_boost(req: BoostReq):
    # Ability state is transient — no persistence needed.
    res = sim.activate_boost(req.id)
    return JSONResponse(res, status_code=200 if res.get("ok") else 409)


@app.post("/api/jam")
async def api_jam(req: JamReq):
    res = sim.jam(req.attacker, req.target)
    return JSONResponse(res, status_code=200 if res.get("ok") else 409)


@app.post("/api/reset")
async def api_reset():
    res = sim.reset()
    await persist_now()
    return res


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    # Send a full snapshot immediately so a client that connects during a
    # probes-only tick still has users/world right away.
    await ws.send_text(json.dumps(sim.snapshot(include_users=True),
                                  separators=(",", ":")))
    last_seq = hub.seq

    async def sender():
        nonlocal last_seq
        while True:
            last_seq, data = await hub.wait(last_seq, timeout=15)
            if data is not None:
                await ws.send_text(data)

    async def receiver():
        # We don't consume client input yet, but reading is how we promptly
        # detect a close (and it's the future hook for viewport messages).
        while True:
            await ws.receive_text()

    send_task = asyncio.create_task(sender())
    recv_task = asyncio.create_task(receiver())
    try:
        await asyncio.wait({send_task, recv_task},
                           return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in (send_task, recv_task):
            t.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.gather(send_task, recv_task)


# Static files last so /api and /ws routes take precedence over the "/" mount.
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning",
                ws_ping_interval=20, ws_ping_timeout=20)


if __name__ == "__main__":
    main()
