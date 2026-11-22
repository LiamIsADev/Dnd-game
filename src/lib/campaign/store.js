// Campaign data in Supabase. The database decides what each person may see:
// players never receive hidden enemies, enemies in the fog, enemy HP, maps the
// DM hasn't opened, or images the DM hasn't shown. This file just asks for
// "everything I'm allowed to see" and listens for changes.
import { supabase } from '../supabase.js';
import { normalize } from '../character/store.js';

const BUCKET = 'campaign-images';

function check(error) {
  if (!error) return;
  if (/relation .*(campaign|maps|tokens|handouts|rolls).* does not exist|Could not find the (table|function)/i.test(error.message)) {
    throw new Error('The campaign tables are missing. Run supabase/migrations/0003_campaigns.sql in the Supabase SQL editor.');
  }
  if (/permission denied for (table|function)/i.test(error.message)) {
    throw new Error('The database is blocking campaign access. Re-run supabase/migrations/0003_campaigns.sql in the Supabase SQL editor.');
  }
  throw new Error(error.message);
}

async function q(promise) {
  const { data, error } = await promise;
  check(error);
  return data;
}

/* --------------------------------------------------------- campaign list */

export async function listCampaigns(userId) {
  const rows = await q(
    supabase
      .from('campaign_members')
      .select('role, character_id, campaigns (id, name, dm_id, join_code, updated_at)')
      .eq('user_id', userId),
  );
  const list = rows.filter((r) => r.campaigns).map((r) => ({ ...r.campaigns, role: r.role, character_id: r.character_id }));
  const dmIds = [...new Set(list.map((c) => c.dm_id))];
  const names = await profileNames(dmIds);
  return list
    .map((c) => ({ ...c, dmName: names[c.dm_id] || 'Dungeon Master' }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function createCampaign(name) {
  const campaign = await q(supabase.from('campaigns').insert({ name: name.trim() || 'New campaign' }).select('id').single());
  // Every campaign starts with one empty battle map, already open.
  const map = await q(supabase.from('maps').insert({ campaign_id: campaign.id, name: 'Battle map' }).select('id').single());
  await q(supabase.from('campaigns').update({ active_map_id: map.id }).eq('id', campaign.id));
  return campaign.id;
}

export async function joinCampaign(code) {
  const { data, error } = await supabase.rpc('join_campaign', { code });
  if (error && /No campaign has that code|Sign in first/.test(error.message)) throw new Error(error.message);
  check(error);
  return data;
}

export async function profileNames(ids) {
  if (!ids.length) return {};
  const rows = await q(supabase.from('profiles').select('id, display_name').in('id', ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.display_name]));
}

/* --------------------------------------------------------- loading a table */

const loaders = {
  async campaign(s) {
    s.campaign = await q(supabase.from('campaigns').select('*').eq('id', s.id).maybeSingle());
  },
  async members(s) {
    const rows = await q(supabase.from('campaign_members').select('*').eq('campaign_id', s.id).order('joined_at'));
    const names = await profileNames(rows.map((r) => r.user_id));
    s.members = rows.map((r) => ({ ...r, name: names[r.user_id] || 'Player' }));
    // The DM can read the characters brought to the campaign; players can read their own.
    const ids = rows.map((r) => r.character_id).filter(Boolean);
    const chars = ids.length ? await q(supabase.from('characters').select('id, owner_id, name, data, updated_at').in('id', ids)) : [];
    s.characters = Object.fromEntries(chars.map((c) => [c.id, { ...c, data: normalize(c.data) }]));
  },
  async maps(s) {
    s.maps = await q(supabase.from('maps').select('*').eq('campaign_id', s.id).order('created_at'));
  },
  async tokens(s) {
    s.tokens = await q(supabase.from('tokens').select('*').eq('campaign_id', s.id).order('created_at'));
    if (s.isDm) {
      const rows = await q(supabase.from('token_secrets').select('*').eq('campaign_id', s.id));
      s.secrets = Object.fromEntries(rows.map((r) => [r.token_id, r]));
    } else s.secrets = {};
  },
  async handouts(s) {
    s.handouts = await q(supabase.from('handouts').select('*').eq('campaign_id', s.id).order('created_at'));
  },
  async rolls(s) {
    const rows = await q(supabase.from('rolls').select('*').eq('campaign_id', s.id).order('created_at', { ascending: false }).limit(50));
    s.rolls = rows;
  },
};

// Which parts to reload when the database says a table changed. Fog and the
// active map decide which tokens a player can see, so they reload tokens too.
const RELOAD = {
  campaigns: ['campaign', 'maps', 'tokens'],
  characters: ['members', 'tokens'],
  campaign_members: ['members'],
  maps: ['maps', 'tokens'],
  tokens: ['tokens'],
  token_secrets: ['tokens'],
  handouts: ['handouts'],
};

export async function loadTable(id, userId) {
  const s = { id, userId, campaign: null, members: [], characters: {}, maps: [], tokens: [], secrets: {}, handouts: [], rolls: [] };
  await loaders.campaign(s);
  if (!s.campaign) return null;
  s.isDm = s.campaign.dm_id === userId;
  await Promise.all(['members', 'maps', 'tokens', 'handouts', 'rolls'].map((k) => loaders[k](s)));
  return s;
}

export async function reload(s, parts) {
  if (parts.includes('campaign')) {
    await loaders.campaign(s);
    if (!s.campaign) return false;
  }
  await Promise.all(parts.filter((p) => p !== 'campaign').map((p) => loaders[p](s)));
  return true;
}

/**
 * Listen for changes. Calls onChange(parts) when something needs reloading
 * and onRoll(row) for each new dice roll this person is allowed to see.
 */
export function subscribe(campaignId, { onChange, onRoll, onStatus }) {
  const channel = supabase
    .channel(`campaign-${campaignId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'campaigns', filter: `id=eq.${campaignId}` }, (payload) => {
      onChange(RELOAD[payload.new?.last_change] || ['campaign', 'members', 'maps', 'tokens', 'handouts']);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rolls', filter: `campaign_id=eq.${campaignId}` }, (payload) => {
      onRoll(payload.new);
    })
    .subscribe((status) => onStatus?.(status));
  return () => supabase.removeChannel(channel);
}

/* ------------------------------------------------------------- campaign */

export async function renameCampaign(id, name) {
  await q(supabase.from('campaigns').update({ name: name.trim() || 'Campaign' }).eq('id', id));
}

export async function newJoinCode(id) {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  await q(supabase.from('campaigns').update({ join_code: code }).eq('id', id));
  return code;
}

export async function deleteCampaign(id) {
  await q(supabase.from('campaigns').delete().eq('id', id));
}

export async function leaveCampaign(id, userId) {
  await q(supabase.from('campaign_members').delete().eq('campaign_id', id).eq('user_id', userId));
}

export async function removePlayer(id, userId) {
  await leaveCampaign(id, userId);
}

export async function chooseCharacter(campaignId, userId, characterId) {
  await q(supabase.from('campaign_members').update({ character_id: characterId }).eq('campaign_id', campaignId).eq('user_id', userId));
}

/* ------------------------------------------------------------------ maps */

export async function createMap(campaignId, fields) {
  return q(supabase.from('maps').insert({ campaign_id: campaignId, ...fields }).select('*').single());
}

export async function updateMap(id, fields) {
  await q(supabase.from('maps').update(fields).eq('id', id));
}

export async function deleteMap(id) {
  await q(supabase.from('maps').delete().eq('id', id));
}

export async function setActiveMap(campaignId, mapId) {
  await q(supabase.from('campaigns').update({ active_map_id: mapId }).eq('id', campaignId));
}

/* ---------------------------------------------------------------- tokens */

export async function createToken(fields, secret) {
  const token = await q(supabase.from('tokens').insert(fields).select('*').single());
  if (secret) await q(supabase.from('token_secrets').insert({ token_id: token.id, campaign_id: token.campaign_id, ...secret }));
  return token;
}

export async function updateToken(id, fields) {
  await q(supabase.from('tokens').update(fields).eq('id', id));
}

export async function saveSecret(tokenId, campaignId, fields) {
  await q(supabase.from('token_secrets').upsert({ token_id: tokenId, campaign_id: campaignId, ...fields }));
}

export async function deleteToken(id) {
  await q(supabase.from('tokens').delete().eq('id', id));
}

/** Moving goes through the database so players can only move their own token, and so it reveals fog. */
export async function moveToken(id, x, y) {
  const { error } = await supabase.rpc('move_token', { token: id, nx: x, ny: y });
  if (error && /only move your own/.test(error.message)) throw new Error('You can only move your own token.');
  check(error);
}

/* -------------------------------------------------------------- handouts */

export async function createHandout(campaignId, title, imagePath) {
  return q(supabase.from('handouts').insert({ campaign_id: campaignId, title, image_path: imagePath }).select('*').single());
}

export async function showHandout(id, shown) {
  await q(supabase.from('handouts').update({ shown, shown_at: shown ? new Date().toISOString() : null }).eq('id', id));
}

export async function deleteHandout(handout) {
  await q(supabase.from('handouts').delete().eq('id', handout.id));
  await supabase.storage.from(BUCKET).remove([handout.image_path]);
}

/* ---------------------------------------------------------------- images */

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export async function uploadImage(campaignId, file) {
  if (!TYPES.includes(file.type)) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
  if (file.size > MAX_BYTES) throw new Error('Images can be up to 5 MB.');
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type];
  const path = `${campaignId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    if (/bucket not found/i.test(error.message)) throw new Error('Image storage is missing. Run supabase/migrations/0003_campaigns.sql in the Supabase SQL editor.');
    throw new Error(error.message);
  }
  return path;
}

const urlCache = new Map();

/** A short-lived link to a private image. Fails (returns null) if this person isn't allowed to see it yet. */
export async function imageUrl(path) {
  if (!path) return null;
  const hit = urlCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  urlCache.set(path, { url: data.signedUrl, expires: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

/* ----------------------------------------------------------------- dice */

/** Dice are rolled by the database so nobody can fake a roll. */
export async function rollDice(campaignId, expr, { label = '', mode = 'normal', private: secret = false } = {}) {
  const { data, error } = await supabase.rpc('roll_dice', { cid: campaignId, expr, label, mode, private: secret });
  if (error && /dice|not in this campaign|roll mode/i.test(error.message)) throw new Error(error.message);
  check(error);
  return data;
}

/* ------------------------------------------------------- rules automation */
// Every one of these is rolled and applied by the database (see 0004_rules.sql).

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (/Could not find the function/i.test(error.message)) {
      throw new Error('Combat rules are missing. Run supabase/migrations/0004_rules.sql in the Supabase SQL editor.');
    }
    // Rule messages from the database are written for players; show them as they are.
    if (error.code === 'P0001') throw new Error(error.message);
    check(error);
  }
  return data;
}

export const combat = {
  start: (cid) => rpc('combat_start', { cid }),
  end: (cid) => rpc('combat_end', { cid }),
  next: (cid) => rpc('combat_next', { cid }),
  initiative: (token, bonus, mode = 'normal') => rpc('roll_initiative', { token, bonus, mode }),
  attack: (a) =>
    rpc('attack', {
      attacker: a.attacker, target: a.target, bonus: a.bonus, damage: a.damage || '', damage_type: a.damageType || '',
      mode: a.mode || 'normal', label: a.label || '', extra: a.extra || [],
    }),
  save: (a) =>
    rpc('saving_throw', {
      source: a.source, targets: a.targets, ability: a.ability, dc: a.dc, damage: a.damage || '', damage_type: a.damageType || '',
      half: !!a.half, condition: a.condition || '', label: a.label || '',
    }),
  heal: (healer, target, amount, label = '') => rpc('heal', { healer, target, amount, label }),
  adjustHp: (target, delta, temp = false) => rpc('adjust_hp', { target, delta, temp }),
  condition: (token, name, present) => rpc('set_condition', { token, name, present }),
  deathSave: (token) => rpc('death_save', { token }),
  useSlot: (charId, level, used) => rpc('use_slot', { char_id: charId, level, used }),
  hitDie: (token, die, conMod) => rpc('spend_hit_die', { token, die, con_mod: conMod }),
  rest: (cid, kind) => rpc('party_rest', { cid, kind }),
  awardXp: (cid, amount) => rpc('award_xp', { cid, amount }),
};
