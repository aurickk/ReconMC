/**
 * Session token authentication handler
 * Based on OpSec mod's implementation
 *
 * Strategy:
 * 1. Try session token first (validate against Minecraft profile API)
 * 2. Only refresh if session token is invalid (401/403)
 * 3. Use multiple client IDs, scopes, and ticket formats for compatibility
 * 4. Report refreshed tokens back to coordinator via callback
 */

import type { MicrosoftTokenAccount, AuthResult, TokenRefreshCallback } from './types';
import type { SocksProxyConfig } from './proxied-fetch';
import { createFetchFn } from './proxied-fetch';
import { logger } from '../logger.js';
import {
  validateTokenWithProfile,
  fullRefreshFlow,
} from '@reconmc/scanner';
import type { FullRefreshFlowResult } from '@reconmc/scanner';

// Global token refresh callback - can be set by the agent
let globalTokenRefreshCallback: TokenRefreshCallback | undefined;
let globalAccountId: string | undefined;

/**
 * Set the token refresh callback for reporting refreshed tokens
 */
export function setTokenRefreshCallback(accountId: string, callback: TokenRefreshCallback): void {
  globalAccountId = accountId;
  globalTokenRefreshCallback = callback;
}

/**
 * Clear the token refresh callback
 */
export function clearTokenRefreshCallback(): void {
  globalAccountId = undefined;
  globalTokenRefreshCallback = undefined;
}

/**
 * Run the shared fullRefreshFlow and map its result to the bot's AuthResult type.
 */
async function runRefreshFlow(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<AuthResult> {
  const result = await fullRefreshFlow(refreshToken, fetchFn, logger);
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
 * Main authentication function
 * Strategy:
 * - If session token is valid: use it directly (fastest path)
 * - If session token is invalid/expired: refresh to get new tokens
 *
 * Note: The session join to Mojang only requires accessToken and profile UUID.
 * The Xbox Live userHash is NOT needed for Minecraft Java authentication.
 */
export async function authenticateWithToken(
  account: MicrosoftTokenAccount,
  proxy?: SocksProxyConfig
): Promise<AuthResult> {
  // Create a fetch function that routes through the proxy if provided
  const fetchFn = createFetchFn(proxy);
  if (proxy) {
    logger.debug(`[authenticateWithToken] Using proxy ${proxy.type}://${proxy.host}:${proxy.port} for auth API calls`);
  }

  try {
    // First, try to validate the session token against the profile API
    logger.debug('[authenticateWithToken] Validating session token...');
    const validation = await validateTokenWithProfile(account.accessToken, fetchFn);

    if (validation.valid && validation.profile) {
      logger.debug(`[authenticateWithToken] Session token valid: ${validation.profile.name}`);

      // Use session token directly - no need to refresh!
      // The session join to Mojang only needs accessToken + profile UUID
      return {
        success: true,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        profile: validation.profile,
        userHash: undefined, // Not needed for Java edition auth
        refreshed: false,
      };
    }

    // Session token is invalid/expired/rejected - try refresh if we have a refresh token
    if (!account.refreshToken) {
      logger.error(`[authenticateWithToken] Token validation failed (HTTP ${validation.statusCode}: ${validation.error}) and no refresh token available`);
      return {
        success: false,
        error: `Access token invalid (${validation.error ?? 'unknown'}) and no refresh token available. Please re-authenticate the account.`,
      };
    }

    logger.debug(`[authenticateWithToken] Token validation failed (HTTP ${validation.statusCode}), attempting refresh...`);
    const result = await runRefreshFlow(account.refreshToken, fetchFn);

    // Report refreshed tokens back to coordinator if callback is set
    if (result.success && result.refreshed && globalTokenRefreshCallback && globalAccountId) {
      if (result.accessToken && result.refreshToken) {
        try {
          await globalTokenRefreshCallback(globalAccountId, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          });
          logger.debug('[authenticateWithToken] Reported refreshed tokens to coordinator');
        } catch (err) {
          logger.warn('[authenticateWithToken] Failed to report refreshed tokens:', err);
        }
      }
    }

    return result;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown authentication error',
    };
  }
}

/**
 * Get Minecraft profile using access token
 */
export async function getMinecraftProfile(
  accessToken: string
): Promise<{ id: string; name: string } | null> {
  const result = await validateTokenWithProfile(accessToken);
  return result.profile ?? null;
}

/**
 * Validate a token account configuration
 */
export function validateTokenAccount(account: MicrosoftTokenAccount): boolean {
  return (
    account.type === 'microsoft' &&
    typeof account.accessToken === 'string' &&
    account.accessToken.length > 0
  );
}
