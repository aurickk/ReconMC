import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;

export async function render(container) {
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="stat-batches">-</div>
        <div class="stat-label">Total Batches</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-processing">-</div>
        <div class="stat-label">Processing</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-agents">-</div>
        <div class="stat-label">Agents Online</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-idle">-</div>
        <div class="stat-label">Idle Agents</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Recent Batches</h2>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="batches-table"></tbody>
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
    const [batches, agents] = await Promise.all([
      api.getBatches(),
      api.getAgents(),
    ]);

    const totalBatches = batches.length || 0;
    const processingBatches = batches.filter(b => b.status === 'processing').length || 0;
    const totalAgents = agents.filter(a => !a.offline).length || 0;
    const idleAgents = agents.filter(a => a.status === 'idle' && !a.offline).length || 0;

    // Check if elements exist (page might have been redirected due to auth error)
    const statBatches = document.getElementById('stat-batches');
    const statProcessing = document.getElementById('stat-processing');
    const statAgents = document.getElementById('stat-agents');
    const statIdle = document.getElementById('stat-idle');
    const tbody = document.getElementById('batches-table');

    // If any key element is missing, the page was likely redirected - abort
    if (!statBatches || !statProcessing || !statAgents || !statIdle || !tbody) {
      return;
    }

    statBatches.textContent = totalBatches;
    statProcessing.textContent = processingBatches;
    statAgents.textContent = totalAgents;
    statIdle.textContent = idleAgents;

    const recentBatches = batches.slice(0, 10);

    if (recentBatches.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center text-muted">
            No batches yet. <a href="#batches" style="color: var(--accent)">Create one</a>
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = recentBatches.map(batch => {
        const progress = batch.completedTasks && batch.totalTasks
          ? `${batch.completedTasks}/${batch.totalTasks}`
          : '-';
        const progressPercent = batch.totalTasks
          ? (batch.completedTasks / batch.totalTasks) * 100
          : 0;

        return `
          <tr class="clickable" data-batch-id="${batch.id}">
            <td><code>${batch.id.substring(0, 8)}...</code></td>
            <td>${batch.name || '-'}</td>
            <td><span class="badge ${batch.status}">${batch.status}</span></td>
            <td>
              ${progress !== '-' ? `
                <div class="flex flex-between">
                  <span>${progress}</span>
                  <span class="text-muted">${progressPercent.toFixed(0)}%</span>
                </div>
                <div class="progress-bar mt-1">
                  <div class="progress-fill" style="width: ${progressPercent}%"></div>
                </div>
              ` : '-'}
            </td>
            <td>${new Date(batch.createdAt).toLocaleString()}</td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('tr.clickable').forEach(row => {
        row.addEventListener('click', () => {
          window.location.hash = `/results?id=${row.dataset.batchId}`;
        });
      });
    }
  } catch (error) {
    showToast(`Error loading dashboard: ${error.message}`, 'error');
  }
}
