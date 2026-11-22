// Character library: every saved character, plus create / import / export.
import { html } from '../lib/dom.js';
import { loadCharacterRules } from '../lib/srd.js';
import { listCharacters, createCharacter, deleteCharacter, downloadCharacter, parseImport } from '../lib/character/store.js';
import { derive } from '../lib/character/rules.js';
import { confirmDialog, toast } from '../lib/ui.js';

/** One character as a card (used here and on the home screen). */
export function characterSummary(row, srd) {
  const d = derive(row.data, srd);
  const line = [d.species?.name, d.cls ? `${d.cls.name} ${d.level}` : null].filter(Boolean).join(' · ');
  return html`<article class="character-card" data-id="${row.id}">
    <a class="character-link" href="#/characters/${row.id}">
      <span class="avatar" aria-hidden="true">${(row.name || '?').trim().charAt(0).toUpperCase()}</span>
      <span>
        <strong>${row.name}</strong>
        <span class="muted">${line || 'Unfinished'}</span>
        <span class="mini-stats"><span>HP ${row.data.hp?.current ?? d.hpMax}/${d.hpMax}</span><span>AC ${d.ac}</span></span>
      </span>
    </a>
  </article>`;
}

export async function renderCharacters(root, { navigate }) {
  root.innerHTML = String(html`
    <section class="page">
      <div class="section-head">
        <h1 class="page-title">Characters</h1>
        <div class="actions">
          <label class="button secondary" for="import-file">Import from file</label>
          <input type="file" id="import-file" accept=".json,application/json" class="sr-only" />
          <a class="button" href="#/characters/new">Create a character</a>
        </div>
      </div>
      <p class="muted">Export a character to a file to keep a backup, or to bring it into another campaign or account.</p>
      <div id="list" class="library"><p class="loading">Loading…</p></div>
    </section>`);

  const list = root.querySelector('#list');
  let rows = [];
  let srd;

  async function load() {
    try {
      [rows, srd] = await Promise.all([listCharacters(), loadCharacterRules()]);
      draw();
    } catch (err) {
      list.innerHTML = String(html`<p class="message error">${err.message}</p>`);
    }
  }

  function draw() {
    if (!rows.length) {
      list.innerHTML = String(html`<div class="empty card">
        <p>No saved characters yet.</p>
        <a class="button" href="#/characters/new">Create your first character</a>
      </div>`);
      return;
    }
    list.innerHTML = String(
      html`${rows.map(
        (r) => html`<div class="library-row">
          ${characterSummary(r, srd)}
          <div class="row-actions">
            <a class="button small secondary" href="#/characters/${r.id}">Open sheet</a>
            <a class="button small secondary" href="#/characters/${r.id}/edit">Edit in builder</a>
            <button type="button" class="button small secondary" data-act="export" data-id="${r.id}">Export</button>
            <button type="button" class="button small secondary" data-act="copy" data-id="${r.id}">Duplicate</button>
            <button type="button" class="button small danger-outline" data-act="delete" data-id="${r.id}">Delete</button>
          </div>
        </div>`,
      )}`,
    );
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = rows.find((r) => r.id === btn.dataset.id);
    if (!row) return;
    if (btn.dataset.act === 'export') {
      downloadCharacter(row.data);
      toast(`Exported ${row.name}.`);
    } else if (btn.dataset.act === 'copy') {
      btn.disabled = true;
      try {
        const copy = await createCharacter({ ...structuredClone(row.data), name: `${row.name} (copy)`.slice(0, 80) });
        rows.unshift(copy);
        draw();
        toast(`Made a copy of ${row.name}.`, 'success');
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    } else if (btn.dataset.act === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${row.name}?`,
        message: 'This permanently deletes the character. Export it first if you might want it back.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteCharacter(row.id);
        rows = rows.filter((r) => r.id !== row.id);
        draw();
        toast(`Deleted ${row.name}.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  root.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1_000_000) return toast('That file is too big to be a character.', 'error');
    try {
      const character = parseImport(await file.text());
      const created = await createCharacter(character);
      toast(`Imported ${created.name}.`, 'success');
      navigate(`/characters/${created.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await load();
}
