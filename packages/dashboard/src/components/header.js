import { removeApiKey, maskApiKey, getApiKey } from '../auth.js';

export function renderHeader(navigate, currentPath) {
  const navItems = [
    { path: '/', label: 'Dashboard' },
    { path: '/batches', label: 'Batches' },
    { path: '/results', label: 'Results' },
    { path: '/agents', label: 'Agents' },
    { path: '/accounts', label: 'Accounts' },
    { path: '/proxies', label: 'Proxies' },
  ];

  const header = document.createElement('header');
  header.className = 'header';

  header.innerHTML = `
    <h1>ReconMC</h1>
    <nav class="header-nav">
      ${navItems.map(item => `
        <button class="nav-link${currentPath === item.path ? ' active' : ''}" data-path="${item.path}">
          ${item.label}
        </button>
      `).join('')}
    </nav>
    <div class="header-actions">
      <span class="api-key-display" title="${getApiKey() || ''}">${maskApiKey(getApiKey() || '')}</span>
      <button class="btn btn-secondary btn-sm" id="logoutBtn">Sign Out</button>
    </div>
  `;

  header.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.path);
    });
  });

  // Handle logout
  const logoutBtn = header.querySelector('#logoutBtn');
  logoutBtn.addEventListener('click', () => {
    removeApiKey();
    window.location.hash = '/login';
  });

  return header;
}
