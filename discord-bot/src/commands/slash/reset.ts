import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { logger } from '../../logger.js';
import { guildConfigService } from '../../services/guildConfigService.js';

// Custom IDs for reset buttons
export const RESET_CONFIRM_ID = 'reset_confirm';
export const RESET_CANCEL_ID = 'reset_cancel';

/**
 * /reset command - Reset ReconMC configuration for this guild
 * Only visible to users with Manage Guild permission
 */
export const data: RESTPostAPIChatInputApplicationCommandsJSONBody =
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset ReconMC configuration for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(0) // Guild only (0 = Guild, 1 = Bot DM, 2 = Private Channel)
    .toJSON();

/**
 * Execute the /reset command - shows confirmation buttons
 */
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Ensure this is used in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  logger.debug(`[ResetCommand] /reset invoked by ${interaction.user.id} in guild ${interaction.guildId}`);

  // Check if configuration exists
  const config = guildConfigService.getConfig(interaction.guildId);

  // If no configuration exists, show "not configured" message
  if (!config) {
    await interaction.reply({
      content: '⚠️ **ReconMC is not configured for this server.**\n\nUse `/setup` to configure the bot with your coordinator credentials.',
      ephemeral: true
    });
    return;
  }

  // Create confirmation buttons
  const confirmButton = new ButtonBuilder()
    .setCustomId(RESET_CONFIRM_ID)
    .setLabel('Confirm Reset')
    .setStyle(ButtonStyle.Danger);

  const cancelButton = new ButtonBuilder()
    .setCustomId(RESET_CANCEL_ID)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

  await interaction.reply({
    content: '⚠️ **Are you sure you want to reset the ReconMC configuration?**\n\nThis will delete all settings for this server. You will need to run `/setup` again to reconfigure.',
    components: [row],
    ephemeral: true
  });

  logger.debug(`[ResetCommand] Confirmation shown for guild ${interaction.guildId}`);
}
