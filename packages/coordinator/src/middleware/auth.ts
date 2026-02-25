import { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';
import IPCIDR from 'ip-cidr';

const API_KEYS = new Set<string>();
const envKey = process.env.RECONMC_API_KEY;
const AUTH_DISABLED = process.env.RECONMC_DISABLE_AUTH === 'true';

if (envKey) {
  API_KEYS.add(envKey.trim());
}

const DEFAULT_TRUSTED_NETWORKS = [
  '172.16.0.0/12',
  '10.0.0.0/8',
  '127.0.0.0/8',
];

let cachedTrustedNetworks: string[] | null = null;

function getTrustedNetworks(): string[] {
  if (cachedTrustedNetworks) return cachedTrustedNetworks;

  const envNetworks = process.env.TRUSTED_NETWORKS;
  if (!envNetworks || envNetworks.trim() === '') {
    cachedTrustedNetworks = DEFAULT_TRUSTED_NETWORKS;
    return cachedTrustedNetworks;
  }

  cachedTrustedNetworks = envNetworks
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  return cachedTrustedNetworks;
}

function isIpInTrustedNetwork(ip: string, networks: string[]): boolean {
  if (!IPCIDR.isValidAddress(ip)) return false;

  for (const cidr of networks) {
    try {
      const ipCidr = new IPCIDR(cidr);
      if (ipCidr.contains(ip)) return true;
    } catch {
      continue;
    }
  }
  return false;
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

  if (!apiKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  if (!timingSafeAny(apiKey, API_KEYS)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  request.log.info({ apiKey: apiKey.substring(0, 8) + '...' }, 'API request');
}

export async function requireTrustedNetwork(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const clientIp = request.ip;
  const trustedNetworks = getTrustedNetworks();

  if (!isIpInTrustedNetwork(clientIp, trustedNetworks)) {
    request.log.warn({ ip: clientIp }, 'Blocked access to internal endpoint');
    return reply.code(403).send({ error: 'Forbidden: internal endpoint' });
  }
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
