/**
 * AutoAuth plugin for mineflayer
 * Handles automatic authentication on cracked servers that require /login or /register
 * 
 * Based on mineflayer-auto-auth by Konstantin Azizov
 * https://github.com/G07cha/MineflayerAutoAuth
 */

import type { Bot } from 'mineflayer';
import { logger } from '../logger.js';

export interface AutoAuthOptions {
  /** Password to use for login/register */
  password: string;
  /** Enable debug logging (default: false) */
  logging?: boolean;
  /** Ignore repeated login/register requests (default: false) */
  ignoreRepeat?: boolean;
  /** Callback when a repeat request is detected */
  onRepeat?: () => void;
  /** Timeout in ms to wait for auth prompt before considering login complete (default: 3000) */
  authTimeout?: number;
}

export interface AutoAuthResult {
  /** Whether authentication was required */
  authRequired: boolean;
  /** Type of auth that was performed */
  authType?: 'login' | 'register';
  /** Whether auth was successful (no repeat requests) */
  success: boolean;
  /** Error message if auth failed */
  error?: string;
}

declare module 'mineflayer' {
  interface Bot {
    autoAuth: {
      /** Wait for authentication to complete or timeout */
      waitForAuth(): Promise<AutoAuthResult>;
      /** Check if auth has been triggered */
      isAuthTriggered(): boolean;
      /** Get the current auth state */
      getState(): 'waiting' | 'authenticated' | 'failed';
    };
  }
}

/**
 * Generate auth command string
 */
function generateAuthCommand(type: 'login' | 'register', password: string): string {
  if (type === 'register') {
    return `/register ${password} ${password}`;
  }
  return `/login ${password}`;
}

/**
 * AutoAuth mineflayer plugin
 * Automatically handles /login and /register prompts on cracked servers
 */
export function autoAuth(bot: Bot, options: AutoAuthOptions): void {
  if (!options?.password) {
    throw new Error('AutoAuth: password is required');
  }

  const config: Required<Omit<AutoAuthOptions, 'onRepeat'>> & Pick<AutoAuthOptions, 'onRepeat'> = {
    password: options.password,
    logging: options.logging ?? false,
    ignoreRepeat: options.ignoreRepeat ?? false,
    onRepeat: options.onRepeat,
    authTimeout: options.authTimeout ?? 3000,
  };

  let state: 'waiting' | 'authenticated' | 'failed' = 'waiting';
  let authTriggered = false;
  let authType: 'login' | 'register' | undefined;
  let commandSent = false;
  let authResolve: ((result: AutoAuthResult) => void) | null = null;

  const log = (message: string) => {
    if (config.logging) {
      logger.debug(`[AutoAuth] ${message}`);
    }
  };

  const completeAuth = (success: boolean, error?: string) => {
    if (authResolve) {
      authResolve({
        authRequired: authTriggered,
        authType,
        success,
        error,
      });
      authResolve = null;
    }
  };

  // Add chat patterns for login/register detection
  // These patterns match common auth plugin formats
  bot.addChatPattern('autoAuthRegister', /\/register/i, { repeat: true, parse: true });
  bot.addChatPattern('autoAuthLogin', /\/login/i, { repeat: true, parse: true });

  // Handle register requests
  bot.on('chat:autoAuthRegister' as any, () => {
    log('Detected register request');
    authTriggered = true;
    authType = 'register';

    if (commandSent && !config.ignoreRepeat) {
      log('Register request repeated - authentication may have failed');
      state = 'failed';
      if (config.onRepeat) {
        config.onRepeat();
      }
      completeAuth(false, 'Register request repeated - authentication failed');
      return;
    }

    const command = generateAuthCommand('register', config.password);
    log(`Sending: ${command.replace(config.password, '***')}`);
    bot.chat(command);
    commandSent = true;
    state = 'authenticated';

    // Give a small delay for the server to process
    setTimeout(() => {
      if (state === 'authenticated') {
        completeAuth(true);
      }
    }, 500);
  });

  // Handle login requests
  bot.on('chat:autoAuthLogin' as any, () => {
    log('Detected login request');
    authTriggered = true;
    authType = 'login';

    if (commandSent && !config.ignoreRepeat) {
      log('Login request repeated - authentication may have failed');
      state = 'failed';
      if (config.onRepeat) {
        config.onRepeat();
      }
      completeAuth(false, 'Login request repeated - authentication failed');
      return;
    }

    const command = generateAuthCommand('login', config.password);
    log(`Sending: ${command.replace(config.password, '***')}`);
    bot.chat(command);
    commandSent = true;
    state = 'authenticated';

    // Give a small delay for the server to process
    setTimeout(() => {
      if (state === 'authenticated') {
        completeAuth(true);
      }
    }, 500);
  });

  // Attach methods to bot
  bot.autoAuth = {
    waitForAuth(): Promise<AutoAuthResult> {
      return new Promise((resolve) => {
        // If already authenticated or failed, resolve immediately
        if (state !== 'waiting') {
          resolve({
            authRequired: authTriggered,
            authType,
            success: state === 'authenticated',
            error: state === 'failed' ? 'Authentication failed' : undefined,
          });
          return;
        }

        authResolve = resolve;

        // Set timeout - if no auth prompt received, assume no auth needed
        setTimeout(() => {
          if (state === 'waiting') {
            log('No auth prompt received within timeout - assuming no auth required');
            state = 'authenticated';
            resolve({
              authRequired: false,
              success: true,
            });
          }
        }, config.authTimeout);
      });
    },

    isAuthTriggered(): boolean {
      return authTriggered;
    },

    getState(): 'waiting' | 'authenticated' | 'failed' {
      return state;
    },
  };

  log('AutoAuth plugin initialized');
}
