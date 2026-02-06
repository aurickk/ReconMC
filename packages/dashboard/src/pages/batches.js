import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';

let refreshInterval = null;
let statusFilter = 'all';

export async function render(container) {
  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <h2>Batches</h2>
      <button class="btn btn-primary" id="create-batch-btn">+ New Batch</button>
    </div>

    <div class="card mb-3">
      <div class="flex flex-gap">
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="all">All</button>
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="pending">Pending</button>
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="processing">Processing</button>
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="completed">Completed</button>
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="cancelled">Cancelled</button>
        <button class="btn btn-sm btn-secondary filter-btn" data-filter="failed">Failed</button>
      </div>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="batches-table"></tbody>
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
      loadBatches();
    });
  });

  // Set active filter
  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.add('btn-primary');
  container.querySelector(`[data-filter="${statusFilter}"]`)?.classList.remove('btn-secondary');

  // Create batch button
  document.getElementById('create-batch-btn').addEventListener('click', showCreateBatchModal);

  await loadBatches();
  refreshInterval = setInterval(loadBatches, 3000);
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function loadBatches() {
  try {
    const batches = await api.getBatches();

    const filtered = statusFilter === 'all'
      ? batches
      : batches.filter(b => b.status === statusFilter);

    const tbody = document.getElementById('batches-table');

    // Check if tbody exists (may not exist during page transitions)
    if (!tbody) {
      return;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No batches found</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(batch => {
      const progress = batch.completedTasks && batch.totalTasks
        ? `${batch.completedTasks}/${batch.totalTasks}`
        : '-';
      const progressPercent = batch.totalTasks
        ? (batch.completedTasks / batch.totalTasks) * 100
        : 0;

      // Determine which actions to show based on status
      const canCancel = batch.status === 'pending' || batch.status === 'processing';
      const canDelete = batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled';

      return `
        <tr>
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
          <td class="actions-cell">
            <button class="btn btn-sm btn-secondary view-btn" data-id="${batch.id}">View</button>
            ${canCancel ? `<button class="btn btn-sm btn-warning cancel-btn" data-id="${batch.id}" data-name="${batch.name || batch.id}">Cancel</button>` : ''}
            ${canDelete ? `<button class="btn btn-sm btn-danger delete-btn" data-id="${batch.id}" data-name="${batch.name || batch.id}">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = `/results?id=${btn.dataset.id}`;
      });
    });

    tbody.querySelectorAll('.cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showCancelConfirmation(btn.dataset.id, btn.dataset.name);
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showDeleteConfirmation(btn.dataset.id, btn.dataset.name);
      });
    });
  } catch (error) {
    showToast(`Error loading batches: ${error.message}`, 'error');
  }
}

function showCreateBatchModal() {
  const body = `
    <div class="form-group">
      <label for="batch-name">Batch Name (optional)</label>
      <input type="text" id="batch-name" class="form-control" placeholder="My scan batch">
    </div>
    <div class="form-group">
      <label for="batch-servers">Servers (one per line)</label>
      <textarea id="batch-servers" class="form-control" placeholder="mc.hypixel.net&#10;play.server.com&#10;..."></textarea>
      <small class="text-muted">Format: host or host:port (default port is 25565)</small>
    </div>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-batch">Cancel</button>
    <button class="btn btn-primary" id="submit-batch">Create Batch</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Create New Batch',
    body,
    footer,
  });

  overlay.querySelector('#cancel-batch').addEventListener('click', closeModal);
  overlay.querySelector('#submit-batch').addEventListener('click', async () => {
    const name = document.getElementById('batch-name').value.trim();
    const serversText = document.getElementById('batch-servers').value.trim();

    if (!serversText) {
      showToast('Please enter at least one server', 'error');
      return;
    }

    const servers = serversText
      .split('\n')
      .map(s => s.trim())
      .filter(s => s);

    try {
      const batch = await api.createBatch(servers, name || undefined);
      closeModal();
      showToast('Batch created successfully', 'success');
      loadBatches();
    } catch (error) {
      showToast(`Error creating batch: ${error.message}`, 'error');
    }
  });
}

function showCancelConfirmation(batchId, batchName) {
  const body = `
    <p>Are you sure you want to cancel this batch?</p>
    <p><strong>${batchName}</strong></p>
    <p class="text-muted">This will stop processing and mark all pending tasks as cancelled.</p>
  `;

  const footer = `
    <button class="btn btn-secondary" id="cancel-no">Keep Processing</button>
    <button class="btn btn-warning" id="cancel-yes">Cancel Batch</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Cancel Batch',
    body,
    footer,
  });

  overlay.querySelector('#cancel-no').addEventListener('click', closeModal);
  overlay.querySelector('#cancel-yes').addEventListener('click', async () => {
    try {
      await api.cancelBatch(batchId);
      closeModal();
      showToast('Batch cancelled successfully', 'success');
      loadBatches();
    } catch (error) {
      showToast(`Error cancelling batch: ${error.message}`, 'error');
    }
  });
}

function showDeleteConfirmation(batchId, batchName) {
  const body = `
    <p>Are you sure you want to delete this batch?</p>
    <p><strong>${batchName}</strong></p>
    <p class="text-error">This action cannot be undone. All scan results for this batch will be permanently deleted.</p>
  `;

  const footer = `
    <button class="btn btn-secondary" id="delete-no">Keep Batch</button>
    <button class="btn btn-danger" id="delete-yes">Delete Batch</button>
  `;

  const { closeModal, overlay } = showModal({
    title: 'Delete Batch',
    body,
    footer,
  });

  overlay.querySelector('#delete-no').addEventListener('click', closeModal);
  overlay.querySelector('#delete-yes').addEventListener('click', async () => {
    try {
      await api.deleteBatch(batchId);
      closeModal();
      showToast('Batch deleted successfully', 'success');
      loadBatches();
    } catch (error) {
      showToast(`Error deleting batch: ${error.message}`, 'error');
    }
  });
}
