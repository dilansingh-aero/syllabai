-- Schedules the weekly digest email for Sunday 6 pm US Central (23:00 UTC).
-- Run this ONCE in the SQL editor, AFTER:
--   1. deploying the "digest" edge function,
--   2. adding secrets BREVO_API_KEY, BREVO_FROM, DIGEST_SECRET to Edge Functions.
-- Replace the two placeholders below first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'syllabai-weekly-digest',
  '0 23 * * 0',
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-digest-secret', 'PASTE-YOUR-DIGEST_SECRET-HERE'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To undo later: select cron.unschedule('syllabai-weekly-digest');
