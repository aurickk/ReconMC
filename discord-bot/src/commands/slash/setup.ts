import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { logger } from '../../logger.js';

// Custom IDs for modal components
export const SETUP_MODAL_ID = 'setup_modal';
export const COORDINATOR_URL_INPUT_ID = 'coordinator_url';
export const API_KEY_INPUT_ID = 'api_key';

/**
 * /setup command - Configure the bot for this guild
 * Only visible to users with Manage Guild permission
 */
export const data: RESTPostAPIChatInputApplicationCommandsJSONBody =
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure ReconMC for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(0) // Guild only (0 = Guild, 1 = Bot DM, 2 = Private Channel)
    .toJSON();

/**
 * Create the setup modal with Coordinator URL and API Key fields
 */
function createSetupModal(): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(SETUP_MODAL_ID)
    .setTitle('Configure ReconMC');

  // Coordinator URL input (required)
  const coordinatorUrlInput = new TextInputBuilder()
    .setCustomId(COORDINATOR_URL_INPUT_ID)
    .setLabel('Coordinator URL')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://coordinator.example.com')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(500);

  // API Key input (optional)
  const apiKeyInput = new TextInputBuilder()
    .setCustomId(API_KEY_INPUT_ID)
    .setLabel('API Key (optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave empty if no authentication required')
    .setRequired(false)
    .setMaxLength(200);

  // Add inputs to action rows (each input needs its own row)
  const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(coordinatorUrlInput);
  const secondActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput);

  modal.addComponents(firstActionRow, secondActionRow);

  return modal;
}

/**
 * Execute the /setup command - shows the configuration modal
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  // Ensure this is used in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  logger.debug(`[SetupCommand] /setup invoked by ${interaction.user.id} in guild ${interaction.guildId}`);

  const modal = createSetupModal();

  try {
    await interaction.showModal(modal);
    logger.debug(`[SetupCommand] Modal shown successfully`);
  } catch (error) {
    logger.error('[SetupCommand] Failed to show modal:', error);
    
    // showModal doesn't support ephemeral, but if it fails, we can't recover
    // The error is likely a timeout or interaction already acknowledged
    if (error instanceof Error && !error.message.includes('Unknown interaction')) {
      throw error;
    }
  }
}
