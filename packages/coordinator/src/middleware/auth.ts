import { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';

const envKey = process.env.RECONMC_API_KEY?.trim() ?? '';
const AUTH_DISABLED = process.env.RECONMC_DISABLE_AUTH === 'true';
const envKeyBuffer = envKey ? Buffer.from(envKey, 'utf8') : null;

function timingSafeApiKeyCheck(provided: string): boolean {
  if (!envKeyBuffer) return false;
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (providedBuffer.length !== envKeyBuffer.length) {
    crypto.timingSafeEqual(envKeyBuffer, envKeyBuffer);
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, envKeyBuffer);
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (AUTH_DISABLED) {
    request.log.info({ apiKey: 'AUTH_DISABLED' }, 'API request');
    return;
  }

  const apiKey = request.headers['x-api-key'] as string;

  if (!apiKey || !timingSafeApiKeyCheck(apiKey)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  request.log.info({ apiKey: apiKey.substring(0, 8) + '...' }, 'API request');
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
