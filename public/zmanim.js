// ================================================================
// MOISDES — ZMANIM ENGINE
// zmanim.js
// Sunrise/sunset via the standard NOAA-based solar position formulas
// (the same approach used by most zmanim calendars/libraries — accurate
// to roughly a minute). Sof Zman Shema/Tfilah are given in both the
// Magen Avraham (day = alos 72 to tzeis 72, earlier) and Gra (day =
// sunrise to sunset, later) opinions, per the site's standing convention.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.zmanim = (function () {
  const rad = Math.PI / 180;
  const dayMs = 1000 * 60 * 60 * 24;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const e = rad * 23.4397; // obliquity of the Earth

  const sin = Math.sin, cos = Math.cos, tan = Math.tan, asin = Math.asin, acos = Math.acos, atan2 = Math.atan2;

  function toJulian(date) { return date.valueOf() / dayMs - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
  function toDays(date) { return toJulian(date) - J2000; }

  function rightAscension(l, b) { return atan2(sin(l) * cos(e) - tan(b) * sin(e), cos(l)); }
  function declination(l, b) { return asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l)); }
  function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
  function eclipticLongitude(M) {
    const C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M));
    const P = rad * 102.9372;
    return M + C + P + Math.PI;
  }
  function julianCycle(d, lw) { return Math.round(d - 0.0009 - lw / (2 * Math.PI)); }
  function approxTransit(Ht, lw, n) { return 0.0009 + (Ht + lw) / (2 * Math.PI) + n; }
  function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L); }
  function hourAngle(h, phi, d) { return acos((sin(h) - sin(phi) * sin(d)) / (cos(phi) * cos(d))); }
  function getSetJ(h, lw, phi, dec, n, M, L) {
    const w = hourAngle(h, phi, dec);
    const a = approxTransit(w, lw, n);
    return solarTransitJ(a, M, L);
  }

  // Returns { sunrise, sunset, solarNoon } as JS Date objects for the
  // given calendar date (local calendar day) at (lat, lon), optionally
  // corrected for the observer's elevation in meters.
  //
  // This simplified formula (SunCalc-style, low-order series) is kept
  // only as a fallback for the rare case spa.js failed to load — the
  // real engine is NREL's Solar Position Algorithm (spa.js), a far
  // higher-precision reference implementation (full VSOP87 + nutation
  // series vs. this formula's handful of terms). See getSunTimes() below.
  function getSunTimesNoaa(date, lat, lon, elevation) {
    const lw = rad * -lon, phi = rad * lat;
    const d = toDays(date), n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);
    // Standard geometric + refraction depression (-0.833°), plus a
    // horizon-dip correction when elevation is known: being higher up
    // lets you see further over the horizon, so sunrise is genuinely a
    // touch earlier and sunset a touch later. dip(°) ≈ 1.76·√(meters)/60
    // (standard formula used by most zmanim calculators).
    const dip = elevation > 0 ? (1.76 * Math.sqrt(elevation)) / 60 : 0;
    const h0 = (-0.833 - dip) * rad;
    const Jset = getSetJ(h0, lw, phi, dec, n, M, L);
    const Jrise = Jnoon - (Jset - Jnoon);
    return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), solarNoon: fromJulian(Jnoon) };
  }

  // Prefers the NREL Solar Position Algorithm (spa.js) when it's loaded
  // on the page; falls back to the simplified formula above otherwise.
  function getSunTimes(date, lat, lon, elevation) {
    const spa = window.MOISDES.spa;
    if (spa) return spa.sunTimes(date, lat, lon, elevation);
    return getSunTimesNoaa(date, lat, lon, elevation);
  }

  function addMinutes(date, mins) { return new Date(date.getTime() + mins * 60000); }

  // Local calendar date as "YYYY-MM-DD" — deliberately NOT
  // date.toISOString().slice(0,10), which converts to UTC and rolls to
  // the next calendar day during evening hours in negative-UTC-offset
  // timezones (most of the US), well before local midnight.
  function localIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Full zmanim set for one calendar date, fixed-72-minute method for
  // alos/tzeis (matches Tzeis 60/72 below), Gra day = sunrise-sunset.
  function computeZmanim(date, lat, lon, elevation) {
    const { sunrise, sunset, solarNoon } = getSunTimes(date, lat, lon, elevation);
    const alos = addMinutes(sunrise, -72);
    const tzeis72 = addMinutes(sunset, 72);
    const shaaGra = (sunset - sunrise) / 12;
    const shaaMA = (tzeis72 - alos) / 12;
    return {
      sunrise,
      sunset,
      chatzos: solarNoon,
      sofZmanShemaEarly: new Date(alos.getTime() + 3 * shaaMA),
      sofZmanShemaLate: new Date(sunrise.getTime() + 3 * shaaGra),
      sofZmanTfilahEarly: new Date(alos.getTime() + 4 * shaaMA),
      sofZmanTfilahLate: new Date(sunrise.getTime() + 4 * shaaGra),
      tzeis60: addMinutes(sunset, 60),
      tzeis72,
    };
  }

  function fmtTime(d) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ── HEBCAL.COM ZMANIM (via the Worker's /api/hebcal-zmanim proxy) ──
  // Hebcal's own solar/astronomical engine is the community-trusted
  // reference most zmanim apps use; when it's reachable we prefer it for
  // the fields that actually depend on precise sun-position math. Fixed
  // clock-offset fields (tzeis 60/72, purely "sunset + N minutes") don't
  // need it — those are recomputed locally from whichever sunset resolves.
  //
  // Matched by normalized-substring rather than an exact key name: we
  // can't live-verify Hebcal's exact field spelling from this dev
  // environment, and a single wrong exact-match would silently fall back
  // to the local calculation for that field with no visible sign anything
  // was wrong. Include/exclude patterns are far more tolerant of whatever
  // the real casing/spelling turns out to be (sofZmanShma vs sof_zman_shma
  // vs sofZmanShmaGRA, etc).
  const HEBCAL_FIELD_RULES = {
    sunrise: { include: ['sunrise'], exclude: [] },
    sunset: { include: ['sunset'], exclude: [] },
    chatzos: { include: ['chatzot'], exclude: ['night'] },
    sofZmanShemaEarly: { include: ['sofzmanshma'], exclude: ['tfil'] }, // Magen Avraham
    sofZmanShemaLate: { include: ['sofzmanshma'], exclude: ['tfil', 'mga', 'ma19', 'ma16', 'ma72'] }, // Gra
    sofZmanTfilahEarly: { include: ['sofzmantfil'], exclude: [] }, // Magen Avraham
    sofZmanTfilahLate: { include: ['sofzmantfil'], exclude: ['mga', 'ma19', 'ma16', 'ma72'] }, // Gra
  };

  function normalizeKey(k) { return k.toLowerCase().replace(/[^a-z]/g, ''); }

  // Within a field's matching candidates, the MGA (early/stringent)
  // variant's key normally contains "mga" and the Gra (late) variant's
  // doesn't — so among all keys matching a field's include/exclude rule,
  // prefer the one whose "has mga in the name" matches what this field is.
  function pickHebcalField(times, rule, wantMga) {
    const candidates = Object.keys(times).filter((k) => {
      const norm = normalizeKey(k);
      return rule.include.every((p) => norm.includes(p)) && !rule.exclude.some((p) => norm.includes(p));
    });
    if (!candidates.length) return null;
    const mgaMatch = candidates.find((k) => normalizeKey(k).includes('mga') === wantMga);
    return times[mgaMatch || candidates[0]];
  }

  async function hebcalTimes(dateIso, lat, lon) {
    try {
      const api = window.MOISDES.api;
      if (!api) return null;
      const { times } = await api.get(`/api/hebcal-zmanim?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&date=${encodeURIComponent(dateIso)}`);
      return times || null;
    } catch (e) {
      return null;
    }
  }

  // Same shape as computeZmanim(), but tries Hebcal first and only falls
  // back to the in-house calculation (per field, not all-or-nothing) when
  // Hebcal is unreachable or a particular field is missing from its
  // response — a Hebcal outage or a renamed field degrades quietly
  // instead of blanking out the widget. Returns { zmanim, source } so the
  // caller can show attribution only when Hebcal's numbers were actually used.
  async function computeZmanimWithHebcal(date, lat, lon, elevation, dateIso) {
    const local = computeZmanim(date, lat, lon, elevation);
    const times = await hebcalTimes(dateIso, lat, lon);
    if (!times) return { zmanim: local, source: 'local' };

    const merged = { ...local };
    let usedAny = false;
    for (const [ourKey, rule] of Object.entries(HEBCAL_FIELD_RULES)) {
      const wantMga = ourKey.endsWith('Early');
      const raw = pickHebcalField(times, rule, wantMga);
      if (!raw) continue;
      const d = new Date(raw);
      if (isNaN(d.getTime())) continue;
      merged[ourKey] = d;
      usedAny = true;
    }
    merged.tzeis60 = addMinutes(merged.sunset, 60);
    merged.tzeis72 = addMinutes(merged.sunset, 72);
    return { zmanim: merged, source: usedAny ? 'hebcal' : 'local' };
  }

  // Current Hebrew calendar date the halachic way: the day rolls over at
  // shkia+72 (not midnight), and shows an "אור ליום" prefix from that
  // rollover until the next sunrise.
  function currentHebrewDateDisplay(lat, lon, elevation) {
    const hebrew = window.MOISDES.hebrew;
    const now = new Date();
    const todayIso = localIso(now);
    const tToday = getSunTimes(now, lat, lon, elevation);
    const rollover = addMinutes(tToday.sunset, 72);

    if (now < rollover) {
      return { text: hebrew.isoToHebrewString(todayIso), ohrLyom: false, effectiveIso: todayIso };
    }
    const tomorrow = new Date(now.getTime() + dayMs);
    const tomorrowIso = localIso(tomorrow);
    const tTomorrow = getSunTimes(tomorrow, lat, lon, elevation);
    const stillBeforeSunrise = now < tTomorrow.sunrise;
    const label = hebrew.isoToHebrewString(tomorrowIso);
    return { text: stillBeforeSunrise ? `אור ליום ${label}` : label, ohrLyom: stillBeforeSunrise, effectiveIso: tomorrowIso };
  }

  // Hebcal's Hebrew-date strings carry nikud (vowel points) and a
  // grammatical "ב" prefix on the month ("באב" = "in Av") — neither
  // matches this site's plain style used everywhere else (e.g. "אב", no
  // points), so both get stripped rather than shown as Hebcal renders them.
  const HEB_MONTH_STEMS = ['תשרי', 'מרחשון', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר א', 'אדר ב', 'אדר', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
  function cleanHebcalHebrew(s) {
    let out = String(s || '').replace(/[֑-ׇ]/g, ''); // strip nikud/cantillation (U+0591-U+05C7)
    for (const m of HEB_MONTH_STEMS) {
      const withPrefix = 'ב' + m;
      if (out.includes(withPrefix)) { out = out.replace(withPrefix, m); break; }
    }
    return out;
  }

  // Hebcal-sourced Hebrew-date text for the already-resolved effective
  // date (which date is "in effect" is still decided locally via the
  // shkia+72 rollover above — Hebcal only supplies the display string for
  // that date). Returns null on any failure so callers fall back to
  // currentHebrewDateDisplay()'s own in-house .text field.
  async function hebcalDateText(effectiveIso, ohrLyom) {
    try {
      const api = window.MOISDES.api;
      if (!api) return null;
      const { hebrew: hebStr } = await api.get(`/api/hebcal-date?date=${encodeURIComponent(effectiveIso)}`);
      if (!hebStr) return null;
      const clean = cleanHebcalHebrew(hebStr);
      return ohrLyom ? `אור ליום ${clean}` : clean;
    } catch (e) {
      return null;
    }
  }

  const BROOKLYN = { lat: 40.6782, lon: -73.9442, elevation: 0, label: 'Brooklyn, NY' };

  // Geolocates with a Brooklyn fallback; always calls back with a small
  // "which location" label so the displayed times are never unexplained.
  // The label starts as coordinates (immediate) and upgrades to a city
  // name via reverse geocoding when that resolves. GPS altitude (when
  // the device provides one — mobile GPS usually does, desktop/wifi
  // geolocation usually doesn't) feeds the horizon-dip correction above.
  function withLocation(cb) {
    if (!navigator.geolocation) return cb(BROOKLYN);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        const elevation = typeof pos.coords.altitude === 'number' && pos.coords.altitude > 0 ? pos.coords.altitude : 0;
        const loc = { lat, lon, elevation, label: `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
        cb(loc);
        fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)
          .then((r) => r.json())
          .then((data) => {
            const name = [data.city || data.locality, data.principalSubdivision].filter(Boolean).join(', ');
            if (name) cb({ lat, lon, elevation, label: name });
          })
          .catch(() => {});
      },
      () => cb(BROOKLYN),
      { timeout: 5000, enableHighAccuracy: true }
    );
  }

  return { getSunTimes, computeZmanim, computeZmanimWithHebcal, fmtTime, currentHebrewDateDisplay, hebcalDateText, withLocation, localIso, BROOKLYN };
})();
