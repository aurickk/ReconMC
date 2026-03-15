import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  PermissionFlagsBits,
  PermissionsBitField
} from 'discord.js';
import { CoordinatorAPIClient, type FullScanResult, type ScanResultWithId } from '../../utils/coordinator-api.js';
import { createFullScanEmbed, createErrorEmbed } from '../../utils/embeds.js';
import { storeScanResult } from '../../handlers/buttonHandler.js';
import { guildConfigService } from '../../services/guildConfigService.js';
import { logger } from '../../logger.js';

export const data: RESTPostAPIChatInputApplicationCommandsJSONBody =
  new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Scan a Minecraft server')
    .addStringOption(option =>
      option
        .setName('ip')
        .setDescription('Server IP address or hostname')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('port')
        .setDescription('Server port (default: 25565)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(65535)
    )
    .toJSON();

/**
 * Check if a channel is allowed for command usage
 * Admins with ManageGuild permission bypass restrictions
 * Empty allowedChannels array allows all channels
 */
function isChannelAllowed(
  channelId: string,
  allowedChannels: string[],
  memberPermissions: Readonly<PermissionsBitField> | null
): boolean {
  // Admin bypass - users with ManageGuild can use commands anywhere
  if (memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }
  // Empty array means all channels are allowed
  if (allowedChannels.length === 0) {
    return true;
  }
  // Check if current channel is in the allowed list
  return allowedChannels.includes(channelId);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // Check if used in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  // Get guild configuration
  const config = guildConfigService.getConfig(interaction.guildId);
  if (!config) {
    await interaction.reply({
      content: 'This server hasn\'t been configured. An admin needs to run /setup first.',
      ephemeral: true
    });
    return;
  }

  // Channel restriction check - admins bypass, empty array allows all
  if (!isChannelAllowed(interaction.channelId, config.allowedChannels, interaction.memberPermissions)) {
    await interaction.reply({
      content: '❌ This command is not allowed in this channel. Please use an allowed channel.',
      ephemeral: true
    });
    return;
  }

  // Defer reply because scanning can take time
  try {
    await interaction.deferReply();
  } catch (error) {
    // Interaction already expired or was handled elsewhere
    if (error instanceof Error && error.message.includes('Unknown interaction')) {
      logger.warn('[SlashCommand] Interaction expired before deferReply');
      return;
    }
    throw error;
  }

  const ip = interaction.options.getString('ip', true);
  const port = interaction.options.getInteger('port') ?? 25565;

  logger.debug(`[SlashCommand] /scan called: host=${ip}, port=${port}, guild=${interaction.guildId}`);

  // Use per-guild coordinator URL and API key
  const api = new CoordinatorAPIClient(config.coordinatorUrl, config.apiKey);

  // Track scan start time
  const scanStartTime = Date.now();

  try {
    // Send initial "scanning" message
    await interaction.editReply({
      content: `Scanning ${ip}:${port}... This may take up to 2 minutes.`,
    });

    // Check session pool availability and warn if empty
    const diagnostics = await api.getQueueDiagnostics();
    if (diagnostics && diagnostics.sessions.total === 0) {
      await interaction.editReply({
        content: `Scanning ${ip}:${port}... Waiting for available session tokens. Import tokens via the dashboard to start scanning.`,
      });
    } else if (diagnostics && diagnostics.sessions.available === 0 && diagnostics.sessions.total > 0) {
      await interaction.editReply({
        content: `Scanning ${ip}:${port}... All session tokens are currently in use. The scan will proceed when a token becomes available.`,
      });
    }

    logger.debug(`[SlashCommand] Calling coordinator API at ${config.coordinatorUrl}...`);
    const scanResult = await api.scanServer(ip, port);
    const result = scanResult.result;

    const scanDuration = Date.now() - scanStartTime;

    logger.debug(`[SlashCommand] API result:`, {
      serverId: scanResult.serverId,
      pingSuccess: result.ping.success,
      host: result.ping.host,
      port: result.ping.port,
      hasStatus: !!result.ping.status,
      hasData: !!result.ping.status?.data,
      serverMode: result.serverMode,
      hasConnection: !!result.connection,
      connectionSuccess: result.connection?.success,
      scanDuration: `${scanDuration}ms`
    });

    logger.debug(`[SlashCommand] Creating full scan embed...`);
    const { embed, files, components } = await createFullScanEmbed(result, scanDuration, scanResult.serverId, config.dashboardUrl);

    logger.debug(`[SlashCommand] Embed created, sending to Discord...`);

    const reply = await interaction.editReply({
      content: undefined, // Clear the "scanning" message
      embeds: [embed],
      files,
      components
    });

    // Store the full scan result for select menu interactions
    storeScanResult(reply.id, result, scanDuration);

    logger.debug(`[SlashCommand] Reply sent successfully`);
  } catch (error) {
    const scanDuration = Date.now() - scanStartTime;
    logger.error(`[SlashCommand] Error occurred:`, error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorDetails = error instanceof Error ? error.stack : String(error);

    logger.error(`[SlashCommand] Error details:`, errorDetails);

    try {
      const embed = createErrorEmbed(`Failed to scan server: ${errorMessage}`);
      await interaction.editReply({
        content: undefined,
        embeds: [embed]
      });
      logger.debug(`[SlashCommand] Error reply sent`);
    } catch (replyError) {
      logger.error(`[SlashCommand] Failed to send error reply:`, replyError);
    }
  }
}
