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
const gameModes = new Set(['classic', 'random', 'emoji', 'splash', 'quote', 'ability']);
let champions = [];
let championById = new Map();
let championMetadataById = new Map();
const universeDetailsById = new Map();
const abilityHintsByChampionId = new Map();
let dataDragonVersion = '';

app.use(express.static('public'));
app.get('/api/champions', (_req, res) => {
  res.json({
    champions: champions.map(({ id, name, title, tags }) => ({ id, name, title, tags })),
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
    gameMode: room.gameMode,
    timerSeconds: room.timerSeconds,
    turnExpiresAt: room.turnExpiresAt,
    turnPlayerId: room.turnPlayerId,
    log: room.log,
    chatMessages: room.chatMessages,
    winnerId: room.winnerId,
  };

  if (room.phase === 'playing') {
    state.modeHint = room.gameMode === 'classic' ? null : room.sharedModeHint;
    if (room.gameMode !== 'classic') {
      const wrongGuessCount = room.log.filter((entry) => entry.championId && !entry.isCorrect).length;
      state.revealedSkillHints = room.revealedSkillHints;
      if (room.gameMode === 'ability') state.abilityColorRevealed = room.abilityColorRevealed;
      state.wrongGuessCount = wrongGuessCount;
      state.nextHintAt = room.hintNextAt;
      state.hintAvailable = wrongGuessCount >= room.hintNextAt && (room.gameMode === 'ability'
        ? !room.abilityColorRevealed
        : room.revealedSkillHints.length < 4);
    }
  }
  if (room.phase === 'finished') {
    state.revealedTargets = room.gameMode === 'classic'
      ? [...room.players.entries()].map(([id, player]) => ({
        id,
        name: player.name,
        champion: championById.get(player.targetId)?.name ?? 'Chưa chọn',
      }))
      : [{
        name: 'Đáp án chung',
        champion: championById.get(room.sharedTargetId)?.name ?? 'Chưa chọn',
      }];
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
  room.pendingHintId = null;
  room.revealedSkillHints = [];
  room.abilityColorRevealed = false;
  room.hintNextAt = room.gameMode === 'ability' ? 6 : 7;
  room.pendingGuessId = null;
  room.turnPlayerId = null;
  room.winnerId = null;
  room.log = [];
  room.sharedTargetId = null;
  room.sharedModeHint = null;
  room.starting = false;
  for (const player of room.players.values()) {
    player.ready = false;
    player.targetId = null;
  }
}

function removePlayerFromRoom(socket) {
  const roomCode = socket.data.roomCode;
  const room = rooms.get(roomCode);
  socket.data.roomCode = null;
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(room.code);
  if (room.players.size === 0) {
    clearRoomExpiry(room);
    rooms.delete(roomCode);
    return;
  }

  clearRoomExpiry(room);
  resetMatch(room);
  broadcastState(room);
  room.expiryTimer = setTimeout(() => {
    if (room.players.size < 2) rooms.delete(roomCode);
  }, 30 * 60 * 1000);
  room.expiryTimer.unref?.();
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
  room.pendingGuessId = null;
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

async function getAbilityModeHint(champion) {
  if (abilityHintsByChampionId.has(champion.id)) {
    return abilityHintsByChampionId.get(champion.id);
  }

  const pendingHint = (async () => {
    const response = await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(dataDragonVersion)}/data/en_US/champion/${encodeURIComponent(champion.id)}.json`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) throw new Error(`Data Dragon trả về HTTP ${response.status}`);
    const payload = await response.json();
    const spells = payload.data?.[champion.id]?.spells;
    if (!Array.isArray(spells) || spells.length < 4) {
      throw new Error(`Data Dragon thiếu dữ liệu kỹ năng cho ${champion.name}.`);
    }

    return spells.slice(0, 4).map((spell, index) => {
      if (typeof spell.image?.full !== 'string' || !spell.image.full) {
        throw new Error(`Data Dragon thiếu biểu tượng kỹ năng ${index + 1} của ${champion.name}.`);
      }
      return {
        key: ['Q', 'W', 'E', 'R'][index],
        imageUrl: `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(dataDragonVersion)}/img/spell/${encodeURIComponent(spell.image.full)}`,
      };
    });
  })();
  abilityHintsByChampionId.set(champion.id, pendingHint);

  try {
    return await pendingHint;
  } catch (error) {
    abilityHintsByChampionId.delete(champion.id);
    throw error;
  }
}

async function getModeHint(championId, gameMode) {
  if (gameMode === 'classic' || gameMode === 'random') return null;
  const champion = championById.get(championId);
  const metadata = championMetadataById.get(championId);
  if (!champion || !metadata) throw new Error('Không tìm thấy dữ liệu cho vị tướng này.');

  if (gameMode === 'emoji') {
    const roleEmojis = {
      Assassin: '🗡️',
      Fighter: '⚔️',
      Mage: '🔮',
      Marksman: '🏹',
      Support: '✨',
      Tank: '🛡️',
    };
    const regionEmojis = {
      'Bandle City': '🎪',
      Bilgewater: '🏴‍☠️',
      Demacia: '🏰',
      Freljord: '❄️',
      Ionia: '🌸',
      Ixtal: '🌿',
      Noxus: '🟥',
      Piltover: '⚙️',
      'Shadow Isles': '👻',
      Shurima: '🌞',
      Targon: '⛰️',
      'The Void': '🟣',
      Zaun: '🧪',
      Runeterra: '🌍',
    };
    const positionEmojis = { Top: '🛡️', Jungle: '🌲', Mid: '🔮', Bottom: '🏹', Support: '💚' };
    const emojis = [
      regionEmojis[metadata.regions?.[0]],
      roleEmojis[champion.tags?.[0]],
      positionEmojis[metadata.positions?.[0]],
      metadata.rangeType === 'Ranged' ? '🎯' : metadata.rangeType === 'Melee' ? '👊' : null,
    ].filter(Boolean);
    return { kind: 'emoji', emojis };
  }

  if (gameMode === 'splash') {
    return {
      kind: 'splash',
      imageUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${encodeURIComponent(champion.id)}_0.jpg`,
      cropX: randomInt(20, 81),
      cropY: randomInt(20, 81),
    };
  }

  if (gameMode === 'quote') {
    const roleLabels = {
      Assassin: 'sát thủ',
      Fighter: 'đấu sĩ',
      Mage: 'pháp sư',
      Marksman: 'xạ thủ',
      Support: 'hỗ trợ',
      Tank: 'đỡ đòn',
    };
    const role = champion.tags?.map((tag) => roleLabels[tag]).find(Boolean) ?? 'chiến binh';
    const region = metadata.regions?.[0] || 'Runeterra';
    return { kind: 'quote', text: `Một ${role} đến từ ${region} đang chờ bạn gọi đúng tên.` };
  }

  if (gameMode === 'ability') {
    const abilities = await getAbilityModeHint(champion);
    return { kind: 'ability', abilities: [abilities[randomInt(abilities.length)]] };
  }

  throw new Error('Chế độ chơi không hợp lệ.');
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, timerSeconds = 0, gameMode = 'classic' } = {}, ack) => {
    if (socket.data.roomCode) return sendError(ack, 'Bạn đang ở trong một phòng.');
    const playerName = cleanName(name);
    if (!playerName) return sendError(ack, 'Hãy nhập tên hiển thị của bạn.');
    if (!timerDurations.has(timerSeconds)) return sendError(ack, 'Thời gian mỗi lượt không hợp lệ.');
    if (!gameModes.has(gameMode)) return sendError(ack, 'Chế độ chơi không hợp lệ.');

    const room = {
      code: makeRoomCode(),
      players: new Map([[socket.id, { name: playerName, ready: false, targetId: null, lastChatAt: 0 }]]),
      phase: 'lobby',
      gameMode,
      sharedTargetId: null,
      sharedModeHint: null,
      revealedSkillHints: [],
      abilityColorRevealed: false,
      hintNextAt: 7,
      pendingHintId: null,
      pendingGuessId: null,
      starting: false,
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

  socket.on('room:choose', ({ championId } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return sendError(ack, 'Phòng không ở trạng thái chọn tướng.');
    if (room.gameMode !== 'classic') return sendError(ack, 'Mode này dùng một tướng ngẫu nhiên chung, không cần chọn tướng bí mật.');
    if (!championById.has(championId)) return sendError(ack, 'Không tìm thấy vị tướng này.');
    player.targetId = championId;
    player.ready = false;
    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:ready', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return sendError(ack, 'Phòng không ở trạng thái chờ.');
    if (room.starting) return sendError(ack, 'Đang chuẩn bị ván đấu. Hãy chờ một chút.');
    if (room.players.size !== 2) return sendError(ack, 'Đang chờ người chơi thứ hai.');
    if (room.gameMode === 'classic' && !player.targetId) return sendError(ack, 'Hãy chọn tướng bí mật trước.');
    player.ready = !player.ready;

    if ([...room.players.values()].every((candidate) => candidate.ready)) {
      if (room.gameMode !== 'classic') {
        room.starting = true;
        const sharedTarget = champions[randomInt(champions.length)];
        let sharedModeHint;
        try {
          sharedModeHint = await getModeHint(sharedTarget.id, room.gameMode);
        } catch (error) {
          console.error(`Không tải được gợi ý mode ${room.gameMode} trong phòng ${room.code}:`, error);
          room.starting = false;
          if (room.players.get(socket.id) === player) player.ready = false;
          sendError(ack, 'Không tải được dữ liệu gợi ý. Hãy thử bắt đầu lại sau ít phút.');
          broadcastState(room);
          return;
        }

        if (rooms.get(room.code) !== room || room.phase !== 'lobby' || room.players.size !== 2
          || ![...room.players.values()].every((candidate) => candidate.ready)) {
          room.starting = false;
          return sendError(ack, 'Trạng thái phòng đã thay đổi. Hãy thử sẵn sàng lại.');
        }
        room.sharedTargetId = sharedTarget.id;
        room.sharedModeHint = sharedModeHint;
        room.revealedSkillHints = sharedModeHint?.kind === 'ability'
          ? [...sharedModeHint.abilities]
          : [];
        room.abilityColorRevealed = false;
        room.hintNextAt = room.gameMode === 'ability' ? 6 : 7;
        room.pendingHintId = null;
        room.starting = false;
      }

      room.phase = 'playing';
      room.log = [];
      const firstPlayerId = [...room.players.keys()][randomInt(room.players.size)];
      startTurn(room, firstPlayerId);
    }

    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:hint', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return sendError(ack, 'Ván chơi chưa bắt đầu.');
    if (room.gameMode === 'classic') return sendError(ack, 'Mode Cổ điển không có gợi ý kỹ năng.');
    if (room.pendingGuessId) return sendError(ack, 'Đang xử lý lượt đoán. Hãy chờ một chút.');
    if (room.pendingHintId) return sendError(ack, 'Đang tải gợi ý. Hãy chờ một chút.');

    const wrongGuessCount = room.log.filter((entry) => entry.championId && !entry.isCorrect).length;
    if (wrongGuessCount < room.hintNextAt) {
      return sendError(ack, `Cần thêm ${room.hintNextAt - wrongGuessCount} lượt đoán sai để mở gợi ý.`);
    }
    if (room.gameMode === 'ability') {
      if (room.abilityColorRevealed) return sendError(ack, 'Màu kỹ năng đã được mở.');
      room.abilityColorRevealed = true;
      ack?.({ ok: true });
      broadcastState(room);
      return;
    }
    if (room.revealedSkillHints.length >= 4) return sendError(ack, 'Đã mở đủ bốn kỹ năng.');

    const champion = championById.get(room.sharedTargetId);
    if (!champion) return sendError(ack, 'Không tìm thấy đáp án của ván đấu.');

    const hintRequestId = randomUUID();
    room.pendingHintId = hintRequestId;
    let abilities;
    try {
      abilities = await getAbilityModeHint(champion);
    } catch (error) {
      console.error(`Không tải được gợi ý kỹ năng trong phòng ${room.code}:`, error);
      if (room.pendingHintId === hintRequestId) room.pendingHintId = null;
      return sendError(ack, 'Không tải được kỹ năng. Hãy thử lại sau ít phút.');
    }

    if (rooms.get(room.code) !== room || room.phase !== 'playing' || room.pendingHintId !== hintRequestId) {
      if (room.pendingHintId === hintRequestId) room.pendingHintId = null;
      return sendError(ack, 'Ván chơi đã thay đổi. Hãy thử lại.');
    }

    const nextAbility = abilities[room.revealedSkillHints.length];
    if (!nextAbility) {
      room.pendingHintId = null;
      return sendError(ack, 'Không còn kỹ năng nào để gợi ý.');
    }
    room.revealedSkillHints.push(nextAbility);
    room.hintNextAt = room.log.filter((entry) => entry.championId && !entry.isCorrect).length + 6;
    room.pendingHintId = null;
    ack?.({ ok: true });
    broadcastState(room);
  });

  socket.on('room:guess', async ({ championId } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return sendError(ack, 'Ván chơi chưa bắt đầu.');
    if (room.turnPlayerId !== socket.id) return sendError(ack, 'Chưa đến lượt của bạn.');
    if (room.pendingGuessId) return sendError(ack, 'Đang xử lý lượt đoán. Hãy chờ một chút.');
    if (!championById.has(championId)) return sendError(ack, 'Không tìm thấy vị tướng này.');
    if (room.log.some((entry) => entry.championId === championId)) {
      return sendError(ack, 'Vị tướng này đã được đoán trong ván đấu.');
    }

    const opponent = [...room.players.entries()].find(([id]) => id !== socket.id);
    if (!opponent) return sendError(ack, 'Không tìm thấy đối thủ trong phòng.');
    const [opponentId, opponentPlayer] = opponent;
    const targetId = room.gameMode === 'classic' ? opponentPlayer.targetId : room.sharedTargetId;
    if (!targetId) return sendError(ack, 'Chưa có đáp án cho ván đấu này.');
    const guessRequestId = randomUUID();
    room.pendingGuessId = guessRequestId;
    let clues = [];
    if (room.gameMode === 'classic' || room.gameMode === 'random') {
      let guess;
      let target;
      try {
        [guess, target] = await Promise.all([
          getChampionDetails(championId),
          getChampionDetails(targetId),
        ]);
      } catch (error) {
        console.error(`Không tải được dữ liệu lượt đoán trong phòng ${room.code}:`, error);
        if (room.pendingGuessId === guessRequestId) room.pendingGuessId = null;
        return sendError(ack, 'Không tải được dữ liệu tướng. Hãy thử lại sau ít phút.');
      }
      clues = buildClues(guess, target);
    }
    if (rooms.get(room.code) !== room || room.phase !== 'playing' || room.turnPlayerId !== socket.id
      || room.pendingGuessId !== guessRequestId) {
      if (room.pendingGuessId === guessRequestId) room.pendingGuessId = null;
      return sendError(ack, 'Lượt chơi đã thay đổi. Hãy kiểm tra lại lượt của bạn.');
    }

    room.pendingGuessId = null;
    const isCorrect = championId === targetId;
    const player = room.players.get(socket.id);
    room.log.push({
      playerId: socket.id,
      playerName: player.name,
      championId,
      championName: championById.get(championId).name,
      clues,
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

  socket.on('room:leave', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.players.has(socket.id)) return sendError(ack, 'Bạn không ở trong phòng này.');
    removePlayerFromRoom(socket);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    removePlayerFromRoom(socket);
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
