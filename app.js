/* MySyllabi — browser edition (GitHub Pages friendly).
 *
 * Everything runs and stays in THIS browser: courses, syllabi, calendar, Q&A
 * history (localStorage). No server, no shared accounts. With an Anthropic API
 * key (Settings) answers come from claude-opus-5, restricted to your uploads;
 * without one, a keyword-retrieval fallback shows best-matching passages.
 */
"use strict";

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

/* ================= persistence ================= */

const DB_KEY = "mysyllabi-v1";

function freshDb() {
  return { courses: [], docs: [], events: [], chats: [], apiKey: "", nextId: 1, welcomed: false };
}
let db = loadDb();

function loadDb() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...freshDb(), ...JSON.parse(raw) };
  } catch (_e) { /* corrupted -> start fresh */ }
  return freshDb();
}
function save() { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
function uid() { return db.nextId++; }

const MODEL = "claude-opus-5";
const COURSE_COLORS = ["#4f46e5", "#0d9488", "#d97706", "#db2777", "#7c3aed", "#059669", "#dc2626", "#2563eb"];

/* ================= small utils ================= */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
function openModal(html) { $("#modal").innerHTML = html; $("#modal-backdrop").classList.remove("hidden"); }
function closeModal() { $("#modal-backdrop").classList.add("hidden"); }
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === $("#modal-backdrop")) closeModal(); });

const KIND_ICONS = { exam: "📝", quiz: "❓", assignment: "📌", project: "📦", class: "🏫", other: "📅" };

function pad(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoToday() { return isoOf(new Date()); }
function addDays(iso, n) { const [y, m, d] = iso.split("-").map(Number); return isoOf(new Date(y, m - 1, d + n)); }
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function courseById(id) { return db.courses.find((c) => c.id === id); }
function docsOf(courseId) { return db.docs.filter((d) => d.course_id === courseId); }

/* ================= chunking ================= */

const HEADING_RE = /^([A-Z][A-Za-z0-9 &/\-']{2,60}:?|[A-Z0-9 &/\-']{4,60}|\d+\.\s+[A-Z].{2,60})$/;

function looksLikeHeading(line) {
  line = line.trim();
  if (!line || line.length > 64 || /[.,]$/.test(line)) return false;
  if (line.endsWith(":")) return true;
  return line.split(/\s+/).length <= 7 && HEADING_RE.test(line);
}

function chunkText(text, target = 900, overlapLines = 2) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const chunks = [];
  let current = [], currentLen = 0, section = "";
  const flush = () => {
    const body = current.join("\n").trim();
    if (body) chunks.push({ section, text: body });
    const tail = overlapLines && current.length > overlapLines ? current.slice(-overlapLines) : [];
    current = [...tail];
    currentLen = current.reduce((n, t) => n + t.length + 1, 0);
  };
  for (const line of lines) {
    if (looksLikeHeading(line)) {
      if (currentLen > 200) flush();
      section = line.trim().replace(/:$/, "");
    }
    current.push(line);
    currentLen += line.length + 1;
    if (currentLen >= target) flush();
  }
  flush();
  return chunks.filter((c) => c.text.length > 30);
}

/* ================= retrieval (BM25 + synonyms) ================= */

const STOPWORDS = new Set(["the","a","an","and","or","of","to","in","on","for","is","are","be","do","does","i","my","me","we","you","your","it","this","that","with","at","by","as","can","if","what","when","how","will","there","any"]);

const SYNONYMS = {
  exam:["test","midterm","final","prelim","quiz","exams"], test:["exam","midterm","quiz"],
  midterm:["exam","prelim"], final:["exam","cumulative"], quiz:["quizzes","exam"],
  due:["deadline","submit","submission","turn"], deadline:["due","date"],
  late:["penalty","extension","slip","grace"], extension:["late","extra","time"],
  grade:["grading","grades","weight","percent","breakdown"], grading:["grade","weight","percent"],
  curve:["curved","median","grading"], office:["hours","oh"], hours:["office"],
  attendance:["absence","absences","attend","miss","missed","participation"],
  miss:["absence","attendance","makeup","missed"], absent:["absence","attendance","miss"],
  book:["textbook","materials","reading"], textbook:["book","materials","isbn"],
  cheating:["integrity","plagiarism","honor","academic","collaboration"],
  plagiarism:["integrity","academic","honor"], collaborate:["collaboration","integrity","group","partner"],
  laptop:["laptops","devices","electronics","phone"], regrade:["regrades","grading","dispute","gradescope"],
  email:["contact","reach"], ta:["tas","assistant","grader","section"],
  professor:["instructor","prof","dr"], instructor:["professor","prof"], extra:["credit","bonus"],
  drop:["dropped","lowest"], makeup:["make","up","missed","alternate"],
  sick:["illness","ill","medical","absence","excused"], project:["paper","presentation","essay"],
  homework:["hw","assignment","assignments","problem","pset"], assignment:["homework","hw","due"],
};

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !STOPWORDS.has(t));
}

function expandQuery(question) {
  const weights = {};
  for (const tok of tokenize(question)) {
    weights[tok] = Math.max(weights[tok] || 0, 1.0);
    for (const syn of SYNONYMS[tok] || []) weights[syn] = Math.max(weights[syn] || 0, 0.4);
  }
  return weights;
}

function rankChunks(chunks, question, k = 10, charBudget = 14000) {
  if (!chunks.length) return [];
  const weights = expandQuery(question);
  const terms = Object.keys(weights);
  if (!terms.length) return [];
  const docs = chunks.map((c) => {
    const counts = {};
    for (const t of tokenize(c.text)) counts[t] = (counts[t] || 0) + 1;
    return counts;
  });
  const docLens = docs.map((d) => Object.values(d).reduce((a, b) => a + b, 0) || 1);
  const avgLen = docLens.reduce((a, b) => a + b, 0) / docLens.length;
  const n = docs.length;
  const df = {};
  for (const t of terms) df[t] = docs.filter((d) => d[t]).length;
  const k1 = 1.5, b = 0.75;
  const scored = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = d[t] || 0;
      if (!tf) continue;
      const idf = Math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5));
      score += weights[t] * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLens[i] / avgLen));
    }
    if (score > 0) scored.push([score, chunks[i]]);
  });
  scored.sort((a, b2) => b2[0] - a[0]);
  const picked = [];
  let used = 0;
  for (const [score, chunk] of scored.slice(0, k * 2)) {
    if (picked.length >= k || used + chunk.text.length > charBudget) continue;
    picked.push([score, chunk]);
    used += chunk.text.length;
  }
  return picked;
}

/* ================= heuristics: dates, facts, routing ================= */

const MONTHS = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
const MONTH_DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi;
const EVENT_KEYWORDS = /\b(exam|midterm|prelim|final|quiz|due|deadline|project|paper|presentation|essay|homework|hw|assignment|problem set|pset|lab report|report|test)\b/i;

function classifyKind(text) {
  const t = text.toLowerCase();
  if (/\b(exam|midterm|prelim|final|test)\b/.test(t)) return "exam";
  if (t.includes("quiz")) return "quiz";
  if (/\b(project|paper|presentation|essay)\b/.test(t)) return "project";
  return "assignment";
}

function pickYear(month, day, explicitYear, today) {
  if (explicitYear) {
    let y = parseInt(explicitYear, 10);
    if (y < 100) y += 2000;
    const d = new Date(y, month - 1, day);
    return d.getMonth() === month - 1 ? y : null;
  }
  const lo = new Date(today); lo.setDate(lo.getDate() - 120);
  const hi = new Date(today); hi.setDate(hi.getDate() + 330);
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const cand = new Date(y, month - 1, day);
    if (cand.getMonth() !== month - 1) continue;
    if (cand >= lo && cand <= hi) return y;
  }
  return null;
}

function extractEventsHeuristic(text) {
  const today = new Date();
  const events = [], seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !EVENT_KEYWORDS.test(line)) continue;
    const matches = [];
    for (const m of line.matchAll(MONTH_DATE_RE)) matches.push([MONTHS[m[1].toLowerCase()], parseInt(m[2], 10), m[3]]);
    for (const m of line.matchAll(NUMERIC_DATE_RE)) {
      const mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) matches.push([mo, da, m[3]]);
    }
    for (const [month, day, ey] of matches) {
      const year = pickYear(month, day, ey, today);
      if (!year) continue;
      const iso = `${year}-${pad(month)}-${pad(day)}`;
      let title = line.replace(/\s+/g, " ").slice(0, 110).replace(/^[\s\-–—:•*]+|[\s\-–—:•*]+$/g, "");
      const key = iso + "|" + title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const times = Array.from(line.matchAll(TIME_RE));
      let time = "";
      if (times.length) {
        const tm = times[0];
        let hour = parseInt(tm[1], 10);
        const minute = parseInt(tm[2], 10);
        let mer = (tm[3] || "").toLowerCase();
        if (!mer && hour <= 11 && times.some((t) => (t[3] || "").toLowerCase() === "pm")) mer = "pm";
        if (mer === "pm" && hour < 12) hour += 12;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) time = `${pad(hour)}:${pad(minute)}`;
      }
      events.push({ title, date: iso, time, kind: classifyKind(line) });
    }
  }
  return events;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PERCENT_LINE_RE = /^(.{2,60}?)[:\s.–—-]*(\d{1,3})\s?%/;

function linesMatching(lines, re, limit = 2) {
  return lines.filter((l) => re.test(l)).map((l) => l.replace(/\s+/g, " ").trim()).slice(0, limit).join(" | ");
}

function emptyFacts() {
  return { instructor:"", instructor_email:"", office_hours:"", location_or_modality:"", late_policy:"",
    attendance_policy:"", exam_policy:"", academic_integrity:"", textbook:"", grading:[], tas:[], other_key_policies:[] };
}

function extractFactsHeuristic(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f = emptyFacts();
  for (const ln of lines) {
    const low = ln.toLowerCase();
    if (!f.instructor && /^\s*(instructor|professor)\b/.test(low)) {
      f.instructor = ln.replace(/^(instructor|professor)\s*:?\s*/i, "");
      const m = ln.match(EMAIL_RE);
      if (m) f.instructor_email = m[0];
    }
    if (!f.instructor_email && (low.includes("instructor") || low.includes("professor") || low.includes("email"))) {
      const m = ln.match(EMAIL_RE);
      if (m) f.instructor_email = m[0];
    }
    if (low.includes("office hour") && f.office_hours.length < 200) {
      f.office_hours = (f.office_hours + " | " + ln).replace(/^\s*\|\s*/, "");
    }
    if (/^\s*(ta|teaching assistant|head ta|grader)s?\b/i.test(ln)) {
      const m = ln.match(EMAIL_RE);
      f.tas.push({ name: ln.replace(/^(head\s+)?(ta|teaching assistant|grader)s?\s*:?\s*/i, "").slice(0, 80), email: m ? m[0] : "", hours: "" });
    }
    const pm = ln.match(PERCENT_LINE_RE);
    if (pm && f.grading.length < 12) {
      const component = pm[1].replace(/\s+/g, " ").replace(/^[\s\-:*•–]+|[\s\-:*•–]+$/g, "");
      const noise = /\b(late|loses?|lose|per day|answering|penalt|deduct|reduce[sd]?|miss)\b/i.test(component);
      if (component.length >= 2 && component.length <= 45 && !noise) {
        f.grading.push({ component, weight: pm[2] + "%" });
      }
    }
  }
  f.late_policy = linesMatching(lines, /\b(late|slip day|grace period)\b/i, 3);
  f.attendance_policy = linesMatching(lines, /\b(attendance|absence|iclicker|participation required)\b/i, 2);
  f.exam_policy = linesMatching(lines, /\b(makeup|make-up|missed exam|exam conflict|conflict with)\b/i, 2);
  f.academic_integrity = linesMatching(lines, /\b(academic integrity|plagiarism|honor code|ai tools|chatgpt)\b/i, 2);
  f.textbook = linesMatching(lines, /\b(textbook|required text|isbn)\b/i, 2);
  f.location_or_modality = linesMatching(lines, /\b(lecture[s]?:|meets|room|hall \d|building|zoom)\b/i, 1);
  return f;
}

const ROUTE_RULES = [
  ["professor", /\b(extension|extenuating|sick|illness|ill\b|medical|emergency|family|funeral|accommodat|disability|conflict with (the )?(exam|midterm|final)|miss(ed|ing)? (the )?(exam|midterm|final)|grade dispute|final grade|incomplete|excused)\b/i],
  ["ta", /\b(homework|hw\b|assignment|problem set|pset|lab\b|regrade|rubric|partial credit|how (do|to) (i )?submit|autograder|office hours)\b/i],
  ["classmate_or_lms", /\b(notes|recording|slides|lecture video|canvas|gradescope|moodle|blackboard|brightspace|log ?in|upload|website down)\b/i],
  ["registrar_or_advisor", /\b(drop|add deadline|enroll|register|swap|credit hours|prerequisite|major|minor|transcript|pass.?fail|audit)\b/i],
];

function routeQuestion(question, foundAnswer, hasTas) {
  for (const [route, re] of ROUTE_RULES) {
    if (re.test(question)) {
      if (route === "ta" && !hasTas) {
        return ["professor", "This is a course-logistics question; with no TA listed, the instructor is the right contact."];
      }
      const reasons = {
        professor: "Personal circumstances, exam conflicts, and grade decisions are instructor calls.",
        ta: "Assignment and grading logistics are usually handled by the TAs first.",
        classmate_or_lms: "This sounds like course-site or missed-class material — a classmate or the LMS will be faster.",
        registrar_or_advisor: "This is about enrollment/degree rules, which live outside any one course.",
      };
      return [route, reasons[route]];
    }
  }
  if (foundAnswer) return ["none", "Your syllabus covers this — no need to email anyone."];
  if (hasTas) return ["ta", "Your materials don't cover this. Course staff would know; start with a TA, and escalate to the professor if needed."];
  return ["professor", "Your materials don't cover this, so the instructor is the best person to ask."];
}

/* ================= ICS ================= */

function icsEscape(v) { return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
function icsUnescape(v) { return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\"); }
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let chunk = line;
  while (enc.encode(chunk).length > 74) {
    let cut = Math.min(74, chunk.length);
    while (cut > 1 && enc.encode(chunk.slice(0, cut)).length > 74) cut--;
    out.push(chunk.slice(0, cut));
    chunk = " " + chunk.slice(cut);
  }
  out.push(chunk);
  return out.join("\r\n");
}

function generateIcs(events, calName) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MySyllabi//Course Calendar//EN",
    "CALSCALE:GREGORIAN", "X-WR-CALNAME:" + icsEscape(calName)];
  for (const ev of events) {
    const ymd = ev.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:evt-${ev.id}@mysyllabi.local`, `DTSTAMP:${stamp}`);
    if (ev.time) {
      const hhmm = ev.time.replace(":", "");
      lines.push(`DTSTART:${ymd}T${hhmm}00`);
      const [y, m, d] = ev.date.split("-").map(Number);
      const [h, mi] = ev.time.split(":").map(Number);
      const end = new Date(y, m - 1, d, h + 1, mi);
      lines.push(`DTEND:${isoOf(end).replace(/-/g, "")}T${pad(end.getHours())}${pad(end.getMinutes())}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${addDays(ev.date, 1).replace(/-/g, "")}`);
    }
    const course = ev.course_id ? courseById(ev.course_id) : null;
    lines.push("SUMMARY:" + icsEscape(course ? `[${course.code}] ${ev.title}` : ev.title));
    if (ev.details) lines.push("DESCRIPTION:" + icsEscape(ev.details));
    lines.push("CATEGORIES:" + (ev.kind || "other").toUpperCase(), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function parseIcs(text) {
  const today = new Date();
  const lo = new Date(today); lo.setDate(lo.getDate() - 60);
  const hi = new Date(today); hi.setDate(hi.getDate() + 420);
  const unfolded = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && unfolded.length) unfolded[unfolded.length - 1] += raw.slice(1);
    else unfolded.push(raw);
  }
  const events = [];
  let cur = null;
  for (const line of unfolded) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VEVENT")) { cur = { title: "", date: "", time: "", details: "" }; continue; }
    if (upper.startsWith("END:VEVENT")) {
      if (cur && cur.title && cur.date) {
        const [y, m, d] = cur.date.split("-").map(Number);
        const when = new Date(y, m - 1, d);
        if (when >= lo && when <= hi) { cur.kind = classifyKind(cur.title); events.push(cur); }
      }
      cur = null; continue;
    }
    if (!cur || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const name = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1).trim();
    if (name === "SUMMARY") cur.title = icsUnescape(value).slice(0, 140);
    else if (name === "DESCRIPTION") cur.details = icsUnescape(value).slice(0, 400);
    else if (name === "DTSTART") {
      const m = value.match(/^(\d{8})(T(\d{2})(\d{2})\d{2}Z?)?$/);
      if (m) {
        cur.date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
        if (m[2]) cur.time = `${m[3]}:${m[4]}`;
      }
    }
  }
  return events;
}

/* ================= file extraction ================= */

async function extractFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    if (!window.pdfjsLib) throw new Error("PDF reader didn't load (offline?). Paste the text instead.");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => it.str).join(" ").replace(/ {3,}/g, "\n"));
    }
    const text = pages.join("\n");
    if (text.trim().length < 40) {
      throw new Error("That PDF has no extractable text — probably a scanned image. Paste the syllabus text instead.");
    }
    return { text, kind: "pdf" };
  }
  if (name.endsWith(".docx")) {
    if (!window.mammoth) throw new Error("Word reader didn't load (offline?). Paste the text instead.");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: result.value, kind: "docx" };
  }
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return { text: await file.text(), kind: "txt" };
  }
  throw new Error("Unsupported file type. Upload a .pdf, .docx, .txt, or .md file.");
}

/* ================= Claude (browser -> Anthropic API) ================= */

const QA_SYSTEM = `You are MySyllabi, a study assistant that answers a student's question using ONLY the numbered excerpts provided from their own uploaded course materials (excerpt [0], when present, is their extracted deadline calendar).

HARD RULES — these define the product and are non-negotiable:
1. GROUNDING. Every factual claim must come from the provided excerpts. Never use outside knowledge about the school, professor, course, or "typical" policies. Never guess, infer beyond the text, or fill gaps.
2. If the excerpts don't contain the answer: status="not_found". Say plainly their materials don't cover it, and answer nothing beyond that. Do not speculate about what the policy "probably" is.
3. If the excerpts cover only part of the question: status="partial". Answer the covered part, and state exactly which part their materials don't address.
4. CITATIONS. Support each claim with the excerpt id and a short VERBATIM quote (an exact contiguous substring of that excerpt, under 200 characters — copy it character-for-character). An answer with status "answered" must include at least one citation. If you cannot quote it, you cannot claim it.
5. DATES. Today is {today}. Resolve relative phrasing ("next week", "this Friday") into explicit dates using excerpt dates.
6. If materials from multiple courses could apply and the question doesn't say which, ask which course they mean (status="partial") instead of mixing courses. When the answer is course-specific, name the course code.

ROUTING — after answering, tell the student who (if anyone) to contact, using what their materials indicate:
- "none": their materials fully answer it; note there's no need to email anyone.
- "ta": assignment/homework clarifications, grading of specific problems, regrade mechanics, lab or section logistics — when the materials mention TAs/graders or direct such questions to them.
- "professor": personal circumstances (illness, emergencies, extensions, accommodations), exam conflicts, absences beyond policy, grade disputes, anything the materials say to email the instructor about.
- "classmate_or_lms": missed-lecture notes, whether something was posted, LMS/tech issues.
- "registrar_or_advisor": enrollment, drop/add, degree requirements — outside any course's syllabus.
If status is "not_found", pick the route for whoever WOULD know. In route_reason (one or two sentences), explain the pick; if the materials name the right contact (a specific person or email), include it.

CONFIDENCE: "high" when a quote directly and unambiguously answers; "medium" when you had to combine or interpret excerpts; "low" when the support is thin.

STYLE: friendly and brief — a knowledgeable classmate, not a lawyer. Lead with the answer. Plain text only (no markdown headers).`;

const ANSWER_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "answer", "citations", "route", "route_reason", "confidence"],
  properties: {
    status: { type: "string", enum: ["answered", "partial", "not_found"] },
    answer: { type: "string" },
    citations: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["excerpt_id", "quote"],
      properties: { excerpt_id: { type: "integer" }, quote: { type: "string" } } } },
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
- other_key_policies: up to 6 short standout policies a student would want surfaced (e.g. "No extra credit", "3 slip days total", "Laptops in back rows only").
- events: every dated deliverable or exam a student would put on a calendar. date must be ISO YYYY-MM-DD. Today is {today}; the course term is "{term}". If a date has no year, infer it from the term/today so it lands in the plausible academic window. Skip anything whose date you cannot resolve to a specific day — do not guess dates. time is "HH:MM" 24-hour if stated, else "".
- Do not create events for ranges like "Week 3" or "TBA".`;

const FACTS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["facts", "events"],
  properties: {
    facts: { type: "object", additionalProperties: false,
      required: ["instructor","instructor_email","office_hours","location_or_modality","grading","late_policy","attendance_policy","exam_policy","academic_integrity","textbook","tas","other_key_policies"],
      properties: {
        instructor: { type: "string" }, instructor_email: { type: "string" },
        office_hours: { type: "string" }, location_or_modality: { type: "string" },
        grading: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["component", "weight"], properties: { component: { type: "string" }, weight: { type: "string" } } } },
        late_policy: { type: "string" }, attendance_policy: { type: "string" },
        exam_policy: { type: "string" }, academic_integrity: { type: "string" }, textbook: { type: "string" },
        tas: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["name", "email", "hours"], properties: { name: { type: "string" }, email: { type: "string" }, hours: { type: "string" } } } },
        other_key_policies: { type: "array", items: { type: "string" } },
      } },
    events: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["title", "date", "time", "kind"],
      properties: { title: { type: "string" }, date: { type: "string" }, time: { type: "string" },
        kind: { type: "string", enum: ["exam", "quiz", "assignment", "project", "class", "other"] } } } },
  },
};

const EMAIL_SYSTEM = `You draft a short, respectful email from a student to their course staff.

Rules:
- Ground it in the provided context: mention that they checked the syllabus and what it does/doesn't say (only if the context supports that). Never invent policies, dates, or names.
- If the context names the right recipient, use their name and put their email in to_hint; otherwise to_hint is a description like "your TA (see course site)".
- 60-140 words. Specific subject line including the course code. Professional but natural student voice — no groveling, no filler.
- Use [square-bracket placeholders] for anything only the student knows (their section, dates, attachments).
- Sign with the student's name. Plain text.`;

const EMAIL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["subject", "body", "to_hint"],
  properties: { subject: { type: "string" }, body: { type: "string" }, to_hint: { type: "string" } },
};

async function callClaude({ system, user, maxTokens, effort, schema }) {
  if (!db.apiKey) throw new Error("no-key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": db.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
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
    const msg = (data.error && data.error.message) || `API error ${res.status}`;
    if (res.status === 401) throw new Error("Your API key was rejected — check it in Settings.");
    throw new Error(msg);
  }
  if (data.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
}

function normalizeWs(s) { return s.replace(/\s+/g, " ").trim().toLowerCase(); }

function verifyCitations(citations, excerpts) {
  const byId = {}, labels = {};
  for (const ex of excerpts) { byId[ex.id] = normalizeWs(ex.text); labels[ex.id] = ex.label; }
  return (citations || []).slice(0, 12).map((c) => {
    const quote = (c.quote || "").trim();
    return {
      excerpt_id: c.excerpt_id,
      label: labels[c.excerpt_id] || `excerpt ${c.excerpt_id}`,
      quote: quote.slice(0, 300),
      verified: Boolean(quote) && (byId[c.excerpt_id] || "").includes(normalizeWs(quote)),
    };
  });
}

/* ================= domain operations ================= */

function chunksForScope(courseId) {
  const chunks = [];
  for (const doc of db.docs) {
    if (courseId && doc.course_id !== courseId) continue;
    const course = courseById(doc.course_id);
    for (const ch of doc.chunks) {
      chunks.push({ text: ch.text, section: ch.section, code: course ? course.code : "?", filename: doc.filename });
    }
  }
  return chunks;
}

function dedupeKey(t) { return t.toLowerCase().split(/\s+/).join(" ").slice(0, 60); }

function addEvents(courseId, docId, events, source) {
  const existing = new Set(db.events.filter((e) => e.course_id === courseId)
    .map((e) => e.date + "|" + dedupeKey(e.title)));
  let added = 0;
  for (const ev of events.slice(0, 150)) {
    const key = ev.date + "|" + dedupeKey(ev.title);
    if (existing.has(key)) continue;
    existing.add(key);
    db.events.push({ id: uid(), course_id: courseId, document_id: docId, title: ev.title.slice(0, 140),
      date: ev.date, time: ev.time || "", kind: ev.kind || "other", source, details: ev.details || "" });
    added++;
  }
  return added;
}

async function ingestDocument(course, filename, text, kind) {
  text = text.trim();
  if (text.length < 40) throw new Error("That document looks empty — nothing to index.");
  const doc = { id: uid(), course_id: course.id, filename, kind, text,
    chunks: chunkText(text), facts: null, facts_mode: "heuristic",
    uploaded_at: isoToday() };
  let events = [];
  if (db.apiKey) {
    try {
      const result = await callClaude({
        system: FACTS_SYSTEM.replace("{today}", isoToday()).replace("{term}", course.term || "not specified"),
        user: `SYLLABUS for ${course.code}:\n\n${text.slice(0, 60000)}`,
        maxTokens: 12000, effort: "medium", schema: FACTS_SCHEMA,
      });
      doc.facts = result.facts;
      doc.facts_mode = "ai";
      events = (result.events || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
        .map((e) => ({ ...e, time: /^\d{2}:\d{2}$/.test(e.time) ? e.time : "" }));
    } catch (_e) { /* fall through to heuristics */ }
  }
  if (!doc.facts) {
    doc.facts = extractFactsHeuristic(text);
    events = extractEventsHeuristic(text);
  }
  db.docs.push(doc);
  const eventsAdded = addEvents(course.id, doc.id, events, "auto");
  save();
  return { doc, eventsAdded };
}

function calendarExcerpt() {
  const today = isoToday(), horizon = addDays(today, 120);
  const rows = db.events.filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 45);
  if (!rows.length) return null;
  const lines = rows.map((e) => {
    const c = e.course_id ? courseById(e.course_id) : null;
    return `${e.date}${e.time ? " " + e.time : ""} (${e.kind}) ${c ? "[" + c.code + "] " : ""}${e.title}`;
  });
  return { id: 0, label: "Your deadline calendar (next ~4 months, extracted from your materials)", text: lines.join("\n") };
}

async function doAsk(question, courseId) {
  const chunks = chunksForScope(courseId);
  if (!chunks.length) throw new Error("Upload at least one syllabus first — I only answer from your materials.");
  const ranked = rankChunks(chunks, question);
  const excerpts = [];
  const cal = calendarExcerpt();
  if (cal) excerpts.push(cal);
  ranked.forEach(([score, ch], i) => {
    excerpts.push({ id: i + 1, label: `${ch.code} — ${ch.section || ch.filename}`, text: ch.text, score });
  });

  let result;
  if (db.apiKey) {
    try {
      const scope = courseId ? `the student limited this question to ${courseById(courseId).code}` : "all of the student's courses";
      let prompt = "EXCERPTS FROM THE STUDENT'S MATERIALS:\n\n" +
        excerpts.map((ex) => `[${ex.id}] ${ex.label}\n${ex.text}`).join("\n\n---\n\n");
      const history = db.chats.slice(-4).map((c) => `Q: ${c.question}\nA: ${(c.answer.answer || "").slice(0, 400)}`);
      if (history.length) prompt += `\n\nRECENT CONVERSATION (context only — NOT a source, never cite it):\n${history.join("\n")}`;
      prompt += `\n\nSCOPE: ${scope}\nSTUDENT'S QUESTION: ${question}`;
      result = await callClaude({
        system: QA_SYSTEM.replace("{today}", new Date().toDateString()),
        user: prompt, maxTokens: 6000, effort: "medium", schema: ANSWER_SCHEMA,
      });
      result.citations = verifyCitations(result.citations, excerpts);
      result.unverified = result.status === "answered" && !result.citations.some((c) => c.verified);
      result.mode = "ai";
    } catch (e) {
      result = heuristicAnswer(question, excerpts);
      result.mode = "heuristic";
      result.note = `AI call failed (${e.message}) — showing keyword matches instead.`;
    }
  } else {
    result = heuristicAnswer(question, excerpts);
    result.mode = "heuristic";
  }
  db.chats.push({ id: uid(), course_id: courseId || null, question, answer: result, created_at: isoToday() });
  if (db.chats.length > 80) db.chats = db.chats.slice(-80);
  save();
  return result;
}

function heuristicAnswer(question, excerpts) {
  const passages = excerpts.filter((e) => e.id !== 0);
  const found = passages.length > 0 && (passages[0].score || 0) >= 1.2;
  const hasTas = db.docs.some((d) => d.facts && d.facts.tas && d.facts.tas.length) ||
    passages.slice(0, 3).some((p) => /\bTAs?\b/.test(p.text));
  const [route, reason] = routeQuestion(question, found, hasTas);
  return {
    status: found ? "partial" : "not_found",
    answer: found
      ? "AI answers are off (no API key set in Settings), so here are the passages from your own materials that best match your question — the answer is very likely in the first one."
      : "Nothing in your uploaded materials matches this question, and I never guess. It may simply not be covered by your syllabi.",
    citations: found ? passages.slice(0, 3).map((p) => ({ excerpt_id: p.id, label: p.label, quote: p.text.slice(0, 400), verified: true })) : [],
    route, route_reason: reason, confidence: "low",
  };
}

async function draftEmail({ question, recipient, course_id, context }) {
  const course = course_id ? courseById(course_id) : null;
  const code = course ? course.code : "your class";
  if (db.apiKey) {
    try {
      const draft = await callClaude({
        system: EMAIL_SYSTEM,
        user: `Student: [your name]\nCourse: ${code}\nRecipient type: ${recipient}\nWhat they want to ask about: ${question}\n\nRelevant material from their syllabus/answer:\n${(context || "").slice(0, 6000)}`,
        maxTokens: 3000, effort: "low", schema: EMAIL_SCHEMA,
      });
      draft.mode = "ai";
      return draft;
    } catch (_e) { /* template fallback */ }
  }
  let toHint = "";
  if (course) {
    for (const d of docsOf(course.id)) {
      if (!d.facts) continue;
      if (recipient === "ta" && d.facts.tas && d.facts.tas.length) toHint = d.facts.tas[0].email || "";
      if (!toHint) toHint = d.facts.instructor_email || "";
      if (toHint) break;
    }
  }
  const words = question.split(/\s+/);
  const topic = words.slice(0, 9).join(" ") + (words.length > 9 ? "…" : "");
  return {
    mode: "template",
    subject: (course ? `[${code}] ` : "") + (topic ? `Question: ${topic}` : "Quick question"),
    to_hint: toHint || (recipient === "ta" ? "your TA (see course site)" : "your instructor"),
    body: `Dear ${recipient === "professor" ? "Professor [name]" : "[TA's name]"},\n\n` +
      `${course ? `I'm in your ${code} class this term.` : "I'm in your class this term."} I checked the syllabus first, but I still wanted to ask: ${question}\n\n` +
      `[Add one sentence of context — your situation, section, or dates.]\n\nThank you for your time,\n[Your name]`,
  };
}

/* ================= demo data ================= */

const DEMO = [
  { code: "CS 2110", title: "Data Structures & OO Programming", instructor: "Prof. Elena Marchetti", color: "#4f46e5",
    text: `CS 2110: Data Structures and Object-Oriented Programming
Big Hill University — Fall 2026

Instructor: Prof. Elena Marchetti (elena.marchetti@bighill.edu)
Office Hours: Tuesdays 2:00-4:00 pm, Rhodes Hall 402, or by appointment
Lectures: Mon/Wed/Fri 10:10-11:00 am, Statler Auditorium

Teaching Assistants
TA: Kevin Zhao (kzhao@bighill.edu), office hours Thursdays 5:00-7:00 pm, Rhodes 574
TA: Priya Nair (pnair@bighill.edu), office hours Mondays 3:00-5:00 pm, Rhodes 574
Questions about homework grading, rubrics, and regrades go to the TAs first, not the instructor.

Textbook
Textbook: "Data Structures and Abstractions with Java" — the full text is FREE online through the university library. No purchase is required.

Grading
Homework: 30%
Labs: 10%
Prelim 1: 15%
Prelim 2: 15%
Final Exam: 25%
Participation: 5%

Exam Schedule
Prelim 1: Thursday, October 1, 2026, 7:30-9:00 pm, Barton Hall
Prelim 2: Thursday, November 5, 2026, 7:30-9:00 pm, Barton Hall
Final Exam: Monday, December 14, 2026, 9:00 am
If you have a conflict with an evening prelim, email Prof. Marchetti at least two weeks before the exam date.
Makeup exams are only given for documented illness or emergencies.

Homework Deadlines
Homework 1 due Friday, September 4, 2026 at 11:59 pm
Homework 2 due Friday, September 18, 2026 at 11:59 pm
Homework 3 due Friday, October 9, 2026 at 11:59 pm
Homework 4 due Friday, October 23, 2026 at 11:59 pm
Homework 5 due Friday, November 13, 2026 at 11:59 pm
Homework 6 due Friday, December 4, 2026 at 11:59 pm

Late Policy
You have 3 slip days for the semester, applied automatically in whole-day units.
After slip days are used, late homework loses 10% per day and is not accepted more than 3 days late. Slip days cannot be used on labs or exams.
Extensions beyond slip days are granted only by the instructor for documented illness, family emergencies, or university conflicts.

Regrades
Regrade requests are submitted through Gradescope within 7 days of grades being released and are handled by the TAs.

Extra Credit
There is no extra credit in this course.

Academic Integrity
All submitted code must be written by you alone. Using AI assistants to generate homework solutions is a violation of the academic integrity code.` },
  { code: "PSYC 1101", title: "Introduction to Psychology", instructor: "Dr. Sam Okafor", color: "#0d9488",
    text: `PSYC 1101: Introduction to Psychology
Big Hill University — Fall 2026

Instructor: Dr. Sam Okafor (sam.okafor@bighill.edu)
Office Hours: Wednesdays 10:00 am-12:00 pm, Uris Hall 211
Lectures: Tue/Thu 1:25-2:40 pm, Bailey Hall

Head TA: Maria Voss (mvoss@bighill.edu) — contact Maria for section changes, quiz issues, and SONA research-credit questions.

Grading
Prelim exams (3): 45%
Cumulative final exam: 25%
Weekly online quizzes: 15%
iClicker participation: 10%
Research participation (SONA): 5%

Exam Dates
Prelim 1: Thursday, September 24, 2026, in class
Prelim 2: Thursday, October 22, 2026, in class
Prelim 3: Thursday, November 19, 2026, in class
Final Exam: Wednesday, December 16, 2026, 2:00 pm
There are NO makeup prelims. If you miss a prelim with a documented, university-approved excuse, its weight moves to the final exam. Contact Dr. Okafor about excused absences.

Weekly Quizzes
A short online quiz opens on Canvas each Friday and is due Sunday at 11:59 pm.
Quizzes cannot be submitted late for any reason; your two lowest quiz scores are dropped.

Attendance
Attendance is tracked through iClicker responses in lecture. You can miss up to 5 lectures with no penalty; each additional absence reduces your participation grade.

Research Participation
You must complete 4 SONA research credits by Friday, December 4, 2026.

Academic Integrity
Quizzes are open-book but individual. Sharing quiz answers in group chats is an academic integrity violation.` },
  { code: "MATH 2400", title: "Linear Algebra", instructor: "Prof. Daniel Reyes", color: "#d97706",
    text: `MATH 2400: Linear Algebra
Big Hill University — Fall 2026

Instructor: Prof. Daniel Reyes (dreyes@bighill.edu)
Office Hours: Mondays 3:00-4:30 pm, Malott Hall 588
Lectures: Mon/Wed/Fri 12:20-1:10 pm, Malott 251

TA: course TAs hold drop-in help hours every weekday 4:00-6:00 pm in the Math Support Center (Malott 210).

Grading
Problem Sets: 25%
Midterm 1: 20%
Midterm 2: 20%
Final Exam: 30%
Participation: 5%
Course grades are curved so that the class median lands at B/B+.

Problem Sets
Problem sets are due Fridays at 5:00 pm on Gradescope, starting Friday, September 11, 2026. Late problem sets are NOT accepted — this is why the lowest score is dropped.

Exams
Midterm 1: Thursday, October 8, 2026, in class
Midterm 2: Thursday, November 12, 2026, 7:30-9:00 pm, Olin Hall 155 (evening exam)
Final Exam: Friday, December 18, 2026, 9:00 am
If you have a conflict with the November 12 evening midterm, you must email Prof. Reyes by October 29, 2026.
No calculators, notes, or formula sheets are allowed on any exam.

Missed Exams
A missed midterm with a documented emergency shifts its weight to the final exam.

Academic Integrity
You may collaborate on problem sets in groups of up to 3, but each student writes up solutions independently.` },
  { code: "PHIL 1010", title: "Introduction to Ethics", instructor: "Dr. Naomi Feld", color: "#db2777",
    text: `PHIL 1010: Introduction to Ethics
Big Hill University — Fall 2026

Instructor: Dr. Naomi Feld (nfeld@bighill.edu)
Office Hours: Wednesdays 1:00-3:00 pm, Goldwin Smith 328
Lectures: Tue/Thu 11:40 am-12:55 pm, Goldwin Smith 132
This course has no TAs; all questions go to Dr. Feld.

Grading
Essay 1: 25%
Essay 2: 25%
Final Exam: 30%
Participation: 20%

Deadlines
Essay 1 due Friday, October 2, 2026 at 5:00 pm
Essay 2 due Friday, November 13, 2026 at 5:00 pm
Final Exam: Monday, December 14, 2026, 9:00 am

Late Policy
Late essays lose one-third of a letter grade per day.
No extensions are granted within 48 hours of a deadline except for documented emergencies - email Dr. Feld as early as possible.

Attendance
Attendance is required. You may take 3 unexcused absences; further absences reduce your participation grade by 2% each.

Academic Integrity
Essays are checked for plagiarism and AI generation. Cite everything.` },
];

async function loadDemo() {
  for (const spec of DEMO) {
    if (db.courses.some((c) => c.code === spec.code)) continue;
    const course = { id: uid(), code: spec.code, title: spec.title, term: "Fall 2026",
      instructor: spec.instructor, color: spec.color };
    db.courses.push(course);
    await ingestDocument(course, spec.code.toLowerCase().replace(/\s+/g, "") + "-syllabus.txt", spec.text, "txt");
  }
  save();
}

/* ================= views ================= */

let view = "dashboard";
let askCourse = "";
let calMonth = null;
let selectedDay = null;

function renderAiPill() {
  const pill = $("#ai-pill");
  if (db.apiKey) {
    pill.className = "ai-pill on";
    pill.textContent = `✦ AI answers on · ${MODEL}`;
  } else {
    pill.className = "ai-pill off";
    pill.textContent = "✦ Keyword mode — add API key";
  }
}

function navigate(v, param) {
  view = v;
  $$("#nav .nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === v));
  if (v === "dashboard") renderDashboard();
  else if (v === "course") renderCourse(param);
  else if (v === "ask") renderAsk();
  else if (v === "calendar") renderCalendar();
  else if (v === "settings") renderSettings();
}
window.navigate = navigate;

/* ---------- dashboard ---------- */

function renderDashboard() {
  const today = isoToday(), horizon = addDays(today, 14);
  const upcoming = db.events.filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
  const upHtml = upcoming.length ? `
    <div class="upcoming-strip"><h3>Next 14 days</h3><div class="up-list">${upcoming.map((e) => {
      const c = e.course_id ? courseById(e.course_id) : null;
      return `<div class="up-item"><div class="d">${fmtDate(e.date)}${e.time ? " · " + esc(e.time) : ""}</div>
        <div class="t">${KIND_ICONS[e.kind] || "📅"} ${c ? `<b>${esc(c.code)}</b> ` : ""}${esc(e.title)}</div></div>`;
    }).join("")}</div></div>` : "";

  const welcome = !db.courses.length ? `
    <div class="card" style="margin-bottom:20px">
      <h3>👋 Welcome — here's the deal</h3>
      <p style="color:var(--ink-soft)">MySyllabi answers course questions <b>only from syllabi you upload</b> — with quotes to prove it — and tells you whether that email to your professor is even necessary. Everything you add stays in <b>this browser</b> on your device: no account, no server, nothing shared.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="load-demo">🎓 Load 4 demo courses</button>
        <button class="btn" id="add-course-btn2">+ Add your own course</button>
      </div>
    </div>` : "";

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Your courses</h1>
        <div class="sub">Upload each course's syllabus once — then ask questions instead of scrolling PDFs.</div></div>
      <button class="btn primary" id="add-course-btn">+ Add course</button>
    </div>
    ${welcome}${upHtml}
    <div class="course-grid">
      ${db.courses.map((c) => {
        const count = docsOf(c.id).length;
        const next = db.events.filter((e) => e.course_id === c.id && e.date >= today)
          .sort((a, b) => a.date.localeCompare(b.date))[0];
        return `<div class="card course-card" data-id="${c.id}">
          <div class="stripe" style="background:${esc(c.color)}"></div>
          <h3>${esc(c.code)}</h3><div class="ctitle">${esc(c.title || "")}</div>
          <div class="cmeta"><span class="chip">${count} doc${count === 1 ? "" : "s"}</span>
          ${next ? `<span class="chip accent">${KIND_ICONS[next.kind] || "📅"} ${fmtDate(next.date)}</span>` : ""}</div>
        </div>`;
      }).join("")}
      <div class="card add-card" id="add-course-card">+ Add a course</div>
    </div>`;

  $$(".course-card").forEach((el) => el.addEventListener("click", () => navigate("course", Number(el.dataset.id))));
  $("#add-course-btn").addEventListener("click", openAddCourse);
  $("#add-course-card").addEventListener("click", openAddCourse);
  const btn2 = $("#add-course-btn2");
  if (btn2) btn2.addEventListener("click", openAddCourse);
  const demoBtn = $("#load-demo");
  if (demoBtn) demoBtn.addEventListener("click", async () => {
    demoBtn.disabled = true; demoBtn.textContent = "Loading…";
    await loadDemo();
    toast("Demo courses loaded — try Ask!");
    renderDashboard();
  });
}

function openAddCourse() {
  const dots = COURSE_COLORS.map((c, i) =>
    `<span class="color-dot ${i === 0 ? "sel" : ""}" data-color="${c}" style="background:${c}"></span>`).join("");
  openModal(`
    <h3>Add a course</h3>
    <div class="field"><label>Course code *</label><input id="nc-code" placeholder="CS 2110"></div>
    <div class="field"><label>Title</label><input id="nc-title" placeholder="Data Structures"></div>
    <div class="row">
      <div class="field"><label>Term</label><input id="nc-term" placeholder="Fall 2026"></div>
      <div class="field"><label>Instructor</label><input id="nc-inst" placeholder="Prof. Smith"></div>
    </div>
    <div class="field"><label>Color</label><div class="color-dots">${dots}</div></div>
    <div class="modal-actions"><button class="btn" id="nc-cancel">Cancel</button>
    <button class="btn primary" id="nc-save">Add course</button></div>`);
  let color = COURSE_COLORS[db.courses.length % COURSE_COLORS.length];
  $$(".color-dot").forEach((dot) => dot.addEventListener("click", () => {
    $$(".color-dot").forEach((d) => d.classList.remove("sel"));
    dot.classList.add("sel"); color = dot.dataset.color;
  }));
  $("#nc-cancel").addEventListener("click", closeModal);
  $("#nc-save").addEventListener("click", () => {
    const code = $("#nc-code").value.trim().slice(0, 40);
    if (!code) return toast("Course code is required (e.g. CS 2110).", "err");
    const course = { id: uid(), code, title: $("#nc-title").value.trim().slice(0, 120),
      term: $("#nc-term").value.trim().slice(0, 40), instructor: $("#nc-inst").value.trim().slice(0, 80), color };
    db.courses.push(course); save(); closeModal();
    toast("Course added — now drop in its syllabus.");
    navigate("course", course.id);
  });
}

/* ---------- course detail ---------- */

function mergeFacts(docs) {
  const merged = { grading: [], tas: [], other_key_policies: [] };
  const keys = ["instructor","instructor_email","office_hours","location_or_modality","late_policy","attendance_policy","exam_policy","academic_integrity","textbook"];
  for (const doc of docs) {
    const f = doc.facts || {};
    for (const k of keys) if (!merged[k] && f[k]) merged[k] = f[k];
    if (!merged.grading.length && Array.isArray(f.grading)) merged.grading = f.grading;
    if (Array.isArray(f.tas)) merged.tas = merged.tas.concat(f.tas);
    if (Array.isArray(f.other_key_policies)) merged.other_key_policies = merged.other_key_policies.concat(f.other_key_policies);
  }
  return merged;
}

function renderCourse(courseId) {
  $$("#nav .nav-item").forEach((a) => a.classList.remove("active"));
  const c = courseById(courseId);
  if (!c) return navigate("dashboard");
  const docs = docsOf(courseId);
  const facts = mergeFacts(docs);
  const rows = [];
  const add = (k, v) => { if (v) rows.push({ k, v }); };
  add("Instructor", [facts.instructor, facts.instructor_email].filter(Boolean).join("\n"));
  add("Office hours", facts.office_hours);
  add("Where", facts.location_or_modality);
  if (facts.grading.length) add("Grading", facts.grading.map((g) => `${g.component}: ${g.weight || "—"}`).join("\n"));
  add("Late policy", facts.late_policy);
  add("Attendance", facts.attendance_policy);
  add("Exams / makeups", facts.exam_policy);
  add("Textbook", facts.textbook);
  if (facts.tas.length) add("TAs", facts.tas.map((t) => [t.name, t.email].filter(Boolean).join(" · ")).join("\n"));
  add("Integrity", facts.academic_integrity);
  if (facts.other_key_policies.length) add("Worth knowing", facts.other_key_policies.join("\n"));
  const events = db.events.filter((e) => e.course_id === courseId).sort((a, b) => a.date.localeCompare(b.date));
  const modeChip = docs.some((d) => d.facts_mode === "ai") ? `<span class="chip accent">AI-extracted</span>`
    : (docs.length ? `<span class="chip">auto-extracted</span>` : "");

  $("#view").innerHTML = `
    <div class="view-head">
      <div><a onclick="navigate('dashboard')">← Courses</a>
        <h1 style="color:${esc(c.color)}">${esc(c.code)}</h1>
        <div class="sub">${esc(c.title || "")}${c.term ? " · " + esc(c.term) : ""}${c.instructor ? " · " + esc(c.instructor) : ""}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="ask-this">💬 Ask about this course</button>
        <button class="btn danger" id="del-course">Delete</button></div>
    </div>
    <div class="card"><h3>Course card ${modeChip}</h3>
      ${rows.length ? `<div class="facts-grid">${rows.map((r) =>
        `<div class="fact"><div class="k">${esc(r.k)}</div><div class="v">${esc(r.v)}</div></div>`).join("")}</div>`
      : `<p class="muted">Upload a syllabus and I'll pull out the instructor, grading breakdown, late policy, and more.</p>`}
    </div>
    <div class="section-title"><h3>Syllabi & documents</h3>
      <button class="btn small" id="paste-btn">✏️ Paste text instead</button></div>
    <div class="card">
      ${docs.map((d) => `<div class="doc-row">
        <span>${d.kind === "pdf" ? "📕" : d.kind === "docx" ? "📘" : "📄"}</span>
        <div><div class="name">${esc(d.filename)}</div>
        <div class="meta">${esc(d.kind)} · added ${esc(d.uploaded_at)}</div></div>
        <div class="spacer"></div>
        <button class="btn small danger" data-del-doc="${d.id}">Remove</button></div>`).join("")
        || `<p class="muted" style="margin:4px">No documents yet.</p>`}
      <div class="dropzone" id="dropzone">
        <b>Drop a syllabus here</b> or <a id="browse">browse</a> — PDF, Word, or text.<br>
        <span style="font-size:12.5px">Deadlines are auto-added to your calendar; key policies fill the course card.</span>
        <input type="file" id="file-input" accept=".pdf,.docx,.txt,.md" style="display:none">
      </div>
    </div>
    <div class="section-title"><h3>Deadlines from this course (${events.length})</h3></div>
    <div class="card">
      ${events.map((e) => `<div class="ev-row"><span class="ev-date">${fmtDate(e.date)}</span>
        <span class="kind-dot" style="background:${esc(c.color)}"></span>
        <span>${KIND_ICONS[e.kind] || "📅"} ${esc(e.title)}${e.time ? ` <span class="muted">${esc(e.time)}</span>` : ""}</span></div>`).join("")
        || `<p class="muted" style="margin:4px">Nothing yet — they'll appear when you upload a syllabus.</p>`}
    </div>`;

  $("#ask-this").addEventListener("click", () => { askCourse = String(courseId); navigate("ask"); });
  $("#del-course").addEventListener("click", () => {
    if (!confirm(`Delete ${c.code} and all its documents/events?`)) return;
    db.courses = db.courses.filter((x) => x.id !== courseId);
    db.docs = db.docs.filter((x) => x.course_id !== courseId);
    db.events = db.events.filter((x) => x.course_id !== courseId);
    save(); toast("Course deleted."); navigate("dashboard");
  });
  $$("[data-del-doc]").forEach((b) => b.addEventListener("click", () => {
    const id = Number(b.dataset.delDoc);
    db.docs = db.docs.filter((d) => d.id !== id);
    db.events = db.events.filter((e) => e.document_id !== id);
    save(); toast("Document removed."); renderCourse(courseId);
  }));
  $("#paste-btn").addEventListener("click", () => openPaste(courseId));
  const dz = $("#dropzone"), fi = $("#file-input");
  $("#browse").addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => fi.files[0] && uploadFile(courseId, fi.files[0]));
  ["dragover", "dragenter"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadFile(courseId, f); });
}

async function uploadFile(courseId, file) {
  const dz = $("#dropzone");
  if (dz) dz.innerHTML = `<b>Reading ${esc(file.name)}…</b> extracting policies & deadlines`;
  try {
    const { text, kind } = await extractFile(file);
    const { doc, eventsAdded } = await ingestDocument(courseById(courseId), file.name, text, kind);
    toast(`Indexed ${doc.chunks.length} sections, added ${eventsAdded} calendar events.`);
  } catch (err) { toast(err.message, "err"); }
  renderCourse(courseId);
}

function openPaste(courseId) {
  openModal(`
    <h3>Paste syllabus text</h3>
    <div class="field"><label>Name it</label><input id="pt-title" placeholder="Syllabus (pasted)"></div>
    <div class="field"><label>Full text</label><textarea id="pt-text" rows="12" placeholder="Paste the whole syllabus…"></textarea></div>
    <div class="modal-actions"><button class="btn" id="pt-cancel">Cancel</button>
    <button class="btn primary" id="pt-save">Add & extract</button></div>`);
  $("#pt-cancel").addEventListener("click", closeModal);
  $("#pt-save").addEventListener("click", async () => {
    try {
      const text = $("#pt-text").value;
      if (text.trim().length < 40) return toast("Paste the full syllabus text first.", "err");
      const { doc, eventsAdded } = await ingestDocument(courseById(courseId),
        $("#pt-title").value.trim().slice(0, 80) || "Syllabus (pasted)", text, "pasted");
      closeModal();
      toast(`Indexed ${doc.chunks.length} sections, added ${eventsAdded} calendar events.`);
      renderCourse(courseId);
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ---------- ask ---------- */

const SUGGESTIONS = ["When is my next exam?", "What's the late policy for homework?", "How many lectures can I miss?",
  "Is there any extra credit?", "What should I do if I'm sick on an exam day?"];

function renderAsk() {
  const options = [`<option value="">All courses</option>`]
    .concat(db.courses.map((c) => `<option value="${c.id}" ${String(c.id) === askCourse ? "selected" : ""}>${esc(c.code)}</option>`));
  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Ask your syllabi</h1>
      <div class="sub">Answers come only from what you've uploaded — with quotes to prove it. If it's not in there, I'll say so.</div></div>
      ${db.chats.length ? `<button class="btn small" id="clear-chats">Clear history</button>` : ""}
    </div>
    <div class="chat-wrap">
      <div class="chat-scroll" id="chat-scroll">
        ${db.chats.length ? db.chats.map(renderExchange).join("") : `
          <div class="empty"><div class="big-ic">💬</div>Try one of these:</div>
          <div class="suggestions" style="justify-content:center">
            ${SUGGESTIONS.map((s) => `<span class="sug">${esc(s)}</span>`).join("")}</div>`}
      </div>
      <div class="ask-bar"><form class="ask-box" id="ask-form">
        <select id="ask-course">${options.join("")}</select>
        <input id="ask-input" placeholder="e.g. Can I use my slip days on labs?" autocomplete="off">
        <button class="btn primary" id="ask-send" type="submit">Ask</button>
      </form></div>
    </div>`;
  $$(".sug").forEach((sug) => sug.addEventListener("click", () => { $("#ask-input").value = sug.textContent; submitAsk(); }));
  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); submitAsk(); });
  $("#ask-course").addEventListener("change", (e) => { askCourse = e.target.value; });
  const clearBtn = $("#clear-chats");
  if (clearBtn) clearBtn.addEventListener("click", () => { db.chats = []; save(); renderAsk(); });
  bindAnswerActions();
  window.scrollTo(0, document.body.scrollHeight);
}

function renderExchange(chat) {
  return `<div class="msg-q">${esc(chat.question)}</div><div class="msg-a">${renderAnswer(chat.answer, chat)}</div>`;
}

function renderAnswer(a, chat) {
  const statusPill = a.status === "answered" ? `<span class="pill ok">✓ From your materials</span>`
    : a.status === "partial" ? `<span class="pill warn">◐ Partly covered</span>`
    : `<span class="pill bad">✕ Not in your materials</span>`;
  const routeLabels = { none: "📗 No email needed", ta: "🧑‍💻 Ask your TA", professor: "🎓 Ask your professor",
    classmate_or_lms: "👥 Classmate / course site", registrar_or_advisor: "🏛 Registrar / advisor" };
  const conf = a.mode === "ai" && a.confidence ? `<span class="pill" style="background:var(--slate-soft);color:var(--ink-soft)">confidence: ${esc(a.confidence)}</span>` : "";
  const cites = (a.citations || []).map((c) => `<div class="cite">
      <div class="src">📖 ${esc(c.label)} ${c.verified === false ? `<span class="unverified" title="This quote couldn't be matched verbatim to your documents.">⚠ unverified</span>` : ""}</div>
      <div class="quote">“${esc(c.quote)}”</div></div>`).join("");
  const citeLabel = ((a.citations || [])[0] || {}).label || "";
  const emailBtn = (a.route === "ta" || a.route === "professor")
    ? `<button class="btn small draft-email" data-q="${esc(chat.question)}" data-route="${a.route}"
        data-course="${chat.course_id || ""}" data-citelabel="${esc(citeLabel)}"
        data-ctx="${esc(((a.citations || []).map((c) => c.quote).join(" … ") + " " + (a.answer || "")).slice(0, 2000))}">
        ✉️ Draft the email for me</button>` : "";
  return `<div class="answer-card">
    <div class="answer-top">${statusPill}<span class="pill route-${esc(a.route)}">${routeLabels[a.route] || esc(a.route)}</span>${conf}</div>
    <div class="answer-text">${esc(a.answer)}</div>
    ${a.unverified ? `<div class="mode-note">⚠ Heads up: I couldn't verify this answer's quotes against your documents — double-check before relying on it.</div>` : ""}
    ${a.route_reason ? `<div class="route-reason"><b>Who to ask:</b> ${esc(a.route_reason)}</div>` : ""}
    ${cites ? `<details class="cites" ${a.mode === "heuristic" ? "open" : ""}><summary>${(a.citations || []).length} source ${a.mode === "heuristic" ? "passage" : "quote"}${(a.citations || []).length === 1 ? "" : "s"} from your documents</summary>${cites}</details>` : ""}
    ${a.note ? `<div class="mode-note">${esc(a.note)}</div>` : ""}
    ${a.mode === "heuristic" && !a.note ? `<div class="mode-note">Keyword mode (no API key set) — showing best-matching passages rather than a written answer. Add a key in Settings for full answers.</div>` : ""}
    <div class="answer-actions">${emailBtn}</div></div>`;
}

function bindAnswerActions() {
  $$(".draft-email").forEach((btn) => btn.addEventListener("click", () => {
    let courseId = btn.dataset.course ? Number(btn.dataset.course) : null;
    if (!courseId && btn.dataset.citelabel) {
      const code = btn.dataset.citelabel.split(" — ")[0].trim();
      const match = db.courses.find((c) => c.code === code);
      if (match) courseId = match.id;
    }
    openEmailDraft({ question: btn.dataset.q, recipient: btn.dataset.route, course_id: courseId, context: btn.dataset.ctx });
  }));
}

async function submitAsk() {
  const input = $("#ask-input");
  const question = input.value.trim();
  if (!question) return;
  const courseId = $("#ask-course").value ? Number($("#ask-course").value) : null;
  const scroll = $("#chat-scroll");
  if (scroll.querySelector(".empty")) scroll.innerHTML = "";
  scroll.insertAdjacentHTML("beforeend",
    `<div class="msg-q">${esc(question)}</div><div class="thinking" id="thinking">Checking your materials…</div>`);
  input.value = "";
  $("#ask-send").disabled = true;
  window.scrollTo(0, document.body.scrollHeight);
  try {
    const answer = await doAsk(question, courseId);
    $("#thinking").outerHTML = `<div class="msg-a">${renderAnswer(answer, { question, course_id: courseId })}</div>`;
    bindAnswerActions();
  } catch (err) {
    $("#thinking").outerHTML = `<div class="msg-a"><div class="answer-card"><span class="pill bad">✕ ${esc(err.message)}</span></div></div>`;
  } finally {
    $("#ask-send").disabled = false;
    window.scrollTo(0, document.body.scrollHeight);
  }
}

async function openEmailDraft(payload) {
  openModal(`<h3>Drafting your email…</h3><p class="muted">Grounded in your syllabus — nothing invented.</p>`);
  const draft = await draftEmail(payload);
  openModal(`
    <h3>✉️ Email draft <span class="chip">${draft.mode === "ai" ? "AI" : "template"}</span></h3>
    <div class="field"><label>To</label><input id="em-to" value="${esc(draft.to_hint)}"></div>
    <div class="field"><label>Subject</label><input id="em-subject" value="${esc(draft.subject)}"></div>
    <div class="field"><label>Body</label><textarea id="em-body" rows="10">${esc(draft.body)}</textarea></div>
    <p class="muted">Fill in the [placeholders], then paste into your mail app.</p>
    <div class="modal-actions"><button class="btn" id="em-close">Close</button>
    <button class="btn primary" id="em-copy">Copy to clipboard</button></div>`);
  $("#em-close").addEventListener("click", closeModal);
  $("#em-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${$("#em-subject").value}\n\n${$("#em-body").value}`);
      toast("Copied — paste it into your email app.");
    } catch (_e) { toast("Couldn't access clipboard — select and copy manually.", "err"); }
  });
}

/* ---------- calendar ---------- */

function renderCalendar() {
  if (!calMonth) { const now = new Date(); calMonth = new Date(now.getFullYear(), now.getMonth(), 1); }
  const year = calMonth.getFullYear(), month = calMonth.getMonth();
  const monthName = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const byDate = {};
  for (const e of db.events) (byDate[e.date] = byDate[e.date] || []).push(e);
  const firstDow = new Date(year, month, 1).getDay();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - firstDow + i);
    const iso = isoOf(d);
    const evs = (byDate[iso] || []);
    cells.push(`<div class="cal-cell ${d.getMonth() !== month ? "dim" : ""} ${iso === isoToday() ? "today" : ""}" data-date="${iso}">
      <div class="dnum">${d.getDate()}</div>
      ${evs.slice(0, 3).map((e) => {
        const c = e.course_id ? courseById(e.course_id) : null;
        return `<div class="cal-ev" style="background:${esc(c ? c.color : "#64748b")}" title="${esc(e.title)}">${e.time ? esc(e.time) + " " : ""}${c ? esc(c.code) + ": " : ""}${esc(e.title)}</div>`;
      }).join("")}
      ${evs.length > 3 ? `<div class="cal-more">+${evs.length - 3} more</div>` : ""}</div>`);
  }
  const dayEvents = selectedDay ? (byDate[selectedDay] || []) : [];

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Calendar</h1><div class="sub">Every deadline pulled from your syllabi, plus anything you add or import.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="import-ics">⇪ Import .ics</button>
        <button class="btn" id="export-ics">⬇ Export .ics</button>
        <button class="btn primary" id="add-event">+ Event</button></div>
    </div>
    <div class="cal-head">
      <button class="btn small" id="cal-prev">←</button><h2>${esc(monthName)}</h2>
      <button class="btn small" id="cal-next">→</button><button class="btn small" id="cal-today">Today</button>
    </div>
    <div class="cal-grid">
      ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${cells.join("")}
    </div>
    ${selectedDay ? `<div class="card day-panel"><h3>${fmtDate(selectedDay)}</h3>
      ${dayEvents.length ? dayEvents.map((e) => {
        const c = e.course_id ? courseById(e.course_id) : null;
        return `<div class="ev-row"><span class="kind-dot" style="background:${esc(c ? c.color : "#64748b")}"></span>
          <span>${KIND_ICONS[e.kind] || "📅"} ${c ? `<b>${esc(c.code)}</b> ` : ""}${esc(e.title)}
          ${e.time ? `<span class="muted">${esc(e.time)}</span>` : ""}
          <span class="chip" style="margin-left:6px">${esc(e.source)}</span></span>
          <span style="flex:1"></span>
          <button class="btn small danger" data-del-ev="${e.id}">Remove</button></div>`;
      }).join("") : `<p class="muted">Nothing on this day.</p>`}</div>` : ""}`;

  $("#cal-prev").addEventListener("click", () => { calMonth = new Date(year, month - 1, 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { calMonth = new Date(year, month + 1, 1); renderCalendar(); });
  $("#cal-today").addEventListener("click", () => { const now = new Date(); calMonth = new Date(now.getFullYear(), now.getMonth(), 1); renderCalendar(); });
  $$(".cal-cell").forEach((cell) => cell.addEventListener("click", () => { selectedDay = cell.dataset.date; renderCalendar(); }));
  $$("[data-del-ev]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    db.events = db.events.filter((ev) => ev.id !== Number(b.dataset.delEv));
    save(); renderCalendar();
  }));
  $("#add-event").addEventListener("click", openAddEvent);
  $("#import-ics").addEventListener("click", openImportIcs);
  $("#export-ics").addEventListener("click", () => {
    const blob = new Blob([generateIcs(db.events, "MySyllabi")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mysyllabi.ics";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Downloaded — import it into Google/Apple/Outlook calendar.");
  });
}

function courseOptions() {
  return [`<option value="">(no course)</option>`]
    .concat(db.courses.map((c) => `<option value="${c.id}">${esc(c.code)}</option>`)).join("");
}

function openAddEvent() {
  openModal(`
    <h3>Add event</h3>
    <div class="field"><label>Title *</label><input id="ne-title" placeholder="Essay 2 due"></div>
    <div class="row">
      <div class="field"><label>Date *</label><input id="ne-date" type="date" value="${selectedDay || isoToday()}"></div>
      <div class="field"><label>Time</label><input id="ne-time" type="time"></div></div>
    <div class="row">
      <div class="field"><label>Type</label><select id="ne-kind">
        <option value="assignment">Assignment</option><option value="exam">Exam</option>
        <option value="quiz">Quiz</option><option value="project">Project</option>
        <option value="class">Class</option><option value="other">Other</option></select></div>
      <div class="field"><label>Course</label><select id="ne-course">${courseOptions()}</select></div></div>
    <div class="modal-actions"><button class="btn" id="ne-cancel">Cancel</button>
    <button class="btn primary" id="ne-save">Add</button></div>`);
  $("#ne-cancel").addEventListener("click", closeModal);
  $("#ne-save").addEventListener("click", () => {
    const title = $("#ne-title").value.trim().slice(0, 140);
    const date = $("#ne-date").value;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast("An event needs a title and a date.", "err");
    db.events.push({ id: uid(), course_id: $("#ne-course").value ? Number($("#ne-course").value) : null,
      title, date, time: $("#ne-time").value || "", kind: $("#ne-kind").value, source: "manual", details: "" });
    save(); closeModal(); toast("Event added."); renderCalendar();
  });
}

function openImportIcs() {
  openModal(`
    <h3>Import a course calendar</h3>
    <p class="muted">Canvas, Moodle & co. give every student a calendar export (look for "Calendar feed" / .ics). Download the .ics file and upload it here. (Pasting a feed URL usually gets blocked by the school's server when done from a browser, so the file route is the reliable one.)</p>
    <div class="field"><label>.ics file</label><input id="ic-file" type="file" accept=".ics"></div>
    <div class="field"><label>Attach to course (optional)</label><select id="ic-course">${courseOptions()}</select></div>
    <div class="modal-actions"><button class="btn" id="ic-cancel">Cancel</button>
    <button class="btn primary" id="ic-go">Import</button></div>`);
  $("#ic-cancel").addEventListener("click", closeModal);
  $("#ic-go").addEventListener("click", async () => {
    const file = $("#ic-file").files[0];
    if (!file) return toast("Choose a .ics file first.", "err");
    const events = parseIcs(await file.text());
    if (!events.length) return toast("No usable events found in that calendar (or all fall outside the current term window).", "err");
    const courseId = $("#ic-course").value ? Number($("#ic-course").value) : null;
    const added = addEvents(courseId, null, events, "ics");
    save(); closeModal();
    toast(`Imported ${added} of ${events.length} events.`);
    renderCalendar();
  });
}

/* ---------- settings ---------- */

function renderSettings() {
  $("#view").innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    <div class="settings-grid">
      <div class="card">
        <h3>${db.apiKey ? "✅ AI answers are on" : "🔌 AI answers are off"}</h3>
        <div class="kv"><span class="k">Mode</span><span>${db.apiKey ? `Full answers via <b>${MODEL}</b>, restricted to your uploads` : "Keyword matching over your uploads (no AI)"}</span></div>
        <div class="field" style="margin-top:12px"><label>Anthropic API key</label>
          <input id="key-input" type="password" placeholder="sk-ant-…" value="${esc(db.apiKey)}"></div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="key-save">Save key</button>
          ${db.apiKey ? `<button class="btn danger" id="key-clear">Remove key</button>` : ""}
        </div>
        <p class="muted" style="margin-top:10px">The key is stored only in this browser and sent only to Anthropic's API. Don't enter it on shared computers. Get one at console.anthropic.com — without it, everything still works in keyword mode.</p>
      </div>
      <div class="card">
        <h3>💾 Your data</h3>
        <p class="muted">Everything lives in this browser. Back it up to a file, move it to another device, or wipe it.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="backup">⬇ Download backup</button>
          <button class="btn" id="restore">⇪ Restore backup</button>
          <button class="btn danger" id="wipe">Erase everything</button>
          <input id="restore-file" type="file" accept=".json" style="display:none">
        </div>
      </div>
    </div>`;

  $("#key-save").addEventListener("click", () => {
    db.apiKey = $("#key-input").value.trim();
    save(); renderAiPill();
    toast(db.apiKey ? "Key saved — AI answers are on. It'll be checked on your next question." : "Key cleared.");
    renderSettings();
  });
  const clearBtn = $("#key-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { db.apiKey = ""; save(); renderAiPill(); renderSettings(); });
  $("#backup").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ ...db, apiKey: "" }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mysyllabi-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#restore").addEventListener("click", () => $("#restore-file").click());
  $("#restore-file").addEventListener("change", async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.courses)) throw new Error("not a MySyllabi backup");
      const key = db.apiKey;
      db = { ...freshDb(), ...data, apiKey: key };
      save(); toast("Backup restored."); navigate("dashboard");
    } catch (err) { toast(`Couldn't restore: ${err.message}`, "err"); }
  });
  $("#wipe").addEventListener("click", () => {
    if (!confirm("Erase ALL courses, documents, events, and history from this browser?")) return;
    db = freshDb(); save(); toast("Wiped."); navigate("dashboard");
  });
}

/* ================= boot ================= */

$$("#nav .nav-item").forEach((a) => a.addEventListener("click", () => navigate(a.dataset.view)));
renderAiPill();
navigate("dashboard");
