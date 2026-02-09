/**
 * Microsoft Account Validation Service
 * Validates Microsoft tokens and retrieves Minecraft profile information
 * Includes token refresh capability for expired access tokens
 *
 * All API calls are optionally routed through a SOCKS proxy from the pool
 * to distribute requests across IPs and avoid rate limiting.
 */

import type { SocksProxyConfig } from './proxied-fetch.js';
import { createFetchFn } from './proxied-fetch.js';
import {
  validateTokenWithProfile,
  fullRefreshFlow,
} from '@reconmc/scanner';

export interface ValidationResult {
  valid: boolean;
  username?: string;
  profileId?: string;
  error?: string;
  newAccessToken?: string;
  newRefreshToken?: string;
  refreshed?: boolean;
}

/**
 * Validate Microsoft account with optional token refresh
 */
export async function validateMicrosoftAccount(
  accessToken: string,
  refreshToken?: string,
  proxy?: SocksProxyConfig
): Promise<ValidationResult> {
  const fetchFn = createFetchFn(proxy);

  if (!accessToken || typeof accessToken !== 'string' || accessToken.length === 0) {
    return {
      valid: false,
      error: 'Access token is required',
    };
  }

  // First, try to validate the access token
  const validation = await validateTokenWithProfile(accessToken, fetchFn);

  if (validation.valid && validation.profile) {
    return {
      valid: true,
      username: validation.profile.name,
      profileId: validation.profile.id,
      refreshed: false,
    };
  }

  // Token validation failed - try refresh if we have a refresh token
  if (!refreshToken || refreshToken.length === 0) {
    return {
      valid: false,
      error: `Access token invalid (${validation.error ?? 'unknown'}) and no refresh token available. Please re-authenticate the account.`,
    };
  }

  const refreshResult = await fullRefreshFlow(refreshToken, fetchFn);

  if (refreshResult.success && refreshResult.profile) {
    return {
      valid: true,
      username: refreshResult.profile.name,
      profileId: refreshResult.profile.id,
      newAccessToken: refreshResult.accessToken,
      newRefreshToken: refreshResult.refreshToken,
      refreshed: true,
    };
  }

  // Provide clearer error message based on common failures
  let errorMsg = refreshResult.error ?? 'Unknown refresh error';
  if (errorMsg.includes('expired')) {
    errorMsg = 'Refresh token is expired (refresh tokens expire after ~90 days of non-use). You must re-authenticate the account from scratch to get a new refresh token.';
  }

  return {
    valid: false,
    error: errorMsg,
  };
}

/**
 * Validate account credentials based on type
 */
export async function validateAccount(
  type: string,
  accessToken: string | null | undefined,
  username: string | null | undefined,
  refreshToken?: string | null,
  proxy?: SocksProxyConfig
): Promise<ValidationResult> {
  // For Microsoft accounts, validate the access token
  if (type === 'microsoft' && accessToken) {
    return await validateMicrosoftAccount(accessToken, refreshToken ?? undefined, proxy);
  }

  // For cracked accounts, just validate username exists
  if (type === 'cracked') {
    if (!username || username.length === 0) {
      return {
        valid: false,
        error: 'Username is required for cracked accounts',
      };
    }
    return {
      valid: true,
      username,
    };
  }

  // Invalid account type or missing credentials
  return {
    valid: false,
    error: type === 'microsoft'
      ? 'Access token is required for Microsoft accounts'
      : 'Invalid account type',
  };
}
