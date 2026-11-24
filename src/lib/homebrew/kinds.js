// What each kind of homebrew looks like: its blank template, its form fields,
// and finalize(), which fills in everything the rest of the site works out
// from the form (modifiers, XP, attack and save details, level tables...).
// A finished item has exactly the same shape as the built-in rules data, so
// the builder, sheet, table and rules browser use it like any other entry.

export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const DAMAGE_TYPES = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'];
export const CONDITIONS = ['Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];
export const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
export const CREATURE_TYPES = ['Aberration', 'Beast', 'Celestial', 'Construct', 'Dragon', 'Elemental', 'Fey', 'Fiend', 'Giant', 'Humanoid', 'Monstrosity', 'Ooze', 'Plant', 'Undead'];
export const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
export const CR_LIST = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
export const XP_BY_CR = { 0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000 };
export const WEAPON_PROPERTIES = ['Ammunition', 'Finesse', 'Heavy', 'Light', 'Loading', 'Reach', 'Thrown', 'Two-Handed', 'Versatile'];
export const MASTERIES = ['Cleave', 'Graze', 'Nick', 'Push', 'Sap', 'Slow', 'Topple', 'Vex'];
export const RARITIES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary', 'Artifact'];
export const ITEM_CATEGORIES = ['Armor', 'Potion', 'Ring', 'Rod', 'Scroll', 'Staff', 'Wand', 'Weapon', 'Wondrous Item'];
export const FEAT_CATEGORIES = ['Origin Feat', 'General Feat', 'Fighting Style Feat', 'Epic Boon Feat'];
export const CASTER_TYPES = [
  ['none', 'No spellcasting'],
  ['full', 'Full caster (like a Wizard)'],
  ['half', 'Half caster (like a Paladin)'],
  ['third', 'Third caster (like an Eldritch Knight)'],
  ['pact', 'Pact Magic (like a Warlock)'],
];

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const str = (v) => String(v ?? '').trim();
const mod = (score) => Math.floor((num(score, 10) - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
export const crValue = (rating) => (String(rating).includes('/') ? 1 / Number(String(rating).split('/')[1]) : num(rating));
export const pbForCr = (cr) => Math.max(2, Math.ceil(Math.max(cr, 1) / 4) + 1);

/** "2d6+3" -> 10 (the rounded-down average). */
export function averageOf(dice) {
  const m = String(dice || '')
    .replace(/\s+/g, '')
    .match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return Number(dice) || 0;
  const n = Number(m[1] || 1);
  return Math.floor((n * (Number(m[2]) + 1)) / 2 + Number(m[3] || 0));
}
const diceText = (dice) => String(dice || '').replace(/\s+/g, '').replace(/([+-])/g, ' $1 ');

/* ------------------------------------------------------------- monsters */

function actionEntry(a, who) {
  const out = { name: str(a.name) || 'Action', text: str(a.text) };
  if (a.usesPerDay) {
    out.usesPerDay = num(a.usesPerDay);
    if (!/\/Day\)/.test(out.name)) out.name += ` (${out.usesPerDay}/Day)`;
  }
  if (a.recharge && !/Recharge/.test(out.name)) out.name += ` (Recharge ${a.recharge})`;
  if (a.mode === 'attack') {
    const dmg = [{ average: averageOf(a.damage), dice: str(a.damage).replace(/\s+/g, ''), type: a.damageType || 'Bludgeoning' }];
    if (str(a.extraDamage)) dmg.push({ average: averageOf(a.extraDamage), dice: str(a.extraDamage).replace(/\s+/g, ''), type: a.extraType || 'Fire' });
    const ranged = a.attackKind === 'ranged';
    out.attack = {
      kind: a.attackKind || 'melee',
      bonus: num(a.bonus),
      reach: ranged ? null : `reach ${num(a.reach, 5)} ft.`,
      range: ranged ? `range ${str(a.range) || '80/320'} ft.` : null,
      damage: dmg,
    };
    if (!out.text) {
      const hit = dmg.map((d, i) => `${i ? ' plus ' : ''}${d.average} (${diceText(d.dice)}) ${d.type} damage`).join('');
      out.text = `_${ranged ? 'Ranged' : 'Melee'} Attack Roll:_ ${signed(num(a.bonus))}, ${ranged ? out.attack.range : out.attack.reach} _Hit:_ ${hit}.`;
    }
  } else if (a.mode === 'save') {
    const dmg = str(a.damage) ? [{ average: averageOf(a.damage), dice: str(a.damage).replace(/\s+/g, ''), type: a.damageType || 'Fire' }] : [];
    out.save = { ability: a.saveAbility || 'dex', dc: num(a.dc, 13), damage: dmg, half: !!a.half, condition: a.condition || '' };
    if (!out.text) {
      const fail = [dmg[0] ? `${dmg[0].average} (${diceText(dmg[0].dice)}) ${dmg[0].type} damage` : '', a.condition ? `the target has the ${a.condition} condition` : '']
        .filter(Boolean)
        .join(', and ');
      out.text = `_${ABILITY_NAMES[out.save.ability]} Saving Throw:_ DC ${out.save.dc}, ${str(a.targets) || `one creature ${who} can see within 30 feet`}. _Failure:_ ${fail || 'see the description'}.${a.half && dmg[0] ? ' _Success:_ Half damage.' : ''}`;
    }
  }
  if (!out.text) out.text = '—';
  return out;
}

function finalizeMonster(d) {
  const cr = crValue(d.cr?.rating ?? '1');
  const pb = pbForCr(cr);
  const profs = new Set(d.saveProfs || []);
  const abilities = {};
  for (const k of ABILITY_KEYS) {
    const score = num(d.abilities?.[k]?.score, 10);
    abilities[k] = { score, mod: mod(score), save: mod(score) + (profs.has(k) ? pb : 0) };
  }
  const who = `the ${str(d.name).toLowerCase() || 'creature'}`;
  const list = (items) => (items || []).filter((a) => str(a.name) || str(a.text)).map((a) => ({ ...actionEntry(a, who), form: a }));
  const acValue = num(d.acValue, 12);
  return {
    name: str(d.name),
    group: null,
    size: [d.size || 'Medium'],
    type: str(d.type) || 'Monstrosity',
    alignment: str(d.alignment) || 'Unaligned',
    ac: `${acValue}${str(d.acNote) ? ` (${str(d.acNote)})` : ''}`,
    acValue,
    acNote: str(d.acNote),
    initiative: { bonus: abilities.dex.mod, score: 10 + abilities.dex.mod },
    hp: { average: num(d.hp?.average, 10), formula: str(d.hp?.formula) || null },
    speed: str(d.speed) || '30 ft.',
    abilities,
    saveProfs: [...profs],
    skills: str(d.skills) || null,
    vulnerabilities: str(d.vulnerabilities) || null,
    resistances: str(d.resistances) || null,
    immunities: str(d.immunities) || null,
    gear: null,
    senses: str(d.senses) || `Passive Perception ${10 + abilities.wis.mod}`,
    languages: str(d.languages) || '—',
    cr: { rating: String(d.cr?.rating ?? '1'), value: cr, xp: XP_BY_CR[cr] ?? 0, xpInLair: null, proficiencyBonus: pb },
    traits: (d.traits || []).filter((t) => str(t.name) || str(t.text)).map((t) => ({ name: str(t.name), text: str(t.text) })),
    actions: list(d.actions),
    bonusActions: list(d.bonusActions),
    reactions: list(d.reactions),
    legendaryActions: list(d.legendaryActions),
    legendaryActionsIntro: (d.legendaryActions || []).length
      ? str(d.legendaryActionsIntro) || `Legendary Action Uses: 3. Immediately after another creature's turn, ${who} can spend a use to take one of these actions. It regains all its uses at the start of each of its turns.`
      : null,
    mythicTrait: str(d.mythicTrait?.text) ? { name: str(d.mythicTrait.name) || 'Mythic Trait', text: str(d.mythicTrait.text) } : null,
    mythicActions: str(d.mythicTrait?.text) ? list(d.mythicActions) : [],
    mythicActionsIntro: str(d.mythicTrait?.text) && (d.mythicActions || []).length ? str(d.mythicActionsIntro) || `Once its mythic trait has been used, ${who} can spend its Legendary Action uses on these options too.` : null,
  };
}

/** Turn a stored action back into form fields (for editing or copying a built-in monster). */
function actionForm(a) {
  if (a.form) return a.form;
  const base = { name: a.name, text: a.text, usesPerDay: a.usesPerDay || '' };
  if (a.attack) {
    const [d1, d2] = a.attack.damage || [];
    return {
      ...base,
      mode: 'attack',
      attackKind: /ranged/.test(a.attack.kind) && !/melee/.test(a.attack.kind) ? 'ranged' : 'melee',
      bonus: a.attack.bonus,
      reach: Number(String(a.attack.reach || '').match(/\d+/)?.[0]) || 5,
      range: String(a.attack.range || '').match(/[\d/]+/)?.[0] || '',
      damage: d1?.dice || '',
      damageType: d1?.type || 'Bludgeoning',
      extraDamage: d2?.dice || '',
      extraType: d2?.type || '',
    };
  }
  if (a.save) {
    const d1 = a.save.damage?.[0];
    return { ...base, mode: 'save', saveAbility: a.save.ability, dc: a.save.dc, damage: d1?.dice || '', damageType: d1?.type || 'Fire', half: !!a.save.half, condition: a.save.condition || '' };
  }
  return { ...base, mode: 'text' };
}

export function monsterToForm(m) {
  const list = (items) => (items || []).map(actionForm);
  return {
    ...m,
    size: Array.isArray(m.size) ? m.size[0] : m.size || 'Medium',
    acNote: m.acNote ?? String(m.ac || '').match(/\((.*)\)/)?.[1] ?? '',
    acValue: m.acValue ?? (parseInt(m.ac, 10) || 12),
    saveProfs: m.saveProfs || ABILITY_KEYS.filter((k) => m.abilities?.[k] && m.abilities[k].save !== m.abilities[k].mod),
    actions: list(m.actions),
    bonusActions: list(m.bonusActions),
    reactions: list(m.reactions),
    legendaryActions: list(m.legendaryActions),
    mythicActions: list(m.mythicActions),
    mythicTrait: m.mythicTrait || { name: '', text: '' },
  };
}

/* --------------------------------------------------------------- spells */

function finalizeSpell(d) {
  const material = str(d.components?.materialText);
  const comps = { verbal: !!d.components?.verbal, somatic: !!d.components?.somatic, material: d.components?.hasMaterial ? material || 'a material component' : null };
  comps.raw = [comps.verbal && 'V', comps.somatic && 'S', comps.material && `M (${comps.material})`].filter(Boolean).join(', ') || 'None';
  comps.materialText = material;
  comps.hasMaterial = !!d.components?.hasMaterial;
  const conc = !!d.concentration;
  const dur = str(d.durationBase) || 'Instantaneous';
  const m = d.mechanics || {};
  const mechanics =
    m.kind && m.kind !== 'other'
      ? {
          kind: m.kind,
          attackType: m.kind === 'attack' ? m.attackType || 'ranged' : undefined,
          save: m.kind === 'save' ? m.save || 'dex' : undefined,
          half: m.kind === 'save' ? !!m.half : undefined,
          damage: m.kind !== 'heal' ? str(m.damage).replace(/\s+/g, '') || undefined : undefined,
          damageType: m.kind !== 'heal' ? m.damageType || undefined : undefined,
          heal: m.kind === 'heal' ? str(m.heal).replace(/\s+/g, '') || '1d8' : undefined,
          addMod: m.kind === 'heal' ? !!m.addMod : undefined,
          condition: m.condition || undefined,
          upcast: str(m.upcast).replace(/\s+/g, '') || undefined,
          areaShape: m.areaShape || undefined,
          areaSize: m.areaShape ? num(m.areaSize, 15) : undefined,
          areaSelf: m.areaShape ? !!m.areaSelf : undefined,
          targets: num(m.targets, 1),
        }
      : null;
  return {
    name: str(d.name),
    level: num(d.level),
    school: d.school || 'Evocation',
    classes: [...(d.classes || [])],
    castingTime: `${d.castingTime || 'Action'}${d.ritual ? ' or Ritual' : ''}`.replace(/ or Ritual or Ritual$/, ' or Ritual'),
    castingBase: d.castingBase ?? (d.castingTime || 'Action'),
    ritual: !!d.ritual,
    range: str(d.range) || 'Self',
    components: comps,
    duration: conc ? `Concentration, up to ${dur.charAt(0).toLowerCase()}${dur.slice(1)}` : dur,
    durationBase: dur,
    concentration: conc,
    description: str(d.description),
    higherLevels: num(d.level) > 0 ? str(d.higherLevels) || null : null,
    cantripUpgrade: num(d.level) === 0 ? str(d.cantripUpgrade) || null : null,
    creatureStatBlock: null,
    mechanics,
    mechanicsForm: m,
  };
}

export function spellToForm(s) {
  return {
    ...s,
    castingTime: s.castingBase || String(s.castingTime || 'Action').replace(/ or Ritual$/, ''),
    durationBase: s.durationBase || String(s.duration || '').replace(/^Concentration, up to /i, '').replace(/^./, (c) => c.toUpperCase()),
    components: {
      verbal: !!s.components?.verbal,
      somatic: !!s.components?.somatic,
      hasMaterial: !!s.components?.material,
      materialText: s.components?.materialText ?? (typeof s.components?.material === 'string' ? s.components.material : ''),
    },
    mechanics: s.mechanicsForm || {},
  };
}

/* ------------------------------------------------------ weapons, armor */

function finalizeWeapon(d) {
  const props = [];
  for (const p of d.propertyList || []) {
    if (p === 'Thrown' || p === 'Ammunition') props.push(`${p} (Range ${str(d.range) || '20/60'}${p === 'Ammunition' && str(d.ammo) ? `; ${str(d.ammo)}` : ''})`);
    else if (p === 'Versatile') props.push(`Versatile (${str(d.versatileDice) || '1d10'})`);
    else props.push(p);
  }
  for (const p of str(d.otherProperties).split(',').map((x) => x.trim()).filter(Boolean)) props.push(p);
  const dice = str(d.damage?.dice).replace(/\s+/g, '');
  const type = d.damage?.type || 'Slashing';
  const bonus = num(d.bonus);
  return {
    name: str(d.name),
    category: d.category || 'Simple',
    kind: d.kind || 'melee',
    damage: dice ? { dice, type } : null,
    damageText: dice ? `${dice} ${type}` : 'Special',
    properties: props,
    propertyList: [...(d.propertyList || [])],
    range: str(d.range),
    ammo: str(d.ammo),
    versatileDice: str(d.versatileDice),
    otherProperties: str(d.otherProperties),
    mastery: d.mastery || null,
    weight: str(d.weight) || '—',
    cost: str(d.cost) || '—',
    bonus,
    magic: bonus || d.isMagic ? { rarity: d.rarity || 'Uncommon', attunement: d.attunement ? 'Requires Attunement' : null } : null,
    isMagic: !!d.isMagic,
    rarity: d.rarity || 'Uncommon',
    attunement: !!d.attunement,
    description: str(d.description) || null,
  };
}

export function weaponToForm(w) {
  const list = [];
  let range = w.range || '';
  let ammo = w.ammo || '';
  let versatile = w.versatileDice || '';
  const other = [];
  for (const p of w.properties || []) {
    const m = p.match(/^(Thrown|Ammunition) \(Range ([\d/]+)(?:; ([^)]+))?\)/i);
    const v = p.match(/^Versatile \(([^)]+)\)/i);
    if (m) {
      list.push(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());
      range = m[2];
      ammo = m[3] || ammo;
    } else if (v) {
      list.push('Versatile');
      versatile = v[1];
    } else if (WEAPON_PROPERTIES.includes(p)) list.push(p);
    else other.push(p);
  }
  return {
    ...w,
    propertyList: w.propertyList || list,
    range,
    ammo,
    versatileDice: versatile,
    otherProperties: w.otherProperties ?? other.join(', '),
    bonus: w.bonus || 0,
    isMagic: w.isMagic ?? !!w.magic,
    rarity: w.rarity || w.magic?.rarity || 'Uncommon',
    attunement: w.attunement ?? !!w.magic?.attunement,
  };
}

function finalizeArmor(d) {
  const cat = d.category || 'Light';
  const shield = cat === 'Shield';
  const base = num(d.baseAc, shield ? 2 : 11);
  const addsDex = !shield && cat !== 'Heavy';
  const maxDex = cat === 'Medium' ? num(d.maxDex, 2) : null;
  return {
    name: str(d.name),
    category: cat,
    armorClass: shield ? `+${base}` : `${base}${addsDex ? ` + Dex modifier${maxDex != null ? ` (max ${maxDex})` : ''}` : ''}`,
    baseAc: base,
    addsDex,
    maxDex,
    isShield: shield,
    strength: cat === 'Heavy' && num(d.strength) ? num(d.strength) : null,
    stealthDisadvantage: !!d.stealthDisadvantage,
    weight: str(d.weight) || '—',
    cost: str(d.cost) || '—',
    description: str(d.description) || null,
  };
}

/* ------------------------------------------------------ classes, subclasses */

const ORD = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const REFERENCE_CLASS = { full: 'wizard', half: 'paladin', pact: 'warlock' };
// Third casters (like an Eldritch Knight): cantrips, prepared spells and slots by level.
const THIRD = {
  cantrips: [0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
  prepared: [0, 0, 0, 3, 4, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 10, 11, 11, 11, 12, 13],
  slots: [[], [], [], [2], [3], [3], [3], [4, 2], [4, 2], [4, 2], [4, 3], [4, 3], [4, 3], [4, 3, 2], [4, 3, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 1]],
};

/**
 * Build a class level table like the SRD's: Level, Proficiency Bonus, Class
 * Features (with Subclass at 3, Ability Score Improvements at 4/8/12/16 and an
 * Epic Boon at 19), plus spellcasting columns copied from a matching SRD class.
 */
export function buildLevelTable(d, srdClasses = []) {
  const features = (d.features || []).filter((f) => str(f.name));
  const names = (lvl) => {
    const out = features.filter((f) => num(f.level, 1) === lvl).map((f) => str(f.name));
    if (lvl === 3) out.push(`${str(d.name) || 'Class'} Subclass`);
    if ([4, 8, 12, 16].includes(lvl)) out.push('Ability Score Improvement');
    if (lvl === 19) out.push('Epic Boon');
    if ([6, 10, 14].includes(lvl) && d.subclassFeatures !== false) out.push('Subclass feature');
    return out.join(', ') || '—';
  };
  const type = d.casterType || 'none';
  const ref = srdClasses.find((c) => c.id === REFERENCE_CLASS[type]);
  const columns = ['Level', 'Proficiency Bonus', 'Class Features'];
  let extra = () => [];
  if (type === 'third') {
    columns.push('Cantrips', 'Prepared Spells', '——Spell Slots per Spell Level——');
    extra = (l) => [String(THIRD.cantrips[l]), String(THIRD.prepared[l]), ...[0, 1, 2, 3].map((i) => (THIRD.slots[l][i] ? String(THIRD.slots[l][i]) : '—'))];
  } else if (ref) {
    const start = ref.levelTable.columns.findIndex((c) => /Cantrips|Prepared Spells|Spell Slots|Slot Level/.test(c));
    const cols = ref.levelTable.columns.slice(start).filter((c) => !/Channel Divinity|Eldritch Invocations/.test(c));
    columns.push(...cols);
    const keep = ref.levelTable.columns.map((c, i) => (i >= start && !/Channel Divinity|Eldritch Invocations/.test(c) ? i : -1)).filter((i) => i >= 0);
    const slotStart = ref.levelTable.columns.findIndex((c) => /Spell Slots per Spell Level/.test(c));
    extra = (l) => {
      const row = ref.levelTable.rows[l - 1];
      const out = keep.map((i) => row[i]);
      if (slotStart !== -1) out.push(...row.slice(ref.levelTable.columns.length));
      return out;
    };
  }
  const rows = Array.from({ length: 20 }, (_, i) => {
    const l = i + 1;
    return [String(l), `+${Math.ceil(l / 4) + 1}`, names(l), ...extra(l)];
  });
  return { columns, rows };
}

function finalizeClass(d, srd) {
  const saves = (d.savingThrows || []).slice(0, 2);
  const skillOptions = d.skillOptions || [];
  const skillCount = num(d.skillCount, 2);
  const skillsRaw = `Choose ${skillCount}: ${skillOptions.join(', ')}`;
  const type = d.casterType || 'none';
  const features = (d.features || [])
    .filter((f) => str(f.name))
    .map((f) => ({ level: Math.max(1, Math.min(20, num(f.level, 1))), name: str(f.name), description: str(f.description) || '—' }))
    .sort((a, b) => a.level - b.level);
  const out = {
    name: str(d.name),
    description: str(d.description),
    primaryAbility: d.primaryAbility || 'Strength',
    hitDie: num(d.hitDie, 8),
    savingThrows: saves,
    skillChoices: { count: skillCount, options: skillOptions, raw: skillsRaw },
    skillCount,
    skillOptions,
    weaponProficiencies: str(d.weaponProficiencies) || 'Simple weapons',
    toolProficiencies: str(d.toolProficiencies) || null,
    armorTraining: str(d.armorTraining) || 'None',
    startingEquipment: str(d.startingEquipment) || 'Choose A or B: (A) Dagger, Explorer\'s Pack, and 10 GP; or (B) 50 GP',
    casterType: type,
    spellcasting: type === 'none' ? null : { ability: d.spellAbility || 'int', list: d.spellList || str(d.name), type: type === 'pact' ? 'pact' : type },
    spellAbility: d.spellAbility || 'int',
    spellList: d.spellList || '',
    unarmoredDefense: d.unarmoredDefense || '',
    features,
    subclasses: [],
    extras: [],
  };
  out.coreTraits = {
    'Primary Ability': out.primaryAbility,
    'Hit Point Die': `D${out.hitDie} per ${out.name} level`,
    'Saving Throw Proficiencies': saves.join(' and ') || '—',
    'Skill Proficiencies': skillsRaw,
    'Weapon Proficiencies': out.weaponProficiencies,
    ...(out.toolProficiencies ? { 'Tool Proficiencies': out.toolProficiencies } : {}),
    'Armor Training': out.armorTraining,
    'Starting Equipment': out.startingEquipment,
  };
  out.levelTable = buildLevelTable({ ...d, features }, srd?.classes || []);
  return out;
}

export function classToForm(c) {
  const type =
    c.casterType ||
    (c.spellcasting?.type) ||
    ({ bard: 'full', cleric: 'full', druid: 'full', sorcerer: 'full', wizard: 'full', paladin: 'half', ranger: 'half', warlock: 'pact' }[c.id] ?? 'none');
  const abil = { bard: 'cha', cleric: 'wis', druid: 'wis', sorcerer: 'cha', wizard: 'int', paladin: 'cha', ranger: 'wis', warlock: 'cha' };
  return {
    ...c,
    skillCount: c.skillCount ?? c.skillChoices?.count ?? 2,
    skillOptions: c.skillOptions ?? c.skillChoices?.options ?? [],
    casterType: type,
    spellAbility: c.spellAbility || c.spellcasting?.ability || abil[c.id] || 'int',
    spellList: c.spellList || (c.source && c.source !== 'homebrew' ? c.name : ''),
    unarmoredDefense: c.unarmoredDefense ?? (c.id === 'barbarian' ? 'con' : c.id === 'monk' ? 'wis' : ''),
    features: (c.features || []).map((f) => ({ level: f.level, name: f.name, description: f.description })),
  };
}

function finalizeSubclass(d) {
  const features = (d.features || [])
    .filter((f) => str(f.name))
    .map((f) => ({ level: Math.max(3, Math.min(20, num(f.level, 3))), name: str(f.name), description: str(f.description) || '—' }));
  // Always-prepared spells become a "... Spells" table, which the sheet reads.
  const rows = (d.alwaysPrepared || []).filter((r) => (r.spells || []).length);
  if (rows.length) {
    const table = ['| Level | Spells |', '|---|---|', ...rows.map((r) => `| ${num(r.level, 3)} | ${r.spells.join(', ')} |`)].join('\n');
    features.push({
      level: Math.min(...rows.map((r) => num(r.level, 3))),
      name: `${str(d.name)} Spells`,
      description: `When you reach a level in this table, you always have the listed spells prepared.\n\n${table}`,
      generated: true,
    });
  }
  features.sort((a, b) => a.level - b.level);
  return {
    name: str(d.name),
    classId: d.classId || '',
    tagline: str(d.tagline) || null,
    description: str(d.description),
    features,
    alwaysPrepared: rows.map((r) => ({ level: num(r.level, 3), spells: [...r.spells] })),
  };
}

export function subclassToForm(s) {
  return {
    ...s,
    classId: s.classId || '',
    features: (s.features || []).filter((f) => !f.generated).map((f) => ({ level: f.level, name: f.name, description: f.description })),
    alwaysPrepared: s.alwaysPrepared || [],
  };
}

/* ------------------------------------------ species, backgrounds, feats, items */

function finalizeSpecies(d) {
  const traits = (d.traits || []).filter((t) => str(t.name)).map((t) => ({ name: str(t.name), text: str(t.text) || '—' }));
  return {
    name: str(d.name),
    creatureType: d.creatureType || 'Humanoid',
    size: str(d.size) || 'Medium',
    speed: num(d.speed, 30),
    darkvision: num(d.darkvision, 0) || null,
    traits,
    description: [
      `**Creature Type:** ${d.creatureType || 'Humanoid'}`,
      `**Size:** ${str(d.size) || 'Medium'}`,
      `**Speed:** ${num(d.speed, 30)} feet`,
      ...(num(d.darkvision, 0) ? [`**Darkvision:** ${num(d.darkvision)} feet`] : []),
      str(d.lore),
      ...traits.map((t) => `***${t.name}.*** ${t.text}`),
    ]
      .filter(Boolean)
      .join('\n\n'),
    lore: str(d.lore),
  };
}

function finalizeBackground(d) {
  const out = {
    name: str(d.name),
    abilityScores: (d.abilityScores || []).slice(0, 3),
    feat: d.feat || 'Alert',
    skillProficiencies: (d.skillProficiencies || []).slice(0, 2),
    toolProficiency: str(d.toolProficiency) || null,
    equipment: str(d.equipment) || 'Choose A or B: (A) Traveler\'s Clothes, 15 GP; or (B) 50 GP',
    lore: str(d.lore),
  };
  out.description = [
    `**Ability Scores:** ${out.abilityScores.join(', ')}`,
    `**Feat:** ${out.feat}`,
    `**Skill Proficiencies:** ${out.skillProficiencies.join(' and ')}`,
    `**Tool Proficiency:** ${out.toolProficiency || 'None'}`,
    `**Equipment:** ${out.equipment}`,
    out.lore,
  ]
    .filter(Boolean)
    .join('\n');
  return out;
}

function finalizeFeat(d) {
  const inc = (d.abilityIncrease || []).map((k) => ABILITY_NAMES[k]).filter(Boolean);
  let description = str(d.body);
  // Written the way the rest of the site reads feats ("Increase your X or Y score by 1").
  if (inc.length) {
    const list = inc.length === 1 ? inc[0] : `${inc.slice(0, -1).join(', ')} or ${inc[inc.length - 1]}`;
    description = `***Ability Score Increase.*** Increase your ${list} score by 1, to a maximum of 20.\n\n${description}`;
  }
  if (d.repeatable) description += '\n\n_Repeatable._ You can take this feat more than once.';
  return {
    name: str(d.name),
    category: d.category || 'General Feat',
    prerequisite: str(d.prerequisite) || null,
    repeatable: !!d.repeatable,
    abilityIncrease: [...(d.abilityIncrease || [])],
    body: str(d.body),
    description: description.trim(),
  };
}

export function featToForm(f) {
  return {
    ...f,
    body: f.body ?? String(f.description || '').replace(/^\*\*\*Ability Score Increase\.\*\*\*[^\n]*\n*/, '').replace(/\n*_Repeatable\._[^\n]*$/, ''),
    abilityIncrease: f.abilityIncrease || [],
  };
}

function finalizeMagicItem(d, srd) {
  const baseName = srd?.equipment?.weapons?.find((w) => w.id === d.baseWeapon)?.name || d.baseWeaponName || '';
  d = { ...d, baseWeaponName: baseName };
  const att = d.attunement ? `Requires Attunement${str(d.attunementBy) ? ` by ${str(d.attunementBy)}` : ''}` : null;
  const cat = d.category || 'Wondrous Item';
  return {
    name: str(d.name),
    category: cat,
    rarity: [d.rarity || 'Uncommon'],
    meta: `${cat}${cat === 'Weapon' && d.baseWeapon ? ` (${d.baseWeaponName || d.baseWeapon})` : ''}, ${d.rarity || 'Uncommon'}${att ? ` (${att})` : ''}`,
    attunement: att,
    attunementBy: str(d.attunementBy),
    description: str(d.description),
    creatureStatBlock: null,
    baseWeapon: cat === 'Weapon' ? d.baseWeapon || '' : '',
    baseWeaponName: cat === 'Weapon' ? d.baseWeaponName || '' : '',
    bonus: cat === 'Weapon' ? num(d.bonus) : 0,
  };
}

export function magicItemToForm(i) {
  return { ...i, rarity: Array.isArray(i.rarity) ? i.rarity[0] : i.rarity, attunement: !!i.attunement, attunementBy: i.attunementBy || String(i.attunement || '').match(/by (.*)$/)?.[1] || '' };
}

/* ------------------------------------------------------------- the kinds */

export const KINDS = {
  monster: { label: 'Monster', plural: 'Monsters', dataset: 'monsters', finalize: finalizeMonster, toForm: monsterToForm },
  spell: { label: 'Spell', plural: 'Spells', dataset: 'spells', finalize: finalizeSpell, toForm: spellToForm },
  weapon: { label: 'Weapon', plural: 'Weapons', dataset: 'weapons', finalize: finalizeWeapon, toForm: weaponToForm },
  armor: { label: 'Armor', plural: 'Armor', dataset: 'armor', finalize: finalizeArmor, toForm: (a) => ({ ...a }) },
  class: { label: 'Class', plural: 'Classes', dataset: 'classes', finalize: finalizeClass, toForm: classToForm },
  subclass: { label: 'Subclass', plural: 'Subclasses', dataset: 'subclasses', finalize: finalizeSubclass, toForm: subclassToForm },
  species: { label: 'Species', plural: 'Species', dataset: 'species', finalize: finalizeSpecies, toForm: (s) => ({ ...s, darkvision: s.darkvision || '' }) },
  background: { label: 'Background', plural: 'Backgrounds', dataset: 'backgrounds', finalize: finalizeBackground, toForm: (b) => ({ ...b, lore: b.lore ?? '' }) },
  feat: { label: 'Feat', plural: 'Feats', dataset: 'feats', finalize: finalizeFeat, toForm: featToForm },
  'magic-item': { label: 'Magic Item', plural: 'Magic Items', dataset: 'magic-items', finalize: finalizeMagicItem, toForm: magicItemToForm },
};
export const KIND_ORDER = ['monster', 'spell', 'weapon', 'armor', 'class', 'subclass', 'species', 'background', 'feat', 'magic-item'];

/** A new, empty item of a kind (already finalized, so every field exists). */
export function blank(kind, srd) {
  const base = {
    monster: {
      name: '', size: 'Medium', type: 'Monstrosity', alignment: 'Unaligned', acValue: 12, hp: { average: 10, formula: '3d8' }, speed: '30 ft.',
      abilities: Object.fromEntries(ABILITY_KEYS.map((k) => [k, { score: 10 }])), cr: { rating: '1' },
      actions: [{ name: 'Claw', mode: 'attack', attackKind: 'melee', bonus: 4, reach: 5, damage: '1d6+2', damageType: 'Slashing' }],
    },
    spell: { name: '', level: 1, school: 'Evocation', classes: [], castingTime: 'Action', range: '60 feet', components: { verbal: true, somatic: true }, durationBase: 'Instantaneous', mechanics: { kind: 'other' } },
    weapon: { name: '', category: 'Martial', kind: 'melee', damage: { dice: '1d8', type: 'Slashing' }, propertyList: [] },
    armor: { name: '', category: 'Light', baseAc: 11 },
    class: { name: '', hitDie: 8, primaryAbility: 'Strength', savingThrows: ['Strength', 'Constitution'], skillCount: 2, skillOptions: ['Athletics', 'Perception'], casterType: 'none', features: [{ level: 1, name: '', description: '' }] },
    subclass: { name: '', classId: 'fighter', features: [{ level: 3, name: '', description: '' }] },
    species: { name: '', creatureType: 'Humanoid', size: 'Medium', speed: 30, traits: [{ name: '', text: '' }] },
    background: { name: '', abilityScores: ['Strength', 'Dexterity', 'Constitution'], feat: 'Alert', skillProficiencies: ['Athletics', 'Perception'] },
    feat: { name: '', category: 'General Feat', body: '' },
    'magic-item': { name: '', category: 'Wondrous Item', rarity: 'Uncommon', description: '' },
  }[kind];
  return KINDS[kind].finalize(base, srd);
}

/** Copy a built-in (or homebrew) entry into a homebrew draft. */
export function fromExisting(kind, item, srd) {
  const clean = { ...item };
  for (const k of ['id', 'source', 'sourceName', 'homebrewId', 'ownerId', 'siteLegendary']) delete clean[k];
  const form = KINDS[kind].toForm(clean);
  return KINDS[kind].finalize(form, srd);
}

/** What the editor's form edits: the stored item turned back into form fields. */
export function toForm(kind, data) {
  return KINDS[kind].toForm(structuredClone(data));
}

export { ORD };
