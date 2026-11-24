// Saving and loading characters in Supabase (table: public.characters).
// Each player can only see and change their own characters; the database's
// row-level security rules enforce that, not this file.
import { supabase } from '../supabase.js';
import { newCharacter } from './rules.js';

const COLUMNS = 'id, name, data, created_at, updated_at';

function check(error) {
  if (!error) return;
  if (/relation .*characters.* does not exist|Could not find the table/i.test(error.message)) {
    throw new Error('The characters table is missing. Run supabase/setup-all.sql in the Supabase SQL editor (it is safe to run again).');
  }
  if (/permission denied for table/i.test(error.message)) {
    throw new Error('The database is blocking access to characters. Run supabase/setup-all.sql in the Supabase SQL editor (it is safe to run again).');
  }
  throw new Error(error.message);
}

/** Fill in fields added after a character was saved, so old saves keep working. */
export function normalize(data) {
  const base = newCharacter();
  const out = { ...base, ...data };
  for (const key of ['backgroundBonus', 'baseScores', 'scoreAdjust', 'equipmentChoice', 'coins', 'spells', 'hp', 'deathSaves', 'details', 'speciesOptions']) {
    out[key] = { ...base[key], ...(data?.[key] || {}) };
  }
  for (const key of ['classSkills', 'inventory', 'conditions']) out[key] = Array.isArray(data?.[key]) ? data[key] : [];
  out.slotsUsed = data?.slotsUsed && typeof data.slotsUsed === 'object' ? data.slotsUsed : {};
  return out;
}

export async function listCharacters() {
  const { data, error } = await supabase.from('characters').select(COLUMNS).order('updated_at', { ascending: false });
  check(error);
  return data.map((row) => ({ ...row, data: normalize(row.data) }));
}

export async function getCharacter(id) {
  const { data, error } = await supabase.from('characters').select(COLUMNS).eq('id', id).maybeSingle();
  check(error);
  return data ? { ...data, data: normalize(data.data) } : null;
}

export async function createCharacter(character) {
  const { data, error } = await supabase
    .from('characters')
    .insert({ name: character.name.trim() || 'Unnamed hero', data: character })
    .select(COLUMNS)
    .single();
  check(error);
  return { ...data, data: normalize(data.data) };
}

/**
 * Save a character. Pass the updated_at you loaded to make sure nothing else
 * (like damage at the live table) changed it in the meantime: if it did, this
 * returns { conflict: true } and nothing is overwritten.
 */
export async function saveCharacter(id, character, expectedUpdatedAt) {
  let query = supabase
    .from('characters')
    .update({ name: character.name.trim() || 'Unnamed hero', data: character })
    .eq('id', id);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const { data, error } = await query.select('id, updated_at').maybeSingle();
  check(error);
  if (!data) {
    if (expectedUpdatedAt) return { conflict: true };
    throw new Error('Character not found.');
  }
  return data;
}

export async function deleteCharacter(id) {
  const { error } = await supabase.from('characters').delete().eq('id', id);
  check(error);
}

/* ------------------------------------------------------ import / export */

export const EXPORT_FORMAT = 'dnd-game-character';

export function exportFile(character) {
  const payload = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), character };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const safe = (character.name || 'character').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character';
  return { blob, filename: `${safe}.character.json` };
}

export function downloadCharacter(character) {
  const { blob, filename } = exportFile(character);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read an exported file's text. Throws a friendly error if it isn't one of ours. */
export function parseImport(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a character file from this site.");
  }
  if (json?.format !== EXPORT_FORMAT || typeof json.character !== 'object' || !json.character) {
    throw new Error("That file isn't a character file from this site.");
  }
  if (json.version > 1) throw new Error('That character was saved by a newer version of the site.');
  const c = normalize(json.character);
  if (typeof c.name !== 'string') c.name = String(c.name ?? '');
  c.name = c.name.slice(0, 80);
  return c;
}
