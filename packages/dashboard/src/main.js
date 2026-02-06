import { canAccessApp, isAuthenticated } from './auth.js';
import { renderHeader } from './components/header.js';

// Import pages
import * as loginPage from './pages/login.js';
import * as dashboardPage from './pages/dashboard.js';
import * as batchesPage from './pages/batches.js';
import * as resultsPage from './pages/results.js';
import * as agentsPage from './pages/agents.js';
import * as accountsPage from './pages/accounts.js';
import * as proxiesPage from './pages/proxies.js';

const routes = {
  '/login': loginPage,
  '/': dashboardPage,
  '/batches': batchesPage,
  '/results': resultsPage,
  '/agents': agentsPage,
  '/accounts': accountsPage,
  '/proxies': proxiesPage,
};

let currentPage = null;
let currentCleanup = null;

function getHashPath() {
  const hash = window.location.hash.slice(1) || '/';
  const [path, queryString] = hash.split('?');
  return path;
}

function navigate(path) {
  window.location.hash = path;
}

async function render() {
  const path = getHashPath();

  // Check if user can access the app (authenticated or auth disabled)
  const hasAccess = await canAccessApp();

  // If trying to access login page and auth is disabled, redirect to dashboard
  if (path === '/login' && hasAccess) {
    window.location.hash = '/';
    return;
  }

  // If trying to access protected route without access, redirect to login
  if (path !== '/login' && !hasAccess) {
    window.location.hash = '/login';
    return;
  }

  const page = routes[path] || routes['/'];

  // Cleanup previous page
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  const app = document.getElementById('app');
  app.innerHTML = '';

  // Don't render header on login page
  if (path !== '/login') {
    const header = renderHeader(navigate, path);
    app.appendChild(header);
  }

  // Render main content
  const main = document.createElement('main');
  main.className = path === '/login' ? 'login-main' : 'main';
  app.appendChild(main);

  // Render page
  try {
    await page.render(main);
    currentCleanup = page.cleanup || (() => {});
  } catch (error) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <h3>Error Loading Page</h3>
        <p>${error.message}</p>
      </div>
    `;
  }
}

// Handle hash changes
window.addEventListener('hashchange', render);

// Initial render
render();
