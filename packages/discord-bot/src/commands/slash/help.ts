import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../../logger.js';

export const data: RESTPostAPIChatInputApplicationCommandsJSONBody =
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help information for ReconMC')
    .toJSON();

export async function execute(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('ReconMC - Minecraft Server Scanner')
    .setDescription('Scan Minecraft servers to get their status, player count, and more!')
    .setColor('Blue')
    .addFields(
      {
        name: 'Commands',
        value:
          '`/scan <ip> [port] [timeout]` - Scan a Minecraft server\n' +
          '`/help` - Show this help message\n' +
          '`!scan <ip> [port]` - Scan using prefix command'
      },
      {
        name: 'Examples',
        value:
          '`/scan mc.hypixel.net`\n' +
          '`/scan play.it.cypionix.net:25565`\n' +
          '`!scan mc.hypixel.net`'
      },
      {
        name: 'Options',
        value:
          '**ip** - Server IP address or hostname (required)\n' +
          '**port** - Server port, default is 25565 (optional)\n' +
          '**timeout** - Connection timeout in ms, default is 5000 (optional)'
      }
    )
    .setTimestamp();

  try {
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    // Interaction already expired or was handled elsewhere
    if (error instanceof Error && error.message.includes('Unknown interaction')) {
      logger.warn('[SlashCommand] Help interaction expired');
      return;
    }
    throw error;
  }
}
