#!/usr/bin/env node
// Converts the SRD 5.2.1 Markdown in srd-source/ into JSON files in
// public/data/srd/, which the website loads at runtime.
//
//   npm run build:srd
//
// Source: https://github.com/downfallx/dnd-5e-srd-markdown (CC BY 4.0).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseSpells,
  parseStatBlocks,
  parseMagicItems,
  parseFeats,
  parseBackgrounds,
  parseSpecies,
  parseClasses,
  parseEquipment,
  parseGlossary,
  chapter,
} from './srd/parsers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFile(path.join(root, 'srd-source', f), 'utf8');
const outDir = path.join(root, 'public', 'data', 'srd');

export const ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, ' +
  'available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 ' +
  'International License, available at https://creativecommons.org/licenses/by/4.0/legalcode. ' +
  'Markdown conversion by downfallx/dnd-5e-srd-markdown; reformatted into JSON for this site.';

export async function buildSrd() {
  const [spellsMd, monstersMd, animalsMd, itemsMd, featsMd, originsMd, classesMd, equipMd, glossaryMd] =
    await Promise.all(
      [
        'spells.md',
        'monsters-A-Z.md',
        'animals.md',
        'magic-items.md',
        'feats.md',
        'character-origins.md',
        'classes.md',
        'equipment.md',
        'rules-glossary.md',
      ].map(src),
    );

  const monsters = [
    ...parseStatBlocks(monstersMd, { source: 'monsters' }),
    ...parseStatBlocks(animalsMd, { source: 'animals' }),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const chapters = [
    chapter('playing-the-game', 'Playing the Game', await src('playing-the-game.md')),
    chapter('character-creation', 'Character Creation', await src('character-creation.md')),
    chapter('gameplay-toolbox', 'Gameplay Toolbox', await src('gameplay-toolbox.md')),
    chapter('spellcasting', 'Spellcasting', spellsMd.slice(0, spellsMd.indexOf('## Spell Descriptions'))),
    chapter('equipment', 'Equipment', equipMd),
    chapter('magic-item-rules', 'Magic Item Rules', itemsMd.slice(0, itemsMd.indexOf('## Magic Items A–Z'))),
    chapter('monster-rules', 'Using Monsters', await src('monsters.md')),
  ];

  const data = {
    spells: parseSpells(spellsMd),
    monsters,
    'magic-items': parseMagicItems(itemsMd),
    feats: parseFeats(featsMd),
    backgrounds: parseBackgrounds(originsMd),
    species: parseSpecies(originsMd),
    classes: parseClasses(classesMd),
    equipment: parseEquipment(equipMd),
    glossary: parseGlossary(glossaryMd),
    chapters,
  };
  return data;
}

async function main() {
  const data = await buildSrd();
  await mkdir(outDir, { recursive: true });
  const counts = {};
  for (const [name, value] of Object.entries(data)) {
    await writeFile(path.join(outDir, `${name}.json`), JSON.stringify(value));
    counts[name] = Array.isArray(value) ? value.length : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v.length]));
  }
  const index = { version: 'SRD 5.2.1', attribution: ATTRIBUTION, counts };
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log('SRD data written to public/data/srd/');
  console.log(JSON.stringify(counts, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
