// SyllabAI weekly digest: emails each user this week's deadlines plus their
// remaining skips. Runs on a schedule (see supabase/digest-schedule.sql) or
// manually. NOT active until you add the secrets below; without them it exits
// harmlessly.
//
// Secrets required (Edge Functions -> Secrets):
//   BREVO_API_KEY   free key from brevo.com (300 emails/day on the free plan)
//   BREVO_FROM      the sender email you verified in Brevo
//   DIGEST_SECRET   any long random string; the caller must send it in the
//                   x-digest-secret header so nobody else can trigger sends
//
// Deploy exactly like the claude function: Edge Functions -> New function ->
// name it "digest" -> paste this file -> Deploy.

import { createClient } from "npm:@supabase/supabase-js@2";

const BREVO_KEY = Deno.env.get("BREVO_API_KEY") ?? "";
const BREVO_FROM = Deno.env.get("BREVO_FROM") ?? "";
const SECRET = Deno.env.get("DIGEST_SECRET") ?? "";

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-digest-secret") !== SECRET) {
    return new Response(JSON.stringify({ error: "Not authorized." }), { status: 401 });
  }
  if (!BREVO_KEY || !BREVO_FROM) {
    return new Response(JSON.stringify({ error: "Email is not configured (BREVO_API_KEY / BREVO_FROM)." }), { status: 200 });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = new Date();
  const weekOut = new Date(today.getTime() + 7 * 86400000);

  const [{ data: events }, { data: courses }, { data: prefs }] = await Promise.all([
    admin.from("events").select("user_id, course_id, title, date, time").gte("date", iso(today)).lte("date", iso(weekOut)),
    admin.from("courses").select("id, user_id, code, allowances"),
    admin.from("digest_prefs").select("user_id, enabled"),
  ]);
  const optedOut = new Set((prefs ?? []).filter((p) => !p.enabled).map((p) => p.user_id));
  const courseById = new Map((courses ?? []).map((c) => [c.id, c]));

  const byUser = new Map<string, { events: typeof events; skips: string[] }>();
  for (const e of events ?? []) {
    if (optedOut.has(e.user_id)) continue;
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, { events: [], skips: [] });
    byUser.get(e.user_id)!.events!.push(e);
  }
  for (const c of courses ?? []) {
    if (optedOut.has(c.user_id) || !byUser.has(c.user_id)) continue;
    for (const a of (c.allowances as { label: string; remaining: number; total: number }[]) ?? []) {
      byUser.get(c.user_id)!.skips.push(`${c.code} ${a.label}: ${a.remaining}/${a.total} left`);
    }
  }

  let sent = 0;
  for (const [userId, bundle] of byUser) {
    const { data: userData } = await admin.auth.admin.getUserById(userId);
    const email = userData?.user?.email;
    if (!email || !bundle.events!.length) continue;
    const lines = bundle.events!
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => {
        const code = e.course_id ? (courseById.get(e.course_id)?.code ?? "") : "";
        return `<li><b>${e.date}</b>${e.time ? " " + e.time : ""} — ${code ? code + ": " : ""}${e.title}</li>`;
      }).join("");
    const skipsHtml = bundle.skips.length
      ? `<p><b>Skips remaining:</b><br>${bundle.skips.join("<br>")}</p>` : "";
    const html = `<p>Your week, straight from your syllabi:</p><ul>${lines}</ul>${skipsHtml}
      <p style="color:#888;font-size:12px">SyllabAI · turn this off in Settings → Weekly digest email</p>`;
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: BREVO_FROM, name: "SyllabAI" },
        to: [{ email }],
        subject: `This week: ${bundle.events!.length} deadline${bundle.events!.length === 1 ? "" : "s"}`,
        htmlContent: html,
      }),
    });
    if (res.ok) sent++;
  }

  return new Response(JSON.stringify({ sent, users: byUser.size }), { status: 200 });
});
