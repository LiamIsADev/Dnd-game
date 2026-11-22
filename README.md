# Dnd Game

A website for creating and running Fifth Edition (2024 rules) campaigns online. One player is the Dungeon Master, the rest of the party play their characters, and everyone joins a live session with a shared battle map. The site rolls the dice and tracks everything, so nobody needs paper or physical dice.

Built with plain HTML, CSS and JavaScript, using [Vite](https://vite.dev) to run and bundle the site and [Supabase](https://supabase.com) for sign-in, the database and live sync.

## Roadmap

1. **Foundation** (done): project setup, email sign-in, and the SRD rules converted into data the site can use, with a rules browser.
2. **Characters** (done): home screen, step-by-step character builder, digital character sheet with dice rolling, saved character library, import/export as a file.
3. **Live table** (done): campaigns and invite links, separate DM and player views, grid map with tokens and fog of war, drag-and-drop enemies, image reveals, dice roller.
4. **Rules automation** (done): initiative, attacks, saving throws, damage, HP, conditions, spell slots, rests and levelling.

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
| `npm test`          | Checks the rules conversion, character math, dice and import/export  |
| `npm run build:srd` | Regenerates `public/data/srd/*.json` from the Markdown in `srd-source/` |

## One-time Supabase setup

The Supabase project URL and publishable key are in `src/lib/config.js`. They are safe to be public; the database's row-level security rules decide what each player can see. **Never** put the secret or `service_role` key in this repository.

In the [Supabase dashboard](https://supabase.com/dashboard) for the project:

1. **Create the database tables.** Open **SQL Editor → New query**, paste the contents of each file in [`supabase/migrations/`](supabase/migrations/) in number order (`0001_profiles.sql`, then `0002_characters.sql`, and so on), and click **Run** for each. They're safe to run again.
2. **Allow the site's address for sign-in links.** Open **Authentication → URL Configuration**:
   - Set **Site URL** to where the site is hosted (use `http://localhost:5173` until it's online).
   - Under **Redirect URLs**, add `http://localhost:5173/**` (and later the hosted address followed by `/**`).
3. **Add the 6-digit code to the sign-in email** (lets people sign in on a different device from where they read their email). Open **Authentication → Emails**, choose the **Magic Link** template and add this line to the message body, then save:
   ```html
   <p>Or enter this code on the sign-in page: <strong>{{ .Token }}</strong></p>
   ```
4. **Let people create password accounts without an email.** Open **Authentication → Sign In / Providers → Email**, make sure **Email** is enabled, and turn **Confirm email** off, then save. Players can then sign in with a password (no email needed), and use email links as a backup. If you leave Confirm email on, new password accounts get one confirmation email first.
5. **Before inviting lots of players**, connect a real email sender under **Authentication → Emails → SMTP Settings** (for example [Resend](https://resend.com), which has a free tier). Supabase's built-in sender only sends about 2 emails per hour. Password sign-in doesn't send emails, so it isn't affected.

## Project layout

```
index.html                 Page shell (header, footer)
src/main.js                Starts the app and routes between pages (#/rules, #/account, ...)
src/lib/                   Supabase client, sign-in, rules data loader, dice, HTML helpers
src/lib/character/         Character rules math (rules.js) and saving/loading (store.js)
src/lib/campaign/          Campaign data and live updates (store.js), fog of war, dice text helpers
src/pages/                 One file per page
src/components/            Reusable pieces (the battle map board, the monster stat block)
src/styles.css             All styles (dark and light themes)
public/data/srd/           Rules data as JSON (generated, committed)
scripts/build-srd.mjs      Converts srd-source/*.md into public/data/srd/*.json
srd-source/                SRD 5.2.1 Markdown, copied from downfallx/dnd-5e-srd-markdown
supabase/migrations/       SQL to run in Supabase, in order
tests/                     Automated checks (node --test)
tests/db/                  Database security and rules tests against a local PostgreSQL (bash tests/db/run.sh)
```

## Campaigns and the live table

- **Start a campaign** on the Campaigns page. You become its Dungeon Master and get a 6-letter join code.
- **Invite players** by sending the link (Invite players button) or the code. Players type the code in the "Join a campaign" box on their home screen.
- **Players** pick one of their saved characters, see the map the DM has opened (through the fog), move their own token, roll from quick-roll buttons, and see images when the DM shows them.
- **The DM** sees everything: drag enemies from the 330 SRD creatures onto the map (hidden from players until revealed), place the party's tokens, track enemy HP and AC, roll secretly from stat blocks, paint fog away or back, prepare maps before opening them for players, upload map backgrounds, and show or hide images.
- **Dice** are rolled by the database, so nobody can fake a roll. Everyone sees the shared roll log; secret rolls only show for the roller (and the DM).

All of the secrecy is enforced by the database's row-level security, not by the page. A player's browser never receives hidden enemies, enemies in the fog, enemy HP, unopened maps or unshown images. `tests/db/security.test.sql` checks this.

## Rules automation

Run `0004_rules.sql` in the Supabase SQL Editor to turn this on.

- **Combat and turns.** The DM presses **Start combat**, rolls initiative for the enemies in one click, and players roll their own. The turn order shows above the map, the current creature glows, and **Next turn** moves on (players can end their own turn). Dead creatures are skipped.
- **Attacks.** Players click a weapon or attack spell, then click the target. The DM clicks a monster's action in its panel, then the target. The site rolls to hit against the target's AC (which players never see), handles natural 20s (double dice) and natural 1s, rolls damage and applies it, including resistances, immunities and vulnerabilities.
- **Saving throws.** Save spells and monster abilities like breath weapons can hit several targets. Each target rolls its own save against the DC, takes full or half damage, and gains a condition (for example Paralyzed from Hold Person) on a failed save.
- **Hit points and conditions.** Damage uses Temporary HP first. At 0 HP a character falls Unconscious and rolls death saves from the table; damage while down counts as failures, and massive damage kills outright. Monsters at 0 HP are marked dead. Condition chips can be toggled by the DM or the player and show on the token.
- **Spell slots.** Casting a levelled spell picks a slot (upcasting adds the extra dice) and spends it after the spell is cast. Cantrips scale with level, healing spells add the casting modifier.
- **Rests and XP.** The DM can give the party a short or long rest (long rest restores HP, Hit Point Dice, slots and death saves, and lowers Exhaustion) and award XP, split evenly. The XP box is filled in with the defeated enemies' XP.
- **Levelling up.** When a character has enough XP, the sheet shows **Level up**. It walks through Hit Points (average or roll), a subclass at level 3, ability score increases or a feat, and lists the new features. Milestone levelling works too.

Every roll and every change to HP runs inside the database, so a player can only act for their own character. `tests/db/rules.test.sql` checks the rules.

## Character files

**Export file** on a character sheet (or in the Characters list) downloads a `.character.json` file. **Import from file** on the Characters page adds it to your library as a new character. This is how a character moves between campaigns or accounts. Only files exported from this site can be imported.

## Rules content and licence

The rules come from the **System Reference Document 5.2.1** (the 2024 Fifth Edition rules) by Wizards of the Coast LLC, licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The Markdown version is from [downfallx/dnd-5e-srd-markdown](https://github.com/downfallx/dnd-5e-srd-markdown) (commit `1b4b99d`). See [`srd-source/LICENSE`](srd-source/LICENSE).

Only SRD content can be included in the site. Material that exists only in the published books (other subclasses, spells, monsters and so on) is copyrighted and must not be added here.

Dungeons & Dragons and D&D are trademarks of Wizards of the Coast LLC. This project is not affiliated with or endorsed by Wizards of the Coast.
