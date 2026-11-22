import { html } from '../lib/dom.js';
import {
  getAuth, sendSignInEmail, verifyCode, isValidEmail, signInWithPassword, signUpWithPassword, MIN_PASSWORD,
} from '../lib/auth.js';

export function renderSignIn(root, { navigate }) {
  if (getAuth().session) {
    navigate('/account');
    return;
  }
  let email = sessionStorage.getItem('signInEmail') || '';
  // 'password' | 'email' (send a link) | 'code' (link sent, waiting)
  let stage = 'password';

  const methodTabs = () => html`
    <div class="segmented sign-in-method" role="tablist" aria-label="How to sign in">
      <button type="button" role="tab" data-method="password" aria-selected="${stage === 'password'}" class="${stage === 'password' ? 'selected' : ''}">Password</button>
      <button type="button" role="tab" data-method="email" aria-selected="${stage !== 'password'}" class="${stage !== 'password' ? 'selected' : ''}">Email link</button>
    </div>`;

  function draw(message = '', kind = '') {
    root.innerHTML = String(html`
      <section class="page narrow">
        <div class="card">
          <h1>Sign in</h1>
          ${methodTabs()}
          ${stage === 'password'
            ? html`
                <p>Sign in with your email and password. New here? Fill both in and press <strong>Create account</strong>.</p>
                <form id="password-form" novalidate>
                  <label for="email">Email</label>
                  <input id="email" name="email" type="email" autocomplete="email" required value="${email}" placeholder="you@example.com" />
                  <label for="password">Password</label>
                  <input id="password" name="password" type="password" autocomplete="current-password" required minlength="${MIN_PASSWORD}" />
                  <div class="row wrap">
                    <button type="submit" class="button" value="sign-in">Sign in</button>
                    <button type="submit" class="button secondary" value="sign-up">Create account</button>
                  </div>
                </form>
                <p class="muted small">Only used email links so far? Sign in with an email link once, then set a password in Account settings.</p>`
            : stage === 'email'
              ? html`
                  <p>Enter your email and we'll send you a sign-in link. No password needed. New here? This creates your account.</p>
                  <form id="email-form" novalidate>
                    <label for="email">Email</label>
                    <input id="email" name="email" type="email" autocomplete="email" required value="${email}" placeholder="you@example.com" />
                    <button type="submit" class="button">Email me a sign-in link</button>
                  </form>`
              : html`
                  <p>We sent an email to <strong>${email}</strong>.</p>
                  <ol class="steps">
                    <li>Open it and click <strong>the sign-in link</strong>. This page will sign you in.</li>
                    <li>Or type the <strong>6-digit code</strong> from the email here:</li>
                  </ol>
                  <form id="code-form" novalidate>
                    <label for="code">Code</label>
                    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" />
                    <button type="submit" class="button">Sign in with code</button>
                  </form>
                  <p class="muted">Didn't get it? Check your spam folder, or
                    <button type="button" class="link-button" id="resend">send another email</button>, or
                    <button type="button" class="link-button" id="change">use a different email</button>.</p>`}
          <p class="message ${kind}" role="status" aria-live="polite">${message}</p>
        </div>
      </section>`);

    root.querySelectorAll('[data-method]').forEach((b) =>
      b.addEventListener('click', () => {
        const input = root.querySelector('#email');
        if (input) email = input.value.trim();
        stage = b.dataset.method;
        draw();
      }),
    );
    root.querySelector('#password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const action = e.submitter?.value || 'sign-in';
      email = form.email.value.trim();
      const password = form.password.value;
      if (!isValidEmail(email)) return draw('Please enter a valid email address.', 'error');
      if (!password) return draw('Please enter your password.', 'error');
      sessionStorage.setItem('signInEmail', email);
      form.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        if (action === 'sign-up') {
          const { confirm } = await signUpWithPassword(email, password);
          if (confirm) draw(`Account created. We sent a confirmation email to ${email}: click the link in it, then sign in here.`, 'success');
          // Otherwise main.js notices the new session and moves on.
        } else {
          await signInWithPassword(email, password);
        }
      } catch (err) {
        draw(err.message, 'error');
      }
    });
    root.querySelector('#email-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = e.target.email.value;
      if (!isValidEmail(value)) return draw('Please enter a valid email address.', 'error');
      email = value.trim();
      await send(e.target.querySelector('button'));
    });
    root.querySelector('#code-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value.replace(/\s/g, '');
      if (!/^\d{6,10}$/.test(code)) return draw('The code is the 6-digit number in the email.', 'error');
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        await verifyCode(email, code);
        // main.js notices the new session and moves on.
      } catch (err) {
        draw(err.message, 'error');
      }
    });
    root.querySelector('#resend')?.addEventListener('click', (e) => send(e.target));
    root.querySelector('#change')?.addEventListener('click', () => {
      stage = 'email';
      draw();
    });
    const focusId = stage === 'code' ? '#code' : email && stage === 'password' ? '#password' : '#email';
    root.querySelector(focusId)?.focus();
  }

  async function send(button) {
    if (button) button.disabled = true;
    try {
      await sendSignInEmail(email);
      sessionStorage.setItem('signInEmail', email);
      stage = 'code';
      draw('Email sent.', 'success');
    } catch (err) {
      draw(err.message, 'error');
    }
  }

  draw();
}
