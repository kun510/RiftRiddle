import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
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

test('two players can create a room, alternate guesses, and finish a round', { timeout: 60000 }, async (t) => {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverFile], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  const clients = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
    child.kill();
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
  await emitAck(second, 'room:ready', {});

  const started = await waitForState(first, (state) => state.phase === 'playing');
  assert.equal(started.log.length, 0);
  assert.ok(started.turnExpiresAt > Date.now());
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
  assert.ok(emojiStarted.modeHint.emojis.length);
  assert.equal(emojiStarted.players.find((player) => player.isSelf).ownChampion, null);

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

  for (const gameMode of ['splash', 'quote', 'ability']) {
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
      assert.match(splashStarted.modeHint.imageUrl, /\/cdn\/img\/champion\/splash\/.+_0\.jpg$/);
      assert.ok(splashStarted.modeHint.cropX >= 20 && splashStarted.modeHint.cropX <= 80);
      assert.ok(splashStarted.modeHint.cropY >= 20 && splashStarted.modeHint.cropY <= 80);
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
