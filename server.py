#!/usr/bin/env python3
"""Space Map — server-authoritative edition (stdlib only, zero deps).

Unlike the POC (where every browser ran its own probe simulation), here the
SERVER owns the one true world: users/stars, probes, collisions and growth all
live in this process. A background thread ticks the simulation ~30x/sec and
broadcasts a JSON snapshot to every connected client over Server-Sent Events
(SSE) at /api/stream. Clients are thin renderers — they draw snapshots and send
input (join / login / reset) back via plain HTTP. Result: every tab/browser
sees the *same* probes, the same growth, the same board.

Endpoints
  GET  /api/stream      text/event-stream — live world snapshots (SSE)
  GET  /api/state       one-shot JSON snapshot (debug/health)
  POST /api/join        {"name": "..."}      -> {ok, id} | {ok:false, error}
  POST /api/login       {"id": N, "value": bool} toggle a star online/offline
  POST /api/reset       clear all users
  (everything else)     static files (index.html, main.js, style.css, ...)

Persistence: roster (name, position, radius, hits, createdAt, loggedIn) is
written to $DATA_DIR/roster.json. Probes are ephemeral. Because there is a
single writer, growth is now safe to persist (no cross-tab conflicts).

Env: DATA_DIR (data folder), BIND (host, default 127.0.0.1), PORT (default 5173).
"""
import json
import math
import os
import random
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# --- paths / config ---------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
ROSTER_PATH = os.path.join(DATA_DIR, "roster.json")
# Render (and most PaaS) inject PORT and RENDER; bind all interfaces there.
_default_bind = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
HOST = os.environ.get("BIND", _default_bind)
PORT = int(os.environ.get("PORT", "5173"))

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
SPAWN_INTERVAL = 10.0
PROBE_RATIO = 0.10   # max probes = 10% of active (logged-in) users...
MIN_PROBES = 1       # ...but never fewer than this (keeps the map alive)
SECTOR_SIZE = 560.0
SECTOR_COLS = 4
SECTOR_PAD = 70.0
STARS_PER_SECTOR = 10
PULL_MIN = 0.05


def now_ms():
    return int(time.time() * 1000)


# --- broadcast hub: one pre-serialized snapshot fanned out to all SSE clients -
class Hub:
    def __init__(self):
        self._cond = threading.Condition()
        self._seq = 0
        self._data = b'{}'

    def publish(self, data: bytes):
        with self._cond:
            self._data = data
            self._seq += 1
            self._cond.notify_all()

    def wait(self, last_seq, timeout):
        """Block until a newer snapshot exists (or timeout). Returns (seq, data)."""
        with self._cond:
            self._cond.wait_for(lambda: self._seq != last_seq, timeout=timeout)
            return self._seq, self._data


hub = Hub()


# --- the authoritative world ------------------------------------------------
class Sim:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = []          # list of dicts (see _new_user)
        self.probes = []
        self.rev = 0             # bumps on roster membership / login changes
        self.collisions = 0
        self.user_seq = 0
        self.probe_seq = 0
        self.spawn_timer = SPAWN_INTERVAL
        self.dirty = False
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

    def allowed_radius(self, u):
        cap = MAX_USER_RADIUS
        for o in self.users:
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

    def add_user(self, name):
        """Create a user + drop their planet. Enforces unique names. Locked."""
        with self.lock:
            key = name.strip().lower()
            if not key:
                return {"ok": False, "error": "empty"}
            if any(u["name"].strip().lower() == key for u in self.users):
                return {"ok": False, "error": "name_taken"}
            sector = len(self.users) // STARS_PER_SECTOR
            u = self._new_user({"name": name.strip()[:16] or None,
                                "loggedIn": True, "createdAt": now_ms()})
            fx, fy = self.place_star_fraction(sector)
            u["fx"], u["fy"] = fx, fy
            self.users.append(u)
            self.position_users()
            self.rev += 1
            self.dirty = True
            self._save_locked()
            return {"ok": True, "id": u["id"]}

    def set_logged_in(self, uid, value):
        with self.lock:
            for u in self.users:
                if u["id"] == uid:
                    u["loggedIn"] = bool(value)
                    self.rev += 1
                    self.dirty = True
                    self._save_locked()
                    return {"ok": True}
        return {"ok": False, "error": "not_found"}

    def reset(self):
        with self.lock:
            self.users = []
            self.probes = []
            self.rev += 1
            self.dirty = True
            self._save_locked()
            return {"ok": True}

    def active_users(self):
        return sum(1 for u in self.users if u["loggedIn"])

    def max_probes(self):
        # Cap scales with engagement: 10% of active users, at least MIN_PROBES.
        return max(MIN_PROBES, int(self.active_users() * PROBE_RATIO))

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
        best, best_d = None, math.inf
        for u in self.users:
            if u["pullForce"] <= PULL_MIN:
                continue
            d = (u["x"] - x) ** 2 + (u["y"] - y) ** 2
            if d < best_d:
                best_d, best = d, u
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
            self.spawn_timer += SPAWN_INTERVAL

        ease = min(1.0, dt * PULL_FADE)
        for u in self.users:
            target = 1.0 if u["loggedIn"] else 0.0
            u["pullForce"] += (target - u["pullForce"]) * ease
            if u["pulse"] > 0:
                u["pulse"] = max(0.0, u["pulse"] - dt * 2.2)

        bw, bh = self.world_size()
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

            near = self.nearest_active_user(p["x"], p["y"])
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
        for i in range(len(self.probes) - 1, -1, -1):
            p = self.probes[i]
            for u in self.users:
                if u["pullForce"] <= PULL_MIN:
                    continue
                rr = PROBE_RADIUS + u["r"]
                if (p["x"] - u["x"]) ** 2 + (p["y"] - u["y"]) ** 2 <= rr * rr:
                    u["hits"] += 1
                    u["pulse"] = 1.0
                    new_r = min(u["r"] + USER_GROWTH, self.allowed_radius(u))
                    if new_r > u["r"]:
                        u["r"] = new_r
                    self.collisions += 1
                    self.dirty = True
                    del self.probes[i]
                    break

    # -- snapshot (must be called under lock) --
    def _snapshot_locked(self):
        bw, bh = self.world_size()
        return {
            "rev": self.rev,
            "t": now_ms(),
            "world": {"w": round(bw, 1), "h": round(bh, 1)},
            "collisions": self.collisions,
            "maxProbes": self.max_probes(),
            "users": [{
                "id": u["id"], "name": u["name"],
                "x": round(u["x"], 1), "y": round(u["y"], 1),
                "r": round(u["r"], 2), "hits": u["hits"],
                "loggedIn": u["loggedIn"], "pull": round(u["pullForce"], 3),
                "pulse": round(u["pulse"], 3), "createdAt": u["createdAt"],
                "sector": u["sector"],
            } for u in self.users],
            "probes": [{
                "id": p["id"], "x": round(p["x"], 1), "y": round(p["y"], 1),
                "hue": round(p["hue"], 1),
            } for p in self.probes],
        }

    def snapshot(self):
        with self.lock:
            return self._snapshot_locked()

    def tick(self, dt):
        """Advance the sim and return a serialized snapshot for broadcast."""
        with self.lock:
            self.update(dt)
            snap = self._snapshot_locked()
        return json.dumps(snap, separators=(",", ":")).encode("utf-8")

    # -- persistence --
    def _load(self):
        try:
            with open(ROSTER_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self.rev = int(data.get("rev", 0))
                for d in data.get("users", []):
                    self.users.append(self._new_user(d))
        except (FileNotFoundError, ValueError, OSError):
            pass

    def _save_locked(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        payload = {
            "rev": self.rev,
            "users": [{
                "name": u["name"], "fx": u["fx"], "fy": u["fy"], "r": u["r"],
                "hits": u["hits"], "createdAt": u["createdAt"], "loggedIn": u["loggedIn"],
            } for u in self.users],
        }
        tmp = ROSTER_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        # os.replace is atomic, but on Windows it can transiently fail with
        # PermissionError if an AV/indexer holds the target open. Retry a few
        # times; if it still fails, stay dirty so the autosave retries later
        # instead of crashing the request handler.
        for attempt in range(6):
            try:
                os.replace(tmp, ROSTER_PATH)
                self.dirty = False
                return
            except PermissionError:
                if attempt == 5:
                    print("warn: roster save deferred (file locked)", flush=True)
                    return
                time.sleep(0.02)

    def autosave(self):
        with self.lock:
            if self.dirty:
                self._save_locked()


sim = Sim()


# --- simulation thread ------------------------------------------------------
def sim_loop():
    step = 1.0 / TICK_HZ
    last = time.perf_counter()
    save_accum = 0.0
    while True:
        start = time.perf_counter()
        dt = start - last
        last = start
        if dt > 0.05:
            dt = 0.05
        hub.publish(sim.tick(dt))

        save_accum += dt
        if save_accum >= SAVE_EVERY:
            sim.autosave()
            save_accum = 0.0

        # keep a steady cadence
        sleep_for = step - (time.perf_counter() - start)
        if sleep_for > 0:
            time.sleep(sleep_for)


# --- HTTP handler -----------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, *args):
        pass  # quiet; SSE would flood the console otherwise

    # -- helpers --
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except (ValueError, TypeError):
            return None

    # -- routes --
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/stream":
            return self._stream()
        if path == "/api/state":
            return self._send_json(sim.snapshot())
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/join":
            body = self._read_json()
            if body is None:
                return self._send_json({"ok": False, "error": "bad_request"}, 400)
            res = sim.add_user(str(body.get("name", "")))
            return self._send_json(res, 200 if res.get("ok") else 200)
        if path == "/api/login":
            body = self._read_json()
            if body is None or "id" not in body:
                return self._send_json({"ok": False, "error": "bad_request"}, 400)
            res = sim.set_logged_in(int(body["id"]), bool(body.get("value", True)))
            return self._send_json(res, 200 if res.get("ok") else 404)
        if path == "/api/reset":
            return self._send_json(sim.reset())
        return self.send_error(404, "Not Found")

    # -- SSE stream --
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # disable proxy buffering
        self.end_headers()
        last_seq = -1
        try:
            while True:
                seq, data = hub.wait(last_seq, timeout=15)
                if seq == last_seq:
                    self.wfile.write(b": ping\n\n")     # keepalive comment
                else:
                    self.wfile.write(b"data: " + data + b"\n\n")
                    last_seq = seq
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return  # client disconnected


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    threading.Thread(target=sim_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"space-map (authoritative) http://{HOST}:{PORT}  "
          f"(tick {TICK_HZ}Hz, data: {ROSTER_PATH})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
