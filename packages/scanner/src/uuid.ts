/**
 * UUID validation and server mode detection utilities
 * Moved from discord-bot to scanner package for centralized business logic
 * 
 * Uses multiple API providers with fallback:
 * 1. Minetools API (primary) - https://api.minetools.eu/
 * 2. PlayerDB API (fallback) - https://playerdb.co/
 */
import { logger } from './logger.js';

interface MinetoolsUUIDResponse {
  id?: string;
  name?: string;
  status: 'OK' | 'ERR';
  errorMessage?: string;
}

interface PlayerDBResponse {
  code: string;
  message: string;
  data: {
    player: {
      username: string;
      id: string;
      avatar: string;
      meta?: {
        cached_at?: number;
      };
    } | null;
  };
  success: boolean;
}

/** Player sample from Minecraft server status response */
interface ServerPlayer {
  id: string;
  name: string;
}

/** Result of UUID verification */
interface UUIDVerifyResult {
  result: 'valid' | 'invalid' | 'error';
  uuid?: string;
  name?: string;
}

/**
 * Validate if a string is a valid Minecraft UUID format
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
function isValidUUIDFormat(uuid: string): boolean {
  if (!uuid || typeof uuid !== 'string') {
    return false;
  }

  // Validate UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Convert UUID to trimmed format (without dashes) for API
 */
function toTrimmedUUID(uuid: string): string {
  return uuid.replace(/-/g, '');
}

/**
 * Format a trimmed UUID (32 chars) to standard format with dashes
 */
function formatUUID(trimmedUuid: string): string {
  if (trimmedUuid.length === 32) {
    return `${trimmedUuid.substring(0, 8)}-${trimmedUuid.substring(8, 12)}-${trimmedUuid.substring(12, 16)}-${trimmedUuid.substring(16, 20)}-${trimmedUuid.substring(20, 32)}`;
  }
  return trimmedUuid;
}


/**
 * Verify a UUID with Minetools API (primary provider)
 * Uses https://api.minetools.eu/uuid/ which has caching and better rate limits
 */
async function verifyWithMinetools(uuid: string): Promise<UUIDVerifyResult> {
  const trimmedUUID = toTrimmedUUID(uuid);
  const apiUrl = `https://api.minetools.eu/uuid/${trimmedUUID}`;

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(3000), // 3 second timeout
  });

  if (!response.ok) {
    logger.warn(`[UUID Validation] Minetools HTTP error ${response.status} for UUID ${uuid}`);
    return { result: 'error', uuid };
  }

  const data = await response.json() as MinetoolsUUIDResponse;

  // Check if the API itself had an error (e.g., Mojang servers down)
  if (data.status === 'ERR') {
    // Check if it's a Mojang API error vs just "not found"
    if (data.errorMessage?.toLowerCase().includes('mojang') ||
        data.errorMessage?.toLowerCase().includes('servers') ||
        data.errorMessage?.toLowerCase().includes('issues')) {
      logger.warn(`[UUID Validation] Minetools: Mojang API error for UUID ${uuid}: ${data.errorMessage}`);
      return { result: 'error', uuid }; // API error, try fallback
    }
    // Otherwise, UUID not found in database (cracked)
    logger.debug(`[UUID Validation] Minetools: UUID ${uuid} not found in database`);
    return { result: 'invalid', uuid };
  }

  // Check if the API returned a valid response
  if (data.status === 'OK' && data.id && data.name) {
    const validatedUuid = formatUUID(data.id);
    logger.debug(`[UUID Validation] Minetools: UUID ${uuid} validated to ${validatedUuid} (${data.name})`);
    return { result: 'valid', uuid: validatedUuid, name: data.name };
  }

  // Invalid or fake UUID - not found in database
  logger.debug(`[UUID Validation] Minetools: UUID ${uuid} validation failed: ${JSON.stringify(data)}`);
  return { result: 'invalid', uuid };
}

/**
 * Verify a UUID with PlayerDB API (fallback provider)
 * Uses https://playerdb.co/api/player/minecraft/ 
 * Note: PlayerDB has no rate limits but requests should include User-Agent
 */
async function verifyWithPlayerDB(uuid: string): Promise<UUIDVerifyResult> {
  const trimmedUUID = toTrimmedUUID(uuid);
  const apiUrl = `https://playerdb.co/api/player/minecraft/${trimmedUUID}`;

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'ReconMC/1.0 (Minecraft Server Scanner)',
    },
    signal: AbortSignal.timeout(5000), // 5 second timeout (PlayerDB can be slower)
  });

  if (!response.ok) {
    logger.warn(`[UUID Validation] PlayerDB HTTP error ${response.status} for UUID ${uuid}`);
    return { result: 'error', uuid };
  }

  const data = await response.json() as PlayerDBResponse;

  // Check if the request was successful
  if (data.success && data.data?.player) {
    const player = data.data.player;
    const validatedUuid = formatUUID(player.id.replace(/-/g, ''));
    logger.debug(`[UUID Validation] PlayerDB: UUID ${uuid} validated to ${validatedUuid} (${player.username})`);
    return { result: 'valid', uuid: validatedUuid, name: player.username };
  }

  // Player not found - UUID doesn't exist in Mojang database
  if (data.code === 'minecraft.invalid_username' || data.code === 'minecraft.api_failure' || !data.success) {
    // Check if it's an API failure vs not found
    if (data.message?.toLowerCase().includes('api') || data.message?.toLowerCase().includes('error')) {
      logger.warn(`[UUID Validation] PlayerDB: API error for UUID ${uuid}: ${data.message}`);
      return { result: 'error', uuid };
    }
    logger.debug(`[UUID Validation] PlayerDB: UUID ${uuid} not found in database`);
    return { result: 'invalid', uuid };
  }

  logger.debug(`[UUID Validation] PlayerDB: UUID ${uuid} validation failed: ${JSON.stringify(data)}`);
  return { result: 'invalid', uuid };
}

/**
 * Verify a UUID with multiple API providers (with fallback)
 * Primary: Minetools API
 * Fallback: PlayerDB API
 * Returns: { result: 'valid' | 'invalid' | 'error', uuid?: string, name?: string }
 */
async function verifyUUIDWithMinetools(uuid: string): Promise<UUIDVerifyResult> {
  // Try Minetools first (primary provider)
  try {
    const result = await verifyWithMinetools(uuid);
    
    // If we got a definitive result (valid or invalid), return it
    if (result.result !== 'error') {
      return result;
    }
    
    // Minetools returned an error, try fallback
    logger.debug(`[UUID Validation] Minetools failed, trying PlayerDB fallback for UUID ${uuid}`);
  } catch (error) {
    logger.warn(`[UUID Validation] Minetools exception for UUID ${uuid}:`, error);
    // Fall through to try PlayerDB
  }

  // Try PlayerDB as fallback
  try {
    const result = await verifyWithPlayerDB(uuid);
    return result;
  } catch (error) {
    logger.warn(`[UUID Validation] PlayerDB exception for UUID ${uuid}:`, error);
    return { result: 'error', uuid };
  }
}

/**
 * Validate if a string is a valid Minecraft UUID
 * This performs both format validation AND Minetools API verification
 * Returns false for API errors (use detectServerMode for proper handling)
 */
export async function isValidMinecraftUUID(uuid: string): Promise<boolean> {
  // First check format
  if (!isValidUUIDFormat(uuid)) {
    return false;
  }

  // Then verify with Minetools API (uses cached Mojang data)
  const result = await verifyUUIDWithMinetools(uuid);
  return result.result === 'valid'; // Return false for both invalid and API errors
}

/**
 * Synchronously validate UUID format (without API call)
 * This is a lightweight check that only validates the format
 */
export function isValidUUIDFormatSync(uuid: string): boolean {
  return isValidUUIDFormat(uuid);
}

/**
 * Validate a player object and return UUID validation result
 * This performs actual API verification with Mojang
 */
export async function validatePlayerUUID(player: ServerPlayer | Partial<ServerPlayer>): Promise<{ valid: boolean; uuid?: string }> {
  if (!player || !player.id) {
    return { valid: false };
  }

  const uuid = player.id;
  const valid = await isValidMinecraftUUID(uuid);
  return { valid, uuid };
}

/**
 * Validate a player object synchronously (format check only)
 * This is faster but doesn't verify the UUID with Mojang
 */
export function validatePlayerUUIDSync(player: ServerPlayer | Partial<ServerPlayer>): { valid: boolean; uuid?: string } {
  if (!player || !player.id) {
    return { valid: false };
  }

  const uuid = player.id;
  const valid = isValidUUIDFormatSync(uuid);
  return { valid, uuid };
}

/**
 * Result of server mode detection with validated player data
 */
export interface ServerModeDetectionResult {
  serverMode: 'online' | 'cracked' | 'unknown';
  validatedPlayers: Array<{ name: string; id: string; originalId?: string }>;
}

/**
 * Detect if a server is in online mode or cracked/offline mode
 * based on player UUIDs (with Mojang API verification)
 * Returns both the server mode and the validated player UUIDs
 */
export async function detectServerMode(players: Array<ServerPlayer | Partial<ServerPlayer>>): Promise<ServerModeDetectionResult> {
  const validatedPlayers: Array<{ name: string; id: string; originalId?: string }> = [];
  const defaultResult: ServerModeDetectionResult = {
    serverMode: 'unknown',
    validatedPlayers: players.map((p) => ({ name: p?.name || 'Unknown', id: p?.id || '', originalId: p?.id })),
  };

  if (!players || players.length === 0) {
    return defaultResult; // Can't determine - no players
  }

  // Check all players' UUIDs with Mojang API
  const validationPromises = players.map(async (p) => {
    if (!p?.id) return { player: p, result: { result: 'error' as const, uuid: p?.id || '' } };
    const result = await verifyUUIDWithMinetools(p.id);
    return { player: p, result };
  });

  const validations = await Promise.all(validationPromises);

  // Build validated players array and collect results
  const apiErrors: UUIDVerifyResult[] = [];
  const validResults: UUIDVerifyResult[] = [];

  for (const { player, result } of validations) {
    validatedPlayers.push({
      name: player?.name || 'Unknown',
      id: result.uuid || player?.id || '',
      originalId: player?.id,
    });

    if (result.result === 'error') {
      apiErrors.push(result);
    } else if (result.result === 'valid') {
      validResults.push(result);
    } else {
      validResults.push(result);
    }
  }

  // If all API calls failed, can't determine
  if (apiErrors.length === validations.length) {
    logger.warn(`[ServerMode] All UUID checks failed (API errors), returning unknown`);
    return { serverMode: 'unknown', validatedPlayers };
  }

  // If we have significant API errors (more than 50%), return unknown to be safe
  if (apiErrors.length > validations.length / 2) {
    logger.warn(`[ServerMode] Too many API errors (${apiErrors.length}/${validations.length}), returning unknown`);
    return { serverMode: 'unknown', validatedPlayers };
  }

  // Check the actual validation results
  const hasValidUUID = validResults.some((r) => r.result === 'valid');
  const hasInvalidUUID = validResults.some((r) => r.result === 'invalid');

  let serverMode: 'online' | 'cracked' | 'unknown';
  if (hasValidUUID && !hasInvalidUUID) {
    serverMode = 'online';
  } else if (hasInvalidUUID && !hasValidUUID) {
    serverMode = 'cracked';
  } else if (hasValidUUID && hasInvalidUUID) {
    // Mixed results - some valid, some invalid
    // Could be a mixed-mode server or detection error, return unknown to be safe
    serverMode = 'unknown';
  } else {
    serverMode = 'unknown';
  }

  return { serverMode, validatedPlayers };
}

/**
 * Synchronously detect server mode (format check only)
 * This is faster but may have false positives for offline-mode servers with formatted UUIDs
 * Returns 'unknown' for ambiguous cases to be safe
 */
export function detectServerModeSync(players: Array<ServerPlayer | Partial<ServerPlayer>>): 'online' | 'cracked' | 'unknown' {
  if (!players || players.length === 0) {
    return 'unknown';
  }

  let hasValidFormat = false;
  let hasInvalidFormat = false;

  for (const p of players) {
    if (!p?.id) continue;

    if (isValidUUIDFormatSync(p.id)) {
      hasValidFormat = true;
    } else {
      hasInvalidFormat = true;
    }
  }

  // Only return 'online' if all UUIDs have valid format (no invalid ones)
  if (hasValidFormat && !hasInvalidFormat) {
    return 'online';
  }

  // For any other case (invalid formats or mixed), return 'unknown' to be safe
  // The format check alone isn't reliable enough to declare a server as 'cracked'
  return 'unknown';
}
