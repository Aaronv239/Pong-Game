const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────────────────────
const W            = 800;
const H            = 500;
const PADDLE_W     = 10;
const BASE_H       = 90;
const LEFT_X       = 30;
const RIGHT_X      = W - 30 - PADDLE_W;
const BALL_R       = 6;
const PADDLE_SPEED = 5.5;
const WINNING_SCORE = 7;
const TICK_MS      = 1000 / 60;   // 60 Hz physics
const SPAWN_MS     = 7000;

const PU_DEFS = [
  { id: 'speed',  icon: '⚡', color: '#ffdd00', glow: '#ff8800', dur: 5000 },
  { id: 'slow',   icon: '❄',  color: '#44ddff', glow: '#0066ff', dur: 6000 },
  { id: 'grow',   icon: '▲',  color: '#00ff88', glow: '#00cc44', dur: 7000 },
  { id: 'shrink', icon: '▼',  color: '#ff4455', glow: '#cc0022', dur: 5000 },
  { id: 'laser',  icon: '✦',  color: '#dd44ff', glow: '#8800ff', dur: 6000 },
];

// ── Game state ────────────────────────────────────────────────────────────────
let game    = createGame();
let players = {};   // socketId → { side: 'left'|'right', input: { up, down } }
let lastTick = Date.now();

function createGame() {
  return {
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, hue: 0, fx: {} },
    paddles: {
      left:  { y: H / 2 - BASE_H / 2, h: BASE_H, score: 0, fx: {}, hitFlash: 0 },
      right: { y: H / 2 - BASE_H / 2, h: BASE_H, score: 0, fx: {}, hitFlash: 0 },
    },
    powerups:   [],
    phase:      'waiting',   // 'waiting' | 'playing' | 'gameover'
    winner:     null,
    lastSide:   'left',
    spawnTimer: SPAWN_MS * 0.55,
  };
}

function resetBall(toLeft) {
  const angle = (Math.random() * 40 - 20) * Math.PI / 180;
  const s = 5;
  game.ball = {
    x: W / 2, y: H / 2,
    vx: (toLeft ? -1 : 1) * s * Math.cos(angle),
    vy: s * Math.sin(angle),
    hue: game.ball.hue,
    fx: {},
  };
}

function playerCount() { return Object.keys(players).length; }

// ── Physics tick ──────────────────────────────────────────────────────────────
function hitsLeft() {
  const p = game.paddles.left;
  return (
    game.ball.x - BALL_R < LEFT_X + PADDLE_W &&
    game.ball.x + BALL_R > LEFT_X &&
    game.ball.y + BALL_R > p.y &&
    game.ball.y - BALL_R < p.y + p.h
  );
}
function hitsRight() {
  const p = game.paddles.right;
  return (
    game.ball.x - BALL_R < RIGHT_X + PADDLE_W &&
    game.ball.x + BALL_R > RIGHT_X &&
    game.ball.y + BALL_R > p.y &&
    game.ball.y - BALL_R < p.y + p.h
  );
}

function applyPowerup(pu, now) {
  const atk = game.lastSide === 'left' ? game.paddles.left  : game.paddles.right;
  const def = game.lastSide === 'left' ? game.paddles.right : game.paddles.left;
  switch (pu.id) {
    case 'speed':  game.ball.fx.speed = now + pu.dur; break;
    case 'slow':   game.ball.fx.slow  = now + pu.dur; break;
    case 'grow':   atk.fx.grow        = now + pu.dur; break;
    case 'shrink': def.fx.shrink      = now + pu.dur; break;
    case 'laser':  game.ball.fx.laser = now + pu.dur; break;
  }
}

// Convert absolute expiry timestamps → remaining ms (safe to send to client)
function fxRemain(fx, now) {
  const r = {};
  for (const [k, v] of Object.entries(fx)) {
    const rem = v - now;
    if (rem > 0) r[k] = rem;
  }
  return r;
}

function tick() {
  if (game.phase !== 'playing') return;

  const now = Date.now();
  const dt  = Math.min(now - lastTick, 50);
  lastTick  = now;

  const events = [];

  // Expire effects
  for (const k of Object.keys(game.ball.fx)) if (game.ball.fx[k] < now) delete game.ball.fx[k];
  for (const side of ['left', 'right']) {
    const p = game.paddles[side];
    for (const k of Object.keys(p.fx)) if (p.fx[k] < now) delete p.fx[k];
    p.h = p.fx.grow ? BASE_H * 1.75 : p.fx.shrink ? BASE_H * 0.45 : BASE_H;
    if (p.hitFlash > 0) p.hitFlash--;
  }

  // Move paddles from player inputs
  for (const { side, input } of Object.values(players)) {
    const p = game.paddles[side];
    if (input.up)   p.y -= PADDLE_SPEED;
    if (input.down) p.y += PADDLE_SPEED;
    p.y = Math.max(0, Math.min(H - p.h, p.y));
  }

  // Spawn / expire power-ups
  game.spawnTimer += dt;
  if (game.spawnTimer >= SPAWN_MS && game.powerups.length < 3) {
    const def = PU_DEFS[Math.floor(Math.random() * PU_DEFS.length)];
    game.powerups.push({
      ...def,
      uid:  Math.random().toString(36).slice(2),
      x:    W / 2 + (Math.random() - 0.5) * 320,
      y:    60 + Math.random() * (H - 120),
      r:    21, age: 0, life: 9000,
    });
    game.spawnTimer = 0;
  }
  for (const pu of game.powerups) pu.age += dt;
  game.powerups = game.powerups.filter(pu => pu.age < pu.life);

  // Move ball
  const mult = game.ball.fx.speed ? 1.65 : game.ball.fx.slow ? 0.5 : 1;
  game.ball.x   += game.ball.vx * mult;
  game.ball.y   += game.ball.vy * mult;
  game.ball.hue  = (game.ball.hue + 2.5) % 360;

  // Wall bounces
  if (game.ball.y - BALL_R <= 0) {
    game.ball.y  = BALL_R;
    game.ball.vy = Math.abs(game.ball.vy);
    events.push({ type: 'wallBounce', x: game.ball.x, y: 0, hue: game.ball.hue });
  }
  if (game.ball.y + BALL_R >= H) {
    game.ball.y  = H - BALL_R;
    game.ball.vy = -Math.abs(game.ball.vy);
    events.push({ type: 'wallBounce', x: game.ball.x, y: H, hue: game.ball.hue });
  }

  // Paddle bounces
  if (game.ball.vx < 0 && hitsLeft()) {
    game.ball.x = LEFT_X + PADDLE_W + BALL_R;
    const t = (game.ball.y - (game.paddles.left.y + game.paddles.left.h / 2)) / (game.paddles.left.h / 2);
    const a = t * 60 * Math.PI / 180;
    const s = Math.min(Math.hypot(game.ball.vx, game.ball.vy) * 1.05, 16);
    game.ball.vx =  s * Math.cos(a);
    game.ball.vy =  s * Math.sin(a);
    game.lastSide = 'left';
    game.paddles.left.hitFlash = 12;
    events.push({ type: 'paddleHit', side: 'left', x: game.ball.x, y: game.ball.y });
  }
  if (game.ball.vx > 0 && hitsRight()) {
    game.ball.x = RIGHT_X - BALL_R;
    const t = (game.ball.y - (game.paddles.right.y + game.paddles.right.h / 2)) / (game.paddles.right.h / 2);
    const a = t * 60 * Math.PI / 180;
    const s = Math.min(Math.hypot(game.ball.vx, game.ball.vy) * 1.05, 16);
    game.ball.vx = -s * Math.cos(a);
    game.ball.vy =  s * Math.sin(a);
    game.lastSide = 'right';
    game.paddles.right.hitFlash = 12;
    events.push({ type: 'paddleHit', side: 'right', x: game.ball.x, y: game.ball.y });
  }

  // Power-up collection
  game.powerups = game.powerups.filter(pu => {
    if (Math.hypot(game.ball.x - pu.x, game.ball.y - pu.y) < BALL_R + pu.r) {
      applyPowerup(pu, now);
      events.push({ type: 'powerupCollected', x: pu.x, y: pu.y, color: pu.color });
      return false;
    }
    return true;
  });

  // Scoring
  if (game.ball.x < 0) {
    game.paddles.right.score++;
    events.push({ type: 'score', side: 'right', ballY: game.ball.y });
    if (game.paddles.right.score >= WINNING_SCORE) {
      game.phase  = 'gameover';
      game.winner = 'right';
    } else {
      resetBall(false);
    }
  }
  if (game.ball.x > W) {
    game.paddles.left.score++;
    events.push({ type: 'score', side: 'left', ballY: game.ball.y });
    if (game.paddles.left.score >= WINNING_SCORE) {
      game.phase  = 'gameover';
      game.winner = 'left';
    } else {
      resetBall(true);
    }
  }

  // Broadcast
  io.emit('state', buildPayload(now, events));
}

function buildPayload(now, events = []) {
  return {
    ball: {
      x:   game.ball.x,
      y:   game.ball.y,
      hue: game.ball.hue,
      fx:  fxRemain(game.ball.fx, now),
    },
    paddles: {
      left:  { y: game.paddles.left.y,  h: game.paddles.left.h,  score: game.paddles.left.score,  hitFlash: game.paddles.left.hitFlash,  fx: fxRemain(game.paddles.left.fx,  now) },
      right: { y: game.paddles.right.y, h: game.paddles.right.h, score: game.paddles.right.score, hitFlash: game.paddles.right.hitFlash, fx: fxRemain(game.paddles.right.fx, now) },
    },
    powerups: game.powerups.map(({ uid, id, icon, color, glow, x, y, r, age, life }) =>
      ({ uid, id, icon, color, glow, x, y, r, age, life })
    ),
    phase:  game.phase,
    winner: game.winner,
    events,
  };
}

// ── Socket connections ────────────────────────────────────────────────────────
io.on('connection', socket => {
  // Reject if already two players
  if (playerCount() >= 2) {
    socket.emit('full');
    socket.disconnect(true);
    return;
  }

  // Assign side (take the vacant slot)
  const takenSides = new Set(Object.values(players).map(p => p.side));
  const side = takenSides.has('left') ? 'right' : 'left';
  players[socket.id] = { side, input: { up: false, down: false } };

  socket.emit('assigned', { side, playerNumber: side === 'left' ? 1 : 2 });
  console.log(`Player ${side} connected (${socket.id})`);

  if (playerCount() === 2) {
    // Both seats filled — start fresh game
    game = createGame();
    game.phase = 'playing';
    lastTick   = Date.now();
    resetBall(Math.random() < 0.5);
    io.emit('start');
    console.log('Game started');
  } else {
    socket.emit('waiting');
    io.emit('playerCount', playerCount());
  }

  // ── Events from this client ──
  socket.on('input', input => {
    if (players[socket.id]) players[socket.id].input = input;
  });

  socket.on('restart', () => {
    if (game.phase !== 'gameover') return;
    if (playerCount() < 2) return;
    game = createGame();
    game.phase = 'playing';
    lastTick   = Date.now();
    resetBall(Math.random() < 0.5);
    io.emit('start');
    console.log('Game restarted');
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    console.log(`Player ${side} disconnected`);
    game = createGame();   // reset so next joiner gets a fresh game
    io.emit('playerDisconnected');
    io.emit('playerCount', playerCount());
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Laser Pong server → http://localhost:${PORT}`));
setInterval(tick, TICK_MS);
