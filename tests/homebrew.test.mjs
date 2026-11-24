// Homebrew: what each form turns into, how it joins the rules data, and that
// the character rules and the table use it. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KINDS, KIND_ORDER, blank, fromExisting, toForm, averageOf, buildLevelTable } from '../src/lib/homebrew/kinds.js';
import { mergeHomebrew } from '../src/lib/homebrew/merge.js';
import { parseImport, EXPORT_FORMAT } from '../src/lib/homebrew/store.js';
import { setPath, getPath } from '../src/components/homebrew-form.js';
import { rulesMarkdown } from '../src/lib/dom.js';
import * as R from '../src/lib/character/rules.js';
import { spellMechanics, monsterActions } from '../src/lib/character/automation.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../public/data/srd/${n}.json`, import.meta.url)));
const srd = Object.fromEntries(['classes', 'species', 'backgrounds', 'feats', 'equipment', 'spells', 'monsters', 'magic-items'].map((n) => [n, load(n)]));
const row = (kind, data, id = `00000000-0000-0000-0000-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`) => ({ id, owner_id: 'u1', kind, name: data.name, data });

test('every kind has a blank item that finalizes cleanly', () => {
  for (const kind of KIND_ORDER) {
    const item = blank(kind, srd);
    assert.equal(typeof item, 'object', kind);
    const again = KINDS[kind].finalize(toForm(kind, item), srd);
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(item)), `${kind} round-trips`);
  }
});

test('monster forms work out mods, saves, XP and attack text', () => {
  const form = toForm('monster', blank('monster', srd));
  Object.assign(form, { name: 'Mud Troll', cr: { rating: '5' }, saveProfs: ['con'] });
  form.abilities.str.score = 18;
  form.abilities.con.score = 16;
  form.actions = [
    { name: 'Slam', mode: 'attack', attackKind: 'melee', bonus: 7, reach: 10, damage: '2d8+4', damageType: 'Bludgeoning' },
    { name: 'Mud Spray', mode: 'save', saveAbility: 'dex', dc: 14, damage: '4d6', damageType: 'Acid', half: true, condition: 'Blinded', recharge: '5–6' },
  ];
  const m = KINDS.monster.finalize(form);
  assert.equal(m.abilities.str.mod, 4);
  assert.equal(m.abilities.con.save, 3 + 3);
  assert.equal(m.cr.xp, 1800);
  assert.equal(m.cr.proficiencyBonus, 3);
  assert.match(m.actions[0].text, /Melee Attack Roll:_ \+7, reach 10 ft\. _Hit:_ 13 \(2d8 \+ 4\) Bludgeoning damage/);
  assert.equal(m.actions[1].name, 'Mud Spray (Recharge 5–6)');
  assert.match(m.actions[1].text, /Dexterity Saving Throw:_ DC 14/);
  const acts = monsterActions(m);
  assert.deepEqual(acts[0], { name: 'Slam', kind: 'attack', bonus: 7, damage: '2d8+4', damageType: 'Bludgeoning', extra: [], rider: null });
  assert.equal(acts[1].half, true);
  assert.equal(acts[1].condition, 'Blinded');
});

test('copying an SRD monster keeps its attacks', () => {
  const goblin = srd.monsters.find((m) => /goblin/i.test(m.name) && m.actions.some((a) => a.attack));
  const copy = fromExisting('monster', goblin, srd);
  assert.equal(copy.name, goblin.name);
  assert.equal(copy.hp.average, goblin.hp.average);
  const a = goblin.actions.find((x) => x.attack);
  const b = copy.actions.find((x) => x.name === a.name);
  assert.equal(b.attack.bonus, a.attack.bonus);
  assert.equal(b.text, a.text, 'the original wording is kept');
  assert.equal(copy.id, undefined);
});

test('homebrew spells roll from the form, with upcasting and areas', () => {
  const form = toForm('spell', blank('spell', srd));
  Object.assign(form, { name: 'Mud Bolt', level: 2, classes: ['Wizard'] });
  form.mechanics = { kind: 'save', save: 'str', half: true, damage: '3d8', damageType: 'Acid', upcast: '1d8', areaShape: 'circle', areaSize: 10, condition: 'Prone' };
  const spell = KINDS.spell.finalize(form);
  const m = spellMechanics(spell, { slotLevel: 4 });
  assert.equal(m.kind, 'save');
  assert.equal(m.save, 'str');
  assert.equal(m.damage, '5d8');
  assert.equal(m.condition, 'Prone');
  assert.deepEqual(m.area, { shape: 'circle', size: 10, self: false });
  assert.equal(m.targets, Infinity);
  const heal = KINDS.spell.finalize({ ...form, level: 0, mechanics: { kind: 'heal', heal: '1d4', addMod: true, upcast: '1d4', targets: 1 } });
  assert.equal(spellMechanics(heal, { casterLevel: 11, castingMod: 3 }).heal, '3d4+3');
  assert.equal(spell.components.raw, 'V, S');
  assert.equal(KINDS.spell.finalize({ ...form, concentration: true, durationBase: '1 minute' }).duration, 'Concentration, up to 1 minute');
});

test('weapons and armor work out their text and AC', () => {
  const w = KINDS.weapon.finalize({ name: 'Mud Hammer', category: 'Martial', kind: 'melee', damage: { dice: '1d10', type: 'Bludgeoning' }, propertyList: ['Heavy', 'Versatile', 'Thrown'], versatileDice: '1d12', range: '20/60', isMagic: true, bonus: 1, mastery: 'Topple' });
  assert.deepEqual(w.properties, ['Heavy', 'Versatile (1d12)', 'Thrown (Range 20/60)']);
  assert.equal(w.bonus, 1);
  assert.equal(w.magic.rarity, 'Uncommon');
  const back = toForm('weapon', srd.equipment.weapons.find((x) => x.id === 'longbow'));
  assert.ok(back.propertyList.includes('Ammunition'));
  assert.equal(back.range, '150/600');
  const a = KINDS.armor.finalize({ name: 'Bark Mail', category: 'Medium', baseAc: 14, maxDex: 2 });
  assert.equal(a.armorClass, '14 + Dex modifier (max 2)');
  assert.equal(KINDS.armor.finalize({ name: 'Buckler', category: 'Shield', baseAc: 1 }).isShield, true);
});

test('a homebrew class gets a level table and its own spellcasting', () => {
  const cls = KINDS.class.finalize(
    {
      name: 'Mudmancer', hitDie: 8, savingThrows: ['Intelligence', 'Wisdom'], skillCount: 2, skillOptions: ['Arcana', 'Nature'],
      casterType: 'half', spellAbility: 'wis', spellList: 'Druid', unarmoredDefense: 'wis',
      features: [{ level: 1, name: 'Mud Sense', description: 'You feel the earth.' }, { level: 2, name: 'Sludge Step', description: '…' }],
    },
    srd,
  );
  assert.equal(cls.levelTable.rows.length, 20);
  assert.match(cls.levelTable.rows[2][2], /Mudmancer Subclass/);
  assert.match(cls.levelTable.rows[3][2], /Ability Score Improvement/);
  const merged = mergeHomebrew(srd, [row('class', cls, '00000000-0000-0000-0000-00000000c1a5')]);
  const found = merged.classes.find((c) => c.name === 'Mudmancer');
  assert.equal(found.id, 'hb-00000000-0000-0000-0000-00000000c1a5');
  const sc = R.spellcasting(found, 5);
  assert.equal(sc.ability, 'wis');
  assert.equal(sc.list, 'Druid');
  assert.deepEqual(sc.slots, R.spellcasting(srd.classes.find((c) => c.id === 'paladin'), 5).slots);
  const third = buildLevelTable({ name: 'X', casterType: 'third' }, srd.classes);
  const thirdCls = { ...cls, levelTable: third, spellcasting: { ability: 'int', list: 'Wizard', type: 'third' } };
  assert.deepEqual(R.spellcasting(thirdCls, 7).slots, { 1: 4, 2: 2 });
  const pact = KINDS.class.finalize({ name: 'Hexer', casterType: 'pact', spellAbility: 'cha' }, srd);
  assert.equal(R.spellcasting(pact, 5).pact, true);
  assert.deepEqual(R.spellcasting(pact, 5).slots, { 3: 2 });

  // A character of that class: hit points, saves and Unarmored Defense.
  const c = { ...R.newCharacter(), classId: found.id, level: 3, baseScores: { str: 10, dex: 14, con: 12, int: 10, wis: 16, cha: 8 } };
  const d = R.derive(c, merged);
  assert.equal(d.cls.name, 'Mudmancer');
  assert.equal(d.ac, 10 + 2 + 3);
});

test('subclasses join built-in and homebrew classes, with always-prepared spells', () => {
  const clsRow = row('class', KINDS.class.finalize({ name: 'Mudmancer', casterType: 'full', spellAbility: 'int' }, srd), '00000000-0000-0000-0000-0000000000aa');
  const sub1 = KINDS.subclass.finalize({ name: 'Circle of Clay', classId: 'druid', features: [{ level: 3, name: 'Clay Form', description: 'x' }], alwaysPrepared: [{ level: 3, spells: ['Entangle', 'Grease'] }] });
  const sub2 = KINDS.subclass.finalize({ name: 'Bog School', classId: 'hb-00000000-0000-0000-0000-0000000000aa', features: [{ level: 3, name: 'Bog', description: 'y' }] });
  const merged = mergeHomebrew(srd, [clsRow, row('subclass', sub1), row('subclass', sub2)]);
  const druid = merged.classes.find((c) => c.id === 'druid');
  const clay = druid.subclasses.find((s) => s.name === 'Circle of Clay');
  assert.ok(clay);
  assert.equal(merged.classes.find((c) => c.name === 'Mudmancer').subclasses[0].name, 'Bog School');
  assert.equal(srd.classes.find((c) => c.id === 'druid').subclasses.some((s) => s.name === 'Circle of Clay'), false, 'the cached SRD data is not changed');
  const { spells } = R.subclassSpells(clay, 3, merged.spells);
  assert.deepEqual(spells.map((s) => s.name).sort(), ['Entangle', 'Grease']);
  assert.deepEqual(toForm('subclass', clay).features.map((f) => f.name), ['Clay Form'], 'the generated spells feature is not edited');
});

test('feats, backgrounds, species and magic items', () => {
  const feat = KINDS.feat.finalize({ name: 'Mud Lover', category: 'General Feat', abilityIncrease: ['str', 'con'], body: 'You like mud.' });
  assert.deepEqual(R.featAbilityIncrease(feat), { options: ['str', 'con'], amount: 1 });
  assert.equal(toForm('feat', feat).body, 'You like mud.');
  const bg = KINDS.background.finalize({ name: 'Bog Hermit', abilityScores: ['Strength', 'Constitution', 'Wisdom'], feat: 'Tough', skillProficiencies: ['Nature', 'Survival'] });
  assert.deepEqual(R.backgroundAbilityKeys(bg), ['str', 'con', 'wis']);
  const sp = KINDS.species.finalize({ name: 'Mudling', speed: 25, darkvision: 60, traits: [{ name: 'Slippery', text: 'Hard to grab.' }] });
  assert.match(sp.description, /\*\*Darkvision:\*\* 60 feet/);
  const item = KINDS['magic-item'].finalize({ name: 'Mire Blade', category: 'Weapon', rarity: 'Rare', baseWeapon: 'longsword', bonus: 2, attunement: true }, srd);
  assert.equal(item.meta, 'Weapon (Longsword), Rare (Requires Attunement)');
  const merged = mergeHomebrew(srd, [row('feat', feat), row('background', bg), row('species', sp), row('magic-item', item)]);
  const blade = merged.equipment.weapons.find((w) => w.name === 'Mire Blade');
  assert.equal(blade.bonus, 2);
  assert.equal(blade.damageText, '1d8 Slashing');
  for (const key of ['feats', 'backgrounds', 'species', 'magic-items']) assert.ok(merged[key].some((x) => x.source === 'homebrew'), key);
  const c = { ...R.newCharacter(), speciesId: merged.species.find((s) => s.name === 'Mudling').id, classId: 'fighter', level: 1 };
  assert.equal(R.derive(c, merged).speed, 25);
});

test('form paths and markdown safety', () => {
  const f = {};
  setPath(f, 'actions.0.damage', '1d6');
  assert.deepEqual(f, { actions: [{ damage: '1d6' }] });
  assert.equal(getPath(f, 'actions.0.damage'), '1d6');
  assert.equal(averageOf('2d6+3'), 10);
  assert.doesNotMatch(rulesMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) <script>x</script>'), /<img|<script|javascript:/);
  assert.match(rulesMarkdown('<table><tr><td colspan="2">ok</td></tr></table>'), /<td colspan="2">ok<\/td>/);
});

test('import files are checked', () => {
  assert.throws(() => parseImport('nope'), /isn't a homebrew file/);
  assert.throws(() => parseImport(JSON.stringify({ format: 'dnd-game-character', items: [] })), /isn't a homebrew file/);
  const items = parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, items: [{ kind: 'spell', name: 'A', data: { name: 'A' } }, { kind: 'vehicle', data: {} }] }));
  assert.equal(items.length, 1);
});
