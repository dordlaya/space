/*
 * Space Map — LIVE (server-authoritative client)
 *
 * This client does NOT simulate anything. The server owns the world (probes,
 * collisions, growth) and streams JSON snapshots over SSE (/api/stream). Here we
 * only:
 *   1. connect to the stream and mirror the latest snapshot into local state,
 *   2. smoothly interpolate probe/camera motion between snapshots, and draw,
 *   3. send user input (join / login / reset) back to the server via HTTP.
 * Because every client renders the same authoritative snapshots, all tabs and
 * browsers now see the SAME probes, growth and board.
 */

// ---------------------------------------------------------------------------
// Config (client-side: rendering + layout only; physics live on the server)
// ---------------------------------------------------------------------------
const CONFIG = {
  userRadius: 10,        // must match the server's USER_RADIUS (for growth math)
  probeRadius: 6,
  maxProbes: 10,         // HUD display only

  sectorSize: 560,       // must match server SECTOR_SIZE
  sectorCols: 4,
  sectorPad: 70,
  starsPerSector: 10,

  zoomMax: 2.6,
  zoomStep: 1.25,

  starCounts: [140, 90, 50],
  trailLength: 26,       // client-built neon trail length
  probeEase: 14,         // how fast displayed probe pos chases the server target
};

const PULL_MIN = 0.05;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Renderer — PixiJS v8 (WebGL/WebGPU). Same setup as the POC; only the source
// of truth changed (server snapshots instead of a local sim).
// ---------------------------------------------------------------------------
const canvas = document.getElementById('map');

const world = { w: window.innerWidth, h: window.innerHeight };  // CSS pixels
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let uiScale = 1;

const app = new PIXI.Application();
let rendererReady = false;

let glowTex;
let bgLayer, worldLayer;
let sectorGfx, sectorLabelLayer, trailGfx, starGlowLayer, starGfx,
  starLabelLayer, probeGlowLayer, probeGfx;

const starGlowPool = [];
const probeGlowPool = [];
const sectorLabelPool = [];
const starLabelPool = [];
let bgStars = [];

function makeGlowTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return PIXI.Texture.from(c);
}

function makeGlowSprite() {
  const s = new PIXI.Sprite(glowTex);
  s.anchor.set(0.5);
  s.blendMode = 'add';
  return s;
}
function ensureSprites(layer, pool, n) {
  while (pool.length < n) { const s = makeGlowSprite(); pool.push(s); layer.addChild(s); }
  for (let i = n; i < pool.length; i++) pool[i].visible = false;
}
function ensureLabels(layer, pool, n, anchorX, anchorY) {
  while (pool.length < n) {
    const t = new PIXI.Text({
      text: '',
      style: { fontFamily: 'ui-monospace, monospace', fontSize: 16, fill: 0xffffff },
      resolution: 2,
    });
    t.anchor.set(anchorX, anchorY);
    pool.push(t);
    layer.addChild(t);
  }
  for (let i = n; i < pool.length; i++) pool[i].visible = false;
}
function setLabel(t, text, fill) {
  if (t._txt !== text) { t.text = text; t._txt = text; }
  if (t._fill !== fill) { t.style.fill = fill; t._fill = fill; }
}

function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const to = (v) => Math.round(255 * v);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}

function makeStars() {
  return CONFIG.starCounts.map((count, i) => {
    const depth = (i + 1) / CONFIG.starCounts.length;
    const stars = [];
    for (let s = 0; s < count; s++) {
      stars.push({
        x: Math.random() * world.w,
        y: Math.random() * world.h,
        r: 0.4 + depth * 1.6 * Math.random(),
        a: 0.15 + depth * 0.7 * Math.random(),
        tw: Math.random() * Math.PI * 2,
      });
    }
    return { depth, stars };
  });
}

function buildBackground() {
  for (const c of bgLayer.removeChildren()) c.destroy();
  bgStars = [];
  for (const layer of makeStars()) {
    for (const s of layer.stars) {
      const sp = new PIXI.Sprite(glowTex);
      sp.anchor.set(0.5);
      sp.blendMode = 'add';
      sp.tint = 0xcfe9ff;
      sp.width = sp.height = Math.max(1.2, s.r) * 3.2;
      bgStars.push({ sprite: sp, baseX: s.x, baseY: s.y, a: s.a, tw: s.tw, depth: layer.depth });
      bgLayer.addChild(sp);
    }
  }
}

function applyCamera() {
  worldLayer.scale.set(cam.zoom);
  worldLayer.position.set(world.w / 2 - cam.x * cam.zoom, world.h / 2 - cam.y * cam.zoom);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  world.w = window.innerWidth;
  world.h = window.innerHeight;
  uiScale = clamp(Math.min(world.w, world.h) / 820, 0.62, 1);
  if (!rendererReady) return;
  app.renderer.resize(world.w, world.h);
  buildBackground();
}
window.addEventListener('resize', resize);

async function bootstrap() {
  await app.init({
    canvas,
    width: world.w,
    height: world.h,
    background: 0x05070d,
    antialias: true,
    resolution: dpr,
    autoDensity: true,
    autoStart: false,
  });

  glowTex = makeGlowTexture();

  bgLayer = new PIXI.Container();
  worldLayer = new PIXI.Container();
  app.stage.addChild(bgLayer, worldLayer);

  sectorGfx = new PIXI.Graphics();
  sectorLabelLayer = new PIXI.Container();
  trailGfx = new PIXI.Graphics(); trailGfx.blendMode = 'add';
  starGlowLayer = new PIXI.Container();
  starGfx = new PIXI.Graphics();
  starLabelLayer = new PIXI.Container();
  probeGlowLayer = new PIXI.Container();
  probeGfx = new PIXI.Graphics();
  worldLayer.addChild(
    sectorGfx, sectorLabelLayer, trailGfx,
    starGlowLayer, starGfx, starLabelLayer,
    probeGlowLayer, probeGfx,
  );

  rendererReady = true;
  resize();
  last = performance.now();
  requestAnimationFrame(frame);
}
bootstrap();

// ---------------------------------------------------------------------------
// Sectors — deterministic from the number of users (same math as the server).
// ---------------------------------------------------------------------------
const SECTOR_WORDS = [
  'Andromeda', 'Cygnus', 'Draco', 'Eridanus', 'Fornax', 'Hydra', 'Indus', 'Lyra',
  'Orion', 'Perseus', 'Phoenix', 'Serpens', 'Tucana', 'Vela', 'Carina', 'Pyxis',
];
function sectorCount() { return Math.max(1, Math.ceil(users.length / CONFIG.starsPerSector)); }
function sectorName(i) {
  const base = SECTOR_WORDS[i % SECTOR_WORDS.length];
  const tier = Math.floor(i / SECTOR_WORDS.length);
  return tier > 0 ? `${base}-${tier + 1}` : base;
}
function sectorOrigin(i) {
  const col = i % CONFIG.sectorCols;
  const row = Math.floor(i / CONFIG.sectorCols);
  return { x: col * CONFIG.sectorSize, y: row * CONFIG.sectorSize };
}
function sectorCenter(i) {
  const o = sectorOrigin(i);
  return { x: o.x + CONFIG.sectorSize / 2, y: o.y + CONFIG.sectorSize / 2 };
}
function worldSize() {
  const n = sectorCount();
  const cols = Math.min(n, CONFIG.sectorCols);
  const rows = Math.ceil(n / CONFIG.sectorCols);
  return { w: cols * CONFIG.sectorSize, h: rows * CONFIG.sectorSize };
}

// ---------------------------------------------------------------------------
// State — mirrors the latest server snapshot. No simulation here.
// ---------------------------------------------------------------------------
let users = [];                 // [{id,name,x,y,r,hits,loggedIn,pullForce,pulse,createdAt,sector}]
let probes = [];                // display probes: {id,x,y,tx,ty,hue,trail:[]}
const probeById = new Map();
let collisionCount = 0;
let maxProbes = CONFIG.maxProbes;   // live cap from the server (10% of active users)
let spawnInterval = 10;             // live spawn cadence from the server (seconds)
let serverRev = -1;
let selectedUserId = null;
let firstSnapshot = false;
let linkUp = false;

// The signed-in session: which star is "mine". Persisted in localStorage so a
// reload keeps you signed in, and it gates edits to your own star only.
const SESSION_KEY = 'spacemap.session';
let sessionUserId = null;
let sessionUserName = null;

// Ability timings — mirror the server so the UI can show live countdowns.
// The server stays the sole authority; these are for display only.
const BOOST_DURATION_MS = 60_000;      // Heartbeat: 100% pull for 1 min...
const BOOST_COOLDOWN_MS = 600_000;     // ...then locked for the rest of 10 min
const JAM_ACTIVE_MS = 60_000;          // a jam visibly bites for 1 min (display)
// Per-target jam cooldown expiry (ms epoch) from the server, keyed by target id.
const jamCooldowns = new Map();
// The last jam timestamp we've already notified about for our own star.
// null = baseline not set yet (so we don't alert for a jam that predates login).
let myLastJamAt = null;

function getUserById(id) { return users.find((u) => u.id === id) || null; }

// Merge a server snapshot into local state.
function applySnapshot(snap) {
  collisionCount = snap.collisions || 0;
  if (typeof snap.maxProbes === 'number') maxProbes = snap.maxProbes;
  if (typeof snap.spawnInterval === 'number') spawnInterval = snap.spawnInterval;

  // Users only ride along on low-rate "user" ticks (or when the roster
  // changes) — most snapshots are probes-only, so skip the rebuild then and
  // keep the mirror we already have.
  const hasUsers = Array.isArray(snap.users);
  if (hasUsers) {
    users = snap.users.map((s) => ({
      id: s.id, name: s.name, x: s.x, y: s.y, r: s.r, hits: s.hits,
      loggedIn: s.loggedIn, pullForce: s.pull, pulse: s.pulse,
      createdAt: s.createdAt, sector: s.sector, boostAt: s.boostAt || 0,
      lastJamAt: s.lastJamAt || 0, lastJamBy: s.lastJamBy || '',
    }));

    // Did my own star just get jammed? Notify on the rising edge of lastJamAt.
    if (sessionUserId !== null) {
      const me = users.find((u) => u.id === sessionUserId);
      if (me) {
        if (myLastJamAt === null) {
          myLastJamAt = me.lastJamAt;         // baseline; don't alert for old jams
        } else if (me.lastJamAt > myLastJamAt) {
          myLastJamAt = me.lastJamAt;
          onJammed(me.lastJamBy || 'someone');
        }
      }
    }
  }

  // Probes: keep display objects across snapshots so we can interpolate + trail.
  const seen = new Set();
  for (const s of (snap.probes || [])) {
    let p = probeById.get(s.id);
    if (!p) {
      p = { id: s.id, x: s.x, y: s.y, tx: s.x, ty: s.y, hue: s.hue, trail: [] };
      probeById.set(s.id, p);
      probes.push(p);
    } else {
      p.tx = s.x; p.ty = s.y; p.hue = s.hue;
    }
    seen.add(s.id);
  }
  for (let i = probes.length - 1; i >= 0; i--) {
    if (!seen.has(probes[i].id)) { probeById.delete(probes[i].id); probes.splice(i, 1); }
  }

  // rev only travels with the users array. Roster membership / login changed →
  // refresh dependent UI.
  if (hasUsers && snap.rev !== serverRev) {
    serverRev = snap.rev;
    validateSession();   // drop a stale session (e.g. after a reset)
    refreshLoginUI();
    if (selectedUserId !== null && !getUserById(selectedUserId)) {
      selectedUserId = null;
      hideStarInfo();
    }
    if (fitPending) { fitPending = false; fitView(); }
  }

  if (!firstSnapshot && hasUsers) { firstSnapshot = true; fitView(); }
}

// ---------------------------------------------------------------------------
// WebSocket — the live link to the authoritative world. Unlike EventSource,
// WebSocket has no built-in reconnect, so we back off and retry ourselves.
// ---------------------------------------------------------------------------
let ws = null;
let reconnectDelay = 500;
function connectStream() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { linkUp = true; reconnectDelay = 500; };
  ws.onmessage = (e) => {
    try { applySnapshot(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
  ws.onclose = () => { linkUp = false; scheduleReconnect(); };
  ws.onerror = () => { /* an onclose always follows; reconnect happens there */ };
}
function scheduleReconnect() {
  setTimeout(connectStream, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);  // capped backoff
}
connectStream();

// ---------------------------------------------------------------------------
// Server actions (client input -> authoritative server)
// ---------------------------------------------------------------------------
async function apiRegister(name, email, password) {
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    return res.json();
  } catch { return { ok: false, error: 'network' }; }
}
async function apiLogin(identifier, password) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    return res.json();
  } catch { return { ok: false, error: 'network' }; }
}
// Toggle your own star online/offline (Go Live / Go Dark) — no password.
async function apiStatus(id, value) {
  try {
    await fetch('/api/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, value }),
    });
  } catch { /* will resync on next snapshot */ }
}
async function apiReset() {
  try { await fetch('/api/reset', { method: 'POST' }); } catch { /* ignore */ }
}
async function apiBoost(id) {
  try {
    const r = await fetch('/api/boost', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return r.json();
  } catch { return { ok: false, error: 'network' }; }
}
async function apiJam(attacker, target) {
  try {
    const r = await fetch('/api/jam', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attacker, target }),
    });
    return r.json();
  } catch { return { ok: false, error: 'network' }; }
}

// ---------------------------------------------------------------------------
// Camera — world-space view with smooth easing toward a target.
// ---------------------------------------------------------------------------
const cam = { x: 0, y: 0, zoom: 1 };
const camTarget = { x: 0, y: 0, zoom: 1 };
let fitPending = false;

function fitZoom() {
  const b = worldSize();
  const margin = 60;
  return Math.min((world.w - margin * 2) / b.w, (world.h - margin * 2) / b.h);
}
function minZoom() { return Math.min(fitZoom(), CONFIG.zoomMax); }

function fitView() {
  const b = worldSize();
  camTarget.x = cam.x = b.w / 2;
  camTarget.y = cam.y = b.h / 2;
  camTarget.zoom = cam.zoom = clamp(fitZoom(), 0.05, CONFIG.zoomMax);
}
fitView();

function toWorld(sx, sy) {
  return { x: (sx - world.w / 2) / cam.zoom + cam.x, y: (sy - world.h / 2) / cam.zoom + cam.y };
}

// ---------------------------------------------------------------------------
// Pointer: 1 finger/mouse = pan, 2 fingers = pinch-zoom, wheel = zoom,
// tap/click = select a star. Multi-touch is tracked via pointer events.
// ---------------------------------------------------------------------------
const pointers = new Map();        // pointerId -> {x, y} (canvas-relative)
let panning = false;
let pinch = null;                  // {startDist, startZoom, anchor:{x,y}}
let gestureMoved = false;          // true once a drag/pinch happened (suppresses tap)
const panStart = { sx: 0, sy: 0, camX: 0, camY: 0 };

const DOUBLE_TAP_MS = 300;         // max gap between taps to count as a double-tap
const DOUBLE_TAP_DIST = 30;        // max movement (screen px) between the two taps
let lastTap = { t: 0, x: 0, y: 0 };

// Double-tap / double-click: zoom in toward the point, or back out to fit if
// already zoomed in. Uses camTarget so the camera easing animates it smoothly.
function doubleTapZoom(sx, sy) {
  if (cam.zoom <= minZoom() * 1.2) {
    const before = toWorld(sx, sy);
    const nz = clamp(cam.zoom * 2.4, minZoom(), CONFIG.zoomMax);
    camTarget.zoom = nz;
    camTarget.x = before.x - (sx - world.w / 2) / nz;
    camTarget.y = before.y - (sy - world.h / 2) / nz;
  } else {
    fitView();
  }
}

function canvasXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function activePoints() { return [...pointers.values()]; }

function beginPan(p) {
  panning = true;
  panStart.sx = p.x; panStart.sy = p.y;
  panStart.camX = camTarget.x; panStart.camY = camTarget.y;
}
function beginPinch() {
  panning = false;
  const [a, b] = activePoints();
  const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  pinch = { startDist: dist, startZoom: cam.zoom, anchor: toWorld(mid.x, mid.y) };
}

canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, canvasXY(e));
  gestureMoved = false;
  if (pointers.size === 1) beginPan(activePoints()[0]);
  else if (pointers.size === 2) beginPinch();
});

window.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, canvasXY(e));

  // Two fingers: pinch-zoom, keeping the world point under the midpoint fixed
  // (finger translation also pans, which feels natural).
  if (pointers.size >= 2 && pinch) {
    const [a, b] = activePoints();
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const nz = clamp(pinch.startZoom * (dist / pinch.startDist), minZoom(), CONFIG.zoomMax);
    cam.zoom = camTarget.zoom = nz;
    cam.x = camTarget.x = pinch.anchor.x - (mid.x - world.w / 2) / nz;
    cam.y = camTarget.y = pinch.anchor.y - (mid.y - world.h / 2) / nz;
    gestureMoved = true;
    return;
  }

  // One finger/mouse: pan.
  if (panning && pointers.size === 1) {
    const p = activePoints()[0];
    const dx = p.x - panStart.sx;
    const dy = p.y - panStart.sy;
    if (Math.hypot(dx, dy) > 5) gestureMoved = true;
    cam.x = camTarget.x = panStart.camX - dx / cam.zoom;
    cam.y = camTarget.y = panStart.camY - dy / cam.zoom;
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const last = canvasXY(e);
  pointers.delete(e.pointerId);

  if (pointers.size === 1) {
    // Dropped from pinch back to a single finger — rebaseline the pan so the
    // remaining finger doesn't cause a jump.
    pinch = null;
    beginPan(activePoints()[0]);
  } else if (pointers.size === 0) {
    // A clean tap (no drag/pinch): double-tap zooms, single tap selects.
    if (!gestureMoved) {
      const now = performance.now();
      const isDouble = (now - lastTap.t) < DOUBLE_TAP_MS
        && Math.hypot(last.x - lastTap.x, last.y - lastTap.y) < DOUBLE_TAP_DIST;
      if (isDouble) {
        doubleTapZoom(last.x, last.y);
        lastTap.t = 0;                  // reset so a 3rd tap doesn't chain
      } else {
        lastTap = { t: now, x: last.x, y: last.y };
        const w = toWorld(last.x, last.y);
        const hit = userAt(w.x, w.y);
        if (hit) { selectedUserId = hit.id; showStarInfo(); }
        else { selectedUserId = null; hideStarInfo(); }
      }
    }
    panning = false;
    pinch = null;
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = toWorld(mx, my);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz = clamp(cam.zoom * factor, minZoom(), CONFIG.zoomMax);
  cam.zoom = camTarget.zoom = nz;
  cam.x = camTarget.x = before.x - (mx - world.w / 2) / nz;
  cam.y = camTarget.y = before.y - (my - world.h / 2) / nz;
}, { passive: false });

function userAt(x, y) {
  let hit = null;
  let bestD = Infinity;
  for (const u of users) {
    const tapR = Math.max(u.r + 6, 16 / cam.zoom);
    const d = (u.x - x) ** 2 + (u.y - y) ** 2;
    if (d <= tapR * tapR && d < bestD) { bestD = d; hit = u; }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// frame — ease camera + probes toward server targets, build trails, draw.
// ---------------------------------------------------------------------------
function stepDisplay(dt) {
  const zmin = minZoom();
  camTarget.zoom = clamp(camTarget.zoom, zmin, CONFIG.zoomMax);
  const k = Math.min(1, dt * 8);
  cam.x += (camTarget.x - cam.x) * k;
  cam.y += (camTarget.y - cam.y) * k;
  cam.zoom += (camTarget.zoom - cam.zoom) * k;

  // Interpolate displayed probe positions toward the latest server target, then
  // append to the client-built neon trail (smooth even at ~30Hz snapshots).
  const pk = Math.min(1, dt * CONFIG.probeEase);
  for (const p of probes) {
    p.x += (p.tx - p.x) * pk;
    p.y += (p.ty - p.y) * pk;
    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > CONFIG.trailLength) p.trail.shift();
  }
}

// ---------------------------------------------------------------------------
// render() — draw current state through the camera.
// ---------------------------------------------------------------------------
function render(time) {
  const z = cam.zoom;
  applyCamera();

  // Visible world rectangle (+ margin for glow/labels near the edge). With
  // thousands of stars, skipping everything off-screen is the single biggest
  // client-side win — we only pay to draw what the camera can actually see.
  const cullMargin = 80;
  const halfW = world.w / 2 / z + cullMargin;
  const halfH = world.h / 2 / z + cullMargin;
  const viewMinX = cam.x - halfW, viewMaxX = cam.x + halfW;
  const viewMinY = cam.y - halfH, viewMaxY = cam.y + halfH;

  // --- Background starfield (screen space, parallax + twinkle) ---
  for (const st of bgStars) {
    const shiftX = (cam.x * 0.03 * st.depth) % world.w;
    const shiftY = (cam.y * 0.03 * st.depth) % world.h;
    let sx = st.baseX - shiftX; if (sx < 0) sx += world.w;
    let sy = st.baseY - shiftY; if (sy < 0) sy += world.h;
    st.sprite.position.set(sx, sy);
    st.sprite.alpha = st.a * (0.6 + 0.4 * Math.sin(time * 0.002 + st.tw));
  }

  // --- Sector borders + labels ---
  const n = sectorCount();
  const S = CONFIG.sectorSize;
  const sectorOnScreen = S * z;
  const sectorFontPx = clamp(sectorOnScreen * 0.045, 9, 15) * uiScale;
  const showSectorLabel = sectorOnScreen > 140 * uiScale;
  const sectorStroke = { width: (1.25 * uiScale) / z, color: 0x78b4dc, alpha: 0.22 };
  sectorGfx.clear();
  ensureLabels(sectorLabelLayer, sectorLabelPool, n, 0, 0);
  for (let i = 0; i < n; i++) {
    const o = sectorOrigin(i);
    const lbl = sectorLabelPool[i];
    if (o.x > viewMaxX || o.x + S < viewMinX || o.y > viewMaxY || o.y + S < viewMinY) {
      lbl.visible = false;
      continue;  // sector fully off-screen
    }
    sectorGfx.rect(o.x, o.y, S, S).stroke(sectorStroke);
    if (showSectorLabel) {
      lbl.visible = true;
      setLabel(lbl, `SECTOR · ${sectorName(i).toUpperCase()}`, 0x96cdeb);
      lbl.alpha = 0.55;
      lbl.scale.set(sectorFontPx / (16 * z));
      lbl.position.set(o.x + (10 * uiScale) / z, o.y + (8 * uiScale) / z);
    } else {
      lbl.visible = false;
    }
  }

  // --- Neon probe trails: additive fat halo + thin bright core ---
  trailGfx.clear();
  for (const p of probes) {
    const pts = p.trail;
    if (pts.length < 2) continue;
    const glowC = hsl2hex(p.hue, 100, 60);
    const coreC = hsl2hex(p.hue, 100, 85);
    for (let i = 1; i < pts.length; i++) {
      const t = i / (pts.length - 1);
      const A = pts[i - 1], B = pts[i];
      trailGfx.moveTo(A.x, A.y).lineTo(B.x, B.y)
        .stroke({ width: (3.4 * uiScale) / z, color: glowC, alpha: 0.12 * t, cap: 'round' });
      trailGfx.moveTo(A.x, A.y).lineTo(B.x, B.y)
        .stroke({ width: (1.5 * uiScale) / z, color: coreC, alpha: 0.9 * t, cap: 'round' });
    }
  }

  // --- Stars (users): additive glow sprite + star body + rings + label ---
  ensureSprites(starGlowLayer, starGlowPool, users.length);
  ensureLabels(starLabelLayer, starLabelPool, users.length, 0.5, 1);
  starGfx.clear();
  users.forEach((u, idx) => {
    if (u.x < viewMinX || u.x > viewMaxX || u.y < viewMinY || u.y > viewMaxY) {
      starGlowPool[idx].visible = false;
      starLabelPool[idx].visible = false;
      return;  // off-screen star: skip glow, body and label entirely
    }
    const pulse = u.pulse;
    const vis = 0.2 + 0.8 * u.pullForce;

    const gs = starGlowPool[idx];
    gs.visible = true;
    gs.position.set(u.x, u.y);
    gs.width = gs.height = (u.r + 12) * 2;
    gs.tint = 0xffd696;
    gs.alpha = vis * (0.45 + pulse * 0.5);

    if (pulse > 0) {
      starGfx.circle(u.x, u.y, u.r + 6 + (1 - pulse) * 16)
        .stroke({ width: 2 / z, color: 0xffd282, alpha: pulse });
    }
    drawStarShape(u.x, u.y, u.r, pulse, vis);
    if (u.id === selectedUserId) {
      starGfx.circle(u.x, u.y, u.r + 12)
        .stroke({ width: 1.5 / z, color: 0x9fe7ff, alpha: 0.9 });
    }

    const lbl = starLabelPool[idx];
    const screenR = u.r * z;
    if (screenR > 4 * uiScale || u.id === selectedUserId) {
      const labelPx = clamp(screenR * 0.85, 8, 14) * uiScale;
      const tag = u.pullForce <= PULL_MIN ? ' · offline' : ` · ${u.hits}`;
      lbl.visible = true;
      setLabel(lbl, `${u.name}${tag}`, u.loggedIn ? 0xffe9c2 : 0x8aa0ad);
      lbl.alpha = 0.4 + 0.5 * u.pullForce;
      lbl.scale.set(labelPx / (16 * z));
      lbl.position.set(u.x, u.y - u.r - 3 / z);
    } else {
      lbl.visible = false;
    }
  });

  // --- Probes: additive glow sprite + colored core + hot white centre ---
  const R = CONFIG.probeRadius;
  ensureSprites(probeGlowLayer, probeGlowPool, probes.length);
  probeGfx.clear();
  probes.forEach((p, idx) => {
    const gs = probeGlowPool[idx];
    gs.visible = true;
    gs.position.set(p.x, p.y);
    gs.width = gs.height = R * 6;
    gs.tint = hsl2hex(p.hue, 100, 66);
    gs.alpha = 0.6;
    probeGfx.circle(p.x, p.y, R).fill(hsl2hex(p.hue, 100, 68));
    probeGfx.circle(p.x, p.y, R * 0.45).fill(0xf4fbff);
  });

  app.render();
}

function drawStarShape(x, y, r, pulse, vis) {
  const spikes = 4;
  const outer = r + pulse * 3;
  const inner = outer * 0.4;
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / spikes) * i - Math.PI / 2;
    pts.push(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  starGfx.poly(pts, true).fill({ color: 0xfff0d2, alpha: 0.9 * vis });
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = {
  probes: document.getElementById('hud-probes'),
  spawn: document.getElementById('hud-spawn'),
  users: document.getElementById('hud-users'),
  sectors: document.getElementById('hud-sectors'),
  collisions: document.getElementById('hud-collisions'),
  fps: document.getElementById('hud-fps'),
  link: document.getElementById('hud-link'),
};
let hudTimer = 0;
function updateHud(dt, fps) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.15;
  const online = users.reduce((a, u) => a + (u.loggedIn ? 1 : 0), 0);
  hud.probes.textContent = `${probes.length} / ${maxProbes}`;
  hud.spawn.textContent = `every ${spawnInterval.toFixed(1)}s`;
  hud.users.textContent = `${online} / ${users.length} online`;
  hud.sectors.textContent = String(sectorCount());
  hud.collisions.textContent = String(collisionCount);
  hud.fps.textContent = fps.toFixed(0);
  hud.link.textContent = linkUp ? 'live' : 'reconnecting…';
  hud.link.className = linkUp ? 'link-live' : 'link-down';
  updateStarInfo();
  refreshHeartbeat();
  refreshHomeButton();
  refreshLeaderboard();
}

// ---------------------------------------------------------------------------
// Zoom controls
// ---------------------------------------------------------------------------
function zoomBy(factor) {
  camTarget.zoom = clamp(camTarget.zoom * factor, minZoom(), CONFIG.zoomMax);
}
document.getElementById('zoom-in').addEventListener('click', () => zoomBy(CONFIG.zoomStep));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / CONFIG.zoomStep));
document.getElementById('zoom-fit').addEventListener('click', fitView);

// Home planet: zoom straight to your own star (only shown when signed in).
const homeBtn = document.getElementById('zoom-home');
homeBtn.addEventListener('click', () => {
  const me = sessionUserId !== null ? getUserById(sessionUserId) : null;
  if (me) focusStar(me);
});
function refreshHomeButton() {
  const has = sessionUserId !== null && !!getUserById(sessionUserId);
  homeBtn.classList.toggle('hidden', !has);
}

// ---------------------------------------------------------------------------
// Search — jump to a star (by name) or a sector (by name).
// ---------------------------------------------------------------------------
const search = {
  input: document.getElementById('search'),
  results: document.getElementById('search-results'),
};

function focusStar(u) {
  camTarget.x = u.x;
  camTarget.y = u.y;
  camTarget.zoom = clamp(1.8, minZoom(), CONFIG.zoomMax);
  selectedUserId = u.id;
  showStarInfo();
}
function focusSector(i) {
  const c = sectorCenter(i);
  camTarget.x = c.x;
  camTarget.y = c.y;
  const fit = Math.min((world.w - 80) / CONFIG.sectorSize, (world.h - 80) / CONFIG.sectorSize);
  camTarget.zoom = clamp(fit, minZoom(), CONFIG.zoomMax);
}

function runSearch() {
  const q = search.input.value.trim().toLowerCase();
  search.results.innerHTML = '';
  if (!q) { search.results.classList.add('hidden'); return; }

  const items = [];
  for (let i = 0; i < sectorCount(); i++) {
    if (sectorName(i).toLowerCase().includes(q)) {
      items.push({ kind: 'sector', label: sectorName(i), sub: 'sector', onPick: () => focusSector(i) });
    }
  }
  for (const u of users) {
    if (u.name.toLowerCase().includes(q)) {
      items.push({ kind: 'star', label: u.name, sub: `star · ${sectorName(u.sector)}`, onPick: () => focusStar(u) });
    }
  }

  if (!items.length) {
    search.results.innerHTML = '<div class="search-empty">No matches</div>';
    search.results.classList.remove('hidden');
    return;
  }

  for (const it of items.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'search-item';
    row.innerHTML = `<span class="si-dot ${it.kind}"></span><span class="si-label">${it.label}</span><span class="si-sub">${it.sub}</span>`;
    row.addEventListener('click', () => {
      it.onPick();
      search.results.classList.add('hidden');
      search.input.blur();
    });
    search.results.appendChild(row);
  }
  search.results.classList.remove('hidden');
}

search.input.addEventListener('input', runSearch);
search.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = search.results.querySelector('.search-item');
    if (first) first.click();
  } else if (e.key === 'Escape') {
    search.results.classList.add('hidden');
    search.input.blur();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#search-wrap')) search.results.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Leaderboard — top 10 stars by size; expand/collapse, state remembered.
// ---------------------------------------------------------------------------
const LB_KEY = 'spacemap.lb';
const leaderboard = {
  panel: document.getElementById('leaderboard'),
  toggle: document.getElementById('lb-toggle'),
  body: document.getElementById('lb-body'),
};
let lbOpen = false;
try { lbOpen = localStorage.getItem(LB_KEY) === '1'; } catch { /* ignore */ }

function setLeaderboardOpen(open) {
  lbOpen = open;
  leaderboard.panel.classList.toggle('collapsed', !open);
  try { localStorage.setItem(LB_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  if (open) refreshLeaderboard();
}

function refreshLeaderboard() {
  if (!lbOpen) return;   // hidden — don't bother building rows
  const top = [...users].sort((a, b) => b.r - a.r).slice(0, 10);
  if (!top.length) {
    leaderboard.body.innerHTML = '<div class="lb-empty">No stars yet.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  top.forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    row.title = `Focus ${u.name}`;
    // Build via nodes + textContent so user-supplied names can't inject markup.
    row.innerHTML =
      `<span class="lb-rank">${i + 1}</span>` +
      '<div class="lb-main"><span class="lb-name"></span><span class="lb-sector"></span></div>' +
      `<span class="lb-size">${u.r.toFixed(1)}px</span>` +
      `<span class="lb-dot ${u.loggedIn ? 'online' : ''}" title="${u.loggedIn ? 'online' : 'offline'}"></span>`;
    row.querySelector('.lb-name').textContent = u.name;
    row.querySelector('.lb-sector').textContent = sectorName(u.sector);
    row.addEventListener('click', () => focusStar(u));
    frag.appendChild(row);
  });
  leaderboard.body.replaceChildren(frag);
}

leaderboard.toggle.addEventListener('click', () => setLeaderboardOpen(!lbOpen));
setLeaderboardOpen(lbOpen);

// ---------------------------------------------------------------------------
// Login page — actions now go to the authoritative server.
// ---------------------------------------------------------------------------
const login = {
  panel: document.getElementById('login'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  formLogin: document.getElementById('form-login'),
  formRegister: document.getElementById('form-register'),
  loginId: document.getElementById('login-id'),
  loginPass: document.getElementById('login-pass'),
  loginBtn: document.getElementById('login-btn'),
  regName: document.getElementById('reg-name'),
  regEmail: document.getElementById('reg-email'),
  regPass: document.getElementById('reg-pass'),
  registerBtn: document.getElementById('register-btn'),
  enter: document.getElementById('enter-btn'),
  list: document.getElementById('user-list'),
  reset: document.getElementById('reset-users'),
  close: document.getElementById('login-close'),
  addBtn: document.getElementById('add-user'),
  error: document.getElementById('login-error'),
};

let loginMode = 'login';
function setLoginMode(mode) {
  loginMode = mode;
  const isLogin = mode === 'login';
  login.tabLogin.classList.toggle('active', isLogin);
  login.tabRegister.classList.toggle('active', !isLogin);
  login.formLogin.classList.toggle('hidden', !isLogin);
  login.formRegister.classList.toggle('hidden', isLogin);
  clearLoginError();
}

function showLogin() {
  login.panel.classList.remove('hidden');
  clearLoginError();
  refreshLoginUI();
  const focusEl = loginMode === 'login' ? login.loginId : login.regName;
  setTimeout(() => focusEl.focus(), 50);
}
function hideLogin() { login.panel.classList.add('hidden'); }

function emailLooksValid(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((email || '').trim());
}
function userExists(name) {
  const key = name.trim().toLowerCase();
  return !!key && users.some((u) => u.name.toLowerCase() === key);
}
function showLoginError(msg) {
  login.error.textContent = msg;
  login.error.classList.remove('hidden');
}
function clearLoginError() {
  login.error.textContent = '';
  login.error.classList.add('hidden');
}
function errorMessage(error) {
  switch (error) {
    case 'name_taken': return 'That nickname is already taken — pick another.';
    case 'email_taken': return 'That email is already registered — try logging in.';
    case 'bad_email': return 'Please enter a valid email address.';
    case 'weak_password': return 'Password must be at least 4 characters.';
    case 'empty': return 'Please enter a nickname.';
    case 'invalid_credentials': return 'Wrong email/username or password.';
    case 'network': return 'Server unreachable — please try again.';
    default: return 'Something went wrong — please try again.';
  }
}

const USER_LIST_LIMIT = 10;   // show the N most-recent users; rest behind a toggle
let showAllUsers = false;

function refreshLoginUI() {
  login.list.innerHTML = '';

  // Most-recently-joined first, so the "latest" users are always visible.
  const ordered = [...users].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const shown = showAllUsers ? ordered : ordered.slice(0, USER_LIST_LIMIT);

  for (const u of shown) {
    const chip = document.createElement('span');
    chip.className = 'user-chip' + (u.loggedIn ? ' online' : '')
      + (u.id === sessionUserId ? ' me' : '');
    chip.textContent = u.name;
    chip.title = u.id === sessionUserId
      ? "This is you — you're signed in"
      : `Log in as ${u.name}`;
    chip.addEventListener('click', () => { loginAs(u); });
    login.list.appendChild(chip);
  }

  const hidden = users.length - shown.length;
  if (users.length > USER_LIST_LIMIT) {
    const more = document.createElement('span');
    more.className = 'user-more';
    more.textContent = showAllUsers ? 'show less' : `+${hidden} more`;
    more.title = showAllUsers ? 'Collapse the list' : 'Show all users';
    more.addEventListener('click', () => { showAllUsers = !showAllUsers; refreshLoginUI(); });
    login.list.appendChild(more);
  }

  login.close.style.display = 'flex';
  login.addBtn.style.display = 'flex';
}

async function doLogin() {
  const identifier = login.loginId.value.trim();
  const password = login.loginPass.value;
  if (!identifier || !password) {
    showLoginError('Enter your email/username and password.');
    return;
  }
  login.loginBtn.disabled = true;
  try {
    const res = await apiLogin(identifier, password);
    if (!res.ok) { showLoginError(errorMessage(res.error)); login.loginPass.select(); return; }
    clearLoginError();
    setSession(res.id, res.name);
    login.loginPass.value = '';
    fitPending = true;      // fit once our star shows up in a snapshot
    hideLogin();
  } finally {
    login.loginBtn.disabled = false;
  }
}

async function doRegister() {
  const name = login.regName.value.trim();
  const email = login.regEmail.value.trim();
  const password = login.regPass.value;
  if (!name) { showLoginError('Please enter a nickname.'); login.regName.focus(); return; }
  if (!emailLooksValid(email)) { showLoginError('Please enter a valid email address.'); login.regEmail.focus(); return; }
  if (password.length < 4) { showLoginError('Password must be at least 4 characters.'); login.regPass.focus(); return; }
  // Fast client-side name check for snappy feedback; the server is authoritative.
  if (userExists(name)) { showLoginError('That nickname is already taken — pick another.'); login.regName.select(); return; }
  login.registerBtn.disabled = true;
  try {
    const res = await apiRegister(name, email, password);
    if (!res.ok) { showLoginError(errorMessage(res.error)); return; }
    clearLoginError();
    setSession(res.id, res.name || name);   // this new star is now "mine"
    login.regName.value = ''; login.regEmail.value = ''; login.regPass.value = '';
    fitPending = true;
    hideLogin();
  } finally {
    login.registerBtn.disabled = false;
  }
}

login.tabLogin.addEventListener('click', () => setLoginMode('login'));
login.tabRegister.addEventListener('click', () => setLoginMode('register'));
login.loginBtn.addEventListener('click', doLogin);
login.registerBtn.addEventListener('click', doRegister);
[login.loginId, login.loginPass].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
[login.regName, login.regEmail, login.regPass].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); }));
[login.loginId, login.loginPass, login.regName, login.regEmail, login.regPass]
  .forEach((el) => el.addEventListener('input', clearLoginError));
login.enter.addEventListener('click', () => { hideLogin(); fitView(); });
login.close.addEventListener('click', hideLogin);
login.addBtn.addEventListener('click', showLogin);
login.reset.addEventListener('click', (e) => {
  e.preventDefault();
  apiReset();
  clearSession();
  selectedUserId = null;
  hideStarInfo();
});
setLoginMode('login');

// ---------------------------------------------------------------------------
// Session — remember who "I" am across reloads, and gate edits to my own star.
// ---------------------------------------------------------------------------
const sessionBar = {
  bar: document.getElementById('session-bar'),
  label: document.getElementById('session-label'),
  logout: document.getElementById('logout-btn'),
  sound: document.getElementById('sound-toggle'),
};

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (s && typeof s.id === 'number') return s;
  } catch { /* ignore corrupt value */ }
  return null;
}
function setSession(id, name) {
  sessionUserId = id;
  sessionUserName = name;
  myLastJamAt = null;   // re-baseline jam alerts for the new identity
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ id, name })); } catch { /* ignore */ }
  refreshSessionBar();
  refreshHeartbeat();
  if (selectedUserId !== null) updateStarInfo();
}
function clearSession() {
  sessionUserId = null;
  sessionUserName = null;
  myLastJamAt = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  refreshSessionBar();
  refreshHeartbeat();
  if (selectedUserId !== null) updateStarInfo();
}
// Drop the session if the star it points at no longer matches (e.g. reset).
function validateSession() {
  if (sessionUserId === null) return;
  const me = getUserById(sessionUserId);
  const nameOk = me && (!sessionUserName
    || me.name.toLowerCase() === sessionUserName.toLowerCase());
  if (!nameOk) clearSession();
}
// Clicking a known user prefills the login form (password still required).
function loginAs(u) {
  setLoginMode('login');
  login.loginId.value = u.name;
  login.loginPass.value = '';
  clearLoginError();
  setTimeout(() => login.loginPass.focus(), 30);
}
function refreshSessionBar() {
  if (sessionUserId !== null) {
    sessionBar.label.textContent = `Signed in as ${sessionUserName || '—'}`;
    sessionBar.bar.classList.remove('hidden');
  } else {
    sessionBar.bar.classList.add('hidden');
  }
}
sessionBar.logout.addEventListener('click', clearSession);

// Bootstrap: resume a saved session straight onto the map; otherwise show login.
const savedSession = loadSession();
if (savedSession) {
  sessionUserId = savedSession.id;
  sessionUserName = savedSession.name;
  refreshSessionBar();
} else {
  showLogin();
}

// ---------------------------------------------------------------------------
// Notifications & sound — toast + red flash + WebAudio tones (no asset files).
// ---------------------------------------------------------------------------
const SOUND_KEY = 'spacemap.sound';
let soundEnabled = true;
try { soundEnabled = localStorage.getItem(SOUND_KEY) !== '0'; } catch { /* ignore */ }

let audioCtx = null;
function ensureAudio() {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Browsers require a user gesture before audio can start — resume on first input.
window.addEventListener('pointerdown', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { passive: true });

function playTone({ freq = 440, dur = 0.15, type = 'sine', gain = 0.2, slideTo = null, delay = 0 }) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}
function soundJammed() {
  // Two-tone descending "alarm".
  playTone({ freq: 660, slideTo: 220, dur: 0.28, type: 'sawtooth', gain: 0.22 });
  playTone({ freq: 440, slideTo: 150, dur: 0.34, type: 'square', gain: 0.12, delay: 0.13 });
}
function soundCast() {
  // Soft confirm blip when you fire an ability.
  playTone({ freq: 520, slideTo: 780, dur: 0.12, type: 'triangle', gain: 0.14 });
}

const toasts = document.getElementById('toasts');
function showToast(msg, kind = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;               // textContent — names can't inject markup
  toasts.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

const screenFlash = document.getElementById('screen-flash');
function flashScreen() {
  screenFlash.classList.remove('flash');
  void screenFlash.offsetWidth;       // reflow so the animation can re-trigger
  screenFlash.classList.add('flash');
}

function onJammed(byName) {
  showToast(`⚡ Jammed by ${byName} — pull −25% for 60s`, 'jam');
  flashScreen();
  soundJammed();
}

function refreshSoundToggle() {
  sessionBar.sound.textContent = soundEnabled ? '🔊' : '🔇';
  sessionBar.sound.classList.toggle('muted', !soundEnabled);
  sessionBar.sound.title = soundEnabled ? 'Sounds on — click to mute' : 'Muted — click to unmute';
}
sessionBar.sound.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem(SOUND_KEY, soundEnabled ? '1' : '0'); } catch { /* ignore */ }
  refreshSoundToggle();
  if (soundEnabled) soundCast();      // brief confirmation that audio is on
});
refreshSoundToggle();

// ---------------------------------------------------------------------------
// Star info panel
// ---------------------------------------------------------------------------
const starInfo = {
  panel: document.getElementById('star-info'),
  name: document.getElementById('si-name'),
  sector: document.getElementById('si-sector'),
  status: document.getElementById('si-status'),
  pull: document.getElementById('si-pull'),
  age: document.getElementById('si-age'),
  absorbed: document.getElementById('si-absorbed'),
  size: document.getElementById('si-size'),
  growth: document.getElementById('si-growth'),
  pos: document.getElementById('si-pos'),
  born: document.getElementById('si-born'),
  toggle: document.getElementById('si-toggle'),
  jam: document.getElementById('si-jam'),
  close: document.getElementById('si-close'),
};
starInfo.close.addEventListener('click', () => { selectedUserId = null; hideStarInfo(); });
starInfo.toggle.addEventListener('click', () => {
  if (selectedUserId !== sessionUserId) return;   // you can only change your own star
  const u = getUserById(selectedUserId);
  if (!u) return;
  apiStatus(u.id, !u.loggedIn);   // server flips it; snapshot updates the panel
});
starInfo.jam.addEventListener('click', async () => {
  const target = selectedUserId;
  if (target === null || target === sessionUserId || sessionUserId === null) return;
  starInfo.jam.disabled = true;
  const res = await apiJam(sessionUserId, target);
  if (res.cooldownUntil) jamCooldowns.set(target, res.cooldownUntil);
  if (res.ok) soundCast();
  refreshAbilityUI();
});

function showStarInfo() { starInfo.panel.classList.remove('hidden'); updateStarInfo(); }
function hideStarInfo() { starInfo.panel.classList.add('hidden'); }

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function updateStarInfo() {
  if (selectedUserId === null) return;
  const u = getUserById(selectedUserId);
  if (!u) { selectedUserId = null; hideStarInfo(); return; }
  starInfo.name.textContent = u.name;
  starInfo.sector.textContent = sectorName(u.sector);
  const jammed = (u.lastJamAt || 0) > 0 && (Date.now() - u.lastJamAt) < JAM_ACTIVE_MS;
  starInfo.status.textContent = (u.loggedIn ? 'online' : 'offline') + (jammed ? ' · jammed' : '');
  starInfo.status.className = jammed ? 'si-jammed' : (u.loggedIn ? 'si-online' : 'si-offline');
  starInfo.pull.textContent = `${Math.round(u.pullForce * 100)}%`;
  starInfo.age.textContent = formatDuration(Date.now() - u.createdAt);
  starInfo.absorbed.textContent = String(u.hits);
  starInfo.size.textContent = `${u.r.toFixed(1)} px`;
  starInfo.growth.textContent = `+${(u.r - CONFIG.userRadius).toFixed(1)} px`;
  starInfo.pos.textContent = `${u.x.toFixed(0)}, ${u.y.toFixed(0)}`;
  starInfo.born.textContent = new Date(u.createdAt).toLocaleTimeString();
  // Only the owner can change their star — everyone else sees it read-only.
  if (u.id === sessionUserId) {
    starInfo.toggle.style.display = '';
    starInfo.toggle.textContent = u.loggedIn ? 'Go Dark' : 'Go Live';
  } else {
    starInfo.toggle.style.display = 'none';
  }

  // Jam is only for OTHER stars, and only when you're signed in.
  if (sessionUserId !== null && u.id !== sessionUserId) {
    starInfo.jam.classList.remove('hidden');
    const me = getUserById(sessionUserId);
    const cd = jamCooldowns.get(u.id) || 0;
    const remaining = cd - Date.now();
    if (me && !me.loggedIn) {
      starInfo.jam.disabled = true;
      starInfo.jam.textContent = 'Go Live to Jam';
    } else if (remaining > 0) {
      starInfo.jam.disabled = true;
      starInfo.jam.textContent = `Jam in ${fmtClock(remaining)}`;
    } else {
      starInfo.jam.disabled = false;
      starInfo.jam.textContent = 'Jam −25%';
    }
  } else {
    starInfo.jam.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Abilities — Heartbeat (self boost). Jam lives in the star panel above.
// The server is authoritative; boost state is derived from the snapshot's
// boostAt so it survives reloads.
// ---------------------------------------------------------------------------
const heartbeatBtn = document.getElementById('heartbeat-btn');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
}

function boostState() {
  const me = sessionUserId !== null ? getUserById(sessionUserId) : null;
  if (!me) return { kind: 'none' };
  const now = Date.now();
  const at = me.boostAt || 0;
  if (at && now - at < BOOST_DURATION_MS) return { kind: 'active', until: at + BOOST_DURATION_MS };
  const readyAt = at ? at + BOOST_COOLDOWN_MS : 0;
  if (now < readyAt) return { kind: 'cooldown', until: readyAt };
  return { kind: 'ready' };
}

function refreshHeartbeat() {
  if (sessionUserId === null) { heartbeatBtn.classList.add('hidden'); return; }
  heartbeatBtn.classList.remove('hidden');
  const me = getUserById(sessionUserId);
  const st = boostState();
  const now = Date.now();
  heartbeatBtn.classList.toggle('boosting', st.kind === 'active');
  heartbeatBtn.classList.toggle('count', st.kind === 'cooldown');
  if (!me || !me.loggedIn) {
    heartbeatBtn.disabled = true;
    heartbeatBtn.textContent = '⚡';
    heartbeatBtn.title = 'Go live to use Heartbeat';
  } else if (st.kind === 'active') {
    heartbeatBtn.disabled = true;
    heartbeatBtn.textContent = '⚡';
    heartbeatBtn.title = `Boosting — ${fmtClock(st.until - now)} left`;
  } else if (st.kind === 'cooldown') {
    heartbeatBtn.disabled = true;
    heartbeatBtn.textContent = fmtClock(st.until - now);   // mm:ss until ready
    heartbeatBtn.title = `Heartbeat ready in ${fmtClock(st.until - now)}`;
  } else {
    heartbeatBtn.disabled = false;
    heartbeatBtn.textContent = '⚡';
    heartbeatBtn.title = 'Heartbeat — boost your pull to 100% for 1 min';
  }
}

heartbeatBtn.addEventListener('click', async () => {
  if (sessionUserId === null) return;
  heartbeatBtn.disabled = true;
  const res = await apiBoost(sessionUserId);
  if (res.ok && res.boostUntil) {
    const me = getUserById(sessionUserId);
    if (me) me.boostAt = res.boostUntil - BOOST_DURATION_MS;   // optimistic; snapshot confirms
    soundCast();
  }
  refreshHeartbeat();
});

// One entry point the session/snapshot code can poke to keep buttons in sync.
function refreshAbilityUI() {
  refreshHeartbeat();
  if (selectedUserId !== null) updateStarInfo();
}

// ---------------------------------------------------------------------------
// The loop — pure rendering; the server drives the simulation.
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);

  stepDisplay(dt);
  render(now);
  updateHud(dt, dt > 0 ? 1 / dt : 0);

  requestAnimationFrame(frame);
}
// The render loop is started by bootstrap() once app.init() resolves (v8 is async).
