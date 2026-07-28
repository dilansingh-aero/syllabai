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

const COLOR_OPTIONS = [
  { name: "Lava Red", hex: "#dc2626" },
  { name: "Sunset Ember", hex: "#ea580c" },
  { name: "Golden Amber", hex: "#d97706" },
  { name: "Forest Green", hex: "#059669" },
  { name: "Ocean Teal", hex: "#0d9488" },
  { name: "Sky Blue", hex: "#2563eb" },
  { name: "Royal Indigo", hex: "#4f46e5" },
  { name: "Grape Violet", hex: "#7c3aed" },
  { name: "Rose Pink", hex: "#db2777" },
];
const COURSE_COLORS = COLOR_OPTIONS.map((o) => o.hex);
const KIND_ICONS = { exam: "📝", quiz: "❓", assignment: "📌", project: "📦", class: "🏫", other: "📅" };
const ALLOW_EMOJI = { "Class skips": "🏫", "Homework skips": "📌", "Lab skips": "🧪" };
const SESSION_GAP_MS = 30 * 60 * 1000;

const state = {
  user: null,                    // {id, email, name}
  usage: { on: false, limit: 0, used: 0, left: 0 },
  db: { courses: [], docs: [], events: [], notes: [], sessions: [], feeds: [] },
  askCourse: "", gradeCourse: "", calMonth: null, selectedDay: null,
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
const MONTHPAT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "October 8, 2026". The (?!\d) stops "October 2026" being read as day 20.
const MONTH_DATE_RE = new RegExp(`\\b(${MONTHPAT})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, "gi");
// "8 October 2026", "3rd Nov 2026": the norm outside the US.
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHPAT})\\b\\.?,?\\s*(\\d{4})?`, "gi");
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
// "11:59 pm", "9:00", and bare "5pm" / "5 p.m."
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|\b(\d{1,2}):(\d{2})\b/gi;
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
    for (const m of line.matchAll(DAY_MONTH_RE)) matches.push([MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), m[3]]);
    for (const m of line.matchAll(NUMERIC_DATE_RE)) {
      let mo = parseInt(m[1], 10), da = parseInt(m[2], 10);
      // 15/03/27 can only be day-first, so read it that way.
      if (mo > 12 && da >= 1 && da <= 12) { const swap = mo; mo = da; da = swap; }
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
      // A range ("7-9pm", "7:30-9:00 pm") means the START time; the meridiem
      // usually only appears at the end, so borrow it unless the range crosses
      // noon (11-1pm starts in the morning).
      const range = line.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:[-–—]|\bto\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
      // TIME_RE has two alternatives; normalize both into {hour, minute, mer}.
      const times = Array.from(line.matchAll(TIME_RE)).map((t) => ({
        hour: parseInt(t[1] !== undefined ? t[1] : t[4], 10),
        minute: parseInt((t[1] !== undefined ? t[2] : t[5]) || "0", 10),
        mer: (t[3] || "").toLowerCase().replace(/\./g, ""),
      })).filter((t) => !isNaN(t.hour));
      let time = "";
      if (range) {
        let hour = parseInt(range[1], 10);
        const minute = parseInt(range[2] || "0", 10);
        const endHour = parseInt(range[3], 10);
        const mer = range[5].toLowerCase().replace(/\./g, "");
        const startShares = hour <= endHour;
        if (mer === "pm" && startShares && hour < 12) hour += 12;
        if (mer === "am" && startShares && hour === 12) hour = 0;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) time = `${pad(hour)}:${pad(minute)}`;
      } else if (times.length) {
        const tm = times[0];
        let hour = tm.hour;
        const minute = tm.minute;
        let mer = tm.mer;
        if (!mer && hour <= 11 && times.some((t) => t.mer === "pm")) mer = "pm";
        if (mer === "pm" && hour < 12) hour += 12;
        if (mer === "am" && hour === 12) hour = 0;
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) time = `${pad(hour)}:${pad(minute)}`;
      }
      events.push({ title, date: iso, time, kind: classifyKind(line) });
    }
  }
  return events;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PERCENT_LINE_RE = /^(.{2,60}?)[:\s.–—-]*(\d{1,3})\s?%/;

const GRADE_NOISE_RE = /\b(late|loses?|lose|per day|answering|penalt|deduct|reduce[sd]?|miss|total|value|assignment type|up to|each|approximately)\b/i;

function cleanComponent(s) {
  return String(s).replace(/\s+/g, " ").replace(/^[\s\-:*•–●]+|[\s\-:*•–●]+$/g, "").trim();
}

function plausibleComponent(s) {
  return /[a-z]/i.test(s) && s.length >= 2 && s.length <= 45 && !/%/.test(s) && !GRADE_NOISE_RE.test(s);
}

// PDF tables often extract value-first ("Homework\n20%  Mini Projects\n10% ..."),
// which reads as gibberish line by line. Splitting into cells and pairing each
// percentage with the cell before it recovers the real breakdown.
function gradingFromCells(text) {
  const cells = text.split(/\n|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 1; i < cells.length && out.length < 12; i++) {
    const m = cells[i].match(/^(?:up to\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (!m) continue;
    const name = cleanComponent(cells[i - 1]);
    if (!plausibleComponent(name)) continue;
    out.push({ component: name, weight: m[1] + "%" });
  }
  return out;
}

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
      const component = cleanComponent(pm[1]);
      if (plausibleComponent(component)) f.grading.push({ component, weight: pm[2] + "%" });
    }
  }
  // Table-shaped breakdowns win, since a value-first table produces garbage
  // above; anything the line scan found that the table didn't is appended.
  const fromCells = gradingFromCells(text);
  if (fromCells.length >= 2) {
    const seen = new Set(fromCells.map((g) => g.component.toLowerCase()));
    f.grading = fromCells.concat(f.grading.filter((g) => !seen.has(g.component.toLowerCase()))).slice(0, 12);
  }
  f.late_policy = linesMatching(lines, /\b(late|slip day|grace period)\b/i, 3);
  f.attendance_policy = linesMatching(lines, /\b(attendance|absence|iclicker|participation required)\b/i, 2);
  f.exam_policy = linesMatching(lines, /\b(makeup|make-up|missed exam|exam conflict|conflict with)\b/i, 2);
  f.academic_integrity = linesMatching(lines, /\b(academic integrity|plagiarism|honor code|ai tools|chatgpt)\b/i, 2);
  f.textbook = linesMatching(lines, /\b(textbook|required text|isbn)\b/i, 2);
  f.location_or_modality = linesMatching(lines, /\b(lecture[s]?:|meets|room|hall \d|building|zoom)\b/i, 1);
  return f;
}

/* ---- allowance (skips/drops) detection ---- */

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, once: 1, twice: 2, thrice: 3 };
function toNum(s) { return WORDNUM[String(s).toLowerCase()] || parseInt(s, 10) || 0; }
const NUMPAT = "\\d+|one|two|three|four|five|six|seven|eight|nine|ten";
const SUBJPAT = "homework|hw|assignment|problem set|pset|quiz(?:zes)?|quiz|lab|tutorial|reading|discussion";

function normSubject(s) {
  const l = String(s || "").toLowerCase();
  if (/^hw$|^homework$/.test(l)) return "Homework";
  if (/^pset$|^problem set$/.test(l)) return "Problem set";
  if (/^quiz/.test(l)) return "Quiz";
  return cap(l);
}

function labelEmoji(label) {
  const l = label.toLowerCase();
  if (/class|lecture|absence|attend/.test(l)) return "🏫";
  if (/homework|hw|assignment|pset|problem/.test(l)) return "📌";
  if (/lab/.test(l)) return "🧪";
  if (/quiz/.test(l)) return "❓";
  return "🎟";
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function extractAllowancesHeuristic(text) {
  const found = [];
  const add = (label, total) => { if (total >= 1 && total <= 30) found.push({ label, total }); };
  let m;
  if ((m = text.match(new RegExp(`(${NUMPAT})\\s+(?:free\\s+)?slip days?`, "i")))) add("Slip days", toNum(m[1]));
  if ((m = text.match(new RegExp(`(${NUMPAT})\\s+(?:free\\s+)?(?:grace|late) days?`, "i")))) add("Late days", toNum(m[1]));
  if ((m = text.match(new RegExp(`miss (?:up to )?(${NUMPAT})\\s+(lectures?|classes|tutorials?|labs?|sessions?|discussions?)`, "i")))) {
    add(/tutorial/i.test(m[2]) ? "Tutorial skips" : /lab/i.test(m[2]) ? "Lab skips" : "Class skips", toNum(m[1]));
  }
  // "3 unexcused absences", "3 absences are allowed", "you are allowed three absences"
  const GRANT = "allowed|permitted|granted|entitled to|may take|can take|get|have|receive";
  if ((m = text.match(new RegExp(`(${NUMPAT})\\s+(?:unexcused |excused )?absences?(?:\\s+(?:are\\s+|is\\s+)?(?:${GRANT}))?`, "i")))
    && /unexcused|excused|allowed|permitted|granted/i.test(m[0])) add("Absences", toNum(m[1]));
  else if ((m = text.match(new RegExp(`(?:${GRANT})\\s+(?:up to\\s+)?(${NUMPAT})\\s+(?:unexcused |excused )?absences?`, "i")))) {
    add("Absences", toNum(m[1]));
  }
  if ((m = text.match(new RegExp(`(${NUMPAT})\\s+free (?:passes|skips|absences)`, "i")))) add("Free passes", toNum(m[1]));
  if ((m = text.match(new RegExp(`(?:get|have|receive|given|allowed)\\s+(${NUMPAT})\\s+(?:free\\s+)?drops\\b`, "i")))) add("Dropped scores", toNum(m[1]));

  // "5 homework drops", "2 quiz skips", "3 lab passes"
  const nounOf = (w) => /skip|miss/i.test(w) ? "skips" : /pass/i.test(w) ? "passes" : "drops";
  const subjDropRe = new RegExp(`(${NUMPAT})\\s+(${SUBJPAT})\\s+(drops?|skips?|passes|misses)\\b`, "gi");
  while ((m = subjDropRe.exec(text))) add(`${normSubject(m[2])} ${nounOf(m[3])}`, toNum(m[1]));

  // "homework drops: 5", "quiz skips = 2"
  const colonDropRe = new RegExp(`(${SUBJPAT})\\s+(drops?|skips?|passes)\\s*[:=-]\\s*(${NUMPAT})\\b`, "gi");
  while ((m = colonDropRe.exec(text))) add(`${normSubject(m[1])} ${nounOf(m[2])}`, toNum(m[3]));

  // "we drop two labs from the final score"
  const dropNSubjRe = new RegExp(`drops?\\s+(?:the\\s+|your\\s+)?(${NUMPAT})\\s+(?:lowest\\s+)?(${SUBJPAT})`, "gi");
  while ((m = dropNSubjRe.exec(text))) add(`${normSubject(m[2])} drops`, toNum(m[1]));

  // Any line pairing "lowest" with "drop" is a drop policy. The subjects come
  // from the whole line, so "Labs will have two lowest scores dropped" is Lab
  // drops, and "Lecture Activities and Homeworks will each have the lowest 2
  // scores dropped" becomes one tracker per subject.
  for (const line of text.split(/\r?\n/)) {
    if (!/lowest/i.test(line) || !/drop/i.test(line)) continue;
    const nm = line.match(new RegExp(`(${NUMPAT})\\s+lowest`, "i"))
      || line.match(new RegExp(`lowest\\s+(${NUMPAT})`, "i"));
    const total = nm ? toNum(nm[1]) : 1;
    const subs = subjectsInLine(line);
    if (subs.length) for (const s of subs) add(`${s} drops`, total);
    else add("Dropped scores", total);
  }

  // "(2 drops)" tucked inside a grading line: name it from the component,
  // e.g. "Homework Assignments (approximately 11; 1 drop): 55%".
  for (const line of text.split(/\r?\n/)) {
    let lm;
    const inline = new RegExp(`\\b(${NUMPAT})\\s+drops?\\b`, "gi");
    while ((lm = inline.exec(line))) {
      const subs = subjectsInLine(line);
      const comp = line.match(/^(.{2,60}?)\s*[(:]/);
      let label;
      if (subs.length === 1) label = `${subs[0]} drops`;
      else if (comp) {
        const cs = subjectsInLine(comp[1]);
        label = `${cs.length ? cs[0] : comp[1].trim().replace(/\s+/g, " ").slice(0, 22)} drops`;
      } else if (subs.length) label = `${subs[0]} drops`;
      else label = "Dropped scores";
      add(label, toNum(lm[1]));
    }
  }

  // "you can make it up ... twice a term" (newlines allowed; PDFs wrap freely)
  const makeupRe = /make\s+(?:it|them|these|one)\s+up[^.]{0,80}?\b(once|twice|thrice|\d+|one|two|three|four|five)\s*(?:times?)?\s+(?:a|per)\s+(?:term|semester|quarter|year)/gi;
  while ((m = makeupRe.exec(text))) {
    const window = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
    const subs = subjectsInLine(window);
    add(subs.length === 1 ? `${subs[0]} makeups` : "Makeups", toNum(m[1]));
  }
  return found;
}

// Subjects mentioned anywhere in a policy line, most specific first.
const SUBJ_WORDS = [
  ["lecture activit", "Lecture activity"], ["iclicker", "iClicker"], ["clicker", "Clicker"],
  ["homework", "Homework"], ["problem set", "Problem set"], ["pset", "Problem set"],
  ["assignment", "Assignment"], ["quiz", "Quiz"], ["lab", "Lab"], ["tutorial", "Tutorial"],
  ["discussion", "Discussion"], ["reading", "Reading"], ["project", "Project"],
  ["lecture", "Lecture"], ["participation", "Participation"], ["attendance", "Attendance"],
];

function subjectsInLine(line) {
  const l = line.toLowerCase();
  const found = [];
  for (const [key, label] of SUBJ_WORDS) {
    if (!l.includes(key)) continue;
    if (found.some((f) => f.startsWith(label) || label.startsWith(f))) continue;
    found.push(label);
  }
  return found;
}

function mergeAllowances(course, found) {
  course.allowances = course.allowances || [];
  const existing = new Set(course.allowances.map((a) => a.label.toLowerCase().trim()));
  let added = 0;
  for (const f of found.slice(0, 8)) {
    const label = String(f.label || "").slice(0, 30).trim();
    const total = Math.max(1, Math.min(99, parseInt(f.total, 10) || 0));
    if (!label || !f.total || existing.has(label.toLowerCase())) continue;
    existing.add(label.toLowerCase());
    course.allowances.push({ label, emoji: labelEmoji(label), total, remaining: total });
    added++;
  }
  return added;
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
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const text = htmlToText(await file.text());
    if (text.length < 40) throw new Error("That page has no readable text.");
    return { text, kind: "html" };
  }
  if (name.endsWith(".mhtml") || name.endsWith(".mht")) {
    // Chrome's default "Webpage, Single File" save format.
    const html = mhtmlToHtml(await file.text());
    const text = html ? htmlToText(html) : "";
    if (text.length < 40) throw new Error("Couldn't read that saved page. Re-save it as 'Webpage, HTML Only' and try again.");
    return { text, kind: "html" };
  }
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return { text: await file.text(), kind: "txt" };
  }
  throw new Error("Unsupported file type. Upload a .pdf, .docx, .html, .txt, or .md file.");
}

// Pull the html part out of an MHTML (MIME) package.
function mhtmlToHtml(raw) {
  const htmlAt = raw.search(/content-type:\s*text\/html/i);
  if (htmlAt < 0) return null;
  let headEnd = raw.indexOf("\r\n\r\n", htmlAt);
  if (headEnd < 0) headEnd = raw.indexOf("\n\n", htmlAt);
  if (headEnd < 0) return null;
  const head = raw.slice(htmlAt, headEnd);
  let body = raw.slice(headEnd).trim();
  const bm = raw.match(/boundary="?([^"\r\n]+)"?/i);
  if (bm) {
    const cut = body.indexOf("--" + bm[1]);
    if (cut > 0) body = body.slice(0, cut);
  }
  if (/content-transfer-encoding:\s*base64/i.test(head)) {
    try { return atob(body.replace(/\s+/g, "")); } catch (_e) { return null; }
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    return body.replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

// Saved webpages (common for NZ course outlines) become plain text with the
// block structure kept as line breaks, so headings and tables survive.
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, iframe, svg").forEach((el) => el.remove());
  doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
  doc.querySelectorAll("td, th").forEach((el) => el.append("  "));
  doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, table, section, article, dt, dd")
    .forEach((el) => el.append("\n"));
  const text = (doc.body ? doc.body.textContent : doc.textContent) || "";
  return text.replace(/\u00A0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const UPLOADABLE_RE = /\.(pdf|docx|txt|md|html?|mht(?:ml)?)$/i;

// Turn a drop into a flat file list, walking folders (course-outline packs).
// Entries must be grabbed before the first await or the DataTransfer goes stale.
async function collectFiles(dt) {
  const out = [];
  const entries = dt.items
    ? [...dt.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean)
    : [];
  const plainFiles = [...(dt.files || [])];
  const walk = async (entry) => {
    if (out.length >= 12 || !entry) return;
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f && UPLOADABLE_RE.test(f.name)) out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const e of batch) await walk(e);
      } while (batch.length && out.length < 12);
    }
  };
  if (entries.length) for (const e of entries) await walk(e);
  else for (const f of plainFiles) if (UPLOADABLE_RE.test(f.name)) out.push(f);
  return out.slice(0, 12);
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
// state.db is the source of truth; repo methods reassign its arrays, so sync
// them back into localDb before writing (chats live only in localDb).
function localSave() {
  if (state.db.courses !== undefined) {
    localDb = { ...localDb, courses: state.db.courses, docs: state.db.docs,
      events: state.db.events, notes: state.db.notes, sessions: state.db.sessions };
  }
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localDb));
}

async function sbThrow(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

const repo = {
  async loadAll() {
    if (REMOTE) {
      const [courses, docs, events, notes, sessions, feeds] = await Promise.all([
        sbThrow(supa.from("courses").select("*").order("created_at")),
        sbThrow(supa.from("documents").select("id, course_id, filename, kind, facts, facts_mode, chunks, file_path, uploaded_at").order("uploaded_at")),
        sbThrow(supa.from("events").select("*").order("date")),
        sbThrow(supa.from("notes").select("id, course_id, text, created_at").order("created_at", { ascending: false })),
        sbThrow(supa.from("chat_sessions").select("*").order("last_at", { ascending: false })),
        supa.from("feeds").select("*").then(({ data }) => data || []),
      ]);
      state.db = { courses, docs, events, notes, sessions, feeds };
    } else {
      state.db = {
        courses: localDb.courses, docs: localDb.docs, events: localDb.events,
        notes: localDb.notes, sessions: localDb.sessions, feeds: [],
      };
    }
  },

  // Older databases may lack newer columns; retry without whichever one the
  // error names until the write goes through.
  async _courseWrite(op, payload) {
    const optional = ["description", "facts_override", "grades"];
    for (let attempt = 0; attempt <= optional.length; attempt++) {
      try {
        return await op(payload);
      } catch (e) {
        const missing = optional.find((col) => col in payload && String(e.message).includes(col));
        if (!missing) throw e;
        payload = { ...payload };
        delete payload[missing];
        if (!Object.keys(payload).length) return;
      }
    }
  },

  async addCourse(fields) {
    const course = { id: uuid(), allowances: [], description: "", facts_override: {}, grades: {}, ...fields };
    if (REMOTE) {
      await this._courseWrite((p) => sbThrow(supa.from("courses").insert(p)),
        { ...course, user_id: state.user.id });
    }
    state.db.courses.push(course);
    if (!REMOTE) localSave();
    return course;
  },

  async updateCourse(course, fields) {
    Object.assign(course, fields);
    if (REMOTE) {
      await this._courseWrite((p) => sbThrow(supa.from("courses").update(p).eq("id", course.id)), fields);
    } else {
      localSave();
    }
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

  /* ---- shared courses (remote only) ---- */

  async shareCourse(course) {
    const docs = [];
    for (const d of docsOf(course.id)) {
      try {
        const src = await this.getSource(d.id);
        if (src) docs.push({ filename: d.filename, kind: d.kind, text: src.text,
          chunks: d.chunks || [], facts: d.facts || null });
      } catch (_e) { /* skip */ }
    }
    const events = state.db.events.filter((e) => e.course_id === course.id)
      .map((e) => ({ title: e.title, date: e.date, time: e.time, kind: e.kind, details: e.details || "" }));
    const snapshot = {
      owner_id: state.user.id, code: course.code, title: course.title || "",
      term: course.term || "", instructor: course.instructor || "", color: course.color,
      description: course.description || "",
      allowances: (course.allowances || []).map((a) => ({ ...a, remaining: a.total })),
      docs, events,
    };
    const existing = await sbThrow(supa.from("shared_courses").select("id")
      .eq("owner_id", state.user.id).eq("code", course.code).maybeSingle());
    if (existing) {
      await sbThrow(supa.from("shared_courses").update(snapshot).eq("id", existing.id));
      return existing.id;
    }
    const row = await sbThrow(supa.from("shared_courses").insert(snapshot).select("id").single());
    return row.id;
  },

  async searchShared(q) {
    const safe = q.replace(/[%,()]/g, " ").trim();
    if (safe.length < 2) return [];
    return await sbThrow(supa.from("shared_courses")
      .select("id, code, title, term, instructor, color, created_at")
      .or(`code.ilike.%${safe}%,title.ilike.%${safe}%,instructor.ilike.%${safe}%`)
      .order("created_at", { ascending: false }).limit(8));
  },

  async getShared(id) {
    return await sbThrow(supa.from("shared_courses").select("*").eq("id", id).single());
  },

  async importShared(shared) {
    const course = await this.addCourse({ code: shared.code, title: shared.title,
      term: shared.term, instructor: shared.instructor, color: shared.color,
      description: shared.description || "",
      allowances: (shared.allowances || []).map((a) => ({ ...a, remaining: a.total })) });
    for (const d of shared.docs || []) {
      await this.addDocument({ id: uuid(), course_id: course.id, filename: d.filename,
        kind: d.kind, text: d.text, chunks: d.chunks || [], facts: d.facts || null,
        facts_mode: d.facts ? "ai" : "heuristic", file_path: "",
        uploaded_at: new Date().toISOString() }, null);
    }
    if ((shared.events || []).length) await this.addEventsBulk(course.id, null, shared.events, "shared");
    return course;
  },

  /* ---- calendar feeds (remote only) ---- */

  async addFeed(url) {
    const row = { id: uuid(), url, added_at: new Date().toISOString() };
    await sbThrow(supa.from("feeds").insert({ ...row, user_id: state.user.id }));
    state.db.feeds.push(row);
    return row;
  },

  async delFeed(id) {
    await sbThrow(supa.from("feeds").delete().eq("id", id));
    state.db.feeds = state.db.feeds.filter((f) => f.id !== id);
  },

  async getDigestPref() {
    const { data } = await supa.from("digest_prefs").select("enabled")
      .eq("user_id", state.user.id).maybeSingle();
    return data ? data.enabled : true;
  },

  async setDigestPref(enabled) {
    await sbThrow(supa.from("digest_prefs").upsert({ user_id: state.user.id, enabled }));
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
  let allowancesFound = null;
  if (REMOTE && state.usage.on && !quiet) {
    try {
      const res = await repo.invokeClaude({ kind: "extract", text, code: course.code, term: course.term || "" });
      if (res && res.result) {
        doc.facts = res.result.facts;
        doc.facts_mode = "ai";
        events = (res.result.events || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
          .map((e) => ({ ...e, time: /^\d{2}:\d{2}$/.test(e.time) ? e.time : "" }));
        if (Array.isArray(res.result.allowances) && res.result.allowances.length) {
          allowancesFound = res.result.allowances;
        }
      }
    } catch (_e) { /* heuristics below */ }
  }
  if (!doc.facts) {
    doc.facts = extractFactsHeuristic(text);
    events = extractEventsHeuristic(text);
  }
  if (!allowancesFound) allowancesFound = extractAllowancesHeuristic(text);
  await repo.addDocument(doc, file);
  const eventsAdded = await repo.addEventsBulk(course.id, doc.id, events, "auto");
  const allowancesAdded = mergeAllowances(course, allowancesFound);
  if (allowancesAdded) await repo.saveAllowances(course);
  return { doc, eventsAdded, allowancesAdded };
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

// Words that carry no topic: they say how a question is phrased, not what it
// is about. Excluded from coverage so "who handles regrades" is judged on
// "regrades" alone, while "refund policy for parking" still fails on the two
// content words the materials have never heard of.
const ASK_WORDS = new Set(["who","whom","whose","which","why","where","should","need","needs","must",
  "get","gets","got","have","has","had","about","from","than","then","they","them","their","its","our",
  "us","so","but","not","no","yes","please","tell","know","did","done","was","were","been","being",
  "would","could","should","may","might","take","takes","go","goes","going","happen","happens","handle",
  "handles","work","works","use","used","using","many","much","long","often","allowed","am","re","ve"]);

// How much of the question's topic the top passage covers. BM25 scores are
// corpus-relative, so a short question against a short syllabus can score low
// while still being an obvious match; coverage catches those.
function termCoverage(question, text) {
  const terms = [...new Set(tokenize(question))].filter((t) => !ASK_WORDS.has(t));
  if (!terms.length) return 0;
  const hay = " " + tokenize(text).join(" ") + " ";
  const present = (term) =>
    hay.includes(" " + term + " ") || (SYNONYMS[term] || []).some((s) => hay.includes(" " + s + " "));
  return terms.filter(present).length / terms.length;
}

function heuristicAnswer(question, excerpts) {
  const passages = excerpts.filter((e) => e.id !== 0);
  const top = passages[0];
  const found = Boolean(top) &&
    ((top.score || 0) >= 1.2 || termCoverage(question, top.text) >= 0.5);
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
  else if (view === "grades") renderGrades();
  else if (view === "calendar") renderCalendar();
  else if (view === "settings") renderSettings();
}
window.navigate = navigate;

/* ---------- dashboard ---------- */

/* Green when plenty remain, sliding to red as they run out. */
function allowColor(remaining, total) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return `hsl(${Math.round(120 * ratio)}, 68%, 38%)`;
}

function colorSelectHtml(id, selectedHex) {
  const sel = COLOR_OPTIONS.some((o) => o.hex === selectedHex) ? selectedHex : COLOR_OPTIONS[0].hex;
  return `<div class="color-pick">
    <span class="color-swatch" id="${id}-swatch" style="background:${sel}"></span>
    <select id="${id}">${COLOR_OPTIONS.map((o) =>
      `<option value="${o.hex}" ${o.hex === sel ? "selected" : ""}>${o.name}</option>`).join("")}</select>
  </div>`;
}

function bindColorSelect(id) {
  const el = $("#" + id);
  el.addEventListener("change", () => { $("#" + id + "-swatch").style.background = el.value; });
  return () => el.value;
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
          ${c.description ? `<div class="cdesc">${esc(c.description)}</div>` : ""}
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

// Best guess at course code / title / term / instructor from the first lines
// of a syllabus, so a dropped file can become a fully-named course.
function guessCourseMeta(text, filename) {
  const head = text.split(/\r?\n/).slice(0, 60).map((l) => l.trim()).filter(Boolean);
  const meta = { code: "", title: "", term: "", instructor: "" };
  const codeRe = /\b([A-Z]{2,5})\s?-?\s?(\d{3,4}[A-Z]?)\b/;
  const notCodes = new Set(["FALL", "SPRING", "SUMMER", "WINTER", "ROOM", "HALL", "SUITE", "PHONE"]);
  for (const line of head) {
    const m = line.match(codeRe);
    if (!m || notCodes.has(m[1])) continue;
    meta.code = `${m[1]} ${m[2]}`;
    const after = line.slice(line.indexOf(m[0]) + m[0].length).replace(/^[\s:.·–—-]+/, "").trim();
    if (after.length >= 4 && after.length <= 90 && !/university|college|department|semester/i.test(after)) {
      meta.title = after;
    }
    break;
  }
  if (!meta.code && filename) {
    // Separators keep word boundaries from forming: ECE210_outline, cs-225.pdf
    const m = filename.toUpperCase().replace(/[^A-Z0-9]+/g, " ").match(codeRe);
    if (m && !notCodes.has(m[1])) meta.code = `${m[1]} ${m[2]}`;
  }
  const termM = text.match(/\b(fall|spring|summer|winter)\s*'?(\d{2}|\d{4})\b/i);
  if (termM) meta.term = `${cap(termM[1].toLowerCase())} ${termM[2].length === 2 ? "20" + termM[2] : termM[2]}`;
  for (const l of head) {
    const tm = l.match(/course title\s*:?\s*(.{3,90})/i);
    if (tm) { meta.title = tm[1].replace(/[●•·|]+.*$/, "").trim().slice(0, 120); break; }
  }
  for (const l of head) {
    const im = l.match(/^(?:instructor|professor|taught by)s?\s*:?\s*(.{3,})$/i);
    if (im) { meta.instructor = im[1].replace(EMAIL_RE, "").replace(/[()]/g, "").replace(/[●•·|]+.*$/, "").trim().slice(0, 80); break; }
  }
  return meta;
}

function openAddCourse() {
  const startColor = COURSE_COLORS[state.db.courses.length % COURSE_COLORS.length];
  openModal(`
    <h3>Add a course</h3>
    <p style="margin:4px 0 10px"><b>Fastest:</b> drop the syllabus or course outline. Code, title, course info, deadlines, and skip trackers all fill in automatically.</p>
    <div class="field"><label>Color</label>${colorSelectHtml("ac-color", startColor)}</div>
    <div class="dropzone" id="ac-drop">
      <b>Drop files or a whole course folder here</b><br>
      or <a id="ac-browse">browse files</a> · <a id="ac-folder-link">choose a folder</a> — PDF, Word, HTML, or text
      <input type="file" id="ac-file" accept=".pdf,.docx,.txt,.md,.html,.htm,.mhtml,.mht" multiple style="display:none">
      <input type="file" id="ac-folder" webkitdirectory style="display:none">
    </div>
    ${REMOTE ? `
    <div class="add-divider">or grab a course a classmate shared</div>
    <div class="field" style="position:relative">
      <input id="ac-search" placeholder="Search by code, title, or professor…" autocomplete="off">
      <div class="type-results" id="ac-results"></div>
    </div>` : ""}
    <div class="add-divider">or</div>
    <p style="text-align:center;margin:2px 0"><a id="ac-manual">✏️ Enter the details manually</a></p>
    <div class="modal-actions"><button class="btn" id="ac-cancel">Cancel</button></div>`);
  const getColor = bindColorSelect("ac-color");
  $("#ac-cancel").addEventListener("click", closeModal);
  $("#ac-manual").addEventListener("click", () => openAddCourseManual(getColor()));
  const fi = $("#ac-file"), fo = $("#ac-folder"), dz = $("#ac-drop");
  $("#ac-browse").addEventListener("click", () => fi.click());
  $("#ac-folder-link").addEventListener("click", () => fo.click());
  const start = (files) => { if (files && files.length) addCourseFromFiles(files, getColor()); };
  fi.addEventListener("change", () => start([...fi.files]));
  fo.addEventListener("change", () => start([...fo.files].filter((f) => UPLOADABLE_RE.test(f.name))));
  ["dragover", "dragenter"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { collectFiles(e.dataTransfer).then(start); });
  if (REMOTE) bindSharedSearch();
}

// One file or a whole folder: the outline/syllabus (by name, else the first
// readable file) names the course and gets the AI extract; the rest ingest
// with free heuristics so a 10-file folder still costs one AI call.
async function addCourseFromFiles(files, color) {
  files = files.slice(0, 12);
  if (!files.length) return toast("No PDF, Word, or text files in that.", "err");
  openModal(`<h3>Reading ${files.length === 1 ? esc(files[0].name) : files.length + " files"}…</h3>
    <p class="muted">Pulling out the course, its info, deadlines, and skips.</p>`);
  const extracted = [];
  for (const f of files) {
    try { extracted.push({ file: f, ...(await extractFile(f)) }); }
    catch (_e) { /* one unreadable file shouldn't sink the folder */ }
  }
  if (!extracted.length) {
    closeModal(); toast("Couldn't read any of those files.", "err");
    return openAddCourse();
  }
  const primary = extracted.find((x) => /outline|syllabus/i.test(x.file.name)) || extracted[0];
  try {
    const meta = guessCourseMeta(primary.text, primary.file.name);
    const course = await repo.addCourse({
      code: meta.code || primary.file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "New course",
      title: meta.title, term: meta.term, instructor: meta.instructor, color });
    let ev = 0, al = 0;
    for (const x of extracted) {
      const r = await ingestDocument(course, x.file.name, x.text, x.kind, x !== primary, x.file);
      ev += r.eventsAdded; al += r.allowancesAdded;
    }
    closeModal();
    toast(`${course.code} is set up: ${extracted.length} document${extracted.length === 1 ? "" : "s"}, ${ev} deadline${ev === 1 ? "" : "s"}`
      + (al ? `, ${al} skip tracker${al === 1 ? "" : "s"}` : "") + ".");
    navigate("course", course.id);
  } catch (err) { closeModal(); toast(err.message, "err"); openAddCourse(); }
}

function bindSharedSearch() {
  const input = $("#ac-search"), results = $("#ac-results");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const rows = await repo.searchShared(q);
        results.innerHTML = rows.length ? rows.map((r) => `
          <div class="type-row" data-shared="${r.id}">
            <span class="kind-dot" style="background:${esc(r.color)}"></span>
            <span class="tr-main"><b>${esc(r.code)}</b> ${esc(r.title || "")}</span>
            <span class="tr-sub">${esc([r.instructor, r.term].filter(Boolean).join(" · "))}</span>
            <span class="btn small primary">Add</span>
          </div>`).join("")
        : `<div class="type-row muted" style="cursor:default">Nothing shared under that yet. Add it yourself, then hit Share so classmates get it free.</div>`;
        $$(".type-row[data-shared]", results).forEach((row) =>
          row.addEventListener("click", () => importSharedById(row.dataset.shared)));
      } catch (e) { results.innerHTML = `<div class="type-row muted" style="cursor:default">${esc(e.message)}</div>`; }
    }, 250);
  });
}

async function importSharedById(id) {
  openModal(`<h3>Importing…</h3><p class="muted">Copying the course into your account.</p>`);
  try {
    const shared = await repo.getShared(id);
    const course = await repo.importShared(shared);
    closeModal();
    const nd = (shared.docs || []).length, ne = (shared.events || []).length;
    toast(`${course.code} imported: ${nd} document${nd === 1 ? "" : "s"}, ${ne} deadline${ne === 1 ? "" : "s"}.`);
    navigate("course", course.id);
  } catch (err) { closeModal(); toast(err.message, "err"); }
}

async function handleShareHash() {
  const m = location.hash.match(/^#share=([\w-]{10,})$/);
  if (!m || !REMOTE || !state.user) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const shared = await repo.getShared(m[1]);
    const nd = (shared.docs || []).length, ne = (shared.events || []).length;
    openModal(`
      <h3>Add this shared course?</h3>
      <p><b>${esc(shared.code)}</b> ${esc(shared.title || "")}<br>
        <span class="muted">${esc([shared.instructor, shared.term].filter(Boolean).join(" · "))}${nd || ne ? ` · ${nd} document${nd === 1 ? "" : "s"}, ${ne} deadline${ne === 1 ? "" : "s"}` : ""}</span></p>
      <div class="modal-actions"><button class="btn" id="shx-no">Not now</button>
      <button class="btn primary" id="shx-yes">Add to my courses</button></div>`);
    $("#shx-no").addEventListener("click", closeModal);
    $("#shx-yes").addEventListener("click", () => importSharedById(shared.id));
  } catch (_e) { toast("That share link doesn't work anymore.", "err"); }
}

function openAddCourseManual(startColor) {
  openModal(`
    <h3>Add a course</h3>
    <div class="field"><label>Course code *</label><input id="nc-code" placeholder="CS 2110"></div>
    <div class="field"><label>Title</label><input id="nc-title" placeholder="Data Structures"></div>
    <div class="field"><label>Description</label><textarea id="nc-desc" rows="2" placeholder="Anything worth remembering about this class"></textarea></div>
    <div class="row">
      <div class="field"><label>Term</label><input id="nc-term" placeholder="Fall 2026"></div>
      <div class="field"><label>Instructor</label><input id="nc-inst" placeholder="Prof. Smith"></div>
    </div>
    <div class="field"><label>Color</label>${colorSelectHtml("nc-color", startColor)}</div>
    <div class="modal-actions"><button class="btn" id="nc-cancel">Cancel</button>
    <button class="btn primary" id="nc-save">Add course</button></div>`);
  const getColor = bindColorSelect("nc-color");
  $("#nc-cancel").addEventListener("click", closeModal);
  $("#nc-save").addEventListener("click", async () => {
    const code = $("#nc-code").value.trim().slice(0, 40);
    if (!code) return toast("Course code is required (e.g. CS 2110).", "err");
    try {
      const course = await repo.addCourse({ code, title: $("#nc-title").value.trim().slice(0, 120),
        description: $("#nc-desc").value.trim().slice(0, 300),
        term: $("#nc-term").value.trim().slice(0, 40), instructor: $("#nc-inst").value.trim().slice(0, 80),
        color: getColor() });
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
  // Newest upload wins per field; older documents only fill what's still missing.
  for (const doc of [...docs].reverse()) {
    const f = doc.facts || {};
    for (const k of keys) if (!merged[k] && f[k]) merged[k] = f[k];
    if (!merged.grading.length && Array.isArray(f.grading)) merged.grading = f.grading;
    if (Array.isArray(f.tas)) merged.tas = merged.tas.concat(f.tas);
    if (Array.isArray(f.other_key_policies)) merged.other_key_policies = merged.other_key_policies.concat(f.other_key_policies);
  }
  merged.tas = merged.tas.filter((t, i, arr) =>
    arr.findIndex((x) => (x.email || x.name || "") === (t.email || t.name || "")) === i);
  merged.other_key_policies = [...new Set(merged.other_key_policies)];
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

  // The user's edits sit on top of whatever was extracted: same label replaces
  // the value (empty hides the row), new labels become extra rows.
  const baseMap = {};
  rows.forEach((r) => { baseMap[r.k] = r.v; });
  const ov = c.facts_override || {};
  rows.forEach((r) => { if (ov[r.k] !== undefined) r.v = ov[r.k]; });
  Object.keys(ov).forEach((k) => { if (baseMap[k] === undefined) rows.push({ k, v: ov[k] }); });
  const shownRows = rows.filter((r) => r.v);

  const events = state.db.events.filter((e) => e.course_id === courseId)
    .sort((a, b) => a.date.localeCompare(b.date));

  $("#view").innerHTML = `
    <div class="view-head">
      <div><a onclick="navigate('dashboard')">← Courses</a>
        <h1 style="color:${esc(c.color)}">${esc(c.code)}</h1>
        <div class="sub">${esc(c.title || "")}${c.term ? " · " + esc(c.term) : ""}${c.instructor ? " · " + esc(c.instructor) : ""}</div>
        ${c.description ? `<div class="sub" style="max-width:560px">${esc(c.description)}</div>` : ""}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="ask-this">💬 Ask</button>
        <button class="btn" id="grades-this">🎯 Grades</button>
        ${REMOTE ? `<button class="btn" id="share-course" title="Give classmates a one-click copy of this course">📤 Share</button>` : ""}
        <button class="btn" id="edit-course">✏️ Edit</button>
        <button class="btn danger" id="del-course">Delete</button></div>
    </div>

    <div class="course-top">
      <div class="card info-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>Course info</h3>
          <button class="btn small" id="edit-facts" title="Edit course info">✏️</button>
        </div>
        ${shownRows.length ? `<div class="facts-grid">${shownRows.map((r) =>
          `<div class="fact"><div class="k">${esc(r.k)}</div><div class="v">${esc(r.v)}</div></div>`).join("")}</div>`
        : `<p class="muted">Upload a syllabus and I'll pull out the instructor, grading breakdown, late policy, and more. Or hit ✏️ to fill it in yourself.</p>`}
      </div>
      <div class="card skips-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <h3 style="font-size:14px">Skips</h3>
          <span>
            <button class="btn small" id="auto-allow" title="Scan every syllabus and note in this course and add trackers automatically">✨ Auto add</button>
            <button class="btn small" id="add-allow" title="Add a tracker manually">＋</button>
          </span>
        </div>
        ${(c.allowances || []).length ? c.allowances.map((a, i) => `
          <div class="allow-row">
            <span class="allow-ic">${esc(a.emoji || "🎟")}</span>
            <span class="allow-name" title="${esc(a.label)}">${esc(a.label)}</span>
            <button class="btn small" data-allow-use="${i}" title="Use one">−</button>
            <span class="allow-count" style="background:${allowColor(a.remaining, a.total)}">${a.remaining}/${a.total}</span>
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
          <span>${d.kind === "pdf" ? "📕" : d.kind === "docx" ? "📘" : d.kind === "html" ? "🌐" : "📄"}</span>
          <div><div class="name">${esc(d.filename)}</div>
          <div class="meta">${esc(d.kind)} · added ${esc((d.uploaded_at || "").slice(0, 10))} · click to open</div></div>
          <div class="spacer"></div>
          <button class="btn small danger" data-del-doc="${d.id}">Remove</button>
        </div>`).join("") || `<p class="muted" style="margin:4px">No documents yet.</p>`}
      <div class="dropzone" id="dropzone">
        <b>Drop syllabus, course outline, or any course files here</b> or <a id="browse">browse</a> — PDF, Word, HTML, or text. Folders and multiple files work.<br>
        <span style="font-size:12.5px">Deadlines are auto-added to your calendar; key policies fill the course info.</span>
        <input type="file" id="file-input" accept=".pdf,.docx,.txt,.md,.html,.htm,.mhtml,.mht" multiple style="display:none">
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
  $("#grades-this").addEventListener("click", () => { state.gradeCourse = String(courseId); navigate("grades"); });
  const shareBtn = $("#share-course");
  if (shareBtn) shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    try {
      const id = await repo.shareCourse(c);
      const link = `${location.origin}${location.pathname}#share=${id}`;
      openModal(`
        <h3>📤 Share ${esc(c.code)}</h3>
        <p class="muted">Anyone with a SyllabAI account gets this course with one click: syllabus text, course info, deadlines, and skip trackers. They can also find it by searching "${esc(c.code)}" when adding a course.</p>
        <div class="field"><label>Share link</label><input id="sh-link" readonly value="${esc(link)}"></div>
        <div class="modal-actions"><button class="btn" id="sh-close">Close</button>
        <button class="btn primary" id="sh-copy">Copy link</button></div>`);
      $("#sh-close").addEventListener("click", closeModal);
      $("#sh-copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link); toast("Link copied. Send it to your classmates."); }
        catch (_e) { $("#sh-link").select(); toast("Copy it from the box.", "err"); }
      });
    } catch (err) { toast(err.message, "err"); }
    shareBtn.disabled = false;
  });
  $("#del-course").addEventListener("click", async () => {
    if (!confirm(`Delete ${c.code} and all its documents, notes, and events?`)) return;
    await repo.delCourse(courseId);
    toast("Course deleted."); navigate("dashboard");
  });

  $("#edit-course").addEventListener("click", () => openEditCourse(c));
  $("#edit-facts").addEventListener("click", () => openEditFacts(c, rows, baseMap));
  const saveAllow = async () => { await repo.saveAllowances(c); renderCourse(courseId); };
  $("#add-allow").addEventListener("click", () => openAddAllowance(c, saveAllow));
  $("#auto-allow").addEventListener("click", async () => {
    const btn = $("#auto-allow");
    btn.disabled = true;
    try {
      const { added, aiOk, hadText } = await autoDetectSkips(c);
      if (!hadText) toast("Nothing to scan yet. Upload a syllabus or add a note first.", "err");
      else if (aiOk) toast(added ? `AI read everything and set up ${added} tracker${added === 1 ? "" : "s"}.`
        : "AI read everything: no countable skips, drops, or allowances stated.");
      else if (REMOTE) toast(added ? `Basic scan found ${added} tracker${added === 1 ? "" : "s"}. The full AI scan needs the updated edge function deployed (SETUP.md).`
        : "Basic scan found nothing. The full AI scan (handles typos and any wording) needs the updated edge function deployed, or you're out of AI calls today.", added ? "" : "err");
      else toast(added ? `Found ${added} tracker${added === 1 ? "" : "s"}.`
        : "No countable skips or drops matched. Demo mode uses patterns only; the live site's AI scan reads anything.");
    } catch (err) { toast(err.message, "err"); }
    renderCourse(courseId);
  });
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
  fi.addEventListener("change", () => uploadFiles(courseId, [...fi.files]));
  ["dragover", "dragenter"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { collectFiles(e.dataTransfer).then((files) => uploadFiles(courseId, files)); });
}

async function autoDetectSkips(course) {
  // Gather everything this course knows: every document's full text plus every note.
  const texts = [];
  for (const doc of docsOf(course.id)) {
    try {
      const src = await repo.getSource(doc.id);
      if (src) texts.push(src.text);
    } catch (_e) { /* skip unreadable doc */ }
  }
  for (const note of notesOf(course.id)) texts.push(note.text);
  const combined = texts.join("\n\n");
  let found = extractAllowancesHeuristic(combined);
  // Signed in with AI: a dedicated cheap-model pass reads the same pile with an
  // open-ended brief (any countable allowance, any wording, typos included).
  // When it works, its answer REPLACES the pattern scan entirely, so vague
  // pattern labels never sit next to the AI's specific ones.
  let aiOk = false;
  if (REMOTE && state.user && texts.length) {
    try {
      const res = await repo.invokeClaude({ kind: "skips",
        text: combined.slice(0, 80000), code: course.code });
      if (res && res.result && Array.isArray(res.result.allowances)) {
        found = res.result.allowances;
        aiOk = true;
      }
    } catch (_e) { /* out of AI calls or older function: heuristic already ran */ }
  }
  const added = mergeAllowances(course, found);
  if (added) await repo.saveAllowances(course);
  return { added, aiOk, hadText: texts.length > 0 };
}

function openEditCourse(course) {
  openModal(`
    <h3>Edit course</h3>
    <div class="field"><label>Course code *</label><input id="ec-code" value="${esc(course.code)}"></div>
    <div class="field"><label>Title</label><input id="ec-title" value="${esc(course.title || "")}"></div>
    <div class="field"><label>Description</label><textarea id="ec-desc" rows="2" placeholder="Anything worth remembering about this class">${esc(course.description || "")}</textarea></div>
    <div class="row">
      <div class="field"><label>Term</label><input id="ec-term" value="${esc(course.term || "")}"></div>
      <div class="field"><label>Instructor</label><input id="ec-inst" value="${esc(course.instructor || "")}"></div>
    </div>
    <div class="field"><label>Color</label>${colorSelectHtml("ec-color", course.color)}</div>
    <div class="modal-actions"><button class="btn" id="ec-cancel">Cancel</button>
    <button class="btn primary" id="ec-save">Save</button></div>`);
  const getColor = bindColorSelect("ec-color");
  $("#ec-cancel").addEventListener("click", closeModal);
  $("#ec-save").addEventListener("click", async () => {
    const code = $("#ec-code").value.trim().slice(0, 40);
    if (!code) return toast("Course code is required.", "err");
    try {
      await repo.updateCourse(course, {
        code, title: $("#ec-title").value.trim().slice(0, 120),
        description: $("#ec-desc").value.trim().slice(0, 300),
        term: $("#ec-term").value.trim().slice(0, 40),
        instructor: $("#ec-inst").value.trim().slice(0, 80), color: getColor(),
      });
      closeModal(); toast("Course updated.");
      renderCourse(course.id);
    } catch (err) { toast(err.message, "err"); }
  });
}

function openEditFacts(course, rows, baseMap) {
  openModal(`
    <h3>Edit course info</h3>
    <p class="muted" style="margin-top:0">Your edits stick: re-uploading a syllabus never overwrites them. Clear a field to hide that row.</p>
    ${rows.map((r, i) => `
      <div class="field"><label>${esc(r.k)}</label><textarea data-ef="${i}" rows="2">${esc(r.v)}</textarea></div>`).join("")}
    <div class="row">
      <div class="field"><label>New row name</label><input id="ef-newk" placeholder="Prerequisites"></div>
      <div class="field"><label>Value</label><input id="ef-newv" placeholder="MATH 1910 or instructor consent"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ef-reset" title="Throw away your edits and show only what was extracted">Reset to extracted</button>
      <button class="btn" id="ef-cancel">Cancel</button>
      <button class="btn primary" id="ef-save">Save</button>
    </div>`);
  $("#ef-cancel").addEventListener("click", closeModal);
  $("#ef-reset").addEventListener("click", async () => {
    try { await repo.updateCourse(course, { facts_override: {} }); closeModal(); renderCourse(course.id); }
    catch (err) { toast(err.message, "err"); }
  });
  $("#ef-save").addEventListener("click", async () => {
    const ov = {};
    rows.forEach((r, i) => {
      const v = $(`[data-ef="${i}"]`).value.trim().slice(0, 1200);
      const base = (baseMap[r.k] !== undefined ? String(baseMap[r.k]) : "").trim();
      if (v !== base) ov[r.k] = v;
    });
    const nk = $("#ef-newk").value.trim().slice(0, 60);
    const nv = $("#ef-newv").value.trim().slice(0, 1200);
    if (nk && nv) ov[nk] = nv;
    try {
      await repo.updateCourse(course, { facts_override: ov });
      closeModal(); toast("Course info updated."); renderCourse(course.id);
    } catch (err) { toast(err.message, "err"); }
  });
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

// Multiple files at once are fine; with several, only the outline/syllabus
// (by name, else the first) spends an AI call, the rest use free heuristics.
async function uploadFiles(courseId, files) {
  files = (files || []).slice(0, 12);
  if (!files.length) return;
  const dz = $("#dropzone");
  const primaryName = (files.find((f) => /outline|syllabus/i.test(f.name)) || files[0]).name;
  let ok = 0, ev = 0, al = 0;
  for (const f of files) {
    if (dz) dz.innerHTML = `<b>Reading ${esc(f.name)}…</b> extracting policies & deadlines`;
    try {
      const { text, kind } = await extractFile(f);
      const quiet = files.length > 1 && f.name !== primaryName;
      const r = await ingestDocument(courseById(courseId), f.name, text, kind, quiet, f);
      ok++; ev += r.eventsAdded; al += r.allowancesAdded;
    } catch (err) { toast(`${f.name}: ${err.message}`, "err"); }
  }
  if (ok) toast(`Added ${ok} document${ok === 1 ? "" : "s"}: ${ev} deadline${ev === 1 ? "" : "s"}`
    + (al ? `, ${al} skip tracker${al === 1 ? "" : "s"}` : "") + ".");
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

/* ---------- grades ---------- */

const LETTER_CUTS = [[93, "A"], [90, "A-"], [87, "B+"], [83, "B"], [80, "B-"],
  [77, "C+"], [73, "C"], [70, "C-"], [67, "D+"], [63, "D"], [60, "D-"], [0, "F"]];
function letterFor(pct) {
  for (const [cut, letter] of LETTER_CUTS) if (pct >= cut) return letter;
  return "F";
}
function parseWeight(w) {
  const m = String(w == null ? "" : w).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Rows live in course.grades = { rows: [{name, weight, score}] }. Seeded from
// the syllabus grading breakdown the first time the tab is opened.
function gradeRows(course) {
  if (!course.grades || !Array.isArray(course.grades.rows)) course.grades = { rows: [] };
  if (!course.grades.rows.length) {
    const facts = mergeFacts(docsOf(course.id));
    course.grades.rows = facts.grading
      .map((g) => ({ name: g.component, weight: parseWeight(g.weight), score: null }))
      .filter((r) => r.name);
  }
  return course.grades.rows;
}

function syncGradeRows(course) {
  const rows = gradeRows(course);
  const have = new Set(rows.map((r) => r.name.toLowerCase().trim()));
  let added = 0;
  for (const g of mergeFacts(docsOf(course.id)).grading) {
    if (!g.component || have.has(g.component.toLowerCase().trim())) continue;
    rows.push({ name: g.component, weight: parseWeight(g.weight), score: null });
    added++;
  }
  return added;
}

function gradeMath(rows) {
  const withW = rows.filter((r) => typeof r.weight === "number" && r.weight > 0);
  const totalW = withW.reduce((s, r) => s + r.weight, 0);
  const scored = withW.filter((r) => typeof r.score === "number");
  const scoredW = scored.reduce((s, r) => s + r.weight, 0);
  const earned = scored.reduce((s, r) => s + r.weight * r.score / 100, 0);
  return {
    totalW, scoredW, remainingW: totalW - scoredW,
    current: scoredW > 0 ? (earned / scoredW) * 100 : null,
    // needed average (0-100) on everything not yet scored to end at `target` overall
    neededFor(target) {
      if (totalW <= 0) return null;
      const remaining = totalW - scoredW;
      if (remaining <= 0) return null;
      return ((target / 100) * totalW - earned) / remaining * 100;
    },
    final: totalW > 0 ? (earned + 0) / totalW * 100 : null, // if all remaining scored 0
  };
}

function renderGrades() {
  if (!state.db.courses.length) {
    $("#view").innerHTML = `<div class="view-head"><div><h1>Grade calculator</h1></div></div>
      <div class="empty"><div class="big-ic">🎯</div>Add a course first, then plan your grade here.</div>`;
    return;
  }
  if (!state.gradeCourse || !courseById(state.gradeCourse)) state.gradeCourse = String(state.db.courses[0].id);
  const c = courseById(state.gradeCourse);
  const rows = gradeRows(c);

  $("#view").innerHTML = `
    <div class="view-head">
      <div><h1>Grade calculator</h1>
        <div class="sub">Weights come from the syllabus. Type what you've scored, see where you stand, and what the rest needs to be.</div></div>
    </div>
    <div class="scope-chips" style="margin-bottom:14px">
      ${state.db.courses.map((cc) => `<span class="scope-chip ${String(cc.id) === state.gradeCourse ? "sel" : ""}"
        data-gcourse="${cc.id}" style="${String(cc.id) === state.gradeCourse ? `background:${esc(cc.color)};border-color:${esc(cc.color)};color:#fff` : ""}">${esc(cc.code)}</span>`).join("")}
    </div>
    <div class="grades-layout">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">${esc(c.code)} components</h3>
          <span>
            <button class="btn small" id="gr-sync" title="Pull any components named in the syllabus grading breakdown">⟳ Sync from syllabus</button>
            <button class="btn small" id="gr-add">＋ Add</button>
          </span>
        </div>
        ${rows.length ? `
        <div class="grade-table">
          <div class="gt-head"><span>Component</span><span>Weight %</span><span>Your score %</span><span></span></div>
          ${rows.map((r, i) => `
            <div class="gt-row">
              <input data-gr-name="${i}" value="${esc(r.name)}">
              <input data-gr-w="${i}" type="number" min="0" max="100" step="0.5" value="${r.weight == null ? "" : r.weight}">
              <input data-gr-s="${i}" type="number" min="0" max="120" step="0.1" placeholder="—" value="${r.score == null ? "" : r.score}">
              <button class="btn small danger" data-gr-del="${i}">✕</button>
            </div>`).join("")}
        </div>
        <p class="muted" style="font-size:12px">Leave the score blank for anything not graded yet. Category averages work fine (your homework average so far).</p>`
        : `<p class="muted">No grading breakdown found. Upload the syllabus, hit Sync, or add components by hand.</p>`}
      </div>
      <div class="card grade-readout" id="grade-readout"></div>
    </div>`;

  const persist = () => repo.updateCourse(c, { grades: c.grades }).catch((e) => toast(e.message, "err"));

  const readRow = (i) => {
    const w = $(`[data-gr-w="${i}"]`).value, s = $(`[data-gr-s="${i}"]`).value;
    rows[i].name = $(`[data-gr-name="${i}"]`).value.slice(0, 60);
    rows[i].weight = w === "" ? null : Math.max(0, parseFloat(w) || 0);
    rows[i].score = s === "" ? null : Math.max(0, parseFloat(s) || 0);
  };

  const readout = () => {
    const m = gradeMath(rows);
    const target = c.grades.target == null ? 90 : c.grades.target;
    const remaining = rows.filter((r) => typeof r.weight === "number" && r.weight > 0 && typeof r.score !== "number");
    const needed = m.neededFor(target);
    let plan = "";
    if (m.totalW <= 0) plan = `<p class="muted">Give your components weights first.</p>`;
    else if (!remaining.length) plan = `<p>Everything is graded. ${m.current == null ? "" : `Final: <b>${m.current.toFixed(1)}%</b> (${letterFor(m.current)}).`}</p>`;
    else {
      const list = remaining.map((r) => `${esc(r.name)} (${r.weight}%)`).join(", ");
      const tone = needed > 100 ? "bad" : needed <= 0 ? "locked" : needed > 90 ? "warn" : "ok";
      plan = `
        <div class="plan-line ${tone}">
          ${needed <= 0 ? `🎉 Locked in: even 0% on the rest keeps you at ${letterFor(target)} target.`
          : needed > 100 ? `Not possible on scores alone: the rest averages out above 100% (${needed.toFixed(1)}%). Time for extra credit or a lower target.`
          : `You need to average <b>${needed.toFixed(1)}%</b> across the remaining ${m.remainingW.toFixed(0)}% of the course.`}
        </div>
        <p class="muted" style="font-size:12.5px">Remaining: ${list}</p>`;
    }
    $("#grade-readout").innerHTML = `
      <h3>Where you stand</h3>
      ${m.current == null ? `<p class="muted">Enter at least one score.</p>` : `
        <div class="big-grade" style="color:${needed != null && needed > 100 ? "var(--red)" : "inherit"}">${m.current.toFixed(1)}%
          <span class="letter">${letterFor(m.current)}</span></div>
        <p class="muted" style="font-size:12.5px">Average so far, covering ${m.scoredW.toFixed(0)}% of the course${m.totalW < 99.5 ? ` (weights add to ${m.totalW.toFixed(0)}%)` : ""}.</p>`}
      <div class="target-row">
        <span class="muted" style="font-size:12.5px">Target:</span>
        ${[["A", 93], ["A-", 90], ["B+", 87], ["B", 83]].map(([l, v]) =>
          `<button class="btn small tgt ${target === v ? "primary" : ""}" data-tgt="${v}">${l}</button>`).join("")}
        <input id="tgt-custom" type="number" min="0" max="110" value="${target}" title="Custom target %"> %
      </div>
      ${plan}`;
    $$("[data-tgt]").forEach((b) => b.addEventListener("click", () => {
      c.grades.target = Number(b.dataset.tgt);
      $("#tgt-custom").value = c.grades.target;
      readout(); persist();
    }));
    $("#tgt-custom").addEventListener("change", () => {
      c.grades.target = Math.max(0, Math.min(110, parseFloat($("#tgt-custom").value) || 90));
      readout(); persist();
    });
  };
  readout();

  rows.forEach((_r, i) => {
    ["gr-name", "gr-w", "gr-s"].forEach((kind) => {
      const el = $(`[data-${kind}="${i}"]`);
      el.addEventListener("input", () => { readRow(i); readout(); });
      el.addEventListener("change", () => { readRow(i); persist(); });
    });
    $(`[data-gr-del="${i}"]`).addEventListener("click", () => {
      rows.splice(i, 1); persist(); renderGrades();
    });
  });
  $("#gr-add").addEventListener("click", () => {
    rows.push({ name: "New component", weight: null, score: null });
    persist(); renderGrades();
  });
  $("#gr-sync").addEventListener("click", () => {
    const added = syncGradeRows(c);
    toast(added ? `Pulled ${added} component${added === 1 ? "" : "s"} from the syllabus.` : "Nothing new in the syllabus breakdown.");
    if (added) { persist(); renderGrades(); }
  });
  $$("[data-gcourse]").forEach((chip) => chip.addEventListener("click", () => {
    state.gradeCourse = chip.dataset.gcourse;
    renderGrades();
  }));
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
      <div><h1>Calendar</h1><div class="sub">Every deadline pulled from your syllabi, notes, and feeds.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${REMOTE ? `<button class="btn" id="subscribe-feed">📡 Canvas feed</button>` : ""}
        ${REMOTE && state.db.feeds.length ? `<button class="btn" id="refresh-feeds">⟳ Refresh</button>` : ""}
        <button class="btn primary" id="add-event">+ Event</button></div>
    </div>
    ${REMOTE && !state.db.feeds.length ? `<p class="muted" style="margin:-8px 0 14px">💡 Hook up your Canvas calendar feed once and every assignment date lands here automatically. Hit 📡 Canvas feed.</p>` : ""}
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
  const sub = $("#subscribe-feed");
  if (sub) sub.addEventListener("click", openSubscribeFeed);
  const rf = $("#refresh-feeds");
  if (rf) rf.addEventListener("click", async () => {
    rf.disabled = true;
    await refreshFeeds(false);
    renderCalendar();
  });
}

/* ---- Canvas/Moodle calendar feeds ---- */

function courseForTitle(title) {
  const t = String(title).toLowerCase().replace(/\s+/g, "");
  for (const c of state.db.courses) {
    const compact = c.code.toLowerCase().replace(/\s+/g, "");
    const subj = (c.code.toLowerCase().match(/^[a-z]+/) || [""])[0];
    const num = (c.code.match(/\d{3,}/) || [""])[0];
    if (compact.length > 2 && t.includes(compact)) return c.id;
    if (subj.length >= 2 && num && t.includes(subj) && t.includes(num)) return c.id;
  }
  return null;
}

async function refreshFeeds(silent) {
  if (!REMOTE || !state.db.feeds.length) return 0;
  let total = 0, failed = 0;
  for (const feed of state.db.feeds) {
    try {
      const res = await repo.invokeClaude({ kind: "ics", url: feed.url });
      if (!res || res.error || !res.text) { failed++; continue; }
      const events = parseIcs(res.text);
      const groups = new Map();
      for (const ev of events) {
        const cid = courseForTitle(ev.title);
        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid).push(ev);
      }
      for (const [cid, evs] of groups) total += await repo.addEventsBulk(cid, null, evs, "canvas");
    } catch (_e) { failed++; }
  }
  if (!silent) {
    if (failed && !total) toast("Couldn't refresh the feed. Check the URL, and make sure the latest edge function is deployed.", "err");
    else toast(total ? `Pulled ${total} new deadline${total === 1 ? "" : "s"} from your feed${state.db.feeds.length === 1 ? "" : "s"}.` : "Feeds are up to date.");
  }
  return total;
}

function openSubscribeFeed() {
  openModal(`
    <h3>📡 Subscribe to your Canvas calendar</h3>
    <p class="muted">In Canvas: Calendar → <b>Calendar Feed</b> (bottom of the right sidebar) → copy the link. Paste it once and every assignment date flows in here; Refresh pulls anything new. Moodle and Blackboard feeds work too.</p>
    <div class="field"><label>Feed URL</label><input id="fd-url" placeholder="https://canvas…/feeds/calendars/user_….ics"></div>
    ${state.db.feeds.length ? `<div class="field"><label>Your feeds</label>${state.db.feeds.map((f) => `
      <div class="doc-row" style="cursor:default"><span>📡</span>
        <div class="name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:330px">${esc(f.url)}</div>
        <div class="spacer"></div><button class="btn small danger" data-del-feed="${f.id}">✕</button></div>`).join("")}</div>` : ""}
    <div class="modal-actions"><button class="btn" id="fd-cancel">Close</button>
    <button class="btn primary" id="fd-save">Subscribe & pull now</button></div>`);
  $("#fd-cancel").addEventListener("click", closeModal);
  $$("[data-del-feed]").forEach((b) => b.addEventListener("click", async () => {
    try { await repo.delFeed(b.dataset.delFeed); } catch (err) { return toast(err.message, "err"); }
    openSubscribeFeed();
  }));
  $("#fd-save").addEventListener("click", async () => {
    const url = $("#fd-url").value.trim().replace(/^webcal:\/\//i, "https://");
    if (!/^https:\/\/.+/.test(url)) return toast("Paste the https feed link from Canvas.", "err");
    const btn = $("#fd-save");
    btn.disabled = true;
    try {
      await repo.addFeed(url.slice(0, 500));
      closeModal();
      await refreshFeeds(false);
      renderCalendar();
    } catch (err) { toast(err.message, "err"); btn.disabled = false; }
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
      // Jump to the month the event lands in, otherwise adding a deadline in a
      // future month looks like nothing happened.
      const [ey, em] = date.split("-").map(Number);
      state.calMonth = new Date(ey, em - 1, 1);
      state.selectedDay = date;
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
          <label class="kv" style="cursor:pointer"><span class="k">Weekly digest email</span>
            <input type="checkbox" id="digest-toggle" checked></label>
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
      <div class="card">
        <h3>🗓 Calendar data</h3>
        <p class="muted">Canvas feed subscriptions live on the Calendar tab. These are for one-off files.</p>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn" id="import-ics">⇪ Import .ics file</button>
          <button class="btn" id="export-ics">⬇ Export everything (.ics)</button>
        </div>
      </div>
    </div>`;

  $("#theme-light").addEventListener("click", () => { applyTheme("light"); renderSettings(); });
  $("#theme-dark").addEventListener("click", () => { applyTheme("dark"); renderSettings(); });
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
  const dig = $("#digest-toggle");
  if (dig) {
    repo.getDigestPref().then((v) => { dig.checked = v; }).catch(() => {});
    dig.addEventListener("change", async () => {
      try { await repo.setDigestPref(dig.checked); toast(dig.checked ? "Weekly digest on." : "Weekly digest off."); }
      catch (err) { toast(err.message, "err"); dig.checked = !dig.checked; }
    });
  }
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
  handleShareHash();
  refreshFeeds(true).then((n) => {
    if (n) toast(`${n} new deadline${n === 1 ? "" : "s"} pulled from your Canvas feed.`);
  }).catch(() => {});
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
