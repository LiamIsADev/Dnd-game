// Rules automation helpers: spells, monsters, XP and levelling up. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newCharacter, derive } from '../src/lib/character/rules.js';
import {
  spellMechanics, castableSpells, damageTypesFrom, monsterSecrets, characterSecrets,
  levelForXp, canLevelUp, levelUpInfo, applyLevelUp, XP_FOR_LEVEL, monsterActions,
} from '../src/lib/character/automation.js';

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
