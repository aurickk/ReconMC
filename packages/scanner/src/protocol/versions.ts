/**
 * Minecraft protocol version map and helpers.
 * Used by the agent to determine version compatibility
 * for bot connections (mineflayer has a native version ceiling).
 */

/** Highest protocol version that mineflayer + minecraft-protocol@1.66 can handle natively. */
export const MAX_NATIVE_PROTOCOL = 774; // 1.21.11

/** Map protocol numbers to mineflayer-compatible version strings. */
export const PROTOCOL_VERSIONS: Record<number, string> = {
  // 1.20.x
  763: '1.20.1',
  764: '1.20.2',
  765: '1.20.4',
  766: '1.20.6',
  // 1.21.x
  767: '1.21.1',
  768: '1.21.3',
  769: '1.21.4',
  770: '1.21.5',
  771: '1.21.6',
  772: '1.21.8',
  773: '1.21.10',
  774: '1.21.11',  // <-- MAX_NATIVE_PROTOCOL ceiling
};

/** Get human-readable version name from protocol number. */
export function getVersionName(protocol: number): string {
  return PROTOCOL_VERSIONS[protocol] || `Unknown (${protocol})`;
}

/**
 * Check if a protocol version is natively supported by the installed
 * mineflayer + minecraft-protocol natively.
 */
export function isNativelySupported(protocol: number): boolean {
  return protocol <= MAX_NATIVE_PROTOCOL;
}

/**
 * Get the mineflayer version string to use for a given server protocol.
 * Returns the exact version if natively supported, or the highest native
 * version as a fallback for servers that may accept older clients (ViaVersion).
 */
export function getNativeVersion(protocol: number): string | null {
  if (protocol <= MAX_NATIVE_PROTOCOL) {
    return PROTOCOL_VERSIONS[protocol] || null;
  }
  return null;
}

