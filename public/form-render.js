// ================================================================
// MOISDES — PUBLIC FORM RENDERER (/form.html?slug=<slug>)
// form-render.js
//
// Routed by query string, not a path segment (was /form/<slug>) —
// Cloudflare Pages' automatic clean-URL canonicalization treats a
// literal form.html as the canonical asset for the route /form and
// issues its own redirect collapsing any /form/<slug> path down to bare
// /form, stripping the slug before a custom _redirects rule ever gets a
// chance to run. A query string sidesteps that whole class of routing
// ambiguity: this is just one real file, loaded directly, with the slug
// read from the query string client-side — nothing for Cloudflare's
// path-based redirect logic to collapse.
// ================================================================

(async function () {
  const api = window.MOISDES.api;
  const util = window.MOISDES.util;
  const app = document.getElementById('app');

  // body is rendered as raw HTML (rich-text content from the admin
  // builder, e.g. the thank-you message) — only title is plain text.
  function showMessage(title, body) {
    app.innerHTML = `
      <div class="form-wrap">
        <h1 class="page-title">${util.eh(title)}</h1>
        ${body ? `<div>${body}</div>` : ''}
      </div>`;
  }

  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) {
    showMessage('דאס בלאט איז נישט געפונען געווארן', '');
    app.querySelector('.form-wrap').insertAdjacentHTML('beforeend', '<p><a href="/">צוריק צום הויפט בלאט</a></p>');
    return;
  }

  let form, fields;
  try {
    const data = await api.get(`/api/forms/${encodeURIComponent(slug)}/public`);
    form = data.form;
    fields = data.fields;
  } catch (e) {
    showMessage('דער פארמולאר איז נישט געפונען געווארן', '');
    app.querySelector('.form-wrap').insertAdjacentHTML('beforeend', '<p><a href="/">צוריק צום הויפט בלאט</a></p>');
    return;
  }

  document.title = form.title ? `${form.title} — חצר וויען` : 'פארמולאר — חצר וויען';
  const settings = form.settings || {};

  if (settings.status === 'closed') {
    showMessage(form.title || '', '');
    app.querySelector('.form-wrap').insertAdjacentHTML('beforeend', '<p class="state-msg">דער פארמולאר איז געשלאסן</p>');
    return;
  }

  // ── Build the form ──────────────────────────────────────────────────

  function fieldWrap(f, inner) {
    const wrap = document.createElement('div');
    wrap.className = 'form-field';
    if (f.label && f.type !== 'heading' && f.type !== 'paragraph') {
      const label = document.createElement('label');
      label.setAttribute('for', `field-${f.id}`);
      label.innerHTML = util.eh(f.label) + (f.required ? ' <span class="req">*</span>' : '');
      wrap.appendChild(label);
    }
    wrap.appendChild(inner);
    return wrap;
  }

  function buildField(f) {
    const name = `field-${f.id}`;

    if (f.type === 'heading') {
      const el = document.createElement('div');
      el.className = 'form-heading';
      el.textContent = f.label || '';
      const wrap = document.createElement('div');
      wrap.className = 'form-field';
      wrap.appendChild(el);
      return wrap;
    }
    if (f.type === 'paragraph') {
      const el = document.createElement('div');
      el.className = 'form-paragraph';
      el.textContent = f.label || '';
      const wrap = document.createElement('div');
      wrap.className = 'form-field';
      wrap.appendChild(el);
      return wrap;
    }

    if (f.type === 'radio' || f.type === 'checkbox') {
      const group = document.createElement('div');
      group.className = 'choice-group';
      // Radio: native `required` on every input in the (shared-name) group
      // correctly means "at least one must be checked" per the HTML spec.
      // Checkbox: each box is its own separate control (name="...[]"), so
      // there's no native way to express "at least one of these" — native
      // `required` on every box would instead demand ALL of them checked.
      // That case is validated by hand in the submit handler below instead
      // (see requiredCheckboxGroups), so `required` is deliberately never
      // set on checkbox inputs here.
      if (f.required) group.dataset.requiredGroup = f.type;
      (f.options || []).forEach((option, i) => {
        const row = document.createElement('div');
        row.className = 'choice-row';
        const input = document.createElement('input');
        input.type = f.type;
        input.name = f.type === 'radio' ? name : `${name}[]`;
        input.value = option;
        input.id = `${name}-${i}`;
        if (f.required && f.type === 'radio') input.required = true;
        const label = document.createElement('label');
        label.setAttribute('for', input.id);
        label.textContent = option;
        label.style.fontWeight = '400';
        row.appendChild(input);
        row.appendChild(label);
        group.appendChild(row);
      });
      return fieldWrap(f, group);
    }

    let input;
    switch (f.type) {
      case 'textarea':
        input = document.createElement('textarea');
        break;
      case 'select':
        input = document.createElement('select');
        input.innerHTML = '<option value="">-</option>' +
          (f.options || []).map((o) => `<option value="${util.eh(o)}">${util.eh(o)}</option>`).join('');
        break;
      case 'file':
        input = document.createElement('input');
        input.type = 'file';
        break;
      case 'email':
        input = document.createElement('input');
        input.type = 'email';
        break;
      case 'phone':
        input = document.createElement('input');
        input.type = 'tel';
        break;
      case 'date':
        input = document.createElement('input');
        input.type = 'date';
        break;
      default:
        input = document.createElement('input');
        input.type = 'text';
    }
    input.id = name;
    input.name = name;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.required) input.required = true;
    return fieldWrap(f, input);
  }

  async function collectAnswer(f, formEl) {
    const name = `field-${f.id}`;
    if (f.type === 'checkbox') {
      return [...formEl.querySelectorAll(`[name="${name}[]"]:checked`)].map((el) => el.value).join(', ');
    }
    if (f.type === 'radio') {
      const checked = formEl.querySelector(`[name="${name}"]:checked`);
      return checked ? checked.value : '';
    }
    if (f.type === 'file') {
      const file = formEl.querySelector(`#${name}`).files[0];
      if (!file) return '';
      const { url, key } = await api.post(`/api/forms/${encodeURIComponent(slug)}/presign`, { filename: file.name });
      const res = await fetch(url, { method: 'PUT', body: file });
      if (!res.ok) throw new Error(`Could not upload ${file.name} (${res.status})`);
      return key;
    }
    const el = formEl.querySelector(`#${name}`);
    return el ? el.value : '';
  }

  const wrap = document.createElement('div');
  wrap.className = 'form-wrap';

  const titleEl = document.createElement('h1');
  titleEl.className = 'page-title';
  titleEl.textContent = form.title || '';
  wrap.appendChild(titleEl);

  if (settings.description) {
    const desc = document.createElement('div');
    desc.className = 'form-paragraph';
    desc.innerHTML = settings.description; // rich-text content from the admin builder
    wrap.appendChild(desc);
  }

  const formEl = document.createElement('form');
  formEl.id = 'public-form';
  formEl.noValidate = false;
  fields.forEach((f) => formEl.appendChild(buildField(f)));

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'form-submit';
  submitBtn.textContent = 'שיקט';
  formEl.appendChild(submitBtn);

  const errorEl = document.createElement('div');
  errorEl.className = 'form-error';
  formEl.appendChild(errorEl);

  wrap.appendChild(formEl);
  app.innerHTML = '';
  app.appendChild(wrap);

  // Required checkbox groups can't be validated with the native
  // `required` attribute (see the comment above where they're built), so
  // it's checked by hand here: every group.dataset.requiredGroup ===
  // 'checkbox' must have at least one box checked before submitting.
  function checkRequiredCheckboxGroups() {
    for (const group of formEl.querySelectorAll('[data-required-group="checkbox"]')) {
      if (!group.querySelector('input[type=checkbox]:checked')) return false;
    }
    return true;
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    if (!checkRequiredCheckboxGroups()) {
      errorEl.textContent = 'ביטע אויסקלייבן כאטש איין אפציע וואו עס איז פארלאנגט.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'שיקט...';

    try {
      const answers = {};
      for (const f of fields) {
        if (f.type === 'heading' || f.type === 'paragraph') continue;
        answers[f.id] = await collectAnswer(f, formEl);
      }
      await api.post(`/api/forms/${encodeURIComponent(slug)}/submit`, { answers });
      showMessage(settings.thankYouTitle || 'א דאנק!', settings.thankYouMessage || 'אייער ענטפער איז אנגענומען געווארן.');
    } catch (err) {
      errorEl.textContent = err.message || 'עפעס איז נישט אין ארדנונג. פרובירט נאכאמאל.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'שיקט';
    }
  });
})();
