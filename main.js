/*
 * Space Map POC
 * Autonomous "probes" (roaming dots) drift across a starfield and collide with
 * "users" — star-nodes placed on the map. Stars are grouped into named SECTORS
 * (every 10 stars = one sector). The map has world-space coordinates with a
 * pan/zoom camera, plus a search bar to jump to a star or sector.
 *
 * Engine pieces (portable to React Native / Flutter / Unity later):
 *   1. World + camera        (world coords, screen<->world transforms)
 *   2. Entities / state      (users, probes, sectors, background stars)
 *   3. update(dt)            (steering / collisions / camera easing — the tick)
 *   4. render()              (draw current state through the camera)
 *   5. the loop              (update + render every frame, delta-timed)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  maxSpeed: 90,
  wanderStrength: 2.6,
  edgeMargin: 120,
  edgeForce: 140,
  seekForce: 220,

  userRadius: 10,
  userAttraction: 26,    // BASE pull; each star scales this by its pullForce
  userGrowth: 2.5,
  maxUserRadius: 46,
  starMinGap: 12,        // min empty space (world px) to keep between star edges
  pullFade: 3,           // how fast pullForce eases to its login target

  probeRadius: 6,
  spawnInterval: 10,
  maxProbes: 10,

  // Sectors
  sectorSize: 560,       // world px per sector cell (square)
  sectorCols: 4,         // sectors are laid out in a grid this many columns wide
  sectorPad: 70,         // keep stars this far inside their sector cell
  starsPerSector: 10,    // every N stars form a new sector

  // Camera
  zoomMax: 2.6,
  zoomStep: 1.25,

  starCounts: [140, 90, 50],
  trailLength: 26,       // number of recent points kept per probe for its neon trail
};

const PULL_MIN = 0.05; // below this a star is inert (no pull, no collisions)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Renderer — PixiJS v8 (WebGL/WebGPU). We keep our own update()/loop and drive
// drawing manually (autoStart:false); ONLY the draw layer is Pixi. All
// simulation, camera math, persistence and HTML UI stay exactly as before.
// v8 note: app.init() is async, so the renderer-owned objects are created in
// bootstrap() below and the render loop only starts once init resolves.
// ---------------------------------------------------------------------------
const canvas = document.getElementById('map');

const world = { w: window.innerWidth, h: window.innerHeight };  // CSS pixels
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let uiScale = 1;                 // shrinks on-screen text/lines on small screens

const app = new PIXI.Application();   // v8: construct empty, configure via init()
let rendererReady = false;

// Renderer-owned display objects (assigned in bootstrap() after app.init()).
let glowTex;
let bgLayer, worldLayer;
let sectorGfx, sectorLabelLayer, trailGfx, starGlowLayer, starGfx,
  starLabelLayer, probeGlowLayer, probeGfx, seekGfx;

// --- Pools (reuse display objects; hide extras instead of destroying) ---
const starGlowPool = [];
const probeGlowPool = [];
const sectorLabelPool = [];
const starLabelPool = [];
let bgStars = [];

// Soft radial texture reused for every glow (stars, probes, background dots).
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
  s.blendMode = 'add';           // v8: blend modes are strings
  return s;
}
function ensureSprites(layer, pool, n) {
  while (pool.length < n) { const s = makeGlowSprite(); pool.push(s); layer.addChild(s); }
  for (let i = n; i < pool.length; i++) pool[i].visible = false;
}
function ensureLabels(layer, pool, n, anchorX, anchorY) {
  while (pool.length < n) {
    // v8: options-object constructor. White fill so we can recolour via tint.
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
// Update a pooled label's text/colour ONLY when it changes — v8 Text re-rasterises
// on every .text / .style change, so we guard to keep per-frame cost near zero.
function setLabel(t, text, fill) {
  if (t._txt !== text) { t.text = text; t._txt = text; }
  if (t._fill !== fill) { t.style.fill = fill; t._fill = fill; }
}

// HSL (matches the old hsl() trail/probe colours) -> 0xRRGGBB for Pixi tint.
function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const to = (v) => Math.round(255 * v);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}

// Background starfield as soft additive sprites (rebuilt on resize).
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

// Camera = worldLayer transform (replaces the old ctx setWorldTransform()).
function applyCamera() {
  worldLayer.scale.set(cam.zoom);
  worldLayer.position.set(world.w / 2 - cam.x * cam.zoom, world.h / 2 - cam.y * cam.zoom);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  world.w = window.innerWidth;
  world.h = window.innerHeight;
  // Phones (small min-side) get proportionally smaller labels/strokes so the
  // map isn't dominated by text; desktop stays at full size.
  uiScale = clamp(Math.min(world.w, world.h) / 820, 0.62, 1);
  if (!rendererReady) return;    // renderer not built yet (pre-init)
  app.renderer.resize(world.w, world.h);
  buildBackground();
}
window.addEventListener('resize', resize);

// v8 async init: build renderer + scene graph, then start the render loop.
async function bootstrap() {
  await app.init({
    canvas,
    width: world.w,
    height: world.h,
    background: 0x05070d,
    antialias: true,
    resolution: dpr,
    autoDensity: true,
    autoStart: false,            // we render from our own rAF loop
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
  seekGfx = new PIXI.Graphics();
  worldLayer.addChild(
    sectorGfx, sectorLabelLayer, trailGfx,
    starGlowLayer, starGfx, starLabelLayer,
    probeGlowLayer, probeGfx, seekGfx,
  );

  rendererReady = true;
  resize();                      // size renderer + build background
  last = performance.now();
  requestAnimationFrame(frame);
}
bootstrap();

// ---------------------------------------------------------------------------
// Sectors — every `starsPerSector` stars form a sector with a unique name,
// laid out in a fixed grid so existing sectors never move as new ones appear.
// ---------------------------------------------------------------------------
const SECTOR_WORDS = [
  'Andromeda', 'Cygnus', 'Draco', 'Eridanus', 'Fornax', 'Hydra', 'Indus', 'Lyra',
  'Orion', 'Perseus', 'Phoenix', 'Serpens', 'Tucana', 'Vela', 'Carina', 'Pyxis',
];

function sectorCount() {
  return Math.max(1, Math.ceil(users.length / CONFIG.starsPerSector));
}
function sectorIndexForUser(i) {
  return Math.floor(i / CONFIG.starsPerSector);
}
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
// Bounding size of the whole occupied world (used for probe roaming + fit zoom).
function worldSize() {
  const n = sectorCount();
  const cols = Math.min(n, CONFIG.sectorCols);
  const rows = Math.ceil(n / CONFIG.sectorCols);
  return { w: cols * CONFIG.sectorSize, h: rows * CONFIG.sectorSize };
}

// ---------------------------------------------------------------------------
// Background stars — decorative, drawn in screen space with parallax.
// ---------------------------------------------------------------------------
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
// Background sprites are built by buildBackground() in the renderer setup.

// ---------------------------------------------------------------------------
// Users — persisted "local users". Position stored as a fraction (fx, fy)
// INSIDE the user's sector cell, so planets stay put as sectors are added.
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'space-map-users-v2';
try { localStorage.removeItem('space-map-users-v1'); } catch {} // clear old data
let userSeq = 0;
let users = loadUsers();

function loadUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((u) => {
      const loggedIn = u.loggedIn ?? false;
      return {
        id: userSeq++,
        name: u.name,
        fx: u.fx,
        fy: u.fy,
        r: u.r ?? CONFIG.userRadius,
        hits: u.hits ?? 0,
        createdAt: u.createdAt ?? Date.now(),
        loggedIn,
        pullForce: loggedIn ? 1 : 0,
        pulse: 0,
        tw: Math.random() * Math.PI * 2,
        x: 0, y: 0, sector: 0,
      };
    });
  } catch {
    return [];
  }
}

function saveUsers() {
  const data = users.map((u) => ({
    name: u.name, fx: u.fx, fy: u.fy, r: u.r, hits: u.hits, createdAt: u.createdAt, loggedIn: u.loggedIn,
  }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

// Cross-tab roster sync: when another tab changes the stored roster, merge the
// changes here WITHOUT resetting this tab's live simulation (r/hits/pulse are
// kept for users that still exist). The stored order is the source of truth, so
// rebuilding in that order keeps sector assignment identical across tabs.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) applyRoster(e.newValue);
});

function applyRoster(raw) {
  let data;
  try { data = raw ? JSON.parse(raw) : []; } catch { return; }

  const byName = new Map(users.map((u) => [u.name.toLowerCase(), u]));
  users = data.map((d) => {
    const existing = byName.get((d.name || '').toLowerCase());
    if (existing) {
      // Keep live sim state; only refresh roster fields.
      existing.fx = d.fx;
      existing.fy = d.fy;
      existing.loggedIn = d.loggedIn ?? false;
      existing.createdAt = d.createdAt ?? existing.createdAt;
      return existing;
    }
    const loggedIn = d.loggedIn ?? false;
    return {
      id: userSeq++,
      name: d.name,
      fx: d.fx,
      fy: d.fy,
      r: d.r ?? CONFIG.userRadius,
      hits: d.hits ?? 0,
      createdAt: d.createdAt ?? Date.now(),
      loggedIn,
      pullForce: loggedIn ? 1 : 0,
      pulse: 0,
      tw: Math.random() * Math.PI * 2,
      x: 0, y: 0, sector: 0,
    };
  });

  positionUsers();
  if (selectedUserId !== null && !users.some((u) => u.id === selectedUserId)) {
    selectedUserId = null;
    hideStarInfo();
  }
  refreshLoginUI();
}

// Place each user inside its sector cell (fraction -> world pixels).
function positionUsers() {
  const S = CONFIG.sectorSize;
  const pad = CONFIG.sectorPad;
  users.forEach((u, i) => {
    u.sector = sectorIndexForUser(i);
    const o = sectorOrigin(u.sector);
    u.x = o.x + pad + u.fx * (S - pad * 2);
    u.y = o.y + pad + u.fy * (S - pad * 2);
  });
}

// Find a spot inside a sector that keeps a minimum gap from existing stars.
// Tries several random candidates; if none clear the bar, returns the best
// (the one furthest from its nearest neighbour). Fraction is relative to the cell.
function placeStarFraction(sectorIndex) {
  const S = CONFIG.sectorSize;
  const pad = CONFIG.sectorPad;
  const o = sectorOrigin(sectorIndex);
  const wantCenterDist = 2 * CONFIG.userRadius + CONFIG.starMinGap;
  const others = users.filter((u) => u.sector === sectorIndex);

  let best = { fx: Math.random(), fy: Math.random() };
  let bestNearest = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const fx = Math.random();
    const fy = Math.random();
    const x = o.x + pad + fx * (S - pad * 2);
    const y = o.y + pad + fy * (S - pad * 2);
    let nearest = Infinity;
    for (const u of others) {
      const d = Math.hypot(u.x - x, u.y - y);
      if (d < nearest) nearest = d;
    }
    if (nearest >= wantCenterDist) return { fx, fy };
    if (nearest > bestNearest) { bestNearest = nearest; best = { fx, fy }; }
  }
  return best;
}

// The largest radius a star may grow to without overlapping any neighbour
// (accounting for the neighbour's current radius plus the required gap).
function allowedRadius(u) {
  let cap = CONFIG.maxUserRadius;
  for (const o of users) {
    if (o === u) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    cap = Math.min(cap, d - o.r - CONFIG.starMinGap);
  }
  return cap;
}

function addUser(name) {
  const sector = Math.floor(users.length / CONFIG.starsPerSector);
  const spot = placeStarFraction(sector);
  const u = {
    id: userSeq++,
    name: name.trim().slice(0, 16) || `User${users.length + 1}`,
    fx: spot.fx,
    fy: spot.fy,
    r: CONFIG.userRadius,
    hits: 0,
    createdAt: Date.now(),
    loggedIn: true,
    pullForce: 0,
    pulse: 0,
    tw: Math.random() * Math.PI * 2,
    x: 0, y: 0, sector: 0,
  };
  users.push(u);
  positionUsers();
  saveUsers();
  return u;
}

function loginUser(name) {
  const key = name.trim().toLowerCase();
  const existing = key && users.find((u) => u.name.toLowerCase() === key);
  if (existing) { existing.loggedIn = true; saveUsers(); return existing; }
  return addUser(name);
}

function setLoggedIn(u, value) { u.loggedIn = value; saveUsers(); }

positionUsers();

// ---------------------------------------------------------------------------
// Camera — world-space view with smooth easing toward a target.
// ---------------------------------------------------------------------------
const cam = { x: 0, y: 0, zoom: 1 };
const camTarget = { x: 0, y: 0, zoom: 1 };

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
// Probes — roaming dots. Spawn within the occupied world bounds.
// ---------------------------------------------------------------------------
let probeSeq = 0;
const probes = [];

function spawnProbe() {
  if (probes.length >= CONFIG.maxProbes) return;
  const b = worldSize();
  const m = CONFIG.edgeMargin;
  const angle = Math.random() * Math.PI * 2;
  probes.push({
    id: probeSeq++,
    x: m + Math.random() * Math.max(1, b.w - m * 2),
    y: m + Math.random() * Math.max(1, b.h - m * 2),
    vx: Math.cos(angle) * CONFIG.maxSpeed * 0.6,
    vy: Math.sin(angle) * CONFIG.maxSpeed * 0.6,
    wanderAngle: angle,
    hue: 180 + Math.random() * 80,
    trail: [],   // recent world positions for the neon trail
  });
}

let spawnTimer = CONFIG.spawnInterval;
let collisionCount = 0;
spawnProbe(); // the map is always alive

let seekTarget = null;       // world-space tap target
let selectedUserId = null;

// ---------------------------------------------------------------------------
// Pointer: drag to pan, wheel to zoom, click to select a star / set a seek.
// ---------------------------------------------------------------------------
const pointer = { down: false, dragging: false, sx: 0, sy: 0, camX: 0, camY: 0 };

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer.down = true;
  pointer.dragging = false;
  pointer.sx = e.clientX - rect.left;
  pointer.sy = e.clientY - rect.top;
  pointer.camX = camTarget.x;
  pointer.camY = camTarget.y;
});

window.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const dx = sx - pointer.sx;
  const dy = sy - pointer.sy;
  if (!pointer.dragging && Math.hypot(dx, dy) > 5) pointer.dragging = true;
  if (pointer.dragging) {
    cam.x = camTarget.x = pointer.camX - dx / cam.zoom;
    cam.y = camTarget.y = pointer.camY - dy / cam.zoom;
  }
});

window.addEventListener('pointerup', (e) => {
  if (!pointer.down) return;
  pointer.down = false;
  if (pointer.dragging) { pointer.dragging = false; return; }

  const rect = canvas.getBoundingClientRect();
  const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
  const hit = userAt(w.x, w.y);
  if (hit) {
    selectedUserId = hit.id;
    showStarInfo();
  } else {
    selectedUserId = null;
    hideStarInfo();
    seekTarget = { x: w.x, y: w.y, life: 2.5 };
  }
});

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

// Star under a world point (generous tap radius, constant in screen px).
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
function getUserById(id) { return users.find((u) => u.id === id) || null; }

// ---------------------------------------------------------------------------
// update(dt) — the tick
// ---------------------------------------------------------------------------
function update(dt) {
  // Ease camera toward its target.
  const zmin = minZoom();
  camTarget.zoom = clamp(camTarget.zoom, zmin, CONFIG.zoomMax);
  const k = Math.min(1, dt * 8);
  cam.x += (camTarget.x - cam.x) * k;
  cam.y += (camTarget.y - cam.y) * k;
  cam.zoom += (camTarget.zoom - cam.zoom) * k;

  // Spawn probes over time.
  spawnTimer -= dt;
  if (spawnTimer <= 0) { spawnProbe(); spawnTimer += CONFIG.spawnInterval; }

  if (seekTarget) {
    seekTarget.life -= dt;
    if (seekTarget.life <= 0) seekTarget = null;
  }

  // Ease pullForce toward login target; fade pulses.
  const ease = Math.min(1, dt * CONFIG.pullFade);
  for (const u of users) {
    const target = u.loggedIn ? 1 : 0;
    u.pullForce += (target - u.pullForce) * ease;
    if (u.pulse > 0) u.pulse = Math.max(0, u.pulse - dt * 2.2);
  }

  const b = worldSize();
  for (const p of probes) {
    let ax = 0, ay = 0;

    p.wanderAngle += (Math.random() - 0.5) * CONFIG.wanderStrength * dt * 2;
    ax += Math.cos(p.wanderAngle) * CONFIG.maxSpeed;
    ay += Math.sin(p.wanderAngle) * CONFIG.maxSpeed;

    if (p.x < CONFIG.edgeMargin) ax += CONFIG.edgeForce * (1 - p.x / CONFIG.edgeMargin);
    if (p.x > b.w - CONFIG.edgeMargin) ax -= CONFIG.edgeForce * (1 - (b.w - p.x) / CONFIG.edgeMargin);
    if (p.y < CONFIG.edgeMargin) ay += CONFIG.edgeForce * (1 - p.y / CONFIG.edgeMargin);
    if (p.y > b.h - CONFIG.edgeMargin) ay -= CONFIG.edgeForce * (1 - (b.h - p.y) / CONFIG.edgeMargin);

    if (CONFIG.userAttraction > 0) {
      const near = nearestActiveUser(p.x, p.y);
      if (near) {
        const dx = near.x - p.x, dy = near.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = CONFIG.userAttraction * near.pullForce;
        ax += (dx / d) * force;
        ay += (dy / d) * force;
      }
    }

    if (seekTarget) {
      const dx = seekTarget.x - p.x, dy = seekTarget.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      ax += (dx / d) * CONFIG.seekForce;
      ay += (dy / d) * CONFIG.seekForce;
    }

    p.vx += ax * dt;
    p.vy += ay * dt;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > CONFIG.maxSpeed) {
      p.vx = (p.vx / speed) * CONFIG.maxSpeed;
      p.vy = (p.vy / speed) * CONFIG.maxSpeed;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > CONFIG.trailLength) p.trail.shift();
  }

  detectCollisions();
}

function nearestActiveUser(x, y) {
  let best = null, bestD = Infinity;
  for (const u of users) {
    if (u.pullForce <= PULL_MIN) continue;
    const d = (u.x - x) ** 2 + (u.y - y) ** 2;
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}

function detectCollisions() {
  for (let i = probes.length - 1; i >= 0; i--) {
    const p = probes[i];
    for (const u of users) {
      if (u.pullForce <= PULL_MIN) continue; // logged-out star: inert
      const rr = CONFIG.probeRadius + u.r;
      if ((p.x - u.x) ** 2 + (p.y - u.y) ** 2 <= rr * rr) {
        u.hits++;
        u.pulse = 1;
        // Grow, but never past what would overlap a neighbour.
        const newR = Math.min(u.r + CONFIG.userGrowth, allowedRadius(u));
        if (newR > u.r) u.r = newR;
        collisionCount++;
        probes.splice(i, 1);
        // NOTE: growth/hits are session-only (not persisted). Each tab runs its
        // own sim; only the roster (below) is shared across tabs.
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// render() — sync the Pixi scene graph from current sim state, then draw.
// ---------------------------------------------------------------------------
function render(time) {
  const z = cam.zoom;
  applyCamera();

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
    sectorGfx.rect(o.x, o.y, S, S).stroke(sectorStroke);   // v8: shape-then-stroke
    const lbl = sectorLabelPool[i];
    if (showSectorLabel) {
      lbl.visible = true;
      setLabel(lbl, `SECTOR · ${sectorName(i).toUpperCase()}`, 0x96cdeb);
      lbl.alpha = 0.55;
      lbl.scale.set(sectorFontPx / (16 * z));         // constant screen size
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
      const t = i / (pts.length - 1);       // 0 tail -> 1 head
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
    gs.width = gs.height = R * 6;              // glow radius ~ R*3
    gs.tint = hsl2hex(p.hue, 100, 66);
    gs.alpha = 0.6;
    probeGfx.circle(p.x, p.y, R).fill(hsl2hex(p.hue, 100, 68));
    probeGfx.circle(p.x, p.y, R * 0.45).fill(0xf4fbff);
  });

  // --- Seek target ring ---
  seekGfx.clear();
  if (seekTarget) {
    seekGfx.circle(seekTarget.x, seekTarget.y, 10 / z)
      .stroke({ width: 1.5 / z, color: 0x9fe7ff, alpha: 0.5 });
  }

  app.render();
}

// 4-point star body drawn into the shared starGfx (v8: build points -> poly -> fill).
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
  users: document.getElementById('hud-users'),
  sectors: document.getElementById('hud-sectors'),
  collisions: document.getElementById('hud-collisions'),
  fps: document.getElementById('hud-fps'),
};
let hudTimer = 0;
function updateHud(dt, fps) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.15;
  const online = users.reduce((a, u) => a + (u.loggedIn ? 1 : 0), 0);
  hud.probes.textContent = `${probes.length} / ${CONFIG.maxProbes}`;
  hud.users.textContent = `${online} / ${users.length} online`;
  hud.sectors.textContent = String(sectorCount());
  hud.collisions.textContent = String(collisionCount);
  hud.fps.textContent = fps.toFixed(0);
  updateStarInfo();
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
// Login page
// ---------------------------------------------------------------------------
const login = {
  panel: document.getElementById('login'),
  nickname: document.getElementById('nickname'),
  join: document.getElementById('join-btn'),
  enter: document.getElementById('enter-btn'),
  list: document.getElementById('user-list'),
  reset: document.getElementById('reset-users'),
  close: document.getElementById('login-close'),
  addBtn: document.getElementById('add-user'),
};

function showLogin() {
  login.panel.classList.remove('hidden');
  refreshLoginUI();
  setTimeout(() => login.nickname.focus(), 50);
}
function hideLogin() { login.panel.classList.add('hidden'); }

function refreshLoginUI() {
  login.list.innerHTML = '';
  for (const u of users) {
    const chip = document.createElement('span');
    chip.className = 'user-chip' + (u.loggedIn ? ' online' : '');
    chip.textContent = u.name;
    chip.title = u.loggedIn ? 'Logged in — click to log out' : 'Logged out — click to log in';
    chip.addEventListener('click', () => { setLoggedIn(u, !u.loggedIn); refreshLoginUI(); updateStarInfo(); });
    login.list.appendChild(chip);
  }
  login.enter.style.display = users.length ? 'inline-block' : 'none';
  login.close.style.display = 'flex';
  login.addBtn.style.display = 'flex';
}

function doJoin() {
  loginUser(login.nickname.value);
  login.nickname.value = '';
  hideLogin();
  refreshLoginUI();
  fitView(); // open the map at the fit-all view
}

login.join.addEventListener('click', doJoin);
login.nickname.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
login.enter.addEventListener('click', () => { hideLogin(); refreshLoginUI(); fitView(); });
login.close.addEventListener('click', hideLogin);
login.addBtn.addEventListener('click', showLogin);
login.reset.addEventListener('click', (e) => {
  e.preventDefault();
  users.length = 0;
  saveUsers();
  positionUsers();
  selectedUserId = null;
  hideStarInfo();
  fitView();
  refreshLoginUI();
});

showLogin();

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
  close: document.getElementById('si-close'),
};
starInfo.close.addEventListener('click', () => { selectedUserId = null; hideStarInfo(); });
starInfo.toggle.addEventListener('click', () => {
  const u = getUserById(selectedUserId);
  if (!u) return;
  setLoggedIn(u, !u.loggedIn);
  refreshLoginUI();
  updateStarInfo();
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
  starInfo.status.textContent = u.loggedIn ? 'online' : 'offline';
  starInfo.status.className = u.loggedIn ? 'si-online' : 'si-offline';
  starInfo.pull.textContent = `${Math.round(u.pullForce * 100)}%`;
  starInfo.age.textContent = formatDuration(Date.now() - u.createdAt);
  starInfo.absorbed.textContent = String(u.hits);
  starInfo.size.textContent = `${u.r.toFixed(1)} px`;
  starInfo.growth.textContent = `+${(u.r - CONFIG.userRadius).toFixed(1)} px`;
  starInfo.pos.textContent = `${u.x.toFixed(0)}, ${u.y.toFixed(0)}`;
  starInfo.born.textContent = new Date(u.createdAt).toLocaleTimeString();
  starInfo.toggle.textContent = u.loggedIn ? 'Log out' : 'Log in';
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);

  update(dt);
  render(now);
  updateHud(dt, dt > 0 ? 1 / dt : 0);

  requestAnimationFrame(frame);
}
// The render loop is started by bootstrap() once app.init() resolves (v8 is async).
