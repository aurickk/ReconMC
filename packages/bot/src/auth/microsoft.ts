/**
 * Microsoft OAuth helpers for initial account authorization.
 * Token refresh is handled by session.ts using shared scanner module.
 */

import type { MicrosoftTokenAccount, AuthResult } from './types';
import { authenticateWithToken } from './session';

const AUTH_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const CLIENT_ID = '00000000-02bd-5e32-b7bb-0f2afcbe97f8';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'XboxLive.signin offline_access',
    state,
    prompt: 'login',
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCodeForToken(code: string): Promise<{ access_token: string; refresh_token: string } | null> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    grant_type: 'authorization_code',
  });

  const response = await fetch(`${TOKEN_URL}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!response.ok) return null;

  const data = await response.json() as { access_token: string; refresh_token: string };
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

export async function completeAuthFlow(code: string): Promise<AuthResult> {
  const tokens = await exchangeCodeForToken(code);
  if (!tokens) {
    return { success: false, error: 'Failed to exchange authorization code' };
  }

  const tokenAccount: MicrosoftTokenAccount = {
    type: 'microsoft',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };

  return authenticateWithToken(tokenAccount);
}
