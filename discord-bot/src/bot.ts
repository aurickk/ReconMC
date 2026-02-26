import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  ChannelSelectMenuInteraction,
  ComponentType
} from 'discord.js';
import * as slashScan from './commands/slash/scan.js';
import * as slashHelp from './commands/slash/help.js';
import * as slashSetup from './commands/slash/setup.js';
import * as slashConfig from './commands/slash/config.js';
import * as slashReset from './commands/slash/reset.js';
import { handlePlayerListButton, handleSelectMenuInteraction, handleResetButton } from './handlers/buttonHandler.js';
import { handleSetupModal } from './handlers/modalHandler.js';
import { handleSetupChannelSelect } from './handlers/selectMenuHandler.js';
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
        GatewayIntentBits.GuildMessages
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
      // Handle modal submissions
      if (interaction.isModalSubmit()) {
        try {
          await handleSetupModal(interaction as ModalSubmitInteraction);
        } catch (error) {
          logger.error('Error handling modal:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          try {
            if (interaction.replied || interaction.deferred) {
              await interaction.editReply({ content: `Error: ${errorMessage}` });
            } else {
              await interaction.reply({
                content: `Error: ${errorMessage}`,
                ephemeral: true
              });
            }
          } catch (replyError) {
            if (replyError instanceof Error && !replyError.message.includes('Unknown interaction')) {
              logger.error('Error sending error reply:', replyError);
            }
          }
        }
        return;
      }

      // Handle channel select menu interactions
      if (interaction.isChannelSelectMenu()) {
        try {
          await handleSetupChannelSelect(interaction as ChannelSelectMenuInteraction);
        } catch (error) {
          logger.error('Error handling channel select:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          try {
            if (interaction.replied || interaction.deferred) {
              await interaction.editReply({ content: `Error: ${errorMessage}` });
            } else {
              await interaction.reply({
                content: `Error: ${errorMessage}`,
                ephemeral: true
              });
            }
          } catch (replyError) {
            if (replyError instanceof Error && !replyError.message.includes('Unknown interaction')) {
              logger.error('Error sending error reply:', replyError);
            }
          }
        }
        return;
      }

      // Handle string select menu interactions (for scan result views)
      if (interaction.isStringSelectMenu()) {
        await handleSelectMenuInteraction(interaction as StringSelectMenuInteraction);
        return;
      }

      // Handle button interactions
      if (interaction.isButton()) {
        // Check if it's a reset button
        if (interaction.customId === 'reset_confirm' || interaction.customId === 'reset_cancel') {
          await handleResetButton(interaction as ButtonInteraction);
          return;
        }
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
        } else if (commandName === 'setup') {
          await slashSetup.execute(interaction as ChatInputCommandInteraction);
        } else if (commandName === 'config') {
          await slashConfig.execute(interaction as ChatInputCommandInteraction);
        } else if (commandName === 'reset') {
          await slashReset.execute(interaction as ChatInputCommandInteraction);
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
  }

  /**
   * Register slash commands with Discord
   */
  async registerCommands() {
    const commands = [
      slashScan.data,
      slashHelp.data,
      slashSetup.data,
      slashConfig.data,
      slashReset.data,
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
