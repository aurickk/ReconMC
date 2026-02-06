import { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import type { ScanResult, ConnectResult } from './api.js';
import type { FullScanResult } from './coordinator-api.js';
import { logger } from '../logger.js';

/**
 * View types for the dropdown menu
 */
export type ViewType = 'overview' | 'plugins' | 'players';

/**
 * Minecraft text component type (simplified)
 */
type TextComponent = string | number | boolean | {
  text?: string;
  extra?: TextComponent[];
  translate?: string;
  with?: TextComponent[];
  score?: { name: string };
  selector?: string;
  keybind?: string;
  nbt?: string;
};

/**
 * Parse Minecraft text component to plain text
 */
function parseDescription(description: TextComponent): string {
  // If it's null or undefined, return empty string
  if (description === null || description === undefined) {
    return '';
  }

  // If it's a simple string, return it
  if (typeof description === 'string') {
    return description;
  }

  // If it's a number, convert to string
  if (typeof description === 'number') {
    return String(description);
  }

  // If it's a boolean, convert to string
  if (typeof description === 'boolean') {
    return String(description);
  }

  // If it's a text component object
  if (typeof description === 'object') {
    // Handle arrays (recursive)
    if (Array.isArray(description)) {
      return description.map(item => parseDescription(item)).join('');
    }

    let result = '';

    // Extract text from various properties
    if (description.text) {
      result += description.text;
    }

    // Handle "extra" array (nested components)
    if (description.extra && Array.isArray(description.extra)) {
      for (const extra of description.extra) {
        result += parseDescription(extra);
      }
    }

    // Handle "translate" components
    if (description.translate) {
      result += description.translate;
      // Handle "with" array for translation parameters
      if (description.with && Array.isArray(description.with)) {
        const params = description.with.map((w: TextComponent) => parseDescription(w)).join(', ');
        if (params) {
          result += ` (${params})`;
        }
      }
    }

    // Handle "score" components
    if (description.score && description.score.name) {
      result += description.score.name;
    }

    // Handle "selector" components
    if (description.selector) {
      result += description.selector;
    }

    // Handle "keybind" components
    if (description.keybind) {
      result += description.keybind;
    }

    // Handle "nbt" components
    if (description.nbt) {
      result += description.nbt;
    }

    return result;
  }

  // Fallback for unknown types
  return '';
}

/**
 * Clean Minecraft formatting codes from strings
 */
function cleanFormatting(text: string): string {
  // Remove Minecraft color codes (§)
  let cleaned = text.replace(/§./g, '');

  // Remove other special characters that might cause Discord embed issues
  // Remove null bytes and other control characters except newlines
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  return cleaned;
}

/**
 * Sanitize text for Discord embeds
 */
function sanitizeForEmbed(text: string, maxLength: number = 4000): string {
  // Clean formatting
  let cleaned = cleanFormatting(text);

  // Trim to max length
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength - 3) + '...';
  }

  return cleaned;
}

/**
 * Validate and sanitize field value for Discord embeds
 * Returns null if value is invalid
 */
function validateFieldValue(value: string): string | null {
  if (typeof value !== 'string') {
    value = String(value);
  }
  // Trim and check if empty
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Discord embed field values must be 1-1024 characters
  if (trimmed.length > 1024) {
    return trimmed.substring(0, 1021) + '...';
  }
  return trimmed;
}

/**
 * Validate field name for Discord embeds
 * Returns null if name is invalid
 */
function validateFieldName(name: string): string | null {
  if (typeof name !== 'string') {
    name = String(name);
  }
  // Trim and check if empty
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Discord embed field names must be 1-256 characters
  if (trimmed.length > 256) {
    return trimmed.substring(0, 253) + '...';
  }
  return trimmed;
}

/**
 * Create a Discord embed for scan results
 */
export async function createScanEmbed(result: ScanResult, showPlayerList: boolean = false): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  return await createScanEmbedWithButtons(result, showPlayerList);
}

/**
 * Create a Discord embed for scan results with player list toggle support
 */
export async function createScanEmbedWithButtons(result: ScanResult, showPlayerList: boolean = false): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  logger.debug('[createScanEmbed] Creating embed for result:', {
    success: result.success,
    host: result.host,
    resolvedIp: result.resolvedIp,
    port: result.port,
    hasStatus: !!result.status,
    hasData: !!result.status?.data,
    serverMode: result.serverMode,
    showPlayerList
  });

  const files: AttachmentBuilder[] = [];

  // Build title with both domain and resolved IP if available
  let title = `${result.host}:${result.port}`;
  if (result.resolvedIp && result.resolvedIp !== result.host) {
    title = `${result.host} → ${result.resolvedIp}:${result.port}`;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setTimestamp(new Date(result.timestamp))
    .setFooter({ text: `Attempts: ${result.attempts}` });

  if (result.success && result.status) {
    // Server is online
    embed.setColor(0x00FF00);

    const { data, latency } = result.status;

    // Add Address information field (domain + resolved IP)
    if (result.resolvedIp && result.resolvedIp !== result.host) {
      const addressValue = `**Domain:** ${result.host}\n**IP:** ${result.resolvedIp}`;
      const validatedAddress = validateFieldValue(addressValue);
      const validatedAddressName = validateFieldName('Address');
      if (validatedAddress && validatedAddressName) {
        embed.addFields({
          name: validatedAddressName,
          value: validatedAddress,
          inline: true
        });
        logger.debug('[createScanEmbed] Added address field:', result.host, '->', result.resolvedIp);
      }
    }

    if (data) {
      // Version information
      if (data.version) {
        const versionName = sanitizeForEmbed(String(data.version.name || 'Unknown'), 100);
        const validatedVersion = validateFieldValue(versionName);
        const validatedName = validateFieldName('Version');
        if (validatedVersion && validatedName) {
          embed.addFields({
            name: validatedName,
            value: validatedVersion,
            inline: true
          });
          logger.debug('[createScanEmbed] Added version field:', validatedVersion);
        } else {
          logger.warn('[createScanEmbed] Skipped version field - validation failed');
        }

        // Protocol version
        if (data.version.protocol !== undefined) {
          const protocolValue = String(data.version.protocol);
          const validatedProtocol = validateFieldValue(protocolValue);
          const validatedProtocolName = validateFieldName('Protocol');
          if (validatedProtocol && validatedProtocolName) {
            embed.addFields({
              name: validatedProtocolName,
              value: validatedProtocol,
              inline: true
            });
            logger.debug('[createScanEmbed] Added protocol field:', validatedProtocol);
          }
        }
      }

      // Player count
      if (data.players) {
        const online = Math.max(0, Number(data.players.online) || 0);
        const max = Math.max(0, Number(data.players.max) || 0);
        const playersValue = `${online}/${max}`;
        const validatedPlayers = validateFieldValue(playersValue);
        const validatedName = validateFieldName('Players');
        if (validatedPlayers && validatedName) {
          embed.addFields({
            name: validatedName,
            value: validatedPlayers,
            inline: true
          });
          logger.debug('[createScanEmbed] Added players field:', validatedPlayers);
        } else {
          logger.warn('[createScanEmbed] Skipped players field - validation failed');
        }

        // Server Mode - use from API response if available, otherwise don't show
        if (result.serverMode) {
          const serverModeValue = result.serverMode === 'online' ? '🟢 Online' : result.serverMode === 'cracked' ? '🔴 Cracked' : '🟡 Unknown';
          const validatedServerMode = validateFieldValue(serverModeValue);
          const validatedServerModeName = validateFieldName('Server Mode');
          if (validatedServerMode && validatedServerModeName) {
            embed.addFields({
              name: validatedServerModeName,
              value: validatedServerMode,
              inline: true
            });
            logger.debug('[createScanEmbed] Added server mode field:', serverModeValue);
          }
        }

        // Player sample (list of online players) - only show if showPlayerList is true
        if (showPlayerList && data.players.sample && Array.isArray(data.players.sample) && data.players.sample.length > 0) {
          // Process and validate players - no async UUID validation here, just display
          const playerData = data.players.sample
            .slice(0, 12) // Limit to 12 players
            .map((p: string | { name?: string; username?: string; player_name?: string; id?: string }) => {
              // Handle different player name formats
              if (typeof p === 'string') {
                return { name: p, id: null };
              }
              if (p && typeof p === 'object') {
                // Get name and UUID
                const name = p.name || p.username || p.player_name || null;
                const id = p.id || null;
                return { name, id };
              }
              return { name: null, id: null };
            })
            .filter((player: { name: string | null; id: string | null }) => {
              // Filter out null, undefined, empty strings, and "Anonymous Player"
              return player.name && player.name.trim() !== '' && player.name !== 'Anonymous Player';
            });

          // Create player list with NameMC links (no validation, just links for manual review)
          const samplePlayers = playerData.map((player: { name: string | null; id: string | null }) => {
            const name = player.name ? player.name.replace(/[^\w\-_\s]/g, '').trim() : 'Unknown';
            const indicator = player.id ? '✅' : '❌';

            if (player.id) {
              return `${indicator} [${name}](https://namemc.com/profile/${player.id})`;
            } else {
              return `${indicator} [${name}](https://namemc.com/search?q=${encodeURIComponent(name)})`;
            }
          });

          // Filter out any empty entries
          const validPlayers = samplePlayers.filter((entry: string) => entry.length > 0);

          if (validPlayers.length > 0) {
            const playerList = validPlayers.join('\n');
            const validatedSample = validateFieldValue(playerList);
            const validatedSampleName = validateFieldName(`Online Players (${validPlayers.length}/${data.players.sample.length})`);
            if (validatedSample && validatedSampleName) {
              embed.addFields({
                name: validatedSampleName,
                value: validatedSample,
                inline: false
              });
              logger.debug('[createScanEmbed] Added player sample:', validPlayers.length, 'players');
            }
          } else {
            logger.debug('[createScanEmbed] No valid player names found in sample');
          }
        }
      }

      // Server MOTD
      if (data.description) {
        try {
          const description = parseDescription(data.description);

          // Validate that we got a proper string, not "[object Object]"
          if (description && typeof description === 'string' && description !== '[object Object]') {
            const cleaned = sanitizeForEmbed(description, 4096);
            if (cleaned && cleaned.length > 0) {
              embed.setDescription(cleaned);
              logger.debug('[createScanEmbed] Added description, length:', cleaned.length);
            } else {
              logger.warn('[createScanEmbed] Description was empty after sanitization');
            }
          } else {
            logger.warn('[createScanEmbed] Invalid description format:', typeof description, description);
          }
        } catch (error) {
          logger.error('[createScanEmbed] Error parsing description:', error);
        }
      }

      // Server icon (favicon)
      if (data.favicon) {
        try {
          if (typeof data.favicon === 'string' && data.favicon.startsWith('data:image/')) {
            // Extract the base64 data (after the comma)
            const base64Data = data.favicon.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');

            // Create attachment
            const attachment = new AttachmentBuilder(buffer, { name: 'server-icon.png' });
            files.push(attachment);

            // Set thumbnail to reference the attachment
            embed.setThumbnail('attachment://server-icon.png');
            logger.debug('[createScanEmbed] Added thumbnail as attachment');
          }
        } catch (error) {
          logger.error('[createScanEmbed] Error setting thumbnail:', error);
        }
      }
    }

    // Latency
    if (latency !== null) {
      const latencyValue = `${latency}ms`;
      const validatedLatency = validateFieldValue(latencyValue);
      const validatedName = validateFieldName('Latency');
      if (validatedLatency && validatedName) {
        embed.addFields({
          name: validatedName,
          value: validatedLatency,
          inline: true
        });
        logger.debug('[createScanEmbed] Added latency field:', validatedLatency);
      } else {
        logger.warn('[createScanEmbed] Skipped latency field - validation failed');
      }
    }

    // Status field
    const statusValue = '🟢 Online';
    const validatedStatus = validateFieldValue(statusValue);
    const validatedStatusName = validateFieldName('Status');
    if (validatedStatus && validatedStatusName) {
      embed.addFields({
        name: validatedStatusName,
        value: validatedStatus,
        inline: false
      });
    } else {
      logger.warn('[createScanEmbed] Skipped status field - validation failed');
    }
  } else {
    // Server is offline
    embed.setColor(0xFF0000);
    embed.setDescription('**Server Offline**');

    if (result.error) {
      const sanitizedError = sanitizeForEmbed(result.error, 1000);
      const validatedError = validateFieldValue(sanitizedError);
      const validatedErrorName = validateFieldName('Error');
      if (validatedError && validatedErrorName) {
        embed.addFields({
          name: validatedErrorName,
          value: validatedError,
          inline: false
        });
      }
    }

    // Status field for offline
    const offlineStatusValue = '🔴 Offline';
    const validatedOfflineStatus = validateFieldValue(offlineStatusValue);
    const validatedOfflineStatusName = validateFieldName('Status');
    if (validatedOfflineStatus && validatedOfflineStatusName) {
      embed.addFields({
        name: validatedOfflineStatusName,
        value: validatedOfflineStatus,
        inline: false
      });
    }
  }

  logger.debug('[createScanEmbed] Embed created successfully');

  return { embed, files };
}

/**
 * Create an error embed
 */
export function createErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Error')
    .setDescription(message)
    .setColor(0xFF0000)
    .setTimestamp();
}

/**
 * Create a combined Discord embed for full scan results (ping + connection)
 */
export async function createFullScanResult(
  result: FullScanResult
): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  // First, get the ping embed as a base
  const { embed: pingEmbed, files } = await createScanEmbedWithButtons(result.ping, false);

  // If there's no connection data, return the ping embed as-is
  if (!result.connection) {
    return { embed: pingEmbed, files };
  }

  const conn = result.connection;

  // Add connection section to the embed
  // Add account type
  if (conn.accountType) {
    const accountLabel = conn.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
    try {
      pingEmbed.addFields({
        name: 'Bot Account',
        value: accountLabel,
        inline: true,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  // Server authentication info
  if (conn.serverAuth) {
    const auth = conn.serverAuth;
    if (auth.authRequired) {
      const authStatus = auth.success ? '✅ Success' : '❌ Failed';
      const authTypeLabel = auth.authType === 'register' ? 'Registered' : 'Logged In';
      try {
        pingEmbed.addFields({
          name: 'Server Auth',
          value: `${authStatus} (${authTypeLabel})`,
          inline: true,
        });
      } catch {
        // Ignore if too many fields
      }
    }
  }

  // Bot username
  if (conn.username) {
    try {
      pingEmbed.addFields({
        name: 'Bot Username',
        value: conn.username,
        inline: true,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  // Connection status
  if (conn.success) {
    // Spawn position
    if (conn.spawnPosition) {
      const pos = conn.spawnPosition;
      try {
        pingEmbed.addFields({
          name: 'Spawn Position',
          value: `X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}`,
          inline: true,
        });
      } catch {
        // Ignore if too many fields
      }
    }

    // Server plugins detection
    if (conn.serverPlugins) {
      const plugins = conn.serverPlugins;

      // Show all plugins
      if (plugins.plugins && plugins.plugins.length > 0) {
        const maxToShow = 15;
        const pluginList = plugins.plugins.slice(0, maxToShow);
        const remaining = plugins.plugins.length - maxToShow;

        let pluginsText = pluginList.join(', ');
        if (remaining > 0) {
          pluginsText += `\n... and ${remaining} more`;
        }

        // Indicate detection method
        const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
          : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
          : plugins.method === 'command_tree' ? 'command tree'
          : plugins.method === 'tab_complete' ? 'tab completion'
          : plugins.method === 'combined' ? 'combined'
          : 'none';

        try {
          pingEmbed.addFields({
            name: `Plugins (${plugins.plugins.length}) - ${methodLabel}`,
            value: pluginsText.substring(0, 1024) || 'No plugins detected',
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      } else if (plugins.method === 'none') {
        try {
          pingEmbed.addFields({
            name: 'Plugins',
            value: '⚠️ Could not detect (commands blocked)',
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }
    }

    // Add connection success status
    try {
      pingEmbed.addFields({
        name: 'Bot Connection',
        value: '🟢 Connected',
        inline: false,
      });
    } catch {
      // Ignore if too many fields
    }
  } else {
    // Connection failed - add error details
    if (conn.error) {
      const error = conn.error;

      // Error code
      if (error.code) {
        try {
          pingEmbed.addFields({
            name: 'Connection Error',
            value: `\`${error.code}\`: ${error.message}`,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }

      // Kick reason (if applicable)
      if (error.kicked && error.kickReason) {
        const kickReason = String(error.kickReason).substring(0, 300);
        try {
          pingEmbed.addFields({
            name: 'Kick Reason',
            value: kickReason,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }

      // Provide friendly error messages
      const friendlyMessage = getFriendlyErrorMessage(error.code);
      if (friendlyMessage) {
        try {
          pingEmbed.addFields({
            name: 'Details',
            value: friendlyMessage,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }
    }

    // Add connection failure status
    try {
      pingEmbed.addFields({
        name: 'Bot Connection',
        value: '🔴 Failed',
        inline: false,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  return { embed: pingEmbed, files };
}

/**
 * Create a Discord embed for full scan results (alias for createFullScanResult)
 * Now includes scan duration and select menus for browsing data
 */
export async function createFullScanEmbed(
  result: FullScanResult,
  scanDuration?: number
): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[]; components: ActionRowBuilder<any>[] }> {
  // First, get the ping embed as a base
  const { embed: pingEmbed, files } = await createScanEmbedWithButtons(result.ping, false);

  // Add scan duration to footer if available
  if (scanDuration) {
    const durationText = scanDuration < 1000
      ? `${scanDuration}ms`
      : scanDuration < 60000
        ? `${(scanDuration / 1000).toFixed(1)}s`
        : `${Math.floor(scanDuration / 60000)}m ${Math.round((scanDuration % 60000) / 1000)}s`;
    pingEmbed.setFooter({ text: `⏱️ Scan time: ${durationText} | Attempts: ${result.ping.attempts}` });
  }

  // If there's no connection data, return ping embed with select menus
  if (!result.connection) {
    const components = createSelectMenusForFullScan(result);
    return { embed: pingEmbed, files, components };
  }

  const conn = result.connection;

  // Add connection section to the embed
  // Add account type
  if (conn.accountType) {
    const accountLabel = conn.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
    try {
      pingEmbed.addFields({
        name: 'Bot Account',
        value: accountLabel,
        inline: true,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  // Server authentication info
  if (conn.serverAuth) {
    const auth = conn.serverAuth;
    if (auth.authRequired) {
      const authStatus = auth.success ? '✅ Success' : '❌ Failed';
      const authTypeLabel = auth.authType === 'register' ? 'Registered' : 'Logged In';
      try {
        pingEmbed.addFields({
          name: 'Server Auth',
          value: `${authStatus} (${authTypeLabel})`,
          inline: true,
        });
      } catch {
        // Ignore if too many fields
      }
    }
  }

  // Bot username
  if (conn.username) {
    try {
      pingEmbed.addFields({
        name: 'Bot Username',
        value: conn.username,
        inline: true,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  // Connection status
  if (conn.success) {
    // Spawn position
    if (conn.spawnPosition) {
      const pos = conn.spawnPosition;
      try {
        pingEmbed.addFields({
          name: 'Spawn Position',
          value: `X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}`,
          inline: true,
        });
      } catch {
        // Ignore if too many fields
      }
    }

    // Server plugins detection
    if (conn.serverPlugins) {
      const plugins = conn.serverPlugins;

      // Show plugin summary (truncated with indicator to use select menu)
      if (plugins.plugins && plugins.plugins.length > 0) {
        const pluginCount = plugins.plugins.length;
        const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
          : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
          : plugins.method === 'command_tree' ? 'command tree'
          : plugins.method === 'tab_complete' ? 'tab completion'
          : plugins.method === 'combined' ? 'combined'
          : 'unknown';

        const summary = pluginCount > 10
          ? `${pluginCount} plugins detected. Use the select menu below to view all.`
          : plugins.plugins.join(', ');

        try {
          pingEmbed.addFields({
            name: `Plugins (${pluginCount}) - ${methodLabel}`,
            value: summary.substring(0, 1024) || 'No plugins detected',
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      } else if (plugins.method === 'none') {
        try {
          pingEmbed.addFields({
            name: 'Plugins',
            value: '⚠️ Could not detect (commands blocked)',
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }
    }

    // Add connection success status
    try {
      pingEmbed.addFields({
        name: 'Bot Connection',
        value: '🟢 Connected',
        inline: false,
      });
    } catch {
      // Ignore if too many fields
    }
  } else {
    // Connection failed - add error details
    if (conn.error) {
      const error = conn.error;

      // Error code
      if (error.code) {
        try {
          pingEmbed.addFields({
            name: 'Connection Error',
            value: `\`${error.code}\`: ${error.message}`,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }

      // Kick reason (if applicable)
      if (error.kicked && error.kickReason) {
        const kickReason = String(error.kickReason).substring(0, 300);
        try {
          pingEmbed.addFields({
            name: 'Kick Reason',
            value: kickReason,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }

      // Provide friendly error messages
      const friendlyMessage = getFriendlyErrorMessage(error.code);
      if (friendlyMessage) {
        try {
          pingEmbed.addFields({
            name: 'Details',
            value: friendlyMessage,
            inline: false,
          });
        } catch {
          // Ignore if too many fields
        }
      }
    }

    // Add connection failure status
    try {
      pingEmbed.addFields({
        name: 'Bot Connection',
        value: '🔴 Failed',
        inline: false,
      });
    } catch {
      // Ignore if too many fields
    }
  }

  // Create select menus
  const components = createSelectMenusForFullScan(result);

  return { embed: pingEmbed, files, components };
}

/**
 * Create select menus for full scan results (single dropdown for view switching)
 */
function createSelectMenusForFullScan(
  result: FullScanResult
): ActionRowBuilder<any>[] {
  return createViewSelectMenu(result, 'overview');
}

/**
 * Create a single select menu for switching between views
 * Exported so buttonHandler can also use this
 */
export function createViewSelectMenu(
  result: FullScanResult,
  currentView: ViewType = 'overview'
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('view_selector')
    .setPlaceholder('📋 Select a view...');

  // Always add Overview option
  selectMenu.addOptions(
    new StringSelectMenuOptionBuilder()
      .setLabel('📊 Overview')
      .setValue('overview')
      .setDescription('View the main scan overview')
  );

  // Add Players option if player data is available
  const hasPlayers = result.ping?.success &&
    result.ping.status?.data?.players?.sample &&
    Array.isArray(result.ping.status.data.players.sample) &&
    result.ping.status.data.players.sample.length > 0;

  if (hasPlayers) {
    const playerCount = result.ping.status?.data?.players?.sample?.length || 0;
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(`👥 Players (${playerCount})`)
        .setValue('players')
        .setDescription(`View all ${playerCount} players`)
    );
  }

  // Add Plugins option if plugin data is available
  const pluginCount = result.connection?.serverPlugins?.plugins?.length || 0;
  if (pluginCount > 0) {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(`🔌 Plugins (${pluginCount})`)
        .setValue('plugins')
        .setDescription(`View all ${pluginCount} plugins`)
    );
  }

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)];
}

/**
 * Create a Discord embed for bot connection results
 */
export function createConnectEmbed(
  host: string,
  port: number,
  result: ConnectResult,
  isFullScan: boolean = false
): { embed: EmbedBuilder } {
  const embed = new EmbedBuilder()
    .setTitle(isFullScan ? `Full Scan: ${host}:${port}` : `Bot Connection: ${host}:${port}`)
    .setTimestamp();

  if (result.success) {
    // Connection successful
    embed.setColor(0x00FF00);

    // Add account type
    if (result.accountType) {
      const accountLabel = result.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
      embed.addFields({
        name: 'Account Type',
        value: accountLabel,
        inline: true,
      });
    }

    // Server authentication info (for cracked servers)
    if (result.serverAuth) {
      const auth = result.serverAuth;
      if (auth.authRequired) {
        const authStatus = auth.success ? '✅ Success' : '❌ Failed';
        const authTypeLabel = auth.authType === 'register' ? 'Registered' : 'Logged In';
        embed.addFields({
          name: 'Server Auth',
          value: `${authStatus} (${authTypeLabel})`,
          inline: true,
        });
      } else {
        embed.addFields({
          name: 'Server Auth',
          value: '⚪ Not Required',
          inline: true,
        });
      }
    }

    // Add fields
    if (result.username) {
      embed.addFields({
        name: 'Username',
        value: result.username,
        inline: true,
      });
    }

    if (result.uuid) {
      embed.addFields({
        name: 'UUID',
        value: `\`${result.uuid}\``,
        inline: true,
      });
    }

    if (result.spawnPosition) {
      const pos = result.spawnPosition;
      embed.addFields({
        name: 'Spawn Position',
        value: `X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}`,
        inline: true,
      });
    }

    if (result.latency) {
      embed.addFields({
        name: 'Latency',
        value: `${result.latency}ms`,
        inline: true,
      });
    }

    if (result.connectedAt) {
      embed.addFields({
        name: 'Connected At',
        value: new Date(result.connectedAt).toLocaleString(),
        inline: false,
      });
    }

    // Server plugins detection
    if (result.serverPlugins) {
      const plugins = result.serverPlugins;

      // Show all plugins in one list
      if (plugins.plugins && plugins.plugins.length > 0) {
        // Show first 20 plugins, indicate if more
        const maxToShow = 20;
        const pluginList = plugins.plugins.slice(0, maxToShow);
        const remaining = plugins.plugins.length - maxToShow;

        let pluginsText = pluginList.join(', ');
        if (remaining > 0) {
          pluginsText += `\n... and ${remaining} more`;
        }

        // Indicate detection method
        const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
          : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
          : plugins.method === 'command_tree' ? 'command tree'
          : plugins.method === 'tab_complete' ? 'tab completion'
          : plugins.method === 'combined' ? 'command tree + tab completion'
          : 'none';

        embed.addFields({
          name: `Server Plugins (${plugins.plugins.length}) - via ${methodLabel}`,
          value: pluginsText.substring(0, 1024) || 'No plugins detected',
          inline: false,
        });
      } else if (plugins.method === 'none') {
        embed.addFields({
          name: 'Server Plugins',
          value: '⚠️ Could not detect plugins (commands may be blocked)',
          inline: false,
        });
      }
    }

    embed.addFields({
      name: 'Status',
      value: '🟢 Connected Successfully',
      inline: false,
    });

    embed.setFooter({ text: `Attempts: ${result.attempts}` });
  } else {
    // Connection failed
    embed.setColor(0xFF0000);
    embed.setDescription('**Connection Failed**');

    // Add account type
    if (result.accountType) {
      const accountLabel = result.accountType === 'microsoft' ? '🟢 Microsoft' : '🔴 Cracked';
      embed.addFields({
        name: 'Account Type',
        value: accountLabel,
        inline: true,
      });
    }

    if (result.username) {
      embed.addFields({
        name: 'Username',
        value: result.username,
        inline: true,
      });
    }

    if (result.error) {
      const error = result.error;

      // Error code
      if (error.code) {
        embed.addFields({
          name: 'Error Code',
          value: `\`${error.code}\``,
          inline: true,
        });
      }

      // Error message
      if (error.message) {
        embed.addFields({
          name: 'Error',
          value: error.message,
          inline: false,
        });
      }

      // Kick reason (if applicable)
      if (error.kicked && error.kickReason) {
        const kickReason = String(error.kickReason).substring(0, 200);
        embed.addFields({
          name: 'Kick Reason',
          value: kickReason,
          inline: false,
        });
      }

      // Provide friendly error messages
      const friendlyMessage = getFriendlyErrorMessage(error.code);
      if (friendlyMessage) {
        embed.addFields({
          name: 'Details',
          value: friendlyMessage,
          inline: false,
        });
      }
    }

    embed.addFields({
      name: 'Status',
      value: '🔴 Connection Failed',
      inline: false,
    });

    embed.setFooter({ text: `Attempts: ${result.attempts}` });
  }

  return { embed };
}

/**
 * Get a friendly error message for common error codes
 */
function getFriendlyErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    'ECONNREFUSED': 'The server refused the connection. It may be offline or blocking connections.',
    'ETIMEDOUT': 'Connection timed out. The server took too long to respond.',
    'KICKED_WHITELIST': 'The server is whitelisted. You need to be added to the whitelist to join.',
    'KICKED_BANNED': 'The account has been banned from this server.',
    'KICKED_FULL': 'The server is full. Try again when there are fewer players online.',
    'KICKED': 'The bot was kicked from the server. See the kick reason for details.',
    'AUTH_FAILED': 'Authentication failed. The account credentials may be invalid.',
    'PROXY_ERROR': 'Failed to connect through the proxy. Check your proxy configuration.',
    'TOKEN_INVALID': 'The access token is invalid or has expired. Refresh the token and try again.',
    'DISCONNECTED': 'The connection was closed unexpectedly.',
  };

  return messages[code] || '';
}
