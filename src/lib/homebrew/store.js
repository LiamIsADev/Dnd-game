// Homebrew in Supabase (tables: public.homebrew, public.campaign_homebrew).
// The database decides who can read what: your own items always, and items
// switched on in your campaigns (monsters only for the DM).
import { supabase } from '../supabase.js';
import { loadSrd, loadCharacterRules } from '../srd.js';
import { KINDS } from './kinds.js';
import { mergeHomebrew, hbId } from './merge.js';

const COLUMNS = 'id, owner_id, kind, name, data, created_at, updated_at';

function check(error) {
  if (!error) return;
  if (/relation .*homebrew.* does not exist|Could not find the (table|function)/i.test(error.message)) {
    throw new Error('The homebrew tables are missing. Run supabase/setup-all.sql in the Supabase SQL editor (it is safe to run again).');
  }
  if (/permission denied for (table|function)/i.test(error.message)) {
    throw new Error('The database is blocking homebrew. Run supabase/setup-all.sql in the Supabase SQL editor (it is safe to run again).');
  }
  throw new Error(error.message);
}

async function q(promise) {
  const { data, error } = await promise;
  check(error);
  return data;
}

const tidyName = (n) => String(n || '').trim().slice(0, 120) || 'Unnamed homebrew';

/* ---------------------------------------------------------- the library */

/** Everything you can read: your own items plus switched-on items from your campaigns. */
export async function listVisible() {
  return q(supabase.from('homebrew').select(COLUMNS).order('name'));
}

export async function listMine(userId) {
  return q(supabase.from('homebrew').select(COLUMNS).eq('owner_id', userId).order('name'));
}

export async function getHomebrew(id) {
  return q(supabase.from('homebrew').select(COLUMNS).eq('id', id).maybeSingle());
}

export async function createHomebrew(kind, data) {
  if (!KINDS[kind]) throw new Error(`Unknown homebrew kind: ${kind}`);
  return q(supabase.from('homebrew').insert({ kind, name: tidyName(data.name), data }).select(COLUMNS).single());
}

export async function saveHomebrew(id, data) {
  return q(supabase.from('homebrew').update({ name: tidyName(data.name), data }).eq('id', id).select(COLUMNS).single());
}

export async function deleteHomebrew(id) {
  await q(supabase.from('homebrew').delete().eq('id', id));
}

/* ----------------------------------------------------------- campaigns */

/** The campaign's list: [{ homebrew_id, added_by, enabled, item }] (item is null if you can't read it). */
export async function campaignHomebrew(campaignId) {
  const links = await q(supabase.from('campaign_homebrew').select('homebrew_id, added_by, enabled, added_at').eq('campaign_id', campaignId));
  const ids = links.map((l) => l.homebrew_id);
  const items = ids.length ? await q(supabase.from('homebrew').select(COLUMNS).in('id', ids)) : [];
  return links.map((l) => ({ ...l, item: items.find((i) => i.id === l.homebrew_id) || null }));
}

/** Which campaigns each of your items is in: { homebrewId: [campaignId] }. */
export async function myCampaignLinks(ids) {
  if (!ids.length) return {};
  const rows = await q(supabase.from('campaign_homebrew').select('campaign_id, homebrew_id, enabled').in('homebrew_id', ids));
  const out = {};
  for (const r of rows) (out[r.homebrew_id] ||= []).push(r);
  return out;
}

/** Returns true if it's switched on straight away (you're the DM), false if it waits for the DM. */
export async function addToCampaign(campaignId, homebrewId) {
  return q(supabase.rpc('homebrew_add', { cid: campaignId, hid: homebrewId }));
}

export async function setEnabled(campaignId, homebrewId, on) {
  await q(supabase.rpc('homebrew_set_enabled', { cid: campaignId, hid: homebrewId, on_off: on }));
}

export async function removeFromCampaign(campaignId, homebrewId) {
  await q(supabase.rpc('homebrew_remove', { cid: campaignId, hid: homebrewId }));
}

/* ------------------------------------------------ rules with homebrew */

/**
 * The rows the rules data should include. With a campaign: what's switched
 * on there plus your own items (so your character always works). Without:
 * everything you can read. Campaign rows say whether they're switched on
 * there (enabledHere).
 */
export async function homebrewRows({ campaignId = null, userId = null } = {}) {
  try {
    if (!campaignId) return await listVisible();
    const links = await q(supabase.from('campaign_homebrew').select('homebrew_id').eq('campaign_id', campaignId).eq('enabled', true));
    const ids = links.map((l) => l.homebrew_id);
    let query = supabase.from('homebrew').select(COLUMNS);
    query = ids.length ? query.or(`owner_id.eq.${userId},id.in.(${ids.join(',')})`) : query.eq('owner_id', userId);
    const set = new Set(ids);
    return (await q(query)).map((r) => ({ ...r, enabledHere: set.has(r.id) }));
  } catch (err) {
    // The site still works without homebrew (for example before 0007 is run).
    console.warn('Homebrew not loaded:', err.message);
    return [];
  }
}

/** loadCharacterRules() plus homebrew. */
export async function loadCharacterRulesWithHomebrew(opts = {}, rows = null) {
  const [rules, hb] = await Promise.all([loadCharacterRules(), rows ? Promise.resolve(rows) : homebrewRows(opts)]);
  return mergeHomebrew(rules, hb);
}

/** One rules dataset plus homebrew ('equipment' gets weapons and armor). */
export async function loadDatasetWithHomebrew(name, rows) {
  const base = await loadSrd(name);
  return mergeHomebrew({ [name]: base }, rows)[name];
}

/* ------------------------------------------------- export and import */

export const EXPORT_FORMAT = 'dnd-game-homebrew';

export function exportFile(rows) {
  const items = rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, data: r.data }));
  const payload = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), items };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const first = rows.length === 1 ? rows[0].name : 'homebrew';
  const safe = first.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'homebrew';
  return { blob, filename: `${safe}.homebrew.json` };
}

export function downloadHomebrew(rows) {
  const { blob, filename } = exportFile(rows);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read an exported file. Throws a friendly error if it isn't one of ours. */
export function parseImport(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a homebrew file from this site.");
  }
  if (json?.format !== EXPORT_FORMAT || !Array.isArray(json.items)) throw new Error("That file isn't a homebrew file from this site.");
  if (json.version > 1) throw new Error('That homebrew was saved by a newer version of the site.');
  const items = json.items.filter((i) => i && KINDS[i.kind] && i.data && typeof i.data === 'object');
  if (!items.length) throw new Error('That file has no homebrew in it.');
  if (items.length > 500) throw new Error('That file has more than 500 items. Split it into smaller files.');
  return items;
}

/**
 * Save imported items as new homebrew. Classes go first so subclasses made
 * for a homebrew class in the same file point at the new copy.
 */
export async function importItems(items) {
  const order = (i) => (i.kind === 'class' ? 0 : i.kind === 'subclass' ? 2 : 1);
  const sorted = [...items].sort((a, b) => order(a) - order(b));
  const newIds = {};
  const saved = [];
  for (const item of sorted) {
    const data = { ...item.data, name: tidyName(item.data.name || item.name) };
    if (item.kind === 'subclass' && newIds[data.classId]) data.classId = newIds[data.classId];
    const row = await createHomebrew(item.kind, data);
    if (item.id) newIds[`hb-${item.id}`] = hbId(row);
    saved.push(row);
  }
  return saved;
}
