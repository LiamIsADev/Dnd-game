import { html } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { loadSrd, loadCharacterRules } from '../lib/srd.js';
import { listCharacters } from '../lib/character/store.js';
import { characterSummary } from './characters.js';
import { joinForm, wireJoin } from './campaigns.js';

export async function renderHome(root, ctx) {
  const { session } = getAuth();
  return session ? renderDashboard(root, ctx.navigate) : renderWelcome(root);
}

/* Signed in: the home screen with the three main areas. */
async function renderDashboard(root, navigate) {
  const { profile } = getAuth();
  root.innerHTML = String(html`
    <section class="page">
      <h1 class="page-title">Welcome, ${profile?.display_name || 'adventurer'}</h1>
      <div class="home-grid">
        <a class="home-card characters" href="#/characters">
          <span class="home-icon" aria-hidden="true">⚔</span>
          <h2>Characters</h2>
          <p>Create new heroes, open their sheets, and manage your saved characters.</p>
        </a>
        <a class="home-card campaigns" href="#/campaigns">
          <span class="home-icon" aria-hidden="true">🗺</span>
          <h2>Campaigns</h2>
          <p>Run a campaign as the DM, or play in one with your party.</p>
        </a>
        <a class="home-card account" href="#/account">
          <span class="home-icon" aria-hidden="true">⚙</span>
          <h2>Account settings</h2>
          <p>Change the name your party sees.</p>
        </a>
      </div>

      <div class="home-join">${joinForm()}</div>

      <div class="section-head">
        <h2>Your characters</h2>
        <a class="button" href="#/characters/new">Create a character</a>
      </div>
      <div id="recent" class="character-grid"><p class="loading">Loading…</p></div>
    </section>`);

  wireJoin(root, navigate);
  const recent = root.querySelector('#recent');
  try {
    const [rows, srd] = await Promise.all([listCharacters(), loadCharacterRules()]);
    if (!rows.length) {
      recent.innerHTML = String(html`<div class="empty card">
        <p>You don't have any characters yet.</p>
        <a class="button" href="#/characters/new">Create your first character</a>
      </div>`);
      return;
    }
    recent.innerHTML = String(
      html`${rows.slice(0, 3).map((r) => characterSummary(r, srd))}
        ${rows.length > 3 ? html`<a class="character-card more" href="#/characters">See all ${rows.length} characters →</a>` : ''}`,
    );
  } catch (err) {
    recent.innerHTML = String(html`<p class="message error">${err.message}</p>`);
  }
}

/* Signed out: a short introduction. */
async function renderWelcome(root) {
  root.innerHTML = String(html`
    <section class="hero">
      <h1>Run your Fifth Edition campaigns online</h1>
      <p class="lead">Build characters, gather your party, and play live on a shared battle map. The site rolls the dice and keeps track of everything, and the Dungeon Master's secrets stay secret.</p>
      <div class="hero-actions">
        <a class="button" href="#/sign-in">Sign in with email</a>
        <a class="button secondary" href="#/rules">Browse the rules</a>
      </div>
    </section>
    <section class="page">
      <div class="tiles" id="counts"></div>
    </section>`);

  try {
    const c = (await loadSrd('index')).counts;
    const tiles = [
      ['Spells', c.spells, 'spells'],
      ['Monsters & animals', c.monsters, 'monsters'],
      ['Magic items', c['magic-items'], 'magic-items'],
      ['Classes', c.classes, 'classes'],
      ['Species', c.species, 'species'],
      ['Feats', c.feats, 'feats'],
    ];
    root.querySelector('#counts').innerHTML = String(
      html`${tiles.map(([label, n, id]) => html`<a class="tile" href="#/rules/${id}"><span class="tile-n">${n}</span><span>${label}</span></a>`)}`,
    );
  } catch {
    // Counts are a nice-to-have; ignore failures.
  }
}
