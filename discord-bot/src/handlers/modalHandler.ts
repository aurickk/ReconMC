import {
  ModalSubmitInteraction,
  ChannelSelectMenuBuilder,
  ChannelType,
  ActionRowBuilder,
  ComponentType,
  StringSelectMenuInteraction
} from 'discord.js';
import { logger } from '../logger.js';
import { SETUP_MODAL_ID, COORDINATOR_URL_INPUT_ID, API_KEY_INPUT_ID } from '../commands/slash/setup.js';
import { CoordinatorAPIClient } from '../utils/coordinator-api.js';

// Custom ID for the channel select menu
export const SETUP_CHANNEL_SELECT_ID = 'setup_channel_select';

// Temporary storage for setup data between modal and channel select
// Keyed by guild ID, stores coordinator URL and API key
const pendingSetupData = new Map<string, { coordinatorUrl: string; apiKey: string }>();

/**
 * Validate URL format
 * @param url - URL string to validate
 * @returns true if valid URL format
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Test coordinator health to verify credentials
 * @param coordinatorUrl - Coordinator API URL
 * @param apiKey - Optional API key
 * @returns Health check result with success status and optional error
 */
async function testCoordinatorHealth(
  coordinatorUrl: string,
  apiKey?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = new CoordinatorAPIClient(coordinatorUrl, apiKey);
    await client.checkHealth();
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Handle setup modal submission
 * Validates URL, tests coordinator health, then shows channel select menu
 */
export async function handleSetupModal(interaction: ModalSubmitInteraction): Promise<void> {
  // Ensure this is in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
    return;
  }

  // Verify this is the setup modal
  if (interaction.customId !== SETUP_MODAL_ID) {
    logger.warn(`[ModalHandler] Unknown modal ID: ${interaction.customId}`);
    return;
  }

  // Extract field values
  const coordinatorUrl = interaction.fields.getTextInputValue(COORDINATOR_URL_INPUT_ID).trim();
  const apiKey = interaction.fields.getTextInputValue(API_KEY_INPUT_ID)?.trim() ?? '';

  logger.debug(`[ModalHandler] Setup modal submitted for guild ${interaction.guildId}`);
  logger.debug(`[ModalHandler] Coordinator URL: ${coordinatorUrl}`);
  logger.debug(`[ModalHandler] API Key provided: ${apiKey.length > 0}`);

  // Validate URL format
  if (!isValidUrl(coordinatorUrl)) {
    await interaction.reply({
      content: '❌ Invalid URL format. Please enter a valid HTTP or HTTPS URL (e.g., https://coordinator.example.com)',
      ephemeral: true
    });
    return;
  }

  // Test coordinator health
  await interaction.deferReply({ ephemeral: true });

  const healthResult = await testCoordinatorHealth(coordinatorUrl, apiKey || undefined);

  if (!healthResult.success) {
    await interaction.editReply({
      content: `❌ Could not connect to coordinator: ${healthResult.error}\n\nPlease verify the URL is correct and the coordinator is running.`
    });
    return;
  }

  // Store pending setup data for this guild
  pendingSetupData.set(interaction.guildId, {
    coordinatorUrl,
    apiKey
  });

  // Create channel select menu
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(SETUP_CHANNEL_SELECT_ID)
    .setPlaceholder('Select channels where ReconMC can be used')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(25); // Discord's max for select menus

  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>()
    .addComponents(channelSelect);

  await interaction.editReply({
    content: '✅ Coordinator connection successful!\n\nNow select the channels where ReconMC commands should be allowed:',
    components: [row]
  });

  logger.debug(`[ModalHandler] Channel select menu shown for guild ${interaction.guildId}`);
}

/**
 * Get pending setup data for a guild
 * @param guildId - Discord guild ID
 * @returns Pending setup data or undefined if not found
 */
export function getPendingSetupData(guildId: string): { coordinatorUrl: string; apiKey: string } | undefined {
  return pendingSetupData.get(guildId);
}

/**
 * Clear pending setup data for a guild
 * @param guildId - Discord guild ID
 */
export function clearPendingSetupData(guildId: string): void {
  pendingSetupData.delete(guildId);
  logger.debug(`[ModalHandler] Cleared pending setup data for guild ${guildId}`);
}
