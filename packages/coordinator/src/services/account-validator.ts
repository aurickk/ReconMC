/**
 * Microsoft Account Validation Service
 * Validates Microsoft tokens and retrieves Minecraft profile information
 * Includes token refresh capability for expired access tokens
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MICROSOFT_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';

// Simple file logger for token refresh debugging
const REFRESH_LOG_PATH = join(process.cwd(), 'logs', 'token-refresh.log');
async function logRefresh(message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  // Also log to console for Docker visibility (using console.error so it shows with warn level)
  console.error(`[TokenRefresh] ${message}`);
  try {
    await fs.mkdir(join(process.cwd(), 'logs'), { recursive: true });
    await fs.appendFile(REFRESH_LOG_PATH, logLine);
  } catch {
    // Ignore file logging errors
  }
}

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
  // New fields for refreshed tokens
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
  accessToken: string
): Promise<{ valid: boolean; statusCode: number; profile?: { id: string; name: string }; error?: string }> {
  try {
    const response = await fetch(MC_PROFILE_URL, {
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
 * Uses raw URL-encoded format to match OpSec's approach
 * IMPORTANT: refreshToken is NOT encoded - it contains special characters that are part of the token format
 */
async function refreshMicrosoftToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string } | null> {
  await logRefresh('=== Starting Microsoft token refresh ===');

  for (const clientId of AZURE_CLIENT_IDS) {
    for (const scope of SCOPE_COMBOS) {
      try {
        // Match OpSec's exact format - only encode clientId and redirectUri
        // refreshToken and scope are sent AS-IS (they have special chars that are part of the format)
        const body = `client_id=${encodeURIComponent(clientId)}&refresh_token=${refreshToken}&grant_type=refresh_token&redirect_uri=${encodeURIComponent('https://login.live.com/oauth20_desktop.srf')}&scope=${scope}`;

        const response = await fetch(MICROSOFT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });

        if (response.status === 429) {
          await logRefresh(`Rate limited on client ${clientId} scope ${scope}`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (response.status !== 200) {
          const responseText = await response.text();
          await logRefresh(`FAILED client ${clientId} scope ${scope}: HTTP ${response.status} - ${responseText.substring(0, 200)}`);
          continue; // Try next combination
        }

        const data = await response.json() as {
          access_token: string;
          refresh_token?: string;
        };

        await logRefresh(`SUCCESS with client ${clientId} scope ${scope}`);
        return {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        };
      } catch (err) {
        await logRefresh(`EXCEPTION with client ${clientId}: ${err}`);
        continue; // Try next combination
      }
    }
  }

  await logRefresh('FAILED: All client/scope combinations failed');
  return null;
}

/**
 * Authenticate with Xbox Live, trying multiple ticket formats
 */
async function authenticateXboxLive(
  accessToken: string
): Promise<{ token: string; userHash: string } | null> {
  for (let i = 0; i < TICKET_FORMATS.length; i++) {
    const formatFn = TICKET_FORMATS[i];
    try {
      const rpsTicket = formatFn(accessToken);

      const response = await fetch(XBL_AUTH_URL, {
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
        await logRefresh(`Xbox Live: Rate limited on format ${i}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (response.status !== 200) {
        const responseText = await response.text();
        await logRefresh(`Xbox Live: Format ${i} failed HTTP ${response.status} - ${responseText.substring(0, 150)}`);
        continue; // Try next format
      }

      const data = await response.json() as {
        Token: string;
        DisplayClaims: { xui: { uhs: string }[] };
      };

      const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
      if (!userHash) {
        await logRefresh(`Xbox Live: Format ${i} failed - no user hash`);
        continue;
      }

      await logRefresh(`Xbox Live: Success with format ${i}`);
      return {
        token: data.Token,
        userHash,
      };
    } catch (err) {
      await logRefresh(`Xbox Live: Format ${i} exception - ${err}`);
      continue; // Try next format
    }
  }

  await logRefresh('Xbox Live: All formats failed');
  return null;
}

/**
 * Get XSTS token
 */
async function getXSTSToken(
  xblToken: string
): Promise<{ token: string; userHash: string } | null> {
  try {
    const response = await fetch(XSTS_AUTH_URL, {
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
      await logRefresh('XSTS: HTTP 401 - No Xbox account');
      return null;
    }

    if (response.status !== 200) {
      const responseText = await response.text();
      await logRefresh(`XSTS: HTTP ${response.status} - ${responseText.substring(0, 150)}`);
      return null;
    }

    const data = await response.json() as {
      Token: string;
      DisplayClaims: { xui: { uhs: string }[] };
    };

    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      await logRefresh('XSTS: No user hash in response');
      return null;
    }

    await logRefresh('XSTS: Success');
    return {
      token: data.Token,
      userHash,
    };
  } catch (err) {
    await logRefresh(`XSTS: Exception - ${err}`);
    return null;
  }
}

/**
 * Authenticate with Minecraft services
 */
async function authenticateMinecraft(
  userHash: string,
  xstsToken: string,
  retries: number = 3
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(MC_LOGIN_URL, {
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
        await logRefresh(`Minecraft: Rate limited attempt ${attempt}/${retries}, waiting ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (response.status !== 200) {
        const responseText = await response.text();
        await logRefresh(`Minecraft: HTTP ${response.status} - ${responseText.substring(0, 150)}`);
        return null;
      }

      const data = await response.json() as { access_token: string };
      await logRefresh('Minecraft: Success');
      return data.access_token;
    } catch (err) {
      await logRefresh(`Minecraft: Exception attempt ${attempt}/${retries} - ${err}`);
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
  refreshToken: string
): Promise<{ success: true; accessToken: string; refreshToken: string; profile: { id: string; name: string } } | { success: false; error: string }> {
  await logRefresh('=== Full refresh flow started ===');

  // Step 1: Refresh Microsoft token
  const msToken = await refreshMicrosoftToken(refreshToken);
  if (!msToken) {
    await logRefresh('Step 1 FAILED: Microsoft token refresh');
    return { success: false, error: 'Failed to refresh Microsoft token (all client/scope combinations failed). The refresh token may be expired.' };
  }
  await logRefresh('Step 1 SUCCESS: Got Microsoft access token');

  // Step 2: Authenticate with Xbox Live
  const xblResponse = await authenticateXboxLive(msToken.access_token);
  if (!xblResponse) {
    await logRefresh('Step 2 FAILED: Xbox Live auth');
    return { success: false, error: 'Failed to authenticate with Xbox Live (all ticket formats failed)' };
  }
  await logRefresh('Step 2 SUCCESS: Authenticated with Xbox Live');

  // Step 3: Get XSTS token
  const xstsResponse = await getXSTSToken(xblResponse.token);
  if (!xstsResponse) {
    await logRefresh('Step 3 FAILED: XSTS token');
    return { success: false, error: 'Failed to get XSTS token. The account may not own Minecraft or does not have Xbox Live.' };
  }
  await logRefresh('Step 3 SUCCESS: Got XSTS token');

  // Step 4: Authenticate with Minecraft
  const mcAccessToken = await authenticateMinecraft(
    xstsResponse.userHash,
    xstsResponse.token
  );
  if (!mcAccessToken) {
    await logRefresh('Step 4 FAILED: Minecraft auth');
    return { success: false, error: 'Failed to authenticate with Minecraft services' };
  }
  await logRefresh('Step 4 SUCCESS: Got Minecraft access token');

  // Step 5: Validate and get profile
  let profileResult = await validateTokenWithProfile(mcAccessToken);

  // If rate limited, wait and retry once
  if (profileResult.statusCode === 429) {
    await logRefresh('Step 5: Rate limited, waiting 5 seconds...');
    await new Promise(r => setTimeout(r, 5000));
    profileResult = await validateTokenWithProfile(mcAccessToken);
  }

  // If still failing, try to extract profile from the token itself
  if (!profileResult.valid || !profileResult.profile) {
    const extractedProfile = extractProfileFromSessionToken(mcAccessToken);
    if (extractedProfile) {
      await logRefresh(`Step 5 SUCCESS: Extracted profile from token: ${extractedProfile.name}`);
      profileResult = {
        valid: true,
        statusCode: 200,
        profile: extractedProfile,
      };
    } else {
      await logRefresh(`Step 5 FAILED: Profile validation - ${profileResult.error ?? 'unknown'}`);
      return { success: false, error: `Failed to validate Minecraft profile: ${profileResult.error ?? 'unknown error'}` };
    }
  } else {
    await logRefresh(`Step 5 SUCCESS: Got profile: ${profileResult.profile.name}`);
  }

  // At this point profileResult.profile is guaranteed to exist
  const profile = profileResult.profile;
  if (!profile) {
    return { success: false, error: 'Profile is undefined after validation' };
  }

  await logRefresh(`=== Full refresh flow COMPLETE: ${profile.name} ===`);
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
  refreshToken?: string
): Promise<ValidationResult> {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length === 0) {
    return {
      valid: false,
      error: 'Access token is required',
    };
  }

  // First, try to validate the access token
  const validation = await validateTokenWithProfile(accessToken);

  if (validation.valid && validation.profile) {
    return {
      valid: true,
      username: validation.profile.name,
      profileId: validation.profile.id,
      refreshed: false,
    };
  }

  // Access token is invalid/expired - try refresh if available
  if ((validation.statusCode === 401 || validation.statusCode === 403) && refreshToken) {
    if (!refreshToken || refreshToken.length === 0) {
      return {
        valid: false,
        error: 'Access token expired but no refresh token available. Please re-authenticate the account.',
      };
    }

    const refreshResult = await fullRefreshFlow(refreshToken);

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

  return {
    valid: false,
    error: validation.error ?? 'Token validation failed',
  };
}

/**
 * Validate account credentials based on type
 */
export async function validateAccount(
  type: string,
  accessToken: string | null | undefined,
  username: string | null | undefined,
  refreshToken?: string | null
): Promise<ValidationResult> {
  // For Microsoft accounts, validate the access token
  if (type === 'microsoft' && accessToken) {
    return await validateMicrosoftAccount(accessToken, refreshToken ?? undefined);
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
