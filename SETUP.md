# MySyllabi server setup (Supabase)

Five steps, all in the Supabase dashboard. Until they're done, the site runs as a
local demo; after them, it has real accounts powered by one hidden API key.

## 1. Create the project
supabase.com → Dashboard → **New project** (your free plan allows 2).
Name it `mysyllabi`, pick any region near you, let it generate the database password.

## 2. Turn off email confirmation
**Authentication → Sign In / Providers → Email → turn OFF "Confirm email" → Save.**
Without this, every classmate has to click a confirmation email, and the free tier
only sends a few emails per hour.

## 3. Create the database tables
**SQL Editor → New query** → paste the entire contents of `supabase/schema.sql`
from this repo → **Run**. It should say "Success. No rows returned".

## 4. Deploy the AI function and add your key
1. **Edge Functions → Deploy a new function → Via Editor.** Name it exactly `claude`.
2. Replace the sample code with the entire contents of
   `supabase/functions/claude/index.ts` from this repo → **Deploy**.
3. **Edge Functions → Secrets → Add new secret:**
   - Name `ANTHROPIC_API_KEY`, value: your key (starts `sk-ant-`). This is the ONLY
     place the key ever goes. Never put it in GitHub.
   - Optional: `MYSYLLABI_DAILY_LIMIT` (default 25 AI answers per person per day).

## 5. Connect the website
**Project Settings → API**: copy the **Project URL** and the **anon public** key,
and put them into `config.js` in this repo. (These two values are safe to publish;
all data access is locked down per-user by row level security.)

Push to GitHub, wait a minute for Pages to rebuild, done: the live site now has
sign-ups, per-user data, and AI answers on your key with daily limits.
