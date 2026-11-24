// Open5e species, backgrounds and classes, and the builder rules that use
// them (picked abilities, Origin feats and skills; subraces). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseBackgroundSkills, skillGrants, equipmentList } from '../scripts/open5e/heroes.mjs';
import { mergeExtra } from '../src/lib/srd.js';
import * as R from '../src/lib/character/rules.js';
import { levelUpInfo } from '../src/lib/character/automation.js';

const load = (dir, n) => JSON.parse(readFileSync(new URL(`../public/data/${dir}/${n}.json`, import.meta.url)));
const base = Object.fromEntries(['classes', 'species', 'backgrounds', 'feats', 'equipment', 'spells'].map((n) => [n, load('srd', n)]));
const srd = {
  ...base,
  classes: mergeExtra('classes', base.classes, [load('open5e', 'subclasses'), load('open5e', 'classes')]),
  species: mergeExtra('species', base.species, load('open5e', 'species')),
  backgrounds: mergeExtra('backgrounds', base.backgrounds, load('open5e', 'backgrounds')),
  feats: mergeExtra('feats', base.feats, load('open5e', 'feats')),
};
const species = (id) => srd.species.find((s) => s.id === id);
const background = (id) => srd.backgrounds.find((b) => b.id === id);

function hero(extra = {}) {
  return {
    ...R.newCharacter(), name: 'Test', classId: 'fighter', speciesId: 'human', backgroundId: 'soldier', level: 1,
    baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    backgroundBonus: { mode: '2-1', plus2: 'str', plus1: 'con' },
    speciesOptions: { size: 'Medium', skill: 'Perception', feat: 'Alert' },
    classSkills: ['Athletics', 'Intimidation'],
    ...extra,
  };
}
const problems = (c) => R.validate(c, srd).map((p) => p.message);

/* ------------------------------------------------------------ species */

test('the new species are added next to the SRD ones', () => {
  const ids = srd.species.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'species ids are unique');
  for (const id of ['alseid', 'catfolk', 'darakhul', 'derro', 'drow', 'erina', 'gearforged', 'half-elf', 'half-orc', 'minotaur', 'mushroomfolk', 'satarre', 'shade']) {
    const s = species(id);
    assert.ok(s, `${id} is missing`);
    assert.ok(s.sourceName, `${id} has no book`);
    assert.ok(s.traits.length >= 3, `${id} has only ${s.traits.length} traits`);
    assert.ok(!s.traits.some((t) => /^Ability Score Increase$/i.test(t.name)), `${id} keeps its 2014 ability increase`);
    assert.ok(s.speed >= 25, `${id} speed ${s.speed}`);
    assert.ok(s.description.includes('2024 rules'));
  }
});

test('subraces are a required choice and change speed, skills and traits', () => {
  const catfolk = species('catfolk');
  assert.deepEqual(R.speciesChoices(catfolk).map((x) => x.key), ['lineage']);
  const c = hero({ speciesId: 'catfolk', speciesOptions: {}, classSkills: ['Athletics', 'Intimidation'] });
  assert.ok(problems(c).includes('Choose: Subrace.'));

  c.speciesOptions = { lineage: 'Malkin' };
  assert.deepEqual(problems(c), []);
  const d = R.derive(c, srd);
  assert.equal(d.subspecies.name, 'Malkin');
  for (const s of ['Perception', 'Stealth', 'Investigation']) assert.ok(d.skills[s].proficient, `${s} from catfolk/Malkin`);
  assert.ok(d.speciesTraits.some((t) => t.name === 'Curiously Clever (Malkin)'));

  // Pantheran asks for one of four skills.
  c.speciesOptions = { lineage: 'Pantheran' };
  assert.ok(problems(c).includes("Choose your species' skill."));
  c.speciesOptions.skills = ['Nature'];
  assert.deepEqual(problems(c), []);
  assert.ok(R.derive(c, srd).skills.Nature.proficient);
  // A skill outside the list doesn't count.
  c.speciesOptions.skills = ['Arcana'];
  assert.ok(problems(c).includes("Choose your species' skill."));
});

test('a subrace speed replaces the species speed', () => {
  const withSpeed = srd.species.flatMap((s) => (s.subspecies || []).filter((x) => x.speed && x.speed !== s.speed).map((x) => [s, x]));
  for (const [s, sub] of withSpeed) {
    const d = R.derive(hero({ speciesId: s.id, speciesOptions: { lineage: sub.name } }), srd);
    assert.equal(d.speed, sub.speed, `${s.name} (${sub.name})`);
  }
});

test('Half-Elf picks two skills of any kind; Stoor Halfling is optional', () => {
  const c = hero({ speciesId: 'half-elf', speciesOptions: {} });
  assert.ok(problems(c).includes("Choose your species' skills."));
  c.speciesOptions.skills = ['Arcana', 'History'];
  assert.deepEqual(problems(c), []);
  assert.ok(R.fixedSkills(c, srd).has('Arcana'));

  const halfling = species('halfling');
  assert.ok(halfling.subspecies.some((x) => x.name === 'Stoor Halfling' && x.optional));
  const h = hero({ speciesId: 'halfling', speciesOptions: {} });
  assert.deepEqual(problems(h), []);
});

test('skill grants are read from trait text', () => {
  assert.deepEqual(skillGrants([{ text: 'You have proficiency in the Perception and Stealth skills.' }]), { skills: ['Perception', 'Stealth'], skillChoice: null });
  assert.deepEqual(
    skillGrants([{ text: 'You have proficiency in the Arcana skill, and you have advantage. In addition, you have proficiency in one of the following skills of your choice: History, Insight, and Religion.' }]),
    { skills: ['Arcana'], skillChoice: { count: 1, options: ['History', 'Insight', 'Religion'] } },
  );
  const any = skillGrants([{ text: 'You gain proficiency in two skills of your choice.' }]);
  assert.equal(any.skillChoice.count, 2);
  assert.equal(any.skillChoice.options.length, 18);
  assert.deepEqual(skillGrants([{ text: 'You have proficiency with spears and shortbows.' }]), { skills: [], skillChoice: null });
});

/* -------------------------------------------------------- backgrounds */

test('the new backgrounds let you pick abilities and an Origin feat', () => {
  const added = srd.backgrounds.filter((b) => b.rules2014);
  assert.equal(added.length, 51);
  const ids = srd.backgrounds.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'background ids are unique');
  assert.equal(new Set(srd.backgrounds.map((b) => b.name)).size, ids.length, 'background names are unique');
  for (const b of added) {
    assert.ok(b.chooseAbilities && b.chooseFeat, b.name);
    assert.ok(b.skillProficiencies.length + (b.skillChoice?.count || 0) >= 1, `${b.name} gives no skills`);
    assert.ok(b.equipment, `${b.name} has no equipment`);
    const opts = R.parseEquipmentOptions(b.equipment);
    const things = Object.values(opts).flatMap((o) => [...o.items, ...Object.values(o.coins).filter(Boolean)]);
    assert.ok(things.length, `${b.name} equipment parses to nothing`);
  }
});

test('a picked background needs three abilities, a feat and its skill', () => {
  const b = background('acolyte-level-up');
  const c = hero({ backgroundId: b.id, backgroundBonus: { mode: '2-1', plus2: 'wis', plus1: 'cha' }, classSkills: ['Athletics', 'Intimidation'] });
  const p = problems(c);
  assert.ok(p.includes('Choose the three abilities your background increases.'));
  assert.ok(p.includes("Choose your background's Origin feat."));
  assert.ok(p.includes("Choose your background's skill."));

  c.backgroundBonus = { mode: '2-1', abilities: ['wis', 'cha', 'con'], plus2: 'wis', plus1: 'cha', feat: 'Alert', skills: ['Insight'] };
  assert.deepEqual(problems(c), []);
  const d = R.derive(c, srd);
  assert.ok(d.feats.some((f) => f.name === 'Alert'));
  assert.ok(d.skills.Religion.proficient && d.skills.Insight.proficient);
  assert.equal(R.abilityScores(c).wis, 12);
  assert.equal(R.abilityScores(c).cha, 9);

  // +2 must be one of the three picked.
  c.backgroundBonus.plus2 = 'str';
  assert.ok(problems(c).includes('Choose which abilities get +2 and +1.'));
  // +1 to all three.
  c.backgroundBonus = { ...c.backgroundBonus, mode: '1-1-1', plus1s: ['wis', 'cha', 'con'] };
  assert.deepEqual(problems(c), []);
});

test('background skills are parsed with their choices', () => {
  assert.deepEqual(parseBackgroundSkills('Religion, and either Insight or Persuasion.'), { fixed: ['Religion'], choice: { count: 1, options: ['Insight', 'Persuasion'] } });
  assert.deepEqual(parseBackgroundSkills('Deception, Sleight of Hand'), { fixed: ['Deception', 'Sleight of Hand'], choice: null });
  assert.ok(equipmentList('Holy symbol, robe, and a prayer book').length >= 3);
});

/* ------------------------------------------------------------ classes */

for (const id of ['marshal', 'mechanist']) {
  test(`${id} is a full class with a 20-level table`, () => {
    const k = srd.classes.find((c) => c.id === id);
    assert.ok(k, `${id} missing`);
    assert.equal(k.levelTable.rows.length, 20);
    assert.ok(k.subclasses.length >= 1);
    assert.ok(k.features.length >= 15);
    assert.ok(R.parseEquipmentOptions(k.startingEquipment).A.items.length);
    const c = hero({ classId: id, classSkills: k.skillChoices.options.slice(0, k.skillChoices.count), level: 1 });
    assert.deepEqual(problems(c), []);

    const asiAt = [];
    let subAt = null;
    for (let lvl = 1; lvl < 20; lvl++) {
      const info = levelUpInfo({ ...c, level: lvl }, srd);
      if (info.asi) asiAt.push(info.level);
      if (info.needsSubclass) subAt = info.level;
    }
    assert.deepEqual(asiAt, [4, 8, 12, 16, 19]);
    assert.equal(subAt, 3);
  });
}

test('Marshal table fixes', () => {
  const k = srd.classes.find((c) => c.id === 'marshal');
  assert.equal(R.levelRow(k, 14)['Commanding Presence'], '30 feet');
});
