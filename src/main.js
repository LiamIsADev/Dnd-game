import './styles.css';
import { initAuth, onAuthChange, getAuth, signOut } from './lib/auth.js';
import { html, esc } from './lib/dom.js';
import { renderHome } from './pages/home.js';
import { renderSignIn } from './pages/signin.js';
import { renderAccount } from './pages/account.js';
import { renderRules } from './pages/rules.js';
import { renderCredits } from './pages/credits.js';

const app = document.getElementById('app');
const authNav = document.getElementById('auth-nav');

// Routes are hash-based (#/rules/spells/fireball) so the site works on any
// static host without server rewrite rules.
const routes = [
  { pattern: /^\/$/, nav: 'home', render: renderHome },
  { pattern: /^\/sign-in$/, nav: 'account', render: renderSignIn },
  { pattern: /^\/account$/, nav: 'account', render: renderAccount, requiresAuth: true },
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
  try {
    cleanup = await match.r.render(app, { params: match.m.slice(1).map((p) => (p ? decodeURIComponent(p) : p)), navigate });
  } catch (err) {
    console.error(err);
    app.innerHTML = String(html`<section class="page narrow"><h1>Something went wrong</h1><p class="error">${err.message}</p></section>`);
  }
}

function highlightNav(nav) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.toggleAttribute('aria-current', a.dataset.nav === nav);
  }
}

function renderAuthNav({ session, profile }) {
  if (session) {
    authNav.innerHTML = `<a href="#/account" data-nav="account">${esc(profile?.display_name || 'Account')}</a>
      <button type="button" class="link-button" id="sign-out">Sign out</button>`;
    authNav.querySelector('#sign-out').addEventListener('click', async () => {
      await signOut();
      navigate('/');
    });
  } else {
    authNav.innerHTML = `<a href="#/sign-in" class="button small" data-nav="account">Sign in</a>`;
  }
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
