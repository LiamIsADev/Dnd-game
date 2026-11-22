// Import/export file format checks. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseImport, EXPORT_FORMAT, normalize } from '../src/lib/character/store.js';

test('round-trips an exported character', () => {
  const character = { ...normalize({}), name: 'Elara', classId: 'wizard', level: 3 };
  const file = JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), character });
  const back = parseImport(file);
  assert.equal(back.name, 'Elara');
  assert.equal(back.classId, 'wizard');
  assert.equal(back.level, 3);
  assert.deepEqual(back.coins, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
});

test('rejects files that are not characters', () => {
  assert.throws(() => parseImport('not json'), /isn't a character file/);
  assert.throws(() => parseImport('{"hello": 1}'), /isn't a character file/);
  assert.throws(() => parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 2, character: {} })), /newer version/);
});

test('fills in missing fields from older saves', () => {
  const c = normalize({ name: 'Old', inventory: 'oops' });
  assert.deepEqual(c.inventory, []);
  assert.deepEqual(c.spells, { cantrips: [], prepared: [] });
});
