import { ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, StringSelectMenuInteraction, EmbedBuilder } from 'discord.js';
import type { ScanResult } from '../utils/api.js';
import type { FullScanResult } from '../utils/coordinator-api.js';
import { createFullScanEmbed, createViewSelectMenu, type ViewType } from '../utils/embeds.js';
import { logger } from '../logger.js';

// TTL for scan results (15 minutes)
const SCAN_RESULT_TTL = 15 * 60 * 1000;

/**
 * Check if a scan result has player list data available
 */
export function hasPlayerData(result: ScanResult): boolean {
  return !!(
    result.success &&
    result.status?.data?.players?.sample &&
    Array.isArray(result.status.data.players.sample) &&
    result.status.data.players.sample.length > 0
  );
}

/**
 * Store view type for each message
 */
const messageViews = new Map<string, ViewType>();

// Store scan results with their message IDs and timestamps for button interactions
const scanResults = new Map<string, {
  result: FullScanResult;
  scanDuration?: number;
  timestamp: number;
}>();

/**
 * Store a scan result for select menu interactions
 */
export function storeScanResult(
  messageId: string,
  result: ScanResult | FullScanResult,
  scanDuration?: number
) {
  // Handle both ScanResult and FullScanResult
  const fullResult: FullScanResult = 'ping' in result ? result as FullScanResult : { ping: result as ScanResult };
  scanResults.set(messageId, {
    result: fullResult,
    scanDuration,
    timestamp: Date.now()
  });
  // Set initial view to overview
  messageViews.set(messageId, 'overview');
}

/**
 * Handle button interactions (currently no buttons, using select menus)
 */
export async function handlePlayerListButton(interaction: ButtonInteraction) {
  await interaction.reply({
    content: 'Button interactions are deprecated. Please use the select menus to browse data.',
    ephemeral: true
  });
}

/**
 * Handle select menu interactions for view switching
 */
export async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction) {
  const messageId = interaction.message.id;
  const stored = scanResults.get(messageId);

  if (!stored) {
    await interaction.reply({
      content: 'This scan result is no longer available. Please run the scan again.',
      ephemeral: true
    });
    return;
  }

  // Check if the scan result has expired
  if (Date.now() - stored.timestamp > SCAN_RESULT_TTL) {
    cleanupScanResult(messageId);
    await interaction.reply({
      content: 'This scan result has expired. Please run the scan again.',
      ephemeral: true
    });
    return;
  }

  const selectedView = interaction.values[0] as ViewType;
  const { result, scanDuration } = stored;

  // Update the current view for this message
  messageViews.set(messageId, selectedView);

  // Generate the appropriate embed based on the selected view
  let embed: EmbedBuilder;
  let content: string | undefined;

  if (selectedView === 'overview') {
    // Show the overview embed
    const { embed: overviewEmbed } = await createFullScanEmbed(result, scanDuration);
    embed = overviewEmbed;
  } else if (selectedView === 'plugins') {
    // Show plugins embed
    embed = createPluginsEmbed(result);
  } else if (selectedView === 'players') {
    // Show players embed
    embed = createPlayersEmbed(result);
  } else {
    await interaction.reply({
      content: 'Unknown selection.',
      ephemeral: true
    });
    return;
  }

  // Update the select menu to reflect the current selection
  const components = createViewSelectMenu(result, selectedView);

  // Update the message with the new embed and components
  await interaction.update({
    embeds: [embed],
    components,
    content
  });
}

/**
 * Create an embed showing all plugins
 */
function createPluginsEmbed(result: FullScanResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Plugins: ${result.ping.host}:${result.ping.port}`)
    .setColor(0x5865F2)
    .setTimestamp(new Date(result.ping.timestamp));

  const conn = result.connection;

  if (!conn?.serverPlugins?.plugins || conn.serverPlugins.plugins.length === 0) {
    embed.setDescription('⚠️ No plugins detected or commands are blocked.');
    return embed;
  }

  const plugins = conn.serverPlugins;
  const methodLabel = plugins.method === 'plugins_command' ? '/plugins'
    : plugins.method === 'bukkit_plugins_command' ? 'bukkit:plugins'
    : plugins.method === 'command_tree' ? 'command tree'
    : plugins.method === 'tab_complete' ? 'tab completion'
    : plugins.method === 'combined' ? 'combined'
    : 'unknown';

  // Add all plugins in a single list
  const allPlugins = plugins.plugins;
  const pluginList = allPlugins
    .map((p: string, idx: number) => `${idx + 1}. ${p}`)
    .join('\n');

  embed.addFields({
    name: `Plugins (${allPlugins.length})`,
    value: pluginList.substring(0, 1024),
    inline: false,
  });

  embed.setFooter({ text: `Detection method: ${methodLabel}` });

  return embed;
}

/**
 * Create an embed showing all players
 */
function createPlayersEmbed(result: FullScanResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Players: ${result.ping.host}:${result.ping.port}`)
    .setColor(0x5865F2)
    .setTimestamp(new Date(result.ping.timestamp));

  const players = result.ping.status?.data?.players?.sample || [];

  if (players.length === 0) {
    const onlineCount = result.ping.status?.data?.players?.online || 0;
    const maxCount = result.ping.status?.data?.players?.max || 0;
    embed.setDescription(`No player sample available.\n\n**Total Players:** ${onlineCount}/${maxCount}`);
    return embed;
  }

  // Display all players with UUIDs and validation status
  const playerData = players
    .slice(0, 50) // Limit to 50 players
    .map((p: { name?: string; username?: string; id?: string }) => {
      const name = p.name || p.username || 'Unknown';
      const id = p.id || null;
      const isValid = id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

      if (id) {
        return `${isValid ? '✅' : '❌'} **${name}**\n\`${id}\`\n[NameMC](https://namemc.com/profile/${id})`;
      }
      return `❌ **${name}**\nNo UUID`;
    })
    .join('\n\n');

  embed.setDescription(playerData.substring(0, 4000));

  embed.setFooter({ text: `Players found: ${players.length}` });

  return embed;
}

/**
 * Clean up old scan results
 */
export function cleanupScanResult(messageId: string) {
  scanResults.delete(messageId);
  messageViews.delete(messageId);
}

/**
 * Clean up expired scan results based on TTL
 */
export function cleanupExpiredScanResults(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [messageId, data] of scanResults.entries()) {
    if (now - data.timestamp > SCAN_RESULT_TTL) {
      scanResults.delete(messageId);
      messageViews.delete(messageId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`[ButtonHandler] Cleaned up ${cleaned} expired scan results`);
  }

  return cleaned;
}

/**
 * Start periodic cleanup of expired scan results
 */
export function startPeriodicCleanup(intervalMs: number = 5 * 60 * 1000): () => void {
  const intervalId = setInterval(() => {
    cleanupExpiredScanResults();
  }, intervalMs);

  logger.debug(`[ButtonHandler] Started periodic cleanup (every ${intervalMs / 1000}s)`);

  return () => {
    clearInterval(intervalId);
    logger.debug('[ButtonHandler] Stopped periodic cleanup');
  };
}
