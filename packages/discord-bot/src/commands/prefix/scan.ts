import { Message, DiscordAPIError } from 'discord.js';
import { CoordinatorAPIClient } from '../../utils/coordinator-api.js';
import { createFullScanEmbed, createErrorEmbed } from '../../utils/embeds.js';
import { storeScanResult, hasPlayerData } from '../../handlers/buttonHandler.js';
import { logger } from '../../logger.js';

const PREFIX = '!';

/**
 * Check if a message is a scan command
 */
export function isScanCommand(message: Message): boolean {
  return message.content.startsWith(`${PREFIX}scan`);
}

/**
 * Execute the scan prefix command
 */
export async function execute(message: Message) {
  logger.debug(`[PrefixCommand] !scan command received from ${message.author.tag}`);

  // Parse command: !scan <ip> [port]
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command !== 'scan') {
    return;
  }

  const ip = args[0];
  const port = args[1] ? parseInt(args[1], 10) : 25565;

  logger.debug(`[PrefixCommand] Parsed: host=${ip}, port=${port}`);

  if (!ip) {
    const embed = createErrorEmbed(
      'Usage: `!scan <ip> [port]`\nExample: `!scan mc.hypixel.net`'
    );
    await message.reply({ embeds: [embed] });
    return;
  }

  // Send a "thinking" message
  const thinkingMessage = await message.reply(`🔍 Scanning ${ip}:${port}... This may take up to 2 minutes.`);

  const api = new CoordinatorAPIClient();

  try {
    logger.debug(`[PrefixCommand] Calling coordinator API...`);
    const result = await api.scanServer(ip, port);

    logger.debug(`[PrefixCommand] API result:`, {
      pingSuccess: result.ping.success,
      host: result.ping.host,
      port: result.ping.port,
      hasStatus: !!result.ping.status,
      hasData: !!result.ping.status?.data,
      serverMode: result.serverMode,
      hasConnection: !!result.connection,
      connectionSuccess: result.connection?.success,
      error: result.ping.error
    });

    logger.debug(`[PrefixCommand] Creating full scan embed...`);
    const { embed, files, components } = await createFullScanEmbed(result);

    logger.debug(`[PrefixCommand] Sending to Discord...`);
    const sentMessage = await thinkingMessage.edit({
      embeds: [embed],
      files,
      components
    });

    // Store the scan result for select menu interactions
    storeScanResult(sentMessage.id, result);

    logger.debug(`[PrefixCommand] Reply sent successfully`);
  } catch (error) {
    logger.error(`[PrefixCommand] Error occurred:`, error);

    // Check if it's a Discord API error with validation details
    if (error instanceof DiscordAPIError) {
      logger.error(`[PrefixCommand] DiscordAPIError Details:`, {
        message: error.message,
        code: error.code,
        status: error.status,
        method: error.method,
        url: error.url,
        stack: error.stack
      });
    }

    if (error instanceof Error) {
      logger.error(`[PrefixCommand] Error message:`, error.message);
      logger.error(`[PrefixCommand] Error stack:`, error.stack);
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const embed = createErrorEmbed(`Failed to scan server: ${errorMessage}`);

    try {
      await thinkingMessage.edit({ embeds: [embed] });
      logger.debug(`[PrefixCommand] Error reply sent`);
    } catch (replyError) {
      logger.error(`[PrefixCommand] Failed to send error reply:`, replyError);

      // Check if the reply error is also a Discord API error
      if (replyError instanceof DiscordAPIError) {
        logger.error(`[PrefixCommand] DiscordAPIError in error reply:`, {
          message: replyError.message,
          code: replyError.code,
          status: replyError.status
        });
      }

      // Try sending a plain text message as fallback
      try {
        await thinkingMessage.edit(`Failed to scan server: ${errorMessage}`);
      } catch (fallbackError) {
        logger.error(`[PrefixCommand] Failed to send fallback message:`, fallbackError);
      }
    }
  }
}
