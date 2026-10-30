'use strict';

// Fallbacks for anything the chart's `game:` values leave out.
const DEFAULTS = {
  title: 'Asteroid Run',
  tagline: '',
  colors: { ship: '#4cc9f0', bullet: '#ffffff', rock: '#8d99ae', accent: '#4cc9f0', background: '#0b1021' },
  rocks: { max: 6, speed: 1, spawnSeconds: 1.6 },
  ship: { lives: 3, shots: 1, fireDelayMs: 220 },
};

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

let cfg = DEFAULTS;
let info = { version: 'dev', image: '', pod: '', database: false };
let W = 0;
let H = 0;
let stars = [];

const state = {
  mode: 'menu', score: 0, lives: 0, time: 0, spawnIn: 0, fireIn: 0, shake: 0,
  ship: null, bullets: [], rocks: [], particles: [], pickups: [], floaters: [],
};

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const nested = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object';
    out[k] = nested ? merge(base[k], v) : v;
  }
  return out;
}

function num(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitize(c) {
  c.rocks.max = Math.round(num(c.rocks.max, 6, 1, 40));
  c.rocks.speed = num(c.rocks.speed, 1, 0.2, 4);
  c.rocks.spawnSeconds = num(c.rocks.spawnSeconds, 1.6, 0.2, 10);
  c.ship.lives = Math.round(num(c.ship.lives, 3, 1, 9));
  c.ship.shots = Math.round(num(c.ship.shots, 1, 1, 7));
  c.ship.fireDelayMs = num(c.ship.fireDelayMs, 220, 60, 2000);
  return c;
}

// ---------- setup ----------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stars = Array.from({ length: Math.round((W * H) / 5000) }, () => ({
    x: Math.random() * W, y: Math.random() * H, z: 0.2 + Math.random() * 0.8,
  }));
}

const keys = new Set();
const mouse = { x: 0, y: 0, down: false, seen: false };

addEventListener('resize', resize);
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'Enter' && state.mode !== 'play') start();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.seen = true;
});
canvas.addEventListener('mousedown', (e) => { if (e.button === 0) mouse.down = true; });
addEventListener('mouseup', () => { mouse.down = false; });
addEventListener('blur', () => { keys.clear(); mouse.down = false; });

$('launch').addEventListener('click', start);
$('again').addEventListener('click', start);
$('over-panel').addEventListener('submit', saveScore);

// ---------- game flow ----------

function start() {
  Object.assign(state, {
    mode: 'play', score: 0, lives: cfg.ship.lives, time: 0, spawnIn: 0.5, fireIn: 0, shake: 0,
    ship: { x: W / 2, y: H / 2, vx: 0, vy: 0, angle: -Math.PI / 2, r: 14, invuln: 2, shield: 0, thrust: false },
    bullets: [], rocks: [], particles: [], pickups: [], floaters: [],
  });
  keys.clear();
  showPanel(null);
  updateHud();
}

function gameOver() {
  state.mode = 'over';
  $('final-score').textContent = state.score;
  $('save-status').textContent = info.database ? '' : 'postgres is not reachable, the score cannot be saved';
  $('submit').disabled = !info.database;
  $('name').value = loadName();
  showPanel('over-panel');
  setTimeout(() => $('name').focus(), 300);
}

function showPanel(id) {
  $('overlay').classList.toggle('hidden', id === null);
  $('start-panel').classList.toggle('hidden', id !== 'start-panel');
  $('over-panel').classList.toggle('hidden', id !== 'over-panel');
}

const difficulty = () => Math.min(2.5, 1 + state.time / 60);

// ---------- update ----------

function update(dt) {
  for (const s of stars) {
    s.y += s.z * 18 * dt;
    if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
  }
  updateParticles(dt);
  if (state.mode !== 'play') return;

  state.time += dt;
  state.shake = Math.max(0, state.shake - dt);
  updateShip(dt);
  fire(dt);
  spawn(dt);
  moveAll(dt);
  collide();
}

function updateShip(dt) {
  const s = state.ship;
  const ACCEL = 1500;
  const DRAG = 3;
  const MAX_SPEED = 430;

  let ax = 0;
  let ay = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) ay -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) ay += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ax -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ax += 1;
  const len = Math.hypot(ax, ay);
  s.thrust = len > 0;
  if (s.thrust) {
    s.vx += (ax / len) * ACCEL * dt;
    s.vy += (ay / len) * ACCEL * dt;
  }
  s.vx -= s.vx * DRAG * dt;
  s.vy -= s.vy * DRAG * dt;
  const speed = Math.hypot(s.vx, s.vy);
  if (speed > MAX_SPEED) {
    s.vx *= MAX_SPEED / speed;
    s.vy *= MAX_SPEED / speed;
  }
  s.x = Math.min(W - s.r, Math.max(s.r, s.x + s.vx * dt));
  s.y = Math.min(H - s.r, Math.max(s.r, s.y + s.vy * dt));

  if (mouse.seen) s.angle = Math.atan2(mouse.y - s.y, mouse.x - s.x);
  else if (s.thrust) s.angle = Math.atan2(s.vy, s.vx);

  s.invuln = Math.max(0, s.invuln - dt);
  s.shield = Math.max(0, s.shield - dt);
}

function fire(dt) {
  const s = state.ship;
  state.fireIn -= dt;
  if (!(keys.has('Space') || mouse.down) || state.fireIn > 0) return;

  const n = cfg.ship.shots;
  for (let i = 0; i < n; i++) {
    const a = s.angle + (i - (n - 1) / 2) * 0.14;
    state.bullets.push({
      x: s.x + Math.cos(a) * 18,
      y: s.y + Math.sin(a) * 18,
      vx: Math.cos(a) * 740 + s.vx * 0.3,
      vy: Math.sin(a) * 740 + s.vy * 0.3,
      life: 1.1,
    });
  }
  state.fireIn = cfg.ship.fireDelayMs / 1000;
}

function spawn(dt) {
  state.spawnIn -= dt;
  if (state.spawnIn > 0) return;
  state.spawnIn = cfg.rocks.spawnSeconds / difficulty();
  if (state.rocks.length >= Math.round(cfg.rocks.max * difficulty())) return;

  const r = 18 + Math.random() * 34;
  let x;
  let y;
  switch (Math.floor(Math.random() * 4)) {
    case 0: x = Math.random() * W; y = -r; break;
    case 1: x = W + r; y = Math.random() * H; break;
    case 2: x = Math.random() * W; y = H + r; break;
    default: x = -r; y = Math.random() * H;
  }
  // Aim roughly at the middle third so rocks cross the play area instead of grazing an edge.
  const a = Math.atan2(H * (0.33 + Math.random() * 0.34) - y, W * (0.33 + Math.random() * 0.34) - x);
  const speed = (55 + Math.random() * 70) * cfg.rocks.speed * Math.sqrt(difficulty());
  const verts = 9 + Math.floor(Math.random() * 4);
  const shape = Array.from({ length: verts }, (_, i) => {
    const t = (i / verts) * Math.PI * 2;
    const k = 0.72 + Math.random() * 0.36;
    return [Math.cos(t) * r * k, Math.sin(t) * r * k];
  });
  const hp = Math.ceil(r / 14);
  state.rocks.push({
    x, y, r, hp, maxHp: hp, shape, flash: 0, entered: false,
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
    rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 1.6,
  });
}

function moveAll(dt) {
  for (const b of state.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }
  state.bullets = state.bullets.filter((b) => b.life > 0 && b.x > -20 && b.x < W + 20 && b.y > -20 && b.y < H + 20);

  for (const r of state.rocks) {
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.rot += r.spin * dt;
    r.flash = Math.max(0, r.flash - dt);
    if (r.x > r.r && r.x < W - r.r && r.y > r.r && r.y < H - r.r) r.entered = true;
  }
  const M = 140;
  state.rocks = state.rocks.filter((r) => !r.entered || (r.x > -M && r.x < W + M && r.y > -M && r.y < H + M));

  for (const p of state.pickups) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  state.pickups = state.pickups.filter((p) => p.life > 0);
}

function collide() {
  const s = state.ship;

  for (const b of state.bullets) {
    for (const r of state.rocks) {
      if (r.hp <= 0 || Math.hypot(b.x - r.x, b.y - r.y) > r.r) continue;
      b.life = 0;
      r.hp -= 1;
      r.flash = 0.08;
      burst(b.x, b.y, cfg.colors.rock, 4, 120);
      if (r.hp <= 0) destroyRock(r);
      break;
    }
  }

  for (const r of state.rocks) {
    if (r.hp <= 0 || Math.hypot(s.x - r.x, s.y - r.y) > r.r + s.r * 0.8) continue;
    if (s.shield > 0) {
      destroyRock(r);
    } else if (s.invuln <= 0) {
      destroyRock(r, false);
      state.lives -= 1;
      state.shake = 0.4;
      s.invuln = 2;
      burst(s.x, s.y, cfg.colors.ship, 40, 260);
      if (state.lives <= 0) {
        updateHud();
        gameOver();
        return;
      }
    }
  }
  state.rocks = state.rocks.filter((r) => r.hp > 0);

  for (const p of state.pickups) {
    if (Math.hypot(s.x - p.x, s.y - p.y) > 24) continue;
    p.life = 0;
    state.score += 100;
    if (p.kind === 'life' && state.lives < cfg.ship.lives + 2) {
      state.lives += 1;
      floater(p.x, p.y, 'signed ✓ +1 life');
    } else {
      s.shield = 5;
      floater(p.x, p.y, 'signed ✓ shield');
    }
  }

  updateHud();
}

function destroyRock(r, scored = true) {
  r.hp = 0;
  burst(r.x, r.y, cfg.colors.rock, 10 + r.maxHp * 6, 200);
  if (!scored) return;
  state.score += 25 * r.maxHp;
  if (Math.random() < 0.12) {
    state.pickups.push({
      x: r.x, y: r.y, vx: r.vx * 0.3, vy: r.vy * 0.3, life: 8,
      kind: Math.random() < 0.4 ? 'life' : 'shield',
    });
  }
}

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random());
    const life = 0.35 + Math.random() * 0.6;
    state.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 1 + Math.random() * 2.5 });
  }
}

function floater(x, y, text) {
  state.floaters.push({ x, y, text, life: 1.4 });
}

function updateParticles(dt) {
  for (const p of state.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 2 * dt;
    p.vy *= 1 - 2 * dt;
    p.life -= dt;
  }
  state.particles = state.particles.filter((p) => p.life > 0);
  for (const f of state.floaters) {
    f.y -= 40 * dt;
    f.life -= dt;
  }
  state.floaters = state.floaters.filter((f) => f.life > 0);
}

// ---------- render ----------

function draw() {
  ctx.fillStyle = cfg.colors.background;
  ctx.fillRect(0, 0, W, H);

  for (const s of stars) {
    ctx.globalAlpha = 0.25 + s.z * 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(s.x, s.y, s.z * 2, s.z * 2);
  }
  ctx.globalAlpha = 1;

  ctx.save();
  if (state.shake > 0) {
    const k = state.shake * 14;
    ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
  }

  for (const p of state.pickups) drawPickup(p);
  for (const r of state.rocks) drawRock(r);

  ctx.fillStyle = cfg.colors.bullet;
  for (const b of state.bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state.mode === 'play') drawShip(state.ship);

  for (const p of state.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  ctx.font = 'bold 14px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  for (const f of state.floaters) {
    ctx.globalAlpha = Math.min(1, f.life);
    ctx.fillStyle = cfg.colors.accent;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawShip(s) {
  if (s.shield > 0) {
    ctx.strokeStyle = cfg.colors.accent;
    ctx.globalAlpha = s.shield < 1.5 ? 0.3 + 0.3 * Math.sin(s.shield * 20) : 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (s.invuln > 0 && Math.floor(s.invuln * 10) % 2 === 0) return;

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  if (s.thrust) {
    ctx.fillStyle = cfg.colors.accent;
    ctx.beginPath();
    ctx.moveTo(-8, -5);
    ctx.lineTo(-16 - Math.random() * 10, 0);
    ctx.lineTo(-8, 5);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(-12, 11);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, -11);
  ctx.closePath();
  ctx.fillStyle = cfg.colors.ship;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawRock(r) {
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.rotate(r.rot);
  ctx.beginPath();
  r.shape.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.globalAlpha = r.flash > 0 ? 0.9 : 0.18 + 0.12 * (r.hp / r.maxHp);
  ctx.fillStyle = r.flash > 0 ? '#ffffff' : cfg.colors.rock;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cfg.colors.rock;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawPickup(p) {
  if (p.life < 2 && Math.floor(p.life * 8) % 2 === 0) return;
  const pulse = 1 + Math.sin(performance.now() / 150) * 0.1;
  const half = 11 * pulse;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.strokeStyle = cfg.colors.accent;
  ctx.fillStyle = cfg.colors.background;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-half, -half, half * 2, half * 2, 4);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-5, 0);
  ctx.lineTo(-1, 5);
  ctx.lineTo(6, -5);
  ctx.stroke();
  ctx.restore();
}

// ---------- DOM ----------

let shownScore = -1;
let shownLives = -1;

function updateHud() {
  if (state.score !== shownScore) {
    shownScore = state.score;
    $('score').textContent = state.score.toLocaleString('en-US');
  }
  if (state.lives !== shownLives) {
    shownLives = state.lives;
    $('lives').textContent = '▲'.repeat(Math.max(0, state.lives));
  }
}

function applyConfig() {
  const root = document.documentElement.style;
  root.setProperty('--accent', cfg.colors.accent);
  root.setProperty('--ship', cfg.colors.ship);
  root.setProperty('--bg', cfg.colors.background);
  document.title = cfg.title;
  $('title').textContent = cfg.title;
  $('start-title').textContent = cfg.title;
  $('tagline').textContent = cfg.tagline;
  $('version').textContent = `v${info.version}`;
  const shots = cfg.ship.shots === 1 ? 'single shot' : `${cfg.ship.shots}-way shot`;
  $('loadout').textContent = `${shots} · up to ${cfg.rocks.max} rocks · speed ×${cfg.rocks.speed}`;
}

function renderFooter() {
  const parts = [];
  const add = (label, value, cls) => {
    const b = document.createElement('b');
    b.textContent = value;
    if (cls) b.className = cls;
    parts.push(document.createTextNode(parts.length ? `   ${label} ` : `${label} `), b);
  };
  add('pod', info.pod || 'local');
  add('image', shortImage(info.image) || 'unknown');
  add('postgres', info.database ? 'connected' : 'unavailable', info.database ? 'ok' : 'bad');
  $('footer').replaceChildren(...parts);
}

function shortImage(ref) {
  return (ref || '').replace(/@sha256:([0-9a-f]{12})[0-9a-f]+/, '@sha256:$1…');
}

function setDatabase(ok, reason) {
  info.database = ok;
  $('db-status').textContent = ok ? 'stored in postgres' : `postgres unavailable: ${reason}`;
  if (state.mode === 'over' && $('save-status').textContent === '') $('submit').disabled = !ok;
  renderFooter();
}

async function refreshScores() {
  try {
    const res = await fetch('/api/scores');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const scores = await res.json();
    const items = scores.map((s) => {
      const li = document.createElement('li');
      for (const [cls, text] of [['who', s.name], ['ver', `v${s.version}`], ['pts', s.score.toLocaleString('en-US')]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        li.append(span);
      }
      return li;
    });
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty hint';
      li.textContent = 'no scores yet, go set one';
      items.push(li);
    }
    $('scores').replaceChildren(...items);
    setDatabase(true);
  } catch (err) {
    setDatabase(false, err.message);
  }
}

async function saveScore(e) {
  e.preventDefault();
  const name = $('name').value.trim();
  if (!name) return;
  storeName(name);
  $('submit').disabled = true;
  $('save-status').textContent = 'saving...';
  try {
    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score: state.score }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    $('save-status').textContent = 'saved to postgres ✓  press Enter to fly again';
    $('name').blur();
    refreshScores();
  } catch (err) {
    $('save-status').textContent = `could not save: ${err.message}`;
    $('submit').disabled = false;
  }
}

function loadName() {
  try { return localStorage.getItem('pilot') || ''; } catch { return ''; }
}

function storeName(name) {
  try { localStorage.setItem('pilot', name); } catch { /* private mode */ }
}

async function init() {
  try {
    const res = await fetch('/api/info');
    if (res.ok) {
      info = await res.json();
      cfg = sanitize(merge(structuredClone(DEFAULTS), info.config));
    }
  } catch { /* serve with defaults */ }
  applyConfig();
  renderFooter();
  refreshScores();
  setInterval(refreshScores, 10000);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

resize();
cfg = sanitize(structuredClone(DEFAULTS));
init();
requestAnimationFrame(frame);
