// ================================================================
// MOISDES — HEADER/FOOTER INTERACTIVITY
// chrome.js
// Header/footer markup is static HTML in each page (so it's present on
// first paint, no load-in-then-shift). This just wires up the mobile
// menu toggle.
// ================================================================

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
