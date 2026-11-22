// Rules browser: search and read everything in the SRD data.
// URL shape: #/rules/<category>/<item-id>
import { html, raw, rulesMarkdown, debounce } from '../lib/dom.js';
import { loadSrd, spellLevelLabel } from '../lib/srd.js';
import { statBlock } from '../components/statblock.js';

const md = (text) => raw(rulesMarkdown(text));

const CATEGORIES = [
  {
    id: 'spells',
    label: 'Spells',
    load: () => loadSrd('spells'),
    sub: (s) => `${spellLevelLabel(s.level)} ${s.school}${s.ritual ? ' · Ritual' : ''}${s.concentration ? ' · Concentration' : ''}`,
    search: (s) => [s.name, s.school, ...s.classes].join(' '),
    filters: [
      { id: 'level', label: 'Level', options: (items) => [...new Set(items.map((s) => s.level))].sort((a, b) => a - b).map((l) => [String(l), l === 0 ? 'Cantrip' : `Level ${l}`]), test: (s, v) => String(s.level) === v },
      { id: 'class', label: 'Class', options: (items) => [...new Set(items.flatMap((s) => s.classes))].sort().map((c) => [c, c]), test: (s, v) => s.classes.includes(v) },
    ],
    detail: (s) => html`
      <h2>${s.name}</h2>
      <p class="meta">${spellLevelLabel(s.level)} ${s.school} (${s.classes.join(', ')})</p>
      <dl class="facts">
        <dt>Casting Time</dt><dd>${s.castingTime}</dd>
        <dt>Range</dt><dd>${s.range}</dd>
        <dt>Components</dt><dd>${s.components.raw}</dd>
        <dt>Duration</dt><dd>${s.duration}</dd>
      </dl>
      ${md(s.description)}
      ${s.higherLevels ? html`<p><strong><em>Using a Higher-Level Spell Slot.</em></strong> ${s.higherLevels}</p>` : ''}
      ${s.cantripUpgrade ? html`<p><strong><em>Cantrip Upgrade.</em></strong> ${s.cantripUpgrade}</p>` : ''}
      ${s.creatureStatBlock ? html`<div class="embedded">${md(s.creatureStatBlock)}</div>` : ''}`,
  },
  {
    id: 'monsters',
    label: 'Monsters',
    load: () => loadSrd('monsters'),
    sub: (m) => `CR ${m.cr?.rating ?? '?'} · ${m.size.join('/')} ${m.type}`,
    search: (m) => [m.name, m.type, m.group].join(' '),
    filters: [
      { id: 'cr', label: 'CR', options: (items) => [...new Map(items.filter((m) => m.cr?.rating).map((m) => [m.cr.rating, m.cr.value])).entries()].sort((a, b) => a[1] - b[1]).map(([r]) => [r, `CR ${r}`]), test: (m, v) => m.cr?.rating === v },
      { id: 'type', label: 'Type', options: (items) => [...new Set(items.map((m) => m.type.split(' (')[0]))].sort().map((t) => [t, t]), test: (m, v) => m.type.split(' (')[0] === v },
    ],
    detail: (m) => statBlock(m),
  },
  {
    id: 'magic-items',
    label: 'Magic Items',
    load: () => loadSrd('magic-items'),
    sub: (i) => `${i.category} · ${i.rarity.join(' / ')}${i.attunement ? ' · Attunement' : ''}`,
    search: (i) => [i.name, i.category, ...i.rarity].join(' '),
    filters: [
      { id: 'rarity', label: 'Rarity', options: () => ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary', 'Artifact', 'Varies'].map((r) => [r, r]), test: (i, v) => i.rarity.includes(v) },
      { id: 'category', label: 'Type', options: (items) => [...new Set(items.map((i) => i.category))].sort().map((c) => [c, c]), test: (i, v) => i.category === v },
    ],
    detail: (i) => html`<h2>${i.name}</h2><p class="meta">${i.meta}</p>${md(i.description)}${i.creatureStatBlock ? html`<div class="embedded">${md(i.creatureStatBlock)}</div>` : ''}`,
  },
  {
    id: 'classes',
    label: 'Classes',
    load: () => loadSrd('classes'),
    sub: (c) => `d${c.hitDie} · ${c.primaryAbility}`,
    search: (c) => c.name,
    detail: (c) => html`
      <h2>${c.name}</h2>
      ${md(c.description)}
      <table class="traits"><tbody>${Object.entries(c.coreTraits).map(([k, v]) => html`<tr><th scope="row">${k}</th><td>${v}</td></tr>`)}</tbody></table>
      ${c.levelTable
        ? html`<h3>${c.name} Features</h3><div class="table-scroll"><table><thead><tr>${c.levelTable.columns.map((h) => html`<th>${h}</th>`)}</tr></thead>
          <tbody>${c.levelTable.rows.map((r) => html`<tr>${r.map((cell) => html`<td>${cell}</td>`)}</tr>`)}</tbody></table></div>`
        : ''}
      <h3>Class Features</h3>
      ${c.features.map((f) => html`<details><summary>Level ${f.level}: ${f.name}</summary>${md(f.description)}</details>`)}
      ${c.subclasses.map(
        (s) => html`<h3>Subclass: ${s.name}</h3>${s.tagline ? html`<p class="meta">${s.tagline}</p>` : ''}${md(s.description)}
          ${s.features.map((f) => html`<details><summary>Level ${f.level}: ${f.name}</summary>${md(f.description)}</details>`)}`,
      )}
      ${c.extras.map((x) => html`<details><summary>${x.title}</summary>${md(x.markdown)}</details>`)}`,
  },
  {
    id: 'species',
    label: 'Species',
    load: () => loadSrd('species'),
    sub: (s) => `${s.creatureType} · Speed ${s.speed} ft.`,
    search: (s) => s.name,
    detail: (s) => html`<h2>${s.name}</h2>${md(s.description)}`,
  },
  {
    id: 'backgrounds',
    label: 'Backgrounds',
    load: () => loadSrd('backgrounds'),
    sub: (b) => b.skillProficiencies.join(', '),
    search: (b) => b.name,
    detail: (b) => html`<h2>${b.name}</h2>${md(b.description)}`,
  },
  {
    id: 'feats',
    label: 'Feats',
    load: () => loadSrd('feats'),
    sub: (f) => f.category + (f.prerequisite ? ` · ${f.prerequisite}` : ''),
    search: (f) => [f.name, f.category].join(' '),
    filters: [{ id: 'category', label: 'Type', options: (items) => [...new Set(items.map((f) => f.category))].map((c) => [c, c]), test: (f, v) => f.category === v }],
    detail: (f) => html`<h2>${f.name}</h2><p class="meta">${f.category}${f.prerequisite ? ` (Prerequisite: ${f.prerequisite})` : ''}</p>${md(f.description)}`,
  },
  {
    id: 'weapons',
    label: 'Weapons',
    load: async () => (await loadSrd('equipment')).weapons,
    sub: (w) => `${w.category} ${w.kind} · ${w.damageText}`,
    search: (w) => [w.name, w.category, w.kind, ...w.properties].join(' '),
    detail: (w) => html`<h2>${w.name}</h2><p class="meta">${w.category} ${w.kind} weapon</p>
      <dl class="facts"><dt>Damage</dt><dd>${w.damageText}</dd><dt>Properties</dt><dd>${w.properties.join(', ') || '—'}</dd>
      <dt>Mastery</dt><dd>${w.mastery}</dd><dt>Weight</dt><dd>${w.weight}</dd><dt>Cost</dt><dd>${w.cost}</dd></dl>`,
  },
  {
    id: 'armor',
    label: 'Armor',
    load: async () => (await loadSrd('equipment')).armor,
    sub: (a) => `${a.category} · AC ${a.armorClass}`,
    search: (a) => [a.name, a.category].join(' '),
    detail: (a) => html`<h2>${a.name}</h2><p class="meta">${a.category}</p>
      <dl class="facts"><dt>Armor Class</dt><dd>${a.armorClass}</dd><dt>Strength</dt><dd>${a.strength ?? '—'}</dd>
      <dt>Stealth</dt><dd>${a.stealthDisadvantage ? 'Disadvantage' : '—'}</dd><dt>Weight</dt><dd>${a.weight}</dd><dt>Cost</dt><dd>${a.cost}</dd></dl>`,
  },
  {
    id: 'gear',
    label: 'Gear',
    load: async () => (await loadSrd('equipment')).gear,
    sub: (g) => g.cost || '',
    search: (g) => g.name,
    detail: (g) => html`<h2>${g.name}</h2>${g.cost ? html`<p class="meta">${g.cost}</p>` : ''}${md(g.description)}`,
  },
  {
    id: 'glossary',
    label: 'Glossary',
    load: () => loadSrd('glossary'),
    sub: (g) => g.tag || '',
    search: (g) => [g.name, g.tag].join(' '),
    filters: [{ id: 'tag', label: 'Kind', options: (items) => [...new Set(items.map((g) => g.tag).filter(Boolean))].sort().map((t) => [t, t]), test: (g, v) => g.tag === v }],
    detail: (g) => html`<h2>${g.name}</h2>${g.tag ? html`<p class="meta">${g.tag}</p>` : ''}${md(g.description)}`,
  },
  {
    id: 'chapters',
    label: 'Rules Chapters',
    load: () => loadSrd('chapters'),
    sub: () => '',
    search: (c) => c.title,
    name: (c) => c.title,
    detail: (c) => html`<h2>${c.title}</h2>${md(c.markdown)}`,
  },
];

export async function renderRules(root, { params, navigate }) {
  const [catId, itemId] = params;
  const cat = CATEGORIES.find((c) => c.id === catId);
  if (!cat) {
    navigate('/rules/spells');
    return;
  }

  root.innerHTML = String(html`
    <section class="rules">
      <nav class="rules-tabs" aria-label="Rules categories">
        ${CATEGORIES.map((c) => html`<a href="#/rules/${c.id}" ${raw(c.id === cat.id ? 'aria-current="page"' : '')}>${c.label}</a>`)}
      </nav>
      <div class="rules-body ${itemId ? 'has-detail' : ''}">
        <aside class="rules-list">
          <div class="rules-controls">
            <input type="search" id="rules-search" placeholder="Search ${cat.label.toLowerCase()}…" aria-label="Search ${cat.label}" />
            <div class="filters"></div>
          </div>
          <p class="result-count muted" aria-live="polite"></p>
          <ul class="results"><li class="loading">Loading…</li></ul>
        </aside>
        <article class="rules-detail" tabindex="-1"><p class="muted">Pick something from the list.</p></article>
      </div>
    </section>`);

  const items = await cat.load();
  const nameOf = cat.name || ((x) => x.name);
  const searchInput = root.querySelector('#rules-search');
  const filtersEl = root.querySelector('.filters');
  const list = root.querySelector('.results');
  const count = root.querySelector('.result-count');
  const detail = root.querySelector('.rules-detail');

  // Remember search + filters per category for this visit.
  const memoryKey = `rules:${cat.id}`;
  const saved = JSON.parse(sessionStorage.getItem(memoryKey) || '{}');
  searchInput.value = saved.q || '';

  filtersEl.innerHTML = String(
    html`${(cat.filters || []).map(
      (f) => html`<label><span class="sr-only">${f.label}</span><select data-filter="${f.id}">
        <option value="">Any ${f.label === 'CR' ? f.label : f.label.toLowerCase()}</option>
        ${f.options(items).map(([v, label]) => html`<option value="${v}" ${raw(saved[f.id] === v ? 'selected' : '')}>${label}</option>`)}
      </select></label>`,
    )}`,
  );

  function refresh() {
    const q = searchInput.value.trim().toLowerCase();
    const active = {};
    for (const sel of filtersEl.querySelectorAll('select')) if (sel.value) active[sel.dataset.filter] = sel.value;
    sessionStorage.setItem(memoryKey, JSON.stringify({ q: searchInput.value, ...active }));
    const shown = items.filter(
      (it) =>
        (!q || cat.search(it).toLowerCase().includes(q)) &&
        Object.entries(active).every(([fid, v]) => cat.filters.find((f) => f.id === fid).test(it, v)),
    );
    count.textContent = `${shown.length} of ${items.length}`;
    list.innerHTML = String(
      html`${shown.map(
        (it) => html`<li><a href="#/rules/${cat.id}/${it.id}" ${raw(it.id === itemId ? 'aria-current="true"' : '')}>
          <span class="name">${nameOf(it)}</span><span class="sub">${cat.sub(it)}</span></a></li>`,
      )}`,
    ) || '<li class="muted">Nothing matches.</li>';
  }

  searchInput.addEventListener('input', debounce(refresh, 120));
  filtersEl.addEventListener('change', refresh);
  refresh();

  if (itemId) {
    const item = items.find((it) => it.id === itemId);
    detail.innerHTML = item
      ? String(html`<a class="back-link" href="#/rules/${cat.id}">← Back to ${cat.label}</a>${cat.detail(item)}`)
      : String(html`<p>Couldn't find that entry.</p>`);
    list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    if (window.matchMedia('(max-width: 800px)').matches) detail.focus();
  } else {
    searchInput.focus({ preventScroll: true });
  }
}
