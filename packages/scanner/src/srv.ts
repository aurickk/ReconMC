import * as dns from 'node:dns';
import * as net from 'node:net';

export interface SRVResult {
  hostname: string;
  port: number;
}

/**
 * Perform SRV record lookup for Minecraft servers
 * Only looks up SRV records for port 25565 non-IP addresses
 */
export async function lookupSRV(
  hostname: string,
  port: number
): Promise<SRVResult> {
  // SRV records only apply to default Minecraft port (25565)
  // And don't lookup SRV for IP addresses
  if (port !== 25565 || net.isIP(hostname) !== 0) {
    return { hostname, port };
  }

  try {
    const result = await dns.promises.resolveSrv(`_minecraft._tcp.${hostname}`) as dns.SrvRecord[];

    // Check if we got a valid result
    if (!result || result.length === 0 || !result[0].name || !result[0].port) {
      return { hostname, port };
    }

    return {
      hostname: result[0].name,
      port: result[0].port
    };
  } catch (e) {
    // On any error, fallback to original values
    return { hostname, port };
  }
}
