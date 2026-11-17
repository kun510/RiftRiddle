import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { buildClues } from './src/game.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const timerDurations = new Set([0, 15, 30, 45, 60, 90, 120]);
const gameModes = new Set(['classic', 'random', 'emoji', 'splash', 'ability']);
let champions = [];
let championById = new Map();
let championMetadataById = new Map();
const abilityHintsByChampionId = new Map();
const splashSkinsByChampionId = new Map();
let dataDragonVersion = '';
const databasePath = process.env.RIFT_RIDDLE_DB_PATH
  || fileURLToPath(new URL('./data/rift-riddle.sqlite', import.meta.url));
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE IF NOT EXISTS matchups (
    player_one_key TEXT NOT NULL,
    player_two_key TEXT NOT NULL,
    player_one_name TEXT NOT NULL,
    player_two_name TEXT NOT NULL,
    player_one_score INTEGER NOT NULL DEFAULT 0,
    player_two_score INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_one_key, player_two_key)
  );
  CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY,
    player_one_key TEXT NOT NULL,
    player_one_name TEXT NOT NULL,
    player_two_key TEXT NOT NULL,
    player_two_name TEXT NOT NULL,
    winner_key TEXT NOT NULL,
    winner_name TEXT NOT NULL,
    game_mode TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    player_one_score INTEGER NOT NULL,
    player_two_score INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS match_history_players
    ON match_history (player_one_key, player_two_key);
`);
const getMatchup = database.prepare('SELECT * FROM matchups WHERE player_one_key = ? AND player_two_key = ?');
const saveMatchup = database.prepare(`
  INSERT INTO matchups (
    player_one_key, player_two_key, player_one_name, player_two_name, player_one_score, player_two_score
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(player_one_key, player_two_key) DO UPDATE SET
    player_one_score = player_one_score + excluded.player_one_score,
    player_two_score = player_two_score + excluded.player_two_score
`);
const addMatchupWin = database.prepare(`
  UPDATE matchups
  SET player_one_score = player_one_score + ?,
      player_two_score = player_two_score + ?
  WHERE player_one_key = ? AND player_two_key = ?
  RETURNING *
`);
const saveMatch = database.prepare(`
  INSERT INTO match_history (
    player_one_key, player_one_name, player_two_key, player_two_name,
    winner_key, winner_name, game_mode, played_at, player_one_score, player_two_score
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getPairMatchHistory = database.prepare(`
  SELECT
    id AS matchNumber,
    player_one_name AS playerOneName,
    player_two_name AS playerTwoName,
    winner_name AS winnerName,
    game_mode AS gameMode,
    played_at AS playedAt,
    player_one_score AS playerOneScore,
    player_two_score AS playerTwoScore
  FROM match_history
  WHERE (player_one_key = ? AND player_two_key = ?)
     OR (player_one_key = ? AND player_two_key = ?)
  ORDER BY id DESC
  LIMIT 50
`);

function normalizePlayerName(name) {
  return name.trim().normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('vi-VN');
}

function orderedPlayerKeys(first, second) {
  return first < second ? [first, second] : [second, first];
}

function getOrCreateMatchup(firstPlayer, secondPlayer) {
  const [playerOneKey, playerTwoKey] = orderedPlayerKeys(firstPlayer.scoreId, secondPlayer.scoreId);
  const playerOne = firstPlayer.scoreId === playerOneKey ? firstPlayer : secondPlayer;
  const playerTwo = firstPlayer.scoreId === playerTwoKey ? firstPlayer : secondPlayer;
  saveMatchup.run(playerOneKey, playerTwoKey, playerOne.name, playerTwo.name, 0, 0);
  return getMatchup.get(playerOneKey, playerTwoKey);
}

function getMatchHistory(playerOneId, playerTwoId) {
  if (!playerTwoId) return [];
  return getPairMatchHistory.all(playerOneId, playerTwoId, playerTwoId, playerOneId)
    .map((match) => ({
      matchNumber: match.matchNumber,
      winnerName: match.winnerName,
      gameMode: match.gameMode,
      playedAt: match.playedAt,
      scores: [
        { name: match.playerOneName, score: match.playerOneScore },
        { name: match.playerTwoName, score: match.playerTwoScore },
      ],
    }));
}

function recordMatch(room, winner) {
  const [firstPlayer, secondPlayer] = [...room.players.values()];
  const [playerOneKey, playerTwoKey] = orderedPlayerKeys(firstPlayer.scoreId, secondPlayer.scoreId);
  const playerOne = firstPlayer.scoreId === playerOneKey ? firstPlayer : secondPlayer;
  const playerTwo = firstPlayer.scoreId === playerTwoKey ? firstPlayer : secondPlayer;
  const winnerIsPlayerOne = winner.scoreId === playerOneKey;
  const playedAt = Date.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    const updatedMatchup = addMatchupWin.get(
      winnerIsPlayerOne ? 1 : 0,
      winnerIsPlayerOne ? 0 : 1,
      playerOneKey,
      playerTwoKey,
    );
    if (!updatedMatchup) throw new Error(`Không tìm thấy bảng điểm của ${playerOne.name} và ${playerTwo.name}.`);
    saveMatch.run(
      playerOneKey,
      playerOne.name,
      playerTwoKey,
      playerTwo.name,
      winner.scoreId,
      winner.name,
      room.gameMode,
      playedAt,
      updatedMatchup.player_one_score,
      updatedMatchup.player_two_score,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const matchup = getMatchup.get(playerOneKey, playerTwoKey);
  room.scores.set(playerOneKey, { id: playerOneKey, name: playerOne.name, score: matchup.player_one_score });
  room.scores.set(playerTwoKey, { id: playerTwoKey, name: playerTwo.name, score: matchup.player_two_score });
  room.matchHistory = getMatchHistory(playerOneKey, playerTwoKey);
}

function migrateRoomRecords() {
  const hasRoomRecords = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_records'",
  ).get();
  if (!hasRoomRecords) return;

  const legacyRecords = database.prepare('SELECT scores_json, match_history_json FROM room_records').all();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const record of legacyRecords) {
      const players = JSON.parse(record.scores_json);
      if (players.length === 2) {
        const [first, second] = players;
        const firstKey = normalizePlayerName(first.name);
        const secondKey = normalizePlayerName(second.name);
        const [playerOneKey, playerTwoKey] = orderedPlayerKeys(firstKey, secondKey);
        const playerOne = firstKey === playerOneKey ? first : second;
        const playerTwo = firstKey === playerTwoKey ? first : second;
        saveMatchup.run(
          playerOneKey,
          playerTwoKey,
          playerOne.name,
          playerTwo.name,
          playerOne.score,
          playerTwo.score,
        );
      }

      for (const match of JSON.parse(record.match_history_json)) {
        if (!Array.isArray(match.scores) || match.scores.length !== 2) continue;
        const [first, second] = match.scores;
        const firstKey = normalizePlayerName(first.name);
        const secondKey = normalizePlayerName(second.name);
        const [playerOneKey, playerTwoKey] = orderedPlayerKeys(firstKey, secondKey);
        const playerOne = firstKey === playerOneKey ? first : second;
        const playerTwo = firstKey === playerTwoKey ? second : first;
        saveMatch.run(
          playerOneKey,
          playerOne.name,
          playerTwoKey,
          playerTwo.name,
          normalizePlayerName(match.winnerName),
          match.winnerName,
          match.gameMode,
          match.playedAt,
          playerOne.score,
          playerTwo.score,
        );
      }
    }
    database.exec('DROP TABLE room_records; COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
migrateRoomRecords();
database.exec('DROP TABLE IF EXISTS player_scores');

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
    score: room.scores.get(player.scoreId).score,
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
    matchHistory: room.matchHistory,
  };

  if (room.phase === 'playing') {
    state.modeHint = room.gameMode === 'classic'
      ? null
      : room.gameMode === 'emoji'
        ? { ...room.sharedModeHint, emojis: room.sharedModeHint.emojis.slice(0, room.revealedEmojiCount) }
        : room.sharedModeHint;
    if (room.gameMode !== 'classic') {
      const wrongGuessCount = room.log.filter((entry) => entry.championId && !entry.isCorrect).length;
      state.revealedSkillHints = room.revealedSkillHints;
      if (room.gameMode === 'ability') state.abilityColorRevealed = room.abilityColorRevealed;
      if (room.gameMode === 'emoji') {
        state.emojiHintsRemaining = Math.max(0, room.sharedModeHint.emojis.length - room.revealedEmojiCount);
      }
      state.wrongGuessCount = wrongGuessCount;
      state.nextHintAt = room.hintNextAt;
      const hasMoreHints = room.gameMode === 'ability'
        ? !room.abilityColorRevealed
        : room.gameMode === 'emoji'
          ? room.revealedEmojiCount < room.sharedModeHint.emojis.length
          : room.revealedSkillHints.length < 4;
      state.hintAvailable = wrongGuessCount >= room.hintNextAt && hasMoreHints;
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
  room.revealedEmojiCount = 0;
  room.abilityColorRevealed = false;
  room.hintNextAt = room.gameMode === 'ability' ? 6 : room.gameMode === 'emoji' ? 3 : 7;
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
  const champion = championById.get(championId);
  const metadata = championMetadataById.get(championId);
  if (!champion || !metadata) throw new Error('Không tìm thấy dữ liệu cho vị tướng này.');
  return metadata;
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

async function getSplashSkinNumbers(champion) {
  if (splashSkinsByChampionId.has(champion.id)) {
    return splashSkinsByChampionId.get(champion.id);
  }

  const pendingSkins = (async () => {
    const response = await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(dataDragonVersion)}/data/en_US/champion/${encodeURIComponent(champion.id)}.json`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) throw new Error(`Data Dragon trả về HTTP ${response.status}`);
    const payload = await response.json();
    const skins = payload.data?.[champion.id]?.skins;
    if (!Array.isArray(skins)) {
      throw new Error(`Data Dragon thiếu dữ liệu trang phục cho ${champion.name}.`);
    }

    const skinNumbers = skins
      .map((skin) => skin.num)
      .filter((skinNumber) => Number.isSafeInteger(skinNumber) && skinNumber > 0);
    if (!skinNumbers.length) {
      throw new Error(`Data Dragon thiếu skin thay thế cho ${champion.name}.`);
    }
    return skinNumbers;
  })();
  splashSkinsByChampionId.set(champion.id, pendingSkins);

  try {
    return await pendingSkins;
  } catch (error) {
    splashSkinsByChampionId.delete(champion.id);
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
    const skinNumbers = await getSplashSkinNumbers(champion);
    return {
      kind: 'splash',
      imageUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${encodeURIComponent(champion.id)}_${skinNumbers[randomInt(skinNumbers.length)]}.jpg`,
      cropX: randomInt(2) * 100,
      cropY: randomInt(2) * 100,
    };
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

    const scoreId = normalizePlayerName(playerName);
    const room = {
      code: makeRoomCode(),
      players: new Map([[socket.id, { name: playerName, scoreId, ready: false, targetId: null, lastChatAt: 0 }]]),
      scores: new Map([[scoreId, { id: scoreId, name: playerName, score: 0 }]]),
      matchHistory: [],
      phase: 'lobby',
      gameMode,
      nextStarterScoreId: scoreId,
      sharedTargetId: null,
      sharedModeHint: null,
      revealedSkillHints: [],
      revealedEmojiCount: 0,
      abilityColorRevealed: false,
      hintNextAt: gameMode === 'ability' ? 6 : gameMode === 'emoji' ? 3 : 7,
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
    if (!playerName) return sendError(ack, 'Hãy nhập tên hiển thị của bạn.');
    const room = rooms.get(roomCode);
    if (!room) return sendError(ack, 'Không tìm thấy phòng. Hãy kiểm tra lại mã.');
    if (room.players.size >= 2) return sendError(ack, 'Phòng đã đủ 2 người chơi.');
    const scoreId = normalizePlayerName(playerName);
    if ([...room.players.values()].some((player) => player.scoreId === scoreId)) {
      return sendError(ack, 'Hai người chơi cần có tên khác nhau.');
    }
    clearRoomExpiry(room);
    room.players.set(socket.id, { name: playerName, scoreId, ready: false, targetId: null, lastChatAt: 0 });
    const [playerOne, playerTwo] = [...room.players.values()];
    const matchup = getOrCreateMatchup(playerOne, playerTwo);
    const firstScore = playerOne.scoreId === matchup.player_one_key
      ? matchup.player_one_score
      : matchup.player_two_score;
    const secondScore = playerTwo.scoreId === matchup.player_two_key
      ? matchup.player_two_score
      : matchup.player_one_score;
    room.scores.set(playerOne.scoreId, { id: playerOne.scoreId, name: playerOne.name, score: firstScore });
    room.scores.set(playerTwo.scoreId, { id: playerTwo.scoreId, name: playerTwo.name, score: secondScore });
    room.matchHistory = getMatchHistory(matchup.player_one_key, matchup.player_two_key);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    ack?.({ ok: true, room: publicState(room, socket.id) });
    broadcastState(room);
  });

  socket.on('room:mode', ({ gameMode } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(socket.id)) return sendError(ack, 'Bạn không ở trong phòng.');
    if (room.phase !== 'lobby' || room.starting) {
      return sendError(ack, 'Chỉ có thể đổi chế độ chơi khi phòng đang chờ.');
    }
    if (!gameModes.has(gameMode)) return sendError(ack, 'Chế độ chơi không hợp lệ.');
    if (room.gameMode === gameMode) return ack?.({ ok: true });

    room.gameMode = gameMode;
    resetMatch(room);
    ack?.({ ok: true });
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
        room.revealedEmojiCount = sharedModeHint?.kind === 'emoji' ? 1 : 0;
        room.abilityColorRevealed = false;
        room.hintNextAt = room.gameMode === 'ability' ? 6 : room.gameMode === 'emoji' ? 3 : 7;
        room.pendingHintId = null;
        room.starting = false;
      }

      room.phase = 'playing';
      room.log = [];
      const firstPlayerId = [...room.players.entries()]
        .find(([, candidate]) => candidate.scoreId === room.nextStarterScoreId)?.[0]
        ?? room.players.keys().next().value;
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
    if (room.gameMode === 'emoji') {
      if (room.revealedEmojiCount >= room.sharedModeHint.emojis.length) {
        return sendError(ack, 'Đã mở đủ emoji.');
      }
      room.revealedEmojiCount += 1;
      room.hintNextAt = wrongGuessCount + 3;
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
      try {
        recordMatch(room, player);
      } catch (error) {
        room.log.pop();
        console.error(`Không lưu được điểm trận đấu trong phòng ${room.code}:`, error);
        return sendError(ack, 'Không lưu được điểm trận đấu. Hãy thử lại.');
      }
      clearTurnTimer(room);
      room.phase = 'finished';
      room.winnerId = socket.id;
      room.nextStarterScoreId = player.scoreId;
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
