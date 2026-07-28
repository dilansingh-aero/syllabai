# SyllabAI server setup (Supabase)

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

## Keeping it updated

When `supabase/schema.sql` or `supabase/functions/claude/index.ts` change in this
repo, re-run / re-paste them the same way as steps 3 and 4. Both are safe to
re-apply; the schema only adds what's missing.

## Optional: weekly digest email

Every Sunday evening, users get one email with the week's deadlines and their
skips remaining. Free, but it needs a sender:

1. Create a free account at brevo.com (300 emails/day free) and verify a sender
   email address (Settings → Senders).
2. Get an API key (SMTP & API → API keys).
3. **Edge Functions → Deploy a new function → Via Editor**, name it exactly
   `digest`, paste `supabase/functions/digest/index.ts`, Deploy.
4. **Edge Functions → Secrets**: add `BREVO_API_KEY` (the key), `BREVO_FROM`
   (the verified sender email), and `DIGEST_SECRET` (any long random string).
5. **SQL Editor**: paste `supabase/digest-schedule.sql`, replace the two
   placeholders (your project ref and your DIGEST_SECRET), Run.

Users can opt out any time in the app: Settings → Weekly digest email.
