import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClues } from '../src/game.js';

const champion = (overrides = {}) => ({
  gender: 'Female',
  positions: ['Mid'],
  species: ['Human'],
  resource: 'Mana',
  rangeType: 'Ranged',
  regions: ['Ionia'],
  releaseYear: 2011,
  ...overrides,
});

test('shows readable champion attributes and marks partial list matches', () => {
  const clues = buildClues(
    champion({ positions: ['Top', 'Mid'], species: ['Human', 'Spirit'], resource: 'Energy' }),
    champion({ positions: ['Mid', 'Bottom'], species: ['Human', 'Vastaya'], resource: 'Mana' }),
  );

  assert.deepEqual(clues.map((clue) => clue.label), [
    'Giới tính',
    'Vị trí',
    'Chủng loài',
    'Tài nguyên',
    'Tầm đánh',
    'Khu vực',
    'Năm ra mắt',
  ]);
  assert.equal(clues[1].status, 'partial');
  assert.equal(clues[2].status, 'partial');
  assert.equal(clues[3].status, 'wrong');
  assert.equal(clues[4].status, 'correct');
});

test('uses arrows only to explain whether the target champion is newer or older', () => {
  const clues = buildClues(
    champion({ releaseYear: 2012 }),
    champion({ releaseYear: 2015 }),
  );

  assert.equal(clues[6].status, 'higher');
  assert.equal(clues[6].value, '2012');
  assert.equal(buildClues(champion({ releaseYear: 2020 }), champion({ releaseYear: 2010 }))[6].status, 'lower');
});

test('treats list attributes as exact regardless of order', () => {
  const guess = champion({ regions: ['Ionia', 'Noxus'] });
  const target = champion({ regions: ['Noxus', 'Ionia'] });
  assert.equal(buildClues(guess, target)[5].status, 'correct');
});

test('marks unavailable metadata as unknown instead of a false match', () => {
  const clues = buildClues(champion({ resource: '' }), champion({ resource: '' }));
  assert.equal(clues[3].status, 'unknown');
});
