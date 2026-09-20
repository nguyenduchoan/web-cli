(() => {
  const $ = (id) => document.getElementById(id);
  const showMessage = (id, message) => { $(id).textContent = message; $(id).hidden = !message; };
  async function api(url, data) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const body = await response.json();
    if (!response.ok) {
      if (body.loginUrl) location.replace('/login');
      throw new Error(body.message || 'Không thể hoàn tất yêu cầu.');
    }
    return body;
  }
  async function load() {
    $('loading').hidden = false; $('retry').hidden = true; showMessage('page-error', '');
    try {
      const state = await api('/hub-api/status');
      if (!state.authenticated && location.pathname !== '/login') { location.replace('/login'); return; }
      if (state.authenticated && location.pathname === '/login') {
        const hash = location.hash;
        const target = /^#session=[0-9a-f-]{36}$/i.test(hash) ? `/api/web-cli/${hash}` : '/';
        location.replace(target);
        return;
      }
      $('login-view').hidden = state.authenticated; $('hub-view').hidden = !state.authenticated;
      if (state.authenticated) {
        $('greeting').textContent = `CHÀO ${state.username.toUpperCase()} · KHÔNG GIAN DỊCH VỤ`;
        $('initial-notice').hidden = !state.mustChangePassword;
        const data = await api('/hub-api/services');
        $('availability').textContent = `● ${data.services.filter((s) => s.status === 'ready').length} dịch vụ sẵn sàng`;
        $('agent-count').textContent = `${data.agentCount} terminal & agent`;
      }
    } catch (error) { showMessage('page-error', error.message || 'Mất kết nối. Vui lòng thử lại.'); $('retry').hidden = false; }
    finally { $('loading').hidden = true; }
  }
  $('retry').addEventListener('click', load);
  $('show-password').addEventListener('click', () => {
    const visible = $('password').type === 'password';
    $('password').type = visible ? 'text' : 'password';
    $('show-password').textContent = visible ? 'Ẩn' : 'Hiện';
    $('show-password').setAttribute('aria-pressed', String(visible));
    $('show-password').setAttribute('aria-label', visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  });
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; showMessage('login-error', '');
    try {
      await api('/hub-api/login', { username: $('username').value.trim(), password: $('password').value });
      $('password').value = '';
      const hash = location.hash;
      const target = /^#session=[0-9a-f-]{36}$/i.test(hash) ? `/api/web-cli/${hash}` : '/';
      location.replace(target);
    }
    catch (error) { showMessage('login-error', error.message); }
    finally { button.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('/hub-api/logout', {}); location.replace('/login'); }
    catch (error) { showMessage('page-error', error.message); }
    finally { $('logout').disabled = false; }
  });
  $('change-password').addEventListener('click', () => { $('password-form').reset(); showMessage('password-message', ''); $('password-dialog').showModal(); });
  $('close-dialog').addEventListener('click', () => $('password-dialog').close());
  $('password-dialog').addEventListener('close', () => $('password-form').reset());
  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault(); showMessage('password-message', '');
    if ($('new-password').value !== $('confirm-password').value) { showMessage('password-message', 'Hai mật khẩu mới chưa trùng nhau.'); return; }
    const button = event.submitter; button.disabled = true;
    try {
      await api('/hub-api/password', { currentPassword: $('current-password').value, newPassword: $('new-password').value });
      $('password-form').reset(); $('password-dialog').close(); $('initial-notice').hidden = false;
      $('initial-notice').textContent = 'Đã đổi mật khẩu. Những phiên đăng nhập trước đã được thu hồi.';
    } catch (error) { showMessage('password-message', error.message); }
    finally { button.disabled = false; }
  });
  window.addEventListener('pageshow', () => { void load(); });
})();
