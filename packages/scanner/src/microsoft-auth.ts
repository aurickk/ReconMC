/**
 * Microsoft Authentication Module (Simplified)
 *
 * Contains only token validation and profile extraction functions.
 * OAuth chain (refresh, Xbox Live, XSTS, Minecraft auth) has been removed --
 * session tokens are now externally provided and disposable.
 */

/**
 * Minecraft profile API endpoint
 */
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

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
 * Uses cache to avoid repeated API calls for recently validated tokens.
 */
export async function validateTokenWithProfile(
  accessToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
  bypassCache = false
): Promise<ProfileValidationResult> {
  if (!bypassCache) {
    const cached = getCachedTokenValidity(accessToken);
    if (cached) {
      return {
        valid: cached.valid,
        statusCode: cached.valid ? 200 : 401,
        profile: cached.profile,
        error: cached.valid ? undefined : 'Token invalid (cached)',
      };
    }
  }

  try {
    const response = await fetchFn(MC_PROFILE_URL, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const statusCode = response.status;

    if (statusCode === 429) {
      return { valid: false, statusCode, error: 'Rate limited' };
    }

    if (statusCode === 401 || statusCode === 403) {
      setCachedTokenValidity(accessToken, false);
      return { valid: false, statusCode, error: 'Token invalid or expired' };
    }

    if (statusCode !== 200) {
      return { valid: false, statusCode, error: `HTTP ${statusCode}` };
    }

    const data = await response.json() as { id?: string; name?: string; error?: string };

    if (data.error || !data.id || !data.name) {
      setCachedTokenValidity(accessToken, false);
      return { valid: false, statusCode, error: 'Invalid profile response' };
    }

    const profile = { id: data.id, name: data.name };
    setCachedTokenValidity(accessToken, true, profile);
    return { valid: true, statusCode, profile };
  } catch (err) {
    return { valid: false, statusCode: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Token validity cache - avoids repeated profile validation calls.
 * Key: hash of access token. Value: { valid, profile, expiresAt }.
 */
const tokenValidityCache = new Map<string, { valid: boolean; profile?: { id: string; name: string }; expiresAt: number }>();
const TOKEN_VALIDITY_TTL = 5 * 60 * 1000; // 5 minutes
const TOKEN_CACHE_MAX = 1000;

function hashToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(16);
}

export function getCachedTokenValidity(accessToken: string): { valid: boolean; profile?: { id: string; name: string } } | null {
  const key = hashToken(accessToken);
  const entry = tokenValidityCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenValidityCache.delete(key);
    return null;
  }
  return { valid: entry.valid, profile: entry.profile };
}

export function setCachedTokenValidity(accessToken: string, valid: boolean, profile?: { id: string; name: string }): void {
  const key = hashToken(accessToken);
  if (tokenValidityCache.size >= TOKEN_CACHE_MAX && !tokenValidityCache.has(key)) {
    const firstKey = tokenValidityCache.keys().next().value;
    if (firstKey !== undefined) tokenValidityCache.delete(firstKey);
  }
  tokenValidityCache.set(key, { valid, profile, expiresAt: Date.now() + TOKEN_VALIDITY_TTL });
}

export function clearTokenValidityCache(): void {
  tokenValidityCache.clear();
}
