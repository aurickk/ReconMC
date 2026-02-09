/**
 * Shared Microsoft Authentication Module
 *
 * This module contains the core Microsoft OAuth authentication flow
 * shared between the bot and coordinator packages.
 *
 * Flow: Microsoft -> Xbox Live -> XSTS -> Minecraft
 */

/**
 * Microsoft OAuth endpoints
 */
export const MICROSOFT_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
export const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
export const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
export const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/**
 * Azure client IDs to try for token refresh
 * Refresh tokens are tied to the issuing client, so we try multiple
 */
export const AZURE_CLIENT_IDS = [
  '00000000402b5328',  // Minecraft public client
  '000000004C12AE6F',  // Xbox App
  '00000000441cc96b',  // Minecraft iOS
  '810e1c10-3b3c-4d4f-be0b-f7e9a01e8b98',  // Common launcher client
  '00000000-02bd-5e32-b7bb-0f2afcbe97f8',  // Minecraft Android
] as const;

/**
 * Scope combinations to try for token refresh
 * Must match the scopes used when the refresh token was issued
 */
export const SCOPE_COMBOS = [
  'XboxLive.signin%20XboxLive.offline_access',  // Full Xbox Live scope (OpSec style)
  'XboxLive.signin%20offline_access',            // Alternative encoding
  'service::user.auth.xboxlive.com::MBI_SSL',    // Service-based scope
  'XboxLive.signin',                             // Minimal scope
] as const;

/**
 * RpsTicket formats to try for Xbox Live authentication
 */
export const TICKET_FORMATS = [
  (token: string) => `d=${token}`,   // Standard format for consumer accounts
  (token: string) => `t=${token}`,   // Alternative format
  (token: string) => token,           // Raw token
] as const;

/**
 * Result of profile validation with status code
 */
export interface ProfileValidationResult {
  valid: boolean;
  statusCode: number;
  profile?: { id: string; name: string };
  error?: string;
}

/**
 * Result of Microsoft token refresh
 */
export interface MicrosoftTokenRefreshResult {
  access_token: string;
  refresh_token?: string;
}

/**
 * Result of Xbox Live authentication
 */
export interface XboxLiveAuthResult {
  token: string;
  userHash: string;
}

/**
 * Extract profile from a Minecraft Launcher session token JWT
 */
export function extractProfileFromSessionToken(token: string): { id: string; name: string } | null {
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
export async function validateTokenWithProfile(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<ProfileValidationResult> {
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
 * LRU-style cache for the working clientId+scope combination per refresh token prefix.
 * Key: first 16 chars of refresh token (enough to identify the account).
 * Value: { clientId, scope } that last worked.
 * Entries auto-expire after 24h to handle token re-issues.
 */
const comboCache = new Map<string, { clientId: string; scope: string; ts: number }>();
const COMBO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const COMBO_CACHE_MAX = 500;

function getCacheKey(refreshToken: string): string {
  return refreshToken.slice(0, 16);
}

function getCachedCombo(refreshToken: string): { clientId: string; scope: string } | null {
  const key = getCacheKey(refreshToken);
  const entry = comboCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > COMBO_CACHE_TTL) {
    comboCache.delete(key);
    return null;
  }
  return { clientId: entry.clientId, scope: entry.scope };
}

function setCachedCombo(refreshToken: string, clientId: string, scope: string): void {
  const key = getCacheKey(refreshToken);
  // Evict oldest entry if cache is full
  if (comboCache.size >= COMBO_CACHE_MAX && !comboCache.has(key)) {
    const firstKey = comboCache.keys().next().value;
    if (firstKey !== undefined) comboCache.delete(firstKey);
  }
  comboCache.set(key, { clientId, scope, ts: Date.now() });
}

/**
 * Try a single clientId+scope combination for token refresh
 */
async function tryRefreshCombo(
  refreshToken: string,
  clientId: string,
  scope: string,
  fetchFn: typeof fetch
): Promise<MicrosoftTokenRefreshResult | null> {
  try {
    const body = `client_id=${encodeURIComponent(clientId)}&refresh_token=${refreshToken}&grant_type=refresh_token&redirect_uri=${encodeURIComponent('https://login.live.com/oauth20_desktop.srf')}&scope=${scope}`;

    const response = await fetchFn(MICROSOFT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
      return null;
    }

    if (response.status !== 200) return null;

    const data = await response.json() as MicrosoftTokenRefreshResult;
    return { access_token: data.access_token, refresh_token: data.refresh_token };
  } catch {
    return null;
  }
}

/**
 * Refresh Microsoft token with multiple client IDs and scopes.
 * Caches which clientId+scope combination works per refresh token so
 * subsequent refreshes skip straight to the working combo (1 HTTP call instead of up to 20).
 *
 * IMPORTANT: refreshToken is NOT encoded - it contains special characters that are part of the token format.
 */
export async function refreshMicrosoftToken(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<MicrosoftTokenRefreshResult | null> {
  // Fast path: try the cached combination first
  const cached = getCachedCombo(refreshToken);
  if (cached) {
    const result = await tryRefreshCombo(refreshToken, cached.clientId, cached.scope, fetchFn);
    if (result) return result;
    // Cached combo failed (token may have been re-issued), fall through to full scan
  }

  // Slow path: try all combinations
  for (const clientId of AZURE_CLIENT_IDS) {
    for (const scope of SCOPE_COMBOS) {
      const result = await tryRefreshCombo(refreshToken, clientId, scope, fetchFn);
      if (result) {
        // Cache the working combination for next time
        setCachedCombo(refreshToken, clientId, scope);
        return result;
      }
    }
  }

  return null;
}

/**
 * Authenticate with Xbox Live, trying multiple ticket formats
 */
export async function authenticateXboxLive(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<XboxLiveAuthResult | null> {
  for (const formatFn of TICKET_FORMATS) {
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
export async function getXSTSToken(
  xblToken: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<XboxLiveAuthResult | null> {
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
 * Result of a full Microsoft -> Xbox Live -> XSTS -> Minecraft refresh flow
 */
export interface FullRefreshFlowResult {
  success: boolean;
  error?: string;
  accessToken?: string;       // Minecraft access token
  refreshToken?: string;      // New Microsoft refresh token
  profile?: { id: string; name: string };
  // Extended token data (used by bot for prismarine-auth cache)
  msAccessToken?: string;     // Microsoft access token
  xblToken?: string;          // Xbox Live token
  xstsToken?: string;         // XSTS token
  userHash?: string;          // Xbox Live user hash
  expiresOn?: number;         // Token expiration timestamp
}

/**
 * Optional logger interface for fullRefreshFlow debug/error output
 */
export interface RefreshFlowLogger {
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/**
 * Full refresh flow: Microsoft -> Xbox Live -> XSTS -> Minecraft
 * Shared between bot and coordinator — extracted to avoid duplication.
 */
export async function fullRefreshFlow(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
  log?: RefreshFlowLogger,
): Promise<FullRefreshFlowResult> {
  log?.debug?.('[fullRefreshFlow] Starting full refresh flow...');

  // Step 1: Refresh Microsoft token
  const msToken = await refreshMicrosoftToken(refreshToken, fetchFn);
  if (!msToken) {
    log?.error?.('[fullRefreshFlow] Failed at step 1: Microsoft token refresh (all client/scope combinations failed)');
    return { success: false, error: 'Failed to refresh Microsoft token (all client/scope combinations failed). The refresh token may be expired.' };
  }

  // Step 2: Authenticate with Xbox Live
  const xblResponse = await authenticateXboxLive(msToken.access_token, fetchFn);
  if (!xblResponse) {
    log?.error?.('[fullRefreshFlow] Failed at step 2: Xbox Live authentication (all ticket formats failed)');
    return { success: false, error: 'Failed to authenticate with Xbox Live (all ticket formats failed)' };
  }

  // Step 3: Get XSTS token
  const xstsResponse = await getXSTSToken(xblResponse.token, fetchFn);
  if (!xstsResponse) {
    log?.error?.('[fullRefreshFlow] Failed at step 3: XSTS token (account may not own Minecraft or does not have Xbox Live)');
    return { success: false, error: 'Failed to get XSTS token. The account may not own Minecraft or does not have Xbox Live.' };
  }

  // Step 4: Authenticate with Minecraft
  const mcAccessToken = await authenticateMinecraft(xstsResponse.userHash, xstsResponse.token, 3, fetchFn);
  if (!mcAccessToken) {
    log?.error?.('[fullRefreshFlow] Failed at step 4: Minecraft authentication');
    return { success: false, error: 'Failed to authenticate with Minecraft services' };
  }

  // Step 5: Validate and get profile (retry once on rate limit)
  let profileResult = await validateTokenWithProfile(mcAccessToken, fetchFn);
  if (profileResult.statusCode === 429) {
    log?.debug?.('[fullRefreshFlow] Rate limited, waiting 5 seconds before retry...');
    await new Promise(r => setTimeout(r, 5000));
    profileResult = await validateTokenWithProfile(mcAccessToken, fetchFn);
  }

  // Fall back to extracting profile from the JWT if validation fails
  if (!profileResult.valid || !profileResult.profile) {
    const extractedProfile = extractProfileFromSessionToken(mcAccessToken);
    if (extractedProfile) {
      log?.debug?.(`[fullRefreshFlow] Extracted profile from token: ${extractedProfile.name}`);
      profileResult = { valid: true, statusCode: 200, profile: extractedProfile };
    } else {
      log?.error?.(`[fullRefreshFlow] Failed at step 5: Profile validation - ${profileResult.error ?? 'unknown'}`);
      return { success: false, error: `Failed to validate Minecraft profile: ${profileResult.error ?? 'unknown error'}` };
    }
  }

  const profile = profileResult.profile!;
  log?.debug?.(`[fullRefreshFlow] Refresh successful: ${profile.name}`);

  const expiresOn = Date.now() + (24 * 60 * 60 * 1000); // 24h typical for MC tokens

  return {
    success: true,
    accessToken: mcAccessToken,
    refreshToken: msToken.refresh_token ?? refreshToken,
    profile,
    msAccessToken: msToken.access_token,
    xblToken: xblResponse.token,
    xstsToken: xstsResponse.token,
    userHash: xstsResponse.userHash,
    expiresOn,
  };
}

/**
 * Authenticate with Minecraft services
 * Includes retry logic for rate limiting (429)
 */
export async function authenticateMinecraft(
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
        const waitTime = attempt * 5000; // 5s, 10s, 15s
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
