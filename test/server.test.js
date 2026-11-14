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

  const annie = champions.find((champion) => champion.name === 'Annie');
  const ashe = champions.find((champion) => champion.name === 'Ashe');
  const wrongGuess = champions.find((champion) => champion.id !== annie.id && champion.id !== ashe.id);
  assert.ok(annie && ashe && wrongGuess, 'catalogue should include champions for a round');

  const first = await connectClient(url);
  const second = await connectClient(url);
  clients.push(first, second);

  const created = await emitAck(first, 'room:create', { name: 'Người chơi A', timerSeconds: 15 });
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
  assert.equal(wrongResult.turnPlayerId, firstTurnClient.id);

  const targetForOther = firstTurnClient === first ? ashe : annie;
  const afterWin = waitForState(first, (state) => state.phase === 'finished');
  await emitAck(firstTurnClient, 'room:guess', { championId: targetForOther.id });
  const finished = await afterWin;
  assert.equal(finished.winnerId, firstTurnClient.id);
  assert.equal(finished.log.at(-1).isCorrect, true);
  assert.deepEqual(finished.revealedTargets.map((item) => item.champion).sort(), ['Annie', 'Ashe']);
});
