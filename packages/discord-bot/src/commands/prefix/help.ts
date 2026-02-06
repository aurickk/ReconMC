import { Message } from 'discord.js';
import { EmbedBuilder } from 'discord.js';

const PREFIX = '!';

/**
 * Check if a message is a help command
 */
export function isHelpCommand(message: Message): boolean {
  const content = message.content.toLowerCase();
  return content.startsWith(`${PREFIX}help`) || content.startsWith('!commands');
}

/**
 * Execute the help prefix command
 */
export async function execute(message: Message) {
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
          '`!scan <ip> [port]` - Scan using prefix command\n' +
          '`!help` - Show this help message'
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

  await message.reply({ embeds: [embed] });
}
