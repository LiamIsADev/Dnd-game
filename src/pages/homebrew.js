// Homebrew: your library, the editor, and a campaign's homebrew switches.
//   #/homebrew                    your library (and items shared through campaigns)
//   #/homebrew/new/<kind>         make something new (or copy an existing entry)
//   #/homebrew/<id>               edit yours, or read one shared with you
//   #/homebrew/campaign/<id>      what a campaign uses; the DM switches items on
import { html, raw, debounce, rulesMarkdown } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';
import { loadSrd, loadCharacterRules } from '../lib/srd.js';
import { toast, confirmDialog } from '../lib/ui.js';
import { statBlock } from '../components/statblock.js';
import { homebrewForm, getPath, setPath, readInput, TEMPLATES } from '../components/homebrew-form.js';
import { KINDS, KIND_ORDER, blank, fromExisting, toForm } from '../lib/homebrew/kinds.js';
import { mergeHomebrew, entryFor } from '../lib/homebrew/merge.js';
import { listCampaigns, profileNames } from '../lib/campaign/store.js';
import { rulesDetail } from './rules.js';
import * as hb from '../lib/homebrew/store.js';

const RULES_CATEGORY = {
  monster: 'monsters', spell: 'spells', weapon: 'weapons', armor: 'armor', class: 'classes',
  species: 'species', background: 'backgrounds', feat: 'feats', 'magic-item': 'magic-items',
};

export async function renderHomebrew(root, { params, navigate }) {
  const [a, b] = params;
  if (a === 'new') return renderEditor(root, { kind: b, id: null, navigate });
  if (a === 'campaign') return renderCampaignHomebrew(root, { campaignId: b, navigate });
  if (a) return renderEditor(root, { kind: null, id: a, navigate });
  return renderLibrary(root, { navigate });
}

/* ================================================================ library */

async function renderLibrary(root, { navigate }) {
  const me = getAuth().session.user.id;
  root.innerHTML = String(html`
    <section class="page">
      <div class="section-head">
        <h1 class="page-title">Homebrew</h1>
        <div class="actions">
          <label class="button secondary" for="hb-import">Import from file</label>
          <input type="file" id="hb-import" accept=".json,application/json" class="sr-only" />
          <button type="button" class="button secondary" data-act="export-all">Export all</button>
        </div>
      </div>
      <p class="muted">Your homebrew is private until you add it to a campaign. The DM's homebrew is switched on straight away; a player's waits for the DM to switch it on. Monsters are only ever shown to the DM.</p>
      <h2>Make something new</h2>
      <div class="hb-new">${KIND_ORDER.map((k) => html`<a class="button small secondary" href="#/homebrew/new/${k}">${KINDS[k].label}</a>`)}</div>
      <div class="rules-controls hb-filter">
        <input type="search" id="hb-search" placeholder="Search your homebrew…" aria-label="Search your homebrew" />
        <select id="hb-kind" aria-label="Kind"><option value="">All kinds</option>${KIND_ORDER.map((k) => html`<option value="${k}">${KINDS[k].plural}</option>`)}</select>
      </div>
      <div id="hb-list" class="library"><p class="loading">Loading…</p></div>
      <div id="hb-shared"></div>
    </section>`);

  const list = root.querySelector('#hb-list');
  const shared = root.querySelector('#hb-shared');
  let rows = [];
  let others = [];
  let links = {};
  let campaigns = [];
  const filter = { q: '', kind: '' };

  async function load() {
    try {
      const [visible, camps] = await Promise.all([hb.listVisible(), listCampaigns(me).catch(() => [])]);
      rows = visible.filter((r) => r.owner_id === me);
      others = visible.filter((r) => r.owner_id !== me);
      campaigns = camps;
      links = await hb.myCampaignLinks(rows.map((r) => r.id));
      draw();
    } catch (err) {
      list.innerHTML = String(html`<p class="message error">${err.message}</p>`);
    }
  }

  const campName = (id) => campaigns.find((c) => c.id === id)?.name || 'a campaign';
  const matches = (r) => (!filter.kind || r.kind === filter.kind) && (!filter.q || r.name.toLowerCase().includes(filter.q));

  function draw() {
    const mine = rows.filter(matches);
    list.innerHTML = String(
      !rows.length
        ? html`<div class="empty card"><p>No homebrew yet. Pick a kind above to make your first, or import a file.</p></div>`
        : !mine.length
          ? html`<p class="muted">Nothing matches.</p>`
          : html`${mine.map((r) => {
              const inCamps = links[r.id] || [];
              const free = campaigns.filter((c) => !inCamps.some((l) => l.campaign_id === c.id));
              return html`<div class="library-row hb-row">
                <a class="hb-name" href="#/homebrew/${r.id}"><strong>${r.name}</strong> <span class="tag">${KINDS[r.kind]?.label || r.kind}</span>
                  <span class="muted small">${inCamps.length ? inCamps.map((l) => `${campName(l.campaign_id)}${l.enabled ? '' : ' (waiting for the DM)'}`).join(' · ') : 'Not in any campaign'}</span></a>
                <div class="row-actions">
                  <a class="button small secondary" href="#/homebrew/${r.id}">Edit</a>
                  ${free.length
                    ? html`<select class="small-select" data-act="add" data-id="${r.id}" aria-label="Add ${r.name} to a campaign"><option value="">Add to campaign…</option>${free.map((c) => html`<option value="${c.id}">${c.name}${c.role === 'dm' ? ' (DM)' : ''}</option>`)}</select>`
                    : ''}
                  <button type="button" class="button small secondary" data-act="copy" data-id="${r.id}">Duplicate</button>
                  <button type="button" class="button small secondary" data-act="export" data-id="${r.id}">Export</button>
                  <button type="button" class="button small danger-outline" data-act="delete" data-id="${r.id}">Delete</button>
                </div>
              </div>`;
            })}`,
    );
    const theirs = others.filter(matches);
    shared.innerHTML = String(
      theirs.length
        ? html`<h2>From your campaigns</h2><p class="muted">Homebrew other people switched on in campaigns you're in. Copy it to make your own version.</p>
          <div class="library">${theirs.map(
            (r) => html`<div class="library-row hb-row"><a class="hb-name" href="#/homebrew/${r.id}"><strong>${r.name}</strong> <span class="tag">${KINDS[r.kind]?.label || r.kind}</span></a>
              <div class="row-actions"><a class="button small secondary" href="#/homebrew/${r.id}">View</a>
              <button type="button" class="button small secondary" data-act="copy" data-id="${r.id}">Copy to my library</button></div></div>`,
          )}</div>`
        : '',
    );
  }

  const find = (id) => rows.find((r) => r.id === id) || others.find((r) => r.id === id);

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'export-all') {
      if (!rows.length) return toast('You have no homebrew to export yet.');
      hb.downloadHomebrew(rows);
      return toast(`Exported ${rows.length} item${rows.length === 1 ? '' : 's'}.`);
    }
    const row = find(btn.dataset.id);
    if (!row) return;
    if (btn.dataset.act === 'export') {
      hb.downloadHomebrew([row]);
      toast(`Exported ${row.name}.`);
    } else if (btn.dataset.act === 'copy') {
      btn.disabled = true;
      try {
        const name = row.owner_id === me ? `${row.name} (copy)` : row.name;
        const copy = await hb.createHomebrew(row.kind, { ...structuredClone(row.data), name: name.slice(0, 120) });
        rows.push(copy);
        rows.sort((x, y) => x.name.localeCompare(y.name));
        draw();
        toast(`Copied ${row.name} to your library.`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      btn.disabled = false;
    } else if (btn.dataset.act === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${row.name}?`,
        message: 'This deletes it for good and takes it out of every campaign using it. Characters that use it will lose it. Export it first if you might want it back.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await hb.deleteHomebrew(row.id);
        rows = rows.filter((r) => r.id !== row.id);
        draw();
        toast(`Deleted ${row.name}.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  root.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-act="add"]');
    if (!sel || !sel.value) return;
    const row = find(sel.dataset.id);
    const cid = sel.value;
    sel.disabled = true;
    try {
      const on = await hb.addToCampaign(cid, row.id);
      toast(on ? `${row.name} is now on in ${campName(cid)}.` : `Added ${row.name} to ${campName(cid)}. It's waiting for the DM to switch it on.`, 'success');
      links = await hb.myCampaignLinks(rows.map((r) => r.id));
      draw();
    } catch (err) {
      toast(err.message, 'error');
      sel.disabled = false;
      sel.value = '';
    }
  });

  root.querySelector('#hb-search').addEventListener(
    'input',
    debounce((e) => {
      filter.q = e.target.value.trim().toLowerCase();
      draw();
    }),
  );
  root.querySelector('#hb-kind').addEventListener('change', (e) => {
    filter.kind = e.target.value;
    draw();
  });

  root.querySelector('#hb-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5_000_000) return toast('That file is too big to be a homebrew file.', 'error');
    try {
      const items = hb.parseImport(await file.text());
      const saved = await hb.importItems(items);
      toast(`Imported ${saved.length} item${saved.length === 1 ? '' : 's'}.`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await load();
}

/* ================================================================= editor */

/** Built-in and visible homebrew entries of a kind, for "Start from an existing…". */
function existingOf(kind, data) {
  if (kind === 'subclass') return data.classes.flatMap((c) => c.subclasses.map((s) => ({ ...s, classId: s.classId || c.id, label: `${s.name} (${c.name})` })));
  if (kind === 'weapon') return data.equipment.weapons.filter((w) => !w.magic || w.source === 'homebrew');
  if (kind === 'armor') return data.equipment.armor;
  return data[KINDS[kind].dataset] || [];
}

async function loadEditorData(kind, rows) {
  const base = await loadCharacterRules();
  const extra = {};
  if (kind === 'monster') extra.monsters = await loadSrd('monsters');
  if (kind === 'magic-item') extra['magic-items'] = await loadSrd('magic-items');
  return mergeHomebrew({ ...base, ...extra }, rows);
}

async function renderEditor(root, { kind, id, navigate }) {
  const me = getAuth().session.user.id;
  root.innerHTML = '<p class="loading">Loading…</p>';
  let row = null;
  if (id) {
    row = await hb.getHomebrew(id);
    if (!row) {
      root.innerHTML = String(html`<section class="page narrow"><div class="card"><h1>Homebrew not found</h1>
        <p>It was deleted, or it isn't shared with you.</p><p><a class="button" href="#/homebrew">Back to homebrew</a></p></div></section>`);
      return;
    }
    kind = row.kind;
  }
  if (!KINDS[kind]) return navigate('/homebrew');
  const mine = !row || row.owner_id === me;
  const visible = await hb.homebrewRows();
  const data = await loadEditorData(kind, visible.filter((r) => r.id !== row?.id));
  const K = KINDS[kind];

  const builtInClasses = data.classes.filter((c) => c.source !== 'homebrew');
  const ctx = {
    classNames: data.classes.map((c) => c.name),
    builtInClassNames: builtInClasses.map((c) => c.name),
    classOptions: data.classes.map((c) => [c.id, c.source === 'homebrew' ? `${c.name} (homebrew)` : c.name]),
    originFeats: data.feats.filter((f) => /origin/i.test(f.category)).map((f) => f.name),
    weaponOptions: data.equipment.weapons.filter((w) => !w.magic).map((w) => [w.id, w.name]),
  };

  let form = toForm(kind, row ? row.data : blank(kind, data));
  let savedJson = JSON.stringify(form);
  const finalized = () => K.finalize(structuredClone(form), data);

  if (!mine) {
    const item = entryFor(row);
    root.innerHTML = String(html`<section class="page">
      <p><a class="back-link" href="#/homebrew">← Homebrew</a></p>
      <div class="section-head"><h1 class="page-title">${row.name}</h1>
        <div class="actions"><button type="button" class="button" data-act="copy">Copy to my library</button></div></div>
      <p class="muted">${K.label} shared with you through a campaign. Copy it to make your own version.</p>
      <div class="card hb-preview">${preview(kind, item, data)}</div></section>`);
    root.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        const copy = await hb.createHomebrew(kind, structuredClone(row.data));
        toast(`Copied ${row.name} to your library.`, 'success');
        navigate(`/homebrew/${copy.id}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return;
  }

  const existing = existingOf(kind, data);
  root.innerHTML = String(html`
    <section class="page hb-editor">
      <p><a class="back-link" href="#/homebrew">← Homebrew</a></p>
      <div class="section-head">
        <h1 class="page-title">${row ? `Edit ${K.label.toLowerCase()}` : `New ${K.label.toLowerCase()}`}</h1>
        <div class="actions">
          <span class="save-state muted" aria-live="polite"></span>
          <button type="button" class="button" data-act="save">${row ? 'Save' : 'Create'}</button>
        </div>
      </div>
      <div class="hb-copy card">
        <label for="hb-from">Start from an existing ${K.label.toLowerCase()}<span class="hint">Copies it into this form so you can change it. Your homebrew never changes the original.</span></label>
        <div class="row"><input id="hb-from" list="hb-from-list" placeholder="Type a name…" autocomplete="off" />
          <button type="button" class="button secondary" data-act="from">Copy</button></div>
        <datalist id="hb-from-list">${existing.map((x) => html`<option value="${x.label || x.name}">${x.sourceName && x.source !== 'srd' ? x.sourceName : 'SRD'}</option>`)}</datalist>
      </div>
      <div class="hb-layout">
        <form class="hb-form" novalidate></form>
        <aside class="hb-side"><h2>Preview</h2><div class="card hb-preview"></div></aside>
      </div>
    </section>`);

  const formEl = root.querySelector('.hb-form');
  const previewEl = root.querySelector('.hb-preview');
  const state = root.querySelector('.save-state');

  function drawForm() {
    const y = window.scrollY;
    formEl.innerHTML = String(homebrewForm(kind, form, ctx));
    window.scrollTo(0, y);
    drawPreview();
  }
  const drawPreview = () => {
    try {
      previewEl.innerHTML = String(preview(kind, { ...finalized(), id: 'preview', source: 'homebrew', sourceName: 'Homebrew' }, data));
    } catch (err) {
      console.error(err);
      previewEl.innerHTML = String(html`<p class="error">Can't preview this yet: ${err.message}</p>`);
    }
    state.textContent = JSON.stringify(form) === savedJson ? '' : 'Unsaved changes';
  };
  const previewSoon = debounce(drawPreview, 250);

  formEl.addEventListener('input', (e) => {
    const el = e.target.closest('[data-path]');
    if (!el || el.dataset.type === 'multi') return;
    setPath(form, el.dataset.path, readInput(el, form));
    previewSoon();
  });
  formEl.addEventListener('change', (e) => {
    const el = e.target.closest('[data-path]');
    if (!el) return;
    if (el.dataset.type === 'multi') {
      const box = el.closest('[data-multi]');
      const next = readInput(el, form);
      const max = Number(box.dataset.max) || 0;
      if (max && next.length > max) {
        el.checked = false;
        return toast(`Pick up to ${max}.`);
      }
      setPath(form, el.dataset.path, next);
    } else setPath(form, el.dataset.path, readInput(el, form));
    if (el.hasAttribute('data-rerender')) drawForm();
    else drawPreview();
  });
  formEl.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    const remove = e.target.closest('[data-remove]');
    const move = e.target.closest('[data-move]');
    if (add) {
      const list = getPath(form, add.dataset.add) || [];
      setPath(form, add.dataset.add, [...list, (TEMPLATES[add.dataset.template] || (() => ({ name: '', text: '' })))()]);
      drawForm();
    } else if (remove) {
      const path = remove.dataset.remove.split('.');
      const i = Number(path.pop());
      const list = getPath(form, path.join('.'));
      list.splice(i, 1);
      drawForm();
    } else if (move) {
      const path = move.dataset.move.split('.');
      const i = Number(path.pop());
      const list = getPath(form, path.join('.'));
      const j = i + Number(move.dataset.dir);
      [list[i], list[j]] = [list[j], list[i]];
      drawForm();
    }
  });

  root.querySelector('[data-act="from"]').addEventListener('click', async () => {
    const name = root.querySelector('#hb-from').value.trim().toLowerCase();
    const item = existing.find((x) => (x.label || x.name).toLowerCase() === name) || existing.find((x) => x.name.toLowerCase() === name);
    if (!item) return toast(`Pick a ${K.label.toLowerCase()} from the list.`, 'error');
    if (JSON.stringify(form) !== savedJson) {
      const ok = await confirmDialog({ title: `Copy ${item.name}?`, message: 'This replaces what is in the form now.', confirmLabel: 'Copy' });
      if (!ok) return;
    }
    form = toForm(kind, fromExisting(kind, item, data));
    if (item.source !== 'homebrew') form.name = `${item.name}`;
    drawForm();
    toast(`Copied ${item.name}. Change anything you like, then ${row ? 'save' : 'create'} it.`);
  });

  const saveBtn = root.querySelector('[data-act="save"]');
  saveBtn.addEventListener('click', async () => {
    const item = finalized();
    if (!item.name) return toast('Give it a name first.', 'error');
    if (kind === 'subclass' && !data.classes.some((c) => c.id === item.classId)) return toast('Pick the class this subclass belongs to.', 'error');
    saveBtn.disabled = true;
    try {
      if (row) {
        row = await hb.saveHomebrew(row.id, item);
        savedJson = JSON.stringify(form);
        state.textContent = 'Saved';
        toast(`Saved ${item.name}.`, 'success');
      } else {
        const created = await hb.createHomebrew(kind, item);
        savedJson = JSON.stringify(form);
        toast(`Created ${item.name}. Add it to a campaign from your homebrew list.`, 'success');
        navigate(`/homebrew/${created.id}`);
        return;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    saveBtn.disabled = false;
  });

  drawForm();
  savedJson = JSON.stringify(form); // drawing fills in the defaults the selects show
  state.textContent = '';
  const warn = (e) => {
    if (JSON.stringify(form) !== savedJson) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}

/** How the item will look in the rules browser. */
function preview(kind, item, data) {
  if (kind === 'monster') return statBlock(item);
  if (kind === 'subclass') {
    const cls = data.classes.find((c) => c.id === item.classId);
    return html`<h2>${item.name || 'Unnamed subclass'}</h2><p class="meta">${cls ? `${cls.name} subclass` : 'Pick a class'}${item.tagline ? ` · ${item.tagline}` : ''}</p>
      ${rulesDetailText(item.description)}
      ${item.features.map((f) => html`<details open><summary>Level ${f.level}: ${f.name}</summary>${rulesDetailText(f.description)}</details>`)}`;
  }
  return rulesDetail(RULES_CATEGORY[kind], item);
}

const rulesDetailText = (t) => raw(rulesMarkdown(t));

/* ======================================================= campaign switches */

async function renderCampaignHomebrew(root, { campaignId }) {
  const me = getAuth().session.user.id;
  root.innerHTML = '<p class="loading">Loading…</p>';
  const { data: campaign } = await supabase.from('campaigns').select('id, name, dm_id').eq('id', campaignId).maybeSingle();
  if (!campaign) {
    root.innerHTML = String(html`<section class="page narrow"><div class="card"><h1>Campaign not found</h1>
      <p>This campaign doesn't exist, or you aren't in it.</p><p><a class="button" href="#/campaigns">Back to campaigns</a></p></div></section>`);
    return;
  }
  const isDm = campaign.dm_id === me;
  root.innerHTML = String(html`
    <section class="page">
      <p><a class="back-link" href="#/campaigns/${campaign.id}">← Back to the table</a></p>
      <h1 class="page-title">Homebrew in ${campaign.name}</h1>
      <p class="muted">${isDm
        ? 'You decide what this campaign uses. Your own homebrew is on as soon as you add it. Players can add theirs, and it waits here until you switch it on. Only you see monsters.'
        : 'Add your homebrew to this campaign and the DM can switch it on. Once it is on, everyone in the campaign can use it.'}</p>
      <div class="card hb-add">
        <label for="hb-add">Add from your library</label>
        <div class="row"><select id="hb-add"><option value="">Loading…</option></select>
        <button type="button" class="button" data-act="add">Add</button></div>
        <p class="hint"><a href="#/homebrew">Open your homebrew library</a> to make something new.</p>
      </div>
      <div id="hb-campaign"><p class="loading">Loading…</p></div>
    </section>`);

  const host = root.querySelector('#hb-campaign');
  const addSel = root.querySelector('#hb-add');
  let entries = [];
  let mine = [];
  let names = {};

  async function load() {
    try {
      [entries, mine] = await Promise.all([hb.campaignHomebrew(campaign.id), hb.listMine(me)]);
      names = await profileNames([...new Set(entries.map((e) => e.added_by))]);
      draw();
    } catch (err) {
      host.innerHTML = String(html`<p class="message error">${err.message}</p>`);
    }
  }

  function draw() {
    const here = new Set(entries.map((e) => e.homebrew_id));
    const free = mine.filter((r) => !here.has(r.id));
    addSel.innerHTML = String(
      free.length
        ? html`<option value="">Choose…</option>${KIND_ORDER.map((k) => {
            const list = free.filter((r) => r.kind === k);
            return list.length ? html`<optgroup label="${KINDS[k].plural}">${list.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</optgroup>` : '';
          })}`
        : html`<option value="">${mine.length ? 'All your homebrew is already here' : 'You have no homebrew yet'}</option>`,
    );
    const readable = entries.filter((e) => e.item);
    const pending = readable.filter((e) => !e.enabled);
    const on = readable.filter((e) => e.enabled);
    const who = (e) => (e.added_by === me ? 'you' : names[e.added_by] || 'a player');
    const rowHtml = (e) => {
      const canRemove = isDm || e.added_by === me;
      return html`<div class="library-row hb-row">
        <a class="hb-name" href="#/homebrew/${e.homebrew_id}"><strong>${e.item.name}</strong> <span class="tag">${KINDS[e.item.kind]?.label || e.item.kind}</span>
          <span class="muted small">Added by ${who(e)}${e.item.kind === 'monster' ? ' · only the DM sees monsters' : ''}</span></a>
        <div class="row-actions">
          ${isDm ? html`<button type="button" class="button small ${e.enabled ? 'secondary' : ''}" data-act="toggle" data-id="${e.homebrew_id}">${e.enabled ? 'Switch off' : 'Switch on'}</button>` : html`<span class="badge">${e.enabled ? 'On' : 'Waiting for the DM'}</span>`}
          ${canRemove ? html`<button type="button" class="button small danger-outline" data-act="remove" data-id="${e.homebrew_id}">Take out</button>` : ''}
        </div></div>`;
    };
    host.innerHTML = String(html`
      ${isDm ? html`<h2>Waiting for you (${pending.length})</h2>${pending.length ? html`<div class="library">${pending.map(rowHtml)}</div>` : html`<p class="muted">Nothing waiting.</p>`}` : ''}
      ${!isDm && pending.length ? html`<h2>Waiting for the DM</h2><div class="library">${pending.map(rowHtml)}</div>` : ''}
      <h2>Switched on (${on.length})</h2>
      ${on.length ? html`<div class="library">${on.map(rowHtml)}</div>` : html`<p class="muted">No homebrew is on in this campaign yet.</p>`}`);
  }

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'add') {
        if (!addSel.value) return toast('Pick something from your library first.');
        const item = mine.find((r) => r.id === addSel.value);
        const enabled = await hb.addToCampaign(campaign.id, addSel.value);
        toast(enabled ? `${item.name} is on.` : `Added ${item.name}. It's waiting for the DM.`, 'success');
      } else if (btn.dataset.act === 'toggle') {
        const entry = entries.find((x) => x.homebrew_id === btn.dataset.id);
        await hb.setEnabled(campaign.id, entry.homebrew_id, !entry.enabled);
        toast(`${entry.item.name} is ${entry.enabled ? 'off' : 'on'}.`);
      } else if (btn.dataset.act === 'remove') {
        const entry = entries.find((x) => x.homebrew_id === btn.dataset.id);
        const ok = await confirmDialog({ title: `Take ${entry.item.name} out?`, message: 'It stays in its owner\'s library. Characters in this campaign that use it lose it here.', confirmLabel: 'Take out' });
        if (!ok) return;
        await hb.removeFromCampaign(campaign.id, entry.homebrew_id);
      }
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  await load();
}
