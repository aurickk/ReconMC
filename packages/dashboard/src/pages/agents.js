import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Agents</h2>
      <span class="text-muted">Auto-refreshes every 3 seconds</span>
    </div>

    <div class="stats-grid mb-3">
      <div class="stat-card">
        <div class="stat-value" id="stat-total">-</div>
        <div class="stat-label">Total Agents</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-online">-</div>
        <div class="stat-label">Online</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-busy">-</div>
        <div class="stat-label">Busy</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-idle">-</div>
        <div class="stat-label">Idle</div>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Current Task</th>
              <th>Last Heartbeat</th>
            </tr>
          </thead>
          <tbody id="agents-table"></tbody>
        </table>
      </div>
    </div>
  `;

  await loadAgents();
  refreshInterval = setInterval(loadAgents, 3000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadAgents() {
  try {
    const agents = await api.getAgents();
    // Filter to only show online agents (idle or busy) - offline agents are removed from DB
    const onlineAgents = agents.filter(a => !a.offline);

    const total = onlineAgents.length || 0;
    const busy = onlineAgents.filter(a => a.status === 'busy').length || 0;
    const idle = onlineAgents.filter(a => a.status === 'idle').length || 0;

    // Check if elements exist (page might have been redirected due to auth error)
    const statTotal = document.getElementById('stat-total');
    const statOnline = document.getElementById('stat-online');
    const statBusy = document.getElementById('stat-busy');
    const statIdle = document.getElementById('stat-idle');
    const tbody = document.getElementById('agents-table');

    // If any key element is missing, the page was likely redirected - abort
    if (!statTotal || !statOnline || !statBusy || !statIdle || !tbody) {
      return;
    }

    statTotal.textContent = total;
    statOnline.textContent = total;
    statBusy.textContent = busy;
    statIdle.textContent = idle;

    if (onlineAgents.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="text-center text-muted">No agents connected</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = onlineAgents.map(agent => {
      const statusClass = agent.status === 'busy' ? 'busy' : 'idle';
      const statusLabel = agent.status;

      const lastSeen = agent.lastHeartbeat
        ? `${Math.round((Date.now() - new Date(agent.lastHeartbeat).getTime()) / 1000)}s ago`
        : 'never';

      const displayName = agent.name || agent.id;
      const showId = agent.name ? `<small class="text-muted">(${agent.id.substring(0, 12)}...)</small>` : '';

      return `
        <tr>
          <td>${displayName}${showId ? ' ' + showId : ''}</td>
          <td><span class="badge ${statusClass}">${statusLabel}</span></td>
          <td>${agent.currentTaskId ? `<code>${agent.currentTaskId.substring(0, 8)}...</code>` : '-'}</td>
          <td class="text-muted">${lastSeen}</td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    showToast(`Error loading agents: ${error.message}`, 'error');
  }
}
