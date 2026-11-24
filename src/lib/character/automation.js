// Rules the live table and the sheet work out automatically: what a spell
// does (attack, save, healing, damage at the slot level), what the database
// needs to know about each creature (AC, HP, saves, resistances), XP, and
// what changes when a character levels up.
import { ABILITIES, derive, levelRow, spellcasting, mod, abilityScores, featAbilityIncrease } from './rules.js';

const ABILITY_BY_WORD = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };

export const DAMAGE_TYPES = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'];

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible',
  'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
];

/* ---------------------------------------------------------------- spells */

/** Add `extra` copies of a die to an expression's first dice term: ("8d6", 2) -> "10d6". */
function addDice(expr, die, extra) {
  if (!extra) return expr;
  const [count, sides] = die.split('d').map(Number);
  const m = expr.match(/^(\d+)d(\d+)/);
  if (m && Number(m[2]) === sides) return expr.replace(/^(\d+)d/, `${Number(m[1]) + count * extra}d`);
  return `${expr}+${count * extra}d${sides}`;
}

/**
 * Work out what a spell does from its rules text.
 * @returns {{kind: 'attack'|'save'|'heal'|'other', attackType?, save?, half?, damage?, damageType?, heal?, addMod?, condition?, scales?}}
 *   damage/heal are dice expressions already scaled for the slot level or the caster's level (cantrips).
 */
export function spellMechanics(spell, { slotLevel = spell?.level || 0, casterLevel = 1, castingMod = 0 } = {}) {
  if (!spell) return { kind: 'other' };
  if (spell.mechanics?.kind) return homebrewMechanics(spell, { slotLevel, casterLevel, castingMod });
  const text = spell.description || '';
  const out = { kind: 'other' };
  const attack = text.match(/make (?:a|one) (ranged|melee) spell attack/i);
  const save = text.match(/(strength|dexterity|constitution|intelligence|wisdom|charisma) saving throw/i);
  const dmg = text.match(/(\d+d\d+(?:\s*\+\s*\d+)?) (acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder) damage/i);
  const heal = text.match(/regains? (?:a number of )?hit points equal to (\d+d\d+)( plus your spellcasting ability modifier)?/i);

  if (heal) {
    out.kind = 'heal';
    out.heal = heal[1];
    out.addMod = !!heal[2];
  } else if (attack) {
    out.kind = 'attack';
    out.attackType = attack[1].toLowerCase();
  } else if (save) {
    out.kind = 'save';
    out.save = ABILITY_BY_WORD[save[1].toLowerCase()];
    out.half = /half as much damage/i.test(text);
    const cond = text.match(/(?:or|and) (?:have|has|is) the (\w+) condition/i) || text.match(/have the (\w+) condition/i);
    if (cond && CONDITIONS.includes(cap(cond[1]))) out.condition = cap(cond[1]);
  }
  if (dmg && out.kind !== 'heal') {
    out.damage = dmg[1].replace(/\s+/g, '');
    out.damageType = cap(dmg[2]);
  }

  // Casting with a higher-level slot.
  const upcast = (spell.higherLevels || '').match(/(?:damage|healing) increases by (\d+d\d+) for each (?:spell )?slot level above (\d)/i);
  if (upcast && slotLevel > Number(upcast[2])) {
    const extra = slotLevel - Number(upcast[2]);
    if (out.kind === 'heal') out.heal = addDice(out.heal, upcast[1], extra);
    else if (out.damage) out.damage = addDice(out.damage, upcast[1], extra);
  }
  // Cantrips get stronger at character levels 5, 11 and 17.
  const cantrip = (spell.cantripUpgrade || '').match(/damage increases by (\d+d\d+) when you reach (?:level|5th)/i);
  if (spell.level === 0 && cantrip && out.damage) {
    const steps = [5, 11, 17].filter((l) => casterLevel >= l).length;
    out.damage = addDice(out.damage, cantrip[1], steps);
  }
  if (out.kind === 'heal' && out.addMod && castingMod) out.heal += castingMod > 0 ? `+${castingMod}` : `${castingMod}`;

  // Spells that always hit (Magic Missile's darts).
  if (out.kind === 'other' && out.damage && /\b(?:strikes|hits) a creature of your choice/i.test(text)) out.kind = 'auto';

  out.use = actionFor(spell.castingTime);
  out.area = spellArea(text);
  Object.assign(out, spellTargets(spell, text, { slotLevel, casterLevel, area: out.area }));
  return out;
}

/**
 * Homebrew spells say what they do in a form instead of in rules text.
 * upcast is the dice added per slot level above the spell's level (or, for a
 * cantrip, at character levels 5, 11 and 17).
 */
function homebrewMechanics(spell, { slotLevel, casterLevel, castingMod }) {
  const m = spell.mechanics;
  const out = { kind: m.kind };
  if (m.kind === 'attack') out.attackType = m.attackType || 'ranged';
  if (m.kind === 'save') {
    out.save = m.save || 'dex';
    out.half = !!m.half;
  }
  if (m.condition && CONDITIONS.includes(m.condition)) out.condition = m.condition;
  if (m.kind === 'heal') {
    out.heal = m.heal || '1d8';
    out.addMod = !!m.addMod;
  } else if (m.damage) {
    out.damage = m.damage;
    out.damageType = m.damageType || 'Force';
  }
  const steps = spell.level === 0 ? [5, 11, 17].filter((l) => casterLevel >= l).length : Math.max(0, slotLevel - spell.level);
  if (m.upcast && /^\d+d\d+$/.test(m.upcast) && steps) {
    if (out.kind === 'heal') out.heal = addDice(out.heal, m.upcast, steps);
    else if (out.damage) out.damage = addDice(out.damage, m.upcast, steps);
  }
  if (out.kind === 'heal' && out.addMod && castingMod) out.heal += castingMod > 0 ? `+${castingMod}` : `${castingMod}`;
  out.use = actionFor(spell.castingTime);
  out.area = m.areaShape
    ? { shape: m.areaShape, size: Number(m.areaSize) || 15, ...(m.areaShape === 'line' ? { width: 5 } : {}), self: m.areaShape === 'cone' || m.areaShape === 'line' || !!m.areaSelf }
    : null;
  out.targets = out.area ? Infinity : Math.max(1, Number(m.targets) || 1);
  out.repeat = false;
  return out;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = (w) => NUMBER_WORDS[String(w).toLowerCase()] ?? Number(w);

/** 'Action', 'Bonus Action, which you take...', 'Reaction, which...' -> the part of a turn it uses. */
export function actionFor(castingTime) {
  const t = String(castingTime || '').toLowerCase();
  if (t.startsWith('bonus action')) return 'bonus';
  if (t.startsWith('reaction')) return 'reaction';
  return 'action';
}

/**
 * The area a spell covers, from text like "20-foot-radius Sphere",
 * "15-foot Cone", "100-foot-long, 5-foot-wide Line" or "15-foot Cube".
 * @returns {{shape: 'circle'|'cone'|'line'|'cube', size: number, width?: number, self: boolean} | null}
 *   size in feet (a circle's radius, a cone's or line's length, a cube's side).
 *   self = the area starts at the caster rather than at a point you choose.
 */
export function spellArea(text) {
  const t = String(text || '');
  const line = t.match(/(\d+)-foot-long,? (\d+)-foot-wide Line/i);
  if (line) return { shape: 'line', size: Number(line[1]), width: Number(line[2]), self: true };
  const m = t.match(/(\d+)-foot(?:-radius)?(?:,? \d+-foot-(?:high|tall))? (Sphere|Cylinder|Emanation|Cone|Cube|Line)\b/i);
  if (!m) return null;
  const size = Number(m[1]);
  const kind = m[2].toLowerCase();
  if (kind === 'cone') return { shape: 'cone', size, self: true };
  if (kind === 'line') return { shape: 'line', size, width: 5, self: true };
  if (kind === 'cube') return { shape: 'cube', size, self: /originating from you|from you\b/i.test(t) };
  if (kind === 'emanation') return { shape: 'circle', size, self: true };
  return { shape: 'circle', size, self: false };
}

/**
 * How many creatures a spell can affect, so a single-target spell can't hit
 * a crowd. repeat = the same creature can be chosen more than once (rays,
 * darts and beams, each its own attack or hit). An area spell has no limit:
 * it affects whoever is inside.
 */
export function spellTargets(spell, text, { slotLevel = spell.level, casterLevel = 1, area = null } = {}) {
  if (area) return { targets: Infinity, repeat: false };
  const above = Math.max(0, slotLevel - spell.level);
  const higher = spell.higherLevels || '';
  // Rays, darts and beams.
  const shots = text.match(/(?:create|hurl|fire|launch)s? (one|two|three|four|five|\d+) (?:glowing |fiery |crackling |\w+ )?(darts|rays|beams|bolts|motes)/i);
  if (shots) {
    const more = /one (?:more|additional) (?:dart|ray|beam|bolt|mote) for each spell slot level above/i.test(higher) ? above : 0;
    return { targets: num(shots[1]) + more, repeat: true, shots: shots[2].toLowerCase() };
  }
  const beams = (spell.cantripUpgrade || '').match(/creates two beams at level (\d+), three beams at level (\d+), and four beams at level (\d+)/i);
  if (beams) {
    const n = 1 + [beams[1], beams[2], beams[3]].filter((l) => casterLevel >= Number(l)).length;
    return { targets: n, repeat: true, shots: 'beams' };
  }
  const upTo = text.match(/up to (one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d+) (?:creatures|targets|willing creatures|Humanoids|Beasts)/i);
  let n = upTo ? num(upTo[1]) : 1;
  const extra = higher.match(/(?:target|affect) (one|two) additional (?:creature|Humanoid|Beast|target)s? for each (?:spell )?slot level above/i);
  if (extra) n += num(extra[1]) * above;
  return { targets: n, repeat: false };
}

function cap(w) {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** The spells a character can cast at the table, with the slot levels open to each. */
export function castableSpells(c, srd) {
  const d = derive(c, srd);
  if (!d.spell) return [];
  const byId = (id) => srd.spells.find((s) => s.id === id);
  const slots = d.spell.slots || {};
  const used = c.slotsUsed || {};
  const chosen = [...(c.spells?.cantrips || []), ...(c.spells?.prepared || [])].map(byId).filter(Boolean);
  return [...chosen, ...d.alwaysSpells.filter((s) => !chosen.includes(s))]
    .map((spell) => {
      const levels =
        spell.level === 0
          ? [0]
          : Object.keys(slots)
              .map(Number)
              .filter((l) => l >= spell.level)
              .sort((a, b) => a - b);
      const open = levels.filter((l) => l === 0 || (slots[l] || 0) - (Number(used[l]) || 0) > 0);
      return { spell, levels, open };
    });
}

/* ------------------------------------------------- creatures and the table */

/** Split "Fire, Poison; Charmed, Poisoned" into damage types (before the ;). */
export function damageTypesFrom(text) {
  if (!text) return [];
  const first = String(text).split(';')[0];
  return DAMAGE_TYPES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(first));
}

/** What the database needs to know about a monster to resolve attacks and saves. */
export function monsterSecrets(mon, { hp } = {}) {
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, mon.abilities?.[a]?.save ?? mon.abilities?.[a]?.mod ?? 0]));
  const h = hp ?? mon.hp?.average ?? null;
  return {
    hp_current: h,
    hp_max: h,
    ac: mon.acValue ?? (parseInt(mon.ac, 10) || null),
    saves,
    resist: damageTypesFrom(mon.resistances),
    immune: damageTypesFrom(mon.immunities),
    vulnerable: damageTypesFrom(mon.vulnerabilities),
    xp: mon.cr?.xp ?? null,
  };
}

/** First walking speed in a stat block's "30 ft., Fly 60 ft.". */
export function walkSpeed(text) {
  const m = String(text || '').match(/^(\d+) ft/);
  return m ? Number(m[1]) : 30;
}

/**
 * What a character can do in a turn, for the database to count: speed,
 * attacks per Attack action (Extra Attack), uses of Action Surge, Second
 * Wind and Rage, spell slots. Written to the token by the DM's browser.
 */
export function combatStats(c, srd) {
  const d = derive(c, srd);
  const names = new Set(d.features.map((f) => f.name));
  const lvl = d.level;
  const stats = { speed: d.speed, attacks: 1, level: lvl };
  if (names.has('Three Extra Attacks')) stats.attacks = 4;
  else if (names.has('Two Extra Attacks')) stats.attacks = 3;
  else if (names.has('Extra Attack')) stats.attacks = 2;
  if (names.has('Action Surge')) stats.actionSurge = lvl >= 17 ? 2 : 1;
  if (names.has('Second Wind')) stats.secondWind = Number(d.classRow['Second Wind']) || 2;
  if (names.has('Rage')) stats.rage = Number(d.classRow['Rages']) || 2;
  if (d.spell && Object.keys(d.spell.slots || {}).length) stats.slots = { ...d.spell.slots };
  return stats;
}

/** Bonus actions a character's class gives them (beyond bonus-action spells). */
export function classBonusActions(c, srd) {
  const d = derive(c, srd);
  const names = new Set(d.features.map((f) => f.name));
  const armored = (c.inventory || []).some((i) => i.equipped && i.ref?.kind === 'armor');
  const light = d.attacks.filter((a) => a.properties?.includes('Light'));
  return {
    cunning: names.has('Cunning Action'),
    // Monk Martial Arts: an Unarmed Strike as a Bonus Action, with no armor or shield.
    martialArts: names.has('Martial Arts') && !armored,
    // Two Light weapons: an extra attack with the other one (no ability modifier to damage unless it's negative).
    offHand: light.length >= 2 ? light : [],
    secondWind: names.has('Second Wind'),
    rage: names.has('Rage'),
    actionSurge: names.has('Action Surge'),
  };
}

/** What the database needs to know about a player character (kept up to date by the DM's browser). */
export function characterSecrets(c, srd) {
  const d = derive(c, srd);
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, d.saves[a].bonus - d.d20Penalty]));
  return { ac: d.ac, hp_max: d.hpMax, saves };
}

/* --------------------------------------------------------------- XP and levels */

// Experience points needed for each level (2024 rules).
export const XP_FOR_LEVEL = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

export function levelForXp(xp) {
  let lvl = 1;
  for (let l = 2; l <= 20; l++) if ((Number(xp) || 0) >= XP_FOR_LEVEL[l]) lvl = l;
  return lvl;
}

/** Can this character level up from their XP? */
export function canLevelUp(c) {
  const level = Number(c.level) || 1;
  return level < 20 && (Number(c.xp) || 0) >= XP_FOR_LEVEL[level + 1];
}

/** Everything that changes when a character goes up one level. */
export function levelUpInfo(c, srd) {
  const d = derive(c, srd);
  const cls = d.cls;
  const level = d.level + 1;
  if (!cls || level > 20) return null;
  const row = levelRow(cls, level);
  const featureText = String(row['Class Features'] || '');
  const features = [
    ...cls.features.filter((f) => f.level === level),
    ...(cls.subclasses.find((s) => s.id === c.subclassId)?.features || []).filter((f) => f.level === level),
  ];
  const hitDie = cls.hitDie || 8;
  const sub = cls.subclasses.find((s) => s.id === c.subclassId) || null;
  const before = spellcasting(cls, d.level, sub);
  const after = spellcasting(cls, level, sub);
  const conMod = mod(abilityScores(c).con);
  return {
    level,
    hitDie,
    conMod,
    hpAverage: hitDie / 2 + 1,
    features,
    needsSubclass: !c.subclassId && /Subclass/i.test(featureText) && level === 3,
    subclasses: cls.subclasses,
    asi: /Ability Score Improvement/.test(featureText),
    epicBoon: /Epic Boon/.test(featureText),
    proficiencyBonus: Math.ceil(level / 4) + 1,
    spells: after
      ? {
          cantrips: after.cantrips - (before?.cantrips || 0),
          prepared: after.prepared - (before?.prepared || 0),
          maxSpellLevel: after.maxSpellLevel,
          newSlotLevel: after.maxSpellLevel > (before?.maxSpellLevel || 0) ? after.maxSpellLevel : null,
        }
      : null,
  };
}

/**
 * Apply a level up. choice: { hp: 'average' | number (the rolled Hit Die),
 *   subclassId?, asi?: { str: 2 } | { str: 1, dex: 1 }, feat?: 'Grappler' }
 */
export function applyLevelUp(c, srd, choice = {}) {
  const info = levelUpInfo(c, srd);
  if (!info) return c;
  const before = derive(c, srd);
  const next = { ...c, level: info.level, hpRolls: { ...(c.hpRolls || {}) }, levelChoices: { ...(c.levelChoices || {}) } };
  if (typeof choice.hp === 'number') next.hpRolls[info.level] = Math.max(1, Math.min(info.hitDie, Math.round(choice.hp)));
  if (info.needsSubclass && choice.subclassId) next.subclassId = choice.subclassId;
  if (info.asi || info.epicBoon) {
    if (choice.feat) {
      // Most feats also raise one ability score by 1; the player picks which.
      const inc = featAbilityIncrease(srd.feats.find((f) => f.name === choice.feat));
      const pick = inc && (inc.options.includes(choice.featAbility) ? choice.featAbility : inc.options[0]);
      next.levelChoices[info.level] = { type: 'feat', feat: choice.feat, ...(pick ? { plus: { [pick]: inc.amount } } : {}) };
    }
    else if (choice.asi) {
      const plus = {};
      let total = 0;
      for (const a of ABILITIES) {
        const n = Math.max(0, Math.min(2, Number(choice.asi[a]) || 0));
        if (n) plus[a] = n;
        total += n;
      }
      if (total > 2) throw new Error('An Ability Score Improvement is +2 to one score or +1 to two.');
      next.levelChoices[info.level] = { type: 'asi', plus };
    }
  }
  // Gaining a level raises your current HP by the same amount as your maximum.
  const after = derive(next, srd);
  const gained = after.hpMax - before.hpMax;
  if (next.hp && next.hp.current != null) next.hp = { ...next.hp, current: Math.max(0, next.hp.current + gained) };
  return next;
}

/**
 * A monster's actions the table can resolve automatically: attack rolls and
 * saving-throw effects (breath weapons, gazes...). Damage that only applies
 * "if" something happened (e.g. with Advantage) is left for the DM.
 */
export function monsterActions(mon) {
  const all = [...(mon.actions || []), ...(mon.bonusActions || []), ...(mon.legendaryActions || []), ...(mon.mythicActions || [])];
  const out = [];
  for (const a of all) {
    const text = a.text || '';
    const clean = (d) => String(d || '').replace(/\s+/g, '');
    if (a.attack) {
      const [first, ...rest] = a.attack.damage || [];
      const extra = rest
        .filter((dmg) => {
          // "plus 2 (1d4) Slashing damage if the attack roll had Advantage" is conditional.
          const re = new RegExp(`\\(${dmg.dice.replace(/[+]/g, '\\s*\\+\\s*')}\\)\\s*${dmg.type} damage(?:,)?\\s+if\\b`, 'i');
          return !re.test(text);
        })
        .map((dmg) => ({ dice: clean(dmg.dice), type: dmg.type }));
      out.push({
        name: a.name,
        kind: 'attack',
        bonus: a.attack.bonus,
        damage: first ? clean(first.dice) : '',
        damageType: first?.type || '',
        extra,
        rider: a.save ? { ability: a.save.ability, dc: a.save.dc } : null,
      });
    } else if (a.save?.ability && a.save?.dc) {
      const dmg = a.save.damage?.[0];
      const cond = text.match(/_Failure:_[^_]*?\bthe (\w+) condition/i);
      out.push({
        name: a.name,
        kind: 'save',
        save: a.save.ability,
        dc: a.save.dc,
        damage: dmg ? clean(dmg.dice) : '',
        damageType: dmg?.type || '',
        // Imported monsters carry these already; SRD ones are read from the text.
        half: a.save.half ?? /_Success:_\s*Half damage/i.test(text),
        condition: a.save.condition ?? (cond && CONDITIONS.includes(cap(cond[1])) ? cap(cond[1]) : ''),
      });
    }
  }
  return out;
}
