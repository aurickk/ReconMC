import {
  ChannelSelectMenuInteraction,
  TextChannel
} from 'discord.js';
import { logger } from '../logger.js';
import { SETUP_CHANNEL_SELECT_ID, getPendingSetupData, clearPendingSetupData } from './modalHandler.js';
import { guildConfigService } from '../services/guildConfigService.js';

/**
 * Handle setup channel select menu interaction
 * Saves the guild configuration to SQLite
 */
export async function handleSetupChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  // Ensure this is in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  // Verify this is the setup channel select menu
  if (interaction.customId !== SETUP_CHANNEL_SELECT_ID) {
    logger.warn(`[SelectMenuHandler] Unknown select menu ID: ${interaction.customId}`);
    return;
  }

  // Get pending setup data
  const pendingData = getPendingSetupData(interaction.guildId);

  if (!pendingData) {
    await interaction.reply({
      content: '❌ Setup session expired. Please run /setup again.',
      ephemeral: true
    });
    return;
  }

  // Get selected channel IDs
  const selectedChannels = interaction.channels;
  const channelIds = selectedChannels.map(channel => channel.id);

  logger.debug(`[SelectMenuHandler] Channel selection for guild ${interaction.guildId}:`);
  logger.debug(`[SelectMenuHandler] - Channels: ${channelIds.join(', ')}`);

  // Build channel names for display
  const channelNames = selectedChannels
    .filter((ch): ch is TextChannel => ch instanceof TextChannel)
    .map(ch => `<#${ch.id}>`)
    .join(', ');

  try {
    // Save configuration to SQLite
    guildConfigService.saveConfig({
      guildId: interaction.guildId,
      coordinatorUrl: pendingData.coordinatorUrl,
      apiKey: pendingData.apiKey,
      allowedChannels: channelIds,
      dashboardUrl: null
    });

    // Clear pending data
    clearPendingSetupData(interaction.guildId);

    // Send success message
    await interaction.update({
      content: `✅ **Configuration saved successfully!**\n\n` +
        `**Coordinator URL:** \`${pendingData.coordinatorUrl}\`\n` +
        `**API Key:** ${pendingData.apiKey ? '`' + '*'.repeat(8) + '`' : 'None (public coordinator)'}\n` +
        `**Allowed Channels:** ${channelNames}\n\n` +
        `You can now use ReconMC commands in the selected channels.`,
      components: []
    });

    logger.info(`[SelectMenuHandler] Configuration saved for guild ${interaction.guildId}`);
  } catch (error) {
    logger.error(`[SelectMenuHandler] Failed to save config for guild ${interaction.guildId}:`, error);

    await interaction.update({
      content: '❌ Failed to save configuration. Please try again or check logs for details.',
      components: []
    });
  }
}
