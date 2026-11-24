// The Open5e importer and the rules it feeds: subclass levels, subclass
// spells, subclass spellcasting and feat ability increases. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanText, levelFor2024, convertSubclass, castingTimeText, spellClasses } from '../scripts/build-open5e.mjs';
import { mergeExtra } from '../src/lib/srd.js';
import * as R from '../src/lib/character/rules.js';
import { spellMechanics, castableSpells, applyLevelUp } from '../src/lib/character/automation.js';

const load = (dir, n) => JSON.parse(readFileSync(new URL(`../public/data/${dir}/${n}.json`, import.meta.url)));
const base = Object.fromEntries(['classes', 'species', 'backgrounds', 'feats', 'equipment', 'spells'].map((n) => [n, load('srd', n)]));
const srd = {
  ...base,
  classes: mergeExtra('classes', base.classes, load('open5e', 'subclasses')),
  spells: mergeExtra('spells', base.spells, load('open5e', 'spells')),
  feats: mergeExtra('feats', base.feats, load('open5e', 'feats')),
};
const cls = (id) => srd.classes.find((c) => c.id === id);
const subclass = (classId, name) => cls(classId).subclasses.find((s) => s.name === name);

function hero(classId, subclassName, level, extra = {}) {
  return {
    ...R.newCharacter(), name: 'Test', classId, speciesId: 'human', backgroundId: 'acolyte', level,
    subclassId: subclassName ? subclass(classId, subclassName).id : null,
    baseScores: { str: 10, dex: 14, con: 12, int: 14, wis: 16, cha: 10 }, ...extra,
  };
}

test('every class gets its Open5e subclasses, all starting at level 3', () => {
  const counts = Object.fromEntries(srd.classes.map((c) => [c.id, c.subclasses.length]));
  assert.deepEqual(counts, { barbarian: 9, bard: 8, cleric: 12, druid: 9, fighter: 8, monk: 10, paladin: 8, ranger: 7, rogue: 8, sorcerer: 9, warlock: 9, wizard: 12 });
  for (const c of srd.classes) {
    const ids = new Set();
    for (const s of c.subclasses) {
      assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
      ids.add(s.id);
      assert.ok(s.features.length >= 4, `${s.name} has only ${s.features.length} features`);
      for (const f of s.features) {
        assert.ok(f.level >= 3 && f.level <= 20, `${s.name}: ${f.name} at ${f.level}`);
        assert.ok(f.description.trim(), `${s.name}: ${f.name} has no text`);
      }
    }
  }
});

test('2014 subclass levels move to the 2024 ones', () => {
  assert.equal(levelFor2024('cleric', 1, 'Bonus Proficiency'), 3);
  assert.equal(levelFor2024('cleric', 2, 'Channel Divinity'), 3);
  assert.equal(levelFor2024('cleric', 8, 'Divine Strike'), 7);
  assert.equal(levelFor2024('cleric', 8, 'Sanguine Recall'), 10);
  assert.equal(levelFor2024('wizard', 2, 'Savant'), 3);
  assert.equal(levelFor2024('warlock', 1, 'Pact'), 3);
  assert.equal(levelFor2024('rogue', 9, 'x'), 9);
  const hell = subclass('barbarian', 'Path of Hellfire');
  assert.deepEqual(hell.features.map((f) => f.level), [3, 6, 10, 14], 'rebuilt from the v1 write-up');
  const blood = subclass('cleric', 'Blood Domain');
  assert.match(blood.features.find((f) => f.name === 'Bloodletting Focus').description, /original 2014 rules/);
});

test('cleanText fixes tables, headings, typos and drops unsafe HTML', () => {
  const t = cleanText('Intro\n**Table**\nLevel | Spells |\r\n|———|———|\n| 1st | *bless* |\nAfter\n#####Heading\ncan-t <script>x</script><img src=x onerror=y><em>ok</em>');
  assert.match(t, /\*\*Table\*\*\n\n\| Level \| Spells \|\n\|---\|---\|\n\| 1st \| \*bless\* \|\n\nAfter/);
  assert.match(t, /\*\*Heading\*\*/);
  assert.match(t, /can't/);
  assert.doesNotMatch(t, /<script|<img|onerror/);
  assert.match(t, /<em>ok<\/em>/);
  for (const c of srd.classes) for (const s of c.subclasses) for (const f of s.features) assert.doesNotMatch(f.description, /<script|<iframe|on\w+=/i);
});

test('converted spells read like the SRD ones', () => {
  assert.equal(castingTimeText({ castingTime: 'bonus-action' }), 'Bonus Action');
  assert.equal(castingTimeText({ castingTime: '10minutes', ritual: true }), '10 minutes or Ritual');
  assert.equal(castingTimeText({ castingTime: 'reaction', reactionCondition: 'when you are hit.' }), 'Reaction, which you take when you are hit');
  assert.deepEqual(spellClasses({ classes: [], v1Classes: 'Sorceror, Wizard, Artificer' }), ['Sorcerer', 'Wizard']);
  const valid = new Set(srd.classes.map((c) => c.name));
  for (const s of srd.spells) for (const c of s.classes) assert.ok(valid.has(c), `${s.name}: ${c}`);
  assert.equal(new Set(srd.spells.map((s) => s.id)).size, srd.spells.length, 'spell ids are unique');
  assert.equal(new Set(srd.spells.map((s) => s.name)).size, srd.spells.length, 'spell names are unique');
  // A 2014-worded spell still works at the table.
  const acid = srd.spells.find((s) => s.name === 'Acid Rain');
  const m = spellMechanics(acid, { slotLevel: 6 });
  assert.equal(m.save, 'dex');
  assert.equal(m.damage, '7d6');
});

test('subclass spells are always prepared', () => {
  // SRD: Life Domain at level 5.
  const life = R.derive(hero('cleric', 'Life Domain', 5), srd);
  assert.deepEqual(life.alwaysSpells.map((s) => s.name).sort(), ['Aid', 'Bless', 'Cure Wounds', 'Lesser Restoration', 'Mass Healing Word', 'Revivify']);
  // 2014 Warlock tables list spell levels: 1st and 2nd at 3, 3rd at 5.
  const fey = subclass('warlock', 'The Ancient Fey Court');
  assert.deepEqual(R.subclassSpells(fey, 3, srd.spells).spells.map((s) => s.name).sort(), ['Calm Emotions', 'Faerie Fire', 'Phantasmal Force', 'Sleep']);
  assert.equal(R.subclassSpells(fey, 5, srd.spells).spells.length, 6);
  // Spells not in the open content are reported, not invented.
  assert.deepEqual(R.subclassSpells(subclass('cleric', 'Blood Domain'), 20, srd.spells).missing, ['crown of madness']);
  // They're castable at the table.
  const c = hero('cleric', 'Demise Domain', 3);
  assert.ok(castableSpells(c, srd).some(({ spell }) => spell.name === 'False Life'));
});

test('Fighter and Rogue subclasses that cast spells', () => {
  const et = subclass('rogue', 'Eldritch Trickster');
  assert.equal(R.spellcasting(cls('rogue'), 2, et), null);
  const at3 = R.spellcasting(cls('rogue'), 3, et);
  assert.deepEqual([at3.ability, at3.list, at3.cantrips, at3.prepared], ['int', 'Wizard', 3, 3]);
  assert.deepEqual(at3.slots, { 1: 2 });
  const at20 = R.spellcasting(cls('rogue'), 20, et);
  assert.deepEqual([at20.cantrips, at20.prepared, at20.maxSpellLevel], [4, 13, 4]);
  assert.equal(R.spellcasting(cls('rogue'), 5, subclass('rogue', 'Thief')), null);
  const d = R.derive(hero('rogue', 'Eldritch Trickster', 3), srd);
  assert.equal(d.spell.saveDc, 8 + 2 + 2);
  assert.deepEqual(d.alwaysSpells.map((s) => s.name), ['Mage Hand']);
  const soul = R.derive(hero('rogue', 'Soulspy', 7), srd);
  assert.deepEqual([soul.spell.ability, soul.spell.list], ['wis', 'Cleric']);
  assert.deepEqual(soul.spell.slots, { 1: 4, 2: 2 });
});

test('feats that raise an ability score', () => {
  const grappler = srd.feats.find((f) => f.name === 'Grappler');
  assert.deepEqual(R.featAbilityIncrease(grappler), { options: ['str', 'dex'], amount: 1 });
  const reserves = srd.feats.find((f) => f.name === 'Boundless Reserves');
  assert.equal(reserves.sourceName, 'Tome of Heroes');
  assert.deepEqual(R.featAbilityIncrease(reserves), { options: ['wis'], amount: 1 });
  const c = hero('fighter', 'Champion', 3, { xp: 2700 });
  const next = applyLevelUp(c, srd, { hp: 'average', feat: 'Grappler', featAbility: 'dex' });
  assert.deepEqual(next.levelChoices[4], { type: 'feat', feat: 'Grappler', plus: { dex: 1 } });
  assert.equal(R.abilityScores(next).dex, R.abilityScores(c).dex + 1);
  assert.ok(R.derive(next, srd).feats.some((f) => f.name === 'Grappler'));
});

test('subclass conversion keeps ids unique', () => {
  const taken = new Set(['path-of-thorns']);
  const s = convertSubclass({ name: 'Path of Thorns', source: 'toh', classKey: 'barbarian', rules: '2014', desc: 'x', features: [{ name: 'A', desc: 'a', levels: [3] }] }, taken);
  assert.equal(s.id, 'path-of-thorns-tome-of-heroes');
});
