import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;

export async function render(container) {
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="stat-servers">-</div>
        <div class="stat-label">Total Servers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-pending">-</div>
        <div class="stat-label">Pending Scans</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-processing">-</div>
        <div class="stat-label">Processing</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-agents">-</div>
        <div class="stat-label">Agents Online</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Recent Servers</h2>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Status</th>
              <th>Last Scanned</th>
              <th>Scan Count</th>
            </tr>
          </thead>
          <tbody id="servers-table"></tbody>
        </table>
      </div>
    </div>
  `;

  await loadData();

  refreshInterval = setInterval(loadData, 5000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadData() {
  try {
    const [servers, queueStatus, agents] = await Promise.all([
      api.getServers(10),
      api.getQueueStatus().catch(() => null),
      api.getAgents().catch(() => []),
    ]);

    const totalServers = queueStatus?.totalServers || servers.length || 0;
    const pendingScans = queueStatus?.pending || 0;
    const processingScans = queueStatus?.processing || 0;
    const totalAgents = agents.filter(a => !a.offline).length || 0;
    const idleAgents = agents.filter(a => a.status === 'idle' && !a.offline).length || 0;

    // Check if elements exist (page might have been redirected due to auth error)
    const statServers = document.getElementById('stat-servers');
    const statPending = document.getElementById('stat-pending');
    const statProcessing = document.getElementById('stat-processing');
    const statAgents = document.getElementById('stat-agents');
    const tbody = document.getElementById('servers-table');

    // If any key element is missing, the page was likely redirected - abort
    if (!statServers || !statPending || !statProcessing || !statAgents || !tbody) {
      return;
    }

    statServers.textContent = totalServers;
    statPending.textContent = pendingScans;
    statProcessing.textContent = processingScans;
    statAgents.textContent = `${totalAgents} (${idleAgents} idle)`;

    if (servers.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="text-center text-muted">
            No servers yet. <a href="#batches" style="color: var(--accent)">Add some</a>
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = servers.map(server => {
        const isOnline = server.latestResult?.ping?.success;
        const serverMode = server.latestResult?.ping?.serverMode || server.latestResult?.serverMode || 'unknown';
        const modeIcon = serverMode === 'online' ? '🟢' : serverMode === 'cracked' ? '🔴' : '🟡';

        const lastScanned = server.lastScannedAt
          ? formatRelativeTime(new Date(server.lastScannedAt))
          : 'Never';

        return `
          <tr class="clickable" data-server-id="${server.id}">
            <td>
              <div>${escapeHtml(server.serverAddress)}</div>
              ${isOnline ? `<span class="badge ${serverMode}" style="font-size: 0.7rem;">${modeIcon} ${serverMode}</span>` : ''}
            </td>
            <td>
              ${isOnline
                ? '<span class="badge online">Online</span>'
                : server.scanCount > 0
                  ? '<span class="badge offline">Offline</span>'
                  : '<span class="badge pending">Pending</span>'
              }
            </td>
            <td>${lastScanned}</td>
            <td>${server.scanCount}</td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('tr.clickable').forEach(row => {
        row.addEventListener('click', () => {
          window.location.hash = `/servers?id=${row.dataset.serverId}`;
        });
      });
    }
  } catch (error) {
    showToast(`Error loading dashboard: ${error.message}`, 'error');
  }
}

function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
