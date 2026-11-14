import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Server } from 'socket.io';
import { buildClues } from './src/game.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const timerDurations = new Set([0, 15, 30, 45, 60, 90, 120]);
let champions = [];
let championById = new Map();
let championMetadataById = new Map();
const universeDetailsById = new Map();
let dataDragonVersion = '';

app.use(express.static('public'));
app.get('/api/champions', (_req, res) => {
  res.json({
    version: dataDragonVersion,
    champions: champions.map(({ id, name, title, image, tags }) => ({ id, name, title, image, tags })),
  });
});

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicState(room, selfId) {
  const players = [...room.players.entries()].map(([id, player]) => ({
    id,
    name: player.name,
    ready: player.ready,
    isSelf: id === selfId,
    ownChampion:
      id === selfId && player.targetId ? championById.get(player.targetId)?.name ?? null : null,
  }));
  const state = {
    code: room.code,
    players,
    phase: room.phase,
    timerSeconds: room.timerSeconds,
    turnExpiresAt: room.turnExpiresAt,
    turnPlayerId: room.turnPlayerId,
    log: room.log,
    chatMessages: room.chatMessages,
    winnerId: room.winnerId,
  };

  if (room.phase === 'finished') {
    state.revealedTargets = [...room.players.entries()].map(([id, player]) => ({
      id,
      name: player.name,
      champion: championById.get(player.targetId)?.name ?? 'Chưa chọn',
    }));
  }

  return state;
}

function broadcastState(room) {
  for (const id of room.players.keys()) {
    io.to(id).emit('room:state', publicState(room, id));
  }
}

function clearRoomExpiry(room) {
  if (room.expiryTimer) {
    clearTimeout(room.expiryTimer);
    room.expiryTimer = null;
  }
}

function resetMatch(room) {
  clearTurnTimer(room);
  room.phase = 'lobby';
  room.turnPlayerId = null;
  room.winnerId = null;
  room.log = [];
  for (const player of room.players.values()) {
    player.ready = false;
    player.targetId = null;
  }
}

function sendError(ack, message) {
  if (typeof ack === 'function') ack({ ok: false, error: message });
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 24) : '';
}

function clearTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnExpiresAt = null;
}

function startTurn(room, playerId) {
  clearTurnTimer(room);
  room.turnPlayerId = playerId;
  if (!room.timerSeconds) return;

  const expiresAt = Date.now() + room.timerSeconds * 1000;
  room.turnExpiresAt = expiresAt;
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'playing' || room.turnPlayerId !== playerId || room.turnExpiresAt !== expiresAt) return;
    const player = room.players.get(playerId);
    const opponentId = [...room.players.keys()].find((id) => id !== playerId);
    if (!player || !opponentId) return;

    room.log.push({ type: 'timeout', playerId, playerName: player.name });
    startTurn(room, opponentId);
    broadcastState(room);
  }, room.timerSeconds * 1000);
  room.turnTimer.unref?.();
}

async function getChampionDetails(championId) {
  if (universeDetailsById.has(championId)) return universeDetailsById.get(championId);
  const champion = championById.get(championId);
  const metadata = championMetadataById.get(championId);
  if (!champion || !metadata) throw new Error('Không tìm thấy dữ liệu cho vị tướng này.');

  const slug = champion.id === 'MonkeyKing' ? 'monkeyking' : champion.id.toLowerCase();
  const pendingDetails = (async () => {
    try {
      const response = await fetch(
        `https://universe-meeps.leagueoflegends.com/v1/en_us/champions/${slug}/index.json`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (!response.ok) throw new Error(`Riot Universe trả về HTTP ${response.status}`);
      const data = await response.json();
      if (data.champion?.name !== champion.name) {
        throw new Error(`Không khớp dữ liệu thế giới cho ${champion.name}.`);
      }

      const species = Array.isArray(data.champion.races)
        ? data.champion.races.map((race) => race.name).filter(Boolean)
        : [];
      return {
        ...metadata,
        species: species.length ? species : ['Human'],
      };
    } catch (error) {
      console.warn(`Chưa tải được chủng loài của ${champion.name}; manh mối này sẽ hiện là chưa rõ:`, error);
      return {
        ...metadata,
        species: [],
      };
    }
  })();

  universeDetailsById.set(championId, pendingDetails);
  try {
    const details = await pendingDetails;
    if (details.species.length) universeDetailsById.set(championId, details);
    else universeDetailsById.delete(championId);
    return details;
  } catch (error) {
    universeDetailsById.delete(championId);
    throw error;
  }
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, timerSeconds = 0 } = {}, ack) => {
    if (socket.data.roomCode) return sendError(ack, 'Bạn đang ở trong một phòng.');
    const playerName = cleanName(name);
    if (!playerName) return sendError(ack, 'Hãy nhập tên hiển thị của bạn.');
    if (!timerDurations.has(timerSeconds)) return sendError(ack, 'Thời gian mỗi lượt không hợp lệ.');

    const room = {
      code: makeRoomCode(),
      players: new Map([[socket.id, { name: playerName, ready: false, targetId: null, lastChatAt: 0 }]]),
      phase: 'lobby',
      timerSeconds,
      turnExpiresAt: null,
      turnTimer: null,
      turnPlayerId: null,
      winnerId: null,
      log: [],
      chatMessages: [],
      expiryTimer: null,
    };
    rooms.set(room.code, room);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    ack?.({ ok: true, room: publicState(room, socket.id) });
  });

  socket.on('room:join', ({ name, code } = {}, ack) => {
    if (socket.data.roomCode) return sendError(ack, 'Bạn đang ở trong một phòng.');
    const playerName = cleanName(name);
    const roomCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const room = rooms.get(roomCode);
    if (!playerName) return sendError(ack, 'Hãy nhập tên hiển thị của bạn.');
    if (!room) return sendError(ack, 'Không tìm thấy phòng. Hãy kiểm tra lại mã.');
    if (room.players.size >= 2) return sendError(ack, 'Phòng đã đủ 2 người chơi.');

    clearRoomExpiry(room);
    room.players.set(socket.id, { name: playerName, ready: false, targetId: null, lastChatAt: 0 });
    socket.data.roomCode = room.code;
    socket.join(room.code);
    ack?.({ ok: true, room: publicState(room, socket.id) });
    broadcastState(room);
  });

  socket.on('room:chat:send', ({ text } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return sendError(ack, 'Bạn không ở trong phòng chat này.');
    if (typeof text !== 'string') return sendError(ack, 'Tin nhắn không hợp lệ.');
    const messageText = text.trim();
    if (!messageText) return sendError(ack, 'Hãy nhập nội dung tin nhắn.');
    if (messageText.length > 500) return sendError(ack, 'Tin nhắn tối đa 500 ký tự.');

    const now = Date.now();
    if (now - player.lastChatAt < 700) return sendError(ack, 'Hãy chờ một chút trước khi gửi tiếp.');
    player.lastChatAt = now;
    const message = {
      id: randomUUID(),
      playerId: socket.id,
      playerName: player.name,
      text: messageText,
      createdAt: now,
    };
    room.chatMessages.push(message);
    if (room.chatMessages.length > 100) room.chatMessages.splice(0, room.chatMessages.length - 100);

    ack?.({ ok: true });
    io.to(room.code).emit('room:chat-message', message);
  });

  socket.on('room:choose', async ({ championId } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return sendError(ack, 'Phòng không ở trạng thái chọn tướng.');
    if (!championById.has(championId)) return sendError(ack, 'Không tìm thấy vị tướng này.');
    try {
      await getChampionDetails(championId);
    } catch (error) {
      console.error(`Không tải được dữ liệu tướng ${championId}:`, error);
      return sendError(ack, 'Không tải được dữ liệu tướng. Hãy thử chọn lại sau ít phút.');
    }
    if (rooms.get(room.code) !== room || room.players.get(socket.id) !== player || room.phase !== 'lobby') {
      return sendError(ack, 'Trạng thái phòng đã thay đổi. Hãy thử lại.');
    }
    player.targetId = championId;
    player.ready = false;
    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:ready', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return sendError(ack, 'Phòng không ở trạng thái chờ.');
    if (room.players.size !== 2) return sendError(ack, 'Đang chờ người chơi thứ hai.');
    if (!player.targetId) return sendError(ack, 'Hãy chọn tướng bí mật trước.');
    player.ready = !player.ready;

    if ([...room.players.values()].every((candidate) => candidate.ready)) {
      room.phase = 'playing';
      room.log = [];
      const firstPlayerId = [...room.players.keys()][randomInt(room.players.size)];
      startTurn(room, firstPlayerId);
    }

    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:guess', async ({ championId } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return sendError(ack, 'Ván chơi chưa bắt đầu.');
    if (room.turnPlayerId !== socket.id) return sendError(ack, 'Chưa đến lượt của bạn.');
    if (!championById.has(championId)) return sendError(ack, 'Không tìm thấy vị tướng này.');

    const opponent = [...room.players.entries()].find(([id]) => id !== socket.id);
    if (!opponent) return sendError(ack, 'Không tìm thấy đối thủ trong phòng.');
    const [opponentId, opponentPlayer] = opponent;
    let guess;
    let target;
    try {
      [guess, target] = await Promise.all([
        getChampionDetails(championId),
        getChampionDetails(opponentPlayer.targetId),
      ]);
    } catch (error) {
      console.error(`Không tải được dữ liệu lượt đoán trong phòng ${room.code}:`, error);
      return sendError(ack, 'Không tải được dữ liệu tướng. Hãy thử lại sau ít phút.');
    }
    if (rooms.get(room.code) !== room || room.phase !== 'playing' || room.turnPlayerId !== socket.id) {
      return sendError(ack, 'Lượt chơi đã thay đổi. Hãy kiểm tra lại lượt của bạn.');
    }

    const isCorrect = championId === opponentPlayer.targetId;
    const player = room.players.get(socket.id);
    room.log.push({
      playerId: socket.id,
      playerName: player.name,
      championId,
      championName: championById.get(championId).name,
      clues: buildClues(guess, target),
      isCorrect,
    });

    if (isCorrect) {
      clearTurnTimer(room);
      room.phase = 'finished';
      room.winnerId = socket.id;
      room.turnPlayerId = null;
    } else {
      startTurn(room, opponentId);
    }

    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:rematch', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.players.size !== 2) return sendError(ack, 'Cần có đủ hai người để chơi lại.');
    resetMatch(room);
    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(socket.id);
    socket.data.roomCode = null;
    if (room.players.size === 0) {
      clearRoomExpiry(room);
      rooms.delete(roomCode);
      return;
    }

    resetMatch(room);
    broadcastState(room);
    room.expiryTimer = setTimeout(() => {
      if (room.players.size < 2) rooms.delete(roomCode);
    }, 30 * 60 * 1000);
    room.expiryTimer.unref?.();
  });
});

async function loadChampions() {
  const catalogue = JSON.parse(await readFile(new URL('./data/champions.json', import.meta.url), 'utf8'));
  if (!catalogue.version || !Array.isArray(catalogue.champions) || catalogue.champions.length < 150) {
    throw new Error('Tệp data/champions.json thiếu hoặc không đầy đủ.');
  }

  dataDragonVersion = catalogue.version;
  champions = catalogue.champions.map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    tags: entry.tags,
    image: { full: entry.imageFile },
  }));
  championById = new Map(champions.map((champion) => [champion.id, champion]));
  championMetadataById = new Map(catalogue.champions.map((entry) => [entry.id, entry.metadata]));
  if (championById.size !== champions.length || championMetadataById.size !== champions.length) {
    throw new Error('Tệp dữ liệu tướng có mã trùng lặp hoặc thiếu manh mối.');
  }
}

const port = Number(process.env.PORT) || 3000;
try {
  await loadChampions();
  httpServer.listen(port, () => {
    console.log(`Rift Riddle is ready at http://localhost:${port} (Data Dragon ${dataDragonVersion})`);
  });
} catch (error) {
  console.error('Không thể đọc dữ liệu tướng đi kèm dự án:', error);
  process.exitCode = 1;
}
