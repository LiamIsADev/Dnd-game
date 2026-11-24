// Species, backgrounds and new classes from the Open5e snapshot, in the same
// shape as the SRD data so the builder, sheet and rules browser use them as is.
//
// These books were written for the 2014 rules, so they're brought into line
// with the 2024 ones the way the 2024 Player's Handbook does for older
// options: a species' own Ability Score Increase is replaced by the one from
// your background, and an older background lets you pick the three ability
// scores and the Origin feat it gives.

const SKILLS = [
  'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception', 'History', 'Insight', 'Intimidation', 'Investigation',
  'Medicine', 'Nature', 'Perception', 'Performance', 'Persuasion', 'Religion', 'Sleight of Hand', 'Stealth', 'Survival',
];
const ABILITY = { strength: 'Strength', dexterity: 'Dexterity', constitution: 'Constitution', intelligence: 'Intelligence', wisdom: 'Wisdom', charisma: 'Charisma', str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
const RULES_2024_SPECIES =
  'This species comes from a book written for the 2014 rules. As in the 2024 rules, your background gives your ability score increases, so this species’ own Ability Score Increase isn’t used.';
const RULES_2024_BACKGROUND =
  'This background comes from a book written for the 2014 rules. As the 2024 rules allow for older backgrounds, choose any three ability scores for its increases and any Origin feat.';

const skillsIn = (text) => SKILLS.filter((s) => new RegExp(`\\b${s}\\b`, 'i').test(text));
const words = { one: 1, two: 2, three: 3 };

/* -------------------------------------------------------------- species */

/** The parts of a trait list the site works out itself: speed, size, darkvision. */
function stats(traits) {
  const all = traits.map((t) => `${t.name}. ${t.desc}`).join('\n');
  const speed = Number(all.match(/(?:walking )?speed (?:is|of) (\d+) feet/i)?.[1]) || null;
  const size = all.match(/Your size is (Small|Medium|Large)/i)?.[1] || null;
  const dark = Number(all.match(/(?:dim light|darkvision) (?:out to |within )?(\d+) feet/i)?.[1]) || null;
  return { speed, size, darkvision: dark };
}

/**
 * Skill proficiencies a species' traits give, so the sheet counts them:
 * { skills: fixed skills, skillChoice: { count, options } | null }.
 * "two skills of your choice" offers every skill.
 */
export function skillGrants(traits) {
  const skills = [];
  let choice = null;
  const addChoice = (count, options) => {
    if (!choice) choice = { count: 0, options: [] };
    choice.count += count;
    choice.options = [...new Set([...choice.options, ...options])];
  };
  for (const t of traits) {
    for (const sentence of String(t.text ?? t.desc ?? '').split(/(?<=\.)\s+/)) {
      if (!/proficien\w* (?:in|with) [^.]*skill/i.test(sentence)) continue;
      const pick = sentence.match(/(one|two|three) of the following skills of your choice:?([^.]*)/i);
      const any = sentence.match(/(one|two|three) skills?(?: or tools?)?(?: and (?:one|two) tools?)? of your choice/i);
      if (pick) {
        const before = sentence.slice(0, pick.index);
        skills.push(...skillsIn(before));
        addChoice(words[pick[1].toLowerCase()], skillsIn(pick[2]));
      } else if (any) {
        addChoice(words[any[1].toLowerCase()], SKILLS);
      } else {
        const m = sentence.match(/proficien\w* (?:in|with) (?:the )?([^.]*?)skills?\b/i);
        if (m) skills.push(...skillsIn(m[1]));
      }
    }
  }
  return { skills: [...new Set(skills)], skillChoice: choice };
}

/** "Ability Score Increase" traits are left out (2024 rules); everything else is kept. */
const keepTrait = (t) => !/^Ability Score Increase$/i.test(t.name);

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function traitList(traits, clean) {
  return traits.filter(keepTrait).map((t) => ({
    name: t.name.replace(/\s+table$/i, ''),
    // Some texts repeat the trait's name in bold at the start ("**_Speed._** ...").
    text: clean(String(t.desc).replace(new RegExp(`^[*_\\s]*${escapeRe(t.name)}\\.?[*_\\s]*`, 'i'), '')),
  }));
}

const SUB_LABEL = { toh_darakhul: 'Heritage', toh_gearforged: 'Race chassis', toh_mushroomfolk: 'Subrace', toh_catfolk: 'Subrace', toh_derro: 'Subrace', toh_drow: 'Subrace', toh_minotaur: 'Subrace' };

/**
 * @param src open5e-source/species.json
 * @param srdSpecies the SRD 5.2.1 species (for Stoor Halfling, a Halfling variant)
 * @returns {{ added: object[], srdAdds: { [id]: { subspecies, choices } } }}
 */
export function convertSpecies(src, srdSpecies, { clean, slug, short }) {
  const subs = src.filter((s) => s.isSub);
  const out = [];
  const srdIds = new Set(srdSpecies.map((s) => s.id));
  const subOf = (key) =>
    subs
      .filter((s) => s.parent === key)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const traits = traitList(s.traits, clean);
        return { name: s.name, description: clean(s.desc), traits, ...stats(s.traits), ...skillGrants(traits) };
      });
  for (const s of src.filter((x) => !x.isSub).sort((a, b) => a.name.localeCompare(b.name))) {
    let traits = traitList(s.traits, clean);
    let st = stats(s.traits);
    if (!s.traits.length && s.v1) {
      // Shade: only the older write-up has its traits ("***Name.*** text" paragraphs).
      traits = s.v1.text
        .split(/\n\s*\n/)
        .map((p) => p.match(/^\*{3}([^*]+?)\.\*{3}\s*([\s\S]*)$/))
        .filter(Boolean)
        .map(([, name, text]) => ({ name, text: clean(text) }));
      st = { speed: s.v1.speed?.walk || 30, size: s.v1.size || 'Medium', darkvision: Number(s.v1.text.match(/within (\d+) feet/)?.[1]) || null };
    }
    const subspecies = subOf(s.key);
    const id = srdIds.has(slug(s.name)) ? `${slug(s.name)}-${slug(short(s.source))}` : slug(s.name);
    const entry = {
      id,
      name: s.name,
      creatureType: 'Humanoid',
      // Darakhul, Gearforged, Mushroomfolk and Shade take their size from what they were (see their Size trait).
      size: st.size || (s.traits.concat(s.v1 ? [{ desc: s.v1.text }] : []).some((t) => /size is determined/i.test(t.desc)) ? 'Small or Medium (see Size)' : 'Medium'),
      speed: st.speed || subspecies.find((x) => x.speed)?.speed || 30,
      darkvision: st.darkvision,
      traits,
      ...skillGrants(traits),
      subspecies,
      choices: subspecies.length ? [{ key: 'lineage', label: SUB_LABEL[s.key] || 'Subrace', options: subspecies.map((x) => [x.name, x.name]) }] : [],
      rules2014: true,
      source: s.source,
      sourceName: short(s.source),
    };
    entry.description = speciesText(entry, clean(s.desc));
    out.push(entry);
  }
  // Stoor Halfling: an optional Halfling variant (Open5e Originals).
  const srdAdds = {};
  const stoor = subs.filter((s) => s.parent === 'srd_halfling');
  if (stoor.length && srdIds.has('halfling')) {
    srdAdds.halfling = {
      subspecies: stoor.map((s) => ({ name: s.name, description: clean(s.desc), traits: traitList(s.traits, clean), ...skillGrants(traitList(s.traits, clean)), optional: true, source: s.source, sourceName: short(s.source) })),
      choices: [{ key: 'lineage', label: 'Variant (optional)', optional: true, options: stoor.map((s) => [s.name, `${s.name} (${short(s.source)})`]) }],
    };
  }
  return { added: out, srdAdds };
}

function speciesText(s, lore) {
  const lines = [
    `**Creature Type:** ${s.creatureType}`,
    `**Size:** ${s.size}`,
    `**Speed:** ${s.speed} feet`,
    lore,
    `_${RULES_2024_SPECIES}_`,
    ...s.traits.map((t) => `***${t.name}.*** ${t.text}`),
  ];
  for (const sub of s.subspecies) {
    lines.push(`**${s.choices[0].label}: ${sub.name}**`, sub.description, ...sub.traits.map((t) => `***${t.name}.*** ${t.text}`));
  }
  return lines.filter(Boolean).join('\n\n');
}

/* ---------------------------------------------------------- backgrounds */

/** "Religion, and either Insight or Persuasion." -> fixed skills + a choice. */
export function parseBackgroundSkills(text) {
  const t = String(text || '');
  if (!t.trim()) return { fixed: [], choice: null };
  const any = t.match(/\b(one|two) (?:skills? )?of your choice\.?$/i) || t.match(/any (one|two) skills? of your choice/i);
  const split = t.search(/\beither\b|\bplus\b|your choice|choose/i);
  const fixed = split === -1 ? skillsIn(t) : skillsIn(t.slice(0, split));
  if (split === -1) return { fixed, choice: null };
  const rest = t.slice(split);
  const count = words[(rest.match(/\b(one|two|three)\b/i)?.[1] || 'one').toLowerCase()] || 1;
  let options = skillsIn(rest).filter((s) => !fixed.includes(s));
  if (any && !options.length) options = SKILLS.filter((s) => !fixed.includes(s));
  if (!options.length) return { fixed, choice: null };
  if (options.length <= count) return { fixed: [...fixed, ...options], choice: null };
  return { fixed, choice: { count, options } };
}

/** "A set of fine clothes, ..., and a belt pouch containing 10 gp" -> a list the builder can hand out. */
export function equipmentList(text) {
  const t = String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\([^)]*\)/g, '')
    .replace(/\*\*/g, '');
  const coins = [...t.matchAll(/(\d+)\s*(gp|sp|cp|g)\b/gi)].map((m) => `${m[1]} ${m[2].toLowerCase() === 'g' ? 'GP' : m[2].toUpperCase()}`);
  const parts = t
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/(?:a |and )?(?:belt )?pouch (?:containing|with)[^,.;]*/gi, 'Pouch')
    .replace(/\d+\s*(gp|sp|cp|g)\b/gi, '')
    .split(/,|;|\band\b|\.\s/)
    .map((x) => x.replace(/^\s*(?:a set of|a|an|the|one|some)\s+/i, '').replace(/[.:]+$/, '').trim())
    .filter((x) => x && !/^(your choice|of your choice)$/i.test(x));
  // "a dagger, quarterstaff, or spear": the choices become one item.
  const items = [];
  for (const x of parts) {
    if (/^or\s/i.test(x) && items.length) items[items.length - 1] += ` ${x.replace(/^or\s+(?:a|an)?\s*/i, 'or ')}`;
    else items.push(x);
  }
  const named = items.filter((x) => x.length < 70).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  return [...named, ...coins].join(', ');
}

export function convertBackground(b, { clean, slug, short, takenNames, takenIds }) {
  const get = (type) => b.benefits.filter((x) => x.type === type);
  const skills = parseBackgroundSkills(get('skill_proficiency')[0]?.desc);
  const tools = get('tool_proficiency').map((x) => clean(x.desc)).join(' ') || null;
  const equipmentText = get('equipment').map((x) => clean(x.desc)).join(' ');
  const suggested = get('ability_score')[0]?.desc || '';
  const sourceName = short(b.source);
  const name = takenNames.has(b.name.toLowerCase()) ? `${b.name} (${sourceName})` : b.name;
  let id = slug(name);
  if (takenIds.has(id)) id = `${id}-${slug(sourceName)}`;
  takenNames.add(name.toLowerCase());
  takenIds.add(id);
  const suggestedKeys = [...suggested.matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b/g)].map((m) => ABILITY[m[1].toLowerCase()]);
  const out = {
    id,
    name,
    abilityScores: ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'],
    chooseAbilities: true,
    suggestedAbilities: suggestedKeys,
    feat: null,
    chooseFeat: true,
    skillProficiencies: skills.fixed,
    skillChoice: skills.choice,
    toolProficiency: tools,
    equipment: equipmentList(equipmentText) || '50 GP',
    rules2014: true,
    source: b.source,
    sourceName,
  };
  const skillLine = [skills.fixed.join(' and '), skills.choice ? `${skills.choice.count === 1 ? 'one' : skills.choice.count} of ${skills.choice.options.length > 10 ? 'any skill' : skills.choice.options.join(', ')}` : '']
    .filter(Boolean)
    .join(', plus ');
  const extras = b.benefits
    .filter((x) => !['skill_proficiency', 'tool_proficiency', 'equipment', 'ability_score'].includes(x.type))
    .sort((x, y) => (x.type === 'feature' ? -1 : y.type === 'feature' ? 1 : 0));
  out.description = [
    `**Ability Scores:** any three you choose${suggestedKeys.length ? ` (the book suggests ${suggestedKeys.join(' and ')})` : ''}`,
    `**Feat:** any Origin feat you choose`,
    `**Skill Proficiencies:** ${skillLine || 'None'}`,
    `**Tool Proficiency:** ${tools || 'None'}`,
    `**Equipment:** ${clean(equipmentText) || 'None listed'}`,
    `_${RULES_2024_BACKGROUND}_`,
    clean(b.desc),
    ...extras.map((x) => `**${x.name}.** ${clean(x.desc)}`),
  ]
    .filter(Boolean)
    .join('\n\n');
  return out;
}

/* -------------------------------------------------------------- classes */

const SKILL_LINE = /\*\*Skills:\*\*\s*Choose (\w+) from ([^\n]+)/i;

function proficiencies(text) {
  const line = (label) => text.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || '';
  const skills = text.match(SKILL_LINE);
  const options = skills ? skillsIn(skills[2]) : [];
  const saves = line('Saving Throws')
    .split(/,|\band\b/)
    .map((x) => ABILITY[x.trim().toLowerCase()])
    .filter(Boolean);
  const cap = (s) => s.replace(/\b(light|medium|heavy|simple|martial)\b/gi, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).replace(/\bshields\b/i, 'Shields');
  return {
    armor: cap(line('Armor').replace(/ armor/gi, '')).replace(/, (Shields)$/, ' armor and $1'),
    weapons: cap(line('Weapons')),
    tools: line('Tools'),
    saves,
    skillCount: words[(skills?.[1] || 'two').toLowerCase()] || 2,
    skillOptions: options,
  };
}

// The site hands out starting equipment from "Choose A or B: (A) ...; or (B) ..."
// lists, so each class's packages are written that way (from the book's own list).
const EQUIPMENT = {
  a5e_marshal: "Choose A, B or C: (A) 6 Javelins, Longsword, Chain Mail, Shield, Explorer's Pack, and 7 GP; or (B) Battleaxe, Scimitar, 2 Spears, Longbow, Quiver, 20 Arrows, Padded Armor, Dungeoneer's Pack, and 89 GP; or (C) 200 GP",
  bfrd_mechanist: "Choose A or B: (A) Longsword, Shield, Light Crossbow, 20 Bolts, Scale Mail, Tinker's Tools, and Dungeoneer's Pack; or (B) 2 Handaxes, Light Crossbow, 20 Bolts, Leather Armor, Tinker's Tools, and Dungeoneer's Pack",
};
const EQUIPMENT_NOTE = {
  a5e_marshal: "The site hands out SRD items in place of Level Up's hauberk, light shield and padded leather (Chain Mail, Shield and Padded Armor). Ask your DM if you'd rather use Level Up's versions.",
  bfrd_mechanist: 'Package A takes a Longsword as its martial weapon and B two Handaxes as its simple weapons; swap them for any others of the same kind.',
};
const PRIMARY = { a5e_marshal: 'Strength or Dexterity, and Charisma', bfrd_mechanist: 'Intelligence' };
const SUBCLASS_FEATURE = /Archetype|Subclass/i;
const ASI_FEATURE = /^(Ability Score Improvement|Improvement)$/i;
const COLUMN_NAME = { 'bfrd_mechanist_augmented-items': 'Augmented Items' };

/**
 * Turn Level Up's Marshal and Black Flag's Mechanist into SRD-shaped classes,
 * with their level tables, every feature and their subclasses.
 */
export function convertClasses(src, { clean, slug, short }) {
  const classes = [];
  for (const c of src.filter((x) => !x.subclassOf)) {
    const prof = proficiencies(c.features.find((f) => f.type === 'PROFICIENCIES')?.desc || '');
    const equipFeature = c.features.find((f) => f.type === 'STARTING_EQUIPMENT');
    const tableCols = c.features.filter((f) => f.type === 'CLASS_TABLE_DATA');
    const levelFeatures = c.features
      .filter((f) => f.type === 'CLASS_LEVEL_FEATURE' && f.levels.length)
      .map((f) => ({ ...f, first: Math.min(...f.levels) }));
    const optionLists = c.features.filter((f) => f.type === 'CLASS_FEATURE_OPTION_LIST' || (f.type === 'CLASS_LEVEL_FEATURE' && !f.levels.length));
    const label = (f) => (SUBCLASS_FEATURE.test(f.name) ? (/Subclass/i.test(f.name) ? f.name : `${f.name} (Subclass)`) : ASI_FEATURE.test(f.name) ? 'Ability Score Improvement' : f.name);
    // Levels where the subclasses gain features (after the first).
    const subLevels = new Set(
      src.filter((x) => x.subclassOf === c.key).flatMap((x) => x.features.flatMap((f) => f.levels)).filter((l) => l > 3),
    );
    // Data fixes: the source table's Commanding Presence at level 14 disagrees with its own text (30 feet from 10th, 45 feet from 15th).
    const FIX = { 'a5e_marshal_commanding-presence-range|14': '30 feet' };
    const rows = Array.from({ length: 20 }, (_, i) => {
      const lvl = i + 1;
      const names = levelFeatures.filter((f) => f.levels.includes(lvl)).map(label);
      if (subLevels.has(lvl)) names.push('Subclass feature');
      const uniq = [...new Set(names)];
      const extra = tableCols.map((col) => {
        if (FIX[`${col.key}|${lvl}`]) return FIX[`${col.key}|${lvl}`];
        const pts = col.table.map(([l, v]) => [Number(l), String(v)]).sort((a, b) => a[0] - b[0]);
        const at = pts.filter(([l]) => l <= lvl).pop();
        return at ? at[1] : '—';
      });
      return [String(lvl), `+${Math.ceil(lvl / 4) + 1}`, uniq.join(', ') || '—', ...extra];
    });
    const features = levelFeatures
      .filter((f) => !SUBCLASS_FEATURE.test(f.name) || f.desc)
      .sort((a, b) => a.first - b.first)
      .map((f) => ({ level: f.first, name: ASI_FEATURE.test(f.name) ? 'Ability Score Improvement' : f.name, description: clean(f.desc) }));
    const name = c.name;
    const skillsRaw = `Choose ${prof.skillCount}: ${prof.skillOptions.join(', ')}`;
    const equip = EQUIPMENT[c.key] || "Choose A or B: (A) Explorer's Pack and 10 GP; or (B) 50 GP";
    const cls = {
      id: slug(name),
      name,
      description: [
        clean(c.desc),
        c.key === 'a5e_marshal'
          ? "_The Marshal uses Level Up Advanced 5th Edition's combat maneuvers, exertion points and expertise dice. Their rules are free at https://a5esrd.com; agree with your DM how to use them at your table._"
          : '',
        c.key === 'bfrd_mechanist' ? "_The Mechanist comes from Kobold Press's Black Flag Roleplaying. Its “luck” and weapon options refer to Black Flag's own rules; agree with your DM how to use them at your table._" : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      primaryAbility: PRIMARY[c.key] || 'Strength',
      hitDie: Number(String(c.hitDie).replace(/\D/g, '')) || 8,
      savingThrows: prof.saves.length ? prof.saves : c.saves,
      skillChoices: { count: prof.skillCount, options: prof.skillOptions, raw: skillsRaw },
      weaponProficiencies: prof.weapons || 'Simple weapons',
      toolProficiencies: prof.tools && !/^none$/i.test(prof.tools) ? prof.tools : null,
      armorTraining: prof.armor || 'None',
      startingEquipment: equip,
      levelTable: { columns: ['Level', 'Proficiency Bonus', 'Class Features', ...tableCols.map((col) => COLUMN_NAME[col.key] || col.name)], rows },
      features,
      subclasses: [],
      extras: [
        ...(equipFeature ? [{ title: 'Starting equipment (as written in the book)', markdown: `${clean(equipFeature.desc)}\n\n_${EQUIPMENT_NOTE[c.key] || ''}_` }] : []),
        ...optionLists.map((f) => ({ title: f.name, markdown: clean(f.desc) })),
      ],
      source: c.source,
      sourceName: short(c.source),
    };
    cls.coreTraits = {
      'Primary Ability': cls.primaryAbility,
      'Hit Point Die': `D${cls.hitDie} per ${name} level`,
      'Saving Throw Proficiencies': cls.savingThrows.join(' and '),
      'Skill Proficiencies': skillsRaw,
      'Weapon Proficiencies': cls.weaponProficiencies,
      ...(cls.toolProficiencies ? { 'Tool Proficiencies': cls.toolProficiencies } : {}),
      'Armor Training': cls.armorTraining,
      'Starting Equipment': equip,
    };
    for (const sc of src.filter((x) => x.subclassOf === c.key).sort((a, b) => a.name.localeCompare(b.name))) {
      cls.subclasses.push({
        id: slug(sc.name),
        name: sc.name,
        tagline: null,
        description: clean(sc.desc) || `A ${name} subclass from ${short(sc.source)}.`,
        features: sc.features
          .filter((f) => f.levels.length)
          .map((f) => ({ level: Math.min(...f.levels), name: f.name, description: clean(f.desc) }))
          .sort((a, b) => a.level - b.level),
        source: sc.source,
        sourceName: short(sc.source),
      });
    }
    classes.push(cls);
  }
  return classes;
}
