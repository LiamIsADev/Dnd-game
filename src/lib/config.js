// Public Supabase settings. These are safe to ship in browser code: the
// publishable key only allows what the database's row-level security policies
// allow. Never put the secret / service_role key in this project.
//
// Override them locally with a .env file (see .env.example) if you point the
// site at a different Supabase project.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://jqszirksthfckyxgtlql.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_eDWYWKaU08A8ZZU0TgyTtw_lpjA6yPe';
