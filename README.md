# One Daily Improvement

Standalone web app port of the claude.ai artifact. Same features — mountain
scoreboard, cheerleader, achievements, categories, assignments, comments,
reactions, photos, mobile layout — running on your own Supabase + a free
static host. URL works on any device, no claude.ai account needed, and you
can keep improving the app without losing any of the crew's entries.

## Files

- `index.html` — the shell
- `styles.css` — design system (copy of the artifact's CSS)
- `app.js` — app logic, talks to Supabase
- `config.example.js` — template for your Supabase URL + anon key
- `supabase-schema.sql` — DB tables, RLS policies, realtime publication

Nothing to build. Just upload the folder to any static host.

## 1. Set up Supabase (one time)

1. Sign in at https://supabase.com and create a new project (or reuse an
   existing one — the tables live in the `public` schema and won't clash as
   long as you don't already have `submissions`, `reactions`, `comments`).
2. Open **SQL Editor** → **New query**. Paste the whole contents of
   `supabase-schema.sql` and click **Run**. This creates the three tables,
   opens RLS for `anon` on all of them, and enables realtime so every open
   browser sees new posts instantly.
3. Open **Storage** → **New bucket**:
   - Name: `entry-photos`
   - Public bucket: **ON**
   - Click **Save**
4. On the new bucket, go to **Policies** → **New policy** → pick a template
   like "Allow access to anon users" for INSERT, SELECT, and DELETE. For
   internal crew use, three "Allow all for anon" policies are fine.
5. In the project sidebar: **Project Settings** → **API**. Copy:
   - **Project URL** → goes into `config.js` as `supabaseUrl`
   - **anon public key** → goes into `config.js` as `supabaseAnonKey`
     (this key is designed to be public; it works because RLS controls
     what anon can do)

## 2. Configure the app

In this folder:

```bash
cp config.example.js config.js
```

Edit `config.js` and fill in your three values:

```js
window.ODI_CONFIG = {
  supabaseUrl: "https://xyzabc.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
  owner: "Ben Newbold",
  photosBucket: "entry-photos",
};
```

`owner` is the person who gets admin buttons (assign, delete, undo).

## 3. Deploy to a static host

Any static host works. Four easy options — pick one.

### Vercel (recommended — one command)

```bash
npm i -g vercel
cd daily-improvement
vercel
```

Follow the prompts (first time will link your account and project). The
final URL is what you share with the crew. Later updates:

```bash
vercel --prod
```

### Netlify (drag-and-drop, no CLI)

1. Go to https://app.netlify.com/drop
2. Drag the `daily-improvement` folder onto the page
3. Netlify gives you a `https://<something>.netlify.app` URL immediately

For updates, drag the folder again to the same site.

### Cloudflare Pages

1. https://dash.cloudflare.com → Pages → **Upload assets**
2. Drag the folder, give the project a name
3. You get a `<name>.pages.dev` URL

### GitHub Pages

1. Make a new GitHub repo, commit `daily-improvement/`
2. Settings → Pages → source = main branch, folder = `/daily-improvement`
3. GitHub gives a `https://<user>.github.io/<repo>/` URL

## 4. Share with the crew

Send the URL. On a phone:

- **iPhone**: Open in Safari → Share → **Add to Home Screen**
- **Android**: Open in Chrome → ⋮ menu → **Install app** / **Add to Home screen**

Now it looks and feels like a native app — tap the icon, no bookmarks, no
sign-in. The 🔔 button in the header asks for notification permission so
they get a popup when a teammate posts (while the browser is open).

## 5. Keep improving the app

Edit `app.js` / `styles.css` locally, then redeploy with the same command
(`vercel --prod`, re-drag to Netlify, etc.). The URL stays the same and
every entry, reaction, comment, and photo stays untouched — they live in
Supabase, not in the app code.

## Schema cheatsheet

Three tables, all with open `anon` RLS (URL = auth):

- `submissions` — the entries (id, name, problem, solution, photos, status,
  kind, category, assignees, improved_*, created_at)
- `reactions` — one row per person × entry × emoji code
- `comments` — flat, with `entry_id` foreign key

Photos live in the `entry-photos` storage bucket; the DB just stores their
public URLs.

## Troubleshooting

- **"Setup needed" page on first load** → `config.js` is missing or
  `supabaseUrl` / `supabaseAnonKey` aren't filled in.
- **Entries don't appear across devices** → realtime isn't published for
  the tables. Re-run `supabase-schema.sql` (it's idempotent and the `do $$`
  block at the bottom fixes the publication).
- **Photo uploads fail** → the `entry-photos` bucket either isn't public
  or doesn't have anon INSERT policy. Fix in Storage → Policies.
- **Everyone can edit everything** → that's by design (URL = auth). If you
  need per-person authorization later, switch to Supabase magic-link auth
  and change the RLS policies from `using (true)` to `using (auth.uid()
  is not null)`.
