import { lookup } from 'node:dns/promises';

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_REGEX = /^\[?([0-9a-fA-F:]+)\]?$/;

/**
 * Private IP address patterns that should be blocked to prevent SSRF attacks
 * Includes loopback, private networks, link-local, and cloud metadata services
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,                           // IPv4 loopback (127.0.0.0/8)
  /^0\./,                             // IPv4 "this" network (0.0.0.0/8)
  /^10\./,                            // Private Class A (10.0.0.0/8)
  /^172\.(1[6-9]|2\d|3[01])\./,      // Private Class B (172.16.0.0/12)
  /^192\.168\./,                      // Private Class C (192.168.0.0/16)
  /^169\.254\./,                      // IPv4 link-local (169.254.0.0/16)
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-8])\./, // Carrier-grade NAT (100.64.0.0/10)
  /^192\.0\.0\./,                     // IANA IPv4 Special Purpose (192.0.0.0/24)
  /^192\.0\.2\./,                     // TEST-NET-1 (192.0.2.0/24)
  /^198\.51\.100\./,                  // TEST-NET-2 (198.51.100.0/24)
  /^203\.0\.113\./,                   // TEST-NET-3 (203.0.113.0/24)
  /^224\./,                           // IPv4 multicast (224.0.0.0/4)
  /^240\./,                           // IPv4 reserved (240.0.0.0/4)
  /^255\.255\.255\.255$/,             // IPv4 broadcast
  /^::1$/,                            // IPv6 loopback
  /^fe80:/i,                          // IPv6 link-local
  /^fc00:/i,                          // IPv6 unique local (private)
  /^fd00:/i,                          // IPv6 unique local (private)
  /^ff00:/i,                          // IPv6 multicast
];

/**
 * Specific IP addresses that should always be blocked
 */
const BLOCKED_IPS = new Set([
  '0.0.0.0',
  'localhost',
  '::1',
  '169.254.169.254', // AWS/GCP/Azure metadata service
]);

/**
 * Check if an IP address is private, loopback, link-local, or otherwise blocked
 * Used to prevent SSRF attacks
 */
export function isPrivateIp(ip: string): boolean {
  const normalizedIp = ip.toLowerCase().trim();

  // Check explicit blocked list
  if (BLOCKED_IPS.has(normalizedIp)) {
    return true;
  }

  // Check against regex patterns
  return PRIVATE_IP_PATTERNS.some(pattern => pattern.test(normalizedIp));
}

export function isIpAddress(host: string): boolean {
  const trimmed = host.trim();
  if (IPV4_REGEX.test(trimmed)) return true;
  const v6Match = trimmed.match(IPV6_REGEX);
  if (v6Match && v6Match[1].includes(':')) return true;
  return false;
}

/**
 * Error thrown when a resolved IP address is private/internal
 */
export class PrivateIpError extends Error {
  constructor(ip: string) {
    super(`Private IP addresses are not allowed: ${ip}`);
    this.name = 'PrivateIpError';
  }
}

/**
 * Resolve server address to IP with SSRF protection.
 * If input is already an IP, validates it's not private.
 * Otherwise resolves hostname and validates the result.
 * @throws {PrivateIpError} if the IP is private, loopback, or internal
 */
export async function resolveServerIp(serverAddress: string): Promise<string> {
  const trimmed = serverAddress.trim();
  const [hostPart] = trimmed.split(':');
  const host = (hostPart ?? trimmed).trim();
  if (!host) return '';

  if (isIpAddress(host)) {
    // Direct IP - validate it's not private
    if (isPrivateIp(host)) {
      throw new PrivateIpError(host);
    }
    return host;
  }

  // Check for blocked hostnames before DNS lookup
  const lowerHost = host.toLowerCase();
  if (BLOCKED_IPS.has(lowerHost) || lowerHost.includes('localhost') || lowerHost.endsWith('.local')) {
    throw new PrivateIpError(host);
  }

  try {
    const result = await lookup(host, { family: 4 });
    const ip = result.address;

    // Validate the resolved IP is not private
    if (isPrivateIp(ip)) {
      throw new PrivateIpError(ip);
    }

    return ip;
  } catch (error) {
    if (error instanceof PrivateIpError) {
      throw error;
    }
    // On DNS resolution failure, return the hostname
    return host;
  }
}

/**
 * Parse server string to { host, port }.
 */
export function parseServerAddress(serverAddress: string): { host: string; port: number } {
  const trimmed = serverAddress.trim();
  const [hostPart, portPart] = trimmed.split(':');
  const host = (hostPart ?? trimmed).trim();
  const port = portPart ? parseInt(portPart, 10) : 25565;
  return {
    host,
    port: Number.isNaN(port) || port <= 0 ? 25565 : Math.min(65535, port),
  };
}
