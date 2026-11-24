import { html } from '../lib/dom.js';
import { getAuth } from '../lib/auth.js';
import { loadSrd, loadOpen5eIndex } from '../lib/srd.js';
import { joinForm, wireJoin } from './campaigns.js';

export async function renderHome(root, ctx) {
  const { session } = getAuth();
  return session ? renderDashboard(root, ctx.navigate) : renderWelcome(root);
}

/* Signed in: the home screen with the three main areas. */
async function renderDashboard(root, navigate) {
  const { profile } = getAuth();
  root.innerHTML = String(html`
    <section class="home-hero">
      <h1 class="home-welcome">Welcome, ${profile?.display_name || 'adventurer'}</h1>
      <div class="home-menu">
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
        <div class="home-join">${joinForm()}</div>
      </div>
    </section>`);

  wireJoin(root, navigate);
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
    const c = { ...(await loadSrd('index')).counts };
    // Include the Open5e additions in the totals.
    const extra = await loadOpen5eIndex();
    if (extra?.counts) {
      c.spells += extra.counts.spells || 0;
      c.monsters += extra.counts.monsters || 0;
      c.feats += extra.counts.feats || 0;
      c['magic-items'] += extra.counts.magicItems || 0;
    }
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
