import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let refreshInterval = null;
let logRefreshInterval = null;
let currentBatchId = null;
let selectedTaskIndex = 0;
let tasks = [];
let agents = [];
let showPlayerList = {};
let currentLogs = [];
let logsAutoScroll = true;
let currentBatch = null;

/**
 * Get friendly agent name from ID
 * @param {string} agentId - The agent ID (e.g., "agent-1")
 * @returns {string} - Friendly name (e.g., "Agent 1") or a shortened ID if not found
 */
function getAgentDisplayName(agentId) {
  const agent = agents.find(a => a.id === agentId);
  if (agent?.name) return agent.name;

  // For old agents not in the list, show a shortened version
  // e.g., "agent-20c682f48ec4" → "agent..." or "agent-1" if it's a new-style ID
  if (agentId.startsWith('agent-')) {
    const suffix = agentId.slice(6);
    // If it's just a number (new-style ID like "agent-1"), show "Agent 1"
    if (/^\d+$/.test(suffix)) {
      return `Agent ${suffix}`;
    }
    // For old-style hashes, just show "agent..." to indicate it was an agent
    return 'agent...';
  }
  return agentId;
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration (e.g., "2.3s", "1m 15s", "45ms")
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '-';

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  } else if (ms < 60000) {
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
}

/**
 * Calculate task duration from timestamps
 * @param {Object} task - Task object with createdAt, startedAt, completedAt
 * @returns {number} - Duration in milliseconds, or null if not available
 */
function getTaskDuration(task) {
  if (task.completedAt && task.startedAt) {
    return new Date(task.completedAt) - new Date(task.startedAt);
  } else if (task.completedAt && task.createdAt) {
    return new Date(task.completedAt) - new Date(task.createdAt);
  } else if (task.startedAt && task.status === 'processing') {
    return Date.now() - new Date(task.startedAt);
  }
  return null;
}

/**
 * Calculate total batch duration
 * @param {Object} batch - Batch object with createdAt and completedAt
 * @returns {number} - Duration in milliseconds, or null if not completed
 */
function getBatchDuration(batch) {
  if (!batch) return null;
  if (batch.completedAt && batch.createdAt) {
    return new Date(batch.completedAt) - new Date(batch.createdAt);
  } else if (batch.createdAt && batch.status !== 'completed') {
    return Date.now() - new Date(batch.createdAt);
  }
  return null;
}

/**
 * Parse Minecraft text component to plain text
 */
function parseDescription(description) {
  if (description === null || description === undefined) {
    return '';
  }

  if (typeof description === 'string') {
    return description;
  }

  if (typeof description === 'number' || typeof description === 'boolean') {
    return String(description);
  }

  if (typeof description === 'object') {
    if (Array.isArray(description)) {
      return description.map(item => parseDescription(item)).join('');
    }

    let result = '';

    if (description.text) {
      result += description.text;
    }

    if (description.extra && Array.isArray(description.extra)) {
      for (const extra of description.extra) {
        result += parseDescription(extra);
      }
    }

    if (description.translate) {
      result += description.translate;
      if (description.with && Array.isArray(description.with)) {
        const params = description.with.map(w => parseDescription(w)).join(', ');
        if (params) {
          result += ` (${params})`;
        }
      }
    }

    if (description.score && description.score.name) {
      result += description.score.name;
    }

    if (description.selector) {
      result += description.selector;
    }

    if (description.keybind) {
      result += description.keybind;
    }

    if (description.nbt) {
      result += description.nbt;
    }

    return result;
  }

  return '';
}

/**
 * Clean Minecraft formatting codes from strings
 */
function cleanFormatting(text) {
  let cleaned = text.replace(/§./g, '');
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned;
}

/**
 * Minecraft color code mappings (§ codes)
 */
const MC_COLORS = {
  '0': '#000000', // Black
  '1': '#0000AA', // Dark Blue
  '2': '#00AA00', // Dark Green
  '3': '#00AAAA', // Dark Aqua
  '4': '#AA0000', // Dark Red
  '5': '#AA00AA', // Dark Purple
  '6': '#FFAA00', // Gold
  '7': '#AAAAAA', // Gray
  '8': '#555555', // Dark Gray
  '9': '#5555FF', // Blue
  'a': '#55FF55', // Green
  'b': '#55FFFF', // Aqua
  'c': '#FF5555', // Red
  'd': '#FF55FF', // Light Purple
  'e': '#FFFF55', // Yellow
  'f': '#FFFFFF', // White
};

/**
 * Minecraft named color mappings (JSON text component)
 */
const MC_NAMED_COLORS = {
  'black': '#000000',
  'dark_blue': '#0000AA',
  'dark_green': '#00AA00',
  'dark_aqua': '#00AAAA',
  'dark_red': '#AA0000',
  'dark_purple': '#AA00AA',
  'gold': '#FFAA00',
  'gray': '#AAAAAA',
  'dark_gray': '#555555',
  'blue': '#5555FF',
  'green': '#55FF55',
  'aqua': '#55FFFF',
  'red': '#FF5555',
  'light_purple': '#FF55FF',
  'yellow': '#FFFF55',
  'white': '#FFFFFF',
};

/**
 * Character width categories for obfuscation
 */
const CHAR_SIZES = {
  THIN: "!i|,.".split(""),
  MID: "Ilt'".split(""),
  WIDE: "\"#$%&()*+-/0123456789<=>?@aAbBcCdDeEfFgGhHjJkKLmMnNoOpPqQrRsSTuUvVwWxXyYzZ{}~".split("")
};

/**
 * Obfuscate text by scrambling characters based on their width
 */
function obfuscateText(text) {
  const result = [];
  for (const char of text) {
    if (CHAR_SIZES.WIDE.includes(char)) {
      result.push(CHAR_SIZES.WIDE[Math.floor(Math.random() * CHAR_SIZES.WIDE.length)]);
    } else if (CHAR_SIZES.MID.includes(char)) {
      result.push(CHAR_SIZES.MID[Math.floor(Math.random() * CHAR_SIZES.MID.length)]);
    } else if (CHAR_SIZES.THIN.includes(char)) {
      result.push(CHAR_SIZES.THIN[Math.floor(Math.random() * CHAR_SIZES.THIN.length)]);
    } else {
      result.push(char);
    }
  }
  return result.join("");
}

/**
 * Update all obfuscated text elements
 */
function updateObfuscatedText() {
  document.querySelectorAll('.mc-obfuscated').forEach(el => {
    // Check if element is still connected to DOM
    if (!el.isConnected) return;

    const original = el.dataset.original;
    if (original) {
      // Decode the URI-encoded original text
      const decoded = decodeURIComponent(original);
      // Obfuscate and set as text content (textContent is safe from XSS)
      el.textContent = obfuscateText(decoded);
    }
  });
}

// Start the obfuscation animation loop
let obfuscationInterval = null;
function startObfuscationAnimation() {
  if (obfuscationInterval) return;
  obfuscationInterval = setInterval(updateObfuscatedText, 80);
}

function stopObfuscationAnimation() {
  if (obfuscationInterval) {
    clearInterval(obfuscationInterval);
    obfuscationInterval = null;
  }
}

/**
 * Named color to CSS class mapping
 */
const MC_NAMED_COLOR_CLASSES = {
  'black': 'mc-black',
  'dark_blue': 'mc-dark-blue',
  'dark_green': 'mc-dark_green',
  'dark_aqua': 'mc-dark_aqua',
  'dark_red': 'mc-dark_red',
  'dark_purple': 'mc-dark_purple',
  'gold': 'mc-gold',
  'gray': 'mc-gray',
  'dark_gray': 'mc-dark_gray',
  'blue': 'mc-blue',
  'green': 'mc-green',
  'aqua': 'mc-aqua',
  'red': 'mc-red',
  'light_purple': 'mc-light_purple',
  'yellow': 'mc-yellow',
  'white': 'mc-white',
};

/**
 * Convert a JSON text component to formatted HTML
 */
function formatJsonTextComponent(component, inheritedStyles = {}) {
  if (!component) return '';

  if (typeof component === 'string') {
    return formatTextWithStyles(component, inheritedStyles);
  }

  if (Array.isArray(component)) {
    return component.map(c => formatJsonTextComponent(c, inheritedStyles)).join('');
  }

  if (typeof component === 'object') {
    // Build styles for this component
    const styles = { ...inheritedStyles };

    if (component.color) {
      // Use CSS class if it's a named color, otherwise use inline style
      const colorClass = MC_NAMED_COLOR_CLASSES[component.color];
      if (colorClass) {
        styles.colorClass = colorClass;
      } else {
        styles.color = MC_NAMED_COLORS[component.color] || component.color;
      }
    }
    if (component.bold) styles.bold = true;
    if (component.italic) styles.italic = true;
    if (component.underlined) styles.underline = true;
    if (component.strikethrough) styles.strikethrough = true;
    if (component.obfuscated) styles.obfuscated = true;

    let result = '';

    // Handle the main text
    if (component.text !== undefined) {
      result += formatTextWithStyles(String(component.text), styles);
    }

    // Handle translate
    if (component.translate) {
      result += formatTextWithStyles(component.translate, styles);
    }

    // Handle extra components (inherit styles)
    if (component.extra && Array.isArray(component.extra)) {
      for (const extra of component.extra) {
        result += formatJsonTextComponent(extra, styles);
      }
    }

    return result;
  }

  return '';
}

/**
 * Format text with given style object
 * Also handles § codes that may be embedded in JSON component text
 */
function formatTextWithStyles(text, styles) {
  if (!text) return '';

  // If the text contains § codes, we need to process them
  // The inherited JSON styles will be applied as a wrapper
  if (text.includes('§')) {
    const innerHtml = formatSectionCodesOnly(text);
    
    // Build wrapper styles from inherited JSON styles
    const cssStyles = [];
    const cssClasses = [];
    
    if (styles.colorClass) cssClasses.push(styles.colorClass);
    else if (styles.color) cssStyles.push(`color:${styles.color}`);
    if (styles.bold) cssClasses.push('mc-bold');
    if (styles.italic) cssClasses.push('mc-italic');
    if (styles.underline) cssClasses.push('mc-underline');
    if (styles.strikethrough) cssClasses.push('mc-strikethrough');
    if (styles.obfuscated) cssClasses.push('mc-obfuscated');
    
    if (cssStyles.length > 0 || cssClasses.length > 0) {
      const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
      const classAttr = cssClasses.length > 0 ? ` class="${cssClasses.join(' ')}"` : '';
      return `<span${classAttr}${styleAttr}>${innerHtml}</span>`;
    }
    return innerHtml;
  }

  // No § codes - simple text with inherited styles
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');

  const cssStyles = [];
  const cssClasses = [];
  const dataAttrs = [];

  if (styles.colorClass) {
    cssClasses.push(styles.colorClass);
  } else if (styles.color) {
    cssStyles.push(`color:${styles.color}`);
  }

  if (styles.bold) cssClasses.push('mc-bold');
  if (styles.italic) cssClasses.push('mc-italic');
  if (styles.underline) cssClasses.push('mc-underline');
  if (styles.strikethrough) cssClasses.push('mc-strikethrough');
  if (styles.obfuscated) {
    cssClasses.push('mc-obfuscated');
    // Use encodeURIComponent to safely store the raw text
    dataAttrs.push(`data-original="${encodeURIComponent(text)}"`);
    escaped = obfuscateText(text);
  }

  if (cssStyles.length > 0 || cssClasses.length > 0) {
    const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
    const classAttr = cssClasses.length > 0 ? ` class="${cssClasses.join(' ')}"` : '';
    const dataAttr = dataAttrs.length > 0 ? ` ${dataAttrs.join(' ')}` : '';
    return `<span${classAttr}${styleAttr}${dataAttr}>${escaped}</span>`;
  }

  return escaped;
}

/**
 * Format § codes only (used by formatTextWithStyles when text contains § codes)
 */
function formatSectionCodesOnly(text) {
  if (!text) return '';

  const result = [];
  let currentClasses = [];
  let currentText = '';
  let isObfuscated = false;

  function flushSpan() {
    if (currentText || currentClasses.length > 0) {
      const classAttr = currentClasses.length > 0 ? ` class="${currentClasses.join(' ')}"` : '';
      let dataAttr = '';
      let displayText;
      if (isObfuscated) {
        // Use encodeURIComponent to safely store the raw text
        dataAttr = ` data-original="${encodeURIComponent(currentText)}"`;
        displayText = obfuscateText(currentText);
      } else {
        displayText = escapeHtml(currentText);
      }
      result.push(`<span${classAttr}${dataAttr}>${displayText}</span>`);
    }
    currentText = '';
    currentClasses = [];
    isObfuscated = false;
  }

  let i = 0;
  while (i < text.length) {
    // Check for § character
    if (text[i] === '§' && i + 1 < text.length) {
      // Flush current span before formatting change
      if (currentText || currentClasses.length > 0) {
        flushSpan();
      }

      const code = text[i + 1].toLowerCase();

      if (MC_COLOR_CLASSES[code]) {
        currentClasses.push(MC_COLOR_CLASSES[code]);
        i += 2;
        continue;
      } else if (code === 'l') {
        currentClasses.push('mc-bold');
        i += 2;
        continue;
      } else if (code === 'm') {
        currentClasses.push('mc-strikethrough');
        i += 2;
        continue;
      } else if (code === 'n') {
        currentClasses.push('mc-underline');
        i += 2;
        continue;
      } else if (code === 'o') {
        currentClasses.push('mc-italic');
        i += 2;
        continue;
      } else if (code === 'k') {
        currentClasses.push('mc-obfuscated');
        isObfuscated = true;
        i += 2;
        continue;
      } else if (code === 'r') {
        // Reset - flush current span and start fresh
        flushSpan();
        i += 2;
        continue;
      }
    }

    // Handle newlines
    if (text[i] === '\n' || (text[i] === '\\' && text[i + 1] === 'n')) {
      currentText += '\n';
      i += (text[i] === '\\') ? 2 : 1;
      continue;
    }

    currentText += text[i];
    i++;
  }

  // Flush any remaining text
  flushSpan();

  // Convert newlines to <br> in the final result
  return result.join('').replace(/\n/g, '<br>');
}

/**
 * Minecraft color code to CSS class mapping
 */
const MC_COLOR_CLASSES = {
  '0': 'mc-black',
  '1': 'mc-dark-blue',
  '2': 'mc-dark_green',
  '3': 'mc-dark_aqua',
  '4': 'mc-dark_red',
  '5': 'mc-dark_purple',
  '6': 'mc-gold',
  '7': 'mc-gray',
  '8': 'mc-dark_gray',
  '9': 'mc-blue',
  'a': 'mc-green',
  'b': 'mc-aqua',
  'c': 'mc-red',
  'd': 'mc-light_purple',
  'e': 'mc-yellow',
  'f': 'mc-white',
};

/**
 * Convert Minecraft § formatting codes to HTML
 */
function formatSectionCodes(text) {
  if (!text || typeof text !== 'string') return escapeHtml(String(text || ''));

  const result = [];
  let currentClasses = [];
  let currentDataAttrs = [];
  let currentText = '';
  let isObfuscated = false;

  function flushSpan() {
    if (currentText || currentClasses.length > 0) {
      const classAttr = currentClasses.length > 0 ? ` class="${currentClasses.join(' ')}"` : '';
      let dataAttr = '';
      let displayText;
      if (isObfuscated) {
        // Use encodeURIComponent to safely store the raw text
        dataAttr = ` data-original="${encodeURIComponent(currentText)}"`;
        displayText = obfuscateText(currentText);
      } else {
        displayText = escapeHtml(currentText);
      }
      result.push(`<span${classAttr}${dataAttr}>${displayText}</span>`);
    }
    currentText = '';
    currentClasses = [];
    currentDataAttrs = [];
    isObfuscated = false;
  }

  let i = 0;
  while (i < text.length) {
    // Check for § character
    if (text[i] === '§' && i + 1 < text.length) {
      // Flush current span before formatting change
      if (currentText || currentClasses.length > 0) {
        flushSpan();
      }

      const code = text[i + 1].toLowerCase();

      if (MC_COLOR_CLASSES[code]) {
        currentClasses.push(MC_COLOR_CLASSES[code]);
        i += 2;
        continue;
      } else if (code === 'l') {
        currentClasses.push('mc-bold');
        i += 2;
        continue;
      } else if (code === 'm') {
        currentClasses.push('mc-strikethrough');
        i += 2;
        continue;
      } else if (code === 'n') {
        currentClasses.push('mc-underline');
        i += 2;
        continue;
      } else if (code === 'o') {
        currentClasses.push('mc-italic');
        i += 2;
        continue;
      } else if (code === 'k') {
        currentClasses.push('mc-obfuscated');
        isObfuscated = true;
        i += 2;
        continue;
      } else if (code === 'r') {
        // Reset - flush current span and start fresh
        flushSpan();
        i += 2;
        continue;
      }
    }

    // Handle newlines
    if (text[i] === '\n' || (text[i] === '\\' && text[i + 1] === 'n')) {
      currentText += '\n';
      i += (text[i] === '\\') ? 2 : 1;
      continue;
    }

    currentText += text[i];
    i++;
  }

  // Flush any remaining text
  flushSpan();

  // Convert newlines to <br> in the final result
  return result.join('').replace(/\n/g, '<br>');
}

/**
 * Main function to format Minecraft text (handles both JSON and § codes)
 */
function formatMinecraftText(text) {
  if (!text) return '';
  
  // If it's already an object (parsed JSON), format directly
  if (typeof text === 'object') {
    return formatJsonTextComponent(text);
  }
  
  if (typeof text !== 'string') {
    return escapeHtml(String(text));
  }
  
  // Try to detect and parse JSON text component
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return formatJsonTextComponent(parsed);
    } catch (e) {
      // Not valid JSON, treat as plain text with § codes
    }
  }
  
  // Check if the text contains § codes
  if (text.includes('§')) {
    return formatSectionCodes(text);
  }
  
  // Plain text - just escape and handle newlines
  return escapeHtml(text).replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
}

/**
 * Sanitize text for display
 */
function sanitizeText(text, maxLength = 4000) {
  let cleaned = cleanFormatting(text);
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength - 3) + '...';
  }
  return cleaned;
}

export async function render(container) {
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  currentBatchId = params.get('id');

  if (!currentBatchId) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>No Batch Selected</h3>
        <p>Please select a batch from the <a href="#batches" style="color: var(--accent)">Batches</a> page.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="flex flex-between mb-3">
      <div>
        <h2>Scan Results</h2>
        <div class="text-muted" style="font-size: 0.9rem;">
          Total time: <span id="batch-duration">-</span>
        </div>
      </div>
      <div>
        <button class="btn btn-secondary" id="export-btn">Export JSON</button>
        <button class="btn btn-secondary" id="back-btn">Back to Batches</button>
      </div>
    </div>

    <div class="flex flex-gap" style="align-items: flex-start;">
      <div class="card" style="flex: 1; max-width: 400px;">
        <div class="card-header">
          <h3 class="card-title">Tasks</h3>
        </div>
        <div id="task-list" class="task-list"></div>
      </div>

      <div class="card" style="flex: 2;">
        <div class="card-header">
          <h3 class="card-title">Task Details</h3>
        </div>
        <div id="task-detail"></div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-header flex flex-between">
        <h3 class="card-title">Agent Logs</h3>
        <div class="flex flex-gap">
          <label class="flex flex-gap" style="align-items: center; font-size: 0.85rem;">
            <input type="checkbox" id="logs-autoscroll" checked>
            Auto-scroll
          </label>
          <button class="btn btn-sm btn-secondary" id="refresh-logs">Refresh</button>
        </div>
      </div>
      <div id="logs-container" class="logs-container"></div>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    window.location.hash = '/batches';
  });

  document.getElementById('export-btn').addEventListener('click', exportResults);

  // Logs panel event listeners
  document.getElementById('logs-autoscroll').addEventListener('change', (e) => {
    logsAutoScroll = e.target.checked;
  });
  document.getElementById('refresh-logs').addEventListener('click', loadLogs);

  await loadResults();
  refreshInterval = setInterval(loadResults, 3000);
  await loadLogs();
  logRefreshInterval = setInterval(loadLogs, 5000);

  // Start the obfuscation animation for Minecraft text
  startObfuscationAnimation();
}

export function cleanup() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (logRefreshInterval) {
    clearInterval(logRefreshInterval);
    logRefreshInterval = null;
  }
  stopObfuscationAnimation();
  currentBatchId = null;
  currentBatch = null;
  selectedTaskIndex = 0;
  tasks = [];
  showPlayerList = {};
  currentLogs = [];
  logsAutoScroll = true;
}

async function loadResults() {
  try {
    const data = await api.getBatchResults(currentBatchId);
    tasks = data.tasks || [];
    currentBatch = data.batch;

    // Load agents for friendly name display
    try {
      agents = await api.getAgents();
    } catch {
      // Ignore if agents endpoint fails
      agents = [];
    }

    const taskList = document.getElementById('task-list');
    const taskDetail = document.getElementById('task-detail');

    // Check if elements exist (may not during page transitions)
    if (!taskList || !taskDetail) {
      return;
    }

    // Update batch duration display (only if elements exist)
    const batchDurationEl = document.getElementById('batch-duration');
    if (batchDurationEl && currentBatch) {
      const batchDuration = getBatchDuration(currentBatch);
      const batchDurationText = batchDuration ? formatDuration(batchDuration) : 'In progress...';
      batchDurationEl.textContent = batchDurationText;
    }

    if (tasks.length === 0) {
      taskList.innerHTML = '<p class="text-center text-muted">No tasks yet</p>';
      taskDetail.innerHTML = '<p class="text-center text-muted">Select a task to view details</p>';
      return;
    }

    taskList.innerHTML = tasks.map((task, index) => {
      const statusIcon = task.status === 'completed' ? '✓'
        : task.status === 'processing' ? '⟳'
        : task.status === 'failed' ? '✗'
        : task.status === 'cancelled' ? '⊘'
        : '○';

      const ping = task.result?.ping;
      const isOnline = ping?.success;
      const taskDuration = getTaskDuration(task);
      const durationText = taskDuration ? formatDuration(taskDuration) : '-';

      return `
        <div class="task-item${index === selectedTaskIndex ? ' active' : ''}" data-index="${index}">
          <div class="task-header">
            <span class="task-address">${task.serverAddress}:${task.port}</span>
            <span class="badge ${task.status}">${statusIcon} ${task.status}</span>
          </div>
          <div class="task-meta">
            ${task.assignedAgentId ? `
              <span class="task-agent text-muted">
                <small>${escapeHtml(getAgentDisplayName(task.assignedAgentId))}</small>
              </span>
            ` : ''}
            <span class="task-duration text-muted">
              <small>${durationText}</small>
            </span>
          </div>
          ${task.status === 'cancelled' ? `
            <div class="task-info">
              <span class="text-muted">● Cancelled</span>
            </div>
          ` : isOnline ? `
            <div class="task-info">
              <span class="text-success">● Online</span>
              ${ping?.serverMode ? `<span class="badge ${ping.serverMode}">${ping.serverMode}</span>` : ''}
            </div>
          ` : task.status === 'completed' ? `
            <div class="task-info">
              <span class="text-error">● Offline</span>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    taskList.querySelectorAll('.task-item').forEach(item => {
      item.addEventListener('click', () => {
        selectedTaskIndex = parseInt(item.dataset.index);
        taskList.querySelectorAll('.task-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        showTaskDetail();
        loadLogs();
      });
    });

    showTaskDetail();
  } catch (error) {
    showToast(`Error loading results: ${error.message}`, 'error');
  }
}

function showTaskDetail() {
  const task = tasks[selectedTaskIndex];
  if (!task) return;

  const detail = document.getElementById('task-detail');
  if (!detail) return;

  // Initialize player list toggle state for this task
  if (!(task.id in showPlayerList)) {
    showPlayerList[task.id] = false;
  }

  const ping = task.result?.ping;
  const connection = task.result?.connection;

  let html = `
    <div class="detail-section">
      <div class="detail-label">Server</div>
      <div class="detail-value">
        <code>${task.serverAddress}:${task.port}</code>
        ${ping?.resolvedIp && ping.resolvedIp !== task.serverAddress ? `
          <span class="text-muted">→ ${ping.resolvedIp}</span>
        ` : ''}
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-label">Status</div>
      <div class="detail-value">
        <span class="badge ${task.status}">${task.status}</span>
      </div>
    </div>
    ${task.assignedAgentId ? `
    <div class="detail-section">
      <div class="detail-label">Agent</div>
      <div class="detail-value"><code>${escapeHtml(getAgentDisplayName(task.assignedAgentId))}</code></div>
    </div>
    ` : ''}
  `;

  if (task.errorMessage) {
    html += `
      <div class="detail-section error-section">
        <div class="detail-label">Error</div>
        <div class="detail-value text-error">
          <div class="error-message mc-text">${formatMinecraftText(task.errorMessage)}</div>
        </div>
      </div>
    `;
  }

  // Display ping result
  if (ping) {
    const data = ping.status?.data;

    // Server icon
    if (data?.favicon) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Server Icon</div>
          <div class="detail-value">
            <img src="${data.favicon}" alt="Server Icon" style="width: 64px; height: 64px; image-rendering: pixelated;" />
          </div>
        </div>
      `;
    }

    // Server mode
    if (ping.serverMode) {
      const modeIcon = ping.serverMode === 'online' ? '🟢' : ping.serverMode === 'cracked' ? '🔴' : '🟡';
      html += `
        <div class="detail-section">
          <div class="detail-label">Server Mode</div>
          <div class="detail-value">
            ${modeIcon} ${ping.serverMode.charAt(0).toUpperCase() + ping.serverMode.slice(1)}
          </div>
        </div>
      `;
    }

    // MOTD/Description
    if (data?.description) {
      const motdHtml = formatMinecraftText(data.description);
      if (motdHtml) {
        html += `
          <div class="detail-section">
            <div class="detail-label">MOTD</div>
            <div class="detail-value motd-display">${motdHtml}</div>
          </div>
        `;
      }
    }

    // Version
    if (data?.version) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Version</div>
          <div class="detail-value">
            ${data.version.name || 'Unknown'} <span class="text-muted">(protocol ${data.version.protocol || '?'})</span>
          </div>
        </div>
      `;
    }

    // Players
    if (data?.players) {
      const online = Math.max(0, Number(data.players.online) || 0);
      const max = Math.max(0, Number(data.players.max) || 0);
      const sample = data.players.sample;

      html += `
        <div class="detail-section">
          <div class="detail-label">Players</div>
          <div class="detail-value">
            <strong>${online}</strong> / ${max}
            ${sample && sample.length > 0 ? `
              <button class="btn btn-sm btn-secondary ml-2" id="toggle-players">
                ${showPlayerList[task.id] ? 'Hide' : 'Show'} Players (${sample.length})
              </button>
            ` : ''}
          </div>
          ${showPlayerList[task.id] && sample && sample.length > 0 ? `
            <div class="player-list mt-2">
              ${sample.map(p => {
                const name = p.name || p.username || 'Unknown';
                const id = p.id;

                const isValidUUID = id &&
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
                  !id.startsWith('00000000');

                const nameMcUrl = isValidUUID
                  ? `https://namemc.com/profile/${id.replace(/-/g, '')}`
                  : `https://namemc.com/search?q=${encodeURIComponent(name)}`;

                return `
                  <div class="player-item">
                    ${isValidUUID ? '✅' : '❌'}
                    <a href="${nameMcUrl}" target="_blank" rel="noopener">${escapeHtml(name)}</a>
                    ${id ? `
                      <code class="uuid-code" title="Click to copy" data-uuid="${escapeHtml(id)}">${escapeHtml(id)}</code>
                    ` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // Latency
    if (ping.status?.latency !== null && ping.status?.latency !== undefined) {
      html += `
        <div class="detail-section">
          <div class="detail-label">Latency</div>
          <div class="detail-value">${ping.status.latency}ms</div>
        </div>
      `;
    }

    // Ping status
    html += `
      <div class="detail-section">
        <div class="detail-label">Ping Status</div>
        <div class="detail-value">
          ${ping.success ? '<span class="text-success">● Online</span>' : '<span class="text-error">● Offline</span>'}
        </div>
      </div>
    `;
  }

  // Display connection result
  if (connection) {
    html += `
      <div class="detail-section">
        <div class="detail-label">Connection</div>
        <div class="detail-value">
          ${connection.success ? '<span class="text-success">● Connected</span>' : '<span class="text-error">● Failed</span>'}
        </div>
      </div>
    `;

    if (connection.success) {
      if (connection.username) {
        html += `
          <div class="detail-section">
            <div class="detail-label">Username</div>
            <div class="detail-value">${connection.username}</div>
          </div>
        `;
      }

      if (connection.uuid) {
        html += `
          <div class="detail-section">
            <div class="detail-label">UUID</div>
            <div class="detail-value"><code>${connection.uuid}</code></div>
          </div>
        `;
      }

      if (connection.accountType) {
        const accountLabel = connection.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
        html += `
          <div class="detail-section">
            <div class="detail-label">Account Type</div>
            <div class="detail-value">${accountLabel}</div>
          </div>
        `;
      }

      if (connection.serverAuth) {
        const auth = connection.serverAuth;
        if (auth.authRequired) {
          const authStatus = auth.success ? '✅ Success' : '❌ Failed';
          const authTypeLabel = auth.authType === 'register' ? 'Registered' : 'Logged In';
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Auth</div>
              <div class="detail-value">${authStatus} (${authTypeLabel})</div>
            </div>
          `;
        } else {
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Auth</div>
              <div class="detail-value">⚪ Not Required</div>
            </div>
          `;
        }
      }

      if (connection.spawnPosition) {
        const pos = connection.spawnPosition;
        html += `
          <div class="detail-section">
            <div class="detail-label">Spawn Position</div>
            <div class="detail-value">X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}</div>
          </div>
        `;
      }

      if (connection.serverPlugins) {
        const plugins = connection.serverPlugins;

        if (plugins.plugins && plugins.plugins.length > 0) {
          const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
            : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
            : plugins.method === 'command_tree' ? 'command tree'
            : plugins.method === 'tab_complete' ? 'tab completion'
            : plugins.method === 'combined' ? 'command tree + tab completion'
            : 'unknown';

          html += `
            <div class="detail-section">
              <div class="detail-label">Plugins (${plugins.plugins.length}) - via ${methodLabel}</div>
              <div class="detail-value">
                ${plugins.plugins.map(p => `<span class="badge pending">${p}</span>`).join(' ')}
              </div>
            </div>
          `;
        } else if (plugins.method === 'none') {
          html += `
            <div class="detail-section">
              <div class="detail-label">Plugins</div>
              <div class="detail-value text-muted">⚠️ Could not detect plugins (commands may be blocked)</div>
            </div>
          `;
        }
      }

      if (connection.connectedAt) {
        html += `
          <div class="detail-section">
            <div class="detail-label">Connected At</div>
            <div class="detail-value">${new Date(connection.connectedAt).toLocaleString()}</div>
          </div>
        `;
      }
    } else {
      if (connection.error) {
        // Show error code
        html += `
          <div class="detail-section">
            <div class="detail-label">Connection Error</div>
            <div class="detail-value text-error">
              <code>${connection.error.code || 'UNKNOWN'}</code>
            </div>
          </div>
        `;
        
        // If kicked, show the server's kick message (not the generic error message)
        if (connection.error.kicked && connection.error.kickReason) {
          html += `
            <div class="detail-section">
              <div class="detail-label">Server Message</div>
              <div class="detail-value mc-text">
                ${formatMinecraftText(connection.error.kickReason)}
              </div>
            </div>
          `;
        } else if (connection.error.message) {
          // Not kicked - show the error message
          html += `
            <div class="detail-section">
              <div class="detail-label">Error Message</div>
              <div class="detail-value mc-text">
                ${formatMinecraftText(connection.error.message)}
              </div>
            </div>
          `;
        }
      }
    }
  }

  // No result data message
  if (!ping && !connection && !task.errorMessage && (task.status === 'completed' || task.status === 'cancelled')) {
    const message = task.status === 'cancelled'
      ? 'This task was cancelled before completion.'
      : 'No scan result data available';
    html += `
      <div class="detail-section">
        <div class="text-muted">${message}</div>
      </div>
    `;
  }

  detail.innerHTML = html;

  // Add event listener for player list toggle
  const toggleBtn = document.getElementById('toggle-players');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      showPlayerList[task.id] = !showPlayerList[task.id];
      showTaskDetail();
    });
  }

  // Copy UUID to clipboard on click
  detail.querySelectorAll('.uuid-code').forEach(el => {
    el.addEventListener('click', () => {
      const uuid = el.dataset.uuid;
      if (uuid && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(uuid).then(() => showToast('UUID copied to clipboard', 'success'));
      }
    });
  });
}

function exportResults() {
  const data = {
    batchId: currentBatchId,
    tasks: tasks,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reconmc-${currentBatchId.substring(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('Results exported', 'success');
}

async function loadLogs() {
  const task = tasks[selectedTaskIndex];
  if (!task) {
    renderLogs([]);
    return;
  }

  try {
    const logs = await api.getTaskLogs(task.id, 100);
    // Reverse to show newest at bottom
    currentLogs = logs.reverse();
    renderLogs(currentLogs);
  } catch (error) {
    // Silently fail for log loading - don't show toast for every failed log fetch
  }
}

function renderLogs(logs) {
  const container = document.getElementById('logs-container');
  if (!container) return;

  if (logs.length === 0) {
    container.innerHTML = '<div class="text-muted text-center p-3">No logs available for this task</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const levelClass = log.level === 'error' ? 'text-error' : log.level === 'warn' ? 'text-warning' : '';
    const time = new Date(log.timestamp).toLocaleTimeString();
    return `<div class="log-entry ${levelClass}"><span class="log-time">${time}</span> ${log.agentId ? `<span class="log-agent">[${escapeHtml(log.agentId)}]</span>` : ''} <span class="log-level">[${log.level.toUpperCase()}]</span> <span class="log-message">${escapeHtml(log.message)}</span></div>`;
  }).join('\n');

  if (logsAutoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
