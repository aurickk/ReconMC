import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';

let refreshInterval = null;
let statusFilter = 'all';

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Servers</h2>
      <button class="btn btn-primary" id="add-servers-btn">+ Add Servers</button>
    </div>

    <div class="card mb-3">
      <div class="flex flex-between" style="align-items: center;">
        <div class="flex flex-gap">
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="all">All</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="online">Online</button>
          <button class="btn btn-sm btn-secondary filter-btn" data-filter="offline">Offline</button>
        </div>
        <div class="flex flex-gap" id="queue-status">
          <span class="text-muted">Loading...</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Status</th>
              <th>Last Scanned</th>
              <th>Scan Count</th>
              <th>Mode</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="servers-table"></tbody>
        </table>
      </div>
    </div>
  `;

  // Filter buttons
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      statusFilter = btn.dataset.filter;
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('btn-primary'));
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.add('btn-secondary'));
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      loadServers();
    });
  });

  // Set active filter
  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.add('btn-primary');
  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.remove('btn-secondary');

  // Add servers button
  document.getElementById('add-servers-btn').addEventListener('click', showAddServersModal);

  await loadServers();
  refreshInterval = setInterval(loadServers, 3000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadServers() {
  try {
    const [servers, queueStatus] = await Promise.all([
      api.getServers(200),
      api.getQueueStatus().catch(() => null),
    ]);

    // Update queue status display
    const statusEl = document.getElementById('queue-status');
    if (statusEl && queueStatus) {
      statusEl.innerHTML = `
        <span class="text-muted">Queue: </span>
        <span class="badge pending">${queueStatus.pending || 0} pending</span>
        <span class="badge processing">${queueStatus.processing || 0} processing</span>
        <span class="text-muted">| Total servers: ${queueStatus.totalServers || 0}</span>
      `;
    }

    const filtered = filterServers(servers, statusFilter);
    const tbody = document.getElementById('servers-table');

    // Check if tbody exists (may not exist during page transitions)
    if (!tbody) {
      return;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No servers found</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(server => {
      const latestResult = server.latestResult;
      const isOnline = latestResult?.ping?.success;
      const serverMode = latestResult?.ping?.serverMode || latestResult?.serverMode || 'unknown';
      const modeIcon = serverMode === 'online' ? '🟢' : serverMode === 'cracked' ? '🔴' : '🟡';

      const lastScanned = server.lastScannedAt
        ? formatRelativeTime(new Date(server.lastScannedAt))
        : 'Never';

      return `
        <tr>
          <td>
            <div style="font-weight: 500;">${escapeHtml(server.serverAddress)}</div>
            ${server.hostname && server.hostname !== server.serverAddress ? `<div class="text-muted"><small>${escapeHtml(server.hostname)}</small></div>` : ''}
            ${server.resolvedIp ? `<div class="text-muted"><small>${escapeHtml(server.resolvedIp)}</small></div>` : ''}
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
          <td>${isOnline ? `${modeIcon} <span class="badge ${serverMode}">${serverMode}</span>` : '-'}</td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-secondary view-btn" data-id="${server.id}">View</button>
            <button class="btn btn-sm btn-danger delete-btn" data-id="${server.id}" data-address="${server.serverAddress}">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = `/servers?id=${btn.dataset.id}`;
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showDeleteConfirmation(btn.dataset.id, btn.dataset.address);
      });
    });
  } catch (error) {
    showToast(`Error loading servers: ${error.message}`, 'error');
  }
}

function filterServers(servers, filter) {
  if (filter === 'all') return servers;
  if (filter === 'online') {
    return servers.filter(s => s.latestResult?.ping?.success);
  }
  if (filter === 'offline') {
    return servers.filter(s => !s.latestResult?.ping?.success && s.scanCount > 0);
  }
  return servers;
}

function showAddServersModal() {
  const body = `
    <div class="form-group">
      <label for="servers-list">Servers (one per line)</label>
      <textarea id="servers-list" class="form-control" rows="10" placeholder="mc.hypixel.net&#10;play.server.com:25567&#10;..."></textarea>
      <small class="text-muted">Format: host or host:port (default port is 25565)</small>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-add">Cancel</button>
    <button class="btn btn-primary" id="submit-add">Add Servers</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Add Servers to Queue',
    body,
    footer,
  });

  overlay.querySelector('#cancel-add').addEventListener('click', closeModal);
  overlay.querySelector('#submit-add').addEventListener('click', async () => {
    const serversText = document.getElementById('servers-list').value.trim();

    if (!serversText) {
      showToast('Please enter at least one server', 'error');
      return;
    }

    const servers = serversText
      .split('\n')
      .map(s => s.trim())
      .filter(s => s);

    try {
      const result = await api.addServers(servers);
      closeModal();
      showToast(`Added ${result.added} servers, skipped ${result.skipped} duplicates`, 'success');
      loadServers();
    } catch (error) {
      showToast(`Error adding servers: ${error.message}`, 'error');
    }
  });
}

function showDeleteConfirmation(serverId, serverAddress) {
  const body = `
    <p>Are you sure you want to delete this server?</p>
    <p><strong>${escapeHtml(serverAddress)}</strong></p>
    <p class="text-error">This action cannot be undone. All scan history for this server will be permanently deleted.</p>
  `;

  const footer = `
    <button class="btn btn-secondary" id="delete-no">Keep Server</button>
    <button class="btn btn-danger" id="delete-yes">Delete Server</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Delete Server',
    body,
    footer,
  });

  overlay.querySelector('#delete-no').addEventListener('click', closeModal);
  overlay.querySelector('#delete-yes').addEventListener('click', async () => {
    try {
      await api.deleteServer(serverId);
      closeModal();
      showToast('Server deleted successfully', 'success');
      loadServers();
    } catch (error) {
      showToast(`Error deleting server: ${error.message}`, 'error');
    }
  });
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
