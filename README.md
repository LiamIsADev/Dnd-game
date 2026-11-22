# Dnd Game

A website for creating and running Fifth Edition (2024 rules) campaigns online. One player is the Dungeon Master, the rest of the party play their characters, and everyone joins a live session with a shared battle map. The site rolls the dice and tracks everything, so nobody needs paper or physical dice.

Built with plain HTML, CSS and JavaScript, using [Vite](https://vite.dev) to run and bundle the site and [Supabase](https://supabase.com) for sign-in, the database and live sync.

## Roadmap

1. **Foundation** (this step): project setup, email sign-in, and the SRD rules converted into data the site can use, with a rules browser.
2. **Characters**: character builder, digital character sheet, saved character library, bringing characters into campaigns.
3. **Live table**: campaigns and invite links, separate DM and player views, grid map with tokens and fog of war, drag-and-drop enemies, image reveals, dice roller.
4. **Rules automation**: initiative, attacks, saving throws, damage, HP, conditions, spell slots, rests and levelling.

## Running it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

Other commands:

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run build`     | Builds the site into `dist/` for hosting                             |
| `npm run preview`   | Serves the built site locally                                        |
| `npm test`          | Checks the rules conversion against known values                     |
| `npm run build:srd` | Regenerates `public/data/srd/*.json` from the Markdown in `srd-source/` |

## One-time Supabase setup

The Supabase project URL and publishable key are in `src/lib/config.js`. They are safe to be public; the database's row-level security rules decide what each player can see. **Never** put the secret or `service_role` key in this repository.

In the [Supabase dashboard](https://supabase.com/dashboard) for the project:

1. **Create the database tables.** Open **SQL Editor → New query**, paste the contents of [`supabase/migrations/0001_profiles.sql`](supabase/migrations/0001_profiles.sql), and click **Run**.
2. **Allow the site's address for sign-in links.** Open **Authentication → URL Configuration**:
   - Set **Site URL** to where the site is hosted (use `http://localhost:5173` until it's online).
   - Under **Redirect URLs**, add `http://localhost:5173/**` (and later the hosted address followed by `/**`).
3. **Add the 6-digit code to the sign-in email** (lets people sign in on a different device from where they read their email). Open **Authentication → Emails**, choose the **Magic Link** template and add this line to the message body, then save:
   ```html
   <p>Or enter this code on the sign-in page: <strong>{{ .Token }}</strong></p>
   ```
4. **Before inviting lots of players**, connect a real email sender under **Authentication → Emails → SMTP Settings** (for example [Resend](https://resend.com), which has a free tier). Supabase's built-in sender only sends a few emails per hour.

## Project layout

```
index.html                 Page shell (header, footer)
src/main.js                Starts the app and routes between pages (#/rules, #/account, ...)
src/lib/                   Supabase client, sign-in, rules data loader, HTML helpers
src/pages/                 One file per page
src/components/            Reusable pieces (e.g. the monster stat block)
src/styles.css             All styles (dark and light themes)
public/data/srd/           Rules data as JSON (generated, committed)
scripts/build-srd.mjs      Converts srd-source/*.md into public/data/srd/*.json
srd-source/                SRD 5.2.1 Markdown, copied from downfallx/dnd-5e-srd-markdown
supabase/migrations/       SQL to run in Supabase, in order
tests/                     Automated checks (node --test)
```

## Rules content and licence

The rules come from the **System Reference Document 5.2.1** (the 2024 Fifth Edition rules) by Wizards of the Coast LLC, licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The Markdown version is from [downfallx/dnd-5e-srd-markdown](https://github.com/downfallx/dnd-5e-srd-markdown) (commit `1b4b99d`). See [`srd-source/LICENSE`](srd-source/LICENSE).

Only SRD content can be included in the site. Material that exists only in the published books (other subclasses, spells, monsters and so on) is copyrighted and must not be added here.

Dungeons & Dragons and D&D are trademarks of Wizards of the Coast LLC. This project is not affiliated with or endorsed by Wizards of the Coast.
