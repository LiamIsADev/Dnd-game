// Put homebrew items into the rules data, next to the built-in entries.
// The cached rules objects are shared by every page, so nothing here changes
// them: each list that gets homebrew is copied first.
import { KINDS } from './kinds.js';

export const hbId = (row) => `hb-${row.id}`;

/** The rules entry for a stored homebrew row. */
export function entryFor(row) {
  return {
    ...row.data,
    id: hbId(row),
    name: row.name,
    source: 'homebrew',
    sourceName: 'Homebrew',
    homebrewId: row.id,
    ownerId: row.owner_id,
  };
}

/** A Weapon-type magic item with a base weapon is also a weapon you can attack with. */
export function magicWeaponFor(item, weapons) {
  if (item.category !== 'Weapon' || !item.baseWeapon) return null;
  const base = weapons.find((w) => w.id === item.baseWeapon);
  if (!base) return null;
  return {
    ...base,
    id: `${item.id}-weapon`,
    name: item.name,
    baseId: base.id,
    baseName: base.name,
    bonus: Number(item.bonus) || 0,
    magic: { rarity: item.rarity?.[0] || 'Uncommon', attunement: item.attunement, itemId: item.id },
    description: item.description,
    cost: null,
    source: 'homebrew',
    sourceName: 'Homebrew',
    homebrewId: item.homebrewId,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * rules: any of { classes, species, backgrounds, feats, equipment, spells,
 * monsters, 'magic-items' }. Returns a new object with the homebrew added to
 * the lists that are present. Subclasses join their class (built-in or
 * homebrew) by data.classId.
 */
export function mergeHomebrew(rules, rows) {
  if (!rows?.length) return rules;
  const out = { ...rules };
  const groups = {};
  for (const row of rows) {
    if (!KINDS[row.kind]) continue;
    (groups[row.kind] ||= []).push(entryFor(row));
  }
  const addTo = (key, items) => {
    if (!out[key] || !items?.length) return;
    out[key] = [...out[key], ...items].sort(byName);
  };
  addTo('spells', groups.spell);
  addTo('monsters', groups.monster);
  addTo('feats', groups.feat);
  addTo('species', groups.species);
  addTo('backgrounds', groups.background);
  addTo('magic-items', groups['magic-item']);

  if (out.equipment) {
    const weapons = out.equipment.weapons;
    const magic = (groups['magic-item'] || []).map((i) => magicWeaponFor(i, weapons)).filter(Boolean);
    out.equipment = {
      ...out.equipment,
      weapons: [...weapons, ...(groups.weapon || []), ...magic].sort(byName),
      armor: [...out.equipment.armor, ...(groups.armor || [])],
    };
  }

  if (out.classes) {
    const classes = [...out.classes.map((c) => ({ ...c })), ...(groups.class || []).map((c) => ({ ...c, subclasses: [], extras: [] }))];
    for (const sub of groups.subclass || []) {
      const cls = classes.find((c) => c.id === sub.classId);
      if (cls) cls.subclasses = [...cls.subclasses, sub];
    }
    out.classes = classes;
  }
  return out;
}
