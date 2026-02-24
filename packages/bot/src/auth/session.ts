/**
 * Session token authentication handler.
 * Auth API calls use direct connections (legitimate OAuth) - not proxied.
 * Only game connections to Minecraft servers require proxy routing.
 */

import type { MicrosoftTokenAccount, AuthResult, TokenRefreshCallback } from './types';
import type { SocksProxyConfig } from './proxied-fetch';
import { logger } from '../logger.js';
import {
  validateTokenWithProfile,
  fullRefreshFlow,
  getCachedTokenValidity,
} from '@reconmc/scanner';
import type { FullRefreshFlowResult } from '@reconmc/scanner';

let globalTokenRefreshCallback: TokenRefreshCallback | undefined;
let globalAccountId: string | undefined;

export function setTokenRefreshCallback(accountId: string, callback: TokenRefreshCallback): void {
  globalAccountId = accountId;
  globalTokenRefreshCallback = callback;
}

export function clearTokenRefreshCallback(): void {
  globalAccountId = undefined;
  globalTokenRefreshCallback = undefined;
}

async function runRefreshFlow(refreshToken: string): Promise<AuthResult> {
  const result = await fullRefreshFlow(refreshToken, globalThis.fetch, logger);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    profile: result.profile,
    userHash: result.userHash,
    refreshed: true,
    msAccessToken: result.msAccessToken,
    xblToken: result.xblToken,
    xstsToken: result.xstsToken,
    expiresOn: result.expiresOn,
  };
}

/**
 * Main authentication function.
 * Uses direct (non-proxied) connections for auth APIs to avoid flagging proxy IPs.
 * Token validation results are cached for 5 minutes to reduce API calls.
 */
export async function authenticateWithToken(
  account: MicrosoftTokenAccount,
  _proxy?: SocksProxyConfig
): Promise<AuthResult> {
  try {
    const cached = getCachedTokenValidity(account.accessToken);
    if (cached?.valid && cached.profile) {
      logger.debug(`[authenticateWithToken] Cache hit: ${cached.profile.name}`);
      return {
        success: true,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        profile: cached.profile,
        userHash: undefined,
        refreshed: false,
      };
    }

    logger.debug('[authenticateWithToken] Validating session token...');
    const validation = await validateTokenWithProfile(account.accessToken, globalThis.fetch);

    if (validation.valid && validation.profile) {
      logger.debug(`[authenticateWithToken] Token valid: ${validation.profile.name}`);
      return {
        success: true,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        profile: validation.profile,
        userHash: undefined,
        refreshed: false,
      };
    }

    if (!account.refreshToken) {
      logger.error(`[authenticateWithToken] Token invalid (${validation.statusCode}: ${validation.error}), no refresh token`);
      return {
        success: false,
        error: `Token invalid and no refresh token. Re-authenticate the account.`,
      };
    }

    logger.debug(`[authenticateWithToken] Token invalid (${validation.statusCode}), refreshing...`);
    const result = await runRefreshFlow(account.refreshToken);

    if (result.success && result.refreshed && globalTokenRefreshCallback && globalAccountId) {
      if (result.accessToken && result.refreshToken) {
        try {
          await globalTokenRefreshCallback(globalAccountId, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          });
          logger.debug('[authenticateWithToken] Reported refreshed tokens');
        } catch (err) {
          logger.warn('[authenticateWithToken] Failed to report tokens:', err);
        }
      }
    }

    return result;
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
