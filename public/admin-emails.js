// ================================================================
// MOISDES ADMIN — Email Center (compose + sent log)
// admin-emails.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminEmails = (function () {
  const api = window.MOISDES.api;

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function canWrite() {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.emails?.write;
  }

  let bodyEditor = null;

  function initCompose() {
    const form = document.getElementById('emails-compose-form');
    const msg = document.getElementById('emails-compose-msg');
    const host = document.getElementById('emails-body-host');
    bodyEditor = window.MOISDES.richtext.createEditor(host, '');

    if (!canWrite()) {
      form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
      host.querySelector('.rte-editor').contentEditable = 'false';
      msg.textContent = "View only — you don't have write access to the Email Center.";
      msg.className = 'state-msg';
      return;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg.textContent = '';
      try {
        const data = await api.post('/api/emails/send', {
          to: document.getElementById('emails-to').value.trim(),
          subject: document.getElementById('emails-subject').value.trim(),
          bodyHtml: bodyEditor.getHtml(),
        });
        msg.textContent = data.dryRun ? (data.message || 'Logged (email sending isn’t configured yet).') : 'Sent.';
        msg.className = 'state-msg ok';
        form.reset();
        bodyEditor.setHtml('');
        loadLog();
      } catch (err) {
        msg.textContent = err.message || 'Could not send.';
        msg.className = 'state-msg err';
      }
      btn.disabled = false;
    });
  }

  async function loadLog() {
    const tbody = document.querySelector('#emails-log-table tbody');
    tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    try {
      const { emails } = await api.get('/api/emails');
      if (!emails.length) {
        tbody.innerHTML = '<tr><td colspan="4">No emails sent yet.</td></tr>';
        return;
      }
      tbody.innerHTML = '';
      emails.forEach((e) => {
        const tr = document.createElement('tr');
        const statusLabel = e.status === 'sent' ? 'Sent' : e.status === 'dry_run' ? 'Logged (not sent)' : 'Error';
        tr.innerHTML = `
          <td>${escapeHtml(e.to_email)}</td>
          <td>${escapeHtml(e.subject)}</td>
          <td>${escapeHtml(statusLabel)}${e.error_message ? ` <span class="state-msg" title="${escapeHtml(e.error_message)}">(details)</span>` : ''}</td>
          <td>${escapeHtml((e.created_at || '').slice(0, 16).replace('T', ' '))}</td>`;
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    }
  }

  function initTabs() {
    const composeTab = document.getElementById('emails-compose-tab');
    const logTab = document.getElementById('emails-log-tab');
    let logLoaded = false;
    document.querySelectorAll('#emails-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#emails-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');        const showLog = btn.dataset.tab === 'log';
        composeTab.style.display = showLog ? 'none' : '';
        logTab.style.display = showLog ? '' : 'none';
        if (showLog && !logLoaded) { logLoaded = true; loadLog(); }
      });
    });
  }

  function init() {
    initCompose();
    initTabs();
  }

  return { init };
})();
