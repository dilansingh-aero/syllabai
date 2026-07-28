# 🎓 MySyllabi

**Your syllabi, answered.** Upload every course syllabus once, get a unified deadline
calendar, and ask questions in plain English — answered *only* from your own materials,
with verbatim quotes to prove it, and a verdict on whether that email to your professor
is even necessary (and whether it should go to the professor or a TA).

**Live site:** this repo is published with GitHub Pages — open it from the repo's
About section, or at `https://<username>.github.io/mysyllabi/`.

## How it works

This is the **browser edition**: there is no server. Everything you add — courses,
syllabi, deadlines, Q&A history — is stored in *your own browser* (localStorage) and
never leaves your device. Every visitor gets their own private copy.

- Works instantly in **keyword mode**: finds and shows the syllabus passages that
  answer your question.
- Add your own Anthropic API key in **Settings** for full AI answers via
  `claude-opus-5` — strictly grounded in your uploads, every claim carrying a quote
  that the app re-verifies against your documents. The key is kept in your browser
  and sent only to Anthropic.

Reads PDF (pdf.js), Word (mammoth.js), and plain-text syllabi. Imports LMS `.ics`
calendar files, exports your deadline calendar as `.ics` for Google/Apple/Outlook,
and can back up / restore all your data as a JSON file.

*A full-stack edition (real accounts, server-side storage) lives in a separate repo.*
