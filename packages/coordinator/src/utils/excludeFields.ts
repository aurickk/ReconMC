import { getTableColumns } from 'drizzle-orm';
import { servers } from '../db/schema.js';

/**
 * Allowlisted tokens for the `exclude` query parameter.
 * - Top-level tokens map to SQL columns (skipped at query time).
 * - Dotted tokens (e.g. "latestResult.plugins") are stripped post-query.
 */
const COLUMN_ALLOWLIST = new Set(['scanHistory']);
const LATEST_RESULT_KEY_ALLOWLIST = new Set(['plugins', 'players', 'connection', 'icon']);

export interface ExcludeConfig {
  excludeColumns: Set<string>;
  excludeLatestResultKeys: Set<string>;
}

/**
 * Parse a comma-separated `exclude` param string.
 * Unknown tokens are silently ignored (forward-compatible).
 */
export function parseExcludeParam(raw: string | undefined): ExcludeConfig {
  const excludeColumns = new Set<string>();
  const excludeLatestResultKeys = new Set<string>();

  if (!raw) return { excludeColumns, excludeLatestResultKeys };

  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) continue;

    if (COLUMN_ALLOWLIST.has(t)) {
      excludeColumns.add(t);
    } else if (t.startsWith('latestResult.')) {
      const key = t.slice('latestResult.'.length);
      if (LATEST_RESULT_KEY_ALLOWLIST.has(key)) {
        excludeLatestResultKeys.add(key);
      }
    }
    // Unknown tokens silently ignored
  }

  return { excludeColumns, excludeLatestResultKeys };
}

/**
 * Build a column selection object that excludes specified columns.
 * Returns `undefined` if nothing to exclude (caller uses `db.select()` as normal).
 */
export function buildSelectColumns(excludeColumns: Set<string>) {
  if (excludeColumns.size === 0) return undefined;

  const allColumns = getTableColumns(servers);
  const selected: Record<string, any> = {};

  for (const [key, col] of Object.entries(allColumns)) {
    if (!excludeColumns.has(key)) {
      selected[key] = col;
    }
  }

  return selected;
}

/**
 * Shallow-copy server objects with specified `latestResult` sub-fields removed.
 * Returns original array unchanged if no keys to exclude.
 */
export function stripLatestResultFields<T extends { latestResult?: any }>(
  serverList: T[],
  excludeKeys: Set<string>,
): T[] {
  if (excludeKeys.size === 0) return serverList;

  return serverList.map((server) => {
    if (!server.latestResult || typeof server.latestResult !== 'object') {
      return server;
    }
    const lr = { ...server.latestResult };
    for (const key of excludeKeys) {
      delete lr[key];
    }
    return { ...server, latestResult: lr };
  });
}
