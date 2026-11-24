// Converts Open5e creatures into the site's monster stat-block format (the
// same shape scripts/srd/parsers.mjs makes for the SRD monsters), and adds
// legendary and mythic actions to the major monsters that have none.

const ABIL = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const ABIL_NAME = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
const DAMAGE = 'acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder';
const CONDITIONS = ['Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];
const XP = { 0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000 };

// Monsters at or above these challenge ratings count as "major".
export const LEGENDARY_FROM_CR = 12;
export const MYTHIC_FROM_CR = 17;

const cap = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
const capFirst = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);

function crRating(v) {
  return v === 0.125 ? '1/8' : v === 0.25 ? '1/4' : v === 0.5 ? '1/2' : String(v);
}

function speedText(sp = {}) {
  const parts = [`${sp.walk ?? 0} ft.`];
  for (const k of ['burrow', 'climb', 'fly', 'swim']) if (sp[k]) parts.push(`${cap(k)} ${sp[k]} ft.${k === 'fly' && sp.hover ? ' (hover)' : ''}`);
  return parts.join(', ');
}

/** "Melee Weapon Attack: +6 to hit, reach 5 ft. ... Hit: 10 (2d6 + 3) piercing damage plus 7 (2d6) fire damage." */
export function parseAttack(text) {
  const t = String(text || '').replace(/_/g, '');
  const m = t.match(/(Melee or Ranged|Melee|Ranged)\s+(?:Weapon|Spell)?\s*Attack(?: Roll)?[:.]\s*([+-]\d+)/i);
  if (!m) return null;
  const hit = t.split(/\bHit:/i)[1] || '';
  const damage = [];
  const re = new RegExp(`(\\d+)\\s*\\((\\d+d\\d+(?:\\s*[+-]\\s*\\d+)?)\\)\\s*(${DAMAGE}) damage`, 'gi');
  for (const d of hit.matchAll(re)) damage.push({ average: Number(d[1]), dice: d[2].replace(/\s+/g, ''), type: cap(d[3]) });
  const reach = t.match(/reach (\d+) ft\./i);
  const range = t.match(/range (\d+\/\d+|\d+) ft\./i);
  return {
    kind: m[1].toLowerCase(),
    bonus: Number(m[2]),
    reach: reach ? `reach ${reach[1]} ft.` : null,
    range: range ? `range ${range[1]} ft.` : null,
    damage,
  };
}

/** "...must make a DC 15 Constitution saving throw, taking 28 (8d6) poison damage on a failed save, or half as much..." */
export function parseSave(text) {
  const t = String(text || '').replace(/_/g, '');
  const m = t.match(/DC (\d+) (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i);
  if (!m) return null;
  const after = t.slice(m.index);
  const damage = [];
  const re = new RegExp(`(\\d+)\\s*\\((\\d+d\\d+(?:\\s*[+-]\\s*\\d+)?)\\)\\s*(${DAMAGE}) damage`, 'gi');
  for (const d of after.matchAll(re)) damage.push({ average: Number(d[1]), dice: d[2].replace(/\s+/g, ''), type: cap(d[3]) });
  const cond = after.match(/\b(?:be|is|becomes?|become|has the|is magically) (blinded|charmed|deafened|frightened|grappled|incapacitated|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious)\b/i);
  return {
    ability: Object.entries(ABIL_NAME).find(([, n]) => n.toLowerCase() === m[2].toLowerCase())[0],
    dc: Number(m[1]),
    damage,
    half: /half as much|half damage/i.test(after),
    condition: cond && CONDITIONS.includes(cap(cond[1])) ? cap(cond[1]) : '',
  };
}

function usesSuffix(uses, name) {
  if (!uses || /\(Recharge|\/Day/i.test(name)) return '';
  if (uses.type === 'RECHARGE_ON_ROLL') return uses.param === 6 ? ' (Recharge 6)' : ` (Recharge ${uses.param}–6)`;
  if (uses.type === 'PER_DAY') return ` (${uses.param}/Day)`;
  if (uses.type === 'RECHARGE_AFTER_REST') return ' (Recharges after a Short or Long Rest)';
  return '';
}

/**
 * One Open5e creature -> site monster.
 * @param clean the same text tidier the rest of the importer uses
 */
export function convertCreature(c, clean, sourceName) {
  const abilities = {};
  for (const [long, key] of Object.entries(ABIL)) {
    const score = c.abilities?.[long] ?? 10;
    const mod = Math.floor((score - 10) / 2);
    abilities[key] = { score, mod, save: c.saves?.[long] ?? mod };
  }
  const skills = Object.entries(c.skills || {})
    .map(([k, v]) => `${cap(k.replace(/_/g, ' '))} ${fmt(v)}`)
    .join(', ');
  const def = c.defenses || {};
  const imm = [def.damage_immunities_display, def.condition_immunities_display].filter(Boolean).join('; ');
  const s = c.senses || {};
  const senses = [
    s.blindsight && `Blindsight ${s.blindsight} ft.`,
    s.darkvision && `Darkvision ${s.darkvision} ft.`,
    s.tremorsense && `Tremorsense ${s.tremorsense} ft.`,
    s.truesight && `Truesight ${s.truesight} ft.`,
  ]
    .filter(Boolean)
    .join(', ');
  const init = c.initiative ?? abilities.dex.mod;
  const entry = (a) => {
    const text = clean(a.desc);
    const out = { name: `${a.name}${usesSuffix(a.uses, a.name)}${a.cost > 1 ? ` (Costs ${a.cost} Actions)` : ''}`, text };
    const attack = parseAttack(text);
    const save = parseSave(text);
    if (attack) out.attack = attack;
    if (save) out.save = save;
    if (a.uses?.type === 'PER_DAY') out.usesPerDay = a.uses.param;
    return out;
  };
  const byType = (type) => c.actions.filter((a) => a.type === type);
  // Level Up writes "The dragon can take 3 legendary actions" as if it were an action.
  const legendary = byType('LEGENDARY_ACTION');
  const introEntry = legendary.find((a) => /can take \d+ legendary actions?/i.test(a.name));
  const name = c.name.trim();
  const monster = {
    id: null,
    name,
    group: null,
    source: c.source,
    sourceName,
    size: [c.size || 'Medium'],
    type: c.type || 'Monstrosity',
    alignment: capFirst(c.alignment || 'Unaligned'),
    ac: `${c.ac}${c.acDetail ? ` (${clean(c.acDetail).replace(/^\(|\)$/g, '')})` : ''}`,
    acValue: c.ac,
    initiative: { bonus: init, score: 10 + init },
    hp: { average: c.hp, formula: c.hitDice ? c.hitDice.replace(/\s+/g, '') : null },
    speed: speedText(c.speed),
    abilities,
    skills: skills || null,
    vulnerabilities: def.damage_vulnerabilities_display || null,
    resistances: def.damage_resistances_display || null,
    immunities: imm || null,
    gear: null,
    senses: `${senses ? `${senses}; ` : ''}Passive Perception ${s.passive ?? 10 + abilities.wis.mod}`,
    languages: c.languages || '—',
    cr: { rating: crRating(c.cr), value: c.cr, xp: c.xp ?? XP[c.cr] ?? 0, xpInLair: null, proficiencyBonus: c.pb ?? Math.max(2, Math.ceil(c.cr / 4) + 1) },
    traits: c.traits.map((t) => ({ name: t.name, text: clean(t.desc) })),
    actions: byType('ACTION').map(entry),
    bonusActions: byType('BONUS_ACTION').map(entry),
    reactions: byType('REACTION').map(entry),
    legendaryActions: legendary.filter((a) => a !== introEntry).map(entry),
    legendaryActionsIntro: null,
  };
  if (monster.legendaryActions.length) {
    const n = Number(introEntry?.name.match(/(\d+)/)?.[1]) || 3;
    monster.legendaryActionsIntro = c.legendaryIntro
      ? clean(c.legendaryIntro)
      : `Legendary Action Uses: ${n}. Immediately after another creature's turn, the ${lowerName(name)} can spend a use to take one of these actions. It regains all its uses at the start of each of its turns.`;
  }
  return monster;
}

function lowerName(name) {
  // "Dragon, Ancient Red" -> "ancient red dragon".
  const [a, b] = name.split(/,\s*/);
  return (b ? `${b} ${a}` : a).toLowerCase();
}

/* ------------------------------------------- legendary and mythic actions */

function bestAttack(m) {
  return [...m.actions].filter((a) => a.attack && !/multiattack/i.test(a.name)).sort((a, b) => avgDamage(b) - avgDamage(a))[0] || null;
}
function avgDamage(a) {
  return (a.attack?.damage || a.save?.damage || []).reduce((s, d) => s + (d.average || 0), 0);
}
function bestSaveAction(m) {
  return [...m.actions].filter((a) => a.save && !a.attack && !/\(Recharge|\/Day/i.test(a.name)).sort((a, b) => avgDamage(b) - avgDamage(a))[0] || null;
}
const baseName = (a) => a.name.replace(/\s*\(.*\)$/, '');

/**
 * Major monsters (CR 12+) without legendary actions get a standard set built
 * from their own stat block. They're marked so the DM knows the site added them.
 */
export function addLegendaryActions(m) {
  if (m.legendaryActions.length || (m.cr?.value ?? 0) < LEGENDARY_FROM_CR) return false;
  const who = `the ${lowerName(m.name)}`;
  const atk = bestAttack(m);
  const sv = bestSaveAction(m);
  const list = [];
  if (atk) list.push({ ...atk, name: baseName(atk), text: `${capFirst(who)} makes one ${baseName(atk)} attack.`, attack: atk.attack });
  list.push({ name: 'Move', text: `${capFirst(who)} moves up to half its Speed without provoking Opportunity Attacks.` });
  if (sv) list.push({ ...sv, name: `${baseName(sv)} (Costs 2 Actions)`, text: `${capFirst(who)} uses ${baseName(sv)}.\n\n${sv.text}` });
  else if (atk) list.push({ name: 'Crushing Blow (Costs 2 Actions)', text: `${capFirst(who)} makes one ${baseName(atk)} attack with Advantage. On a hit, the target also has the Prone condition if it is Huge or smaller.`, attack: atk.attack });
  m.legendaryActions = list;
  m.legendaryActionsIntro = `Legendary Action Uses: 3. Immediately after another creature's turn, ${who} can spend a use to take one of these actions. It regains all its uses at the start of each of its turns. _(Added by this site for major monsters; the DM can leave them out.)_`;
  m.siteLegendary = true;
  return true;
}

/**
 * The biggest bosses (CR 17+) get a mythic trait: when first reduced to 0 Hit
 * Points they rise again, and unlock mythic actions for the rest of the fight.
 */
export function addMythic(m) {
  if ((m.cr?.value ?? 0) < MYTHIC_FROM_CR || !m.legendaryActions.length || m.mythicActions?.length) return false;
  const who = `the ${lowerName(m.name)}`;
  const Who = capFirst(who);
  const half = Math.floor((m.hp?.average || 0) / 2);
  m.mythicTrait = {
    name: 'Mythic Resurgence (1/Day)',
    text: `If ${who} is reduced to 0 Hit Points, it doesn't die or fall Unconscious. Instead it ends every condition on itself and regains ${half} Hit Points (half its maximum). Until the end of the fight it can also use the Mythic Actions below.`,
  };
  const atk = bestAttack(m);
  const sv = bestSaveAction(m) || m.actions.find((a) => a.save && !a.attack);
  const list = [];
  if (atk) list.push({ name: `Relentless ${baseName(atk)}`, text: `${Who} makes two ${baseName(atk)} attacks.`, attack: atk.attack });
  if (sv) list.push({ ...sv, name: `Unleashed ${baseName(sv)} (Costs 2 Actions)`, text: `${Who} uses ${baseName(sv)}, even if it isn't recharged or has no uses left.\n\n${sv.text}` });
  list.push({
    name: 'Shrug It Off',
    text: `${Who} ends one condition on itself and gains ${Math.max(10, Math.round((m.hp?.average || 0) / 10))} Temporary Hit Points.`,
  });
  list.push({
    name: 'Terrible Presence (Costs 2 Actions)',
    text: `_Wisdom Saving Throw:_ DC ${8 + (m.cr.proficiencyBonus || 2) + Math.max(m.abilities.cha.mod, m.abilities.wis.mod, 0)}, each enemy within 30 feet that can see ${who}. _Failure:_ The target has the Frightened condition until the end of its next turn.`,
    save: { ability: 'wis', dc: 8 + (m.cr.proficiencyBonus || 2) + Math.max(m.abilities.cha.mod, m.abilities.wis.mod, 0), damage: [], half: false, condition: 'Frightened' },
  });
  const dc = 8 + (m.cr.proficiencyBonus || 2) + Math.max(m.abilities.str.mod, m.abilities.dex.mod, 0);
  list.push({
    name: 'Sweep Aside',
    text: `_Strength Saving Throw:_ DC ${dc}, each creature within 10 feet of ${who}. _Failure:_ The target is pushed up to 10 feet away and has the Prone condition.`,
    save: { ability: 'str', dc, damage: [], half: false, condition: 'Prone' },
  });
  m.mythicActions = list;
  m.mythicActionsIntro = `Once Mythic Resurgence has been used, ${who} can spend its Legendary Action uses on these options too. _(Added by this site; the DM can leave them out.)_`;
  return true;
}
