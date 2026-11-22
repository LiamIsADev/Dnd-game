// Checks the SRD conversion against known values from the rules text.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSrd } from '../scripts/build-srd.mjs';

const data = await buildSrd();
const byId = (list, id) => list.find((x) => x.id === id);

test('every source entry is converted', async () => {
  const src = (f) => readFile(new URL(`../srd-source/${f}`, import.meta.url), 'utf8');
  const count = (text, re) => (text.match(re) || []).length;
  const statBlocks = count(await src('monsters-A-Z.md'), /^\*\*AC\*\*/gm) + count(await src('animals.md'), /^\*\*AC\*\*/gm);
  assert.equal(data.monsters.length, statBlocks);
  assert.equal(data.spells.length, count(await src('spells.md'), /^_(Level \d+ [A-Za-z]+|[A-Za-z]+ Cantrip) \(/gm));
  assert.equal(data.classes.length, 12);
  assert.equal(data.species.length, 9);
  assert.equal(data.backgrounds.length, 4);
  assert.equal(data.glossary.filter((g) => g.tag === 'Condition').length, 15);
});

test('ids are unique within each list', () => {
  for (const name of ['spells', 'monsters', 'magic-items', 'feats', 'classes', 'species', 'backgrounds']) {
    const ids = data[name].map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${name}`);
  }
});

test('spells: Fireball', () => {
  const s = byId(data.spells, 'fireball');
  assert.equal(s.level, 3);
  assert.equal(s.school, 'Evocation');
  assert.deepEqual(s.classes, ['Sorcerer', 'Wizard']);
  assert.equal(s.range, '150 feet');
  assert.equal(s.components.material, 'a ball of bat guano and sulfur');
  assert.equal(s.concentration, false);
  assert.match(s.higherLevels, /1d6 for each spell slot level above 3/);
});

test('spells: cantrips, rituals and concentration', () => {
  const acid = byId(data.spells, 'acid-splash');
  assert.equal(acid.level, 0);
  assert.match(acid.cantripUpgrade, /2d6/);
  assert.ok(byId(data.spells, 'detect-magic').ritual);
  assert.ok(byId(data.spells, 'bless').concentration);
  assert.ok(byId(data.spells, 'animate-objects').creatureStatBlock.includes('Animated Object'));
});

test('monsters: Aboleth stat block', () => {
  const m = byId(data.monsters, 'aboleth');
  assert.deepEqual(m.size, ['Large']);
  assert.equal(m.type, 'Aberration');
  assert.equal(m.acValue, 17);
  assert.deepEqual(m.hp, { average: 150, formula: '20d10+40' });
  assert.deepEqual(m.initiative, { bonus: 7, score: 17 });
  assert.deepEqual(m.abilities.dex, { score: 9, mod: -1, save: 3 });
  assert.equal(m.cr.value, 10);
  assert.equal(m.cr.xpInLair, 7200);
  const tentacle = m.actions.find((a) => a.name === 'Tentacle');
  assert.equal(tentacle.attack.bonus, 9);
  assert.deepEqual(tentacle.attack.damage[0], { average: 12, dice: '2d6+5', type: 'Bludgeoning' });
  const dominate = m.actions.find((a) => a.name.startsWith('Dominate Mind'));
  assert.equal(dominate.usesPerDay, 2);
  assert.deepEqual(dominate.save.ability, 'wis');
  assert.equal(m.legendaryActions.length, 2);
  assert.match(m.legendaryActionsIntro, /Legendary Action Uses: 3/);
});

test('monsters: every stat block has the core numbers', () => {
  for (const m of data.monsters) {
    assert.ok(m.acValue > 0, `${m.name} AC`);
    assert.ok(m.hp?.average > 0, `${m.name} HP`);
    assert.equal(Object.keys(m.abilities).length, 6, `${m.name} abilities`);
    assert.ok(m.cr?.rating, `${m.name} CR`);
    assert.ok(m.initiative, `${m.name} initiative`);
  }
});

test('monsters: fractional CR and animals', () => {
  const cat = byId(data.monsters, 'cat');
  assert.equal(cat.source, 'animals');
  assert.equal(cat.cr.rating, '0');
  const goblin = byId(data.monsters, 'goblin-warrior');
  assert.equal(goblin.cr.rating, '1/4');
  assert.equal(goblin.cr.value, 0.25);
});

test('classes: Barbarian and Bard core traits', () => {
  const barb = byId(data.classes, 'barbarian');
  assert.equal(barb.hitDie, 12);
  assert.deepEqual(barb.savingThrows, ['Strength', 'Constitution']);
  assert.equal(barb.skillChoices.count, 2);
  assert.equal(barb.levelTable.rows.length, 20);
  assert.equal(barb.features[0].name, 'Rage');
  assert.equal(barb.subclasses[0].name, 'Path of the Berserker');
  const bard = byId(data.classes, 'bard');
  assert.deepEqual(bard.skillChoices.options, 'any');
  assert.equal(bard.skillChoices.count, 3);
});

test('equipment: weapons and armor', () => {
  const { weapons, armor } = data.equipment;
  const longsword = byId(weapons, 'longsword');
  assert.equal(longsword.category, 'Martial');
  assert.deepEqual(longsword.damage, { dice: '1d8', type: 'Slashing' });
  assert.ok(longsword.properties.includes('Versatile (1d10)'));
  const plate = byId(armor, 'plate-armor');
  assert.equal(plate.baseAc, 18);
  assert.equal(plate.strength, 15);
  assert.ok(plate.stealthDisadvantage);
  const hide = byId(armor, 'hide-armor');
  assert.equal(hide.maxDex, 2);
});

test('species, backgrounds and magic items', () => {
  assert.equal(byId(data.species, 'goliath').speed, 35);
  assert.deepEqual(byId(data.backgrounds, 'acolyte').skillProficiencies, ['Insight', 'Religion']);
  const bag = byId(data['magic-items'], 'bag-of-holding');
  assert.equal(bag.category, 'Wondrous Item');
  assert.deepEqual(bag.rarity, ['Uncommon']);
  for (const item of data['magic-items']) assert.ok(item.rarity.length, `${item.name} rarity`);
});
