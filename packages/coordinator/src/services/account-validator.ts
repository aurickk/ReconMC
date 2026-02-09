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

const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MICROSOFT_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';

// Azure client IDs to try for token refresh
const AZURE_CLIENT_IDS = [
  '00000000402b5328',  // Minecraft public client
  '000000004C12AE6F',  // Xbox App
  '00000000441cc96b',  // Minecraft iOS
  '810e1c10-3b3c-4d4f-be0b-f7e9a01e8b98',  // Common launcher client
  '00000000-02bd-5e32-b7bb-0f2afcbe97f8',  // Minecraft Android
];

// Scope combinations to try for token refresh
const SCOPE_COMBOS = [
  'XboxLive.signin%20XboxLive.offline_access',  // Full Xbox Live scope (OpSec style)
  'XboxLive.signin%20offline_access',            // Alternative encoding
  'service::user.auth.xboxlive.com::MBI_SSL',    // Service-based scope
  'XboxLive.signin',                             // Minimal scope
];

// RpsTicket formats to try for Xbox Live authentication
const TICKET_FORMATS = [
  (token: string) => `d=${token}`,   // Standard format for consumer accounts
  (token: string) => `t=${token}`,   // Alternative format
  (token: string) => token,           // Raw token
];

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
 * Extract profile from a Minecraft Launcher session token JWT
 */
function extractProfileFromSessionToken(token: string): { id: string; name: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );

    // Check for profile in pfd (profile data) array - newer token format
    if (payload.pfd && Array.isArray(payload.pfd)) {
      for (const profile of payload.pfd) {
        if (profile.type === 'mc' && profile.id && profile.name) {
          return { id: profile.id, name: profile.name };
        }
      }
    }

    // Check for profile in profiles.mc array - older token format
    if (payload.profiles?.mc && Array.isArray(payload.profiles.mc)) {
      const profile = payload.profiles.mc[0];
      if (profile?.id && profile?.name) {
        return { id: profile.id, name: profile.name };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate Microsoft access token and retrieve Minecraft profile
 */
async function validateTokenWithProfile(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ valid: boolean; statusCode: number; profile?: { id: string; name: string }; error?: string }> {
  try {
    const response = await fetchFn(MC_PROFILE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const statusCode = response.status;

    if (statusCode === 429) {
      return { valid: false, statusCode, error: 'Rate limited' };
    }

    if (statusCode === 401 || statusCode === 403) {
      return { valid: false, statusCode, error: 'Token invalid or expired' };
    }

    if (statusCode !== 200) {
      return { valid: false, statusCode, error: `HTTP ${statusCode}` };
    }

    const data = await response.json() as { id?: string; name?: string; error?: string };

    if (data.error || !data.id || !data.name) {
      return { valid: false, statusCode, error: 'Invalid profile response' };
    }

    return {
      valid: true,
      statusCode,
      profile: { id: data.id, name: data.name },
    };
  } catch (err) {
    return { valid: false, statusCode: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Refresh Microsoft token with multiple client IDs and scopes
 * IMPORTANT: refreshToken is NOT encoded - it contains special characters that are part of the token format
 */
async function refreshMicrosoftToken(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ access_token: string; refresh_token?: string } | null> {
  for (const clientId of AZURE_CLIENT_IDS) {
    for (const scope of SCOPE_COMBOS) {
      try {
        // Match OpSec's exact format - only encode clientId and redirectUri
        // refreshToken and scope are sent AS-IS (they have special chars that are part of the format)
        const body = `client_id=${encodeURIComponent(clientId)}&refresh_token=${refreshToken}&grant_type=refresh_token&redirect_uri=${encodeURIComponent('https://login.live.com/oauth20_desktop.srf')}&scope=${scope}`;

        const response = await fetchFn(MICROSOFT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });

        if (response.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (response.status !== 200) {
          continue; // Try next combination
        }

        const data = await response.json() as {
          access_token: string;
          refresh_token?: string;
        };

        return {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        };
      } catch {
        continue; // Try next combination
      }
    }
  }

  return null;
}

/**
 * Authenticate with Xbox Live, trying multiple ticket formats
 */
async function authenticateXboxLive(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ token: string; userHash: string } | null> {
  for (let i = 0; i < TICKET_FORMATS.length; i++) {
    const formatFn = TICKET_FORMATS[i];
    try {
      const rpsTicket = formatFn(accessToken);

      const response = await fetchFn(XBL_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-xbl-contract-version': '2',
        },
        body: JSON.stringify({
          Properties: {
            AuthMethod: 'RPS',
            SiteName: 'user.auth.xboxlive.com',
            RpsTicket: rpsTicket,
          },
          RelyingParty: 'http://auth.xboxlive.com',
          TokenType: 'JWT',
        }),
      });

      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (response.status !== 200) {
        continue; // Try next format
      }

      const data = await response.json() as {
        Token: string;
        DisplayClaims: { xui: { uhs: string }[] };
      };

      const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
      if (!userHash) {
        continue;
      }

      return {
        token: data.Token,
        userHash,
      };
    } catch {
      continue; // Try next format
    }
  }

  return null;
}

/**
 * Get XSTS token
 */
async function getXSTSToken(
  xblToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ token: string; userHash: string } | null> {
  try {
    const response = await fetchFn(XSTS_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-xbl-contract-version': '1',
      },
      body: JSON.stringify({
        Properties: {
          SandboxId: 'RETAIL',
          UserTokens: [xblToken],
        },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      }),
    });

    if (response.status === 401) {
      return null;
    }

    if (response.status !== 200) {
      return null;
    }

    const data = await response.json() as {
      Token: string;
      DisplayClaims: { xui: { uhs: string }[] };
    };

    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      return null;
    }

    return {
      token: data.Token,
      userHash,
    };
  } catch {
    return null;
  }
}

/**
 * Authenticate with Minecraft services
 */
async function authenticateMinecraft(
  userHash: string,
  xstsToken: string,
  retries: number = 3,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchFn(MC_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
        }),
      });

      if (response.status === 429) {
        const waitTime = attempt * 5000;
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (response.status !== 200) {
        return null;
      }

      const data = await response.json() as { access_token: string };
      return data.access_token;
    } catch {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Full refresh flow: Microsoft -> Xbox Live -> XSTS -> Minecraft
 */
async function fullRefreshFlow(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ success: true; accessToken: string; refreshToken: string; profile: { id: string; name: string } } | { success: false; error: string }> {
  // Step 1: Refresh Microsoft token
  const msToken = await refreshMicrosoftToken(refreshToken, fetchFn);
  if (!msToken) {
    return { success: false, error: 'Failed to refresh Microsoft token (all client/scope combinations failed). The refresh token may be expired.' };
  }

  // Step 2: Authenticate with Xbox Live
  const xblResponse = await authenticateXboxLive(msToken.access_token, fetchFn);
  if (!xblResponse) {
    return { success: false, error: 'Failed to authenticate with Xbox Live (all ticket formats failed)' };
  }

  // Step 3: Get XSTS token
  const xstsResponse = await getXSTSToken(xblResponse.token, fetchFn);
  if (!xstsResponse) {
    return { success: false, error: 'Failed to get XSTS token. The account may not own Minecraft or does not have Xbox Live.' };
  }

  // Step 4: Authenticate with Minecraft
  const mcAccessToken = await authenticateMinecraft(
    xstsResponse.userHash,
    xstsResponse.token,
    3,
    fetchFn
  );
  if (!mcAccessToken) {
    return { success: false, error: 'Failed to authenticate with Minecraft services' };
  }

  // Step 5: Validate and get profile
  let profileResult = await validateTokenWithProfile(mcAccessToken, fetchFn);

  // If rate limited, wait and retry once
  if (profileResult.statusCode === 429) {
    await new Promise(r => setTimeout(r, 5000));
    profileResult = await validateTokenWithProfile(mcAccessToken, fetchFn);
  }

  // If still failing, try to extract profile from the token itself
  if (!profileResult.valid || !profileResult.profile) {
    const extractedProfile = extractProfileFromSessionToken(mcAccessToken);
    if (extractedProfile) {
      profileResult = {
        valid: true,
        statusCode: 200,
        profile: extractedProfile,
      };
    } else {
      return { success: false, error: `Failed to validate Minecraft profile: ${profileResult.error ?? 'unknown error'}` };
    }
  }

  const profile = profileResult.profile;
  if (!profile) {
    return { success: false, error: 'Profile is undefined after validation' };
  }

  return {
    success: true,
    accessToken: mcAccessToken,
    refreshToken: msToken.refresh_token ?? refreshToken,
    profile,
  };
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

  if (refreshResult.success) {
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
  let errorMsg = refreshResult.error;
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
