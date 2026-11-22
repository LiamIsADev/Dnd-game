// Parsers for each SRD 5.2.1 Markdown file. Each takes the file's text and
// returns plain JSON-friendly objects. See scripts/build-srd.mjs for the
// entry point that writes them to public/data/srd/.
import {
  slugify,
  splitByHeading,
  sectionAfter,
  plain,
  boldFields,
  parseHtmlTable,
  findTables,
  namedParagraphs,
  cleanText,
  findDice,
  signedNumber,
} from './parse-utils.mjs';

const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const RARITY_RE = /\b(Very Rare|Uncommon|Common|Rare|Legendary|Artifact|Varies)\b/g;

/* ------------------------------------------------------------------ spells */

export function parseSpells(md) {
  const body = md.slice(md.indexOf('## Spell Descriptions'));
  // Some spells (summons) embed a stat block with its own #### headings.
  // Fold any #### section that isn't a spell back into the spell above it.
  const merged = [];
  for (const sec of splitByHeading(body, 4)) {
    const meta = plain(sec.body.split('\n').find((l) => l.trim()) || '');
    if (/^(Level \d+ \w+|\w+ Cantrip) \(/.test(meta) || !merged.length) merged.push({ ...sec, statBlock: '' });
    else {
      const prev = merged[merged.length - 1];
      prev.statBlock += `${prev.statBlock ? '\n\n' : ''}##### ${sec.title}\n\n${sec.body}`;
    }
  }
  return merged.map(({ title, body: text, statBlock }) => {
    const lines = text.split('\n');
    const meta = plain(lines.find((l) => l.startsWith('_')) || '');
    let level = 0;
    let school;
    let classes = [];
    const classMatch = meta.match(/\(([^)]*)\)\s*$/);
    if (classMatch) classes = classMatch[1].split(',').map((s) => s.trim());
    const lvl = meta.match(/^Level (\d+) (\w+)/);
    const cantrip = meta.match(/^(\w+) Cantrip/);
    if (lvl) {
      level = Number(lvl[1]);
      school = lvl[2];
    } else if (cantrip) {
      school = cantrip[1];
    } else {
      throw new Error(`Unrecognised spell header for ${title}: ${meta}`);
    }
    const f = boldFields(text);
    // Description = everything after the last bold field line.
    const lastField = Math.max(...['Casting Time', 'Range', 'Components', 'Duration'].map((k) => text.indexOf(`**${k}:**`)));
    let desc = text.slice(text.indexOf('\n', lastField) + 1).trim();
    let higherLevels = null;
    let cantripUpgrade = null;
    const hl = desc.match(/\n?_Using a Higher-Level Spell Slot\._\s*([\s\S]*)$/);
    if (hl) {
      higherLevels = hl[1].trim();
      desc = desc.slice(0, hl.index).trim();
    }
    const cu = desc.match(/\n?_Cantrip Upgrade\._\s*([\s\S]*)$/);
    if (cu) {
      cantripUpgrade = cu[1].trim();
      desc = desc.slice(0, cu.index).trim();
    }
    const components = f['Components'] || '';
    const material = components.match(/M \(([\s\S]*)\)\s*$/);
    const castingTime = f['Casting Time'] || '';
    const duration = f['Duration'] || '';
    return {
      id: slugify(title),
      name: title,
      level,
      school,
      classes,
      castingTime,
      ritual: /Ritual/i.test(castingTime),
      range: f['Range'] || '',
      components: {
        verbal: /(^|,\s*)V(,|$)/.test(components.replace(/\(.*\)/, '')),
        somatic: /(^|,\s*)S(,|$)/.test(components.replace(/\(.*\)/, '').replace(/\s/g, '')),
        material: material ? material[1] : null,
        raw: components,
      },
      duration,
      concentration: /^Concentration/i.test(duration),
      description: cleanText(desc),
      higherLevels,
      cantripUpgrade,
      // Summoning spells include the summoned creature's stat block (Markdown).
      creatureStatBlock: statBlock || null,
    };
  });
}

/* ---------------------------------------------------------------- monsters */

const STAT_SECTIONS = ['Traits', 'Actions', 'Bonus Actions', 'Reactions', 'Legendary Actions'];

/**
 * Find every stat block in a file. A stat block starts at a heading whose next
 * non-empty line is an italic "_Size Type, Alignment_" line followed by an AC line.
 */
export function parseStatBlocks(md, { source }) {
  const lines = md.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{2,3}) (.+)$/);
    if (!h) continue;
    const next = lines.slice(i + 1).filter((l) => l.trim()).slice(0, 2);
    if (next[0]?.startsWith('_') && next[1]?.startsWith('**AC**')) {
      starts.push({ line: i, level: h[1].length, name: h[2].trim() });
    }
  }
  let group = null;
  const out = [];
  for (const s of starts) {
    // Track the "## Group" heading (e.g. "Animated Objects") for monsters-A-Z.
    for (let j = s.line; j >= 0; j--) {
      const g = lines[j].match(/^## (.+)$/);
      if (g) {
        group = g[1].trim();
        break;
      }
    }
    let end = lines.length;
    for (let j = s.line + 1; j < lines.length; j++) {
      const h = lines[j].match(/^(#{1,6}) /);
      if (h && h[1].length <= s.level) {
        end = j;
        break;
      }
    }
    const block = lines.slice(s.line + 1, end).join('\n');
    out.push(parseStatBlock(s.name, block, s.level + 1, { source, group: group === s.name ? null : group }));
  }
  return out;
}

function parseStatBlock(name, block, sectionLevel, { source, group }) {
  const meta = plain(block.split('\n').find((l) => l.startsWith('_')));
  const comma = meta.lastIndexOf(',');
  const sizeType = meta.slice(0, comma).trim();
  const alignment = meta.slice(comma + 1).trim();
  const sizeWords = [];
  let rest = sizeType;
  for (;;) {
    const m = rest.match(new RegExp(`^(${SIZES.join('|')})(?:\\s+or\\s+|\\s+)`));
    if (!m) break;
    sizeWords.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  const type = rest.trim();

  const acLine = block.match(/\*\*AC\*\*\s*([^*<]+?)\s*(?:\*\*|<br>)/);
  const initLine = block.match(/\*\*Initiative\*\*\s*([+−-]?\d+)\s*\((\d+)\)/);
  const hpLine = block.match(/\*\*HP\*\*\s*(\d+)\s*(?:\(([^)]+)\))?/);
  const speedLine = block.match(/\*\*Speed\*\*\s*(.+?)\s*(?:<br>)?\s*$/m);

  const abilities = {};
  const table = findTables(block)[0];
  if (table) {
    for (const row of parseHtmlTable(table)) {
      if (row.header) continue;
      for (let i = 0; i + 3 < row.cells.length + 1; i += 4) {
        const key = row.cells[i];
        if (!ABILITIES.includes(key)) continue;
        abilities[key.toLowerCase()] = {
          score: Number(row.cells[i + 1]),
          mod: signedNumber(row.cells[i + 2]),
          save: signedNumber(row.cells[i + 3]),
        };
      }
    }
  }

  const fields = {};
  for (const m of block.matchAll(/^\*\*([A-Z][A-Za-z ]+?)\*\*\s+(.+?)\s*(?:<br>)?\s*$/gm)) {
    const key = m[1].trim();
    if (['AC', 'HP', 'Speed'].includes(key)) continue;
    fields[key] = plain(m[2]);
  }
  const cr = parseCr(fields['CR']);

  const sections = {};
  for (const sec of splitByHeading(block, sectionLevel)) {
    if (!STAT_SECTIONS.includes(sec.title)) continue;
    const key = camel(sec.title);
    let text = sec.body;
    let intro = null;
    const introMatch = text.match(/^(?:<hr>\s*)?_([^_][\s\S]*?)_\s*(?:\n\n|$)/);
    if (introMatch && !/^\*\*/.test(text.replace(/^<hr>\s*/, ''))) {
      intro = introMatch[1].trim();
      text = text.slice(introMatch.index + introMatch[0].length);
    }
    sections[key] = namedParagraphs(text).map(enrichAction);
    if (intro) sections[key + 'Intro'] = intro;
  }

  return {
    id: slugify(name),
    name,
    group,
    source,
    size: sizeWords,
    type,
    alignment,
    ac: acLine ? acLine[1].trim() : null,
    acValue: acLine ? Number(acLine[1].match(/\d+/)?.[0]) : null,
    // A few stat blocks omit Initiative; it defaults to the Dexterity modifier.
    initiative: initLine
      ? { bonus: signedNumber(initLine[1]), score: Number(initLine[2]) }
      : abilities.dex
        ? { bonus: abilities.dex.mod, score: 10 + abilities.dex.mod }
        : null,
    hp: hpLine ? { average: Number(hpLine[1]), formula: hpLine[2]?.replace(/\s+/g, '') ?? null } : null,
    speed: speedLine ? plain(speedLine[1]) : null,
    abilities,
    skills: fields['Skills'] ?? null,
    vulnerabilities: fields['Vulnerabilities'] ?? null,
    resistances: fields['Resistances'] ?? null,
    immunities: fields['Immunities'] ?? null,
    gear: fields['Gear'] ?? null,
    senses: fields['Senses'] ?? null,
    languages: fields['Languages'] ?? null,
    cr,
    traits: sections.traits ?? [],
    actions: sections.actions ?? [],
    bonusActions: sections.bonusActions ?? [],
    reactions: sections.reactions ?? [],
    legendaryActions: sections.legendaryActions ?? [],
    legendaryActionsIntro: sections.legendaryActionsIntro ?? null,
  };
}

function parseCr(raw) {
  if (!raw) return null;
  // Usually "10 (XP 5,900, or 7,200 in lair; PB +4)"; a few read "3 (700 XP; PB +2)".
  const m = raw.match(/^([\d/]+)\s*\((?:XP ([\d,]+)|([\d,]+) XP)(?:,? or ([\d,]+) in lair)?;\s*PB \+(\d+)\)/);
  if (!m) return { raw };
  const [num, den] = m[1].split('/').map(Number);
  return {
    rating: m[1],
    value: den ? num / den : num,
    xp: Number((m[2] ?? m[3]).replace(/,/g, '')),
    xpInLair: m[4] ? Number(m[4].replace(/,/g, '')) : null,
    proficiencyBonus: Number(m[5]),
  };
}

/** Pull machine-usable numbers (attack bonus, damage dice, save DC) out of an action. */
export function enrichAction({ name, text }) {
  const out = { name, text };
  const uses = name.match(/\((\d+)\/Day(?:[^)]*)?\)/i);
  const recharge = name.match(/\(Recharge (\d)(?:[–-](\d))?\)/i);
  if (uses) out.usesPerDay = Number(uses[1]);
  if (recharge) out.recharge = Number(recharge[1]);
  const atk = text.match(/_(Melee|Ranged|Melee or Ranged) Attack Roll:_\s*([+−-]\d+)(?:,\s*(reach [^.]*?ft\.|range [^.]*?ft\.)(?:\s*or\s*(range [^.]*?ft\.))?)?/);
  if (atk) {
    out.attack = {
      kind: atk[1].toLowerCase(),
      bonus: signedNumber(atk[2]),
      reach: atk[3] ?? null,
      range: atk[4] ?? null,
    };
    const hit = text.match(/_Hit:_\s*([\s\S]*?)(?=_Miss:_|$)/);
    if (hit) out.attack.damage = findDice(hit[1]);
  }
  const save = text.match(/_(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw:_\s*DC (\d+)/);
  if (save) {
    out.save = { ability: save[1].slice(0, 3).toLowerCase(), dc: Number(save[2]) };
    const fail = text.match(/_Failure:_\s*([\s\S]*?)(?=_Success:_|_Failure or Success:_|$)/);
    if (fail) out.save.damage = findDice(fail[1]);
  }
  return out;
}

function camel(title) {
  return title.toLowerCase().replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
}

/* ------------------------------------------------------------- magic items */

export function parseMagicItems(md) {
  const body = md.slice(md.indexOf('## Magic Items A–Z'));
  // A couple of items (e.g. Figurines, Deck of Many Things) embed a creature
  // stat block under its own #### heading; fold those back into the item.
  const merged = [];
  for (const sec of splitByHeading(body, 4)) {
    const meta = plain(sec.body.split('\n').find((l) => l.trim()) || '');
    if (/^_?[A-Z][^\n]*, (Very Rare|Uncommon|Common|Rare|Legendary|Artifact|Varies)/.test(meta) || /Rarity Varies|Rarity by/.test(meta) || !merged.length)
      merged.push({ ...sec, statBlock: '' });
    else {
      const prev = merged[merged.length - 1];
      prev.statBlock += `${prev.statBlock ? '\n\n' : ''}##### ${sec.title}\n\n${sec.body}`;
    }
  }
  return merged.map(({ title, body: text, statBlock }) => {
    const metaLine = text.split('\n').find((l) => l.startsWith('_')) || '';
    const meta = plain(metaLine);
    const rarities = [...new Set([...meta.matchAll(RARITY_RE)].map((m) => m[1]))];
    const attunement = meta.match(/\((Requires Attunement[^)]*)\)/);
    const category = meta.split(/[,(]/)[0].trim();
    return {
      id: slugify(title),
      name: title,
      category,
      rarity: rarities,
      meta,
      attunement: attunement ? attunement[1] : null,
      description: cleanText(text.slice(text.indexOf(metaLine) + metaLine.length).trim()),
      creatureStatBlock: statBlock || null,
    };
  });
}

/* ------------------------------------------------------------------- feats */

export function parseFeats(md) {
  const feats = [];
  for (const cat of splitByHeading(md, 3)) {
    if (!/Feats$/.test(cat.title)) continue;
    for (const { title, body } of splitByHeading(cat.body, 4)) {
      const metaLine = body.split('\n').find((l) => l.startsWith('_')) || '';
      const meta = plain(metaLine);
      const prereq = meta.match(/\(Prerequisite:\s*([^)]*)\)/);
      feats.push({
        id: slugify(title),
        name: title,
        category: cat.title.replace(/s$/, ''),
        prerequisite: prereq ? prereq[1] : null,
        repeatable: /_Repeatable\._/.test(body),
        description: cleanText(body.slice(body.indexOf(metaLine) + metaLine.length).trim()),
      });
    }
  }
  return feats;
}

/* ------------------------------------------------- species and backgrounds */

export function parseBackgrounds(md) {
  return splitByHeading(sectionAfter(md, '### Background Descriptions'), 4).map(({ title, body }) => {
    const f = boldFields(body);
    return {
      id: slugify(title),
      name: title,
      abilityScores: (f['Ability Scores'] || '').split(',').map((s) => s.trim()).filter(Boolean),
      feat: plain(f['Feat'] || '').replace(/\s*\(see "Feats"\)/, ''),
      skillProficiencies: (f['Skill Proficiencies'] || '').split(/,|\band\b/).map((s) => s.trim()).filter(Boolean),
      toolProficiency: f['Tool Proficiency'] || null,
      equipment: plain(f['Equipment'] || ''),
      description: cleanText(body),
    };
  });
}

export function parseSpecies(md) {
  return splitByHeading(sectionAfter(md, '### Species Descriptions'), 4).map(({ title, body }) => {
    const f = boldFields(body);
    const afterFields = body.slice(body.indexOf('\n', body.indexOf('**Speed:**')) + 1).trim();
    const traitsText = afterFields.replace(/^As an? [^\n]*special traits\.\s*/, '');
    const speed = Number((f['Speed'] || '').match(/\d+/)?.[0]);
    return {
      id: slugify(title),
      name: title,
      creatureType: f['Creature Type'] || null,
      size: f['Size'] || null,
      speed: Number.isFinite(speed) ? speed : null,
      traits: namedParagraphs(traitsText).filter((t) => t.name),
      description: cleanText(body),
    };
  });
}

/* ----------------------------------------------------------------- classes */

export function parseClasses(md) {
  return splitByHeading(md, 2).map(({ title: name, body }) => {
    const intro = body.split(/\n### /)[0];
    const core = {};
    const coreTable = findTables(intro)[0];
    if (coreTable) for (const r of parseHtmlTable(coreTable)) if (r.cells.length === 2) core[r.cells[0]] = r.cells[1];

    const featuresSection = sectionAfter(body, `### ${name} Class Features`);
    const levelTableHtml = findTables(featuresSection)[0];
    let levelTable = null;
    if (levelTableHtml) {
      const rows = parseHtmlTable(levelTableHtml);
      const head = rows.find((r) => r.header);
      levelTable = {
        columns: head ? head.cells : [],
        rows: rows.filter((r) => !r.header).map((r) => r.cells),
      };
    }
    const features = featureList(featuresSection);

    const subclasses = [];
    const extras = [];
    for (const sec of splitByHeading(body, 3)) {
      const sub = sec.title.match(/^.+ Subclass: (.+)$/);
      if (sub) {
        const tagline = sec.body.match(/^_([^_]+)_/);
        const firstFeature = sec.body.search(/^#### /m);
        subclasses.push({
          id: slugify(sub[1]),
          name: sub[1],
          tagline: tagline ? tagline[1] : null,
          description: cleanText((firstFeature === -1 ? sec.body : sec.body.slice(0, firstFeature)).replace(/^_[^_]+_\s*/, '')),
          features: featureList(sec.body),
        });
      } else if (!/Class Features$|^Becoming/.test(sec.title)) {
        extras.push({ title: sec.title, markdown: sec.body });
      }
    }

    const hitDie = (core['Hit Point Die'] || '').match(/D(\d+)/i);
    return {
      id: slugify(name),
      name,
      description: cleanText(intro.replace(/<table>[\s\S]*?<\/table>/g, '').replace(/\*\*Core .* Traits\*\*/, '')),
      primaryAbility: core['Primary Ability'] || null,
      hitDie: hitDie ? Number(hitDie[1]) : null,
      savingThrows: (core['Saving Throw Proficiencies'] || '').split(/\s+and\s+|,\s*/).filter(Boolean),
      skillChoices: parseSkillChoices(core['Skill Proficiencies']),
      weaponProficiencies: core['Weapon Proficiencies'] || null,
      toolProficiencies: core['Tool Proficiencies'] || null,
      armorTraining: core['Armor Training'] || null,
      startingEquipment: core['Starting Equipment'] || null,
      coreTraits: core,
      levelTable,
      features,
      subclasses,
      extras,
    };
  });
}

function featureList(markdown) {
  return splitByHeading(markdown, 4)
    .map(({ title, body }) => {
      const m = title.match(/^Level (\d+):\s*(.+)$/);
      return m ? { level: Number(m[1]), name: m[2].trim(), description: cleanText(body) } : null;
    })
    .filter(Boolean);
}

function parseSkillChoices(raw) {
  if (!raw) return null;
  const any = raw.match(/Choose any (\d+) skills/i);
  if (any) return { count: Number(any[1]), options: 'any', raw };
  const m = raw.match(/Choose (\d+)(?::| from)\s*(.*)$/i);
  if (!m) return { count: 0, options: [], raw };
  const options = /any/i.test(m[2]) && !m[2].includes(',') ? 'any' : m[2].replace(/\bor\b/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  return { count: Number(m[1]), options, raw };
}

/* --------------------------------------------------------------- equipment */

export function parseEquipment(md) {
  const weaponsSection = sectionAfter(md, '## Weapons');
  const weaponTable = findTables(weaponsSection).find((t) => /Mastery/.test(t));
  const weapons = [];
  let group = null;
  for (const r of parseHtmlTable(weaponTable)) {
    if (r.header) {
      if (r.cells.length === 1) group = r.cells[0];
      continue;
    }
    const [name, damage, properties, mastery, weight, cost] = r.cells;
    const dmg = damage.match(/^(\d+d\d+|\d+)\s*(\w+)?/);
    weapons.push({
      id: slugify(name),
      name,
      category: group?.split(' ')[0] ?? null, // Simple / Martial
      kind: /Ranged/.test(group ?? '') ? 'ranged' : 'melee',
      damage: dmg ? { dice: dmg[1], type: dmg[2] ?? null } : null,
      damageText: damage,
      properties: properties === '—' ? [] : splitTopLevel(properties),
      mastery,
      weight,
      cost,
    });
  }

  const armorSection = sectionAfter(md, '## Armor');
  const armorTable = findTables(armorSection).find((t) => /Armor Class/.test(t));
  const armor = [];
  group = null;
  for (const r of parseHtmlTable(armorTable)) {
    if (r.header) {
      if (r.cells.length === 1) group = r.cells[0];
      continue;
    }
    const [name, ac, strength, stealth, weight, cost] = r.cells;
    const base = ac.match(/^\+?(\d+)/);
    armor.push({
      id: slugify(name),
      name,
      category: group ? group.split(' ')[0] : null, // Light / Medium / Heavy / Shield
      armorClass: ac,
      baseAc: base ? Number(base[1]) : null,
      addsDex: /Dex/.test(ac),
      maxDex: /max 2/.test(ac) ? 2 : null,
      isShield: /^\+/.test(ac),
      strength: strength === '—' ? null : Number(strength.match(/\d+/)?.[0]),
      stealthDisadvantage: /Disadvantage/.test(stealth),
      weight,
      cost,
    });
  }

  const properties = definitionParagraphs(sectionAfter(md, '### Properties'));
  const masteryProperties = definitionParagraphs(sectionAfter(md, '### Mastery Properties'));

  const gear = splitByHeading(sectionAfter(md, '## Adventuring Gear'), 4).map(({ title, body }) => {
    const m = title.match(/^(.+?)\s*\(([^)]+)\)$/);
    return {
      id: slugify(m ? m[1] : title),
      name: m ? m[1] : title,
      cost: m ? m[2] : null,
      description: cleanText(body),
    };
  });

  return { weapons, armor, properties, masteryProperties, gear };
}

/** "**Name.** text" paragraphs, e.g. weapon property definitions. */
function definitionParagraphs(markdown) {
  return [...markdown.matchAll(/^\*\*([^*]+?)\.\*\*\s*(.+)$/gm)].map((m) => ({
    id: slugify(m[1]),
    name: m[1],
    description: m[2].trim(),
  }));
}

/** Split "Finesse, Thrown (Range 20/60), Versatile (1d8)" on commas outside parentheses. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ---------------------------------------------------------------- glossary */

export function parseGlossary(md) {
  return splitByHeading(sectionAfter(md, '## Rules Definitions'), 4).map(({ title, body }) => {
    const m = title.match(/^(.+?)\s*\[([^\]]+)\]$/);
    return {
      id: slugify(m ? m[1] : title),
      name: m ? m[1] : title,
      tag: m ? m[2] : null,
      description: cleanText(body),
    };
  });
}

/* ------------------------------------------------------------ rule chapters */

/** Whole chapters kept as Markdown for the rules reader. */
export function chapter(id, title, markdown) {
  return { id, title, markdown: markdown.replace(/^# .+\n/, '').trim() };
}
