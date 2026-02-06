import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  ChatInputCommandInteraction,
  Message,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ComponentType
} from 'discord.js';
import * as slashScan from './commands/slash/scan.js';
import * as slashHelp from './commands/slash/help.js';
import * as prefixScan from './commands/prefix/scan.js';
import * as prefixHelp from './commands/prefix/help.js';
import { handlePlayerListButton, handleSelectMenuInteraction } from './handlers/buttonHandler.js';
import { logger } from './logger.js';

export class DiscordBot {
  private client: Client;
  private token: string;
  private clientId: string;
  private guildId?: string;
  private ownerId?: string;

  constructor(token: string, clientId: string, guildId?: string, ownerId?: string) {
    this.token = token;
    this.clientId = clientId;
    this.guildId = guildId;
    this.ownerId = ownerId;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Bot ready
    this.client.once(Events.ClientReady, () => {
      logger.info(`Bot logged in as ${this.client.user?.tag}`);
    });

    // Handle slash commands, button interactions, and select menus
    this.client.on(Events.InteractionCreate, async (interaction) => {
      // Handle select menu interactions
      if (interaction.isStringSelectMenu()) {
        await handleSelectMenuInteraction(interaction as StringSelectMenuInteraction);
        return;
      }

      // Handle button interactions (deprecated)
      if (interaction.isButton()) {
        await handlePlayerListButton(interaction as ButtonInteraction);
        return;
      }

      // Handle slash commands
      if (!interaction.isChatInputCommand()) return;

      // Owner-only check
      if (this.ownerId && interaction.user.id !== this.ownerId) {
        await interaction.reply({
          content: '⛔ This bot is private and can only be used by the owner.',
          ephemeral: true
        });
        return;
      }

      const { commandName } = interaction;

      try {
        if (commandName === 'scan') {
          await slashScan.execute(interaction as ChatInputCommandInteraction);
        } else if (commandName === 'help') {
          await slashHelp.execute(interaction as ChatInputCommandInteraction);
        }
      } catch (error) {
        logger.error('Error handling command:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        try {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
              content: `Error executing command: ${errorMessage}`,
              flags: 64 // ephemeral
            });
          } else {
            await interaction.reply({
              content: `Error executing command: ${errorMessage}`,
              flags: 64 // ephemeral
            });
          }
        } catch (replyError) {
          // Ignore errors if interaction has expired
          if (replyError instanceof Error && !replyError.message.includes('Unknown interaction')) {
            logger.error('Error sending error reply:', replyError);
          }
        }
      }
    });

    // Handle prefix commands
    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Owner-only check for prefix commands
      if (this.ownerId && message.author.id !== this.ownerId) {
        // Silently ignore commands from non-owners
        return;
      }

      try {
        if (prefixScan.isScanCommand(message)) {
          await prefixScan.execute(message);
        } else if (prefixHelp.isHelpCommand(message)) {
          await prefixHelp.execute(message);
        }
      } catch (error) {
        logger.error('Error handling prefix command:', error);
      }
    });
  }

  /**
   * Register slash commands with Discord
   */
  async registerCommands() {
    const commands = [
      slashScan.data,
      slashHelp.data,
    ];

    const rest = new REST({ version: '10' }).setToken(this.token);

    try {
      logger.info('Started refreshing application (/) commands.');

      if (this.guildId) {
        // Register guild commands (faster for testing)
        await rest.put(
          Routes.applicationGuildCommands(this.clientId, this.guildId),
          { body: commands }
        );
        logger.info(`Successfully registered guild commands for guild ${this.guildId}`);
      } else {
        // Register global commands
        await rest.put(
          Routes.applicationCommands(this.clientId),
          { body: commands }
        );
        logger.info('Successfully registered global commands');
      }
    } catch (error) {
      logger.error('Error registering commands:', error);
      throw error;
    }
  }

  /**
   * Start the bot
   */
  async start() {
    // Register commands first
    await this.registerCommands();

    // Login to Discord
    await this.client.login(this.token);
  }

  /**
   * Stop the bot
   */
  async stop() {
    this.client.destroy();
  }
}
