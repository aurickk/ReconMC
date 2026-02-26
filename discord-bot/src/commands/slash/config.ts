import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { logger } from '../../logger.js';
import { guildConfigService } from '../../services/guildConfigService.js';

/**
 * Mask an API key for display - shows first 4 and last 4 characters
 * @param apiKey - The API key to mask
 * @returns Masked key in format "xxxx...xxxx" or "Not set"
 */
function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length === 0) {
    return 'Not set';
  }
  
  if (apiKey.length <= 8) {
    // Too short to meaningfully mask, just show asterisks
    return '*'.repeat(apiKey.length);
  }
  
  const first4 = apiKey.slice(0, 4);
  const last4 = apiKey.slice(-4);
  return `${first4}...${last4}`;
}

/**
 * Mask a URL for display - shows protocol and hostname only
 * @param url - The URL to mask
 * @returns Masked URL showing only protocol and hostname
 */
function maskUrl(url: string): string {
  if (!url || url.length === 0) {
    return 'Not set';
  }
  
  try {
    const parsed = new URL(url);
    // Show protocol and hostname, hide path/query
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    // Invalid URL, return as-is with truncation
    if (url.length > 30) {
      return `${url.slice(0, 30)}...`;
    }
    return url;
  }
}

/**
 * /config command - Display current ReconMC configuration for this guild
 * Only visible to users with Manage Guild permission
 */
export const data: RESTPostAPIChatInputApplicationCommandsJSONBody =
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('View the current ReconMC configuration for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(0) // Guild only (0 = Guild, 1 = Bot DM, 2 = Private Channel)
    .toJSON();

/**
 * Execute the /config command - shows current guild configuration
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

  logger.debug(`[ConfigCommand] /config invoked by ${interaction.user.id} in guild ${interaction.guildId}`);

  // Get guild configuration
  const config = guildConfigService.getConfig(interaction.guildId);

  // If no configuration exists, show "not configured" message
  if (!config) {
    await interaction.reply({
      content: '⚠️ **ReconMC is not configured for this server.**\n\nUse `/setup` to configure the bot with your coordinator credentials.',
      ephemeral: true
    });
    return;
  }

  // Build the configuration embed
  const embed = new EmbedBuilder()
    .setTitle('ReconMC Configuration')
    .setDescription('Current server configuration settings')
    .setColor(0x5865F2) // Discord blurple
    .addFields(
      {
        name: 'Coordinator URL',
        value: `\`${maskUrl(config.coordinatorUrl)}\``,
        inline: false
      },
      {
        name: 'API Key',
        value: `\`${maskApiKey(config.apiKey)}\``,
        inline: false
      },
      {
        name: 'Allowed Channels',
        value: config.allowedChannels.length > 0
          ? config.allowedChannels.map(id => `<#${id}>`).join(', ')
          : 'None configured',
        inline: false
      },
      {
        name: 'Dashboard URL',
        value: config.dashboardUrl
          ? `\`${maskUrl(config.dashboardUrl)}\``
          : 'Not configured',
        inline: false
      },
      {
        name: 'Last Updated',
        value: `<t:${Math.floor(new Date(config.updatedAt).getTime() / 1000)}:R>`,
        inline: true
      }
    )
    .setFooter({ text: `Guild ID: ${interaction.guildId}` })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });

  logger.debug(`[ConfigCommand] Configuration displayed for guild ${interaction.guildId}`);
}
