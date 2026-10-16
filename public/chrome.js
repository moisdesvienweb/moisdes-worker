// ================================================================
// MOISDES — HEADER/FOOTER INTERACTIVITY
// chrome.js
// Header/footer markup is static HTML in each page (so it's present on
// first paint, no load-in-then-shift). This just wires up the mobile
// menu toggle.
// ================================================================

// ── LOADING OVERLAY (home page only — hidden by home.js once the mosaic
// has rendered, with a safety timeout in case something hangs).
(function () {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  window.MOISDES = window.MOISDES || {};
  let hidden = false;
  window.MOISDES.hideLoadingOverlay = function () {
    if (hidden) return;
    hidden = true;
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 500);
  };
  setTimeout(window.MOISDES.hideLoadingOverlay, 12000);
})();

(function () {
  const burger = document.getElementById('burger-btn');
  const mobile = document.getElementById('moisdes-mobile');
  const closeBtn = document.getElementById('mobile-close-btn');

  if (burger && mobile) burger.addEventListener('click', () => mobile.classList.add('open'));
  if (closeBtn && mobile) closeBtn.addEventListener('click', () => mobile.classList.remove('open'));
  if (mobile) {
    mobile.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => mobile.classList.remove('open')));
  }
})();

// ── SIMCHAS TICKER (shared across every page) — last 10 days, always
// at least 10, doubled content for a seamless loop (see shared-styles.css).
(async function () {
  const tickerWrap = document.getElementById('simchas-ticker-wrap');
  const tickerEl = document.getElementById('simchas-ticker');
  if (!tickerWrap || !tickerEl || !window.MOISDES || !window.MOISDES.api) return;

  try {
    const api = window.MOISDES.api;
    const util = window.MOISDES.util;
    const { simchas } = await api.get('/api/simchas');
    const cutoff = Date.now() - 10 * 86400000;
    let recent = simchas.filter((s) => new Date(s.date_added).getTime() >= cutoff);
    if (recent.length < 10) recent = simchas.slice(0, 10);
    if (recent.length) {
      const chunk = recent.map((s) => util.eh(s.text)).join('&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;') + '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;';
      tickerEl.innerHTML = `<span>${chunk}${chunk}</span>`;
      tickerWrap.style.display = 'block';
    }
  } catch (e) { /* ticker just stays hidden */ }
})();

// ── NEWSLETTER + CONTACT + CUSTOM FOOTER BUTTONS (shared across every
// page) — newsletter shows once a URL is set via Admin → Settings;
// contact shows once a form with the configured slug exists (Admin →
// Forms); any number of additional custom buttons (label + URL, added
// from Admin → Settings) render alongside them, same size, one row.
(async function () {
  if (!window.MOISDES || !window.MOISDES.api) return;
  const newsletterBtn = document.getElementById('newsletter-btn');
  const contactBtn = document.getElementById('contact-btn');
  const actionsEl = document.querySelector('.footer-actions');

  window.MOISDES.api.get('/api/settings').then(({ settings }) => {
    if (newsletterBtn && settings.newsletter_url) {
      newsletterBtn.href = settings.newsletter_url;
      newsletterBtn.style.display = '';
    }
    if (actionsEl) {
      let buttons = [];
      try { buttons = JSON.parse(settings.footer_buttons || '[]'); } catch (e) { buttons = []; }
      if (Array.isArray(buttons)) {
        buttons.forEach(({ label, url }) => {
          if (!label || !url) return;
          const a = document.createElement('a');
          a.className = 'btn btn-sm newsletter-btn';
          a.href = url;
          if (/^https?:\/\//i.test(url)) { a.target = '_blank'; a.rel = 'noopener'; }
          a.textContent = label;
          actionsEl.appendChild(a);
        });
      }
    }
  }).catch(() => {});

  const contactSlug = window.MOISDES.CFG && window.MOISDES.CFG.contactFormSlug;
  if (contactBtn && contactSlug) {
    window.MOISDES.api.get(`/api/forms/${contactSlug}/public`).then(() => {
      contactBtn.href = `/form.html?slug=${encodeURIComponent(contactSlug)}`;
      contactBtn.style.display = '';
    }).catch(() => {});
  }
})();

// ── PAGE-VIEW TRACKING (fires once per page load) + a reusable helper
// for tracking clicks/shares elsewhere.
(function () {
  if (!window.MOISDES) return;
  window.MOISDES.track = function (kind, label) {
    if (!window.MOISDES.api) return;
    window.MOISDES.api.post('/api/track', { kind, path: location.pathname, label: label || '' }).catch(() => {});
  };
  if (window.MOISDES.api) window.MOISDES.track('view');
})();

// ── SHARE BUTTON — a small reusable "share" control (email + copy link),
// used on content cards across the site. Each click is tracked.
//
// The dropdown is appended to <body> (not the button's own wrapper) and
// positioned with `position: fixed` from the button's live bounding rect.
// Cards use `overflow: hidden` for their media crop, which was clipping
// an absolutely-positioned menu — a body-level portal sidesteps that
// entirely and also lets it flip to open upward when there's no room
// below (e.g. the last card in a grid, near the footer).
(function () {
  if (!window.MOISDES) return;
  window.MOISDES.shareButton = function (url, title) {
    const wrap = document.createElement('div');
    wrap.className = 'share-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-btn';
    btn.title = 'טיילן';
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg>';

    const menu = document.createElement('div');
    menu.className = 'share-menu';
    menu.style.display = 'none';

    const emailLink = document.createElement('a');
    emailLink.href = `mailto:?subject=${encodeURIComponent(title || '')}&body=${encodeURIComponent(url)}`;
    emailLink.textContent = 'אימעיל';
    emailLink.addEventListener('click', () => window.MOISDES.track('share', `email:${url}`));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'קאפירן לינק';
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await navigator.clipboard.writeText(url); copyBtn.textContent = 'קאפירט!'; }
      catch (err) { copyBtn.textContent = url; }
      window.MOISDES.track('share', `copy:${url}`);
      setTimeout(() => { closeMenu(); copyBtn.textContent = 'קאפירן לינק'; }, 1200);
    });

    menu.appendChild(emailLink);
    menu.appendChild(copyBtn);
    document.body.appendChild(menu);

    function positionMenu() {
      const r = btn.getBoundingClientRect();
      menu.style.minWidth = '130px';
      const openUpward = r.bottom + 120 > window.innerHeight;
      if (openUpward) {
        menu.style.top = '';
        menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
      } else {
        menu.style.bottom = '';
        menu.style.top = `${r.bottom + 6}px`;
      }
      const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
      if (rtl) {
        menu.style.left = '';
        menu.style.right = `${Math.max(6, window.innerWidth - r.right)}px`;
      } else {
        menu.style.right = '';
        menu.style.left = `${Math.max(6, r.left)}px`;
      }
    }
    function closeMenu() {
      menu.style.display = 'none';
      window.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('resize', positionMenu);
    }
    function openMenu() {
      document.querySelectorAll('.share-menu').forEach((m) => { m.style.display = 'none'; });
      positionMenu();
      menu.style.display = 'flex';
      window.addEventListener('scroll', positionMenu, true);
      window.addEventListener('resize', positionMenu);
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.style.display === 'none') openMenu(); else closeMenu();
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });

    wrap.appendChild(btn);
    return wrap;
  };
})();
