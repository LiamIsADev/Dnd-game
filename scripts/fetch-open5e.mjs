#!/usr/bin/env node
// Downloads the open-licensed content this site uses from the Open5e API
// (https://open5e.com) and saves a trimmed copy in open5e-source/. Run it
// only when you want newer data; the site is built from the saved copy by
// scripts/build-open5e.mjs.
//
//   npm run fetch:open5e
//
// Only these sources are kept, all published under the OGL 1.0a or CC BY 4.0:
//   Tome of Heroes, Deep Magic, Deep Magic Extended, Warlock Zine and the
//   Kobold Press Compilation (Kobold Press), Tal'Dorei Campaign Setting
//   (Green Ronin), Level Up Advanced 5th Edition Adventurer's Guide
//   (EN Publishing), Spells That Don't Suck (somanyrobots) and Open5e Originals.
// Plus the monster books listed below, Level Up's Dungeon Delver's Guide and
// Gate Pass Gazette (backgrounds), Black Flag (the Mechanist class) and the
// 2014 SRD 5.1 (Half-Elf and Half-Orc).
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'open5e-source');
const API = 'https://api.open5e.com';

export const SOURCES = ['toh', 'tdcs', 'open5e', 'a5e-ag', 'deepm', 'deepmx', 'kp', 'wz', 'spells-that-dont-suck'];
// Monster books (Tome of Beasts 1-3 and its 2023 edition, Creature Codex,
// Black Flag, Level Up's Monstrous Menagerie, Tal'Dorei).
export const MONSTER_SOURCES = ['tob-2023', 'tob', 'tob2', 'tob3', 'ccdx', 'tdcs', 'bfrd', 'a5e-mm'];
// The same sources in the older v1 API, which still has the spell class lists
// and the full subclass write-ups that the v2 API is missing for a few entries.
const V1_SOURCES = { toh: 'toh', taldorei: 'tdcs', o5e: 'open5e', a5e: 'a5e-ag', dmag: 'deepm', 'dmag-e': 'deepmx', kp: 'kp', warlock: 'wz' };

async function getAll(url) {
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const page = await res.json();
    out.push(...page.results);
    url = page.next;
    process.stdout.write('.');
  }
  return out;
}

const keep = (doc) => SOURCES.includes(doc);
// Backgrounds also come from two smaller Level Up books.
export const BACKGROUND_SOURCES = [...SOURCES, 'a5e-ddg', 'a5e-gpg'];
// Classes that aren't in the SRD: Level Up's Marshal and Black Flag's Mechanist.
export const NEW_CLASSES = ['a5e_marshal', 'bfrd_mechanist'];
// From the 2014 SRD 5.1 (CC BY 4.0): the two species the 2024 SRD dropped.
const SRD_2014_SPECIES = ['Half-Elf', 'Half-Orc'];
const keepDoc = (doc) => keep(doc) || MONSTER_SOURCES.includes(doc) || BACKGROUND_SOURCES.includes(doc) || ['vom', 'srd-2014'].includes(doc);
const keyOf = (x) => (typeof x === 'string' ? x.replace(/\/$/, '').split('/').pop() : x?.key || null);

async function main() {
  await mkdir(outDir, { recursive: true });
  const documents = (await getAll(`${API}/v2/documents/?format=json&limit=100`))
    .filter((d) => keepDoc(d.key))
    .map((d) => ({
      key: d.key,
      name: d.name,
      publisher: d.publisher?.name,
      author: d.author,
      year: d.publication_date?.slice(0, 4),
      licenses: d.licenses.map((l) => l.key),
      permalink: d.permalink,
    }));

  const classes = await getAll(`${API}/v2/classes/?format=json&limit=200`);
  const v1Classes = await getAll(`${API}/v1/classes/?format=json&limit=50`);
  const v1Arch = new Map(v1Classes.flatMap((c) => c.archetypes.map((a) => [a.name.toLowerCase(), a.desc])));
  const subclasses = classes
    .filter((c) => /^srd(-2024)?_/.test(c.subclass_of?.key || '') && keep(c.document.key))
    .map((c) => ({
      key: c.key,
      source: c.document.key,
      classKey: c.subclass_of.key.replace(/^srd(-2024)?_/, ''),
      // 2024 subclasses already use the 2024 levels; the rest are 2014 ones.
      rules: c.subclass_of.key.startsWith('srd-2024_') ? '2024' : '2014',
      name: c.name,
      desc: c.desc,
      features: c.features.map((f) => ({ name: f.name, desc: f.desc, levels: f.gained_at.map((g) => g.level) })),
      v1Desc: v1Arch.get(c.name.toLowerCase()) || null,
    }));

  // New classes, with every feature and the level-table columns.
  const newClasses = classes
    .filter((c) => NEW_CLASSES.includes(c.key) || NEW_CLASSES.includes(keyOf(c.subclass_of)))
    .map((c) => ({
      key: c.key,
      source: c.document.key,
      name: c.name,
      subclassOf: keyOf(c.subclass_of),
      desc: c.desc,
      hitDie: c.hit_dice,
      saves: (c.saving_throws || []).map((x) => x.name),
      casterType: c.caster_type,
      features: c.features.map((f) => ({
        key: f.key,
        name: f.name,
        desc: f.desc,
        type: f.feature_type,
        levels: f.gained_at.map((g) => g.level),
        table: (f.data_for_class_table || []).map((t) => [t.level, t.column_value]),
      })),
    }));

  // Species: Tome of Heroes, Open5e Originals and the 2014 SRD's Half-Elf and
  // Half-Orc. Subspecies (subraces, heritages, chassis) point at their parent.
  const v1Races = await getAll(`${API}/v1/races/?format=json&limit=100`);
  const species = (await getAll(`${API}/v2/species/?format=json&limit=200`))
    .filter((s) => keep(s.document.key) || (s.document.key === 'srd-2014' && SRD_2014_SPECIES.includes(s.name)))
    .map((s) => {
      const out = {
        key: s.key,
        source: s.document.key,
        name: s.name,
        desc: s.desc,
        isSub: !!s.is_subspecies,
        parent: keyOf(s.subspecies_of),
        traits: s.traits.map((t) => ({ name: t.name, desc: t.desc })),
      };
      // Shade has no traits in the v2 API; the v1 write-up has them.
      if (!out.traits.length) {
        const v1 = v1Races.find((r) => r.name === s.name);
        if (v1) out.v1 = { speed: v1.speed, size: v1.size_raw, text: [v1.age, v1.alignment, v1.size, v1.speed_desc, v1.languages, v1.vision, v1.traits].filter(Boolean).join('\n\n') };
      }
      return out;
    });

  const backgrounds = (await getAll(`${API}/v2/backgrounds/?format=json&limit=200`))
    .filter((b) => BACKGROUND_SOURCES.includes(b.document.key))
    .map((b) => ({ key: b.key, source: b.document.key, name: b.name, desc: b.desc, benefits: b.benefits.map((x) => ({ name: x.name, type: x.type, desc: x.desc })) }));

  const v1Spells = await getAll(`${API}/v1/spells/?format=json&limit=500`);
  const v1Classes4 = new Map(
    v1Spells.filter((s) => V1_SOURCES[s.document__slug]).map((s) => [`${V1_SOURCES[s.document__slug]}|${s.name.toLowerCase()}`, s.dnd_class]),
  );
  const spells = (await getAll(`${API}/v2/spells/?format=json&limit=500`))
    .filter((s) => keep(s.document.key))
    .map((s) => ({
      key: s.key,
      source: s.document.key,
      name: s.name,
      level: s.level,
      school: s.school?.name,
      classes: s.classes.map((c) => c.name),
      v1Classes: v1Classes4.get(`${s.document.key}|${s.name.toLowerCase()}`) || '',
      castingTime: s.casting_time,
      reactionCondition: s.reaction_condition,
      ritual: s.ritual,
      range: s.range_text,
      verbal: s.verbal,
      somatic: s.somatic,
      material: s.material,
      materialSpecified: s.material_specified,
      duration: s.duration,
      concentration: s.concentration,
      desc: s.desc,
      higherLevel: s.higher_level,
    }));

  const feats = (await getAll(`${API}/v2/feats/?format=json&limit=200`))
    .filter((f) => keep(f.document.key))
    .map((f) => ({
      key: f.key,
      source: f.document.key,
      name: f.name,
      desc: f.desc,
      prerequisite: f.prerequisite,
      benefits: f.benefits.map((b) => b.desc),
      type: f.type,
    }));

  const creatures = (await getAll(`${API}/v2/creatures/?format=json&limit=500`))
    .filter((c) => MONSTER_SOURCES.includes(c.document.key))
    .map((c) => ({
      key: c.key,
      source: c.document.key,
      name: c.name,
      size: c.size?.name,
      type: c.type?.name,
      alignment: c.alignment,
      ac: c.armor_class,
      acDetail: c.armor_detail,
      hp: c.hit_points,
      hitDice: c.hit_dice,
      speed: c.speed,
      abilities: c.ability_scores,
      saves: c.saving_throws_all,
      saveProfs: c.saving_throws,
      skills: c.skill_bonuses,
      initiative: c.initiative_bonus,
      cr: c.challenge_rating,
      xp: c.experience_points,
      pb: c.proficiency_bonus,
      defenses: c.resistances_and_immunities,
      senses: {
        darkvision: c.darkvision_range,
        blindsight: c.blindsight_range,
        tremorsense: c.tremorsense_range,
        truesight: c.truesight_range,
        passive: c.passive_perception,
      },
      languages: c.languages?.as_string,
      traits: c.traits.map((t) => ({ name: t.name, desc: t.desc })),
      actions: c.actions
        .sort((a, b) => (a.order_in_statblock ?? 0) - (b.order_in_statblock ?? 0))
        .map((a) => ({ name: a.name, desc: a.desc, type: a.action_type, cost: a.legendary_action_cost, uses: a.usage_limits })),
    }));

  // Weapons: Tome of Heroes' new weapons (v1 API) and Vault of Magic's magic
  // weapons (each built on an SRD weapon).
  const weapons = (await getAll(`${API}/v1/weapons/?format=json&limit=100&document__slug=toh`)).map((w) => ({
    source: 'toh',
    name: w.name,
    category: w.category,
    cost: w.cost,
    damageDice: w.damage_dice,
    damageType: w.damage_type,
    weight: w.weight,
    properties: (w.properties || []).filter(Boolean),
  }));
  const magicWeapons = (await getAll(`${API}/v2/magicitems/?format=json&limit=500&document__key=vom&category__key=weapon`))
    .filter((m) => m.document.key === 'vom' && m.category?.key === 'weapon')
    .map((m) => ({
      source: 'vom',
      name: m.name,
      desc: m.desc,
      rarity: m.rarity?.name,
      attunement: m.requires_attunement ? m.attunement_detail || true : false,
      base: m.weapon?.key?.replace(/^srd(-2024)?_/, '') || null,
    }));

  // Tome of Beasts 3 is missing its actions in the v2 API for about 200
  // monsters; the v1 API still has them.
  const v1Tob3 = new Map(
    (await getAll(`${API}/v1/monsters/?format=json&limit=500&document__slug=tob3`)).map((m) => [m.name.toLowerCase(), m]),
  );
  for (const c of creatures) {
    if (c.actions.length || c.source !== 'tob3') continue;
    const m = v1Tob3.get(c.name.toLowerCase());
    if (!m) continue;
    const list = (items, type) => (Array.isArray(items) ? items : []).map((a) => ({ name: a.name, desc: a.desc, type, cost: null, uses: null }));
    c.actions = [
      ...list(m.actions, 'ACTION'),
      ...list(m.bonus_actions, 'BONUS_ACTION'),
      ...list(m.reactions, 'REACTION'),
      ...list(m.legendary_actions, 'LEGENDARY_ACTION'),
    ];
    if (!c.traits.length) c.traits = (Array.isArray(m.special_abilities) ? m.special_abilities : []).map((t) => ({ name: t.name, desc: t.desc }));
    if (m.legendary_desc) c.legendaryIntro = m.legendary_desc;
  }

  // The licence texts (the OGL has to travel with the content).
  const licenses = (await getAll(`${API}/v2/licenses/?format=json`))
    .filter((l) => ['ogl-10a', 'cc-by-40'].includes(l.key))
    .map((l) => ({ key: l.key, name: l.name, text: l.desc }));

  const write = (name, data) => writeFile(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 1) + '\n');
  await Promise.all([
    write('documents', documents),
    write('subclasses', subclasses),
    write('spells', spells),
    write('feats', feats),
    write('licenses', licenses),
    write('creatures', creatures),
    write('weapons', { weapons, magicWeapons }),
    write('classes', newClasses),
    write('species', species),
    write('backgrounds', backgrounds),
  ]);
  console.log(`\nSaved ${documents.length} sources, ${subclasses.length} subclasses, ${spells.length} spells, ${feats.length} feats, ${newClasses.length} classes and subclasses, ${species.length} species, ${backgrounds.length} backgrounds.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
