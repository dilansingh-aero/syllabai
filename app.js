/* SyllabAI — GitHub Pages frontend backed by Supabase.
 *
 * Two modes, decided by config.js:
 *   remote: Supabase accounts + Postgres storage. AI answers come from the
 *           "claude" edge function, which holds the server's Anthropic key and
 *           enforces a per-user daily limit. Clients never see a key.
 *   local:  no config yet -> in-browser demo (localStorage, keyword answers).
 */
"use strict";

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

const CFG = window.MYSYLLABI_CONFIG || {};
const REMOTE = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const supa = REMOTE ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

const COURSE_COLORS = ["#4f46e5", "#0d9488", "#d97706", "#db2777", "#7c3aed", "#059669", "#dc2626", "#2563eb"];
const KIND_ICONS = { exam: "📝", quiz: "❓", assignment: "📌", project: "📦", class: "🏫", other: "📅" };
const ALLOW_EMOJI = { "Class skips": "🏫", "Homework skips": "📌", "Lab skips": "🧪" };
const SESSION_GAP_MS = 30 * 60 * 1000;

const state = {
  user: null,                    // {id, email, name}
  usage: { on: false, limit: 0, used: 0, left: 0 },
  db: { courses: [], docs: [], events: [], notes: [], sessions: [] },
  askCourse: "", calMonth: null, selectedDay: null,
  viewingSessionId: null, currentSessionId: null, msgs: [],
};

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
function openModal(html, wide) {
  const modal = $("#modal");
  modal.classList.toggle("wide", Boolean(wide));
  modal.innerHTML = html;
  $("#modal-backdrop").classList.remove("hidden");
}
function closeModal() { $("#modal-backdrop").classList.add("hidden"); }
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === $("#modal-backdrop")) closeModal(); });

function pad(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoToday() { return isoOf(new Date()); }
function addDays(iso, n) { const [y, m, d] = iso.split("-").map(Number); return isoOf(new Date(y, m - 1, d + n)); }
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function courseById(id) { return state.db.courses.find((c) => c.id === id); }
function docsOf(courseId) { return state.db.docs.filter((d) => d.course_id === courseId); }
function notesOf(courseId) { return state.db.notes.filter((n) => n.course_id === courseId); }
function chatMarker(fresh) {
  let marker = sessionStorage.getItem("msy-marker");
  if (!marker || fresh) {
    marker = uuid().slice(0, 36);
    sessionStorage.setItem("msy-marker", marker);
  }
  return marker;
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("msy-theme", theme);
}

/* ================= engine: chunking ================= */

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

/* ================= engine: retrieval ================= */

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
  clue:["hint","hints","clues","mentioned","said"], hint:["clue","clues","mentioned","said"],
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

/* ================= engine: heuristics ================= */

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

function extractFactsHeuristic(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f = { instructor:"", instructor_email:"", office_hours:"", location_or_modality:"", late_policy:"",
    attendance_policy:"", exam_policy:"", academic_integrity:"", textbook:"", grading:[], tas:[], other_key_policies:[] };
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
        return ["professor", "Course logistics question with no TA listed, so the instructor is the right contact."];
      }
      const reasons = {
        professor: "Personal circumstances, exam conflicts, and grade decisions are instructor calls.",
        ta: "Assignment and grading logistics go to the TAs first.",
        classmate_or_lms: "Course site or missed class material. A classmate or the LMS will be faster.",
        registrar_or_advisor: "Enrollment and degree rules live outside any one course.",
      };
      return [route, reasons[route]];
    }
  }
  if (foundAnswer) return ["none", ""];
  if (hasTas) return ["ta", "Not covered in your materials. Start with a TA, escalate to the professor if needed."];
  return ["professor", "Not covered in your materials, so the instructor is the best person to ask."];
}

/* ================= engine: ICS ================= */

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
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SyllabAI//Course Calendar//EN",
    "CALSCALE:GREGORIAN", "X-WR-CALNAME:" + icsEscape(calName)];
  for (const ev of events) {
    const ymd = ev.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:evt-${ev.id}@syllabai.local`, `DTSTAMP:${stamp}`);
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

/* ================= engine: file extraction & quote locating ================= */

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
      throw new Error("That PDF has no extractable text. It's probably a scanned image; paste the syllabus text instead.");
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

function normalizeWs(s) { return s.replace(/\s+/g, " ").trim().toLowerCase(); }

function locateQuote(text, quote) {
  const map = [];
  let norm = "";
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) { norm += " "; map.push(i); lastSpace = true; }
    } else {
      norm += ch.toLowerCase(); map.push(i); lastSpace = false;
    }
  }
  const q = normalizeWs(quote);
  if (!q) return null;
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

function verifyCitations(citations, excerpts) {
  const byId = {};
  for (const ex of excerpts) byId[ex.id] = ex;
  return (citations || []).slice(0, 12).map((c) => {
    const ex = byId[c.excerpt_id];
    const quote = (c.quote || "").trim();
    return {
      excerpt_id: c.excerpt_id,
      label: ex ? ex.label : `excerpt ${c.excerpt_id}`,
      doc_id: ex ? ex.doc_id : null,
      quote: quote.slice(0, 300),
      verified: Boolean(quote) && Boolean(ex) && normalizeWs(ex.text).includes(normalizeWs(quote)),
    };
  });
}

function detectCourseMention(question) {
  const q = question.toLowerCase();
  const qCompact = q.replace(/\s+/g, "");
  const words = q.split(/[^a-z0-9]+/).filter(Boolean);
  const hits = new Set();
  for (const c of state.db.courses) {
    const code = c.code.toLowerCase();
    const compact = code.replace(/\s+/g, "");
    const subj = (code.match(/^[a-z]+/) || [""])[0];
    const num = (code.match(/\d{3,}/) || [""])[0];
    let hit = q.includes(code) || (compact.length > 3 && qCompact.includes(compact)) || (num && q.includes(num));
    if (!hit && subj.length >= 2) {
      for (const w of words) {
        if (w === subj || (w.length >= 3 && subj.length >= 3 && (w.startsWith(subj) || subj.startsWith(w)))) { hit = true; break; }
      }
    }
    if (hit) hits.add(c.id);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/* ================= data layer (remote Supabase / local demo) ================= */

const LOCAL_KEY = "mysyllabi-local-v2";

function localLoad() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_e) { /* fresh */ }
  return { courses: [], docs: [], events: [], notes: [], sessions: [], chats: [] };
}
let localDb = REMOTE ? null : localLoad();
function localSave() { localStorage.setItem(LOCAL_KEY, JSON.stringify(localDb)); }

async function sbThrow(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

const repo = {
  async loadAll() {
    if (REMOTE) {
      const [courses, docs, events, notes, sessions] = await Promise.all([
        sbThrow(supa.from("courses").select("id, code, title, term, instructor, color, allowances").order("created_at")),
        sbThrow(supa.from("documents").select("id, course_id, filename, kind, facts, facts_mode, chunks, file_path, uploaded_at").order("uploaded_at")),
        sbThrow(supa.from("events").select("*").order("date")),
        sbThrow(supa.from("notes").select("id, course_id, text, created_at").order("created_at", { ascending: false })),
        sbThrow(supa.from("chat_sessions").select("*").order("last_at", { ascending: false })),
      ]);
      state.db = { courses, docs, events, notes, sessions };
    } else {
      state.db = {
        courses: localDb.courses, docs: localDb.docs, events: localDb.events,
        notes: localDb.notes, sessions: localDb.sessions,
      };
    }
  },

  async addCourse(fields) {
    const course = { id: uuid(), allowances: [], ...fields };
    if (REMOTE) await sbThrow(supa.from("courses").insert({ ...course, user_id: state.user.id }));
    state.db.courses.push(course);
    if (!REMOTE) localSave();
    return course;
  },

  async delCourse(id) {
    if (REMOTE) await sbThrow(supa.from("courses").delete().eq("id", id));
    state.db.courses = state.db.courses.filter((c) => c.id !== id);
    state.db.docs = state.db.docs.filter((d) => d.course_id !== id);
    state.db.events = state.db.events.filter((e) => e.course_id !== id);
    state.db.notes = state.db.notes.filter((n) => n.course_id !== id);
    if (!REMOTE) localSave();
  },

  async saveAllowances(course) {
    if (REMOTE) await sbThrow(supa.from("courses").update({ allowances: course.allowances }).eq("id", course.id));
    if (!REMOTE) localSave();
  },

  async addDocument(doc, file) {
    if (REMOTE) {
      // Keep the ORIGINAL file so the viewer can show the real pdf/docx.
      if (file && (doc.kind === "pdf" || doc.kind === "docx")) {
        const ext = doc.kind === "pdf" ? "pdf" : "docx";
        const path = `${state.user.id}/${doc.id}.${ext}`;
        const { error } = await supa.storage.from("documents").upload(path, file, { upsert: true });
        if (!error) doc.file_path = path;
      }
      doc.file_path = doc.file_path || "";
      await sbThrow(supa.from("documents").insert({ ...doc, user_id: state.user.id }));
      const { text, ...meta } = doc;
      state.db.docs.push(meta);
    } else {
      state.db.docs.push(doc);
      localSave();
    }
  },

  async delDocument(id) {
    const doc = state.db.docs.find((d) => d.id === id);
    if (REMOTE) {
      if (doc && doc.file_path) await supa.storage.from("documents").remove([doc.file_path]).catch(() => {});
      await sbThrow(supa.from("documents").delete().eq("id", id));
    }
    state.db.docs = state.db.docs.filter((d) => d.id !== id);
    state.db.events = state.db.events.filter((e) => e.document_id !== id);
    if (!REMOTE) localSave();
  },

  async addNote(courseId, text) {
    const note = { id: uuid(), course_id: courseId, text, created_at: new Date().toISOString() };
    if (REMOTE) await sbThrow(supa.from("notes").insert({ ...note, user_id: state.user.id }));
    state.db.notes.unshift(note);
    const added = await this.addEventsBulk(courseId, null, extractEventsHeuristic(text), "note");
    if (!REMOTE) localSave();
    return added;
  },

  async delNote(id) {
    if (REMOTE) await sbThrow(supa.from("notes").delete().eq("id", id));
    state.db.notes = state.db.notes.filter((n) => n.id !== id);
    if (!REMOTE) localSave();
  },

  async addEventsBulk(courseId, docId, events, source) {
    const existing = new Set(state.db.events.filter((e) => e.course_id === courseId)
      .map((e) => e.date + "|" + normalizeWs(e.title).slice(0, 60)));
    const rows = [];
    for (const ev of events.slice(0, 150)) {
      const key = ev.date + "|" + normalizeWs(ev.title).slice(0, 60);
      if (existing.has(key)) continue;
      existing.add(key);
      rows.push({ id: uuid(), course_id: courseId, document_id: docId, title: ev.title.slice(0, 140),
        date: ev.date, time: ev.time || "", kind: ev.kind || "other", source, details: ev.details || "" });
    }
    if (rows.length) {
      if (REMOTE) await sbThrow(supa.from("events").insert(rows.map((r) => ({ ...r, user_id: state.user.id }))));
      state.db.events.push(...rows);
      if (!REMOTE) localSave();
    }
    return rows.length;
  },

  async addEvent(ev) {
    const row = { id: uuid(), ...ev };
    if (REMOTE) await sbThrow(supa.from("events").insert({ ...row, user_id: state.user.id }));
    state.db.events.push(row);
    if (!REMOTE) localSave();
  },

  async delEvent(id) {
    if (REMOTE) await sbThrow(supa.from("events").delete().eq("id", id));
    state.db.events = state.db.events.filter((e) => e.id !== id);
    if (!REMOTE) localSave();
  },

  async getSource(docId) {
    if (String(docId).startsWith("notes-")) {
      const courseId = String(docId).slice(6);
      const course = courseById(courseId);
      const notes = notesOf(courseId).slice().reverse();
      return { title: `${course ? course.code : ""} class notes`,
        text: notes.map((n) => `[${(n.created_at || "").slice(0, 10)}]\n${n.text}`).join("\n\n") };
    }
    if (REMOTE) {
      const data = await sbThrow(supa.from("documents").select("filename, text").eq("id", docId).single());
      return { title: data.filename, text: data.text };
    }
    const doc = state.db.docs.find((d) => d.id === docId);
    return doc ? { title: doc.filename, text: doc.text } : null;
  },

  // Sessions are only persisted once a first question is asked (no empty rows).
  findCurrentSession() {
    const marker = chatMarker();
    const session = state.db.sessions.find((s) => s.marker === marker);
    if (session && Date.now() - new Date(session.last_at).getTime() <= SESSION_GAP_MS) return session;
    return null;
  },

  async persistSession(title) {
    const session = { id: uuid(), marker: chatMarker(), title: (title || "").slice(0, 60),
      started_at: new Date().toISOString(), last_at: new Date().toISOString() };
    if (REMOTE) await sbThrow(supa.from("chat_sessions").insert({ ...session, user_id: state.user.id }));
    state.db.sessions.unshift(session);
    if (!REMOTE) localSave();
    return session;
  },

  // Clicking an old chat makes it the ACTIVE chat again (continue where you left off).
  async resumeSession(sessionId) {
    const session = state.db.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const marker = chatMarker(true);
    session.marker = marker;
    session.last_at = new Date().toISOString();
    if (REMOTE) await sbThrow(supa.from("chat_sessions").update({ marker, last_at: session.last_at }).eq("id", sessionId));
    else localSave();
    return session;
  },

  async listChats(sessionId) {
    if (REMOTE) {
      return await sbThrow(supa.from("chats").select("id, course_id, question, answer, created_at")
        .eq("session_id", sessionId).order("created_at"));
    }
    return localDb.chats.filter((c) => c.session_id === sessionId);
  },

  async addChat(session, question, answer, courseId) {
    const chat = { id: uuid(), session_id: session.id, course_id: courseId,
      question, answer, created_at: new Date().toISOString() };
    if (!session.title) session.title = question.slice(0, 60);
    session.last_at = new Date().toISOString();
    if (REMOTE) {
      await sbThrow(supa.from("chats").insert({ ...chat, user_id: state.user.id }));
      await sbThrow(supa.from("chat_sessions").update({ title: session.title, last_at: session.last_at }).eq("id", session.id));
    } else {
      localDb.chats.push(chat);
      localSave();
    }
    return chat;
  },

  async sendFeedback(text) {
    if (!REMOTE) return;
    await sbThrow(supa.from("feedback").insert({ id: uuid(), user_id: state.user.id,
      email: state.user.email, text: text.slice(0, 4000) }));
  },

  async clearChats() {
    if (REMOTE) {
      await sbThrow(supa.from("chats").delete().eq("user_id", state.user.id));
      await sbThrow(supa.from("chat_sessions").delete().eq("user_id", state.user.id));
    } else {
      localDb.chats = []; localDb.sessions = []; localSave();
    }
    state.db.sessions = [];
    state.currentSessionId = null; state.viewingSessionId = null; state.msgs = [];
  },

  // Calls the edge function. Returns null in local mode (caller falls back to heuristics).
  async invokeClaude(payload) {
    if (!REMOTE) return null;
    const { data, error } = await supa.functions.invoke("claude", { body: payload });
    if (error) throw new Error(error.message || "AI server unreachable.");
    if (data && data.usage) {
      state.usage = data.usage;
      renderAiPill();
    }
    return data;
  },
};

/* ================= demo data ================= */

const DEMO = [
  { code: "CS 2110", title: "Data Structures & OO Programming", instructor: "Prof. Elena Marchetti", color: "#4f46e5",
    allowances: [{ label: "Slip days", emoji: "🎟", total: 3, remaining: 3 }],
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
Textbook: "Data Structures and Abstractions with Java" — the full text is FREE online through the university library.

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
Regrade requests are submitted through Gradescope within 7 days and are handled by the TAs.

Extra Credit
There is no extra credit in this course.

Academic Integrity
All submitted code must be written by you alone. Using AI assistants to generate homework solutions is a violation of the academic integrity code.` },
  { code: "PSYC 1101", title: "Introduction to Psychology", instructor: "Dr. Sam Okafor", color: "#0d9488",
    allowances: [{ label: "Class skips", emoji: "🏫", total: 5, remaining: 5 }],
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
    allowances: [],
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
    allowances: [{ label: "Class skips", emoji: "🏫", total: 3, remaining: 3 }],
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

async function ingestDocument(course, filename, text, kind, quiet, file) {
  text = text.trim();
  if (text.length < 40) throw new Error("That document looks empty. Nothing to index.");
  const doc = { id: uuid(), course_id: course.id, filename, kind, text,
    chunks: chunkText(text), facts: null, facts_mode: "heuristic", file_path: "",
    uploaded_at: new Date().toISOString() };
  let events = [];
  if (REMOTE && state.usage.on && !quiet) {
    try {
      const res = await repo.invokeClaude({ kind: "extract", text, code: course.code, term: course.term || "" });
      if (res && res.result) {
        doc.facts = res.result.facts;
        doc.facts_mode = "ai";
        events = (res.result.events || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
          .map((e) => ({ ...e, time: /^\d{2}:\d{2}$/.test(e.time) ? e.time : "" }));
      }
    } catch (_e) { /* heuristics below */ }
  }
  if (!doc.facts) {
    doc.facts = extractFactsHeuristic(text);
    events = extractEventsHeuristic(text);
  }
  await repo.addDocument(doc, file);
  const eventsAdded = await repo.addEventsBulk(course.id, doc.id, events, "auto");
  return { doc, eventsAdded };
}

async function loadDemo() {
  for (const spec of DEMO) {
    if (state.db.courses.some((c) => c.code === spec.code)) continue;
    const course = await repo.addCourse({ code: spec.code, title: spec.title, term: "Fall 2026",
      instructor: spec.instructor, color: spec.color, allowances: spec.allowances });
    // quiet=true: demo seeding never spends AI calls.
    await ingestDocument(course, spec.code.toLowerCase().replace(/\s+/g, "") + "-syllabus.txt", spec.text, "txt", true);
  }
}

/* ================= ask pipeline ================= */

function chunkPool(courseId) {
  const pool = [];
  for (const doc of state.db.docs) {
    if (courseId && doc.course_id !== courseId) continue;
    const course = courseById(doc.course_id);
    for (const ch of doc.chunks || []) {
      pool.push({ text: ch.text, section: ch.section, code: course ? course.code : "?",
        filename: doc.filename, doc_id: doc.id });
    }
  }
  for (const course of state.db.courses) {
    if (courseId && course.id !== courseId) continue;
    for (const note of notesOf(course.id)) {
      pool.push({ text: note.text, section: `Note (${(note.created_at || "").slice(0, 10)})`,
        code: course.code, filename: "Class notes", doc_id: "notes-" + course.id });
    }
  }
  return pool;
}

function calendarExcerpt() {
  const today = isoToday(), horizon = addDays(today, 120);
  const rows = state.db.events.filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 45);
  if (!rows.length) return null;
  const lines = rows.map((e) => {
    const c = e.course_id ? courseById(e.course_id) : null;
    return `${e.date}${e.time ? " " + e.time : ""} (${e.kind}) ${c ? "[" + c.code + "] " : ""}${e.title}`;
  });
  return { id: 0, label: "Your deadline calendar", doc_id: null, text: lines.join("\n") };
}

function heuristicAnswer(question, excerpts) {
  const passages = excerpts.filter((e) => e.id !== 0);
  const found = passages.length > 0 && (passages[0].score || 0) >= 1.2;
  const hasTas = state.db.docs.some((d) => d.facts && d.facts.tas && d.facts.tas.length) ||
    passages.slice(0, 3).some((p) => /\bTAs?\b/.test(p.text));
  const [route, reason] = routeQuestion(question, found, hasTas);
  return {
    status: found ? "partial" : "not_found",
    answer: found
      ? "Best matching passages from your materials are below; the first very likely answers this."
      : "Not covered in your uploaded materials. I don't guess.",
    citations: found ? passages.slice(0, 3).map((p) => ({ excerpt_id: p.id, label: p.label,
      doc_id: p.doc_id, quote: p.text.slice(0, 400), verified: true })) : [],
    route, route_reason: reason, confidence: "low",
  };
}

async function doAsk(question, courseId, scopeNote) {
  const pool = chunkPool(courseId);
  if (!pool.length) throw new Error("Upload at least one syllabus first. I only answer from your materials.");
  const ranked = rankChunks(pool, question);
  const excerpts = [];
  const cal = calendarExcerpt();
  if (cal) excerpts.push(cal);
  ranked.forEach(([score, ch], i) => {
    excerpts.push({ id: i + 1, label: `${ch.code} — ${ch.section || ch.filename}`,
      doc_id: ch.doc_id, text: ch.text, score });
  });

  let session = repo.findCurrentSession();
  if (!session) session = await repo.persistSession(question);
  let result = null;
  if (REMOTE && state.usage.on) {
    try {
      const scope = courseId ? `the student limited this question to ${courseById(courseId).code}` : "all of the student's courses";
      const history = state.msgs.slice(-4).map((m) => ({ q: m.question, a: (m.answer.answer || "").slice(0, 400) }));
      const res = await repo.invokeClaude({
        kind: "ask", question, scope, history,
        excerpts: excerpts.map((ex) => ({ id: ex.id, label: ex.label, text: ex.text })),
      });
      if (res && res.result) {
        result = res.result;
        result.citations = verifyCitations(result.citations, excerpts);
        result.unverified = result.status === "answered" && !result.citations.some((c) => c.verified);
        result.mode = "ai";
      } else if (res && res.limited) {
        result = heuristicAnswer(question, excerpts);
        result.mode = "heuristic";
        result.note = res.reason === "limit"
          ? `You've used all ${res.usage.limit} AI answers for today. Keyword matches below; the counter resets tomorrow.`
          : "AI isn't set up on this server yet. Keyword matches below.";
      } else if (res && res.error) {
        result = heuristicAnswer(question, excerpts);
        result.mode = "heuristic";
        result.note = res.error;
      }
    } catch (e) {
      result = heuristicAnswer(question, excerpts);
      result.mode = "heuristic";
      result.note = `AI call failed (${e.message}). Showing keyword matches instead.`;
    }
  }
  if (!result) {
    result = heuristicAnswer(question, excerpts);
    result.mode = "heuristic";
  }
  if (scopeNote) result.scope_note = scopeNote;
  await repo.addChat(session, question, result, courseId);
  state.currentSessionId = session.id;
  state.msgs.push({ question, answer: result, course_id: courseId });
  return result;
}

/* ================= views ================= */

function renderAiPill() {
  const pill = $("#ai-pill");
  if (!REMOTE) {
    pill.className = "ai-pill off";
    pill.textContent = "✦ Demo mode (this browser only)";
    pill.title = "No server configured yet. Data stays in this browser; answers are keyword matches.";
  } else if (state.usage.on) {
    pill.className = "ai-pill on";
    pill.textContent = `✦ AI answers on · ${state.usage.left} left today`;
    pill.title = `Each account gets ${state.usage.limit} AI answers per day. Resets at midnight (UTC).`;
  } else {
    pill.className = "ai-pill off";
    pill.textContent = "✦ Keyword mode";
    pill.title = "AI answers are not enabled on this server yet.";
  }
}

function navigate(view, param) {
  $$("#nav .nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  if (view === "dashboard") renderDashboard();
  else if (view === "course") renderCourse(param);
  else if (view === "ask") renderAsk();
  else if (view === "calendar") renderCalendar();
  else if (view === "settings") renderSettings();
}
window.navigate = navigate;

/* ---------- dashboard ---------- */

function allowanceChips(c) {
  return (c.allowances || []).map((a, i) => `
    <span class="allow-chip ${a.remaining === 0 ? "zero" : ""}" data-course="${c.id}" data-idx="${i}"
      title="${esc(a.label)}: ${a.remaining} of ${a.total} left. Click to use one.">
      ${esc(a.emoji || "🎟")} ${a.remaining}/${a.total}</span>`).join("");
}

function renderDashboard() {
  const today = isoToday(), horizon = addDays(today, 14);
  const upcoming = state.db.events.filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
  const upHtml = upcoming.length ? `
    <div class="upcoming-strip"><h3>Next 14 days</h3><div class="up-list">${upcoming.map((e) => {
      const c = e.course_id ? courseById(e.course_id) : null;
      return `<div class="up-item"><div class="d">${fmtDate(e.date)}${e.time ? " · " + esc(e.time) : ""}</div>
        <div class="t">${KIND_ICONS[e.kind] || "📅"} ${c ? `<b>${esc(c.code)}</b> ` : ""}${esc(e.title)}</div></div>`;
    }).join("")}</div></div>` : "";

  const welcome = !state.db.courses.length ? `
    <div class="card" style="margin-bottom:20px">
      <h3>👋 Welcome</h3>
      <p style="color:var(--ink-soft)">SyllabAI answers course questions <b>only from syllabi you upload</b>, with quotes to prove it, and tells you whether that email to your professor is even necessary.</p>
      <button class="btn primary" id="load-demo">🎓 Load 4 demo courses</button>
    </div>` : "";

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Your courses</h1>
        <div class="sub">Upload each course's syllabus once, then ask questions instead of scrolling PDFs.</div></div>
      <button class="btn primary" id="add-course-btn">+ Add course</button>
    </div>
    ${welcome}${upHtml}
    <div class="course-grid">
      ${state.db.courses.map((c) => `
        <div class="card course-card" data-id="${c.id}">
          <div class="stripe" style="background:${esc(c.color)}"></div>
          <h3>${esc(c.code)}</h3><div class="ctitle">${esc(c.title || "")}</div>
        </div>`).join("")}
    </div>
    ${state.db.courses.length === 0 ? `<div class="empty"><div class="big-ic">🎓</div>No courses yet.</div>` : ""}`;

  $$(".course-card").forEach((el) => el.addEventListener("click", () => navigate("course", el.dataset.id)));
  $("#add-course-btn").addEventListener("click", openAddCourse);
  const demoBtn = $("#load-demo");
  if (demoBtn) demoBtn.addEventListener("click", async () => {
    demoBtn.disabled = true; demoBtn.textContent = "Loading…";
    try { await loadDemo(); toast("Demo courses loaded. Try Ask!"); }
    catch (err) { toast(err.message, "err"); }
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
  let color = COURSE_COLORS[state.db.courses.length % COURSE_COLORS.length];
  $$(".color-dot").forEach((dot) => dot.addEventListener("click", () => {
    $$(".color-dot").forEach((d) => d.classList.remove("sel"));
    dot.classList.add("sel"); color = dot.dataset.color;
  }));
  $("#nc-cancel").addEventListener("click", closeModal);
  $("#nc-save").addEventListener("click", async () => {
    const code = $("#nc-code").value.trim().slice(0, 40);
    if (!code) return toast("Course code is required (e.g. CS 2110).", "err");
    try {
      const course = await repo.addCourse({ code, title: $("#nc-title").value.trim().slice(0, 120),
        term: $("#nc-term").value.trim().slice(0, 40), instructor: $("#nc-inst").value.trim().slice(0, 80), color });
      closeModal(); toast("Course added. Now drop in its syllabus.");
      navigate("course", course.id);
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ---------- source viewer (real pdf/docx previews, text fallback) ---------- */

function viewerShell(title) {
  openModal(`
    <div class="doc-view-head">
      <h3>📄 ${esc(title)}</h3>
      <button class="btn small" id="dv-close">Close ✕</button>
    </div>
    <div class="doc-view-body" id="dv-body"><div class="thinking">Loading document…</div></div>`, true);
  $("#dv-close").addEventListener("click", closeModal);
  return $("#dv-body");
}

function centerIn(bodyEl, el) {
  let tries = 0;
  const center = () => {
    if (!el.isConnected || !bodyEl.isConnected) return;
    const delta = el.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top;
    const target = Math.max(0, bodyEl.scrollTop + delta - bodyEl.clientHeight / 2);
    bodyEl.scrollTop = target;
    const after = Math.abs(el.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top - bodyEl.clientHeight / 2);
    if (after > bodyEl.clientHeight && ++tries < 20) setTimeout(center, 120);
  };
  setTimeout(center, 60);
}

async function openDocViewer(docId, quote) {
  if (String(docId).startsWith("notes-")) return openTextViewer(docId, quote);
  const doc = state.db.docs.find((d) => d.id === docId);
  if (doc && REMOTE && doc.file_path && (doc.kind === "pdf" || doc.kind === "docx")) {
    const body = viewerShell(doc.filename);
    try {
      const { data, error } = await supa.storage.from("documents").download(doc.file_path);
      if (error) throw new Error(error.message);
      const bytes = await data.arrayBuffer();
      if (doc.kind === "pdf") await renderPdfPreview(body, bytes, quote);
      else await renderDocxPreview(body, bytes, quote);
      return;
    } catch (_e) { /* fall through to extracted text */ }
  }
  return openTextViewer(docId, quote);
}

async function openTextViewer(docId, quote) {
  let src;
  try { src = await repo.getSource(docId); } catch (err) { return toast(err.message, "err"); }
  if (!src) return toast("That document no longer exists.", "err");
  let bodyHtml = null;
  let found = false;
  if (quote) {
    const range = locateQuote(src.text, quote);
    if (range) {
      found = true;
      bodyHtml = esc(src.text.slice(0, range[0])) +
        `<mark class="src-hl" id="src-hl">` + esc(src.text.slice(range[0], range[1])) + `</mark>` +
        esc(src.text.slice(range[1]));
    }
  }
  const body = viewerShell(src.title);
  body.innerHTML = bodyHtml || esc(src.text);
  const mark = $("#src-hl");
  if (found && mark) centerIn(body, mark);
}

async function renderPdfPreview(body, bytes, quote) {
  if (!window.pdfjsLib) throw new Error("pdf.js unavailable");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  body.innerHTML = "";
  body.classList.add("pdf-view");
  const qNorm = quote ? normalizeWs(quote) : "";
  const dpr = window.devicePixelRatio || 1;
  let target = null;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.6, Math.max(0.7, (body.clientWidth - 36) / base.width));
    const viewport = page.getViewport({ scale });
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    wrap.appendChild(canvas);
    const textDiv = document.createElement("div");
    textDiv.className = "textLayer";
    wrap.appendChild(textDiv);
    body.appendChild(wrap);
    // Selectable text layer, and the surface the highlight lands on.
    const textContent = await page.getTextContent();
    const textDivs = [];
    try {
      await pdfjsLib.renderTextLayer({ textContentSource: textContent, textContent,
        container: textDiv, viewport, textDivs }).promise;
    } catch (_e) { /* preview still works without a text layer */ }
    if (qNorm && !target && textDivs.length) {
      let concat = "";
      const ranges = [];
      textContent.items.forEach((it) => {
        const t = normalizeWs(it.str || "");
        if (!t) { ranges.push(null); return; }
        if (concat) concat += " ";
        const startAt = concat.length;
        concat += t;
        ranges.push([startAt, concat.length]);
      });
      const at = concat.indexOf(qNorm);
      if (at >= 0) {
        const end = at + qNorm.length;
        textContent.items.forEach((_it, i) => {
          const r = ranges[i];
          if (r && r[0] < end && r[1] > at && textDivs[i]) {
            textDivs[i].classList.add("pdf-hl");
            if (!target) target = textDivs[i];
          }
        });
      }
    }
  }
  if (target) centerIn(body, target);
}

async function renderDocxPreview(body, bytes, quote) {
  if (!window.mammoth) throw new Error("mammoth unavailable");
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
  body.innerHTML = "";
  body.classList.add("docx-view");
  const inner = document.createElement("div");
  inner.className = "docx-body";
  inner.innerHTML = result.value;
  body.appendChild(inner);
  if (quote) {
    const range = findQuoteRange(inner, quote);
    if (range) {
      try {
        const mark = document.createElement("mark");
        mark.className = "src-hl";
        range.surroundContents(mark);
        centerIn(body, mark);
        return;
      } catch (_e) { /* quote spans elements: flash the containing block instead */ }
      const el = range.startContainer.parentElement;
      if (el) { el.classList.add("src-hl-block"); centerIn(body, el); }
    }
  }
}

function findQuoteRange(root, quote) {
  const q = normalizeWs(quote);
  if (!q) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let concat = "";
  const maps = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const t = node.nodeValue || "";
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (/\s/.test(ch)) {
        if (concat && !concat.endsWith(" ")) { concat += " "; maps.push([node, i]); }
      } else {
        concat += ch.toLowerCase();
        maps.push([node, i]);
      }
    }
  }
  const at = concat.indexOf(q);
  if (at < 0) return null;
  const [sn, so] = maps[at];
  const [en, eo] = maps[at + q.length - 1];
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo + 1);
  return range;
}

/* ---------- course detail ---------- */

function mergeFacts(docs) {
  const merged = { grading: [], tas: [], other_key_policies: [] };
  const keys = ["instructor", "instructor_email", "office_hours", "location_or_modality",
    "late_policy", "attendance_policy", "exam_policy", "academic_integrity", "textbook"];
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
  const notes = notesOf(courseId);
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
  const events = state.db.events.filter((e) => e.course_id === courseId)
    .sort((a, b) => a.date.localeCompare(b.date));

  $("#view").innerHTML = `
    <div class="view-head">
      <div><a onclick="navigate('dashboard')">← Courses</a>
        <h1 style="color:${esc(c.color)}">${esc(c.code)}</h1>
        <div class="sub">${esc(c.title || "")}${c.term ? " · " + esc(c.term) : ""}${c.instructor ? " · " + esc(c.instructor) : ""}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="ask-this">💬 Ask about this course</button>
        <button class="btn danger" id="del-course">Delete</button></div>
    </div>

    <div class="course-top">
      <div class="card info-card">
        <h3>Course info</h3>
        ${rows.length ? `<div class="facts-grid">${rows.map((r) =>
          `<div class="fact"><div class="k">${esc(r.k)}</div><div class="v">${esc(r.v)}</div></div>`).join("")}</div>`
        : `<p class="muted">Upload a syllabus and I'll pull out the instructor, grading breakdown, late policy, and more.</p>`}
      </div>
      <div class="card skips-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <h3 style="font-size:14px">Skips</h3>
          <button class="btn small" id="add-allow" title="Add a tracker">＋</button>
        </div>
        ${(c.allowances || []).length ? c.allowances.map((a, i) => `
          <div class="allow-row">
            <span title="${esc(a.label)}">${esc(a.emoji || "🎟")}</span>
            <button class="btn small" data-allow-use="${i}" title="Use one">−</button>
            <span class="allow-count ${a.remaining === 0 ? "zero" : ""}">${a.remaining}/${a.total}</span>
            <button class="btn small" data-allow-undo="${i}" title="Give one back">+</button>
            <button class="btn small danger" data-allow-del="${i}" title="Remove tracker">✕</button>
          </div>`).join("") : `<p class="muted" style="font-size:12px">Track class, homework, or lab skips. 3/3 counts down as you use them.</p>`}
      </div>
    </div>

    <div class="section-title"><h3>📝 Notes & clues</h3></div>
    <div class="card">
      <p class="muted" style="margin-top:0">Professor dropped an exam hint? Add it here and Ask can use it later. Dates in notes go on your calendar automatically.</p>
      <div class="note-add">
        <textarea id="note-text" rows="2" placeholder='e.g. "Prof said prelim 2 will focus on chapters 5 to 7, especially hash tables"'></textarea>
        <button class="btn primary" id="note-save">Add note</button>
      </div>
      ${notes.map((n) => `
        <div class="note-row">
          <div><div class="muted" style="font-size:12px">${esc((n.created_at || "").slice(0, 10))}</div>${esc(n.text)}</div>
          <button class="btn small danger" data-del-note="${n.id}">✕</button>
        </div>`).join("")}
    </div>

    <div class="section-title"><h3>Syllabi & documents</h3>
      <button class="btn small" id="paste-btn">✏️ Paste text instead</button></div>
    <div class="card">
      ${docs.map((d) => `
        <div class="doc-row doc-open" data-doc="${d.id}" title="Click to open">
          <span>${d.kind === "pdf" ? "📕" : d.kind === "docx" ? "📘" : "📄"}</span>
          <div><div class="name">${esc(d.filename)}</div>
          <div class="meta">${esc(d.kind)} · added ${esc((d.uploaded_at || "").slice(0, 10))} · click to open</div></div>
          <div class="spacer"></div>
          <button class="btn small danger" data-del-doc="${d.id}">Remove</button>
        </div>`).join("") || `<p class="muted" style="margin:4px">No documents yet.</p>`}
      <div class="dropzone" id="dropzone">
        <b>Drop a syllabus here</b> or <a id="browse">browse</a> — PDF, Word, or text.<br>
        <span style="font-size:12.5px">Deadlines are auto-added to your calendar; key policies fill the course info.</span>
        <input type="file" id="file-input" accept=".pdf,.docx,.txt,.md" style="display:none">
      </div>
    </div>

    <div class="section-title"><h3>Deadlines from this course (${events.length})</h3></div>
    <div class="card">
      ${events.map((e) => `
        <div class="ev-row">
          <span class="ev-date">${fmtDate(e.date)}</span>
          <span class="kind-dot" style="background:${esc(c.color)}"></span>
          <span>${KIND_ICONS[e.kind] || "📅"} ${esc(e.title)}${e.time ? ` <span class="muted">${esc(e.time)}</span>` : ""}</span>
        </div>`).join("") || `<p class="muted" style="margin:4px">Nothing yet.</p>`}
    </div>`;

  $("#ask-this").addEventListener("click", () => { state.askCourse = String(courseId); navigate("ask"); });
  $("#del-course").addEventListener("click", async () => {
    if (!confirm(`Delete ${c.code} and all its documents, notes, and events?`)) return;
    await repo.delCourse(courseId);
    toast("Course deleted."); navigate("dashboard");
  });

  const saveAllow = async () => { await repo.saveAllowances(c); renderCourse(courseId); };
  $("#add-allow").addEventListener("click", () => openAddAllowance(c, saveAllow));
  $$("[data-allow-use]").forEach((b) => b.addEventListener("click", () => {
    const a = c.allowances[Number(b.dataset.allowUse)];
    if (a && a.remaining > 0) { a.remaining--; saveAllow(); }
  }));
  $$("[data-allow-undo]").forEach((b) => b.addEventListener("click", () => {
    const a = c.allowances[Number(b.dataset.allowUndo)];
    if (a && a.remaining < a.total) { a.remaining++; saveAllow(); }
  }));
  $$("[data-allow-del]").forEach((b) => b.addEventListener("click", () => {
    c.allowances.splice(Number(b.dataset.allowDel), 1);
    saveAllow();
  }));

  $("#note-save").addEventListener("click", async () => {
    const text = $("#note-text").value.trim();
    if (text.length < 3) return toast("Write the note first.", "err");
    try {
      const added = await repo.addNote(courseId, text.slice(0, 4000));
      toast(added ? `Note saved. ${added} deadline${added === 1 ? "" : "s"} added to your calendar.` : "Note saved.");
      renderCourse(courseId);
    } catch (err) { toast(err.message, "err"); }
  });
  $$("[data-del-note]").forEach((b) => b.addEventListener("click", async () => {
    await repo.delNote(b.dataset.delNote);
    renderCourse(courseId);
  }));

  $$(".doc-open").forEach((row) => row.addEventListener("click", () => openDocViewer(row.dataset.doc)));
  $$("[data-del-doc]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await repo.delDocument(b.dataset.delDoc);
    toast("Document removed."); renderCourse(courseId);
  }));
  $("#paste-btn").addEventListener("click", () => openPaste(courseId));

  const dz = $("#dropzone"), fi = $("#file-input");
  $("#browse").addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => fi.files[0] && uploadFile(courseId, fi.files[0]));
  ["dragover", "dragenter"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadFile(courseId, f); });
}

function openAddAllowance(course, onSave) {
  openModal(`
    <h3>Add a tracker</h3>
    <div class="field"><label>What is it?</label>
      <select id="al-type">
        <option>Class skips</option><option>Homework skips</option><option>Lab skips</option><option>Custom…</option>
      </select></div>
    <div class="field hidden" id="al-custom-row"><label>Custom name</label><input id="al-custom" placeholder="Excused absences"></div>
    <div class="field"><label>How many are allowed?</label><input id="al-total" type="number" min="1" max="99" value="3"></div>
    <div class="modal-actions"><button class="btn" id="al-cancel">Cancel</button>
    <button class="btn primary" id="al-save">Add</button></div>`);
  $("#al-type").addEventListener("change", (e) => {
    $("#al-custom-row").classList.toggle("hidden", e.target.value !== "Custom…");
  });
  $("#al-cancel").addEventListener("click", closeModal);
  $("#al-save").addEventListener("click", () => {
    const type = $("#al-type").value;
    const label = type === "Custom…" ? ($("#al-custom").value.trim().slice(0, 30) || "Skips") : type;
    const total = Math.max(1, Math.min(99, parseInt($("#al-total").value, 10) || 3));
    (course.allowances = course.allowances || []).push({
      label, emoji: ALLOW_EMOJI[label] || "🎟", total, remaining: total });
    closeModal(); onSave();
  });
}

async function uploadFile(courseId, file) {
  const dz = $("#dropzone");
  if (dz) dz.innerHTML = `<b>Reading ${esc(file.name)}…</b> extracting policies & deadlines`;
  try {
    const { text, kind } = await extractFile(file);
    const { doc, eventsAdded } = await ingestDocument(courseById(courseId), file.name, text, kind, false, file);
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

function scopeChipsHtml() {
  const allSel = !state.askCourse;
  return `<div class="scope-chips">
    <span class="scope-chip ${allSel ? "sel" : ""}" data-course="">All courses</span>
    ${state.db.courses.map((c) => `<span class="scope-chip ${String(c.id) === state.askCourse ? "sel" : ""}"
      data-course="${c.id}" style="${String(c.id) === state.askCourse ? `background:${esc(c.color)};border-color:${esc(c.color)};color:#fff` : ""}">${esc(c.code)}</span>`).join("")}
  </div>`;
}

function scrollChatBottom() {
  const el = $("#chat-scroll");
  if (el) el.scrollTop = el.scrollHeight;
}

async function renderAsk() {
  const current = repo.findCurrentSession();
  state.currentSessionId = current ? current.id : null;
  let messages = [];
  if (current) { try { messages = await repo.listChats(current.id); } catch (_e) { messages = []; } }
  state.msgs = messages.map((m) => ({ question: m.question, answer: m.answer, course_id: m.course_id }));
  const sessions = state.db.sessions.filter((s) => (s.title || "").length);
  const scopedCourse = state.askCourse ? courseById(state.askCourse) : null;

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Ask your syllabi</h1>
      <div class="sub">Answers come only from what you've uploaded, with quotes to prove it.</div></div>
      ${REMOTE && state.usage.on ? `<span class="chip" id="ai-counter" title="Resets at midnight UTC">🔋 ${state.usage.left}/${state.usage.limit} AI answers left today</span>` : ""}
    </div>
    <div class="ask-layout">
      <div class="chat-side">
        <button class="btn small wide" id="new-chat">＋ New chat</button>
        <div class="chat-side-title">History</div>
        ${sessions.map((s) => `
          <div class="chat-item ${s.id === state.currentSessionId ? "active" : ""}" data-session="${s.id}" title="Open and continue this chat">
            <div class="ci-title">${esc(s.title)}</div>
            <div class="ci-date">${esc((s.started_at || "").slice(5, 10).replace("-", "/"))}</div>
          </div>`).join("") || `<p class="muted" style="font-size:12px">No chats yet.</p>`}
      </div>
      <div class="chat-wrap">
        <div class="chat-scroll" id="chat-scroll">
          ${messages.length ? messages.map((m) => renderExchange(m)).join("") : `
            <div class="empty"><div class="big-ic">💬</div>Try one of these:</div>
            <div class="suggestions" style="justify-content:center">
              ${SUGGESTIONS.map((s) => `<span class="sug">${esc(s)}</span>`).join("")}</div>`}
        </div>
        <div class="ask-bar">
          ${scopeChipsHtml()}
          <form class="ask-box" id="ask-form" style="${scopedCourse ? `border-color:${esc(scopedCourse.color)}` : ""}">
            <input id="ask-input" placeholder="${scopedCourse ? `Asking about ${esc(scopedCourse.code)}…` : "Ask across all courses…"}" autocomplete="off">
            <button class="btn primary" id="ask-send" type="submit">Ask</button>
          </form>
        </div>
      </div>
    </div>`;

  $$(".sug").forEach((sug) => sug.addEventListener("click", () => { $("#ask-input").value = sug.textContent; submitAsk(); }));
  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); submitAsk(); });
  $$(".scope-chip").forEach((chip) => chip.addEventListener("click", () => {
    state.askCourse = chip.dataset.course;
    const typed = $("#ask-input") ? $("#ask-input").value : "";
    renderAsk().then(() => {
      const input = $("#ask-input");
      if (input) { input.value = typed; input.focus(); }
    });
  }));
  $("#new-chat").addEventListener("click", () => {
    chatMarker(true);
    state.msgs = [];
    renderAsk();
  });
  $$(".chat-item").forEach((item) => item.addEventListener("click", async () => {
    if (item.dataset.session === state.currentSessionId) return;
    await repo.resumeSession(item.dataset.session);
    renderAsk();
  }));
  bindAnswerActions();
  scrollChatBottom();
}

function renderExchange(msg) {
  return `<div class="msg-q">${esc(msg.question)}</div><div class="msg-a">${renderAnswer(msg.answer, msg)}</div>`;
}

function renderAnswer(a, msg) {
  const statusPill = a.status === "answered" ? `<span class="pill ok">✓ From your materials</span>`
    : a.status === "partial" ? `<span class="pill warn">◐ Partly covered</span>`
    : `<span class="pill bad">✕ Not in your materials</span>`;
  const routeLabels = { none: "📗 No email needed", ta: "🧑‍💻 Ask your TA", professor: "🎓 Ask your professor",
    classmate_or_lms: "👥 Classmate / course site", registrar_or_advisor: "🏛 Registrar / advisor" };
  const showRouteReason = a.route !== "none" && a.route_reason;
  const scopeChip = a.scope_note ? `<span class="chip">🎯 ${esc(a.scope_note)}</span>` : "";
  const cites = (a.citations || []).map((c) => `
    <div class="cite">
      <div class="src">📖 ${esc(c.label)}
        ${c.verified === false ? `<span class="unverified" title="This quote couldn't be matched verbatim to your documents.">⚠ unverified</span>` : ""}
        ${c.doc_id != null ? `<button class="btn small show-src" data-doc="${esc(String(c.doc_id))}" data-q="${esc(c.quote)}">📍 Show source</button>` : ""}
      </div>
      <div class="quote">“${esc(c.quote.length > 150 ? c.quote.slice(0, 150) + "…" : c.quote)}”</div>
    </div>`).join("");
  const citeLabel = ((a.citations || [])[0] || {}).label || "";
  const emailBtn = (a.route === "ta" || a.route === "professor")
    ? `<button class="btn small draft-email" data-q="${esc(msg.question)}" data-route="${a.route}"
        data-course="${msg.course_id || ""}" data-citelabel="${esc(citeLabel)}"
        data-ctx="${esc(((a.citations || []).map((c) => c.quote).join(" … ") + " " + (a.answer || "")).slice(0, 2000))}">
        ✉️ Draft the email for me</button>` : "";
  return `<div class="answer-card">
    <div class="answer-top">${statusPill}<span class="pill route-${esc(a.route)}">${routeLabels[a.route] || esc(a.route)}</span>${scopeChip}</div>
    <div class="answer-text">${esc(a.answer)}</div>
    ${a.unverified ? `<div class="mode-note">⚠ Couldn't verify this answer's quotes against your documents. Double-check before relying on it.</div>` : ""}
    ${showRouteReason ? `<div class="route-reason"><b>Who to ask:</b> ${esc(a.route_reason)}</div>` : ""}
    ${cites ? `<details class="cites"><summary>Sources (${(a.citations || []).length})</summary>${cites}</details>` : ""}
    ${a.note ? `<div class="mode-note">${esc(a.note)}</div>` : ""}
    <div class="answer-actions">${emailBtn}</div></div>`;
}

function bindAnswerActions() {
  $$(".draft-email").forEach((btn) => btn.addEventListener("click", () => {
    let courseId = btn.dataset.course || null;
    if (!courseId && btn.dataset.citelabel) {
      const code = btn.dataset.citelabel.split(" — ")[0].trim();
      const match = state.db.courses.find((c) => c.code === code);
      if (match) courseId = match.id;
    }
    openEmailDraft({ question: btn.dataset.q, recipient: btn.dataset.route, course_id: courseId, context: btn.dataset.ctx });
  }));
  $$(".show-src").forEach((btn) => btn.addEventListener("click", () => {
    openDocViewer(btn.dataset.doc, btn.dataset.q);
  }));
}

async function submitAsk() {
  const input = $("#ask-input");
  if (!input) return;
  const question = input.value.trim();
  if (!question) return;

  let courseId = state.askCourse || null;
  let scopeNote = "";
  const detected = detectCourseMention(question);
  if (detected && detected !== courseId) {
    courseId = detected;
    scopeNote = `Scoped to ${courseById(detected).code} because you mentioned it`;
  }

  const scroll = $("#chat-scroll");
  if (scroll.querySelector(".empty")) scroll.innerHTML = "";
  scroll.insertAdjacentHTML("beforeend",
    `<div class="msg-q">${esc(question)}</div><div class="thinking" id="thinking">Checking your materials…</div>`);
  input.value = "";
  $("#ask-send").disabled = true;
  scrollChatBottom();
  const hadSession = state.currentSessionId;
  try {
    const answer = await doAsk(question, courseId, scopeNote);
    $("#thinking").outerHTML = `<div class="msg-a">${renderAnswer(answer, { question, course_id: courseId })}</div>`;
    bindAnswerActions();
    const counter = $("#ai-counter");
    if (counter && state.usage.on) counter.textContent = `🔋 ${state.usage.left}/${state.usage.limit} AI answers left today`;
    if (hadSession !== state.currentSessionId) renderAsk(); // new chat appeared: refresh the history rail
  } catch (err) {
    $("#thinking").outerHTML = `<div class="msg-a"><div class="answer-card"><span class="pill bad">✕ ${esc(err.message)}</span></div></div>`;
  } finally {
    const send = $("#ask-send");
    if (send) send.disabled = false;
    scrollChatBottom();
  }
}

async function openEmailDraft(payload) {
  openModal(`<h3>Drafting your email…</h3><p class="muted">Grounded in your syllabus. Nothing invented.</p>`);
  let draft = null;
  const course = payload.course_id ? courseById(payload.course_id) : null;
  const code = course ? course.code : "your class";
  if (REMOTE && state.usage.on) {
    try {
      const res = await repo.invokeClaude({ kind: "draft", question: payload.question, code,
        recipient: payload.recipient, context: payload.context, student: state.user ? state.user.name : "[your name]" });
      if (res && res.result) draft = { ...res.result, mode: "ai" };
    } catch (_e) { /* template below */ }
  }
  if (!draft) {
    let toHint = "";
    if (course) {
      for (const d of docsOf(course.id)) {
        if (!d.facts) continue;
        if (payload.recipient === "ta" && d.facts.tas && d.facts.tas.length) toHint = d.facts.tas[0].email || "";
        if (!toHint) toHint = d.facts.instructor_email || "";
        if (toHint) break;
      }
    }
    const words = payload.question.split(/\s+/);
    const topic = words.slice(0, 9).join(" ") + (words.length > 9 ? "…" : "");
    const student = state.user ? state.user.name : "[Your name]";
    draft = {
      mode: "template",
      subject: (course ? `[${code}] ` : "") + (topic ? `Question: ${topic}` : "Quick question"),
      to_hint: toHint || (payload.recipient === "ta" ? "your TA (see course site)" : "your instructor"),
      body: `Dear ${payload.recipient === "professor" ? "Professor [name]" : "[TA's name]"},\n\n` +
        `${course ? `I'm in your ${code} class this term.` : "I'm in your class this term."} I checked the syllabus first, but I still wanted to ask: ${payload.question}\n\n` +
        `[One sentence of context: your situation, section, or dates.]\n\nThank you,\n${student}`,
    };
  }
  openModal(`
    <h3>✉️ Email draft</h3>
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
      toast("Copied. Paste it into your email app.");
    } catch (_e) { toast("Couldn't access clipboard. Select and copy manually.", "err"); }
  });
}

/* ---------- calendar ---------- */

function renderCalendar() {
  if (!state.calMonth) { const now = new Date(); state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1); }
  const year = state.calMonth.getFullYear(), month = state.calMonth.getMonth();
  const monthName = state.calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const byDate = {};
  for (const e of state.db.events) (byDate[e.date] = byDate[e.date] || []).push(e);
  const firstDow = new Date(year, month, 1).getDay();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - firstDow + i);
    const iso = isoOf(d);
    const evs = byDate[iso] || [];
    cells.push(`<div class="cal-cell ${d.getMonth() !== month ? "dim" : ""} ${iso === isoToday() ? "today" : ""}" data-date="${iso}">
      <div class="dnum">${d.getDate()}</div>
      ${evs.slice(0, 3).map((e) => {
        const c = e.course_id ? courseById(e.course_id) : null;
        return `<div class="cal-ev" style="background:${esc(c ? c.color : "#64748b")}" title="${esc(e.title)}">${e.time ? esc(e.time) + " " : ""}${c ? esc(c.code) + ": " : ""}${esc(e.title)}</div>`;
      }).join("")}
      ${evs.length > 3 ? `<div class="cal-more">+${evs.length - 3} more</div>` : ""}</div>`);
  }
  const dayEvents = state.selectedDay ? (byDate[state.selectedDay] || []) : [];

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Calendar</h1><div class="sub">Every deadline pulled from your syllabi and notes, plus anything you add or import.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="import-ics">⇪ Import .ics</button>
        <button class="btn" id="export-ics">⬇ Export .ics</button>
        <button class="btn primary" id="add-event">+ Event</button></div>
    </div>
    <p class="muted" style="margin:-8px 0 14px">💡 Canvas users: in Canvas go to Calendar → Calendar Feed, download the .ics file, then hit Import here. Every homework and quiz shows up right on this page.</p>
    <div class="cal-head">
      <button class="btn small" id="cal-prev">←</button><h2>${esc(monthName)}</h2>
      <button class="btn small" id="cal-next">→</button><button class="btn small" id="cal-today">Today</button>
    </div>
    <div class="cal-grid">
      ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${cells.join("")}
    </div>
    ${state.selectedDay ? `<div class="card day-panel"><h3>${fmtDate(state.selectedDay)}</h3>
      ${dayEvents.length ? dayEvents.map((e) => {
        const c = e.course_id ? courseById(e.course_id) : null;
        return `<div class="ev-row"><span class="kind-dot" style="background:${esc(c ? c.color : "#64748b")}"></span>
          <span>${KIND_ICONS[e.kind] || "📅"} ${c ? `<b>${esc(c.code)}</b> ` : ""}${esc(e.title)}
          ${e.time ? `<span class="muted">${esc(e.time)}</span>` : ""}
          <span class="chip" style="margin-left:6px">${esc(e.source)}</span></span>
          <span style="flex:1"></span>
          <button class="btn small danger" data-del-ev="${e.id}">Remove</button></div>`;
      }).join("") : `<p class="muted">Nothing on this day.</p>`}</div>` : ""}`;

  $("#cal-prev").addEventListener("click", () => { state.calMonth = new Date(year, month - 1, 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { state.calMonth = new Date(year, month + 1, 1); renderCalendar(); });
  $("#cal-today").addEventListener("click", () => { const now = new Date(); state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1); renderCalendar(); });
  $$(".cal-cell").forEach((cell) => cell.addEventListener("click", () => { state.selectedDay = cell.dataset.date; renderCalendar(); }));
  $$("[data-del-ev]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await repo.delEvent(b.dataset.delEv);
    renderCalendar();
  }));
  $("#add-event").addEventListener("click", openAddEvent);
  $("#import-ics").addEventListener("click", openImportIcs);
  $("#export-ics").addEventListener("click", () => {
    const blob = new Blob([generateIcs(state.db.events, "SyllabAI")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "syllabai.ics";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Downloaded. Import it into Google/Apple/Outlook calendar.");
  });
}

function courseOptions() {
  return [`<option value="">(no course)</option>`]
    .concat(state.db.courses.map((c) => `<option value="${c.id}">${esc(c.code)}</option>`)).join("");
}

function openAddEvent() {
  openModal(`
    <h3>Add event</h3>
    <div class="field"><label>Title *</label><input id="ne-title" placeholder="Essay 2 due"></div>
    <div class="row">
      <div class="field"><label>Date *</label><input id="ne-date" type="date" value="${state.selectedDay || isoToday()}"></div>
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
  $("#ne-save").addEventListener("click", async () => {
    const title = $("#ne-title").value.trim().slice(0, 140);
    const date = $("#ne-date").value;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast("An event needs a title and a date.", "err");
    try {
      await repo.addEvent({ course_id: $("#ne-course").value || null, title, date,
        time: $("#ne-time").value || "", kind: $("#ne-kind").value, source: "manual", details: "" });
      closeModal(); toast("Event added."); renderCalendar();
    } catch (err) { toast(err.message, "err"); }
  });
}

function openImportIcs() {
  openModal(`
    <h3>Import a course calendar</h3>
    <p class="muted">Canvas, Moodle & co. give every student a calendar export (look for "Calendar feed" / .ics). Download the .ics file and upload it here.</p>
    <div class="field"><label>.ics file</label><input id="ic-file" type="file" accept=".ics"></div>
    <div class="field"><label>Attach to course (optional)</label><select id="ic-course">${courseOptions()}</select></div>
    <div class="modal-actions"><button class="btn" id="ic-cancel">Cancel</button>
    <button class="btn primary" id="ic-go">Import</button></div>`);
  $("#ic-cancel").addEventListener("click", closeModal);
  $("#ic-go").addEventListener("click", async () => {
    const file = $("#ic-file").files[0];
    if (!file) return toast("Choose a .ics file first.", "err");
    const events = parseIcs(await file.text());
    if (!events.length) return toast("No usable events found in that calendar.", "err");
    try {
      const added = await repo.addEventsBulk($("#ic-course").value || null, null, events, "ics");
      closeModal(); toast(`Imported ${added} of ${events.length} events.`); renderCalendar();
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ---------- settings ---------- */

function renderSettings() {
  const theme = localStorage.getItem("msy-theme") || "light";
  $("#view").innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    <div class="settings-grid">
      <div class="card">
        <h3>🎨 Appearance</h3>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn ${theme === "light" ? "primary" : ""}" id="theme-light">☀️ Light</button>
          <button class="btn ${theme === "dark" ? "primary" : ""}" id="theme-dark">🌙 Dark</button>
        </div>
      </div>
      <div class="card">
        <h3>👤 Account</h3>
        ${REMOTE ? `
          <div class="kv"><span class="k">Name</span><span>${esc(state.user.name)}</span></div>
          <div class="kv"><span class="k">Email</span><span>${esc(state.user.email)}</span></div>
          ${state.usage.on ? `<div class="kv"><span class="k">AI answers</span><span>${state.usage.left} of ${state.usage.limit} left today</span></div>` : ""}
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn" id="clear-history">Clear Q&A history</button>
            <button class="btn danger" id="logout">Sign out</button>
          </div>` : `
          <p class="muted">Demo mode. Data lives only in this browser; there is no account.</p>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn" id="clear-history">Clear Q&A history</button>
            <button class="btn danger" id="wipe">Erase everything</button>
          </div>`}
      </div>
    </div>`;

  $("#theme-light").addEventListener("click", () => { applyTheme("light"); renderSettings(); });
  $("#theme-dark").addEventListener("click", () => { applyTheme("dark"); renderSettings(); });
  $("#clear-history").addEventListener("click", async () => {
    await repo.clearChats();
    toast("History cleared.");
  });
  const logout = $("#logout");
  if (logout) logout.addEventListener("click", async () => {
    await supa.auth.signOut();
    location.reload();
  });
  const wipe = $("#wipe");
  if (wipe) wipe.addEventListener("click", () => {
    if (!confirm("Erase ALL courses, documents, notes, events, and history from this browser?")) return;
    localDb = { courses: [], docs: [], events: [], notes: [], sessions: [], chats: [] };
    localSave();
    state.db = { courses: [], docs: [], events: [], notes: [], sessions: [] };
    toast("Wiped."); navigate("dashboard");
  });
}

/* ================= auth & boot ================= */

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  $("#auth-name-row").classList.toggle("hidden", mode === "login");
  $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#auth-toggle-text").textContent = mode === "login" ? "New here?" : "Already have an account?";
  $("#auth-toggle-link").textContent = mode === "login" ? "Create an account" : "Sign in instead";
  $("#auth-error").textContent = "";
}
$("#auth-toggle-link").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "login" ? "register" : "login");
});
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#auth-submit");
  btn.disabled = true;
  $("#auth-error").textContent = "";
  try {
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    if (authMode === "register") {
      const name = $("#auth-name").value.trim() || email.split("@")[0];
      const { data, error } = await supa.auth.signUp({ email, password, options: { data: { name } } });
      if (error) throw error;
      if (!data.session) {
        $("#auth-error").textContent = "Check your email to confirm the account, then sign in.";
        setAuthMode("login");
        return;
      }
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    await enterApp();
  } catch (err) {
    $("#auth-error").textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
});

async function enterApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (REMOTE) {
    const { data } = await supa.auth.getUser();
    const u = data.user;
    state.user = { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || u.email.split("@")[0] };
    $("#whoami").textContent = `${state.user.name} · ${state.user.email}`;
    repo.invokeClaude({ kind: "status" }).catch(() => { /* pill stays keyword mode */ });
  } else {
    $("#whoami").textContent = "🔒 Demo: everything stays in this browser";
  }
  renderAiPill();
  await repo.loadAll();
  navigate("dashboard");
}

$$("#nav .nav-item").forEach((a) => a.addEventListener("click", () => navigate(a.dataset.view)));

/* ---------- feedback ---------- */

const FEEDBACK_EMAIL = "dilanps2@illinois.edu";

function openFeedback() {
  openModal(`
    <h3>💡 Feedback</h3>
    <p class="muted">Ideas, bugs, feature requests. Goes straight to the developer.</p>
    <div class="field"><textarea id="fb-text" rows="6" placeholder="What should SyllabAI do better?"></textarea></div>
    <div class="modal-actions">
      <button class="btn" id="fb-cancel">Cancel</button>
      <button class="btn primary" id="fb-send">Send</button>
    </div>`);
  $("#fb-cancel").addEventListener("click", closeModal);
  $("#fb-send").addEventListener("click", async () => {
    const text = $("#fb-text").value.trim();
    if (text.length < 3) return toast("Write something first.", "err");
    try { await repo.sendFeedback(text); } catch (_e) { /* mailto below still delivers */ }
    window.open(`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("SyllabAI feedback")}&body=${encodeURIComponent(text.slice(0, 1500))}`);
    closeModal();
    toast("Thanks! Sent to the developer (your email app opened too, hit send there to make sure).");
  });
}
const fbLink = $("#feedback-link");
if (fbLink) fbLink.addEventListener("click", openFeedback);

async function boot() {
  renderAiPill();
  if (!REMOTE) {
    await enterApp();
    return;
  }
  const { data } = await supa.auth.getSession();
  if (data.session) await enterApp();
  else $("#auth").classList.remove("hidden");
}
boot();
