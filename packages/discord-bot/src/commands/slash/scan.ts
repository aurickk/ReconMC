import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { CoordinatorAPIClient, type FullScanResult } from '../../utils/coordinator-api.js';
import { createFullScanEmbed, createErrorEmbed } from '../../utils/embeds.js';
import { storeScanResult } from '../../handlers/buttonHandler.js';
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

export async function execute(interaction: ChatInputCommandInteraction) {
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

  logger.debug(`[SlashCommand] /scan called: host=${ip}, port=${port}`);

  const api = new CoordinatorAPIClient();

  // Track scan start time
  const scanStartTime = Date.now();

  try {
    // Send initial "scanning" message
    await interaction.editReply({
      content: `🔍 Scanning ${ip}:${port}... This may take up to 2 minutes.`,
    });

    logger.debug(`[SlashCommand] Calling coordinator API...`);
    const result = await api.scanServer(ip, port);

    const scanDuration = Date.now() - scanStartTime;

    logger.debug(`[SlashCommand] API result:`, {
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
    const { embed, files, components } = await createFullScanEmbed(result, scanDuration);

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
