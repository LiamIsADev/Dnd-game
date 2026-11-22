// Live table helpers: fog of war, dice text, token sizes. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyFog, fitFog, isRevealed, circleCells, paintCircle, countRevealed } from '../src/lib/campaign/fog.js';
import { squaresForSize, initials, describeRoll, isValidDice, cleanDice, withMod, inviteLink } from '../src/lib/campaign/util.js';

test('fog starts hidden and reveals a circle like the database does', () => {
  let fog = emptyFog(10, 10);
  assert.equal(fog.length, 100);
  assert.equal(countRevealed(fog), 0);
  fog = paintCircle(fog, 10, 10, 1, 0, 2);
  assert.ok(isRevealed(fog, 10, 10, 1, 0));
  assert.ok(isRevealed(fog, 10, 10, 1, 2));
  assert.ok(!isRevealed(fog, 10, 10, 3, 2), 'corner outside the circle stays hidden');
  // Same squares as reveal_circle(mid, 1, 0, 2) in the database.
  assert.equal(countRevealed(fog), circleCells(1, 0, 2, 10, 10).length);
  assert.equal(countRevealed(fog), 8);
  fog = paintCircle(fog, 10, 10, 1, 0, 0, false);
  assert.ok(!isRevealed(fog, 10, 10, 1, 0), 'DM can hide squares again');
});

test('fog never goes outside the map', () => {
  assert.equal(circleCells(0, 0, 3, 4, 4).every(([x, y]) => x >= 0 && y >= 0 && x < 4 && y < 4), true);
  assert.equal(isRevealed('1111', 2, 2, 5, 5), false);
  assert.equal(fitFog('11', 2, 2), '1100');
  assert.equal(fitFog('11x11', 2, 2), '1101');
});

test('creature sizes take up the right number of squares', () => {
  assert.equal(squaresForSize(['Medium']), 1);
  assert.equal(squaresForSize(['Small']), 1);
  assert.equal(squaresForSize(['Large']), 2);
  assert.equal(squaresForSize('Huge'), 3);
  assert.equal(squaresForSize(['Gargantuan']), 4);
});

test('token initials', () => {
  assert.equal(initials('Goblin'), 'GO');
  assert.equal(initials('Adult Red Dragon'), 'AD');
  assert.equal(initials(''), '?');
});

test('roll text shows dropped dice', () => {
  const row = { detail: [{ dice: [4, 17], kept: [17], sides: 20, sign: 1 }, { value: 5, sign: 1 }] };
  assert.equal(describeRoll(row), '2d20 (~~4~~, 17) + 5');
  assert.equal(describeRoll({ detail: [{ dice: [3, 3], kept: [3, 3], sides: 6, sign: 1 }, { value: 1, sign: -1 }] }), '2d6 (3, 3) − 1');
});

test('dice box accepts normal dice and rejects junk', () => {
  assert.equal(cleanDice('2D6 + 3'), '2d6+3');
  for (const ok of ['1d20', 'd20+5', '2d6 + 1d4 - 1', '4d6kh3', '7']) assert.ok(isValidDice(ok), ok);
  for (const bad of ['', 'hello', '1d20;drop', '1d', '++1d6']) assert.ok(!isValidDice(bad), bad);
  assert.equal(withMod('1d20', 5), '1d20+5');
  assert.equal(withMod('1d20', -2), '1d20-2');
  assert.equal(withMod('1d20', 0), '1d20');
});

test('invite links open the join page', () => {
  assert.equal(inviteLink('ABC234', 'https://example.com/'), 'https://example.com/#/join/ABC234');
});
