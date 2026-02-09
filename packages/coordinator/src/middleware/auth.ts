import { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';

const API_KEYS = new Set<string>();
const envKey = process.env.RECONMC_API_KEY;
const AUTH_DISABLED = process.env.RECONMC_DISABLE_AUTH === 'true';

if (envKey) {
  API_KEYS.add(envKey.trim());
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Skip auth check if disabled
  if (AUTH_DISABLED) {
    request.log.info({ apiKey: 'AUTH_DISABLED' }, 'API request');
    return;
  }

  const apiKey = request.headers['x-api-key'] as string;

  if (!apiKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // Use timing-safe comparison for API key validation
  if (!timingSafeAny(apiKey, API_KEYS)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // Add hook for logging (redacted key)
  request.log.info({ apiKey: apiKey.substring(0, 8) + '...' }, 'API request');
}

/**
 * Timing-safe check if a value equals any value in a Set
 * Prevents timing attacks by comparing against all values
 */
function timingSafeAny(value: string, validValues: Set<string>): boolean {
  const valueBuffer = Buffer.from(value, 'utf-8');

  for (const validValue of validValues) {
    const validBuffer = Buffer.from(validValue, 'utf-8');

    // Skip comparison if lengths differ (timing-safe check still done)
    if (valueBuffer.length !== validBuffer.length) {
      // Still do a dummy comparison to maintain constant time
      crypto.timingSafeEqual(valueBuffer, valueBuffer);
      continue;
    }

    if (crypto.timingSafeEqual(valueBuffer, validBuffer)) {
      return true;
    }
  }

  // Always do one final dummy comparison to prevent empty Set short-circuit
  crypto.timingSafeEqual(valueBuffer, valueBuffer);
  return false;
}

export function isAuthDisabled(): boolean {
  return AUTH_DISABLED;
}

/**
 * Generate a secure random agent secret
 */
export function generateAgentSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash an agent secret for storage
 * Uses SHA-256 for simple but secure hashing
 * For production, consider using bcrypt/scrypt with a salt
 */
export function hashAgentSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Timing-safe comparison of agent secrets
 */
export function compareAgentSecret(secret: string, hashedSecret: string): boolean {
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(secretHash, 'hex'),
    Buffer.from(hashedSecret, 'hex')
  );
}
