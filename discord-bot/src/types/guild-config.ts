/**
 * Guild configuration stored in SQLite
 */
export interface GuildConfig {
  /** Discord guild ID */
  guildId: string;
  /** Coordinator API URL */
  coordinatorUrl: string;
  /** API key for coordinator authentication */
  apiKey: string;
  /** Array of channel IDs where commands are allowed */
  allowedChannels: string[];
  /** Optional dashboard URL for scan result links */
  dashboardUrl: string | null;
  /** ISO timestamp of when config was created */
  createdAt: string;
  /** ISO timestamp of when config was last updated */
  updatedAt: string;
}

/**
 * Data structure for the setup modal form
 */
export interface SetupModalData {
  /** Coordinator API URL from modal input */
  coordinatorUrl: string;
  /** API key from modal input */
  apiKey: string;
  /** Comma-separated channel IDs from modal input */
  allowedChannels: string;
  /** Optional dashboard URL from modal input */
  dashboardUrl?: string;
}
