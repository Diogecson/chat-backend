// Layout comum pra todas páginas (exceto login) — injeta topbar + sidebar e trata auth
(function() {
  const token = localStorage.getItem('chat_backend_token');
  const userRaw = localStorage.getItem('chat_backend_user');
  if (!token) { location.href = '/login.html'; return; }

  let user = {};
  try { user = JSON.parse(userRaw || '{}'); } catch(_) {}
  const nav = [
    { href: '/',          label: 'Dashboard', icon: '🏠' },
    { href: '/disparos.html', label: 'Disparos',  icon: '📢' },
    { href: '/contas.html',   label: 'Contas',    icon: '📱' },
    { href: '/campanhas.html',label: 'Campanhas', icon: '📋' },
  ];
  const current = location.pathname === '/' || location.pathname === '/index.html' ? '/' : location.pathname;

  const topbar = `
    <div class="topbar">
      <div class="brand">ChatBackend</div>
      <div class="user">
        <span>${user.usuario || 'admin'}</span>
        <button onclick="logout()">Sair</button>
      </div>
    </div>`;

  const sidebar = `
    <nav class="sidebar">
      ${nav.map(n => `<a href="${n.href}" class="${current === n.href ? 'active' : ''}"><span style="margin-right:8px">${n.icon}</span>${n.label}</a>`).join('')}
    </nav>`;

  // Wrap content: pega qualquer coisa em #page e envelopa
  const page = document.getElementById('page');
  if (!page) return;
  const html = page.innerHTML;
  page.remove();
  document.body.innerHTML = `
    <div class="app">
      ${topbar}
      <div class="main">
        ${sidebar}
        <main class="content" id="main">${html}</main>
      </div>
    </div>`;

  window.logout = function() {
    localStorage.removeItem('chat_backend_token');
    localStorage.removeItem('chat_backend_user');
    location.href = '/login.html';
  };

  window.apiFetch = async function(path, opts = {}) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(path, opts);
    if (r.status === 401) { logout(); throw new Error('Não autenticado'); }
    return r.json();
  };
})();
