// ================================================================
// MOISDES — קהילה לוח (COMMUNITY CALENDAR)
// calendar.js — Google-Calendar-style month grid + a continuous,
// scrollable agenda list (all events, grouped by day, positioned at
// today on load — scroll down for later events, up for earlier ones).
// The grid renders immediately with no event data so the page feels
// instant; events fill in (grid pills + agenda) once the fetch lands.
// Clicking an event (grid pill or agenda row) opens a detail popup.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const gridEl = document.getElementById('calendar-grid');
  const labelEl = document.getElementById('calendar-month-label');
  const prevBtn = document.getElementById('calendar-prev');
  const nextBtn = document.getElementById('calendar-next');
  const agendaEl = document.getElementById('calendar-agenda');
  const agendaPanel = document.getElementById('calendar-agenda-panel');
  const reportBtn = document.getElementById('report-simcha-btn');
  const gcalBtn = document.getElementById('gcal-add-btn');
  const modal = document.getElementById('event-modal');
  const modalBody = document.getElementById('event-modal-body');
  const modalClose = document.getElementById('event-modal-close');
  const attributionEl = document.getElementById('cal-attribution');

  const slug = window.MOISDES.CFG.simchaFormSlug;
  if (slug) {
    api.get(`/api/forms/${slug}/public`).then(() => {
      reportBtn.href = `/form.html?slug=${encodeURIComponent(slug)}`;
      reportBtn.style.display = '';
    }).catch(() => {});
  }

  api.get('/api/gcal-subscribe-url').then(({ url }) => {
    gcalBtn.href = url;
    gcalBtn.style.display = '';
  }).catch(() => {});

  const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MAX_PILLS = 2;

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const today = new Date();
  const todayIso = isoOf(today);
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let eventsByDay = {};
  let eventsLoaded = false;

  // ── PARSHA / HOLIDAY OVERLAY ────────────────────────────────────────
  // Renders instantly from the in-house engine (parsha via a fixed weekly
  // rotation, holidays via fixed Hebrew-calendar dates — both already used
  // elsewhere on the site), then quietly upgrades to Hebcal.com's calendar
  // API once it resolves: real per-year parsha combining rules (the local
  // rotation's "combined" list is only a same-every-year approximation)
  // plus minor fast days and Rosh Chodesh, which the in-house engine
  // doesn't compute at all. A Hebcal outage just keeps the local version.
  let userLoc = null;
  const hebcalCalCache = {};

  function emptyOverlayEntry() { return { holiday: [], fast: [], roshChodesh: [], parsha: null }; }

  function buildLocalOverlay(startIso, endIso, dayCells) {
    const overlay = {};
    hebrew.holidaysInRange(startIso, endIso).forEach((h) => {
      (overlay[h.iso] = overlay[h.iso] || emptyOverlayEntry()).holiday.push(h.name);
    });
    dayCells.forEach((d) => {
      if (d.getDay() !== 6) return;
      const dayIso = isoOf(d);
      (overlay[dayIso] = overlay[dayIso] || emptyOverlayEntry()).parsha = util.dateToParsha(dayIso);
    });
    return overlay;
  }

  // Hebrew cantillation/vowel-point marks (U+0591-U+05C7) — Hebcal's
  // "hebrew" strings carry nikud, but nothing else on this site does, so
  // strip it for a consistent plain-letter look everywhere.
  function stripNikud(s) { return String(s || '').replace(/[֑-ׇ]/g, ''); }

  function buildHebcalOverlay(items) {
    const overlay = {};
    (items || []).forEach((it) => {
      const iso = it.date && String(it.date).slice(0, 10);
      if (!iso) return;
      const label = stripNikud(it.hebrew || it.title || '').replace(/^פרשת\s+/, '').replace(/^Parashat\s+/i, '');
      if (!label || label === 'חג הבנות') return;
      const entry = overlay[iso] || (overlay[iso] = emptyOverlayEntry());
      if (it.category === 'parashat') entry.parsha = label;
      else if (it.category === 'roshchodesh') entry.roshChodesh.push(label);
      else if (it.category === 'fast') entry.fast.push(label);
      else if (it.category === 'holiday') entry.holiday.push(label);
    });
    return overlay;
  }

  async function fetchHebcalOverlay(startIso, endIso) {
    const key = `${startIso}_${endIso}_${userLoc ? userLoc.lat.toFixed(2) + ',' + userLoc.lon.toFixed(2) : ''}`;
    if (hebcalCalCache[key]) return hebcalCalCache[key];
    const params = new URLSearchParams({ start: startIso, end: endIso });
    if (userLoc) { params.set('lat', userLoc.lat); params.set('lon', userLoc.lon); }
    const { items } = await api.get(`/api/hebcal-calendar?${params.toString()}`);
    const overlay = buildHebcalOverlay(items);
    hebcalCalCache[key] = overlay;
    return overlay;
  }

  if (window.MOISDES.zmanim) {
    window.MOISDES.zmanim.withLocation((loc) => {
      const isNewCoords = !userLoc || userLoc.lat !== loc.lat || userLoc.lon !== loc.lon;
      userLoc = loc;
      if (isNewCoords) renderGrid(); // re-render once real geo resolves
    });
  }

  agendaEl.innerHTML = '<p class="state-msg">לאדט געשעענישן...</p>';

  // ── EVENT DETAIL POPUP ─────────────────────────────────────────────
  function closeModal() { modal.classList.remove('open'); modalBody.innerHTML = ''; }
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function mapLinks(addr) {
    if (!addr) return '';
    const q = encodeURIComponent(addr);
    return `
      <div class="map-links">
        <a class="map-link" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Google Maps</a>
        <a class="map-link" href="https://waze.com/ul?q=${q}&navigate=yes" target="_blank" rel="noopener">Waze</a>
      </div>`;
  }

  function openEventModal(ev) {
    const time = ev.allDay ? '' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    modalBody.innerHTML = `
      <div class="event-meta">${hebrew.isoToHebrewString(ev.date)}${time ? ' · ' + time : ''}</div>
      <h2 class="event-title" style="margin-bottom:.6rem">${util.eh(ev.summary)}</h2>
      ${ev.location ? `<div class="event-meta">${util.eh(ev.location)}</div>${mapLinks(ev.location)}` : ''}
      ${ev.description ? `<div class="detail-body">${util.eh(ev.description)}</div>` : ''}
    `;
    modal.classList.add('open');
  }

  function hebrewMonthLabel() {
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    const h1 = hebrew.isoToHebrew(`${viewYear}-${pad(viewMonth + 1)}-01`);
    const h2 = hebrew.isoToHebrew(`${viewYear}-${pad(viewMonth + 1)}-${pad(lastDay)}`);
    const label1 = `${h1.monthName} ${hebrew.yearToHebrew(h1.year)}`;
    const label2 = `${h2.monthName} ${hebrew.yearToHebrew(h2.year)}`;
    return label1 === label2 ? label1 : `${label1} — ${label2}`;
  }

  // Scrolls only the agenda panel's own scroll position — never the
  // whole page — using live viewport rects (robust regardless of
  // offsetParent chains) instead of scrollIntoView, which bubbles up
  // and moves every scrollable ancestor, including the window.
  function scrollAgendaTo(el, smooth) {
    if (!el) return;
    const delta = el.getBoundingClientRect().top - agendaPanel.getBoundingClientRect().top;
    const top = Math.max(0, agendaPanel.scrollTop + delta - 8);
    agendaPanel.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  function renderCells(dayCells, overlay) {
    gridEl.querySelectorAll('.cal-day').forEach((el) => el.remove());
    dayCells.forEach((d) => {
      const dayIso = isoOf(d);
      const otherMonth = d.getMonth() !== viewMonth;
      const cell = document.createElement('div');
      cell.className = 'cal-day' + (otherMonth ? ' other-month' : '');
      if (dayIso === todayIso) cell.classList.add('is-today');
      const dayEvents = eventsByDay[dayIso] || [];
      const hebDay = hebrew.isoToHebrew(dayIso);
      const info = overlay[dayIso] || emptyOverlayEntry();
      const badges = [
        ...info.roshChodesh.map((n) => `<div class="cal-roshchodesh">${util.eh(n)}</div>`),
        ...info.holiday.map((n) => `<div class="cal-holiday">${util.eh(n)}</div>`),
        ...info.fast.map((n) => `<div class="cal-fast">${util.eh(n)}</div>`),
      ].join('');

      cell.innerHTML = `
        <div class="cal-day-top">
          <span class="cal-daynum">${d.getDate()}</span>
          <span class="cal-hebday">${util.eh(hebrew.dayToHebrew(hebDay.day))}</span>
        </div>
        ${badges}
        ${info.parsha ? `<div class="cal-parsha">פ' ${util.eh(info.parsha)}</div>` : ''}
        <div class="cal-events"></div>
      `;
      const eventsWrap = cell.querySelector('.cal-events');
      dayEvents.slice(0, MAX_PILLS).forEach((ev) => {
        const pill = document.createElement('span');
        pill.className = 'cal-event-pill';
        pill.textContent = ev.summary;
        pill.addEventListener('click', (e) => { e.stopPropagation(); openEventModal(ev); });
        eventsWrap.appendChild(pill);
      });
      if (dayEvents.length > MAX_PILLS) {
        const more = document.createElement('span');
        more.className = 'cal-event-more';
        more.textContent = `+${dayEvents.length - MAX_PILLS}`;
        eventsWrap.appendChild(more);
      }

      cell.addEventListener('click', () => {
        const heading = agendaEl.querySelector(`[data-day="${dayIso}"]`);
        scrollAgendaTo(heading, true);
      });
      gridEl.appendChild(cell);
    });
  }

  let gridRenderToken = 0;

  function renderGrid() {
    const myToken = ++gridRenderToken;
    labelEl.innerHTML = `${MONTH_NAMES[viewMonth]} ${viewYear}<div class="calendar-month-heb">${util.eh(hebrewMonthLabel())}</div>`;
    gridEl.innerHTML = '';
    WEEKDAYS.forEach((w) => {
      const cell = document.createElement('div');
      cell.className = 'cal-weekday';
      cell.textContent = w;
      gridEl.appendChild(cell);
    });

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const dayCells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      dayCells.push(d);
    }
    while (dayCells.length > 35 && dayCells.slice(-7).every((d) => d.getMonth() !== viewMonth)) {
      dayCells.splice(-7, 7);
    }

    const startIso = isoOf(dayCells[0]), endIso = isoOf(dayCells[dayCells.length - 1]);
    renderCells(dayCells, buildLocalOverlay(startIso, endIso, dayCells));

    fetchHebcalOverlay(startIso, endIso).then((overlay) => {
      if (myToken !== gridRenderToken) return; // user navigated away before this landed
      renderCells(dayCells, overlay);
      if (attributionEl) attributionEl.style.display = '';
    }).catch(() => { /* keep the local fallback rendered above */ });
  }

  function renderAgenda() {
    const days = Object.keys(eventsByDay).sort();
    if (!days.length) {
      agendaEl.innerHTML = '<p class="state-msg">נאך קיין געשעענישן אין קאלענדאר</p>';
      return;
    }
    agendaEl.innerHTML = '';
    let scrollTarget = null;
    days.forEach((dayIso) => {
      const heading = document.createElement('h4');
      heading.className = 'agenda-day-heading';
      heading.dataset.day = dayIso;
      heading.textContent = hebrew.isoToHebrewString(dayIso);
      if (dayIso === todayIso) heading.classList.add('is-today');
      if (dayIso >= todayIso && !scrollTarget) scrollTarget = heading;
      agendaEl.appendChild(heading);

      eventsByDay[dayIso].slice().sort((a, b) => a.start.localeCompare(b.start)).forEach((ev) => {
        const time = ev.allDay ? '' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const row = document.createElement('div');
        row.className = 'search-result';
        row.style.cursor = 'pointer';
        row.innerHTML = `
          <div class="search-result-title">${util.eh(ev.summary)}${time ? ' · ' + time : ''}</div>
          ${ev.location ? `<div class="search-result-meta">${util.eh(ev.location)}</div>` : ''}
          ${ev.description ? `<div class="search-result-excerpt">${util.eh(ev.description)}</div>` : ''}
        `;
        row.addEventListener('click', () => openEventModal(ev));
        agendaEl.appendChild(row);
      });
    });
    scrollAgendaTo(scrollTarget, false);
  }

  prevBtn.addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderGrid();
  });
  nextBtn.addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderGrid();
  });

  renderGrid();

  try {
    const { events } = await api.get('/api/gcal-events');
    events.forEach((ev) => {
      (eventsByDay[ev.date] = eventsByDay[ev.date] || []).push(ev);
    });
    eventsLoaded = true;
    renderGrid();
    renderAgenda();
  } catch (e) {
    eventsLoaded = true;
    agendaEl.innerHTML = `<p class="state-msg">${util.eh(e.message || 'נישט געקענט לאדן דעם קאלענדאר')}</p>`;
  }
})();
