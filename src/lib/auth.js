// Sign-in and the signed-in player's profile.
//
// Two ways in:
//   - Email and password (no email is sent, so Supabase's email limit doesn't apply).
//   - An email with:
//   - a link that signs them in on that browser, and
//   - a 6-digit code they can type here instead (handy when the email is
//     opened on a different device, e.g. a phone).
import { supabase } from './supabase.js';

const listeners = new Set();
let state = { ready: false, session: null, profile: null };

export function getAuth() {
  return state;
}

/** Subscribe to auth changes. Returns an unsubscribe function. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export async function initAuth() {
  const { data } = await supabase.auth.getSession();
  await applySession(data.session);
  supabase.auth.onAuthStateChange((_event, session) => {
    // Defer so we never call Supabase from inside its own callback.
    setTimeout(() => applySession(session), 0);
  });
  // Remove ?code=... left over from a sign-in link.
  const url = new URL(window.location.href);
  if (url.searchParams.has('code') || url.searchParams.has('error_description')) {
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    url.searchParams.delete('error_code');
    url.searchParams.delete('error_description');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

async function applySession(session) {
  const sameUser = state.session?.user?.id === session?.user?.id;
  if (sameUser && state.ready) {
    setState({ session });
    return;
  }
  const profile = session ? await fetchProfile(session.user) : null;
  setState({ ready: true, session, profile });
}

async function fetchProfile(user) {
  const { data, error } = await supabase.from('profiles').select('id, display_name').eq('id', user.id).maybeSingle();
  if (error) {
    console.warn('Could not load profile (has the database setup SQL been run?)', error.message);
    return { id: user.id, display_name: defaultName(user.email), missingTable: true };
  }
  return data ?? { id: user.id, display_name: defaultName(user.email) };
}

function defaultName(email) {
  return (email || 'Adventurer').split('@')[0];
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Send the sign-in email. Works for new and returning players alike. */
export async function sendSignInEmail(email) {
  const redirect = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: redirect, shouldCreateUser: true },
  });
  if (error) throw friendlyError(error);
}

/** Sign in with the 6-digit code from the email. */
export async function verifyCode(email, code) {
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
  if (error) throw friendlyError(error);
}

export const MIN_PASSWORD = 8;

/** Sign in with email and password. */
export async function signInWithPassword(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw friendlyError(error);
}

/**
 * Create an account with email and password.
 * Returns { confirm: true } when Supabase wants the email confirmed first.
 */
export async function signUpWithPassword(email, password) {
  if (password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
  const redirect = window.location.origin + window.location.pathname;
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirect } });
  if (error) throw friendlyError(error);
  // Supabase hides "already registered" by returning a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
    throw new Error('There is already an account with that email. Sign in instead, or use an email link if it has no password yet.');
  return { confirm: !data.session };
}

/** Set or change the signed-in player's password. */
export async function setPassword(password) {
  if (password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw friendlyError(error);
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function updateDisplayName(name) {
  const user = state.session?.user;
  if (!user) throw new Error('You need to be signed in.');
  const display_name = name.trim().slice(0, 40);
  if (!display_name) throw new Error('Please enter a name.');
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, display_name }, { onConflict: 'id' })
    .select('id, display_name')
    .single();
  if (error) throw friendlyError(error);
  setState({ profile: data });
  return data;
}

function friendlyError(error) {
  const msg = error.message || String(error);
  if (/rate limit|too many|security purposes/i.test(msg))
    return new Error('Too many sign-in emails were sent recently. Please wait a minute and try again.');
  if (/invalid login credentials/i.test(msg))
    return new Error("That email and password don't match. If you've only ever used email links, sign in with a link once, then set a password in Account settings.");
  if (/email not confirmed/i.test(msg))
    return new Error('Please confirm your email first: open the email we sent and click the link.');
  if (/already registered/i.test(msg))
    return new Error('There is already an account with that email. Sign in instead.');
  if (/should be different/i.test(msg)) return new Error('That is already your password.');
  if (/weak|at least/i.test(msg) && /password/i.test(msg))
    return new Error(`That password is too weak. Use at least ${MIN_PASSWORD} characters, mixing letters and numbers.`);
  if (/expired|invalid/i.test(msg) && /token|otp|code/i.test(msg))
    return new Error('That code is wrong or has expired. Check the latest email, or send a new one.');
  return new Error(msg);
}
