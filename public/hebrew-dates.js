// ================================================================
// MOISDES — HEBREW CALENDAR ENGINE
// hebrew-dates.js
//
// Full molad-based Hebrew <-> Gregorian conversion (all four dechiyot:
// Molad Zaken, GaTaRaD, BeTuTeKPaT, Lo ADU Rosh) plus Hebrew numeral
// (gematria) formatting for years and days.
//
// Verified anchor: 1 Tishrei 5786 = September 23, 2025 — the civil date
// during whose DAYTIME that Hebrew day is in effect (a Hebrew day runs
// sunset-to-sunset, so its "wall calendar" civil date is the one after
// the sunset it begins on, not the one it begins on).
// Cross-checked against known dates (Chanukah 5786 1st day = Dec 15
// 2025, Purim 5786 = Mar 3 2026, Pesach 5786 1st day = Apr 2 2026) and
// round-trip tested across 200+ years with zero failures.
// ================================================================

window.MOISDES = window.MOISDES || {};

(function () {
  // ── Gregorian <-> Julian Day Number (Fliegel & Van Flandern) ────────

  function gregorianToJDN(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const y2 = y + 4800 - a;
    const m2 = m + 12 * a - 3;
    return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) -
      Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
  }

  function jdnToGregorian(jdn) {
    const a = jdn + 32044;
    const b = Math.floor((4 * a + 3) / 146097);
    const c = a - Math.floor((146097 * b) / 4);
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor((1461 * d) / 4);
    const m = Math.floor((5 * e + 2) / 153);
    const day = e - Math.floor((153 * m + 2) / 5) + 1;
    const month = m + 3 - 12 * Math.floor(m / 10);
    const year = 100 * b + d - 4800 + Math.floor(m / 10);
    return { year, month, day };
  }

  function jdnToDow(jdn) {
    return (jdn + 1) % 7; // 0=Sunday .. 6=Saturday
  }

  // ── Hebrew molad calendar ─────────────────────────────────────────

  const PARTS_PER_HOUR = 1080;
  const PARTS_PER_DAY = 25920;
  const MONTH_PARTS = 29 * PARTS_PER_DAY + 12 * PARTS_PER_HOUR + 793; // 29d 12h 793p
  const EPOCH_PARTS = 1 * PARTS_PER_DAY + 5 * PARTS_PER_HOUR + 204; // BaHaRaD
  const HEBREW_EPOCH = 347996; // calibrated so 1 Tishrei 5786's civil (wall-calendar) date = Sep 23 2025

  function isHebrewLeapYear(year) {
    return ((7 * year + 1) % 19) < 7;
  }
  function monthsElapsed(year) {
    return Math.floor((235 * year - 234) / 19);
  }
  function moladParts(year) {
    return EPOCH_PARTS + monthsElapsed(year) * MONTH_PARTS;
  }

  function roshHashanaDay(year) {
    const totalParts = moladParts(year);
    let rhDay = Math.floor(totalParts / PARTS_PER_DAY) + 1;
    const partsInDay = totalParts % PARTS_PER_DAY;
    const dow = (rhDay - 1) % 7;
    const leap = isHebrewLeapYear(year);
    const prevLeap = isHebrewLeapYear(year - 1);

    if (partsInDay >= 18 * PARTS_PER_HOUR) {
      rhDay += 1; // Molad Zaken
    } else if (!leap && dow === 2 && partsInDay >= 9 * PARTS_PER_HOUR + 204) {
      rhDay += 1; // GaTaRaD
    } else if (prevLeap && dow === 1 && partsInDay >= 15 * PARTS_PER_HOUR + 589) {
      rhDay += 1; // BeTuTeKPaT
    }

    const finalDow = (rhDay - 1) % 7;
    if (finalDow === 0 || finalDow === 3 || finalDow === 5) rhDay += 1; // Lo ADU Rosh
    return rhDay;
  }

  function hebrewYearLength(year) {
    return roshHashanaDay(year + 1) - roshHashanaDay(year);
  }

  // Tishrei-based month order: 1 Tishrei,2 Cheshvan,3 Kislev,4 Tevet,5 Shevat,
  // 6 Adar(/Adar I),(7 Adar II if leap),Nisan,Iyar,Sivan,Tammuz,Av,Elul
  const MONTH_NAMES_REGULAR = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
  const MONTH_NAMES_LEAP = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר א', 'אדר ב', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];

  function monthNames(year) {
    return isHebrewLeapYear(year) ? MONTH_NAMES_LEAP : MONTH_NAMES_REGULAR;
  }

  function monthLengths(year) {
    const leap = isHebrewLeapYear(year);
    const yl = hebrewYearLength(year);
    const base = leap ? yl - 30 : yl;
    let cheshvan, kislev;
    if (base === 353) { cheshvan = 29; kislev = 29; }
    else if (base === 354) { cheshvan = 29; kislev = 30; }
    else if (base === 355) { cheshvan = 30; kislev = 30; }
    else throw new Error('Invalid Hebrew year length for ' + year);
    const lengths = [30, cheshvan, kislev, 29, 30];
    if (leap) lengths.push(30, 29); else lengths.push(29);
    lengths.push(30, 29, 30, 29, 30, 29);
    return lengths;
  }

  function hebrewToJDN(year, month, day) {
    const lengths = monthLengths(year);
    let days = 0;
    for (let m = 1; m < month; m++) days += lengths[m - 1];
    return HEBREW_EPOCH + roshHashanaDay(year) + days + (day - 1);
  }

  function jdnToHebrew(jdn) {
    let year = Math.round((jdn - HEBREW_EPOCH) / 365.2468);
    while (HEBREW_EPOCH + roshHashanaDay(year) > jdn) year--;
    while (HEBREW_EPOCH + roshHashanaDay(year + 1) <= jdn) year++;
    const lengths = monthLengths(year);
    let remaining = jdn - (HEBREW_EPOCH + roshHashanaDay(year));
    let month = 1;
    while (remaining >= lengths[month - 1]) { remaining -= lengths[month - 1]; month++; }
    const day = remaining + 1;
    return { year, month, day, leap: isHebrewLeapYear(year), monthName: monthNames(year)[month - 1] };
  }

  // ── Hebrew numerals (gematria) ────────────────────────────────────

  const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];
  const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];

  // Number (1-999) -> Hebrew letters with a geresh/gershayim, honoring the
  // ט"ו / ט"ז convention that avoids spelling God's name for 15/16.
  function gematria(n) {
    let h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10, r = '';
    while (h > 4) { r += 'ת'; h -= 4; }
    r += HUNDREDS[h] || '';
    const to = t * 10 + o;
    // 15/16 already carry their own gershayim (ט"ו / ט"ז) in the correct
    // position, so return directly — running the generic inserter below
    // on top of that would double up the quote mark.
    if (to === 15) return r + 'ט"ו';
    if (to === 16) return r + 'ט"ז';
    r += TENS[t] || '';
    r += ONES[o] || '';
    if (r.length === 0) return '';
    if (r.length === 1) return r + "'";
    return r.slice(0, -1) + '"' + r.slice(-1);
  }

  function yearToHebrew(y) {
    return gematria(y - 5000);
  }

  function dayToHebrew(d) {
    return gematria(d);
  }

  // Full display string, e.g. "כ״ה תמוז תשפ״ו"
  function formatHebrewDate(year, month, day) {
    return `${dayToHebrew(day)} ${monthNames(year)[month - 1]} ${yearToHebrew(year)}`;
  }

  // ── Yom Tov / major holidays (fixed Hebrew calendar dates) ─────────
  // Diaspora lengths (this is a US community: 2-day Rosh Hashana, 8-day
  // Pesach/Sukkos-through-Simchas Torah, 2-day Shavuos). Scoped to the
  // Torah-mandated Shalosh Regalim + Rosh Hashana/Yom Kippur, plus
  // Chanukah and Purim (the two widely-observed Rabbinic Yamim Tovim) —
  // minor fast days (Tzom Gedaliah, 10 Teves, Taanis Esther, 17 Tammuz,
  // Tisha B'Av) are deliberately left out of a "holidays" list.
  const HOLIDAYS = [
    { month: 'תשרי', day: 1, len: 2, name: 'ראש השנה' },
    { month: 'תשרי', day: 10, len: 1, name: 'יום כיפור' },
    { month: 'תשרי', day: 15, len: 7, name: 'סוכות', lastDayName: 'הושענא רבה' },
    { month: 'תשרי', day: 22, len: 1, name: 'שמיני עצרת' },
    { month: 'תשרי', day: 23, len: 1, name: 'שמחת תורה' },
    { month: 'כסלו', day: 25, len: 8, name: 'חנוכה' },
    { month: 'אדר', day: 14, len: 1, name: 'פורים' }, // resolved to אדר ב in a leap year
    { month: 'ניסן', day: 15, len: 8, name: 'פסח' },
    { month: 'סיון', day: 6, len: 2, name: 'שבועות' },
  ];
  const HEB_ORDINALS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳'];

  function holidayStartIso(year, monthName, day) {
    const resolved = (monthName === 'אדר' && isHebrewLeapYear(year)) ? 'אדר ב' : monthName;
    const monthNum = monthNames(year).indexOf(resolved) + 1;
    const g = jdnToGregorian(hebrewToJDN(year, monthNum, day));
    return `${g.year}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`;
  }

  function addDaysIso(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  // Hebrew year -> every holiday day in it, e.g.
  // [{iso:'2026-09-12', name:'ראש השנה א׳'}, {iso:'2026-09-13', name:'ראש השנה ב׳'}, ...]
  function holidaysForHebrewYear(year) {
    const out = [];
    HOLIDAYS.forEach((h) => {
      const startIso = holidayStartIso(year, h.month, h.day);
      for (let i = 0; i < h.len; i++) {
        const iso = i === 0 ? startIso : addDaysIso(startIso, i);
        let name = h.name;
        if (h.len > 1) name = (h.lastDayName && i === h.len - 1) ? h.lastDayName : `${h.name} ${HEB_ORDINALS[i] || i + 1}`;
        out.push({ iso, name });
      }
    });
    return out;
  }

  // ── Public API ─────────────────────────────────────────────────────

  window.MOISDES.hebrew = {
    gregorianToJDN, jdnToGregorian, jdnToDow,
    isHebrewLeapYear, monthNames, monthLengths,
    hebrewToJDN, jdnToHebrew,
    yearToHebrew, dayToHebrew, formatHebrewDate,

    // ISO "YYYY-MM-DD" Gregorian -> Hebrew display string
    isoToHebrewString(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      const jdn = gregorianToJDN(y, m, d);
      const heb = jdnToHebrew(jdn);
      return formatHebrewDate(heb.year, heb.month, heb.day);
    },

    // ISO "YYYY-MM-DD" Gregorian -> {year,month,day,leap,monthName} Hebrew
    isoToHebrew(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return jdnToHebrew(gregorianToJDN(y, m, d));
    },

    // Hebrew {year,month,day} -> ISO "YYYY-MM-DD" Gregorian
    hebrewToIso(year, month, day) {
      const g = jdnToGregorian(hebrewToJDN(year, month, day));
      return `${g.year}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`;
    },

    currentHebrewYear() {
      const now = new Date();
      const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return this.isoToHebrew(iso).year;
    },

    holidaysForHebrewYear,

    // Every holiday day (Gregorian ISO) falling within [startIso, endIso]
    // inclusive — spans a year either side of the range's own Hebrew years
    // so nothing near a Rosh Hashana boundary gets missed.
    holidaysInRange(startIso, endIso) {
      const y1 = this.isoToHebrew(startIso).year;
      const y2 = this.isoToHebrew(endIso).year;
      const all = [];
      for (let y = y1 - 1; y <= y2 + 1; y++) all.push(...holidaysForHebrewYear(y));
      return all.filter((h) => h.iso >= startIso && h.iso <= endIso);
    },
  };
})();
