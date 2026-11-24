// The Open5e importer and the rules it feeds: subclass levels, subclass
// spells, subclass spellcasting and feat ability increases. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cleanText, levelFor2024, convertSubclass, castingTimeText, spellClasses, monsterKey } from '../scripts/build-open5e.mjs';
import { parseAttack, parseSave } from '../scripts/open5e/monsters.mjs';
import { mergeExtra } from '../src/lib/srd.js';
import * as R from '../src/lib/character/rules.js';
import { spellMechanics, castableSpells, applyLevelUp, monsterActions } from '../src/lib/character/automation.js';

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

const monsters = mergeExtra('monsters', load('srd', 'monsters'), load('open5e', 'monsters'));
const equipment = mergeExtra('equipment', base.equipment, load('open5e', 'equipment'));

test('monsters: hundreds more, no duplicates', () => {
  assert.ok(monsters.length > 2000, `${monsters.length} monsters`);
  assert.equal(new Set(monsters.map((m) => m.id)).size, monsters.length, 'ids are unique');
  const keys = monsters.map((m) => monsterKey(m.name));
  assert.equal(new Set(keys).size, keys.length, 'no monster appears twice, even with the words in another order');
  for (const m of monsters) {
    assert.ok(m.hp?.average > 0 || m.hp?.average === 0, `${m.name} has HP`);
    assert.ok(m.actions.length + m.traits.length + m.reactions.length + m.bonusActions.length, `${m.name} has something to do`);
    assert.ok(Number.isFinite(m.cr.value) && Number.isFinite(m.acValue), `${m.name} CR and AC`);
  }
});

test('2014-style monster actions are parsed for the table', () => {
  const a = parseAttack('Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) piercing damage plus 7 (2d6) fire damage.');
  assert.deepEqual(a, { kind: 'melee', bonus: 6, reach: 'reach 5 ft.', range: null, damage: [{ average: 10, dice: '2d6+3', type: 'Piercing' }, { average: 7, dice: '2d6', type: 'Fire' }] });
  const s = parseSave('Each creature in a 30-foot cone must make a DC 15 Dexterity saving throw, taking 28 (8d6) fire damage on a failed save, or half as much damage on a successful one.');
  assert.deepEqual([s.ability, s.dc, s.damage[0].dice, s.half], ['dex', 15, '8d6', true]);
  assert.equal(parseSave('must succeed on a DC 13 Wisdom saving throw or be frightened for 1 minute.').condition, 'Frightened');
  const bear = monsters.find((m) => m.name === 'Bear King');
  const acts = monsterActions(bear);
  assert.ok(acts.some((x) => x.kind === 'attack' && x.bonus > 0 && x.damage), 'Bear King can attack at the table');
});

test('major monsters get legendary and mythic actions', () => {
  for (const m of monsters) {
    if (m.cr.value >= 12) assert.ok(m.legendaryActions.length, `${m.name} (CR ${m.cr.rating}) has legendary actions`);
    if (m.cr.value >= 17) assert.ok(m.mythicTrait && m.mythicActions.length >= 3, `${m.name} (CR ${m.cr.rating}) is mythic`);
    if (m.cr.value < 12) assert.ok(!m.siteLegendary && !m.mythicTrait, `${m.name} left alone`);
  }
  // SRD monsters too, without changing what they already had.
  const red = monsters.find((m) => m.id === 'ancient-red-dragon');
  const srdRed = load('srd', 'monsters').find((m) => m.id === 'ancient-red-dragon');
  assert.deepEqual(red.legendaryActions, srdRed.legendaryActions);
  assert.match(red.mythicTrait.text, /regains 253 Hit Points/);
  assert.ok(monsterActions(red).some((a) => a.name.startsWith('Relentless')));
  const archmage = monsters.find((m) => m.id === 'archmage');
  assert.equal(archmage.siteLegendary, true);
  assert.match(archmage.legendaryActionsIntro, /Added by this site/);
});

test('weapons: new and magic ones, no duplicates, usable on the sheet', () => {
  const names = equipment.weapons.map((w) => w.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'no duplicate weapon names');
  assert.equal(new Set(equipment.weapons.map((w) => w.id)).size, names.length, 'no duplicate ids');
  assert.ok(equipment.weapons.length >= 280, `${equipment.weapons.length} weapons`);
  const khopesh = equipment.weapons.find((w) => w.name === 'Khopesh');
  assert.equal(khopesh.sourceName, 'Tome of Heroes');
  const blade = equipment.weapons.find((w) => w.name === 'Akaasit Blade');
  assert.deepEqual([blade.baseId, blade.bonus, blade.category], ['dagger', 1, 'Simple']);
  const c = { ...hero('rogue', null, 1), inventory: [{ uid: 'x', name: 'Akaasit Blade', qty: 1, ref: { kind: 'weapon', id: blade.id }, equipped: true }] };
  const d = R.derive(c, { ...srd, equipment });
  const atk = d.attacks.find((a) => a.uid === 'x');
  assert.equal(atk.toHit, 2 + 2 + 1, 'Dex + proficiency + 1');
  assert.equal(atk.damage, '1d4+3');
});
