/**
 * Authentication module exports
 */

export * from './types';
export * from './microsoft';
export * from './session';
export * from './proxied-fetch';

import type { Account, CrackedAccount, MicrosoftTokenAccount, AuthResult, TokenRefreshCallback } from './types';
import type { SocksProxyConfig } from './proxied-fetch';
import { validateTokenAccount, authenticateWithToken, getMinecraftProfile, setTokenRefreshCallback, clearTokenRefreshCallback } from './session';

/**
 * Set the token refresh callback for reporting refreshed tokens
 */
export { setTokenRefreshCallback, clearTokenRefreshCallback };

/**
 * Validate a cracked account
 */
export function validateCrackedAccount(account: CrackedAccount): boolean {
  return (
    account.type === 'cracked' &&
    typeof account.username === 'string' &&
    account.username.length > 0 &&
    account.username.length <= 16
  );
}

/**
 * Validate any account type
 */
export function validateAccount(account: Account): boolean {
  switch (account.type) {
    case 'cracked':
      return validateCrackedAccount(account);
    case 'microsoft':
      return validateTokenAccount(account);
    default:
      return false;
  }
}

/**
 * Get username from any account type
 */
export function getUsername(account: Account): string {
  switch (account.type) {
    case 'cracked':
      return account.username;
    case 'microsoft':
      // For token auth, username will be fetched from profile
      // Return a placeholder in the meantime
      return 'Player';
    default:
      return 'Player';
  }
}

/**
 * Get auth string for mineflayer
 * Note: mineflayer still uses 'offline' as the auth string for cracked accounts
 */
export function getAuthString(account: Account): 'offline' | 'microsoft' {
  return account.type === 'cracked' ? 'offline' : 'microsoft';
}

/**
 * Get access token for Microsoft accounts (if available)
 */
export async function getAccessToken(
  account: Account
): Promise<string | null> {
  if (account.type === 'microsoft') {
    const result = await authenticateWithToken(account);
    return result.success ? (result.accessToken ?? null) : null;
  }
  return null;
}

/**
 * Get Microsoft profile for an account (fetches from API)
 * Optionally routes API calls through a SOCKS proxy to avoid rate limiting.
 */
export async function getAccountProfile(account: Account, proxy?: SocksProxyConfig): Promise<{ id: string; name: string } | null> {
  if (account.type === 'microsoft') {
    const result = await authenticateWithToken(account, proxy);
    return result.success && result.profile ? result.profile : null;
  }
  return null;
}

/**
 * Get full auth result including userHash for session authentication
 * This is needed for proper Minecraft session token auth.
 * Optionally routes API calls through a SOCKS proxy to avoid rate limiting.
 */
export async function getAccountAuth(account: Account, proxy?: SocksProxyConfig): Promise<AuthResult | null> {
  if (account.type === 'microsoft') {
    return await authenticateWithToken(account, proxy);
  }
  return null;
}

/**
 * Create a cracked account from a username string
 */
export function createCrackedAccount(username: string): CrackedAccount {
  return {
    type: 'cracked',
    username: username.substring(0, 16),
  };
}
