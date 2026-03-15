/**
 * Session Token Validation Service
 * Validates Minecraft session access tokens against the profile API.
 * No refresh flow -- tokens are disposable. Invalid = rejected.
 *
 * All API calls are optionally routed through a SOCKS proxy from the pool
 * to distribute requests across IPs and avoid rate limiting.
 */

import type { SocksProxyConfig } from './proxied-fetch.js';
import { createFetchFn } from './proxied-fetch.js';
import { validateTokenWithProfile } from '@reconmc/scanner';

export interface SessionValidationResult {
  valid: boolean;
  username?: string;
  uuid?: string;
  error?: string;
}

/**
 * Validate a Minecraft session access token against the profile API.
 * No refresh flow -- tokens are disposable. Invalid = rejected.
 * Routes API calls through proxy if provided to avoid rate limits.
 */
export async function validateSessionToken(
  accessToken: string,
  proxy?: SocksProxyConfig
): Promise<SessionValidationResult> {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return { valid: false, error: 'Access token is required' };
  }

  const fetchFn = createFetchFn(proxy);
  const result = await validateTokenWithProfile(accessToken, fetchFn);

  if (result.valid && result.profile) {
    return {
      valid: true,
      username: result.profile.name,
      uuid: result.profile.id,
    };
  }

  // Rate limited -- report as transient error, not invalid token
  if (result.statusCode === 429) {
    return {
      valid: false,
      error: 'Rate limited by Minecraft API. Try again later.',
    };
  }

  return {
    valid: false,
    error: result.error ?? 'Invalid session token',
  };
}
