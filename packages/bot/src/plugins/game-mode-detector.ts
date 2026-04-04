/**
 * Mineflayer Plugin: Game Mode Detector
 *
 * Detects available game modes on servers that use /server or /servers
 * commands for game mode navigation (common on BungeeCord/Velocity networks).
 *
 * Algorithm:
 * 1. Check if /server or /servers exists in the already-detected command list
 * 2. Send tab-complete for "/server " and "/servers " to get candidate completions
 * 3. Cross-reference completions against the tab player list (bot.players)
 * 4. If any completion matches a player name, the /server command has no proper
 *    game mode autocomplete (it's a GUI-only command) → discard ALL candidates
 * 5. If no player names found in completions, return all candidates as game modes
 */

import type { Bot } from 'mineflayer';
import { logger } from '../logger.js';

/**
 * Tab complete packet structure
 */
interface TabCompletePacket {
  matches?: Array<string | { match?: string; text?: string }>;
}

export interface GameModeDetectionResult {
  /** Detected game mode names */
  gameModes: string[];
  /** Which command was used for detection */
  command: 'server' | 'servers' | 'both' | 'none';
  /** Total tab-complete candidates received */
  totalCandidates: number;
  /** Whether autocomplete was detected as GUI-only (player names in completions) */
  isGuiOnly: boolean;
}

/**
 * Perform a single tab complete request.
 * Follows the exact same pattern as command-detector.ts performTabComplete.
 */
function performTabComplete(bot: Bot, text: string, timeout: number): Promise<string[]> {
  return new Promise((resolve) => {
    const results: string[] = [];
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      bot._client.removeListener('tab_complete', tabCompleteHandler);
      logger.debug(`[GameModeDetector] Tab complete timeout for: ${text}`);
      resolve(results);
    }, timeout);

    const tabCompleteHandler = (packet: TabCompletePacket) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      bot._client.removeListener('tab_complete', tabCompleteHandler);

      logger.debug(`[GameModeDetector] Received tab_complete response`);

      try {
        if (packet.matches && Array.isArray(packet.matches) && packet.matches.length > 0) {
          for (const match of packet.matches) {
            const suggestion = (typeof match === 'string'
              ? match
              : match.match || match.text || ''
            ).toString().trim();

            if (suggestion && suggestion.length > 0) {
              // Strip leading '/' if present
              const cmd = suggestion.startsWith('/') ? suggestion.slice(1) : suggestion;
              if (cmd.length > 0) {
                results.push(cmd);
              }
            }
          }
          logger.debug(`[GameModeDetector] Got ${results.length} candidates from tab complete for: ${text}`);
        }
      } catch (err) {
        logger.error('[GameModeDetector] Error parsing tab complete:', err);
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
      logger.error(`[GameModeDetector] Failed to send tab_complete:`, err);
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
 * Mineflayer plugin for detecting game modes via /server and /servers commands
 */
export function gameModeDetector(bot: Bot) {
  /**
   * Detect game modes by tab-completing /server and /servers commands.
   *
   * Uses a shared timeout budget across both commands (default 3000ms total,
   * minimum 500ms per request). Skips commands not present in the detected
   * command list if provided.
   */
  async function detectGameModes(options?: {
    timeout?: number;
    detectedCommands?: string[];
  }): Promise<GameModeDetectionResult> {
    const totalBudget = options?.timeout ?? 3000;
    const detectedCommands = options?.detectedCommands;

    // Determine which commands to try
    const commandsToTry: string[] = [];
    const hasServer = detectedCommands
      ? detectedCommands.includes('server')
      : true;
    const hasServers = detectedCommands
      ? detectedCommands.includes('servers')
      : true;

    if (hasServer) commandsToTry.push('server');
    if (hasServers) commandsToTry.push('servers');

    // If neither command is available, return early
    if (commandsToTry.length === 0) {
      logger.debug('[GameModeDetector] Neither /server nor /servers in detected commands, skipping');
      return {
        gameModes: [],
        command: 'none',
        totalCandidates: 0,
        isGuiOnly: false,
      };
    }

    // Collect all candidates from tab-complete
    const allCandidates: string[] = [];
    let usedCommand: 'server' | 'servers' | 'both' | 'none' = 'none';
    const deadline = Date.now() + Math.max(totalBudget, 1000);
    const MIN_REQUEST_TIMEOUT = 500;

    for (let i = 0; i < commandsToTry.length; i++) {
      const cmd = commandsToTry[i];
      const remaining = deadline - Date.now();
      const commandsLeft = commandsToTry.length - i;
      const perRequestTimeout = Math.max(Math.floor(remaining / commandsLeft), MIN_REQUEST_TIMEOUT);

      logger.debug(`[GameModeDetector] Tab-completing /${cmd} with timeout ${perRequestTimeout}ms`);

      const candidates = await performTabComplete(bot, `/${cmd} `, perRequestTimeout);

      if (candidates.length > 0) {
        allCandidates.push(...candidates);
        usedCommand = usedCommand === 'none' ? (cmd as 'server' | 'servers') : 'both';
      }
    }

    // Cross-reference against player names to detect GUI-only /server commands.
    // If ANY candidate matches a player name, the /server command doesn't have
    // proper game mode autocomplete — it's a GUI command where tab-complete
    // returns online player names instead. Discard ALL candidates.
    const playerNames = new Set<string>();
    try {
      for (const player of Object.values(bot.players)) {
        if (player?.username) {
          playerNames.add(player.username.toLowerCase());
        }
      }
    } catch (err) {
      logger.debug(`[GameModeDetector] Could not read player list: ${err}`);
    }

    const totalCandidates = allCandidates.length;
    let isGuiOnly = false;

    for (const candidate of allCandidates) {
      if (playerNames.has(candidate.toLowerCase())) {
        isGuiOnly = true;
        logger.debug(
          `[GameModeDetector] Player name "${candidate}" found in tab-complete — ` +
          `/server has no proper game mode autocomplete (GUI-only), discarding all candidates`
        );
        break;
      }
    }

    const gameModes = isGuiOnly ? [] : [...allCandidates].sort();

    logger.debug(
      `[GameModeDetector] Candidates: ${totalCandidates}, ` +
      `isGuiOnly: ${isGuiOnly}, game modes: ${gameModes.length}`
    );

    if (gameModes.length > 0) {
      logger.debug(`[GameModeDetector] Detected game modes: ${gameModes.join(', ')}`);
    }

    return {
      gameModes,
      command: usedCommand,
      totalCandidates,
      isGuiOnly,
    };
  }

  logger.debug('[GameModeDetector] Plugin loaded');

  (bot as any).gameModeDetector = {
    detectGameModes,
  };
}

// Type declaration for the plugin
declare module 'mineflayer' {
  interface Bot {
    gameModeDetector: {
      detectGameModes(options?: {
        timeout?: number;
        detectedCommands?: string[];
      }): Promise<GameModeDetectionResult>;
    };
  }
}
