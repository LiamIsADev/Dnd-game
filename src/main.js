import './styles.css';
import { initAuth, onAuthChange, getAuth, signOut } from './lib/auth.js';
import { html } from './lib/dom.js';
import { renderHome } from './pages/home.js';
import { renderSignIn } from './pages/signin.js';
import { renderAccount } from './pages/account.js';
import { renderRules } from './pages/rules.js';
import { renderCredits } from './pages/credits.js';
import { renderCharacters } from './pages/characters.js';
import { renderBuilder } from './pages/builder.js';
import { renderSheet } from './pages/sheet.js';
import { renderCampaigns, renderJoin } from './pages/campaigns.js';
import { renderTable } from './pages/table.js';
import { renderHomebrew } from './pages/homebrew.js';

const app = document.getElementById('app');
const siteNav = document.getElementById('site-nav');

// Routes are hash-based (#/rules/spells/fireball) so the site works on any
// static host without server rewrite rules.
const routes = [
  { pattern: /^\/$/, nav: 'home', render: renderHome },
  { pattern: /^\/sign-in$/, nav: 'account', render: renderSignIn },
  { pattern: /^\/account$/, nav: 'account', render: renderAccount, requiresAuth: true },
  { pattern: /^\/characters$/, nav: 'characters', render: renderCharacters, requiresAuth: true },
  { pattern: /^\/characters\/new$/, nav: 'characters', render: renderBuilder, requiresAuth: true },
  { pattern: /^\/characters\/([^/]+)\/edit$/, nav: 'characters', render: renderBuilder, requiresAuth: true },
  { pattern: /^\/characters\/([^/]+)$/, nav: 'characters', render: renderSheet, requiresAuth: true },
  { pattern: /^\/campaigns$/, nav: 'campaigns', render: renderCampaigns, requiresAuth: true },
  { pattern: /^\/campaigns\/([^/]+)$/, nav: 'campaigns', render: renderTable, requiresAuth: true, wide: true },
  { pattern: /^\/join\/([^/]+)$/, nav: 'campaigns', render: renderJoin, requiresAuth: true },
  { pattern: /^\/homebrew(?:\/([^/]+))?(?:\/([^/]+))?$/, nav: 'homebrew', render: renderHomebrew, requiresAuth: true },
  { pattern: /^\/rules(?:\/([^/]+))?(?:\/([^/]+))?$/, nav: 'rules', render: renderRules },
  { pattern: /^\/credits$/, nav: 'credits', render: renderCredits },
];

let cleanup = null;

function currentPath() {
  const h = window.location.hash;
  return h.startsWith('#/') ? decodeURI(h.slice(1)).split('?')[0] : '/';
}

export function navigate(path) {
  window.location.hash = '#' + path;
}

async function route() {
  const path = currentPath();
  const match = routes.map((r) => ({ r, m: path.match(r.pattern) })).find((x) => x.m);
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  highlightNav(match?.r.nav);
  if (!match) {
    app.innerHTML = String(html`<section class="page narrow"><h1>Page not found</h1><p><a href="#/">Go home</a></p></section>`);
    return;
  }
  if (match.r.requiresAuth && !getAuth().session) {
    sessionStorage.setItem('afterSignIn', path);
    navigate('/sign-in');
    return;
  }
  // Each page gets a fresh element, so event listeners never pile up between pages.
  const view = document.createElement('div');
  view.className = match.r.wide ? 'view wide' : 'view';
  app.replaceChildren(view);
  try {
    cleanup = await match.r.render(view, { params: match.m.slice(1).map((p) => (p ? decodeURIComponent(p) : p)), navigate });
  } catch (err) {
    console.error(err);
    view.innerHTML = String(html`<section class="page narrow"><h1>Something went wrong</h1><p class="error">${err.message}</p></section>`);
  }
}

function highlightNav(nav) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.toggleAttribute('aria-current', a.dataset.nav === nav);
  }
}

function renderAuthNav({ session }) {
  // The main bar: Characters, Campaigns and Account settings once signed in.
  siteNav.innerHTML = session
    ? `<a href="#/" data-nav="home">Home</a>
       <a href="#/characters" data-nav="characters">Characters</a>
       <a href="#/campaigns" data-nav="campaigns">Campaigns</a>
       <a href="#/homebrew" data-nav="homebrew">Homebrew</a>
       <a href="#/rules" data-nav="rules">Rules</a>
       <a href="#/account" data-nav="account">Account settings</a>
       <button type="button" class="link-button" id="sign-out">Sign out</button>`
    : `<a href="#/" data-nav="home">Home</a>
       <a href="#/rules" data-nav="rules">Rules</a>
       <a href="#/sign-in" class="button small" data-nav="account">Sign in</a>`;
  siteNav.querySelector('#sign-out')?.addEventListener('click', async () => {
    await signOut();
    navigate('/');
  });
  highlightNav(routes.find((r) => currentPath().match(r.pattern))?.nav);
}

async function start() {
  app.innerHTML = '<p class="loading">Loading…</p>';
  await initAuth();
  let wasSignedIn = !!getAuth().session;
  renderAuthNav(getAuth());
  onAuthChange((state) => {
    renderAuthNav(state);
    const signedIn = !!state.session;
    if (signedIn !== wasSignedIn) {
      wasSignedIn = signedIn;
      if (signedIn && currentPath() === '/sign-in') {
        const next = sessionStorage.getItem('afterSignIn') || '/';
        sessionStorage.removeItem('afterSignIn');
        navigate(next);
      } else route();
    }
  });
  window.addEventListener('hashchange', route);
  route();
}

start();
