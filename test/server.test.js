import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as createClient } from 'socket.io-client';

const serverFile = fileURLToPath(new URL('../server.js', import.meta.url));
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForState(client, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const current = client.lastRoomState;
    if (current && predicate(current)) return resolve(current);

    const timer = setTimeout(() => {
      client.off('room:state', onState);
      const state = client.lastRoomState;
      const lastGuess = state?.log?.at(-1);
      reject(new Error(`Timed out waiting for room state (phase: ${state?.phase ?? 'none'}, turns: ${state?.log?.length ?? 'none'}, last guess: ${lastGuess?.championName ?? 'none'} by ${lastGuess?.playerId ?? 'none'}).`));
    }, timeout);
    function onState(state) {
      client.lastRoomState = state;
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.off('room:state', onState);
      resolve(state);
    }
    client.on('room:state', onState);
  });
}

function emitAck(client, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)), 5000);
    client.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (!response?.ok) reject(new Error(response?.error ?? `${event} failed.`));
      else resolve(response);
    });
  });
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const client = createClient(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    client.once('connect', () => {
      client.on('room:state', (state) => { client.lastRoomState = state; });
      resolve(client);
    });
    client.once('connect_error', reject);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

test('two players can create a room, alternate guesses, and finish a round', { timeout: 60000 }, async (t) => {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'rift-riddle-test-'));
  const child = spawn(process.execPath, [serverFile], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(port), RIFT_RIDDLE_DB_PATH: join(dataDirectory, 'scores.sqlite') },
    stdio: 'ignore',
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await stopServer(child);
    await rm(dataDirectory, { recursive: true, force: true });
  });

  let champions;
  const startupDeadline = Date.now() + 30000;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null) throw new Error(`Game server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/champions`);
      if (response.ok) {
        champions = (await response.json()).champions;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(champions?.length, 'server should load the champion catalogue');
  assert.ok(champions.every((champion) => !('image' in champion)), 'champion catalogue should not include image data');

  const annie = champions.find((champion) => champion.name === 'Annie');
  const ashe = champions.find((champion) => champion.name === 'Ashe');
  const wrongGuess = champions.find((champion) => champion.id === 'Ahri');
  assert.ok(annie && ashe && wrongGuess, 'catalogue should include champions for a round');

  const first = await connectClient(url);
  const second = await connectClient(url);
  clients.push(first, second);

  const created = await emitAck(first, 'room:create', { name: 'Người chơi A', timerSeconds: 15 });
  assert.equal(created.room.gameMode, 'classic');
  const joined = await emitAck(second, 'room:join', { name: 'Người chơi B', code: created.room.code });
  assert.equal(joined.room.players.length, 2);
  assert.equal(joined.room.timerSeconds, 15);

  const incomingMessage = new Promise((resolve) => second.once('room:chat-message', resolve));
  await emitAck(first, 'room:chat:send', { text: 'Chúc bạn may mắn!' });
  const chatMessage = await incomingMessage;
  assert.equal(chatMessage.playerName, 'Người chơi A');
  assert.equal(chatMessage.text, 'Chúc bạn may mắn!');

  await emitAck(first, 'room:choose', { championId: annie.id });
  const stateAfterChoose = await waitForState(first, (state) => state.players.find((player) => player.isSelf)?.ownChampion === 'Annie');
  assert.equal(stateAfterChoose.chatMessages[0].text, 'Chúc bạn may mắn!');
  await emitAck(second, 'room:choose', { championId: ashe.id });
  await emitAck(first, 'room:ready', {});

  const changedModeForFirst = waitForState(first, (state) => state.gameMode === 'emoji');
  const changedModeForSecond = waitForState(second, (state) => state.gameMode === 'emoji');
  await emitAck(second, 'room:mode', { gameMode: 'emoji' });
  const [emojiLobbyFirst, emojiLobbySecond] = await Promise.all([changedModeForFirst, changedModeForSecond]);
  assert.ok(emojiLobbyFirst.players.every((player) => !player.ready));
  assert.ok(emojiLobbySecond.players.every((player) => !player.ready));
  assert.ok(emojiLobbyFirst.players.every((player) => player.ownChampion === null));
  assert.ok(emojiLobbySecond.players.every((player) => player.ownChampion === null));

  const restoredModeForFirst = waitForState(first, (state) => state.gameMode === 'classic');
  const restoredModeForSecond = waitForState(second, (state) => state.gameMode === 'classic');
  await emitAck(first, 'room:mode', { gameMode: 'classic' });
  await Promise.all([restoredModeForFirst, restoredModeForSecond]);
  await emitAck(first, 'room:choose', { championId: annie.id });
  await emitAck(second, 'room:choose', { championId: ashe.id });

  await emitAck(first, 'room:ready', {});
  await emitAck(second, 'room:ready', {});

  const started = await waitForState(first, (state) => state.phase === 'playing');
  assert.equal(started.turnPlayerId, first.id);
  assert.equal(started.log.length, 0);
  assert.ok(started.turnExpiresAt > Date.now());
  await assert.rejects(
    emitAck(first, 'room:mode', { gameMode: 'emoji' }),
    /Chỉ có thể đổi chế độ chơi khi phòng đang chờ/,
  );
  await assert.rejects(emitAck(first, 'room:hint', {}), /Mode Cổ điển không có gợi ý/);

  const firstTurnPlayerId = started.turnPlayerId;
  const firstTurnClient = firstTurnPlayerId === first.id ? first : second;
  const otherClient = firstTurnClient === first ? second : first;
  const afterTimeout = waitForState(first, (state) => state.log.length === 1 && state.log[0].type === 'timeout', 20000);
  const timeoutResult = await afterTimeout;
  assert.equal(timeoutResult.turnPlayerId, otherClient.id);

  const afterWrongGuess = waitForState(first, (state) => state.log.length === 2);
  await emitAck(otherClient, 'room:guess', { championId: wrongGuess.id });
  const wrongResult = await afterWrongGuess;
  assert.equal(wrongResult.log[1].isCorrect, false);
  assert.deepEqual(wrongResult.log[1].clues[2], {
    label: 'Chủng loài',
    status: 'wrong',
    value: 'Vastayan',
  });
  assert.equal(wrongResult.turnPlayerId, firstTurnClient.id);
  await assert.rejects(emitAck(firstTurnClient, 'room:guess', { championId: wrongGuess.id }), /đã được đoán trong ván đấu/);

  const targetForOther = firstTurnClient === first ? ashe : annie;
  const afterWin = waitForState(first, (state) => state.phase === 'finished');
  await emitAck(firstTurnClient, 'room:guess', { championId: targetForOther.id });
  const finished = await afterWin;
  assert.equal(finished.winnerId, firstTurnClient.id);
  assert.equal(finished.log.at(-1).isCorrect, true);
  assert.deepEqual(finished.revealedTargets.map((item) => item.champion).sort(), ['Annie', 'Ashe']);
  assert.equal(finished.players.find((player) => player.id === firstTurnClient.id).score, 1);
  assert.equal(finished.players.find((player) => player.id === otherClient.id).score, 0);
  assert.equal(finished.matchHistory.length, 1);
  assert.equal(finished.matchHistory[0].winnerName, finished.players.find((player) => player.id === firstTurnClient.id).name);
  assert.deepEqual(
    finished.matchHistory[0].scores.map(({ score }) => score).sort(),
    [0, 1],
  );

  const rematchStatePromise = waitForState(first, (state) => state.phase === 'lobby');
  await emitAck(firstTurnClient, 'room:rematch', {});
  const rematchState = await rematchStatePromise;
  assert.deepEqual(rematchState.players.map(({ score }) => score).sort(), [0, 1]);
  assert.equal(rematchState.matchHistory.length, 1);
  await emitAck(first, 'room:choose', { championId: annie.id });
  await emitAck(second, 'room:choose', { championId: ashe.id });
  await emitAck(first, 'room:ready', {});
  await emitAck(second, 'room:ready', {});
  const rematchStarted = await waitForState(first, (state) => state.phase === 'playing');
  assert.equal(rematchStarted.turnPlayerId, firstTurnClient.id);

  const emojiHost = await connectClient(url);
  const emojiGuest = await connectClient(url);
  clients.push(emojiHost, emojiGuest);
  const emojiRoom = await emitAck(emojiHost, 'room:create', { name: 'Emoji A', gameMode: 'emoji' });
  await emitAck(emojiGuest, 'room:join', { name: 'Emoji B', code: emojiRoom.room.code });
  await assert.rejects(emitAck(emojiHost, 'room:choose', { championId: annie.id }), /tướng ngẫu nhiên chung/);
  await emitAck(emojiHost, 'room:ready', {});
  await emitAck(emojiGuest, 'room:ready', {});
  const emojiStarted = await waitForState(emojiHost, (state) => state.phase === 'playing');
  assert.equal(emojiStarted.gameMode, 'emoji');
  assert.equal(emojiStarted.modeHint.kind, 'emoji');
  assert.equal(emojiStarted.modeHint.emojis.length, 1);
  assert.equal(emojiStarted.nextHintAt, 3);
  assert.equal(emojiStarted.hintAvailable, false);
  assert.ok(emojiStarted.emojiHintsRemaining > 0);
  assert.equal(emojiStarted.players.find((player) => player.isSelf).ownChampion, null);

  const { champions: championCatalogue } = JSON.parse(
    await readFile(new URL('../data/champions.json', import.meta.url), 'utf8'),
  );
  const regionEmojis = {
    'Bandle City': '🎪', Bilgewater: '🏴‍☠️', Demacia: '🏰', Freljord: '❄️', Ionia: '🌸',
    Ixtal: '🌿', Noxus: '🟥', Piltover: '⚙️', 'Shadow Isles': '👻', Shurima: '🌞',
    Targon: '⛰️', 'The Void': '🟣', Zaun: '🧪', Runeterra: '🌍',
  };
  const roleEmojis = {
    Assassin: '🗡️', Fighter: '⚔️', Mage: '🔮', Marksman: '🏹', Support: '✨', Tank: '🛡️',
  };
  const guessesWithDifferentFirstEmoji = championCatalogue
    .filter((champion) => {
      const firstEmoji = regionEmojis[champion.metadata.regions?.[0]] ?? roleEmojis[champion.tags?.[0]];
      return firstEmoji !== emojiStarted.modeHint.emojis[0];
    })
    .slice(0, 3);
  assert.equal(guessesWithDifferentFirstEmoji.length, 3);
  let emojiState = emojiStarted;
  for (const champion of guessesWithDifferentFirstEmoji) {
    const guessingClient = emojiState.turnPlayerId === emojiHost.id ? emojiHost : emojiGuest;
    const nextState = waitForState(emojiHost, (state) => state.log.length === emojiState.log.length + 1);
    await emitAck(guessingClient, 'room:guess', { championId: champion.id });
    emojiState = await nextState;
  }
  assert.equal(emojiState.hintAvailable, true);
  const secondEmojiState = waitForState(emojiHost, (state) => state.modeHint.emojis.length === 2);
  await emitAck(emojiHost, 'room:hint', {});
  emojiState = await secondEmojiState;
  assert.equal(emojiState.modeHint.emojis.length, 2);
  assert.equal(emojiState.nextHintAt, 6);
  assert.equal(emojiState.hintAvailable, false);
  assert.equal(emojiState.emojiHintsRemaining, emojiStarted.emojiHintsRemaining - 1);

  const randomHost = await connectClient(url);
  const randomGuest = await connectClient(url);
  clients.push(randomHost, randomGuest);
  const randomRoom = await emitAck(randomHost, 'room:create', { name: 'Random A', gameMode: 'random' });
  await emitAck(randomGuest, 'room:join', { name: 'Random B', code: randomRoom.room.code });
  await emitAck(randomHost, 'room:ready', {});
  await emitAck(randomGuest, 'room:ready', {});
  const randomStarted = await waitForState(randomHost, (state) => state.phase === 'playing');
  assert.equal(randomStarted.gameMode, 'random');
  assert.equal(randomStarted.modeHint, null);
  assert.ok(randomStarted.players.every((player) => player.ownChampion === null));
  assert.equal(randomStarted.hintAvailable, false);
  assert.deepEqual(randomStarted.revealedSkillHints, []);
  await assert.rejects(emitAck(randomHost, 'room:hint', {}), /Cần thêm 7 lượt đoán sai/);

  const randomTurnClient = randomStarted.turnPlayerId === randomHost.id ? randomHost : randomGuest;
  const randomGuessResult = waitForState(randomHost, (state) => state.log.length === 1);
  await emitAck(randomTurnClient, 'room:guess', { championId: annie.id });
  const randomGuessed = await randomGuessResult;
  assert.equal(randomGuessed.log[0].championName, 'Annie');
  assert.equal(randomGuessed.log[0].clues.length, 7);

  const unsupportedModeClient = await connectClient(url);
  clients.push(unsupportedModeClient);
  await assert.rejects(
    emitAck(unsupportedModeClient, 'room:create', { name: 'Unsupported quote mode', gameMode: 'quote' }),
    /Chế độ chơi không hợp lệ/,
  );

  for (const gameMode of ['splash', 'ability']) {
    const modeClient = await connectClient(url);
    clients.push(modeClient);
    const modeRoom = await emitAck(modeClient, 'room:create', { name: `${gameMode} host`, gameMode });
    assert.equal(modeRoom.room.gameMode, gameMode);
    if (gameMode === 'splash') {
      const modeGuest = await connectClient(url);
      clients.push(modeGuest);
      await emitAck(modeGuest, 'room:join', { name: 'Splash guest', code: modeRoom.room.code });
      await emitAck(modeClient, 'room:ready', {});
      const splashStartedPromise = waitForState(modeClient, (state) => state.phase === 'playing');
      await emitAck(modeGuest, 'room:ready', {});
      const splashStarted = await splashStartedPromise;
      assert.equal(splashStarted.modeHint.kind, 'splash');
      assert.match(splashStarted.modeHint.imageUrl, /\/cdn\/img\/champion\/splash\/.+_[1-9]\d*\.jpg$/);
      assert.ok([0, 100].includes(splashStarted.modeHint.cropX));
      assert.ok([0, 100].includes(splashStarted.modeHint.cropY));
    }
  }

  const leaveHost = await connectClient(url);
  const leaveGuest = await connectClient(url);
  clients.push(leaveHost, leaveGuest);
  const leaveRoom = await emitAck(leaveHost, 'room:create', { name: 'Leave host' });
  await emitAck(leaveGuest, 'room:join', { name: 'Leave guest', code: leaveRoom.room.code });
  const waitingAfterLeave = waitForState(leaveHost, (state) => state.players.length === 1);
  await emitAck(leaveGuest, 'room:leave', {});
  const waitingRoom = await waitingAfterLeave;
  assert.equal(waitingRoom.phase, 'lobby');
  assert.equal(waitingRoom.players.length, 1);

  const rejoiningClient = await connectClient(url);
  clients.push(rejoiningClient);
  const rejoinedRoom = await emitAck(rejoiningClient, 'room:join', {
    name: 'Rejoined player',
    code: leaveRoom.room.code,
  });
  assert.equal(rejoinedRoom.room.players.length, 2);
});

test('scores and match history survive a server restart', { timeout: 30000 }, async (t) => {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'rift-riddle-persistence-test-'));
  const databasePath = join(dataDirectory, 'scores.sqlite');
  const clients = [];
  let child;
  const startServer = () => spawn(process.execPath, [serverFile], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(port), RIFT_RIDDLE_DB_PATH: databasePath },
    stdio: 'ignore',
  });
  const waitUntilReady = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Game server exited with code ${child.exitCode}.`);
      try {
        const response = await fetch(`${url}/api/champions`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the game server.');
  };
  t.after(async () => {
    for (const client of clients) client.disconnect();
    if (child) await stopServer(child);
    await rm(dataDirectory, { recursive: true, force: true });
  });

  child = startServer();
  await waitUntilReady();
  const host = await connectClient(url);
  const guest = await connectClient(url);
  clients.push(host, guest);
  const created = await emitAck(host, 'room:create', { name: 'Kun' });
  await emitAck(guest, 'room:join', { name: 'Da', code: created.room.code });
  const championsResponse = await fetch(`${url}/api/champions`);
  const { champions } = await championsResponse.json();
  const annie = champions.find((champion) => champion.name === 'Annie');
  const ashe = champions.find((champion) => champion.name === 'Ashe');
  await emitAck(host, 'room:choose', { championId: annie.id });
  await emitAck(guest, 'room:choose', { championId: ashe.id });
  await emitAck(host, 'room:ready', {});
  await emitAck(guest, 'room:ready', {});
  const started = await waitForState(host, (state) => state.phase === 'playing');
  const winner = started.turnPlayerId === host.id ? host : guest;
  const targetChampionId = winner === host ? ashe.id : annie.id;
  const finishedPromise = waitForState(host, (state) => state.phase === 'finished');
  await emitAck(winner, 'room:guess', { championId: targetChampionId });
  const finished = await finishedPromise;
  assert.equal(finished.matchHistory.length, 1);
  assert.equal(finished.players.find((player) => player.id === winner.id).score, 1);
  const expectedWinnerName = winner === host ? 'Kun' : 'Da';

  host.disconnect();
  guest.disconnect();
  await stopServer(child);
  child = startServer();
  await waitUntilReady();

  const restoredHost = await connectClient(url);
  const restoredGuest = await connectClient(url);
  clients.push(restoredHost, restoredGuest);
  const newRoom = await emitAck(restoredHost, 'room:create', { name: 'KUN' });
  const guestRestore = await emitAck(restoredGuest, 'room:join', {
    name: 'dA',
    code: newRoom.room.code,
  });
  assert.deepEqual(
    guestRestore.room.players.map((player) => player.score).sort(),
    [0, 1],
  );
  assert.equal(guestRestore.room.matchHistory.length, 1);
  assert.equal(guestRestore.room.matchHistory[0].winnerName, expectedWinnerName);

  const differentOpponent = await connectClient(url);
  clients.push(differentOpponent);
  const otherPairRoom = await emitAck(differentOpponent, 'room:create', { name: 'kUn' });
  const duplicateNamePlayer = await connectClient(url);
  clients.push(duplicateNamePlayer);
  await assert.rejects(
    emitAck(duplicateNamePlayer, 'room:join', { name: 'KUN', code: otherPairRoom.room.code }),
    /Hai người chơi cần có tên khác nhau/,
  );
  const anotherGuest = await connectClient(url);
  clients.push(anotherGuest);
  const otherPair = await emitAck(anotherGuest, 'room:join', {
    name: 'Duc Anh',
    code: otherPairRoom.room.code,
  });
  assert.deepEqual(otherPair.room.players.map((player) => player.score), [0, 0]);
  assert.equal(otherPair.room.matchHistory.length, 0);
});
