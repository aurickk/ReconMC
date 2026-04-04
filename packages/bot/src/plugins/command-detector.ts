/**
 * Mineflayer Plugin: Server Command Detector
 *
 * Detects all root slash command names registered on a Minecraft server.
 * Uses two methods:
 * 1. declare_commands packet (Primary) - Passively captures root command node names
 * 2. Tab Complete (Fallback) - Sends "/ " tab complete request to get root commands
 *
 * Unlike pluginDetector, this returns ALL raw command names without
 * namespace extraction or signature matching.
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

export interface CommandDetectionResult {
  commands: string[];
  method: 'declare_commands' | 'tab_complete' | 'none';
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
 * Perform a single tab complete request
 */
function performTabComplete(bot: Bot, text: string, timeout: number): Promise<string[]> {
  return new Promise((resolve) => {
    const results: string[] = [];
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      bot._client.removeListener('tab_complete', tabCompleteHandler);
      logger.debug(`[CommandDetector] Tab complete timeout for: ${text}`);
      resolve(results);
    }, timeout);

    const tabCompleteHandler = (packet: TabCompletePacket) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      bot._client.removeListener('tab_complete', tabCompleteHandler);

      logger.debug(`[CommandDetector] Received tab_complete response`);

      try {
        if (packet.matches && Array.isArray(packet.matches) && packet.matches.length > 0) {
          for (const match of packet.matches) {
            const suggestion = (typeof match === 'string'
              ? match
              : match.match || match.text || ''
            ).toString().trim();

            if (suggestion && suggestion.length > 0) {
              // Strip leading '/' from results
              const cmd = suggestion.startsWith('/') ? suggestion.slice(1) : suggestion;
              if (cmd.length > 0) {
                results.push(cmd);
              }
            }
          }
          logger.debug(`[CommandDetector] Got ${results.length} commands from tab complete`);
        }
      } catch (err) {
        logger.error('[CommandDetector] Error parsing tab complete:', err);
      }

      resolve(results);
    };

    bot._client.once('tab_complete', tabCompleteHandler);

    try {
      bot._client.write('tab_complete', {
        text: text,
        assumeCommand: false,
        lookedAtBlock: undefined,
      });
    } catch (err) {
      logger.error(`[CommandDetector] Failed to send tab_complete:`, err);
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
 * Mineflayer plugin for detecting server commands
 */
export function commandDetector(bot: Bot) {
  const commands = new Set<string>();
  let declareCommandsReceived = false;

  /**
   * Listen for declare_commands packet (sent on login)
   */
  function setupDeclareCommandsListener(): void {
    bot._client.on('declare_commands', (packet: DeclareCommandsPacket) => {
      commands.clear();
      declareCommandsReceived = true;

      logger.debug('[CommandDetector] Received declare_commands packet');

      try {
        if (packet.nodes && Array.isArray(packet.nodes)) {
          const rootIndex = packet.rootIndex ?? packet.root ?? 0;
          const rootNode = packet.nodes[rootIndex];

          if (rootNode) {
            const children = rootNode.children || [];
            logger.debug(`[CommandDetector] Root has ${children.length} children`);

            for (const childIndex of children) {
              if (typeof childIndex !== 'number' || childIndex < 0 || childIndex >= packet.nodes.length) {
                continue;
              }

              const node = packet.nodes[childIndex];
              if (!node) continue;

              const nodeName = getNodeName(node);
              if (!nodeName) continue;

              // Add ALL root command names as-is (no namespace extraction, no signature matching)
              commands.add(nodeName);
            }
          }

          logger.debug(`[CommandDetector] Found ${commands.size} commands from declare_commands`);
        }
      } catch (error) {
        logger.error('[CommandDetector] Failed to parse command tree:', error);
      }
    });
  }

  /**
   * Detect all root commands on the server.
   *
   * 1. If declare_commands was already received, return those commands.
   * 2. If not yet received, wait up to 2000ms for the packet.
   * 3. If still no commands, fall back to tab complete with "/ ".
   * 4. If both fail, return empty with method 'none'.
   */
  async function detectCommands(options?: { timeout?: number }): Promise<CommandDetectionResult> {
    const timeout = options?.timeout ?? 3000;

    // Wait for declare_commands if not yet received
    if (!declareCommandsReceived) {
      logger.debug('[CommandDetector] declare_commands not yet received, waiting...');
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (declareCommandsReceived) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 2000);
      });
    }

    // Return declare_commands results if available
    if (declareCommandsReceived && commands.size > 0) {
      const sorted = Array.from(commands).sort();
      logger.debug(`[CommandDetector] Returning ${sorted.length} commands via declare_commands`);
      return {
        commands: sorted,
        method: 'declare_commands',
      };
    }

    // Fallback: tab complete with "/ " to get root commands
    logger.debug('[CommandDetector] Falling back to tab complete');
    const tabResults = await performTabComplete(bot, '/ ', Math.max(timeout, 3000));

    if (tabResults.length > 0) {
      const sorted = tabResults.sort();
      logger.debug(`[CommandDetector] Returning ${sorted.length} commands via tab_complete`);
      return {
        commands: sorted,
        method: 'tab_complete',
      };
    }

    // Both methods failed
    logger.debug('[CommandDetector] No commands detected via any method');
    return {
      commands: [],
      method: 'none',
    };
  }

  logger.debug('[CommandDetector] Setting up declare_commands listener');
  setupDeclareCommandsListener();

  (bot as any).commandDetector = {
    detectCommands,
  };
}

// Type declaration for the plugin
declare module 'mineflayer' {
  interface Bot {
    commandDetector: {
      detectCommands(options?: { timeout?: number }): Promise<CommandDetectionResult>;
    };
  }
}
