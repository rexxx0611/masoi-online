// ============================================================
//  MA SÓI ONLINE - Server  (Node.js + Socket.io)
//  Deploy: Railway / Render / Fly.io / VPS
//  npm install && node server.js
// ============================================================
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,
  pingInterval: 30000,
  maxHttpBufferSize: 1e6,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ================================================================
//  STATE
// ================================================================
// rooms[code] = { code, hostId, players, started, gameState, timers:{} }
const rooms = {};

function getRoom(code)    { return rooms[code]; }
function roomOfSocket(sid){ return Object.values(rooms).find(r => r.players.some(p => p.id === sid)); }
function emit(sid, ev, d) { io.to(sid).emit(ev, d); }
function toRoom(code, ev, d, exceptSid) {
  if (exceptSid) io.to(code).except(exceptSid).emit(ev, d);
  else           io.to(code).emit(ev, d);
}

// ================================================================
//  SOCKET EVENTS
// ================================================================
io.on('connection', socket => {
  // ---------- LOBBY ----------
  socket.on('CREATE_ROOM', ({ name, avatar }) => {
    const code   = genCode();
    const player = { id: socket.id, name: name.slice(0,18), avatar, isHost: true };
    rooms[code]  = { code, hostId: socket.id, players: [player], started: false, gameState: null, timers: {} };
    socket.join(code);
    emit(socket.id, 'ROOM_JOINED', { code, me: player, room: roomPublic(rooms[code]) });
  });

  socket.on('JOIN_ROOM', ({ code, name, avatar }) => {
    code = code.toUpperCase();
    const room = getRoom(code);
    if (!room)                return emit(socket.id, 'ERR', { msg: 'Phòng không tồn tại!' });
    if (room.started)         return emit(socket.id, 'ERR', { msg: 'Game đã bắt đầu rồi!' });
    if (room.players.length >= 20) return emit(socket.id, 'ERR', { msg: 'Phòng đã đầy (tối đa 20 người)!' });
    if (room.players.find(p => p.name === name.slice(0,18))) return emit(socket.id, 'ERR', { msg: 'Tên này đã có người dùng!' });

    const player = { id: socket.id, name: name.slice(0,18), avatar, isHost: false };
    room.players.push(player);
    socket.join(code);
    emit(socket.id, 'ROOM_JOINED', { code, me: player, room: roomPublic(room) });
    toRoom(code, 'ROOM_UPDATE', { room: roomPublic(room) }, socket.id);
  });


  // ---------- ROOM ACTIONS ----------
  socket.on('START_GAME', ({ code, roleConfig, discussTime }) => {
    const room = getRoom(code);
    if (!room) return emit(socket.id, 'ERR', { msg: 'Phòng không tồn tại!' });
    if (room.hostId !== socket.id) return emit(socket.id, 'ERR', { msg: 'Chỉ chủ phòng mới có thể bắt đầu!' });
    if (room.started) return emit(socket.id, 'ERR', { msg: 'Game đã bắt đầu rồi!' });
    if (room.players.length < 4) return emit(socket.id, 'ERR', { msg: 'Cần ít nhất 4 người chơi!' });

    try {
      const gs = buildGameState(room.players, roleConfig, discussTime || 60);
      if (!gs || !gs.players || gs.players.length === 0) {
        return emit(socket.id, 'ERR', { msg: 'Lỗi tạo trò chơi. Vui lòng thử lại!' });
      }
      room.started   = true;
      room.gameState = gs;
      
      // Send each player their secret role first (private)
      gs.players.forEach(p => { if (p.id) emit(p.id, 'YOUR_ROLE', { role: p.role }); });
      // Then broadcast GAME_STARTED to everyone — shows game screen
      toRoom(code, 'GAME_STARTED', { gameState: pub(gs) });
      
      // Clear any existing timers and schedule night
      clearRoomTimers(room);
      room.timers.initial = setTimeout(() => beginNight(code), 1500);
    } catch (error) {
      console.error('Error starting game:', error);
      emit(socket.id, 'ERR', { msg: 'Lỗi bắt đầu trò chơi. Vui lòng thử lại!' });
    }
  });

  // ---------- NIGHT ACTIONS ----------
  socket.on('NIGHT_ACT', ({ code, type, target }) => {
    processNightAct(code, socket.id, type, target);
  });

  socket.on('WITCH_SAVE', ({ code }) => {
    const room = getRoom(code);
    if (!room?.gameState || room.gameState.witchPotionUsed) return;
    const p = findAlive(room.gameState, socket.id);
    if (!p || p.role !== 'witch') return;
    room.gameState.nightActions.witchSave = true;
    room.gameState.witchPotionUsed = true;
    toRoom(code, 'STATE_UPDATE', { gameState: pub(room.gameState) });
  });

  socket.on('WITCH_KILL', ({ code, target }) => {
    const room = getRoom(code);
    if (!room?.gameState || room.gameState.witchPotionUsed) return;
    const p = findAlive(room.gameState, socket.id);
    if (!p || p.role !== 'witch') return;
    room.gameState.nightActions.witchKill = target;
    room.gameState.witchPotionUsed = true;
    toRoom(code, 'STATE_UPDATE', { gameState: pub(room.gameState) });
  });

  socket.on('GUARD_ACT', ({ code, target }) => {
    const room = getRoom(code);
    if (!room?.gameState || room.gameState.nightDone.guard) return;
    const p = findAlive(room.gameState, socket.id);
    if (!p || p.role !== 'guard') return;
    room.gameState.nightDone.guard    = true;
    room.gameState.nightActions.guard = target;
    room.gameState.guardLastProtected = target;
  });

  // ---------- VOTING ----------
  socket.on('VOTE_CAST', ({ code, target }) => {
    processVote(code, socket.id, target);
  });

  // ---------- HUNTER ----------
  socket.on('HUNTER_SHOT', ({ code, target }) => {
    processHunterShot(code, socket.id, target);
  });

  // ---------- CHAT ----------
  socket.on('CHAT', ({ code, msg }) => {
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p)   return;
    toRoom(code, 'CHAT_MSG', { from: p.name, msg: String(msg).slice(0, 200) });
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    const room = roomOfSocket(socket.id);
    if (!room) return;
    if (!room.started) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[room.code]; return; }
      if (room.hostId === socket.id) {
        room.players[0].isHost = true;
        room.hostId = room.players[0].id;
      }
      toRoom(room.code, 'ROOM_UPDATE', { room: roomPublic(room) });
    }
    // If game started, KEEP player in game state (they may reconnect within ~5 minutes)
  });
});

// ================================================================
//  GAME ENGINE
// ================================================================

const NIGHT_SEQ  = ['wolf','vampire','guard','seer','witch'];
const NIGHT_SECS = { wolf:20, vampire:20, guard:15, seer:15, witch:20 };

function buildGameState(players, roleConfig, discussTime) {
  const shuffled = shuffle([...players]);
  const pool     = buildPool(roleConfig, shuffled.length);
  const roleMap  = {};
  shuffled.forEach((p, i) => { roleMap[p.id] = pool[i]; });
  return {
    players: shuffled.map(p => ({ ...p, role: roleMap[p.id], alive: true, votes: 0 })),
    roleMap, roleConfig,
    phase: 'night', round: 1,
    nightActions: {}, votes: {},
    witchPotionUsed: false,
    cursedTurned: [], vampireDelayed: null,
    nightDone: {}, wolfTarget: null, wolfVotes: {},
    currentNightRole: null,
    guardLastProtected: null,
    discussTime,
    hunterPending: false,
  };
}

function buildPool(cfg, total) {
  const pool = [];
  ['wolf','vampire','guard','seer','witch','hunter','cursed','bored'].forEach(r => {
    for (let i = 0; i < (cfg[r]||0); i++) pool.push(r);
  });
  while (pool.length < total) pool.push('villager');
  return shuffle(pool);
}

// ---- Night sequence ----
function beginNight(code) {
  try {
    const room = getRoom(code);
    if (!room?.gameState) return console.error('beginNight: room or gameState missing');
    const gs = room.gameState;
    gs.phase         = 'night';
    gs.nightActions  = {};
    gs.nightDone     = {};
    gs.wolfTarget    = null;
    gs.wolfVotes     = {};
    gs.hunterPending = false;
    gs.currentNightRole = null;
    clearRoomTimers(room);

    toRoom(code, 'PHASE_CHANGE', { phase: 'night', gameState: pub(gs) });
    toRoom(code, 'LOG', { msg: `🌙 Đêm ${gs.round} bắt đầu...`, cls: 'night' });
    scheduleNight(code, 0);
  } catch (err) {
    console.error('Error in beginNight:', err);
  }
}

function scheduleNight(code, idx) {
  try {
    const room = getRoom(code);
    if (!room?.gameState) return;
    const gs  = room.gameState;
    const seq = NIGHT_SEQ;
    if (idx >= seq.length) { resolveNight(code); return; }

    const role = seq[idx];
    const secs = NIGHT_SECS[role];
    const cfg  = gs.roleConfig;

    // Skip roles not configured in this game
    const inGame = role === 'wolf' ? (cfg.wolf||0) > 0 : (cfg[role]||0) > 0;
    if (!inGame) { scheduleNight(code, idx + 1); return; }

    // Always announce (dead or alive) so players can't infer deaths from timing
    const ann = {
      wolf:'🐺 Ma Sói đang thức...', vampire:'🧛 Ma Cà Rồng đang thức...',
      guard:'🛡️ Bảo Vệ đang thức...', seer:'🔮 Tiên Tri đang thức...',
      witch:'🧙‍♀️ Phù Thủy đang thức...',
    };
    toRoom(code, 'LOG', { msg: ann[role], cls: 'night' });
    gs.currentNightRole = role;
    toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });

    // Send NIGHT_TURN only to alive players with this role
    const alive = alivePlayers(gs);
    if (role === 'wolf') {
      const wolves = alive.filter(p => isWolf(p, gs));
      if (wolves.length > 0) {
        const pack = wolves.map(w => w.name).join(', ');
        wolves.forEach(w => {
          const targets = alive.filter(t => t.id !== w.id).map(miniPlayer);
          emit(w.id, 'NIGHT_TURN', { role: 'wolf', pack, targets });
        });
      }
    } else if (role === 'vampire') {
      const actor = alive.find(p => p.role === 'vampire');
      if (actor) {
        const targets = alive.filter(p => p.id !== actor.id).map(miniPlayer);
        emit(actor.id, 'NIGHT_TURN', { role: 'vampire', targets });
      }
    } else if (role === 'guard') {
      const actor = alive.find(p => p.role === 'guard');
      if (actor) {
        const targets = alive.map(miniPlayer);
        emit(actor.id, 'NIGHT_TURN', { role: 'guard', targets, lastProtected: gs.guardLastProtected });
      }
    } else if (role === 'seer') {
      const actor = alive.find(p => p.role === 'seer');
      if (actor) {
        const targets = alive.filter(p => p.id !== actor.id).map(miniPlayer);
        emit(actor.id, 'NIGHT_TURN', { role: 'seer', targets });
      }
    } else if (role === 'witch') {
      const actor = alive.find(p => p.role === 'witch');
      if (actor) {
        const killTargets = alive.filter(p => p.id !== actor.id).map(miniPlayer);
        emit(actor.id, 'NIGHT_TURN', {
          role: 'witch', wasAttacked: !!gs.wolfTarget,
          witchPotionUsed: gs.witchPotionUsed, killTargets
        });
      }
    }

    room.timers.night = setTimeout(() => scheduleNight(code, idx + 1), secs * 1000);
    // Broadcast timer so all clients can display countdown
    toRoom(code, 'TIMER_START', { secs, label: ann[role] });
  } catch (err) {
    console.error('Error in scheduleNight:', err);
  }
}

function processNightAct(code, sid, type, target) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs || gs.phase !== 'night') return;
  const player = findAlive(gs, sid);
  if (!player) return;

  if (type === 'wolf' && isWolf(player, gs)) {
    gs.wolfVotes[sid] = target;
    const wolves  = alivePlayers(gs).filter(p => isWolf(p, gs));
    const tally   = {};
    Object.values(gs.wolfVotes).forEach(t => { tally[t] = (tally[t]||0) + 1; });
    const needed  = Math.floor(wolves.length / 2) + 1;
    const top     = Object.entries(tally).sort((a,b) => b[1]-a[1])[0];
    gs.wolfTarget = (top && top[1] >= needed) ? top[0] : null;
    const update  = { votes: gs.wolfVotes, wolfTarget: gs.wolfTarget };
    // Send vote status to all wolves only
    wolves.forEach(w => emit(w.id, 'WOLF_VOTE_UPDATE', update));
  }

  if (type === 'seer' && player.role === 'seer' && !gs.nightDone.seer) {
    gs.nightDone.seer = true;
    const t = gs.players.find(p => p.id === target);
    if (t) emit(sid, 'SEER_ANSWER', { targetName: t.name, isEvil: isWolf(t, gs) });
  }

  if (type === 'vampire' && player.role === 'vampire' && !gs.nightDone.vampire) {
    gs.nightDone.vampire   = true;
    gs.nightActions.vampire = target;
  }

  if (type === 'guard' && player.role === 'guard' && !gs.nightDone.guard) {
    gs.nightDone.guard    = true;
    gs.nightActions.guard  = target;
    gs.guardLastProtected  = target;
  }
}

function resolveNight(code) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs) return;
  clearRoomTimers(room);

  const deaths        = [];
  const guardProtected = gs.nightActions.guard || null;

  // Vampire delayed from previous night
  if (gs.vampireDelayed) {
    const v = gs.players.find(p => p.id === gs.vampireDelayed && p.alive);
    if (v) deaths.push(v);
    gs.vampireDelayed = null;
  }

  // Wolf kill
  if (gs.wolfTarget) {
    const vic = gs.players.find(p => p.id === gs.wolfTarget && p.alive);
    if (vic) {
      if (vic.role === 'cursed' && !gs.cursedTurned.includes(vic.id)) {
        gs.cursedTurned.push(vic.id);
        vic.role = 'wolf';
        emit(vic.id, 'YOUR_ROLE', { role: 'wolf' });
        emit(vic.id, 'CURSED_TURNED', { msg: '😈 Bạn bị sói cắn và biến thành Ma Sói!' });
      } else if (guardProtected === vic.id) {
        // Guard saved — silent
      } else if (gs.nightActions.witchSave) {
        // Witch saved — silent
      } else {
        deaths.push(vic);
      }
    }
  }

  // Witch kill
  if (gs.nightActions.witchKill) {
    const v = gs.players.find(p => p.id === gs.nightActions.witchKill && p.alive);
    if (v) deaths.push(v);
  }

  // Vampire new target (delayed to next night)
  if (gs.nightActions.vampire) gs.vampireDelayed = gs.nightActions.vampire;

  // Apply deaths
  if (deaths.length === 0) {
    toRoom(code, 'LOG', { msg: '🌙 Một đêm bình yên. Không ai chết đêm nay.', cls: 'day' });
  } else {
    deaths.forEach(d => {
      doKill(code, d.id, 'night');
      toRoom(code, 'LOG', { msg: `💀 ${d.name} đã chết trong đêm!`, cls: 'death' });
    });
  }

  toRoom(code, 'LOG', { msg: `☀️ Bình minh ngày ${gs.round}.`, cls: 'day' });
  toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
  if (checkWin(code)) return;
  beginDay(code);
}

// ---- Kill ----
function doKill(code, pid, reason) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs) return;
  const p = gs.players.find(x => x.id === pid && x.alive);
  if (!p) return;
  p.alive = false;
  emit(pid, 'YOU_DIED', { reason, role: p.role });

  // Hunter: 10-second window
  if (p.role === 'hunter') {
    const targets = alivePlayers(gs).filter(x => x.id !== pid).map(miniPlayer);
    if (targets.length > 0) {
      gs.hunterPending = true;
      gs._hunterVictim = pid;
      emit(pid, 'HUNTER_TURN', { targets });
      room.timers.hunter = setTimeout(() => {
        if (gs.hunterPending) {
          gs.hunterPending = false;
          toRoom(code, 'LOG', { msg: '🏹 Thợ Săn không kịp bắn!', cls: 'vote' });
          toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
          afterHunterAct(code);
        }
      }, 10000);
    }
  }
}

function processHunterShot(code, sid, target) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs || !gs.hunterPending) return;
  const hunter = gs.players.find(p => p.id === sid && !p.alive && p.role === 'hunter');
  const tgt    = gs.players.find(p => p.id === target && p.alive);
  if (!hunter || !tgt) return;
  clearTimeout(room.timers.hunter);
  gs.hunterPending = false;
  tgt.alive = false;
  emit(target, 'YOU_DIED', { reason: 'hunter', role: tgt.role });
  toRoom(code, 'LOG', { msg: `💀 ${tgt.name} đã chết bất ngờ!`, cls: 'death' });
  toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
  afterHunterAct(code);
}

function afterHunterAct(code) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs) return;
  if (checkWin(code)) return;
  if (gs.phase === 'night') resolveNight(code);
  else { gs.round++; beginNight(code); }
}

// ---- Day ----
function beginDay(code) {
  try {
    const room = getRoom(code);
    const gs   = room?.gameState;
    if (!gs) return console.error('beginDay: gameState missing');
    gs.phase = 'day';
    gs.votes = {};
    gs.players.forEach(p => { p.votes = 0; });
    toRoom(code, 'PHASE_CHANGE', { phase: 'day', gameState: pub(gs) });
    const dt  = gs.discussTime || 60;
    const lbl = `💬 Thảo luận! (${Math.floor(dt/60)} phút${dt%60 ? ` ${dt%60} giây`:''})`.substring(0, 200);
    toRoom(code, 'LOG', { msg: lbl, cls: 'day' });
    toRoom(code, 'TIMER_START', { secs: dt, label: '💬 Thảo luận' });
    room.timers.day = setTimeout(() => beginVote(code), dt * 1000);
  } catch (err) {
    console.error('Error in beginDay:', err);
  }
}

function beginVote(code) {
  try {
    const room = getRoom(code);
    const gs   = room?.gameState;
    if (!gs || gs.phase !== 'day') return;
    gs.phase = 'vote';
    gs.votes = {};
    gs.players.forEach(p => { p.votes = 0; });
    toRoom(code, 'PHASE_CHANGE', { phase: 'vote', gameState: pub(gs) });
    toRoom(code, 'LOG', { msg: '⚖ Bỏ phiếu! (30 giây)', cls: 'vote' });
    toRoom(code, 'TIMER_START', { secs: 30, label: '⚖ Bỏ phiếu' });
    room.timers.vote = setTimeout(() => resolveVote(code), 30000);
  } catch (err) {
    console.error('Error in beginVote:', err);
  }
}

function processVote(code, sid, target) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs || gs.phase !== 'vote') return;
  const voter = findAlive(gs, sid);
  const tgt   = gs.players.find(p => p.id === target && p.alive);
  if (!voter || !tgt) return;
  if (gs.votes[sid]) {
    const old = gs.players.find(p => p.id === gs.votes[sid]);
    if (old) old.votes = Math.max(0, (old.votes||0) - 1);
  }
  gs.votes[sid] = target;
  tgt.votes = (tgt.votes||0) + 1;
  toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
  toRoom(code, 'LOG', { msg: `🗳 ${voter.name} đã bỏ phiếu.`, cls: 'vote' });
}

function resolveVote(code) {
  try {
    const room = getRoom(code);
    const gs   = room?.gameState;
    if (!gs || gs.phase !== 'vote') return;

    // Vampire delayed death after vote phase
    if (gs.vampireDelayed) {
      const v = gs.players.find(p => p.id === gs.vampireDelayed && p.alive);
      if (v) {
        doKill(code, v.id, 'night');
        toRoom(code, 'LOG', { msg: `💀 ${v.name} đã chết sau khi bỏ phiếu!`, cls: 'death' });
      }
      gs.vampireDelayed = null;
    }

    const alive     = alivePlayers(gs);
    const threshold = Math.floor(alive.length / 2) + 1;
    let max = 0, exes = [];
    alive.forEach(p => {
      const v = p.votes || 0;
      if (v > max)              { max = v; exes = [p]; }
      else if (v === max && v > 0) exes.push(p);
    });

    if (max === 0 || exes.length > 1 || max < threshold) {
      const reason = max === 0 ? 'Không ai bỏ phiếu.'
        : exes.length > 1 ? 'Hòa phiếu.'
        : `Chưa đủ đa số (${max}/${alive.length}, cần ${threshold}).`;
      toRoom(code, 'LOG', { msg: `⚖ Không ai bị treo cổ. ${reason}`, cls: 'vote' });
      toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
      if (checkWin(code)) return;
      gs.round++; beginNight(code); return;
    }

    const topped = exes[0];
    toRoom(code, 'LOG', { msg: `😵 ${topped.name} bị treo cổ với ${max}/${alive.length} phiếu!`, cls: 'death' });

    if (topped.role === 'bored') {
      const wm = `😑 ${topped.name} thắng! Kẻ Chán Đời được toại nguyện!`;
      toRoom(code, 'LOG', { msg: wm, cls: 'win' });
      doKill(code, topped.id, 'vote');
      endGame(code, 'bored', [topped.name], wm, gs.players); return;
    }

    doKill(code, topped.id, 'vote');
    toRoom(code, 'STATE_UPDATE', { gameState: pub(gs) });
    if (checkWin(code)) return;
    gs.round++; beginNight(code);
  } catch (err) {
    console.error('Error in resolveVote:', err);
  }
}

// ---- Win ----
function checkWin(code) {
  const room = getRoom(code);
  const gs   = room?.gameState;
  if (!gs) return false;
  const alive    = alivePlayers(gs);
  const wolves   = alive.filter(p => isWolf(p, gs));
  const vampires = alive.filter(p => p.role === 'vampire');
  const others   = alive.filter(p => !isWolf(p, gs) && p.role !== 'vampire');
  let winner=null, names=[], msg='';

  if (wolves.length === 0 && vampires.length === 0) {
    winner='village'; names=others.map(p=>p.name);
    msg='🎉 Dân Làng chiến thắng! Bóng tối đã bị xua tan!';
  } else if (wolves.length >= others.length + vampires.length) {
    winner='wolf'; names=wolves.map(p=>p.name);
    msg='🐺 Ma Sói chiến thắng! Làng đã chìm vào bóng tối!';
  } else if (vampires.length > 0 && others.length <= 1 && wolves.length === 0) {
    winner='vampire'; names=vampires.map(p=>p.name);
    msg='🧛 Ma Cà Rồng chiến thắng!';
  }

  if (winner) {
    clearRoomTimers(room);
    endGame(code, winner, names, msg, gs.players);
    return true;
  }
  return false;
}

function endGame(code, winner, names, msg, allPlayers) {
  toRoom(code, 'LOG', { msg, cls: 'win' });
  toRoom(code, 'GAME_OVER', { winner, names, msg, allPlayers });
  // Keep room briefly so clients can see end screen
  setTimeout(() => { delete rooms[code]; }, 120000);
}

// ---- Helpers ----
function isWolf(p, gs)  { return p.role==='wolf' || (p.role==='cursed' && gs.cursedTurned.includes(p.id)); }
function alivePlayers(gs){ return gs.players.filter(p => p.alive); }
function findAlive(gs, sid){ return gs.players.find(p => p.id === sid && p.alive); }
function miniPlayer(p)  { return { id: p.id, name: p.name, avatar: p.avatar }; }
function appendLog(code, msg, cls='sys') { toRoom(code, 'LOG', { msg, cls }); }

// Public game state — never leak roles or sensitive info
function pub(gs) {
  return {
    phase: gs.phase, round: gs.round,
    currentNightRole: gs.currentNightRole,
    witchPotionUsed: gs.witchPotionUsed,
    discussTime: gs.discussTime,
    roleConfig: gs.roleConfig, // safe to share — just counts, not assignments
    players: gs.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar,
      alive: p.alive, votes: p.votes, isHost: p.isHost
      // role NEVER sent in pub() — sent privately via YOUR_ROLE
    })),
  };
}

function roomPublic(room) {
  return { code: room.code, hostId: room.hostId, players: room.players.map(p => ({
    id: p.id, name: p.name, avatar: p.avatar, isHost: p.isHost
  })), started: room.started };
}

function clearRoomTimers(room) {
  if (!room?.timers) return;
  Object.values(room.timers).forEach(t => clearTimeout(t));
  room.timers = {};
}

function shuffle(a) {
  for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}

function genCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

// ---- Start ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐺 Ma Sói Online — running on http://localhost:${PORT}`);
  console.log(`   Rooms: ${Object.keys(rooms).length}`);
});
