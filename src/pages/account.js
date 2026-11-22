import { html } from '../lib/dom.js';
import { getAuth, updateDisplayName, setPassword, MIN_PASSWORD } from '../lib/auth.js';

export function renderAccount(root) {
  const { session, profile } = getAuth();

  root.innerHTML = String(html`
    <section class="page narrow">
      <div class="card">
        <h1>Account settings</h1>
        <p class="muted">Signed in as ${session.user.email}</p>
        ${profile?.missingTable
          ? html`<p class="message error">The database isn't set up yet, so your name can't be saved. Run <code>supabase/migrations/0001_profiles.sql</code> in the Supabase SQL editor.</p>`
          : ''}
        <form id="name-form">
          <label for="display-name">Display name</label>
          <p class="hint">This is the name your party and Dungeon Master will see.</p>
          <input id="display-name" name="name" maxlength="40" required value="${profile?.display_name || ''}" />
          <button type="submit" class="button">Save</button>
        </form>
        <p class="message" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Password</h2>
        <p class="hint">Set a password so you can sign in without waiting for an email. You can still use email links too.</p>
        <form id="password-form">
          <input type="email" name="username" autocomplete="username" value="${session.user.email}" hidden />
          <label for="new-password">New password</label>
          <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required />
          <label for="confirm-password">Type it again</label>
          <input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required />
          <button type="submit" class="button">Save password</button>
        </form>
        <p class="message" id="password-status" role="status" aria-live="polite"></p>
      </div>
    </section>`);

  const pwForm = root.querySelector('#password-form');
  const pwStatus = root.querySelector('#password-status');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const show = (text, kind = '') => {
      pwStatus.className = `message ${kind}`;
      pwStatus.textContent = text;
    };
    if (pwForm.password.value !== pwForm.confirm.value) return show("The two passwords don't match.", 'error');
    const btn = pwForm.querySelector('button');
    btn.disabled = true;
    show('Saving…');
    try {
      await setPassword(pwForm.password.value);
      pwForm.reset();
      show('Password saved. Next time, choose Password on the sign-in page.', 'success');
    } catch (err) {
      show(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  const form = root.querySelector('#name-form');
  const status = root.querySelector('#name-form + .message');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    status.className = 'message';
    status.textContent = 'Saving…';
    try {
      await updateDisplayName(form.name.value);
      status.className = 'message success';
      status.textContent = 'Saved.';
    } catch (err) {
      status.className = 'message error';
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
