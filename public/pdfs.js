// ================================================================
// MOISDES — PDFS (גליונות) PAGE
// pdfs.js
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const hebrew = window.MOISDES.hebrew;
  const grid = document.getElementById('pdfs-grid');

  try {
    const { pdfs } = await api.get('/api/pdfs');
    if (!pdfs.length) {
      grid.innerHTML = '<p class="state-msg">נאך קיין גליונות נישט פארעפנטליכט</p>';
      return;
    }
    const sorted = [...pdfs].sort((a, b) => util.dateDesc(a.date, b.date));
    grid.innerHTML = '';

    sorted.forEach((pdf, i) => {
      const card = document.createElement('a');
      card.href = pdf.pdf_url ? api.r2Url(pdf.pdf_url) : '#';
      card.target = '_blank';
      card.rel = 'noopener';
      card.className = 'card pdf-card';
      card.id = `pdf-${pdf.id}`;
      card.innerHTML = `
        <div class="card-media">${pdf.thumb_url ? `<img src="${util.eh(api.r2Url(pdf.thumb_url))}" alt="">` : ''}</div>
        <div class="card-body">
          <div class="card-date">${hebrew.isoToHebrewString(pdf.date)}${i === 0 ? '<span class="badge-new">חדש</span>' : ''}</div>
          <div class="card-title">${util.eh(pdf.title)}${pdf.parsha ? ' · ' + util.eh(pdf.parsha) : ''}</div>
        </div>`;
      grid.appendChild(card);
    });
  } catch (e) {
    grid.innerHTML = '<p class="state-msg">נישט געקענט לאדן</p>';
  }
})();
