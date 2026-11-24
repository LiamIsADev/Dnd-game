// Fifth Edition (2024 / SRD 5.2.1) character rules: everything the builder and
// character sheet calculate from a saved character. Pure functions only, so
// they can be tested without a browser.

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_LABELS = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};
const ABILITY_BY_NAME = Object.fromEntries(Object.entries(ABILITY_LABELS).map(([k, v]) => [v, k]));

export const SKILLS = {
  Acrobatics: 'dex',
  'Animal Handling': 'wis',
  Arcana: 'int',
  Athletics: 'str',
  Deception: 'cha',
  History: 'int',
  Insight: 'wis',
  Intimidation: 'cha',
  Investigation: 'int',
  Medicine: 'wis',
  Nature: 'int',
  Perception: 'wis',
  Performance: 'cha',
  Persuasion: 'cha',
  Religion: 'int',
  'Sleight of Hand': 'dex',
  Stealth: 'dex',
  Survival: 'wis',
};

export const ALIGNMENTS = [
  'Lawful Good',
  'Neutral Good',
  'Chaotic Good',
  'Lawful Neutral',
  'Neutral',
  'Chaotic Neutral',
  'Lawful Evil',
  'Neutral Evil',
  'Chaotic Evil',
];

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export const SPELLCASTING_ABILITY = {
  bard: 'cha',
  cleric: 'wis',
  druid: 'wis',
  paladin: 'cha',
  ranger: 'wis',
  sorcerer: 'cha',
  warlock: 'cha',
  wizard: 'int',
};

/**
 * Choices some species ask for. Options mirror the tables in the SRD's
 * species descriptions (the rules text itself is shown from the SRD data).
 */
export const SPECIES_CHOICES = {
  dragonborn: [
    {
      key: 'lineage',
      label: 'Draconic ancestry',
      options: [
        ['Black', 'Black (Acid)'],
        ['Blue', 'Blue (Lightning)'],
        ['Brass', 'Brass (Fire)'],
        ['Bronze', 'Bronze (Lightning)'],
        ['Copper', 'Copper (Acid)'],
        ['Gold', 'Gold (Fire)'],
        ['Green', 'Green (Poison)'],
        ['Red', 'Red (Fire)'],
        ['Silver', 'Silver (Cold)'],
        ['White', 'White (Cold)'],
      ],
    },
  ],
  elf: [
    { key: 'lineage', label: 'Elven lineage', options: [['Drow', 'Drow'], ['High Elf', 'High Elf'], ['Wood Elf', 'Wood Elf']] },
    { key: 'ability', label: 'Spellcasting ability for lineage spells', options: [['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']] },
    { key: 'skill', label: 'Keen Senses skill', options: [['Insight', 'Insight'], ['Perception', 'Perception'], ['Survival', 'Survival']] },
  ],
  gnome: [
    { key: 'lineage', label: 'Gnomish lineage', options: [['Forest Gnome', 'Forest Gnome'], ['Rock Gnome', 'Rock Gnome']] },
    { key: 'ability', label: 'Spellcasting ability for lineage spells', options: [['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']] },
  ],
  goliath: [
    {
      key: 'lineage',
      label: 'Giant ancestry',
      options: [
        ['Cloud', "Cloud's Jaunt (Cloud Giant)"],
        ['Fire', "Fire's Burn (Fire Giant)"],
        ['Frost', "Frost's Chill (Frost Giant)"],
        ['Hill', "Hill's Tumble (Hill Giant)"],
        ['Stone', "Stone's Endurance (Stone Giant)"],
        ['Storm', "Storm's Thunder (Storm Giant)"],
      ],
    },
  ],
  human: [
    { key: 'size', label: 'Size', options: [['Medium', 'Medium'], ['Small', 'Small']] },
    { key: 'skill', label: 'Skillful: one skill of your choice', options: Object.keys(SKILLS).map((s) => [s, s]) },
    { key: 'feat', label: 'Versatile: an Origin feat', options: 'origin-feats' },
  ],
  tiefling: [
    { key: 'lineage', label: 'Fiendish legacy', options: [['Abyssal', 'Abyssal'], ['Chthonic', 'Chthonic'], ['Infernal', 'Infernal']] },
    { key: 'ability', label: 'Spellcasting ability for legacy spells', options: [['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']] },
    { key: 'size', label: 'Size', options: [['Medium', 'Medium'], ['Small', 'Small']] },
  ],
};

/** A brand-new, empty character. */
export function newCharacter() {
  return {
    schema: 1,
    name: '',
    level: 1,
    classId: null,
    subclassId: null,
    speciesId: null,
    speciesOptions: {},
    backgroundId: null,
    backgroundBonus: { mode: '2-1', plus2: null, plus1: null },
    abilityMethod: 'standard',
    baseScores: { str: null, dex: null, con: null, int: null, wis: null, cha: null },
    rolledScores: null,
    scoreAdjust: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    classSkills: [],
    equipmentChoice: { class: 'A', background: 'A' },
    inventory: [],
    coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    spells: { cantrips: [], prepared: [] },
    hp: { current: null, temp: 0 },
    hitDiceSpent: 0,
    deathSaves: { successes: 0, failures: 0 },
    slotsUsed: {},
    conditions: [],
    exhaustion: 0,
    heroicInspiration: false,
    details: { alignment: '', appearance: '', personality: '', backstory: '', notes: '' },
  };
}

export const mod = (score) => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level) => Math.ceil(level / 4) + 1;
export const signed = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

export function pointBuySpent(scores) {
  return ABILITIES.reduce((sum, a) => sum + (POINT_BUY_COST[scores[a]] ?? 0), 0);
}

/** Final ability scores: base + background increases + manual adjustments. */
export function abilityScores(c) {
  const out = {};
  for (const a of ABILITIES) {
    let s = Number(c.baseScores?.[a] ?? 10) || 10;
    const b = c.backgroundBonus || {};
    if (b.mode === '1-1-1') {
      if ((b.plus1s || []).includes(a)) s += 1;
    } else {
      if (b.plus2 === a) s += 2;
      if (b.plus1 === a) s += 1;
    }
    // Ability Score Improvements from levelling up (can't go above 20).
    for (const [lvl, choice] of Object.entries(c.levelChoices || {})) {
      // A feat's +1 (e.g. Grappler: Strength or Dexterity) is stored the same way.
      if (Number(lvl) <= (Number(c.level) || 1) && (choice?.type === 'asi' || choice?.type === 'feat')) s += Number(choice.plus?.[a] || 0);
    }
    s = Math.min(s, 20);
    s += Number(c.scoreAdjust?.[a] ?? 0) || 0;
    out[a] = Math.max(1, Math.min(30, s));
  }
  return out;
}

/** Background ability names ("Intelligence") -> keys ("int"). */
export function backgroundAbilityKeys(background) {
  return (background?.abilityScores || []).map((n) => ABILITY_BY_NAME[n]).filter(Boolean);
}

/** Read the class level-table row for a level as { column: value }. */
export function levelRow(cls, level) {
  if (!cls?.levelTable) return {};
  const row = cls.levelTable.rows[Math.max(0, Math.min(19, level - 1))] || [];
  const cols = cls.levelTable.columns;
  const out = {};
  const slotStart = cols.findIndex((c) => /Spell Slots per Spell Level/.test(c));
  cols.forEach((c, i) => {
    if (i === slotStart) return;
    out[c] = row[i];
  });
  if (slotStart !== -1) {
    out.slots = row
      .slice(slotStart)
      .filter((v) => v !== '')
      .map((v) => (/^\d+$/.test(v) ? Number(v) : 0));
  }
  return out;
}

/** Spell slots for a class at a level: { 1: 4, 2: 3, ... }; Warlock pact slots all at one level. */
export function spellSlots(cls, level) {
  const row = levelRow(cls, level);
  const slots = {};
  if (row.slots) {
    row.slots.forEach((n, i) => {
      if (n > 0) slots[i + 1] = n;
    });
  } else if (row['Spell Slots'] && row['Slot Level']) {
    slots[Number(row['Slot Level'])] = Number(row['Spell Slots']);
  }
  return slots;
}

// Subclasses that let a Fighter or Rogue cast spells (e.g. Eldritch Trickster)
// use a third of a full caster's slots. Index = class level; levels 1-2 cast nothing.
const THIRD_CASTER = {
  prepared: [0, 0, 0, 3, 4, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 10, 11, 11, 11, 12, 13],
  slots: [
    [], [], [], [2], [3], [3], [3], [4, 2], [4, 2], [4, 2], [4, 3], [4, 3], [4, 3],
    [4, 3, 2], [4, 3, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 1],
  ],
};

/**
 * What a character can cast at a level. subclass is optional: a few
 * subclasses grant spellcasting to a class that has none.
 * list is the class whose spell list they choose from.
 */
export function spellcasting(cls, level, subclass = null) {
  if (!cls) return null;
  if (!SPELLCASTING_ABILITY[cls.id]) {
    const sc = subclass?.spellcasting;
    if (!sc || level < 3) return null;
    const l = Math.min(20, level);
    const slots = Object.fromEntries(THIRD_CASTER.slots[l].map((n, i) => [i + 1, n]));
    return {
      ability: sc.ability,
      cantrips: sc.cantrips + (l >= 10 ? 1 : 0),
      prepared: THIRD_CASTER.prepared[l],
      slots,
      maxSpellLevel: THIRD_CASTER.slots[l].length,
      pact: false,
      list: sc.list,
      fromSubclass: subclass.name,
    };
  }
  const row = levelRow(cls, level);
  const slots = spellSlots(cls, level);
  const levels = Object.keys(slots).map(Number);
  return {
    ability: SPELLCASTING_ABILITY[cls.id],
    cantrips: Number(row['Cantrips']) || 0,
    prepared: Number(row['Prepared Spells']) || 0,
    slots,
    maxSpellLevel: levels.length ? Math.max(...levels) : 0,
    pact: cls.id === 'warlock',
    list: cls.name,
  };
}

const spellKey = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** Rows of every table in a feature's text (Markdown pipes or HTML), as arrays of cells. */
export function featureTables(text) {
  const tables = [];
  const src = String(text || '');
  for (const m of src.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const rows = [...m[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim()),
    );
    tables.push(rows);
  }
  let cur = null;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('|')) {
      if (/^\|\s*:?-{3,}/.test(t)) continue;
      (cur ||= []).push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    } else if (cur) {
      tables.push(cur);
      cur = null;
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

/**
 * The spells a subclass always has prepared (Domain, Oath, Circle and Patron
 * spells), read from its "... Spells" table, up to the character's level.
 * 2014-style tables list spell levels (1st-5th); those come at the 2024 class
 * levels 3, 3, 5, 7 and 9. Subclasses whose table depends on a choice (several
 * spell columns, or one table per land) are left to the player.
 * @returns {{ spells: object[], missing: string[] }}
 */
export function subclassSpells(subclass, level, spells) {
  const out = { spells: [], missing: [] };
  if (!subclass) return out;
  const byKey = new Map(spells.map((s) => [spellKey(s.name), s]));
  for (const f of subclass.features || []) {
    if (f.level > level || !/spells|spell list|magic$/i.test(f.name)) continue;
    // "Level | Spells" tables. With extra columns (Animal Lords: one per
    // affinity) only the first spell column is always prepared.
    const tables = featureTables(f.description).filter((t) => t.length > 1 && /level/i.test(t[0][0]) && /spells?$/i.test(t[0][1] || ''));
    if (tables.length !== 1) continue;
    const [head, ...rows] = tables[0];
    const bySpellLevel = /spell level/i.test(head[0]);
    for (const [lv, cell = ''] of rows) {
      const n = parseInt(lv, 10);
      if (!n) continue;
      const at = Math.max(3, bySpellLevel ? (n <= 2 ? 3 : 2 * n - 1) : n);
      if (at > level) continue;
      for (const raw of cell.split(/,(?![^(]*\))/)) {
        // "find familiar (snakes only)": the note stays in the feature text.
        const name = raw.replace(/[*_]/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!name) continue;
        const sp = byKey.get(spellKey(name));
        if (sp) {
          if (!out.spells.includes(sp)) out.spells.push(sp);
        } else out.missing.push(name);
      }
    }
  }
  for (const name of subclass.spellcasting?.always || []) {
    const sp = byKey.get(spellKey(name));
    if (sp && !out.spells.includes(sp)) out.spells.push(sp);
  }
  return out;
}

/**
 * Ability scores a feat can raise, read from "Increase your Strength or
 * Dexterity score by 1". Returns { options: ['str', 'dex'], amount: 1 } or null.
 */
export function featAbilityIncrease(feat) {
  const m = String(feat?.description || '').match(/Increase (?:your|one) ((?:[A-Z][a-z]+(?:,\s*| or |, or )?)+?) score(?:s)? by (\d)/);
  if (!m) return null;
  const options = [...m[1].matchAll(/Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma/g)].map((x) => ABILITY_BY_NAME[x[0]]);
  return options.length ? { options, amount: Number(m[2]) } : null;
}

/** Which weapons a class is proficient with, from text like "Simple weapons and Martial weapons that have the Light property". */
export function weaponProficient(cls, weapon) {
  const text = cls?.weaponProficiencies || '';
  if (weapon.category === 'Simple') return /Simple/.test(text);
  if (weapon.category === 'Martial') {
    if (/Martial weapons that have the ([\w ]+?) property/.test(text)) {
      const props = text.match(/that have the ([\w ]+?) property/)[1].split(/\s+or\s+/);
      return weapon.properties.some((p) => props.some((x) => p.startsWith(x)));
    }
    return /Martial/.test(text);
  }
  return false;
}

export function armorTrained(cls, armor) {
  const text = cls?.armorTraining || '';
  if (armor.isShield) return /Shields/.test(text);
  return new RegExp(armor.category, 'i').test(text);
}

/**
 * Parse "Choose A or B: (A) Greataxe, 4 Handaxes, Explorer's Pack, and 15 GP; or (B) 75 GP"
 * into { A: [...], B: [...] } of { name, qty } and { coins: { gp: 15 } }.
 */
export function parseEquipmentOptions(text) {
  const out = {};
  if (!text) return out;
  const re = /\(([A-C])\)\s*([^;]+?)(?=;\s*or\s*\(|;\s*\(|$)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = parseItemList(m[2]);
  if (!Object.keys(out).length) out.A = parseItemList(text);
  return out;
}

function parseItemList(text) {
  const items = [];
  const coins = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const parts = text
    .replace(/\.$/, '')
    .split(/,\s*(?:and\s+)?|\s+and\s+(?![^()]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    const coin = p.match(/^(\d+)\s*(CP|SP|EP|GP|PP)$/i);
    if (coin) {
      coins[coin[2].toLowerCase()] += Number(coin[1]);
      continue;
    }
    const q = p.match(/^(\d+)\s+(.+)$/);
    items.push(q ? { qty: Number(q[1]), name: q[2] } : { qty: 1, name: p });
  }
  return { items, coins };
}

/** Find the weapon / armor / gear entry a starting-equipment name refers to. */
export function matchItem(name, equipment) {
  const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").trim();
  const candidates = [name, name.replace(/es$/, ''), name.replace(/s$/, ''), name.replace(/\s*\(.*\)$/, '')];
  for (const kind of ['weapons', 'armor', 'gear']) {
    for (const c of candidates) {
      const hit = equipment[kind].find((e) => norm(e.name) === norm(c));
      if (hit) return { kind: kind === 'weapons' ? 'weapon' : kind, id: hit.id, name: hit.name };
    }
  }
  return null;
}

/** Turn the chosen starting-equipment options into inventory + coins. */
export function startingInventory(c, srd) {
  const cls = srd.classes.find((x) => x.id === c.classId);
  const bg = srd.backgrounds.find((x) => x.id === c.backgroundId);
  const inventory = [];
  const coins = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const add = (opt) => {
    if (!opt) return;
    for (const it of opt.items) {
      const ref = matchItem(it.name, srd.equipment);
      inventory.push({
        uid: uid(),
        name: ref ? ref.name : it.name,
        qty: it.qty,
        ref: ref ? { kind: ref.kind, id: ref.id } : null,
        equipped: false,
      });
    }
    for (const k of Object.keys(coins)) coins[k] += opt.coins[k];
  };
  add(parseEquipmentOptions(cls?.startingEquipment)[c.equipmentChoice?.class || 'A']);
  add(parseEquipmentOptions(bg?.equipment)[c.equipmentChoice?.background || 'A']);
  // Wear the best armor and a shield the character is trained with, and ready weapons.
  const armors = inventory
    .filter((i) => i.ref?.kind === 'armor')
    .map((i) => ({ i, a: srd.equipment.armor.find((x) => x.id === i.ref.id) }))
    .filter(({ a }) => a && armorTrained(cls, a));
  const body = armors.filter(({ a }) => !a.isShield).sort((x, y) => y.a.baseAc - x.a.baseAc)[0];
  if (body) body.i.equipped = true;
  const shield = armors.find(({ a }) => a.isShield);
  if (shield) shield.i.equipped = true;
  for (const i of inventory) if (i.ref?.kind === 'weapon') i.equipped = true;
  return { inventory, coins };
}

export function uid() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/** Everything the sheet shows, derived from the stored character. */
export function derive(c, srd) {
  const cls = srd.classes.find((x) => x.id === c.classId) || null;
  const subclass = cls?.subclasses.find((s) => s.id === c.subclassId) || null;
  const species = srd.species.find((x) => x.id === c.speciesId) || null;
  const background = srd.backgrounds.find((x) => x.id === c.backgroundId) || null;
  const level = Math.max(1, Math.min(20, Number(c.level) || 1));
  const pb = proficiencyBonus(level);
  const scores = abilityScores(c);
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, mod(scores[a])]));

  const saveProfs = new Set((cls?.savingThrows || []).map((n) => ABILITY_BY_NAME[n]).filter(Boolean));
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, { proficient: saveProfs.has(a), bonus: mods[a] + (saveProfs.has(a) ? pb : 0) }]));

  const skillProfs = new Set([...(background?.skillProficiencies || []), ...(c.classSkills || [])]);
  if (['elf', 'human'].includes(c.speciesId) && c.speciesOptions?.skill) skillProfs.add(c.speciesOptions.skill);
  const expertise = new Set(c.expertise || []);
  const skills = Object.fromEntries(
    Object.entries(SKILLS).map(([name, ab]) => {
      const prof = skillProfs.has(name);
      const exp = prof && expertise.has(name);
      return [name, { ability: ab, proficient: prof, expertise: exp, bonus: mods[ab] + (exp ? pb * 2 : prof ? pb : 0) }];
    }),
  );

  // Feats: background origin feat (+ Human Versatile feat).
  const featNames = [];
  if (background?.feat) featNames.push(background.feat);
  if (c.speciesId === 'human' && c.speciesOptions?.feat) featNames.push(c.speciesOptions.feat);
  for (const [lvl, choice] of Object.entries(c.levelChoices || {})) {
    if (Number(lvl) <= level && choice?.type === 'feat' && choice.feat) featNames.push(choice.feat);
  }
  const feats = featNames.map((label) => {
    const base = label.replace(/\s*\(.*\)$/, '');
    const f = srd.feats.find((x) => x.name === base);
    return { name: label, description: f?.description || '' };
  });
  const hasFeat = (n) => featNames.some((f) => f.startsWith(n));

  // Hit points.
  const hitDie = cls?.hitDie || 8;
  // Level 1: the full Hit Die. Each level after: the roll made when levelling
  // up, or the fixed average (half the die + 1). Plus Con each level.
  let hpMax = hitDie + mods.con;
  for (let l = 2; l <= level; l++) {
    const rolled = Number(c.hpRolls?.[l]);
    hpMax += (rolled >= 1 && rolled <= hitDie ? rolled : hitDie / 2 + 1) + mods.con;
  }
  hpMax = Math.max(level, hpMax);
  if (c.speciesId === 'dwarf') hpMax += level;
  hpMax += Number(c.hpMaxAdjust || 0);

  // Armor Class from equipped armor and shield.
  const equippedArmor = (c.inventory || [])
    .filter((i) => i.equipped && i.ref?.kind === 'armor')
    .map((i) => srd.equipment.armor.find((a) => a.id === i.ref.id))
    .filter(Boolean);
  const body = equippedArmor.find((a) => !a.isShield);
  const shield = equippedArmor.find((a) => a.isShield);
  let ac;
  let acSource;
  if (body) {
    const dex = body.addsDex ? (body.maxDex != null ? Math.min(mods.dex, body.maxDex) : mods.dex) : 0;
    ac = body.baseAc + dex;
    acSource = body.name;
  } else if (cls?.id === 'barbarian') {
    ac = 10 + mods.dex + mods.con;
    acSource = 'Unarmored Defense';
  } else if (cls?.id === 'monk' && !shield) {
    ac = 10 + mods.dex + mods.wis;
    acSource = 'Unarmored Defense';
  } else {
    ac = 10 + mods.dex;
    acSource = 'No armor';
  }
  if (shield) {
    ac += shield.baseAc;
    acSource += ' + Shield';
  }
  ac += Number(c.acAdjust || 0);

  let speed = species?.speed ?? 30;
  if (c.speciesId === 'elf' && c.speciesOptions?.lineage === 'Wood Elf') speed = 35;
  if (body?.strength && scores.str < body.strength) speed -= 10;
  // Barbarian Fast Movement: +10 ft. unless in Heavy armor.
  if (cls?.id === 'barbarian' && level >= 5 && body?.category !== 'Heavy') speed += 10;
  // Monk Unarmored Movement: +10 ft. at level 2, rising to +30 ft., with no armor or shield.
  if (cls?.id === 'monk' && level >= 2 && !body && !shield) speed += 10 + 5 * [6, 10, 14, 18].filter((l) => level >= l).length;
  const exhaustion = Math.max(0, Math.min(6, Number(c.exhaustion) || 0));
  speed = Math.max(0, speed - 5 * exhaustion);

  const initiative = mods.dex + (hasFeat('Alert') ? pb : 0);

  // Attacks with carried weapons.
  const attacks = (c.inventory || [])
    .filter((i) => i.ref?.kind === 'weapon' && i.equipped)
    .map((i) => {
      const w = srd.equipment.weapons.find((x) => x.id === i.ref.id);
      if (!w) return null;
      const finesse = w.properties.some((p) => p.startsWith('Finesse'));
      const ability = w.kind === 'ranged' ? 'dex' : finesse ? (mods.dex > mods.str ? 'dex' : 'str') : 'str';
      const prof = weaponProficient(cls, w);
      // Magic weapons (+1, +2...) add their bonus to both rolls.
      const magic = Number(w.bonus) || 0;
      const toHit = mods[ability] + (prof ? pb : 0) + magic;
      const dmgMod = mods[ability] + magic;
      const dice = w.damage?.dice || '1';
      return {
        uid: i.uid,
        name: i.name,
        ability,
        proficient: prof,
        toHit,
        damage: `${dice}${dmgMod ? (dmgMod > 0 ? '+' : '-') + Math.abs(dmgMod) : ''}`,
        damageType: w.damage?.type || '',
        properties: w.properties,
        mastery: w.mastery,
      };
    })
    .filter(Boolean);
  attacks.push({
    uid: 'unarmed',
    name: 'Unarmed Strike',
    ability: 'str',
    proficient: true,
    toHit: mods.str + pb,
    damage: String(Math.max(0, 1 + mods.str)),
    damageType: 'Bludgeoning',
    properties: [],
    mastery: null,
  });

  const casting = spellcasting(cls, level, subclass);
  const spell = casting
    ? { ...casting, saveDc: 8 + pb + mods[casting.ability], attack: pb + mods[casting.ability] }
    : null;
  // Subclass spells that are always prepared and don't count against the limit.
  const always = casting ? subclassSpells(subclass, level, srd.spells || []) : { spells: [], missing: [] };

  const features = [
    ...(cls?.features || []).filter((f) => f.level <= level).map((f) => ({ ...f, source: cls.name })),
    ...(subclass?.features || []).filter((f) => f.level <= level).map((f) => ({ ...f, source: subclass.name })),
  ];

  return {
    cls,
    subclass,
    species,
    background,
    level,
    pb,
    scores,
    mods,
    saves,
    skills,
    feats,
    hitDie,
    hpMax,
    ac,
    acSource,
    speed,
    initiative,
    passivePerception: 10 + skills.Perception.bonus,
    exhaustion,
    // Exhaustion reduces every D20 Test by 2 per level.
    d20Penalty: 2 * exhaustion,
    attacks,
    spell,
    alwaysSpells: always.spells,
    alwaysMissing: always.missing,
    features,
    speciesTraits: species?.traits || [],
    classRow: levelRow(cls, level),
  };
}

/** What's still missing before a character can be saved. Returns [{ step, message }]. */
export function validate(c, srd) {
  const problems = [];
  const cls = srd.classes.find((x) => x.id === c.classId);
  const bg = srd.backgrounds.find((x) => x.id === c.backgroundId);
  if (!cls) problems.push({ step: 'class', message: 'Choose a class.' });
  if (cls && c.level >= 3 && !c.subclassId) problems.push({ step: 'class', message: 'Choose a subclass (level 3 and up).' });
  if (!bg) problems.push({ step: 'background', message: 'Choose a background.' });
  if (bg) {
    const b = c.backgroundBonus || {};
    const keys = backgroundAbilityKeys(bg);
    if (b.mode === '1-1-1') {
      if ((b.plus1s || []).length !== 3) problems.push({ step: 'background', message: 'Choose your +1 ability increases.' });
    } else if (!b.plus2 || !b.plus1 || b.plus2 === b.plus1 || !keys.includes(b.plus2) || !keys.includes(b.plus1)) {
      problems.push({ step: 'background', message: 'Choose which abilities get +2 and +1.' });
    }
  }
  if (!c.speciesId) problems.push({ step: 'species', message: 'Choose a species.' });
  for (const choice of SPECIES_CHOICES[c.speciesId] || []) {
    if (!c.speciesOptions?.[choice.key]) problems.push({ step: 'species', message: `Choose: ${choice.label}.` });
  }
  if (ABILITIES.some((a) => !Number.isFinite(Number(c.baseScores?.[a])) || c.baseScores?.[a] == null))
    problems.push({ step: 'abilities', message: 'Set all six ability scores.' });
  else if (c.abilityMethod === 'pointbuy' && pointBuySpent(c.baseScores) > POINT_BUY_BUDGET)
    problems.push({ step: 'abilities', message: `Point buy is over ${POINT_BUY_BUDGET} points.` });
  if (cls?.skillChoices?.count && (c.classSkills || []).length !== cls.skillChoices.count)
    problems.push({ step: 'skills', message: `Choose ${cls.skillChoices.count} class skills.` });
  const casting = spellcasting(cls, Number(c.level) || 1, cls?.subclasses.find((s) => s.id === c.subclassId));
  if (casting) {
    if ((c.spells?.cantrips || []).length > casting.cantrips) problems.push({ step: 'spells', message: `Too many cantrips (max ${casting.cantrips}).` });
    if ((c.spells?.prepared || []).length > casting.prepared) problems.push({ step: 'spells', message: `Too many prepared spells (max ${casting.prepared}).` });
  }
  if (!c.name?.trim()) problems.push({ step: 'details', message: 'Give your character a name.' });
  return problems;
}

/** Skills already given by the background/species, so the class step doesn't offer them twice. */
export function fixedSkills(c, srd) {
  const bg = srd.backgrounds.find((x) => x.id === c.backgroundId);
  const set = new Set(bg?.skillProficiencies || []);
  if (['elf', 'human'].includes(c.speciesId) && c.speciesOptions?.skill) set.add(c.speciesOptions.skill);
  return set;
}

/* ------------------------------------------------------- play-time changes */
// These return a new character object; they never change the one passed in.

/** Take damage: Temporary Hit Points go first, then Hit Points (not below 0). */
export function applyDamage(c, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const hp = { ...c.hp };
  const fromTemp = Math.min(hp.temp || 0, n);
  hp.temp = (hp.temp || 0) - fromTemp;
  hp.current = Math.max(0, (hp.current ?? 0) - (n - fromTemp));
  return { ...c, hp };
}

/** Regain Hit Points, up to the maximum. Healing from 0 HP resets death saves. */
export function applyHealing(c, amount, hpMax) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const wasDown = (c.hp.current ?? 0) === 0;
  const out = { ...c, hp: { ...c.hp, current: Math.min(hpMax, (c.hp.current ?? 0) + n) } };
  if (wasDown && n > 0) out.deathSaves = { successes: 0, failures: 0 };
  return out;
}

/** Temporary Hit Points don't stack: keep whichever is higher. */
export function applyTempHp(c, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  return { ...c, hp: { ...c.hp, temp: Math.max(c.hp.temp || 0, n) } };
}

/** Long Rest (2024): all HP and Hit Point Dice back, spell slots back, Exhaustion −1. */
export function longRest(c, hpMax) {
  return {
    ...c,
    hp: { current: hpMax, temp: 0 },
    hitDiceSpent: 0,
    slotsUsed: {},
    deathSaves: { successes: 0, failures: 0 },
    exhaustion: Math.max(0, (Number(c.exhaustion) || 0) - 1),
  };
}

/** Short Rest: Warlock Pact Magic slots come back. (Hit Point Dice are spent separately.) */
export function shortRest(c) {
  return c.classId === 'warlock' ? { ...c, slotsUsed: {} } : c;
}
