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
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'open5e-source');
const API = 'https://api.open5e.com';

export const SOURCES = ['toh', 'tdcs', 'open5e', 'a5e-ag', 'deepm', 'deepmx', 'kp', 'wz', 'spells-that-dont-suck'];
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

async function main() {
  await mkdir(outDir, { recursive: true });
  const documents = (await getAll(`${API}/v2/documents/?format=json&limit=100`))
    .filter((d) => keep(d.key))
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
  ]);
  console.log(`\nSaved ${documents.length} sources, ${subclasses.length} subclasses, ${spells.length} spells, ${feats.length} feats.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
