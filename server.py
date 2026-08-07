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
  POST /api/join         {"name": "..."}      -> {ok, id} | {ok:false, error}
  POST /api/login        {"id": N, "value": bool} toggle a star online/offline
  POST /api/reset        clear all users
  (everything else)      static files (index.html, main.js, style.css, ...)

Persistence: roster (name, position, radius, hits, createdAt, loggedIn) is
written to $DATA_DIR/roster.json. Probes are ephemeral. Single writer -> growth
is safe to persist (no cross-tab conflicts).

Valkey-ready: the broadcast path goes through Hub.publish() and the sim is the
sole writer. To scale out later, publish snapshots to Valkey (Redis) pub/sub and
have each replica's WS fan-out subscribe — the Sim stays single-writer.

Env: DATA_DIR (data folder), BIND (host, default 127.0.0.1), PORT (default 5173).
"""
import asyncio
import contextlib
import hashlib
import json
import math
import os
import random
import secrets
import time
import enum

# Optional redis import — only needed when PERSISTENCE_MODE=valkey
try:
    import redis
except ImportError:
    redis = None  # type: ignore

def hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000
    ).hex()
    return pwd_hash, salt


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

# --- persistence configuration -----------------------------------------------
# Set PERSISTENCE_MODE=valkey to use Redis/Valkey; default is local roster.json.
# Set VALKEY_URL to your Redis connection string when using Valkey mode.
class PersistenceMode(enum.Enum):
    ROSTER = "roster"   # local JSON file (default)
    VALKEY = "valkey"   # Redis / Valkey

PERSISTENCE_MODE = os.environ.get("PERSISTENCE_MODE", PersistenceMode.ROSTER.value).strip().lower()
VALKEY_URL = os.environ.get("VALKEY_URL", "redis://red-d9pibof10e5c73dg1pe0:6379")
VALKEY_KEY = "space:roster"   # single Redis key that holds the whole roster JSON


class PersistenceManager:
    """Thin abstraction over local-file vs Valkey (Redis) roster storage.

    Mode is selected at startup via the PERSISTENCE_MODE env var:
      roster (default) — reads/writes DATA_DIR/roster.json
      valkey           — reads/writes a single Redis key (VALKEY_KEY)
    """

    def __init__(self):
        self.mode = PersistenceMode(PERSISTENCE_MODE) if PERSISTENCE_MODE in (
            m.value for m in PersistenceMode) else PersistenceMode.ROSTER
        self._client = None
        if self.mode == PersistenceMode.VALKEY:
            if redis is None:
                raise RuntimeError(
                    "redis package not installed. Run: pip install redis")
            self._client = redis.from_url(VALKEY_URL, decode_responses=True)
            print(f"[persistence] mode=valkey  url={VALKEY_URL}", flush=True)
        else:
            print(f"[persistence] mode=roster  path={ROSTER_PATH}", flush=True)

    # -- load -----------------------------------------------------------------
    def load(self) -> dict | None:
        """Return the raw roster dict, or None if nothing is stored yet."""
        if self.mode == PersistenceMode.VALKEY:
            try:
                raw = self._client.get(VALKEY_KEY)
                if raw:
                    return json.loads(raw)
            except Exception as exc:
                print(f"[persistence] valkey load error: {exc}", flush=True)
            return None
        else:
            try:
                with open(ROSTER_PATH, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (FileNotFoundError, ValueError, OSError):
                return None

    # -- save -----------------------------------------------------------------
    def save(self, data: bytes) -> bool:
        """Persist serialized roster bytes. Returns True on success."""
        if self.mode == PersistenceMode.VALKEY:
            try:
                self._client.set(VALKEY_KEY, data.decode("utf-8"))
                return True
            except Exception as exc:
                print(f"[persistence] valkey save error: {exc}", flush=True)
                return False
        else:
            return _write_roster_file(data)


persistence: PersistenceManager  # assigned after _write_roster_file is defined

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
        self.user_seq += 1
        return {
            "id": self.user_seq,
            "name": d.get("name", f"User{self.user_seq}"),
            "email": d.get("email", ""),
            "pwd_hash": d.get("pwd_hash", ""),
            "pwd_salt": d.get("pwd_salt", ""),
            "token": d.get("token") or secrets.token_hex(32),
            "fx": float(d.get("fx", random.random())),
            "fy": float(d.get("fy", random.random())),
            "r": float(d.get("r", USER_RADIUS)),
            "hits": int(d.get("hits", 0)),
            "createdAt": int(d.get("createdAt", now_ms())),
            "loggedIn": logged_in,
            "pullForce": 1.0 if logged_in else 0.0,
            "pulse": 0.0,
            "x": 0.0, "y": 0.0, "sector": 0,
        }

    def authenticate_or_create_user(self, name: str, email: str, password: str):
        """Authenticate an existing user by email + password, or create a new user star."""
        email_key = email.strip().lower()
        name_key = name.strip()
        if not email_key or not password:
            return {"ok": False, "error": "missing_fields"}

        # Search by email first
        existing_by_email = next((u for u in self.users if u.get("email", "").strip().lower() == email_key), None)

        if existing_by_email:
            # Existing account: verify password
            calc_hash, _ = hash_password(password, existing_by_email.get("pwd_salt", ""))
            if not secrets.compare_digest(calc_hash, existing_by_email.get("pwd_hash", "")):
                return {"ok": False, "error": "invalid_credentials"}
            
            # Successful authentication
            if name_key and name_key != existing_by_email["name"]:
                # Update username if new name provided and not taken by another user
                if not any(u["name"].strip().lower() == name_key.lower() for u in self.users if u["id"] != existing_by_email["id"]):
                    existing_by_email["name"] = name_key[:16]

            if not existing_by_email.get("token"):
                existing_by_email["token"] = secrets.token_hex(32)

            existing_by_email["loggedIn"] = True
            self.rev += 1
            self.dirty = True
            print(
                f"[auth] LOGIN   name={existing_by_email['name']!r:16}  "
                f"email={existing_by_email['email']}  id={existing_by_email['id']}",
                flush=True,
            )
            return {
                "ok": True,
                "user": {
                    "id": existing_by_email["id"],
                    "name": existing_by_email["name"],
                    "email": existing_by_email["email"],
                    "token": existing_by_email["token"],
                }
            }

        # New account: verify name is available
        if not name_key:
            return {"ok": False, "error": "missing_username"}

        if any(u["name"].strip().lower() == name_key.lower() for u in self.users):
            return {"ok": False, "error": "name_taken"}

        # Create new user star
        pwd_hash, pwd_salt = hash_password(password)
        token = secrets.token_hex(32)
        sector = len(self.users) // STARS_PER_SECTOR
        u = self._new_user({
            "name": name_key[:16],
            "email": email_key,
            "pwd_hash": pwd_hash,
            "pwd_salt": pwd_salt,
            "token": token,
            "loggedIn": True,
            "createdAt": now_ms()
        })
        fx, fy = self.place_star_fraction(sector)
        u["fx"], u["fy"] = fx, fy
        self.users.append(u)
        self.position_users()
        self._grid_dirty = True
        self.rev += 1
        self.dirty = True
        print(
            f"[auth] REGISTER name={u['name']!r:16}  "
            f"email={u['email']}  id={u['id']}",
            flush=True,
        )
        return {
            "ok": True,
            "user": {
                "id": u["id"],
                "name": u["name"],
                "email": u["email"],
                "token": u["token"],
            }
        }

    def set_logged_in(self, uid: int, value: bool, token: str = None):
        """Toggle online/offline status for a star. Requires token authorization."""
        for u in self.users:
            if u["id"] == uid:
                if not token or not u.get("token") or not secrets.compare_digest(u["token"], token):
                    return {"ok": False, "error": "unauthorized"}
                u["loggedIn"] = bool(value)
                self.rev += 1
                self.dirty = True
                return {"ok": True}
        return {"ok": False, "error": "not_found"}

    def reset(self):
        self.users = []
        self.probes = []
        self._grid_dirty = True
        self.rev += 1
        self.dirty = True
        return {"ok": True}

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
        any_active = False
        for u in self.users:
            target = 1.0 if u["loggedIn"] else 0.0
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
                self.dirty = True
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
                "sector": u["sector"],
            } for u in self.users]
        return snap

    def tick(self, dt, include_users):
        """Advance the sim; return (serialized snapshot str, current rev)."""
        self.update(dt)
        snap = self.snapshot(include_users=include_users)
        return json.dumps(snap, separators=(",", ":")), self.rev

    # -- persistence --
    def _load(self):
        raw = persistence.load()
        if isinstance(raw, dict):
            self.rev = int(raw.get("rev", 0))
            for d in raw.get("users", []):
                self.users.append(self._new_user(d))

    def roster_bytes(self):
        """Serialize the persistable roster to bytes (called on the event loop;
        the resulting bytes are what gets handed to the writer thread)."""
        payload = {
            "rev": self.rev,
            "users": [{
                "name": u["name"], "email": u.get("email", ""),
                "pwd_hash": u.get("pwd_hash", ""), "pwd_salt": u.get("pwd_salt", ""),
                "token": u.get("token", ""),
                "fx": u["fx"], "fy": u["fy"], "r": u["r"],
                "hits": u["hits"], "createdAt": u["createdAt"], "loggedIn": u["loggedIn"],
            } for u in self.users],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")



def _write_roster_file(data: bytes):
    """Atomically write pre-serialized roster bytes. Runs in a thread executor,
    so it must NOT touch live sim state — only the bytes it was handed."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = ROSTER_PATH + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    # os.replace is atomic, but on Windows it can transiently fail with
    # PermissionError if an AV/indexer holds the target open. Retry a few times.
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

# Initialise persistence before Sim so _load can use it.
# _write_roster_file must be defined first (it's referenced by PersistenceManager.save).
persistence = PersistenceManager()
sim = Sim()


async def persist_now():
    """Serialize on the loop, write via PersistenceManager. No lock: bytes are a snapshot."""
    data = sim.roster_bytes()
    sim.dirty = False
    try:
        if persistence.mode == PersistenceMode.VALKEY:
            # Valkey set is fast enough to call inline (no thread executor needed)
            ok = persistence.save(data)
            if ok:
                print(f"[persist] saved {len(data)} bytes → valkey key={VALKEY_KEY}", flush=True)
        else:
            ok = await asyncio.get_running_loop().run_in_executor(
                None, persistence.save, data)
            if ok:
                print(f"[persist] saved {len(data)} bytes → local {ROSTER_PATH}", flush=True)
        if not ok:
            sim.dirty = True
    except OSError:
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
    backend = f"valkey={VALKEY_URL}" if persistence.mode == PersistenceMode.VALKEY else f"roster={ROSTER_PATH}"
    print(f"space-map (FastAPI/WS) http://{HOST}:{PORT}  "
          f"(tick {TICK_HZ}Hz, persistence: {backend})", flush=True)
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        # Best-effort final save so a graceful shutdown doesn't lose the roster.
        if sim.dirty:
            persistence.save(sim.roster_bytes())


app = FastAPI(title="Space Map (authoritative)", lifespan=lifespan)


class AuthReq(BaseModel):
    email: str = ""
    name: str = ""
    password: str = ""


class LoginReq(BaseModel):
    id: int
    value: bool = True
    token: str = ""


@app.get("/api/health")
async def api_health():
    # Deliberately cheap — no roster serialization — so probes stay light even
    # with thousands of users.
    return {"ok": True, "users": len(sim.users), "probes": len(sim.probes),
            "rev": sim.rev}


@app.get("/api/state")
async def api_state():
    return JSONResponse(sim.snapshot(include_users=True))


@app.post("/api/auth")
@app.post("/api/join")
async def api_auth(req: AuthReq):
    res = sim.authenticate_or_create_user(req.name, req.email, req.password)
    if res.get("ok"):
        await persist_now()
        return JSONResponse(res, status_code=200)
    err = res.get("error")
    status_code = 401 if err == "invalid_credentials" else 400
    return JSONResponse(res, status_code=status_code)


@app.post("/api/login")
async def api_login(req: LoginReq):
    res = sim.set_logged_in(req.id, req.value, req.token)
    if res.get("ok"):
        await persist_now()
        return JSONResponse(res, status_code=200)
    err = res.get("error")
    status_code = 403 if err == "unauthorized" else 404
    return JSONResponse(res, status_code=status_code)


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
