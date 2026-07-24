// ================================================================
// MOISDES PLATFORM — SHARED CONFIG
// shared-config.js — used by every page.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.CFG = {
  apiBase: 'https://moisdes-worker.moisdesvienweb.workers.dev',

  logo: '/logo.avif',

  pages: {
    home: '/',
    blog: '/blog',
    posters: '/posters',
    events: '/events',
    video: '/video',
    pdfs: '/pdfs',
  },

  // Nav links in right-to-left visual reading order (first = rightmost,
  // since the page is RTL and this array is rendered in DOM order).
  nav: [
    { href: '/pdfs', label: 'גליונות' },
    { href: '/video', label: 'ווידיאוס' },
    { href: '/events', label: 'מעמדים' },
    { href: '/posters', label: 'מודעות' },
    { href: '/blog', label: 'בלאג' },
  ],

  // Bereishit Shabbat of Hebrew year 5786, independently derived from the
  // verified anchor (1 Tishrei 5786 = Sep 22 2025) via hebrew-dates.js —
  // see scratch verification in project history. Used as week-0 for the
  // parsha rotation below.
  parshaAnchorDate: '2025-10-18',
  parshaAnchorIndex: 0,

  parshiyot: [
    'בראשית', 'נח', 'לך לך', 'וירא', 'חיי שרה', 'תולדות', 'ויצא', 'וישלח', 'וישב', 'מקץ', 'ויגש', 'ויחי',
    'שמות', 'וארא', 'בא', 'בשלח', 'יתרו', 'משפטים', 'תרומה', 'תצוה', 'כי תשא', 'ויקהל', 'פקודי',
    'ויקרא', 'צו', 'שמיני', 'תזריע', 'מצורע', 'אחרי', 'קדושים', 'אמור', 'בהר', 'בחוקותי',
    'במדבר', 'נשא', 'בהעלותך', 'שלח', 'קרח', 'חוקת', 'בלק', 'פינחס', 'מטות', 'מסעי',
    'דברים', 'ואתחנן', 'עקב', 'ראה', 'שופטים', 'כי תצא', 'כי תבוא', 'נצבים', 'וילך', 'האזינו', 'וזאת הברכה',
  ],
  // Portions read together in most years — applied as a default; the
  // admin parsha picker lets an editor override per-item when a given
  // year splits or joins these differently.
  combined: {
    'ויקהל': 'ויקהל-פקודי', 'תזריע': 'תזריע-מצורע', 'אחרי': 'אחרי-קדושים',
    'בהר': 'בהר-בחוקותי', 'מטות': 'מטות-מסעי', 'נצבים': 'נצבים-וילך',
  },
};

// ── SHARED UTILITIES ────────────────────────────────────────────────

window.MOISDES.util = {
  eh(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; },

  // ISO date (YYYY-MM-DD) -> week-of Shabbat's parsha name
  dateToParsha(iso) {
    const CFG = window.MOISDES.CFG;
    const anchor = new Date(CFG.parshaAnchorDate + 'T12:00:00Z');
    const date = new Date(iso + 'T12:00:00Z');
    const msWeek = 7 * 86400000;
    const dow = date.getUTCDay();
    const daysToShabbat = (6 - dow + 7) % 7;
    const shabbat = new Date(date.getTime() + daysToShabbat * 86400000);
    const wkDiff = Math.round((shabbat - anchor) / msWeek);
    const idx = ((CFG.parshaAnchorIndex + wkDiff) % CFG.parshiyot.length + CFG.parshiyot.length) % CFG.parshiyot.length;
    const p = CFG.parshiyot[idx];
    return CFG.combined[p] || p;
  },

  // ISO date -> Date object for sorting
  parseIso(iso) { return iso ? new Date(iso + 'T12:00:00Z') : null; },

  dateDesc(a, b) {
    const da = this.parseIso(a), db = this.parseIso(b);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db - da;
  },

  weeksAgo(iso, weeks) {
    const d = this.parseIso(iso);
    if (!d) return false;
    return (Date.now() - d.getTime()) < weeks * 7 * 86400000;
  },
};
