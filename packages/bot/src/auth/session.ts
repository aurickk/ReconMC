/**
 * Session token authentication handler.
 * Validates tokens against the Minecraft profile API.
 * No refresh flow -- sessions are disposable.
 */

import type { MicrosoftTokenAccount, AuthResult } from './types';
import type { SocksProxyConfig } from './proxied-fetch';
import { createFetchFn } from './proxied-fetch';
import { logger } from '../logger.js';
import {
  validateTokenWithProfile,
  getCachedTokenValidity,
} from '@reconmc/scanner';

/**
 * Main authentication function.
 * Routes token validation API calls through the SOCKS proxy when provided.
 * This ensures api.minecraftservices.com is reachable even when the hosting
 * server blocks Mojang/Microsoft domains at DNS or firewall level.
 * Token validation results are cached for 5 minutes to reduce API calls.
 */
export async function authenticateWithToken(
  account: MicrosoftTokenAccount,
  proxy?: SocksProxyConfig
): Promise<AuthResult> {
  try {
    const cached = getCachedTokenValidity(account.accessToken);
    if (cached?.valid && cached.profile) {
      logger.debug(`[authenticateWithToken] Cache hit: ${cached.profile.name}`);
      return {
        success: true,
        accessToken: account.accessToken,
        profile: cached.profile,
        userHash: undefined,
      };
    }

    const fetchFn = createFetchFn(proxy);
    logger.debug(`[authenticateWithToken] Validating session token...${proxy ? ' (via proxy)' : ''}`);
    const validation = await validateTokenWithProfile(account.accessToken, fetchFn);

    if (validation.valid && validation.profile) {
      logger.debug(`[authenticateWithToken] Token valid: ${validation.profile.name}`);
      return {
        success: true,
        accessToken: account.accessToken,
        profile: validation.profile,
        userHash: undefined,
      };
    }

    // No refresh flow -- token is invalid, report failure
    logger.error(`[authenticateWithToken] Token invalid (${validation.statusCode}: ${validation.error})`);
    return {
      success: false,
      error: `Token invalid: ${validation.error ?? 'unknown error'}. Session should be invalidated.`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Auth failed',
    };
  }
}

export async function getMinecraftProfile(accessToken: string): Promise<{ id: string; name: string } | null> {
  const result = await validateTokenWithProfile(accessToken);
  return result.profile ?? null;
}

export function validateTokenAccount(account: MicrosoftTokenAccount): boolean {
  return (
    account.type === 'microsoft' &&
    typeof account.accessToken === 'string' &&
    account.accessToken.length > 0
  );
}
