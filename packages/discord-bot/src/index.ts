import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from root directory (parent of packages/discord-bot)
// Compiled code is in dist/, so we need to go up 3 levels: dist/../.. = root
const rootDir = resolve(__dirname, '../../..');
const envPath = resolve(rootDir, '.env');
const result = config({ path: envPath });

import { DiscordBot } from './bot.js';
import { logger } from './logger.js';

// Validate environment variables
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const ownerId = process.env.BOT_OWNER_ID;

if (!token) {
  logger.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

if (!clientId) {
  logger.error('DISCORD_CLIENT_ID is required');
  process.exit(1);
}

const bot = new DiscordBot(token, clientId, guildId, ownerId);

if (ownerId) {
  logger.info(`Bot locked to owner ID: ${ownerId}`);
} else {
  logger.warn('BOT_OWNER_ID not set. Bot can be used by anyone!');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down bot...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down bot...');
  await bot.stop();
  process.exit(0);
});

// Start the bot
bot.start().catch((error) => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});
