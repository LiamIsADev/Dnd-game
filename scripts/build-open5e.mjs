#!/usr/bin/env node
// Converts the Open5e snapshot in open5e-source/ (see fetch-open5e.mjs) into
// the site's own format, in public/data/open5e/:
//   subclasses.json  extra subclasses for the 12 classes, moved to 2024 levels
//   spells.json      spells that aren't in the SRD 5.2.1
//   feats.json       feats that aren't in the SRD 5.2.1
//   index.json       sources, licences and the OGL notices
//
//   npm run build:open5e
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async (f) => JSON.parse(await readFile(path.join(root, f), 'utf8'));
const outDir = path.join(root, 'public', 'data', 'open5e');

// Short names shown next to each subclass, spell and feat.
const SHORT = {
  toh: 'Tome of Heroes',
  tdcs: "Tal'Dorei",
  open5e: 'Open5e',
  'a5e-ag': 'Level Up',
  deepm: 'Deep Magic',
  deepmx: 'Deep Magic Extended',
  kp: 'Kobold Press',
  wz: 'Warlock Zine',
  'spells-that-dont-suck': "Spells That Don't Suck",
};
// When two books have a spell with the same name, the first one listed keeps
// the plain name and the others get the book's name added.
const SPELL_ORDER = ['toh', 'deepm', 'deepmx', 'kp', 'wz', 'open5e', 'tdcs', 'spells-that-dont-suck', 'a5e-ag'];
const CLASSES = ['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard'];

// Subclasses that give a class without spells the ability to cast them: they
// all follow the same table (a third of a full caster's slots).
const SUBCLASS_CASTING = {
  'Arcane Warrior': { ability: 'int', list: 'Wizard', cantrips: 2 },
  'Eldritch Trickster': { ability: 'int', list: 'Wizard', cantrips: 3, always: ['Mage Hand'] },
  Soulspy: { ability: 'wis', list: 'Cleric', cantrips: 3 },
  Underfoot: { ability: 'wis', list: 'Druid', cantrips: 3, always: ['Shillelagh'] },
};
// Subclasses that may also pick spells from another class's list.
const EXTRA_SPELL_LISTS = { 'Spore Sorcery': ['Druid'] };
// Data fixes: features listed at the wrong level in the source.
const LEVEL_FIX = { 'Circle of Wind|Circle Spells': 3, 'Underfoot|Cantrips': 3, 'Underfoot|Spell Slots': 3, 'Underfoot|Spells Known of 1st-Level and Higher': 3 };

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const norm = (s) => slug(s).replace(/-/g, '');

/* --------------------------------------------------------------- text */

const ALLOWED_TAGS = new Set(['table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'em', 'strong', 'b', 'i', 'p', 'br']);

/** Tidy the source Markdown: line endings, typos, tables, headings and stray HTML. */
export function cleanText(text, { headings = 'bold' } = {}) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  // "Smuggler-s", "can-t": apostrophes lost in the source.
  s = s.replace(/\b([A-Za-z]+)-(s|re|t|ve)\b/g, (m, w, e) => (/^(can|don|isn|you|You|Smuggler|symbol|spell|arcanist|navigator)$/.test(w) ? `${w}'${e}` : m));
  // HTML: keep simple formatting and tables, drop attributes, escape the rest.
  s = s.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (m, tag) => {
    const t = tag.toLowerCase();
    if (/^h[1-6]$/.test(t)) return m.startsWith('</') ? '</strong>' : '<strong>';
    if (!ALLOWED_TAGS.has(t)) return '';
    return m.startsWith('</') ? `</${t}>` : `<${t}>`;
  });
  const lines = s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    // Table separator rows drawn with long dashes.
    .map((l) => (/^\|?[\s|:—–-]+$/.test(l) && /[—–]/.test(l) ? l.replace(/[—–]+/g, '---') : l))
    .filter((l, i, all) => !(l === '' && /^\|?[\s|:-]+$/.test(all[i + 1] || 'x') && (all[i + 1] || '').includes('---') && (all[i - 1] || '').includes('|')));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const next = lines[i + 1] || '';
    // A table header written without its leading pipe.
    if (!line.trimStart().startsWith('|') && line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(next)) line = `| ${line.trim()}`;
    const isRow = line.trimStart().startsWith('|');
    if (isRow) line = line.trim();
    // Tables need a blank line before them.
    if (isRow && out.length && out[out.length - 1].trim() && !out[out.length - 1].startsWith('|')) out.push('');
    // Headings inside a feature read better as bold lines.
    const h = line.match(/^#{1,6}\s*(.+?)\s*#*$/);
    if (h && headings === 'bold') line = `**${h[1].replace(/\*\*/g, '')}**`;
    // Text straight after a table needs a blank line too.
    if (!isRow && line.trim() && out.length && out[out.length - 1].startsWith('|')) out.push('');
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* --------------------------------------------------------- subclasses */

/** 2014 subclass levels -> 2024 ones. Every 2024 subclass starts at level 3. */
export function levelFor2024(classKey, level, featureName) {
  if (!level || level < 3) return 3;
  // 2024 Clerics gain subclass features at 3, 6, 10 and 17 (2014: 1, 2, 6, 8, 17).
  if (classKey === 'cleric' && level === 8) {
    // Divine Strike and Potent Spellcasting are part of Blessed Strikes (level 7) now.
    return /Divine Strike|Potent Spellcasting/i.test(featureName) ? 7 : 10;
  }
  return level;
}

function ordinal(n) {
  return `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
}

/** Features the v2 data is missing, rebuilt from the older v1 write-up. */
function v1Features(sc, have) {
  if (!sc.v1Desc) return [];
  const text = sc.v1Desc.replace(/\r\n?/g, '\n');
  const parts = text.split(/^#{3,6}\s*/m).slice(1);
  const inside = sc.features.map((f) => norm(f.desc)).join(' ');
  const out = [];
  for (const part of parts) {
    const [title, ...rest] = part.split('\n');
    const name = title.trim();
    const body = rest.join('\n').trim();
    // Skip it if the v2 data has it under another name (same opening words).
    if (have.has(norm(name)) || inside.includes(norm(name)) || inside.includes(norm(body.slice(0, 80)))) continue;
    const lvl = body.match(/(\d+)(?:st|nd|rd|th) level/i);
    out.push({ name, desc: body, levels: lvl ? [Number(lvl[1])] : [] });
  }
  return out;
}

/** The subclass's introduction: the v2 description, or the start of the v1 write-up. */
function intro(sc) {
  if (sc.desc?.trim()) return sc.desc;
  return (sc.v1Desc || '').split(/^#{3,6}/m)[0];
}

export function convertSubclass(sc, takenIds) {
  const have = new Set(sc.features.map((f) => norm(f.name)));
  const all = [...sc.features, ...v1Features(sc, have)];
  const features = all
    .map((f, i) => {
      const original = LEVEL_FIX[`${sc.name}|${f.name}`] ?? Math.min(...(f.levels.length ? f.levels : [0]));
      const level = sc.rules === '2024' ? Math.max(3, original || 3) : levelFor2024(sc.classKey, original, f.name);
      let description = cleanText(f.desc);
      if (sc.rules !== '2024' && original && original !== level) {
        description += `\n\n_${ordinal(original)}-level feature in the original 2014 rules; it comes at level ${level} with the 2024 ${cap(sc.classKey)}._`;
      }
      if (sc.classKey === 'cleric' && level === 7 && /Divine Strike|Potent Spellcasting/i.test(f.name)) {
        description += `\n\n_With the 2024 rules, take this in place of the choice that Blessed Strikes gives you at level 7._`;
      }
      // Some sources list "Foo." for an option inside Channel Divinity.
      return { level, name: cleanName(f.name), description, order: i };
    })
    .filter((f) => f.description)
    .sort((a, b) => a.level - b.level || a.order - b.order)
    .map(({ order, ...f }) => f);
  let id = slug(sc.name);
  if (takenIds.has(id)) id = `${id}-${slug(SHORT[sc.source] || sc.source)}`;
  takenIds.add(id);
  const out = {
    id,
    name: sc.name,
    tagline: null,
    description: cleanText(intro(sc)),
    features,
    source: sc.source,
    sourceName: SHORT[sc.source] || sc.source,
    rules: sc.rules,
  };
  const casting = SUBCLASS_CASTING[sc.name];
  if (casting) out.spellcasting = { ...casting, type: 'third' };
  if (EXTRA_SPELL_LISTS[sc.name]) out.extraSpellLists = EXTRA_SPELL_LISTS[sc.name];
  return out;
}

/** Feature names: same typo fixes as the text, without "(table)" or a trailing full stop. */
export function cleanName(name) {
  return cleanText(name)
    .replace(/\.$/, '')
    .replace(/\s*\(table\)$/i, '')
    .replace(/Mischeif/g, 'Mischief');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* -------------------------------------------------------------- spells */

const TIME = {
  action: 'Action',
  'bonus-action': 'Bonus Action',
  reaction: 'Reaction',
  turn: '1 turn',
  round: '1 round',
};

export function castingTimeText(sp) {
  let t = TIME[sp.castingTime];
  if (!t) {
    const m = String(sp.castingTime || '').match(/^(\d+)([a-z]+)$/);
    t = m ? `${m[1]} ${Number(m[1]) === 1 ? m[2].replace(/s$/, '') : m[2]}` : cap(String(sp.castingTime || 'Action'));
  }
  if (t === 'Reaction' && sp.reactionCondition) t += `, which you take ${sp.reactionCondition.replace(/^which you take /i, '').replace(/\.$/, '')}`;
  if (sp.ritual) t += ' or Ritual';
  return t;
}

export function spellClasses(sp) {
  const names = sp.classes.length ? sp.classes : String(sp.v1Classes || '').split(',');
  const out = new Set();
  for (const raw of names) {
    const n = raw.trim().replace(/^Sorceror$/, 'Sorcerer');
    if (CLASSES.includes(n)) out.add(n);
  }
  return [...out].sort();
}

export function convertSpell(sp) {
  const material = sp.material ? cleanText(sp.materialSpecified || '').replace(/\.$/, '') || 'a material component' : null;
  const raw = [sp.verbal && 'V', sp.somatic && 'S', material && `M (${material})`].filter(Boolean).join(', ');
  const duration = cap(String(sp.duration || 'Instantaneous').trim());
  const higher = cleanText(sp.higherLevel || '');
  return {
    id: slug(sp.name),
    name: sp.name.trim(),
    level: sp.level,
    school: cap(sp.school || 'Universal'),
    classes: spellClasses(sp),
    castingTime: castingTimeText(sp),
    ritual: !!sp.ritual,
    range: cap(String(sp.range || 'Self')),
    components: { verbal: !!sp.verbal, somatic: !!sp.somatic, material, raw: raw || 'None' },
    duration: sp.concentration && !/^Concentration/i.test(duration) ? `Concentration, up to ${duration.charAt(0).toLowerCase()}${duration.slice(1)}` : duration,
    concentration: !!sp.concentration,
    description: cleanText(sp.desc),
    higherLevels: sp.level > 0 && higher ? higher : null,
    cantripUpgrade: sp.level === 0 && higher ? higher : null,
    creatureStatBlock: null,
    source: sp.source,
    sourceName: SHORT[sp.source] || sp.source,
  };
}

/* --------------------------------------------------------------- feats */

export function convertFeat(f) {
  const benefits = f.benefits.map((b) => `- ${cleanText(b).replace(/\n+/g, ' ')}`).join('\n');
  const prerequisite = cleanText(f.prerequisite || '').replace(/[*_]/g, '').replace(/\.$/, '') || null;
  return {
    id: slug(f.name),
    name: f.name.trim(),
    category: 'General Feat',
    prerequisite,
    repeatable: /more than once/i.test(f.desc + f.benefits.join(' ')),
    description: [cleanText(f.desc), benefits].filter(Boolean).join('\n\n'),
    source: f.source,
    sourceName: SHORT[f.source] || f.source,
  };
}

/* ---------------------------------------------------------------- main */

export async function buildOpen5e() {
  const [documents, subclasses, spells, feats, licenses, srdClasses, srdSpells, srdFeats] = await Promise.all([
    read('open5e-source/documents.json'),
    read('open5e-source/subclasses.json'),
    read('open5e-source/spells.json'),
    read('open5e-source/feats.json'),
    read('open5e-source/licenses.json'),
    read('public/data/srd/classes.json'),
    read('public/data/srd/spells.json'),
    read('public/data/srd/feats.json'),
  ]);

  // Subclasses, by class, sorted by name.
  const takenIds = new Set(srdClasses.flatMap((c) => c.subclasses.map((s) => s.id)));
  const byClass = {};
  for (const sc of [...subclasses].sort((a, b) => a.name.localeCompare(b.name))) {
    (byClass[sc.classKey] ||= []).push(convertSubclass(sc, takenIds));
  }

  // Spells not in the SRD; same-named spells from different books are both kept.
  const srdNames = new Set(srdSpells.map((s) => norm(s.name)));
  const ids = new Set(srdSpells.map((s) => s.id));
  const names = new Set();
  const outSpells = [];
  const skipped = [];
  const ordered = [...spells].sort((a, b) => SPELL_ORDER.indexOf(a.source) - SPELL_ORDER.indexOf(b.source) || a.name.localeCompare(b.name));
  for (const sp of ordered) {
    if (srdNames.has(norm(sp.name))) {
      skipped.push(sp.name);
      continue;
    }
    const s = convertSpell(sp);
    if (names.has(norm(s.name))) s.name = `${s.name} (${s.sourceName})`;
    names.add(norm(s.name));
    if (ids.has(s.id)) s.id = `${s.id}-${slug(s.sourceName)}`;
    ids.add(s.id);
    outSpells.push(s);
  }
  outSpells.sort((a, b) => a.name.localeCompare(b.name));

  const srdFeatNames = new Set(srdFeats.map((f) => norm(f.name)));
  const featIds = new Set(srdFeats.map((f) => f.id));
  const outFeats = [];
  for (const f of feats) {
    if (srdFeatNames.has(norm(f.name))) continue;
    const x = convertFeat(f);
    if (featIds.has(x.id)) x.id = `${x.id}-${slug(x.sourceName)}`;
    featIds.add(x.id);
    outFeats.push(x);
  }
  outFeats.sort((a, b) => a.name.localeCompare(b.name));

  const usedSources = new Set([...subclasses, ...spells, ...feats].map((x) => x.source));
  const sources = documents
    .filter((d) => usedSources.has(d.key))
    .map((d) => ({
      key: d.key,
      short: SHORT[d.key] || d.name,
      title: d.name,
      publisher: d.publisher,
      author: d.author,
      year: d.year,
      licenses: d.licenses,
      url: d.permalink,
      notice: `${d.name}. Copyright ${d.year} ${d.publisher === 'Kobold Press' ? 'Open Design LLC d/b/a Kobold Press' : d.publisher}${d.author && !/not sure|various/i.test(d.author) && d.author !== d.publisher ? `; Authors ${d.author}` : ''}.`,
    }));

  await mkdir(outDir, { recursive: true });
  const write = (name, data) => writeFile(path.join(outDir, `${name}.json`), JSON.stringify(data) + '\n');
  const counts = {
    subclasses: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])),
    spells: outSpells.length,
    feats: outFeats.length,
  };
  await Promise.all([
    write('subclasses', byClass),
    write('spells', outSpells),
    write('feats', outFeats),
    write('index', {
      attribution:
        'This site also includes Open Game Content from the books listed below, taken from the Open5e API (https://open5e.com). ' +
        'Material under the Open Game License 1.0a is used under its terms; the full licence and the Section 15 notices follow. ' +
        'Material under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/) ' +
        'is credited to its authors below. The text was reformatted for this site, and 2014 subclass features were moved to the 2024 class levels.',
      sources,
      section15: [
        'Open Game License v 1.0a Copyright 2000, Wizards of the Coast, LLC.',
        'System Reference Document 5.1 Copyright 2016, Wizards of the Coast, Inc.; Authors Mike Mearls, Jeremy Crawford, Chris Perkins, Rodney Thompson, Peter Lee, James Wyatt, Robert J. Schwalb, Bruce R. Cordell, Chris Sims, and Steve Townshend, based on original material by E. Gary Gygax and Dave Arneson.',
        ...sources.map((s) => s.notice),
        'Open5e. Copyright 2024 Open5e; Ean Moody and contributors.',
      ],
      ogl: licenses.find((l) => l.key === 'ogl-10a')?.text || '',
      counts,
    }),
  ]);
  return { counts, skipped: skipped.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildOpen5e().then(({ counts, skipped }) => {
    console.log('Subclasses:', counts.subclasses);
    console.log(`Spells: ${counts.spells} (skipped ${skipped} already in the SRD). Feats: ${counts.feats}.`);
  });
}
