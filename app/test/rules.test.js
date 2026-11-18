'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/rules');

test('snake draft reverses every other round', () => {
  const order = Array.from({ length: 8 }, (_, i) => R.snakeSlot(i, 4));
  assert.deepStrictEqual(order, [0, 1, 2, 3, 3, 2, 1, 0]);
});

test('round robin pairs everyone once per cycle and gives byes for odd counts', () => {
  const weeks = R.roundRobin([1, 2, 3, 4, 5, 6], 5);
  const seen = new Set();
  for (const pairs of weeks) {
    const ids = pairs.flat();
    assert.strictEqual(new Set(ids).size, 6);
    for (const [a, b] of pairs) seen.add([a, b].sort().join('-'));
  }
  assert.strictEqual(seen.size, 15);
  const odd = R.roundRobin([1, 2, 3], 3);
  for (const pairs of odd) assert.strictEqual(pairs.filter(([, b]) => b === null).length, 1);
});

test('shuffle is deterministic per seed', () => {
  assert.deepStrictEqual(R.shuffle([1, 2, 3, 4, 5], 42), R.shuffle([1, 2, 3, 4, 5], 42));
});

test('standings give 3 points a win and break ties on HP left', () => {
  const members = [{ userId: 1, teamName: 'A' }, { userId: 2, teamName: 'B' }, { userId: 3, teamName: 'C' }];
  const t = R.standings(members, [
    { kind: 'regular', homeId: 1, awayId: 2, winnerId: 1, homeHp: 900, awayHp: 0 },
    { kind: 'regular', homeId: 3, awayId: 2, winnerId: 3, homeHp: 1500, awayHp: 0 },
    { kind: 'regular', homeId: 1, awayId: null, winnerId: null },
  ]);
  assert.deepStrictEqual(t.map((x) => x.userId), [3, 1, 2]);
  assert.strictEqual(t[0].points, 3);
});

test('settings are validated and clamped', () => {
  const s = R.normalizeSettings({ rosterSize: 8, poolRule: { type: 'habitats', habitats: ['forest', 'bogus'] } });
  assert.strictEqual(s.perBattle, 4);
  assert.deepStrictEqual(s.poolRule, { type: 'habitats', habitats: ['forest'] });
  assert.throws(() => R.normalizeSettings({ maxManagers: 9 }), /Max managers/);
  assert.throws(() => R.normalizeSettings({ statsUsed: 'mixed' }), /Stats used/);
});
