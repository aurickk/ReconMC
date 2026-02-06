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
import { logger } from '../logger.js';

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
 * Microsoft OAuth endpoints
 */
const MICROSOFT_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/**
 * Azure client IDs to try for token refresh
 * Refresh tokens are tied to the issuing client, so we try multiple
 */
const AZURE_CLIENT_IDS = [
  '00000000402b5328',  // Minecraft public client
  '000000004C12AE6F',  // Xbox App
  '00000000441cc96b',  // Minecraft iOS
  '810e1c10-3b3c-4d4f-be0b-f7e9a01e8b98',  // Common launcher client
  '00000000-02bd-5e32-b7bb-0f2afcbe97f8',  // Minecraft Android
];

/**
 * Scope combinations to try for token refresh
 */
const SCOPE_COMBOS = [
  'XboxLive.signin offline_access',
  'XboxLive.signin%20offline_access',
  'service::user.auth.xboxlive.com::MBI_SSL',
  'XboxLive.signin',
];

/**
 * RpsTicket formats to try for Xbox Live authentication
 */
const TICKET_FORMATS = [
  (token: string) => `d=${token}`,   // Standard format for consumer accounts
  (token: string) => `t=${token}`,   // Alternative format
  (token: string) => token,           // Raw token
];

/**
 * Result of profile validation with status code
 */
interface ProfileValidationResult {
  valid: boolean;
  statusCode: number;
  profile?: { id: string; name: string };
  error?: string;
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
 * Validate token against Minecraft profile API
 * Returns validation result with status code
 */
async function validateTokenWithProfile(
  accessToken: string
): Promise<ProfileValidationResult> {
  try {
    const response = await fetch(MC_PROFILE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const statusCode = response.status;

    if (statusCode === 429) {
      logger.debug('[validateTokenWithProfile] Rate limited');
      return { valid: false, statusCode, error: 'Rate limited' };
    }

    if (statusCode === 401 || statusCode === 403) {
      logger.debug(`[validateTokenWithProfile] Token invalid/expired: HTTP ${statusCode}`);
      return { valid: false, statusCode, error: 'Token invalid or expired' };
    }

    if (statusCode !== 200) {
      logger.debug(`[validateTokenWithProfile] Failed to validate: HTTP ${statusCode}`);
      return { valid: false, statusCode, error: `HTTP ${statusCode}` };
    }

    const data = await response.json() as { id?: string; name?: string; error?: string };

    if (data.error || !data.id || !data.name) {
      logger.debug(`[validateTokenWithProfile] Invalid profile response`);
      return { valid: false, statusCode, error: 'Invalid profile response' };
    }

    return {
      valid: true,
      statusCode,
      profile: { id: data.id, name: data.name },
    };
  } catch (err) {
    logger.error('[validateTokenWithProfile] Error:', err);
    return { valid: false, statusCode: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Refresh Microsoft token with multiple client IDs and scopes
 */
async function refreshMicrosoftToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string } | null> {
  for (const clientId of AZURE_CLIENT_IDS) {
    for (const scope of SCOPE_COMBOS) {
      try {
        const body = new URLSearchParams({
          client_id: clientId,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
          scope,
        });

        const response = await fetch(MICROSOFT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });

        if (response.status === 429) {
          logger.debug('[refreshMicrosoftToken] Rate limited, waiting...');
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

        logger.debug(`[refreshMicrosoftToken] Success with client: ${clientId}`);
        return {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        };
      } catch {
        continue; // Try next combination
      }
    }
  }

  logger.error('[refreshMicrosoftToken] All client/scope combinations failed');
  return null;
}

/**
 * Authenticate with Xbox Live, trying multiple ticket formats
 */
async function authenticateXboxLive(
  accessToken: string
): Promise<{ token: string; userHash: string } | null> {
  for (const formatFn of TICKET_FORMATS) {
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
        logger.debug('[authenticateXboxLive] Rate limited, waiting...');
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
        logger.error('[authenticateXboxLive] No user hash in response');
        continue;
      }

      logger.debug('[authenticateXboxLive] Authentication successful');
      return {
        token: data.Token,
        userHash,
      };
    } catch {
      continue; // Try next format
    }
  }

  logger.error('[authenticateXboxLive] All ticket formats failed');
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
      logger.error('[getXSTSToken] XSTS denied: No Xbox account');
      return null;
    }

    if (response.status !== 200) {
      logger.error(`[getXSTSToken] Failed: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      Token: string;
      DisplayClaims: { xui: { uhs: string }[] };
    };

    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      logger.error('[getXSTSToken] No user hash in XSTS response');
      return null;
    }

    logger.debug('[getXSTSToken] XSTS token obtained');
    return {
      token: data.Token,
      userHash,
    };
  } catch (err) {
    logger.error('[getXSTSToken] Error:', err);
    return null;
  }
}

/**
 * Authenticate with Minecraft services
 * Includes retry logic for rate limiting (429)
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
        const waitTime = attempt * 5000; // 5s, 10s, 15s
        logger.debug(`[authenticateMinecraft] Rate limited, waiting ${waitTime/1000}s before retry ${attempt}/${retries}...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (response.status !== 200) {
        logger.error(`[authenticateMinecraft] Failed: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json() as { access_token: string };
      logger.debug('[authenticateMinecraft] Minecraft token obtained');
      return data.access_token;
    } catch (err) {
      logger.error('[authenticateMinecraft] Error:', err);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return null;
    }
  }
  
  logger.error('[authenticateMinecraft] All retries exhausted');
  return null;
}

/**
 * Full refresh flow: Microsoft -> Xbox Live -> XSTS -> Minecraft
 * Returns all intermediate tokens needed for prismarine-auth cache
 */
async function fullRefreshFlow(
  refreshToken: string
): Promise<AuthResult> {
  logger.debug('[fullRefreshFlow] Starting full refresh flow...');

  // Step 1: Refresh Microsoft token
  const msToken = await refreshMicrosoftToken(refreshToken);
  if (!msToken) {
    return { success: false, error: 'Failed to refresh Microsoft token' };
  }

  // Step 2: Authenticate with Xbox Live
  const xblResponse = await authenticateXboxLive(msToken.access_token);
  if (!xblResponse) {
    return { success: false, error: 'Failed to authenticate with Xbox Live' };
  }

  // Step 3: Get XSTS token
  const xstsResponse = await getXSTSToken(xblResponse.token);
  if (!xstsResponse) {
    return { success: false, error: 'Failed to get XSTS token' };
  }

  // Step 4: Authenticate with Minecraft
  const mcAccessToken = await authenticateMinecraft(
    xstsResponse.userHash,
    xstsResponse.token
  );
  if (!mcAccessToken) {
    return { success: false, error: 'Failed to authenticate with Minecraft' };
  }

  // Step 5: Validate and get profile
  // If rate limited, try to extract profile from the token or retry
  let profileResult = await validateTokenWithProfile(mcAccessToken);
  
  // If rate limited, wait and retry once
  if (profileResult.statusCode === 429) {
    logger.debug('[fullRefreshFlow] Rate limited, waiting 5 seconds before retry...');
    await new Promise(r => setTimeout(r, 5000));
    profileResult = await validateTokenWithProfile(mcAccessToken);
  }
  
  // If still failing, try to extract profile from the token itself
  if (!profileResult.valid || !profileResult.profile) {
    const extractedProfile = extractProfileFromSessionToken(mcAccessToken);
    if (extractedProfile) {
      logger.debug(`[fullRefreshFlow] Extracted profile from token: ${extractedProfile.name}`);
      profileResult = {
        valid: true,
        statusCode: 200,
        profile: extractedProfile,
      };
    } else {
      return { success: false, error: `Failed to validate Minecraft token: ${profileResult.error ?? 'unknown'}` };
    }
  }

  // At this point, profileResult is guaranteed to have a profile
  const finalProfile = profileResult.profile!;
  logger.debug(`[fullRefreshFlow] Refresh successful: ${finalProfile.name}`);

  // Token expires in 24 hours (typical for Minecraft tokens)
  const expiresOn = Date.now() + (24 * 60 * 60 * 1000);

  return {
    success: true,
    accessToken: mcAccessToken,
    refreshToken: msToken.refresh_token ?? refreshToken,
    profile: finalProfile,
    userHash: xstsResponse.userHash,
    refreshed: true,  // Mark that tokens were refreshed
    // Include all tokens for prismarine-auth cache
    msAccessToken: msToken.access_token,
    xblToken: xblResponse.token,
    xstsToken: xstsResponse.token,
    expiresOn,
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
  account: MicrosoftTokenAccount
): Promise<AuthResult> {
  try {
    // First, try to validate the session token against the profile API
    logger.debug('[authenticateWithToken] Validating session token...');
    const validation = await validateTokenWithProfile(account.accessToken);

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

    // Session token is invalid (401/403) or rate limited (429) - try refresh if available
    if ((validation.statusCode === 401 || validation.statusCode === 403 || validation.statusCode === 429) && account.refreshToken) {
      if (validation.statusCode === 429) {
        logger.debug('[authenticateWithToken] Rate limited on validation, proceeding with refresh flow...');
      } else {
        logger.debug('[authenticateWithToken] Session token expired, attempting refresh...');
      }
      const result = await fullRefreshFlow(account.refreshToken);

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
    }

    // Other error or no refresh token available
    return {
      success: false,
      error: validation.error ?? 'Token validation failed',
    };
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
