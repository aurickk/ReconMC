import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { GuildConfig } from '../types/guild-config.js';

/**
 * Service for managing guild configuration in SQLite
 * Uses WAL mode for better performance and in-memory caching
 */
class GuildConfigService {
  private db: Database.Database | null = null;
  private cache: Map<string, GuildConfig> = new Map();
  private dbPath: string;

  constructor() {
    // Store database in data/ directory relative to package root
    this.dbPath = path.join(process.cwd(), 'data', 'guild_config.db');
  }

  /**
   * Initialize the database connection and create schema
   */
  private init(): void {
    if (this.db) return;

    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better performance
    this.db.pragma('journal_mode = WAL');

    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        coordinator_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        allowed_channels TEXT NOT NULL DEFAULT '[]',
        dashboard_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Get configuration for a guild
   * @param guildId - Discord guild ID
   * @returns GuildConfig or null if not configured
   */
  getConfig(guildId: string): GuildConfig | null {
    // Check cache first
    const cached = this.cache.get(guildId);
    if (cached) return cached;

    this.init();

    const stmt = this.db!.prepare(`
      SELECT guild_id, coordinator_url, api_key, allowed_channels, dashboard_url, created_at, updated_at
      FROM guild_config
      WHERE guild_id = ?
    `);

    const row = stmt.get(guildId) as {
      guild_id: string;
      coordinator_url: string;
      api_key: string;
      allowed_channels: string;
      dashboard_url: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    const config: GuildConfig = {
      guildId: row.guild_id,
      coordinatorUrl: row.coordinator_url,
      apiKey: row.api_key,
      allowedChannels: JSON.parse(row.allowed_channels) as string[],
      dashboardUrl: row.dashboard_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Cache the result
    this.cache.set(guildId, config);

    return config;
  }

  /**
   * Save or update configuration for a guild
   * @param config - Guild configuration to save
   */
  saveConfig(config: Omit<GuildConfig, 'createdAt' | 'updatedAt'>): void {
    this.init();

    const now = new Date().toISOString();
    const allowedChannelsJson = JSON.stringify(config.allowedChannels);

    const stmt = this.db!.prepare(`
      INSERT INTO guild_config (guild_id, coordinator_url, api_key, allowed_channels, dashboard_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        coordinator_url = excluded.coordinator_url,
        api_key = excluded.api_key,
        allowed_channels = excluded.allowed_channels,
        dashboard_url = excluded.dashboard_url,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      config.guildId,
      config.coordinatorUrl,
      config.apiKey,
      allowedChannelsJson,
      config.dashboardUrl ?? null,
      now,
      now
    );

    // Update cache
    const fullConfig: GuildConfig = {
      ...config,
      dashboardUrl: config.dashboardUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(config.guildId, fullConfig);
  }

  /**
   * Delete configuration for a guild
   * @param guildId - Discord guild ID
   * @returns true if config was deleted, false if it didn't exist
   */
  deleteConfig(guildId: string): boolean {
    this.init();

    const stmt = this.db!.prepare('DELETE FROM guild_config WHERE guild_id = ?');
    const result = stmt.run(guildId);

    // Remove from cache
    this.cache.delete(guildId);

    return result.changes > 0;
  }

  /**
   * Check if a guild has configuration
   * @param guildId - Discord guild ID
   */
  hasConfig(guildId: string): boolean {
    return this.getConfig(guildId) !== null;
  }

  /**
   * Clear the in-memory cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.cache.clear();
  }
}

// Export singleton instance
export const guildConfigService = new GuildConfigService();
