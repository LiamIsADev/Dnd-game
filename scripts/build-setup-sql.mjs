// Joins every migration into supabase/setup-all.sql, so the database can be
// brought fully up to date with one paste into the Supabase SQL editor.
// Every migration is safe to run again, so running this file is always safe.
//   node scripts/build-setup-sql.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../supabase/migrations/', import.meta.url);

export function buildSetupSql() {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const head = [
    '-- Everything the site needs in the database, in one file.',
    '-- Supabase dashboard: SQL Editor -> New query -> paste all of this -> Run.',
    '-- It is safe to run again: run it after every update to be sure nothing is missing.',
    `-- Made from supabase/migrations (${files[0]} to ${files.at(-1)}) by scripts/build-setup-sql.mjs.`,
    '',
  ].join('\n');
  return head + files.map((f) => `\n-- ===================================================== ${f}\n\n${readFileSync(new URL(f, dir), 'utf8').trim()}\n`).join('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('../supabase/setup-all.sql', import.meta.url), buildSetupSql());
  console.log('Wrote supabase/setup-all.sql');
}
