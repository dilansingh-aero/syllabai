// SyllabAI edge function: the ONLY place the Anthropic API key lives.
// Handles kind = "status" | "ask" | "extract" | "draft".
// Enforces a per-user daily AI-call limit stored in public.ai_usage.
//
// Secrets required (Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY        your key (sk-ant-...)
//   MYSYLLABI_DAILY_LIMIT    optional, default "25"
//
// Uses raw fetch to api.anthropic.com instead of the SDK to keep the function
// dependency-free for reliable dashboard deploys.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5";
const LIMIT = parseInt(Deno.env.get("MYSYLLABI_DAILY_LIMIT") ?? "25", 10);
const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------- prompts

const QA_SYSTEM = `You are SyllabAI, a study assistant that answers a student's question using ONLY the numbered excerpts provided from their own uploaded course materials and notes (excerpt [0], when present, is their extracted deadline calendar).

HARD RULES:
1. GROUNDING. Every factual claim must come from the provided excerpts. Never use outside knowledge about the school, professor, course, or "typical" policies. Never guess, infer beyond the text, or fill gaps.
2. If the excerpts don't contain the answer: status="not_found". Say plainly their materials don't cover it, nothing more.
3. If the excerpts cover only part of the question: status="partial". Answer the covered part and name what's missing.
4. CITATIONS. Support each claim with the excerpt id and a short VERBATIM quote (an exact contiguous substring of that excerpt, under 200 characters, copied character for character). An answer with status "answered" must include at least one citation. If you cannot quote it, you cannot claim it.
5. DATES. Today is {today}. Resolve relative phrasing ("next week", "this Friday") into explicit dates using excerpt dates.
6. If materials from multiple courses could apply and the question doesn't say which, ask which course they mean (status="partial") instead of mixing courses. When the answer is course specific, name the course code.

ROUTING:
- "none": the materials fully answer it and no action with a person is needed. Set route_reason to "".
- "ta": assignment or grading logistics, when the materials mention TAs or direct such questions to them.
- "professor": personal circumstances, exam conflicts, extensions, accommodations, grade disputes, anything the materials say to email the instructor about.
- "classmate_or_lms": missed lecture notes, whether something was posted, LMS or tech issues.
- "registrar_or_advisor": enrollment, drop or add, degree requirements.
Only recommend contacting someone when the materials don't fully answer it, the student must take an action with a person, or you're unsure. If status is "not_found", pick whoever WOULD know. In route_reason (one short sentence), name the specific contact if the materials give one.

CONFIDENCE: "high" when a quote directly answers; "medium" when you combined excerpts; "low" when support is thin.

STYLE:
- The first sentence IS the answer: the number, date, yes or no, or rule. Then at most one or two short sentences of essential specifics.
- No preamble, no restating the question, no hedging, no filler.
- Never use dashes as punctuation. Hyphens only inside compound words like "drop-in". Plain text only.`;

const ANSWER_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "answer", "citations", "route", "route_reason", "confidence"],
  properties: {
    status: { type: "string", enum: ["answered", "partial", "not_found"] },
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["excerpt_id", "quote"],
        properties: { excerpt_id: { type: "integer" }, quote: { type: "string" } },
      },
    },
    route: { type: "string", enum: ["none", "ta", "professor", "classmate_or_lms", "registrar_or_advisor"] },
    route_reason: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

const FACTS_SYSTEM = `You extract structured facts and dated deadlines from a course syllabus, for the course's own student.

Rules:
- Copy only what the syllabus actually states. Use "" (empty string) or [] for anything it doesn't state. NEVER invent, assume, or normalize policies that aren't written.
- Keep each fact concise (one or two sentences max), in the syllabus's own wording where practical.
- grading: one entry per graded component with its weight as written (e.g. "30%"). If no weights are given, leave the weight "".
- other_key_policies: up to 6 short standout policies a student would want surfaced (e.g. "No extra credit", "3 slip days total").
- events: every dated deliverable or exam a student would put on a calendar. date must be ISO YYYY-MM-DD. Today is {today}; the course term is "{term}". If a date has no year, infer it from the term so it lands in the plausible academic window. Skip anything whose date you cannot resolve to a specific day. time is "HH:MM" 24 hour if stated, else "".
- Do not create events for ranges like "Week 3" or "TBA".
- allowances: every countable per-semester allowance the syllabus explicitly grants, with the EXACT number stated: dropped lowest scores (e.g. "lowest homework dropped" is total 1, "two lowest quiz scores dropped" is total 2), permitted absences or lecture misses, slip/grace/late days, free quiz misses. label is short and student-facing ("Homework drops", "Class skips", "Slip days", "Quiz drops", "Absences"). Only include allowances with an explicit number; never infer one. [] if none.`;

const FACTS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["facts", "events", "allowances"],
  properties: {
    allowances: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["label", "total"],
      properties: { label: { type: "string" }, total: { type: "integer" } } } },
    facts: {
      type: "object", additionalProperties: false,
      required: ["instructor", "instructor_email", "office_hours", "location_or_modality", "grading",
        "late_policy", "attendance_policy", "exam_policy", "academic_integrity", "textbook", "tas", "other_key_policies"],
      properties: {
        instructor: { type: "string" }, instructor_email: { type: "string" },
        office_hours: { type: "string" }, location_or_modality: { type: "string" },
        grading: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["component", "weight"],
          properties: { component: { type: "string" }, weight: { type: "string" } } } },
        late_policy: { type: "string" }, attendance_policy: { type: "string" },
        exam_policy: { type: "string" }, academic_integrity: { type: "string" }, textbook: { type: "string" },
        tas: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["name", "email", "hours"],
          properties: { name: { type: "string" }, email: { type: "string" }, hours: { type: "string" } } } },
        other_key_policies: { type: "array", items: { type: "string" } },
      },
    },
    events: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["title", "date", "time", "kind"],
      properties: { title: { type: "string" }, date: { type: "string" }, time: { type: "string" },
        kind: { type: "string", enum: ["exam", "quiz", "assignment", "project", "class", "other"] } } } },
  },
};

const EMAIL_SYSTEM = `You draft a short, respectful email from a student to their course staff.

Rules:
- Ground it in the provided context: mention that they checked the syllabus and what it does or doesn't say (only if the context supports that). Never invent policies, dates, or names.
- If the context names the right recipient, use their name and put their email in to_hint; otherwise to_hint is a description like "your TA (see course site)".
- 60 to 120 words. Specific subject line including the course code. Natural student voice, no groveling, no filler.
- Never use dashes as punctuation. Hyphens only inside compound words.
- Use [square-bracket placeholders] for anything only the student knows.
- Sign with the student's name. Plain text.`;

const EMAIL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["subject", "body", "to_hint"],
  properties: { subject: { type: "string" }, body: { type: "string" }, to_hint: { type: "string" } },
};

// ---------------------------------------------------------------- anthropic

async function callClaude(system: string, user: string, maxTokens: number, effort: string, schema: unknown) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error ${res.status}`);
  }
  if (data.stop_reason === "refusal") throw new Error("refusal");
  const text = (data.content || []).filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("");
  return JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
}

// ---------------------------------------------------------------- handler

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identify the calling user from their JWT.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Not signed in." }, 401);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
  const kind = String(body.kind || "");
  const today = new Date().toISOString().slice(0, 10);

  // Usage accounting runs with the service role so clients can't touch it.
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: usageRow } = await admin.from("ai_usage").select("calls")
    .eq("user_id", userId).eq("day", today).maybeSingle();
  const used = usageRow?.calls ?? 0;
  const usage = { on: Boolean(API_KEY), limit: LIMIT, used, left: Math.max(0, LIMIT - used) };

  if (kind === "status") return json({ usage });
  if (!API_KEY) return json({ limited: true, reason: "no_key", usage });
  if (used >= LIMIT) return json({ limited: true, reason: "limit", usage });

  // Consume one call up front.
  await admin.from("ai_usage").upsert({ user_id: userId, day: today, calls: used + 1 });
  usage.used = used + 1;
  usage.left = Math.max(0, LIMIT - usage.used);

  try {
    if (kind === "ask") {
      const excerpts = (body.excerpts as { id: number; label: string; text: string }[] | undefined) ?? [];
      const question = String(body.question || "").slice(0, 2000);
      const scope = String(body.scope || "all of the student's courses").slice(0, 200);
      const history = (body.history as { q: string; a: string }[] | undefined) ?? [];
      if (!question || !excerpts.length) return json({ error: "Missing question or excerpts." }, 400);
      let prompt = "EXCERPTS FROM THE STUDENT'S MATERIALS:\n\n" +
        excerpts.slice(0, 14).map((ex) => `[${ex.id}] ${ex.label}\n${String(ex.text).slice(0, 4000)}`).join("\n\n---\n\n");
      if (history.length) {
        prompt += "\n\nRECENT CONVERSATION (context only, NOT a source, never cite it):\n" +
          history.slice(-4).map((h) => `Q: ${String(h.q).slice(0, 300)}\nA: ${String(h.a).slice(0, 400)}`).join("\n");
      }
      prompt += `\n\nSCOPE: ${scope}\nSTUDENT'S QUESTION: ${question}`;
      const result = await callClaude(
        QA_SYSTEM.replace("{today}", new Date().toDateString()), prompt, 6000, "medium", ANSWER_SCHEMA);
      return json({ result, usage });
    }

    if (kind === "extract") {
      const text = String(body.text || "").slice(0, 60000);
      const code = String(body.code || "this course").slice(0, 60);
      const term = String(body.term || "not specified").slice(0, 60);
      if (text.length < 40) return json({ error: "No text." }, 400);
      const result = await callClaude(
        FACTS_SYSTEM.replace("{today}", today).replace("{term}", term),
        `SYLLABUS for ${code}:\n\n${text}`, 12000, "medium", FACTS_SCHEMA);
      return json({ result, usage });
    }

    if (kind === "draft") {
      const question = String(body.question || "").slice(0, 1500);
      const code = String(body.code || "your class").slice(0, 60);
      const recipient = body.recipient === "ta" ? "ta" : "professor";
      const context = String(body.context || "").slice(0, 6000);
      const student = String(body.student || "[your name]").slice(0, 80);
      const result = await callClaude(
        EMAIL_SYSTEM,
        `Student: ${student}\nCourse: ${code}\nRecipient type: ${recipient}\nWhat they want to ask about: ${question}\n\nRelevant material from their syllabus/answer:\n${context}`,
        3000, "low", EMAIL_SCHEMA);
      return json({ result, usage });
    }

    return json({ error: "Unknown kind." }, 400);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "refusal") return json({ error: "The AI declined this request.", usage }, 200);
    return json({ error: `AI call failed: ${message.slice(0, 200)}`, usage }, 200);
  }
});
