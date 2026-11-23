// Rules automation helpers: spells, monsters, XP and levelling up. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newCharacter, derive } from '../src/lib/character/rules.js';
import {
  spellMechanics, castableSpells, damageTypesFrom, monsterSecrets, characterSecrets,
  levelForXp, canLevelUp, levelUpInfo, applyLevelUp, XP_FOR_LEVEL, monsterActions, combatStats, classBonusActions, walkSpeed,
} from '../src/lib/character/automation.js';
import { areaGeometry, tokensInArea } from '../src/lib/campaign/areas.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../public/data/srd/${n}.json`, import.meta.url)));
const srd = Object.fromEntries(['classes', 'species', 'backgrounds', 'feats', 'equipment', 'spells'].map((n) => [n, load(n)]));
const monsters = load('monsters');
const spell = (id) => srd.spells.find((s) => s.id === id);

function fighter(extra = {}) {
  return {
    ...newCharacter(), name: 'Test', classId: 'fighter', speciesId: 'human', backgroundId: 'soldier', level: 3,
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    backgroundBonus: { mode: '2-1', plus2: 'str', plus1: 'con' }, ...extra,
  };
}

test('attack spells and cantrip scaling', () => {
  const fb = spellMechanics(spell('fire-bolt'), { casterLevel: 1 });
  assert.deepEqual([fb.kind, fb.attackType, fb.damage, fb.damageType], ['attack', 'ranged', '1d10', 'Fire']);
  assert.equal(spellMechanics(spell('fire-bolt'), { casterLevel: 5 }).damage, '2d10');
  assert.equal(spellMechanics(spell('fire-bolt'), { casterLevel: 17 }).damage, '4d10');
  const gb = spellMechanics(spell('guiding-bolt'), { slotLevel: 3 });
  assert.equal(gb.damage, '6d6');
});

test('save spells: half damage, conditions and upcasting', () => {
  const f = spellMechanics(spell('fireball'));
  assert.deepEqual([f.kind, f.save, f.half, f.damage, f.damageType], ['save', 'dex', true, '8d6', 'Fire']);
  assert.equal(spellMechanics(spell('fireball'), { slotLevel: 5 }).damage, '10d6');
  const sf = spellMechanics(spell('sacred-flame'), { casterLevel: 11 });
  assert.deepEqual([sf.save, sf.half, sf.damage], ['dex', false, '3d8']);
  const hp = spellMechanics(spell('hold-person'));
  assert.deepEqual([hp.kind, hp.save, hp.condition, hp.damage], ['save', 'wis', 'Paralyzed', undefined]);
  assert.equal(spellMechanics(spell('thunderwave')).save, 'con');
});

test('healing spells add the casting modifier and upcast', () => {
  const cw = spellMechanics(spell('cure-wounds'), { slotLevel: 2, castingMod: 3 });
  assert.deepEqual([cw.kind, cw.heal], ['heal', '4d8+3']);
  assert.equal(spellMechanics(spell('healing-word'), { castingMod: -1 }).heal, '2d4-1');
});

test('castable spells respect slots used', () => {
  const c = { ...newCharacter(), classId: 'wizard', level: 3, speciesId: 'human', backgroundId: 'sage', baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, spells: { cantrips: ['fire-bolt'], prepared: ['magic-missile'] }, slotsUsed: { 1: 4 } };
  const list = castableSpells(c, srd);
  const mm = list.find((x) => x.spell.id === 'magic-missile');
  assert.deepEqual(mm.levels, [1, 2]);
  assert.deepEqual(mm.open, [2], 'level 1 slots are all used');
  assert.deepEqual(list.find((x) => x.spell.id === 'fire-bolt').open, [0]);
});

test('monster resistances and secrets', () => {
  assert.deepEqual(damageTypesFrom('Fire, Poison; Poisoned'), ['Fire', 'Poison']);
  assert.deepEqual(damageTypesFrom('Bludgeoning, Piercing, Slashing'), ['Bludgeoning', 'Piercing', 'Slashing']);
  assert.deepEqual(damageTypesFrom(null), []);
  const ogre = monsters.find((m) => m.id === 'ogre');
  const s = monsterSecrets(ogre);
  assert.equal(s.hp_max, ogre.hp.average);
  assert.equal(s.ac, ogre.acValue);
  assert.equal(s.saves.str, ogre.abilities.str.save);
  assert.equal(s.xp, ogre.cr.xp);
  assert.equal(monsterSecrets(ogre, { hp: 70 }).hp_current, 70);
});

test('character secrets for the DM', () => {
  const s = characterSecrets(fighter(), srd);
  const d = derive(fighter(), srd);
  assert.equal(s.ac, d.ac);
  assert.equal(s.hp_max, d.hpMax);
  assert.equal(s.saves.str, d.saves.str.bonus);
  assert.equal(characterSecrets(fighter({ exhaustion: 2 }), srd).saves.str, d.saves.str.bonus - 4, 'exhaustion lowers saves');
});

test('XP thresholds', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(299), 1);
  assert.equal(levelForXp(300), 2);
  assert.equal(levelForXp(355000), 20);
  assert.equal(canLevelUp(fighter({ level: 3, xp: 2699 })), false);
  assert.equal(canLevelUp(fighter({ level: 3, xp: XP_FOR_LEVEL[4] })), true);
});

test('levelling up a fighter to 4: ASI, HP and features', () => {
  const c = fighter({ hp: { current: 20, temp: 0 } });
  const info = levelUpInfo(c, srd);
  assert.equal(info.level, 4);
  assert.equal(info.asi, true);
  assert.equal(info.hitDie, 10);
  const before = derive(c, srd);
  const next = applyLevelUp(c, srd, { hp: 'average', asi: { str: 2 } });
  const after = derive(next, srd);
  assert.equal(next.level, 4);
  assert.equal(after.scores.str, before.scores.str + 2);
  assert.equal(after.hpMax, before.hpMax + 6 + after.mods.con);
  assert.equal(next.hp.current, 20 + (after.hpMax - before.hpMax), 'current HP rises with max HP');
  assert.throws(() => applyLevelUp(c, srd, { asi: { str: 2, dex: 1 } }), /\+2 to one score/);
});

test('rolled hit points and feats', () => {
  const c = fighter();
  const next = applyLevelUp(c, srd, { hp: 3, feat: 'Grappler' });
  assert.equal(derive(next, srd).hpMax, derive(c, srd).hpMax + 3 + derive(c, srd).mods.con);
  assert.ok(derive(next, srd).feats.some((f) => f.name === 'Grappler'));
});

test('subclass is chosen at level 3', () => {
  const c = fighter({ level: 2, subclassId: null });
  const info = levelUpInfo(c, srd);
  assert.equal(info.needsSubclass, true);
  const next = applyLevelUp(c, srd, { hp: 'average', subclassId: 'champion' });
  assert.equal(next.subclassId, 'champion');
  assert.ok(derive(next, srd).features.some((f) => f.name === 'Improved Critical'));
});

test('casters learn about new spell levels', () => {
  const wiz = { ...newCharacter(), classId: 'wizard', level: 2, speciesId: 'human', backgroundId: 'sage', baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } };
  const info = levelUpInfo(wiz, srd);
  assert.equal(info.spells.newSlotLevel, 2);
  assert.ok(info.spells.prepared >= 1);
});

test('monster actions: attacks, extra damage and breath weapons', () => {
  const goblin = monsterActions(monsters.find((m) => m.id === 'goblin-warrior'));
  assert.deepEqual(goblin[0], { name: 'Scimitar', kind: 'attack', bonus: 4, damage: '1d6+2', damageType: 'Slashing', extra: [], rider: null });
  const ghoul = monsterActions(monsters.find((m) => m.id === 'ghoul'));
  assert.deepEqual(ghoul[0].extra, [{ dice: '1d6', type: 'Necrotic' }], 'bite always adds necrotic damage');
  assert.deepEqual(ghoul[1].rider, { ability: 'con', dc: 10 });
  const dragon = monsterActions(monsters.find((m) => m.id === 'adult-red-dragon'));
  const breath = dragon.find((a) => a.kind === 'save');
  assert.deepEqual([breath.save, breath.dc, breath.damage, breath.damageType, breath.half], ['dex', 21, '17d6', 'Fire', true]);
  assert.deepEqual(dragon.find((a) => a.name === 'Rend').extra, [{ dice: '2d4', type: 'Fire' }]);
});

test('how a spell is cast, its area and how many it can target', () => {
  assert.equal(spellMechanics(spell('healing-word')).use, 'bonus');
  assert.equal(spellMechanics(spell('shield')).use, 'reaction');
  assert.equal(spellMechanics(spell('fireball')).use, 'action');
  assert.deepEqual(spellMechanics(spell('fireball')).area, { shape: 'circle', size: 20, self: false });
  assert.equal(spellMechanics(spell('burning-hands')).area.shape, 'cone');
  assert.deepEqual(spellMechanics(spell('lightning-bolt')).area, { shape: 'line', size: 100, width: 5, self: true });
  assert.equal(spellMechanics(spell('thunderwave')).area.shape, 'cube');
  assert.equal(spellMechanics(spell('fire-bolt')).targets, 1, 'single-target spells hit one creature');
  assert.equal(spellMechanics(spell('sacred-flame')).targets, 1);
  const mm = spellMechanics(spell('magic-missile'));
  assert.equal(mm.kind, 'auto', 'Magic Missile always hits');
  assert.equal(mm.targets, 3);
  assert.equal(mm.repeat, true);
  assert.equal(spellMechanics(spell('magic-missile'), { slotLevel: 3 }).targets, 5, 'one more dart per slot level');
  assert.equal(spellMechanics(spell('scorching-ray')).targets, 3);
  assert.equal(spellMechanics(spell('eldritch-blast'), { casterLevel: 1 }).targets, 1);
  assert.equal(spellMechanics(spell('eldritch-blast'), { casterLevel: 11 }).targets, 3);
  assert.equal(spellMechanics(spell('hold-person'), { slotLevel: 4 }).targets, 3, 'Hold Person: one more Humanoid per slot level');
  assert.equal(spellMechanics(spell('mass-healing-word')).targets, 6);
});

test('spell areas on the grid', () => {
  const tok = (id, x, y, size = 1) => ({ id, x, y, size });
  // A 20-foot Fireball centred on the corner at (5, 5) catches squares within 4 squares.
  const fb = areaGeometry({ shape: 'circle', size: 20, self: false }, null, { x: 5.2, y: 4.9 });
  assert.deepEqual([fb.x, fb.y, fb.r], [5, 5, 4]);
  const ids = tokensInArea(fb, [tok('a', 5, 5), tok('b', 8, 5), tok('c', 9, 5), tok('d', 1, 1)]).map((t) => t.id);
  assert.deepEqual(ids, ['a', 'b']);
  // A 15-foot cone from a caster at (0, 0) pointing right.
  const caster = tok('me', 0, 0);
  const cone = areaGeometry({ shape: 'cone', size: 15, self: true }, caster, { x: 5, y: 0.5 });
  const inCone = tokensInArea(cone, [caster, tok('a', 1, 0), tok('b', 3, 0), tok('c', 4, 0), tok('d', 0, 3)], 'me').map((t) => t.id);
  assert.deepEqual(inCone, ['a', 'b'], 'the cone reaches 3 squares and leaves out the caster');
  // A 15-foot Thunderwave cube on the caster's right side.
  const cube = areaGeometry({ shape: 'cube', size: 15, self: true }, tok('me', 5, 5), { x: 9, y: 5.5 });
  assert.deepEqual([cube.x, cube.y, cube.n], [6, 4, 3]);
  // A 100-foot line from (0, 0) to the right is one square wide.
  const line = areaGeometry({ shape: 'line', size: 100, width: 5, self: true }, caster, { x: 10, y: 0.5 });
  assert.deepEqual(tokensInArea(line, [tok('a', 7, 0), tok('b', 7, 1)], 'me').map((t) => t.id), ['a']);
});

test('what a character can do in a turn', () => {
  const f3 = combatStats(fighter(), srd);
  assert.equal(f3.speed, 30);
  assert.equal(f3.attacks, 1);
  assert.equal(f3.actionSurge, 1);
  assert.equal(f3.secondWind, 2);
  assert.equal(combatStats(fighter({ level: 5 }), srd).attacks, 2, 'Extra Attack at level 5');
  assert.equal(combatStats(fighter({ level: 11 }), srd).attacks, 3);
  const monk = { ...fighter(), classId: 'monk', inventory: [] };
  assert.equal(derive({ ...monk, level: 2 }, srd).speed, 40, 'Unarmored Movement +10 ft.');
  assert.equal(derive({ ...monk, level: 10 }, srd).speed, 50);
  assert.equal(classBonusActions({ ...monk, level: 1 }, srd).martialArts, true);
  const barb = { ...fighter(), classId: 'barbarian', inventory: [] };
  assert.equal(derive({ ...barb, level: 5 }, srd).speed, 40, 'Fast Movement +10 ft.');
  assert.ok(combatStats({ ...barb, level: 3 }, srd).rage >= 2);
  assert.equal(classBonusActions({ ...fighter(), classId: 'rogue', level: 2 }, srd).cunning, true);
  assert.equal(walkSpeed('10 ft., Swim 40 ft.'), 10);
});
