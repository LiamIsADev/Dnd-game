// Character rules, dice, and import/export checks. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrd } from '../scripts/build-srd.mjs';
import * as R from '../src/lib/character/rules.js';
import { roll, parseDice, critical, d20 } from '../src/lib/dice.js';

const data = await buildSrd();
const srd = {
  classes: data.classes,
  species: data.species,
  backgrounds: data.backgrounds,
  feats: data.feats,
  equipment: data.equipment,
  spells: data.spells,
};

function fighter() {
  const c = {
    ...R.newCharacter(),
    name: 'Brakka',
    classId: 'fighter',
    backgroundId: 'soldier',
    speciesId: 'dwarf',
    backgroundBonus: { mode: '2-1', plus2: 'str', plus1: 'con' },
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    classSkills: ['Perception', 'Survival'],
  };
  return { ...c, ...R.startingInventory(c, srd) };
}

test('dice: parsing and totals stay in range', () => {
  assert.deepEqual(parseDice('2d6+3'), [
    { count: 2, sides: 6, sign: 1, keepHighest: null },
    { value: 3, sign: 1 },
  ]);
  assert.throws(() => parseDice('2d6+x'));
  for (let i = 0; i < 500; i++) {
    const r = roll('2d6+3');
    assert.ok(r.total >= 5 && r.total <= 15);
    const s = roll('4d6kh3').total;
    assert.ok(s >= 3 && s <= 18);
  }
  assert.equal(critical('1d8+3'), '2d8+3');
  assert.equal(d20(-1), '1d20-1');
});

test('dice: advantage keeps the higher d20, disadvantage the lower', () => {
  const seq = [0.1, 0.9]; // faces 3 and 19
  const rngFrom = () => {
    let i = 0;
    return () => seq[i++ % seq.length];
  };
  assert.equal(roll('1d20+2', { mode: 'advantage', rng: rngFrom() }).total, 21);
  assert.equal(roll('1d20+2', { mode: 'disadvantage', rng: rngFrom() }).total, 5);
  assert.equal(roll('1d20', { mode: 'advantage', rng: rngFrom() }).natural, 19);
});

test('level-1 Dwarf Fighter (Soldier) numbers', () => {
  const c = fighter();
  const d = R.derive(c, srd);
  assert.deepEqual(d.scores, { str: 17, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
  assert.equal(d.pb, 2);
  assert.equal(d.hpMax, 10 + 2 + 1); // d10 + Con, +1 Dwarven Toughness
  assert.equal(d.ac, 16); // Chain Mail, no Dex
  assert.equal(d.saves.str.bonus, 5);
  assert.equal(d.saves.dex.bonus, 2);
  assert.equal(d.skills.Athletics.bonus, 5); // Soldier skill
  assert.equal(d.skills.Perception.bonus, 3);
  assert.equal(d.passivePerception, 13);
  assert.equal(d.feats[0].name, 'Savage Attacker');
  const greatsword = d.attacks.find((a) => a.name === 'Greatsword');
  assert.equal(greatsword.toHit, 5);
  assert.equal(greatsword.damage, '2d6+3');
  assert.deepEqual(R.validate(c, srd), []);
});

test('starting equipment: option B is gold only; Fighter has three options', () => {
  const opts = R.parseEquipmentOptions(data.classes.find((x) => x.id === 'fighter').startingEquipment);
  assert.deepEqual(Object.keys(opts), ['A', 'B', 'C']);
  assert.equal(opts.C.coins.gp, 155);
  const c = { ...fighter(), equipmentChoice: { class: 'C', background: 'A' } };
  const { coins } = R.startingInventory(c, srd);
  assert.equal(coins.gp, 155 + 14);
});

test('unarmored defense and armor limits', () => {
  const barb = { ...fighter(), classId: 'barbarian', inventory: [] };
  assert.equal(R.derive(barb, srd).ac, 10 + 2 + 2);
  const monk = { ...fighter(), classId: 'monk', inventory: [] };
  assert.equal(R.derive(monk, srd).ac, 10 + 2 + 1);
  const hide = { ...fighter(), baseScores: { ...fighter().baseScores, dex: 18 }, inventory: [{ uid: 'h', name: 'Hide Armor', qty: 1, ref: { kind: 'armor', id: 'hide-armor' }, equipped: true }] };
  assert.equal(R.derive(hide, srd).ac, 12 + 2); // Medium armor caps Dex at +2
});

test('spellcasting: Wizard and Warlock', () => {
  const wiz = data.classes.find((x) => x.id === 'wizard');
  assert.deepEqual(R.spellSlots(wiz, 1), { 1: 2 });
  assert.deepEqual(R.spellSlots(wiz, 5), { 1: 4, 2: 3, 3: 2 });
  assert.deepEqual(R.spellSlots(wiz, 20), { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 });
  const lock = data.classes.find((x) => x.id === 'warlock');
  assert.deepEqual(R.spellSlots(lock, 5), { 3: 2 });
  const c = { ...fighter(), classId: 'wizard', backgroundBonus: { mode: '2-1', plus2: 'str', plus1: 'con' } };
  const d = R.derive(c, srd);
  assert.equal(d.spell.ability, 'int');
  assert.equal(d.spell.saveDc, 8 + 2 + R.mod(8));
});

test('weapon proficiency follows the class text', () => {
  const rogue = data.classes.find((x) => x.id === 'rogue');
  const w = (id) => data.equipment.weapons.find((x) => x.id === id);
  assert.ok(R.weaponProficient(rogue, w('rapier')));
  assert.ok(!R.weaponProficient(rogue, w('greatsword')));
  const wizard = data.classes.find((x) => x.id === 'wizard');
  assert.ok(R.weaponProficient(wizard, w('dagger')));
  assert.ok(!R.weaponProficient(wizard, w('longsword')));
});

test('background ability increases cap at 20 and +1/+1/+1 works', () => {
  const c = { ...fighter(), baseScores: { str: 19, dex: 14, con: 13, int: 8, wis: 12, cha: 10 } };
  assert.equal(R.abilityScores(c).str, 20);
  const even = { ...fighter(), backgroundBonus: { mode: '1-1-1', plus1s: ['str', 'dex', 'con'] } };
  const s = R.abilityScores(even);
  assert.deepEqual([s.str, s.dex, s.con], [16, 15, 14]);
});

test('validation points at the right step', () => {
  const steps = R.validate(R.newCharacter(), srd).map((p) => p.step);
  for (const s of ['class', 'background', 'species', 'abilities', 'details']) assert.ok(steps.includes(s), s);
  const tooMany = { ...fighter(), classSkills: ['Perception', 'Survival', 'History'] };
  assert.ok(R.validate(tooMany, srd).some((p) => p.step === 'skills'));
  const lvl3 = { ...fighter(), level: 3 };
  assert.ok(R.validate(lvl3, srd).some((p) => p.message.includes('subclass')));
});

test('damage, healing, temp HP and rests', () => {
  let c = { ...fighter(), hp: { current: 13, temp: 5 } };
  c = R.applyDamage(c, 8);
  assert.deepEqual(c.hp, { current: 10, temp: 0 });
  c = R.applyDamage(c, 50);
  assert.equal(c.hp.current, 0);
  c = { ...c, deathSaves: { successes: 1, failures: 2 } };
  c = R.applyHealing(c, 4, 13);
  assert.equal(c.hp.current, 4);
  assert.deepEqual(c.deathSaves, { successes: 0, failures: 0 });
  c = R.applyHealing(c, 100, 13);
  assert.equal(c.hp.current, 13);
  c = R.applyTempHp(R.applyTempHp(c, 6), 3);
  assert.equal(c.hp.temp, 6);
  c = R.longRest({ ...c, hp: { current: 2, temp: 6 }, hitDiceSpent: 1, slotsUsed: { 1: 2 }, exhaustion: 2 }, 13);
  assert.deepEqual(c.hp, { current: 13, temp: 0 });
  assert.equal(c.hitDiceSpent, 0);
  assert.deepEqual(c.slotsUsed, {});
  assert.equal(c.exhaustion, 1);
});
