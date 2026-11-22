import { html } from '../lib/dom.js';
import { getAuth, sendSignInEmail, verifyCode, isValidEmail } from '../lib/auth.js';

export function renderSignIn(root, { navigate }) {
  if (getAuth().session) {
    navigate('/account');
    return;
  }
  let email = sessionStorage.getItem('signInEmail') || '';
  let stage = 'email';

  function draw(message = '', kind = '') {
    root.innerHTML = String(html`
      <section class="page narrow">
        <div class="card">
          <h1>Sign in</h1>
          ${stage === 'email'
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
    root.querySelector(stage === 'email' ? '#email' : '#code')?.focus();
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
