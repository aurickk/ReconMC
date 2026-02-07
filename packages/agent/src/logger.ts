/**
 * Simple logger that captures console output and sends it to the coordinator
 */
import { AGENT_ID, COORDINATOR_URL } from './config.js';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

let currentTaskId: string | null = null;
let logBuffer: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_SIZE = 50;

// Store original console methods before any interception
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

export function setTaskContext(taskId: string) {
  currentTaskId = taskId;
  logBuffer = [];
  startFlushTimer();
}

export async function clearTaskContext() {
  // Flush logs and wait for them to be sent before clearing context
  await flushLogs();
  currentTaskId = null;
  logBuffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function startFlushTimer() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setInterval(() => {
    if (logBuffer.length > 0) {
      flushLogs();
    }
  }, FLUSH_INTERVAL_MS);
}

async function flushLogs() {
  if (logBuffer.length === 0 || !currentTaskId) return;

  const logsToSend = [...logBuffer];
  logBuffer = [];

  try {
    const base = COORDINATOR_URL.replace(/\/$/, '');
    await fetch(`${base}/api/tasks/${currentTaskId}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: AGENT_ID,
        logs: logsToSend,
      }),
    });
  } catch (err) {
    // If we fail to send logs, just log to original console
    originalConsole.error('[Logger] Failed to send logs:', err);
  }
}

function addLog(level: 'info' | 'warn' | 'error', message: string) {
  // Strip existing level prefixes from message to avoid duplicates like [INFO] [INFO]
  let cleanMessage = String(message).substring(0, 10000); // Limit message size
  const levelPrefix = new RegExp(`^\\[${level.toUpperCase()}\\s*`, 'i');
  cleanMessage = cleanMessage.replace(levelPrefix, '').trim();

  const entry: LogEntry = {
    level,
    message: cleanMessage,
    timestamp: Date.now(),
  };

  logBuffer.push(entry);

  // Also log to original console (not the intercepted one)
  const timestamp = new Date(entry.timestamp).toISOString();
  const originalMethod = level === 'error' ? originalConsole.error : level === 'warn' ? originalConsole.warn : originalConsole.log;
  originalMethod(`[${timestamp}] [${level.toUpperCase()}]`, cleanMessage);

  // Auto-flush if buffer is full
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    flushLogs();
  }
}

export const logger = {
  info: (message: string) => addLog('info', message),
  warn: (message: string) => addLog('warn', message),
  error: (message: string) => addLog('error', message),
};

/**
 * Noise patterns to suppress from logs (third-party library debug output)
 */
const NOISE_PATTERNS = [
  /Chunk size \d+ is \d+ but only \d+ was read/,
  /partial packet/,
  /PartialReadError: Read error for undefined/,
];

/**
 * Check if a message matches known noise patterns
 */
function isNoise(message: string): boolean {
  return NOISE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Convert an argument to a string for logging
 * Handles Error objects gracefully by extracting just the message
 */
function argToString(arg: any): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  if (arg && typeof arg === 'object' && arg.message) return arg.message; // Error-like objects
  if (arg && typeof arg === 'object' && arg.code && arg.message) return `${arg.code}: ${arg.message}`; // System errors
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Intercept console methods to capture logs
 * Suppresses noise from third-party libraries while preserving original console output
 */
export function interceptConsole() {
  console.log = (...args: any[]) => {
    const message = args.map(argToString).join(' ');
    if (!isNoise(message)) {
      addLog('info', message);
    }
    originalConsole.log.apply(console, args);
  };

  console.info = (...args: any[]) => {
    const message = args.map(argToString).join(' ');
    if (!isNoise(message)) {
      addLog('info', message);
    }
    originalConsole.info.apply(console, args);
  };

  console.warn = (...args: any[]) => {
    const message = args.map(argToString).join(' ');
    if (!isNoise(message)) {
      addLog('warn', message);
    }
    originalConsole.warn.apply(console, args);
  };

  console.error = (...args: any[]) => {
    const message = args.map(argToString).join(' ');
    if (!isNoise(message)) {
      addLog('error', message);
    }
    originalConsole.error.apply(console, args);
  };
}
