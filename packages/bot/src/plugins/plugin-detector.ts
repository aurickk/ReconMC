/**
 * Mineflayer Plugin: Server Plugin Detector
 *
 * Enhanced scanner that detects plugins using multiple methods:
 * 1. Command Tree Packet (Primary) - Parses declare_commands packet for pluginname:command format
 * 2. Multi-phase Tab Complete (Secondary) - Scans root namespace, /version, /plugins, /pl, /help, /bukkit:
 * 3. Command Signatures - Matches commands to plugins via signature database
 * 4. /plugins command (Fallback) - Standard way, works if not blocked
 * 5. bukkit:plugins command (Fallback) - Fallback if /plugins is blocked
 *
 * Based on Meteor Client and collector.js implementations with enhancements from no-p2w addon
 */

import type { Bot } from 'mineflayer';
import { logger } from '../logger.js';

/**
 * Command node structure from declare_commands packet
 */
interface CommandNode {
  name?: string;
  extraNodeData?: string | { name?: string };
  children?: number[];
}

/**
 * Declare commands packet structure
 */
interface DeclareCommandsPacket {
  nodes?: CommandNode[];
  rootIndex?: number;
  root?: number;
}

/**
 * Tab complete packet structure
 */
interface TabCompletePacket {
  matches?: Array<string | { match?: string; text?: string }>;
}

/**
 * Chat message structure
 */
interface ChatMessage {
  text?: string;
  translate?: string;
  with?: (string | ChatMessage)[];
  extra?: (string | ChatMessage)[];
}

export interface PluginDetectionResult {
  plugins: string[];
  method: 'command_tree' | 'tab_complete' | 'combined' | 'plugins_command' | 'bukkit_plugins_command' | 'none';
  rawResponse?: string;
}

export interface PluginDetectorOptions {
  /** Timeout for each detection method in milliseconds (default: 5000) */
  timeout?: number;
  /** Methods to try, in order (default: command_tree, tab_complete, plugins_command, bukkit_plugins_command) */
  methods?: ('command_tree' | 'tab_complete' | 'plugins_command' | 'bukkit_plugins_command')[];
}

/**
 * Command signature database for detecting plugins without namespace prefix
 * Maps command names to their plugin identifiers
 */
const COMMAND_SIGNATURES = new Map<string, string>([
  // EssentialsX
  ['essentials', 'essentialsx'],
  ['es', 'essentialsx'],
  ['eballoon', 'essentialsx'],
  ['eco', 'essentialsx'],
  ['worth', 'essentialsx'],
  ['nick', 'essentialsx'],
  ['tp', 'essentialsx'],
  ['tphere', 'essentialsx'],
  ['tpo', 'essentialsx'],
  ['tpa', 'essentialsx'],
  ['tpahere', 'essentialsx'],
  ['warp', 'essentialsx'],
  ['setwarp', 'essentialsx'],
  ['delwarp', 'essentialsx'],
  ['sethome', 'essentialsx'],
  ['home', 'essentialsx'],
  ['delhome', 'essentialsx'],
  ['back', 'essentialsx'],
  ['msg', 'essentialsx'],
  ['r', 'essentialsx'],
  ['mail', 'essentialsx'],
  ['balance', 'essentialsx'],
  ['bal', 'essentialsx'],
  ['pay', 'essentialsx'],
  ['baltop', 'essentialsx'],
  ['sell', 'essentialsx'],
  ['buy', 'essentialsx'],
  ['trade', 'essentialsx'],
  ['kit', 'essentialsx'],
  ['workbench', 'essentialsx'],
  ['anvil', 'essentialsx'],
  ['enderchest', 'essentialsx'],
  ['day', 'essentialsx'],
  ['night', 'essentialsx'],
  ['sun', 'essentialsx'],
  ['storm', 'essentialsx'],
  ['kickall', 'essentialsx'],

  // WorldEdit
  ['we', 'worldedit'],
  ['worldedit:', 'worldedit'],
  ['worldedit', 'worldedit'],
  ['sel', 'worldedit'],
  ['selection', 'worldedit'],
  ['pos', 'worldedit'],
  ['wand', 'worldedit'],
  ['drain', 'worldedit'],
  ['cyl', 'worldedit'],
  ['sphere', 'worldedit'],
  ['pyramid', 'worldedit'],
  ['set', 'worldedit'],
  ['replace', 'worldedit'],
  ['walls', 'worldedit'],
  ['faces', 'worldedit'],
  ['copy', 'worldedit'],
  ['cut', 'worldedit'],
  ['paste', 'worldedit'],
  ['rotate', 'worldedit'],
  ['flip', 'worldedit'],
  ['undo', 'worldedit'],
  ['redo', 'worldedit'],
  ['superpickaxe', 'worldedit'],

  // WorldGuard
  ['wg', 'worldguard'],
  ['worldguard:', 'worldguard'],
  ['worldguard', 'worldguard'],
  ['region', 'worldguard'],
  ['rg', 'worldguard'],
  ['claim', 'worldguard'],

  // Vault/Economy
  ['vault', 'vault'],
  ['money', 'vault'],
  ['economy', 'vault'],

  // CMI
  ['cmi', 'cmi'],
  ['cmi:chatitem', 'cmi'],
  ['cmi:check', 'cmi'],
  ['cmiaction', 'cmi'],
  ['cmialias', 'cmi'],
  ['cmiarmor', 'cmi'],
  ['cmiafk', 'cmi'],
  ['cmiauto', 'cmi'],

  // CoreProtect
  ['co', 'coreprotect'],
  ['coreprotect:', 'coreprotect'],
  ['coreinspect', 'coreprotect'],
  ['corerollback', 'coreprotect'],
  ['corelookup', 'coreprotect'],

  // LuckoPerms
  ['lp', 'luckperms'],
  ['luckperms:', 'luckperms'],
  ['luckperms', 'luckperms'],
  ['perm', 'luckperms'],
  ['permission', 'luckperms'],
  ['networkuser', 'luckperms'],

  // ProtocolLib
  ['protocol', 'protocollib'],
  ['protocollib:', 'protocollib'],
  ['protocollib', 'protocollib'],
  ['packet', 'protocollib'],

  // PlaceholderAPI
  ['papi', 'placeholderapi'],
  ['placeholderapi:', 'placeholderapi'],
  ['placeholderapi', 'placeholderapi'],
  ['parse', 'placeholderapi'],
  ['placeholders', 'placeholderapi'],

  // ChatControl
  ['chatcontrol', 'chatcontrol'],
  ['cc', 'chatcontrol'],
  ['chatcontrol:', 'chatcontrol'],

  // Chunky
  ['chunky', 'chunky'],
  ['chunky:', 'chunky'],
  ['chunkyworld', 'chunky'],
  ['chunkysilent', 'chunky'],

  // DiscordSRV
  ['discordsrv', 'discordsrv'],
  ['discordsrv:', 'discordsrv'],
  ['discord', 'discordsrv'],

  // Essentials
  ['essentials:', 'essentialsx'],
  ['esschat', 'essentialsx'],
  ['essentials:chat', 'essentialsx'],
  ['essentials:spawn', 'essentialsx'],

  // LibsDisguises
  ['libsdisguises', 'libsdisguises'],
  ['disguise', 'libsdisguises'],
  ['undisguise', 'libsdisguises'],

  // PlotSquared
  ['plots', 'plotsquared'],
  ['plot', 'plotsquared'],
  ['plotsquared:', 'plotsquared'],

  // ViaVersion
  ['viaversion', 'viaversion'],
  ['viaver:', 'viaversion'],
  ['vv', 'viaversion'],

  // ViaBackwards
  ['viabackwards', 'viabackwards'],
  ['vbw', 'viabackwards'],

  // ViaRewind
  ['viarewind', 'viarewind'],
  ['vrewind', 'viarewind'],

  // Citizens
  ['citizens', 'citizens'],
  ['npc', 'citizens'],
  ['citizen', 'citizens'],

  // HolographicDisplays
  ['holograms', 'holographicdisplays'],
  ['holographicdisplays:', 'holographicdisplays'],
  ['hd', 'holographicdisplays'],

  // DecentHolograms
  ['decentholograms', 'decentholograms'],
  ['dh', 'decentholograms'],

  // PlugMan
  ['plugman', 'plugman'],
  ['plugman:', 'plugman'],
  ['pluginsmanager', 'plugman'],

  // AuthMeReloaded
  ['authme', 'authmereloaded'],
  ['login', 'authmereloaded'],
  ['register', 'authmereloaded'],
  ['changepassword', 'authmereloaded'],
  ['authme:', 'authmereloaded'],

  // LoginSecurity
  ['loginsecurity', 'loginsecurity'],
  ['loginsecurity:', 'loginsecurity'],

  // FastLogin
  ['fastlogin', 'fastlogin'],
  ['fastlogin:', 'fastlogin'],

  // CombatLogX
  ['combatlogx', 'combatlogx'],
  ['combatlogx:', 'combatlogx'],

  // AntiWorldEdit (anti-cheat related)
  ['antiworldedit', 'antiworldedit'],
  ['antiwe', 'antiworldedit'],
  ['awe', 'antiworldedit'],

  // dynamo
  ['dynamoload', 'dynamoframework'],
  ['dynamo', 'dynamoframework'],

  // Arcade
  ['arcade', 'arcade'],
  ['arcade:', 'arcade'],

  // BungeeGuard
  ['bungeeguard', 'bungeeguard'],

  // BungeeTabListPlus
  ['bungeetablistplus', 'bungeetablistplus'],
  ['btlp', 'bungeetablistplus'],

  // FastBoard
  ['fastboard', 'fastboard'],

  // TAB
  ['tab:', 'tab'],
  ['tab', 'tab'],

  // skBee
  ['skbee', 'skbee'],
  ['skbee:', 'skbee'],

  // skQuery
  ['skquery', 'skquery'],
  ['skq', 'skquery'],

  // TuSKe
  ['tuske', 'tuske'],
  ['tuske:', 'tuske'],

  // WildStacker
  ['wildstacker', 'wildstacker'],
  ['ws', 'wildstacker'],

  // RoseStacker
  ['rosestacker', 'rosestacker'],
  ['rosestacker:', 'rosestacker'],

  // SuperiorSkyblock
  ['superiorskyblock', 'superiorskyblock'],
  ['superiorskyblock:', 'superiorskyblock'],
  ['is', 'superiorskyblock'],

  // BentoBox
  ['bentobox', 'bentobox'],
  ['bentobox:', 'bentobox'],
  ['bento', 'bentobox'],

  // ASkyBlock
  ['askyblock', 'askyblock'],
  ['island', 'askyblock'],

  // UltimateChat
  ['ultimatechat', 'ultimatechat'],
  ['uc', 'ultimatechat'],
  ['ultimatechat:', 'ultimatechat'],

  // VaultChat
  ['vaultchat', 'vault'],
  ['vaulthatch', 'vault'],

  // Votifier
  ['votifier', 'votifier'],
  ['vote', 'votifier'],
  ['votifier:', 'votifier'],

  // NuVotifier
  ['nuvotifier', 'nuvotifier'],

  // PlotMe
  ['plotme', 'plotme'],
  ['plotme:', 'plotme'],

  // CrazyCrates
  ['crazycrates', 'crazycrates'],
  ['crate', 'crazycrates'],

  // UltimateTimber
  ['ultimatetimber', 'ultimatetimber'],

  // TreeAssist
  ['treeassist', 'treeassist'],
  ['ta', 'treeassist'],

  // Annihilation
  ['annihilation', 'annihilation'],
  ['anni', 'annihilation'],

  // BetterRTP
  ['betterrtp', 'betterrtp'],
  ['rtp', 'betterrtp'],

  // UltimateAutoRestart
  ['ultimateautorestart', 'ultimateautorestart'],
  ['autorestart', 'ultimateautorestart'],

  // ArmorStandTools
  ['armorstandtools', 'armorstandtools'],
  ['ast', 'armorstandtools'],
  ['sat', 'armorstandtools'],

  // ChunkSpawnerLimiter
  ['chunkspawnerlimiter', 'chunkspawnerlimiter'],

  // EntityCleaner
  ['entitycleaner', 'entitycleaner'],
  ['entitycleaner:', 'entitycleaner'],
  ['entitylimiter', 'entitycleaner'],

  // DupeFix
  ['dupefix', 'dupefix'],
  ['fix', 'dupefix'],

  // InventoryRollback
  ['inventoryrollback', 'inventoryrollback'],
  ['ir', 'inventoryrollback'],
  ['inventoryrollback:', 'inventoryrollback'],

  // JoinActions
  ['joinactions', 'joinactions'],

  // LockLogin
  ['locklogin', 'locklogin'],
  ['locklogin:', 'locklogin'],

  // MyCommand
  ['mycmd', 'mycommand'],
  ['mycommand', 'mycommand'],

  // ServerListPlus
  ['serverlistplus', 'serverlistplus'],
  ['slp', 'serverlistplus'],

  // Sentry
  ['sentry', 'sentry'],

  // Spark
  ['spark', 'spark'],
  ['spark:', 'spark'],

  // OpenInv
  ['openinv', 'openinv'],
  ['openinv:', 'openinv'],
  ['openender', 'openinv'],
  ['invsee', 'openinv'],
  ['endersee', 'openinv'],

  // PvPTimer
  ['pvptimer', 'pvptimer'],
  ['pvp', 'pvptimer'],

  // SilkSpawners
  ['silkspawners', 'silkspawners'],
  ['silkspawners:', 'silkspawners'],
  ['spawner', 'silkspawners'],

  // VotingPlugin
  ['votingplugin', 'votingplugin'],
  ['voteplugin', 'votingplugin'],
  ['vp', 'votingplugin'],

  // JCD
  ['jcd', 'jcd'],

  // SilkTouch
  ['silktouch', 'silktouch'],

  // MatrixReborn
  ['matrixreborn', 'matrixreborn'],

  // AAC (Already exists but adding variant)
  ['aac5', 'aac'],
  ['aac4', 'aac'],

  // Config (meets)
  ['configme', 'configme'],

  // NBT
  ['nbtapi', 'nbtapi'],
  ['nbt:', 'nbtapi'],

  // ProtocolSupport
  ['protocolsupport', 'protocolsupport'],
  ['protocolsupport:', 'protocolsupport'],

  // nocheatplusplusplus
  ['nocheatplusplusplus', 'nocheatplus'],
  ['ncppp', 'nocheatplus'],
]);

/**
 * Version command aliases to check in command tree
 * Expanded to include spigot:, paper:, purpur: prefixes
 */
const VERSION_ALIASES = new Set([
  'version',
  'ver',
  'about',
  'bukkit:version',
  'bukkit:ver',
  'bukkit:about',
  'spigot:version',
  'paper:version',
  'purpur:version',
]);

/**
 * Tab complete scanning phases
 * Each phase tries different commands to reveal plugins
 */
interface TabCompletePhase {
  command: string;
  description: string;
}

const TAB_COMPLETE_PHASES: TabCompletePhase[] = [
  { command: '/', description: 'root namespace' },
  { command: '/version', description: 'version' },
  { command: '/ver', description: 'ver alias' },
  { command: '/plugins', description: 'plugins' },
  { command: '/pl', description: 'pl alias' },
  { command: '/help', description: 'help' },
  { command: '/bukkit:', description: 'bukkit namespace' },
  { command: '/bukkit:plugins', description: 'bukkit:plugins' },
  { command: '/bukkit:version', description: 'bukkit:version' },
  { command: '/spigot:plugins', description: 'spigot:plugins' },
  { command: '/spigot:version', description: 'spigot:version' },
];

/**
 * Parse plugin list from /plugins command response
 * Expected format: "Plugins (X): Plugin1, Plugin2, Plugin3"
 */
function parsePluginsResponse(message: string): string[] | null {
  const match = message.match(/Plugins?\s*\((\d+)\)\s*:\s*(.+)/i);
  if (!match) return null;

  const pluginList = match[2];
  const plugins = pluginList
    .split(/,\s*/)
    .map(p => p.replace(/§[0-9a-fk-or]/gi, '').trim())
    .filter(p => p.length > 0);

  return plugins;
}

/**
 * Extract node name from various possible locations in the packet structure
 */
function getNodeName(node: CommandNode | undefined): string {
  if (!node) return '';

  if (node.name && typeof node.name === 'string') {
    return node.name;
  }

  if (node.extraNodeData) {
    if (typeof node.extraNodeData === 'string') {
      return node.extraNodeData;
    }
    if (node.extraNodeData.name && typeof node.extraNodeData.name === 'string') {
      return node.extraNodeData.name;
    }
  }

  return '';
}

/**
 * Extract plugin name from a namespaced command (e.g., "essentials:home" -> "essentials")
 */
function extractPluginFromNamespace(command: string): string | null {
  if (!command || !command.includes(':')) {
    return null;
  }
  const parts = command.split(':');
  if (parts.length >= 2) {
    return parts[0].toLowerCase();
  }
  return null;
}

/**
 * Match command to plugin using signature database
 */
function matchCommandToPlugin(command: string): string | null {
  const cmd = command.toLowerCase().replace(/^\/+/, '').replace(/:.+$/, '');
  return COMMAND_SIGNATURES.get(cmd) || null;
}

/**
 * Mineflayer plugin for detecting server plugins
 */
export function pluginDetector(bot: Bot) {
  const defaultOptions: Required<PluginDetectorOptions> = {
    timeout: 5000,
    methods: ['command_tree', 'tab_complete', 'plugins_command', 'bukkit_plugins_command'],
  };

  const commandTreePlugins = new Set<string>();
  const tabCompletePlugins = new Set<string>();
  let versionAlias: string | null = null;
  let commandTreeReceived = false;

  /**
   * Listen for declare_commands packet (sent on login)
   */
  function setupCommandTreeListener(): void {
    bot._client.on('declare_commands', (packet: DeclareCommandsPacket) => {
      commandTreePlugins.clear();
      tabCompletePlugins.clear();
      versionAlias = null;
      commandTreeReceived = true;

      logger.debug('[PluginDetector] Received declare_commands packet');

      try {
        if (packet.nodes && Array.isArray(packet.nodes)) {
          logger.debug(`[PluginDetector] Processing ${packet.nodes.length} command nodes`);

          const rootIndex = packet.rootIndex ?? packet.root ?? 0;
          const rootNode = packet.nodes[rootIndex];

          if (rootNode) {
            logger.debug(`[PluginDetector] Root node index: ${rootIndex}`);
            const children = rootNode.children || [];
            logger.debug(`[PluginDetector] Root has ${children.length} children`);

            for (const childIndex of children) {
              if (typeof childIndex !== 'number' || childIndex < 0 || childIndex >= packet.nodes.length) {
                continue;
              }

              const node = packet.nodes[childIndex];
              if (!node) continue;

              const nodeName = getNodeName(node);
              if (!nodeName) continue;

              // Check for plugin:command format
              if (nodeName.includes(':')) {
                const pluginName = extractPluginFromNamespace(nodeName);
                if (pluginName) {
                  commandTreePlugins.add(pluginName);
                }
              }

              // Match commands to plugins via signature database
              const matchedPlugin = matchCommandToPlugin(nodeName);
              if (matchedPlugin) {
                commandTreePlugins.add(matchedPlugin);
              }

              // Check for version aliases
              if (!versionAlias && VERSION_ALIASES.has(nodeName.toLowerCase())) {
                versionAlias = nodeName;
                logger.debug(`[PluginDetector] Found version alias: ${versionAlias}`);
              }
            }
          }

          logger.debug(`[PluginDetector] Found ${commandTreePlugins.size} plugins from command tree`);
        }
      } catch (error) {
        logger.error('[PluginDetector] Failed to parse command tree:', error);
      }
    });
  }

  /**
   * Try to detect plugins using the command tree packet
   */
  async function tryCommandTree(): Promise<PluginDetectionResult | null> {
    logger.debug(`[PluginDetector] tryCommandTree called: commandTreeReceived=${commandTreeReceived}, plugins=${commandTreePlugins.size}`);

    if (!commandTreeReceived) {
      logger.debug('[PluginDetector] Command tree not yet received, waiting...');
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (commandTreeReceived) {
            logger.debug('[PluginDetector] Command tree received!');
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);

        setTimeout(() => {
          logger.debug('[PluginDetector] Wait for command tree timed out');
          clearInterval(checkInterval);
          resolve();
        }, 2000);
      });
    }

    if (commandTreePlugins.size > 0) {
      const plugins = Array.from(commandTreePlugins);
      return {
        plugins,
        method: 'command_tree',
      };
    }

    return null;
  }

  /**
   * Perform a single tab complete request
   */
  function performTabComplete(command: string, timeout: number): Promise<string[]> {
    return new Promise((resolve) => {
      const results: string[] = [];
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        bot._client.removeListener('tab_complete', tabCompleteHandler);
        logger.debug(`[PluginDetector] Tab complete timeout for: ${command}`);
        resolve(results);
      }, timeout);

      const tabCompleteHandler = (packet: TabCompletePacket) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        bot._client.removeListener('tab_complete', tabCompleteHandler);

        logger.debug(`[PluginDetector] Received tab_complete response for: ${command}`);

        try {
          if (packet.matches && Array.isArray(packet.matches) && packet.matches.length > 0) {
            for (const match of packet.matches) {
              const suggestion = (typeof match === 'string'
                ? match
                : match.match || match.text || ''
              ).toString().trim();

              if (suggestion && suggestion.length > 0) {
                results.push(suggestion.toLowerCase());
              }
            }
            logger.debug(`[PluginDetector] Got ${results.length} suggestions from: ${command}`);
          }
        } catch (err) {
          logger.error('[PluginDetector] Error parsing tab complete:', err);
        }

        resolve(results);
      };

      bot._client.once('tab_complete', tabCompleteHandler);

      try {
        bot._client.write('tab_complete', {
          text: `${command} `,
          assumeCommand: false,
          lookedAtBlock: undefined,
        });
      } catch (err) {
        logger.error(`[PluginDetector] Failed to send tab_complete for ${command}:`, err);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          bot._client.removeListener('tab_complete', tabCompleteHandler);
          resolve(results);
        }
      }
    });
  }

  /**
   * Try to detect plugins using multi-phase tab completion
   */
  async function tryTabComplete(timeout: number): Promise<PluginDetectionResult | null> {
    logger.debug('[PluginDetector] Starting multi-phase tab complete scan');

    const allPlugins = new Set<string>(commandTreePlugins);
    const detectedFromTabComplete = new Set<string>();

    for (const phase of TAB_COMPLETE_PHASES) {
      logger.debug(`[PluginDetector] Tab complete phase: ${phase.description} (${phase.command})`);

      try {
        const suggestions = await performTabComplete(phase.command, Math.max(timeout, 3000));

        for (const suggestion of suggestions) {
          const pluginFromNamespace = extractPluginFromNamespace(suggestion);
          if (pluginFromNamespace) {
            allPlugins.add(pluginFromNamespace);
            detectedFromTabComplete.add(pluginFromNamespace);
          }

          const matchedPlugin = matchCommandToPlugin(suggestion);
          if (matchedPlugin) {
            allPlugins.add(matchedPlugin);
            detectedFromTabComplete.add(matchedPlugin);
          }
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        logger.error(`[PluginDetector] Error in phase ${phase.description}:`, err);
      }
    }

    logger.debug(`[PluginDetector] Tab complete scan finished. Total plugins: ${allPlugins.size}, New from tab complete: ${detectedFromTabComplete.size}`);

    if (allPlugins.size > 0) {
      const plugins = Array.from(allPlugins);
      return {
        plugins,
        method: detectedFromTabComplete.size > 0 ? 'combined' : 'command_tree',
      };
    }

    return null;
  }

  /**
   * Try to detect plugins using the /plugins command
   */
  async function tryPluginsCommand(timeout: number): Promise<PluginDetectionResult | null> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        bot.removeListener('message', messageHandler);
        resolve(null);
      }, timeout);

      const messageHandler = (jsonMsg: ChatMessage) => {
        const message = jsonMsg.toString();

        if (message.includes('Plugins (') || message.includes('Plugins(')) {
          clearTimeout(timeoutId);
          bot.removeListener('message', messageHandler);

          const plugins = parsePluginsResponse(message);
          if (plugins && plugins.length > 0) {
            resolve({
              plugins,
              method: 'plugins_command',
              rawResponse: message,
            });
          } else {
            resolve(null);
          }
        }
      };

      bot.on('message', messageHandler);
      bot.chat('/plugins');
    });
  }

  /**
   * Try to detect plugins using the bukkit:plugins command
   */
  async function tryBukkitPluginsCommand(timeout: number): Promise<PluginDetectionResult | null> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        bot.removeListener('message', messageHandler);
        resolve(null);
      }, timeout);

      const messageHandler = (jsonMsg: ChatMessage) => {
        const message = jsonMsg.toString();

        if (message.includes('Plugins (') || message.includes('Plugins(')) {
          clearTimeout(timeoutId);
          bot.removeListener('message', messageHandler);

          const plugins = parsePluginsResponse(message);
          if (plugins && plugins.length > 0) {
            resolve({
              plugins,
              method: 'bukkit_plugins_command',
              rawResponse: message,
            });
          } else {
            resolve(null);
          }
        }
      };

      bot.on('message', messageHandler);
      bot.chat('/bukkit:plugins');
    });
  }

  /**
   * Detect plugins using all available methods
   */
  async function detectPlugins(options?: PluginDetectorOptions): Promise<PluginDetectionResult> {
    const opts = { ...defaultOptions, ...options };

    for (const method of opts.methods) {
      let result: PluginDetectionResult | null = null;

      switch (method) {
        case 'command_tree':
          result = await tryCommandTree();
          break;
        case 'tab_complete':
          result = await tryTabComplete(opts.timeout);
          break;
        case 'plugins_command':
          result = await tryPluginsCommand(opts.timeout);
          break;
        case 'bukkit_plugins_command':
          result = await tryBukkitPluginsCommand(opts.timeout);
          break;
      }

      if (result && result.plugins.length > 0) {
        return result;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    return {
      plugins: [],
      method: 'none',
    };
  }

  logger.debug('[PluginDetector] Setting up declare_commands listener');
  setupCommandTreeListener();

  (bot as any).pluginDetector = {
    detectPlugins,
    tryCommandTree: () => tryCommandTree(),
    tryTabComplete: (timeout?: number) => tryTabComplete(timeout ?? defaultOptions.timeout),
    tryPluginsCommand: (timeout?: number) => tryPluginsCommand(timeout ?? defaultOptions.timeout),
    tryBukkitPluginsCommand: (timeout?: number) => tryBukkitPluginsCommand(timeout ?? defaultOptions.timeout),
    getCommandTreePlugins: () => Array.from(commandTreePlugins),
    getTabCompletePlugins: () => Array.from(tabCompletePlugins),
    getVersionAlias: () => versionAlias,
  };
}

// Type declaration for the plugin
declare module 'mineflayer' {
  interface Bot {
    pluginDetector: {
      detectPlugins(options?: PluginDetectorOptions): Promise<PluginDetectionResult>;
      tryCommandTree(): Promise<PluginDetectionResult | null>;
      tryTabComplete(timeout?: number): Promise<PluginDetectionResult | null>;
      tryPluginsCommand(timeout?: number): Promise<PluginDetectionResult | null>;
      tryBukkitPluginsCommand(timeout?: number): Promise<PluginDetectionResult | null>;
      getCommandTreePlugins(): string[];
      getTabCompletePlugins(): string[];
      getVersionAlias(): string | null;
    };
  }
}
