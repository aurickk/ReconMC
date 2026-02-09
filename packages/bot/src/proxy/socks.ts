/**
 * SOCKS proxy handler for Minecraft bot connections
 */

import { SocksClient } from 'socks';
import type { ProxyConfig } from './types';
import { logger } from '../logger.js';

/**
 * SOCKS proxy type (4 = SOCKS4, 5 = SOCKS5)
 */
type SocksProxyType = 4 | 5;

/**
 * SOCKS connection options type (compatible with SocksClient)
 */
interface SocksConnectionOptions {
  proxy: {
    host: string;
    port: number;
    type: SocksProxyType;
    userId?: string;
    password?: string;
  };
  command: 'connect';
  destination: { host: string; port: number };
}

/**
 * Create a SOCKS proxy connection options object
 */
export function createSocksOptions(
  proxy: ProxyConfig,
  destination: { host: string; port: number }
): SocksConnectionOptions {
  return {
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: proxy.type === 'socks5' ? 5 : 4,
      userId: proxy.username,
      password: proxy.password,
    },
    command: 'connect',
    destination: destination,
  };
}

/**
 * Test a proxy connection by connecting to a target host
 */
export async function testProxyConnection(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number = 25565,
  timeout: number = 5000
): Promise<{ success: boolean; error?: string; latency?: number }> {
  const startTime = Date.now();

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const options = createSocksOptions(proxy, { host: targetHost, port: targetPort });

    const result = await Promise.race([
      SocksClient.createConnection(options),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Proxy connection timeout')), timeout);
      }),
    ]);

    // Clear the timeout and close the socket — we only needed to verify connectivity
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result?.socket) {
      result.socket.destroy();
    }

    return {
      success: true,
      latency: Date.now() - startTime,
    };
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown proxy error',
    };
  }
}

/**
 * Create a proxied connection factory for mineflayer
 * SECURITY: All connections MUST go through proxy - no direct connections allowed
 */
export function createProxiedConnect(proxy: ProxyConfig, targetHost: string, targetPort: number) {
  return function (client: { setSocket(socket: unknown): void; emit(event: string, ...args: unknown[]): void }) {
    const options = createSocksOptions(proxy, { host: targetHost, port: targetPort });

    logger.debug(`[Proxy] Establishing ${proxy.type.toUpperCase()} connection to ${targetHost}:${targetPort} via ${proxy.host}:${proxy.port}`);

    SocksClient.createConnection(options, (err, info) => {
      if (err) {
        // Enhanced error logging for proxy failures
        logger.error(`[Proxy] Connection failed: ${err.message}`);
        logger.error(`[Proxy] Proxy: ${proxy.host}:${proxy.port} (${proxy.type})`);
        logger.error(`[Proxy] Target: ${targetHost}:${targetPort}`);

        // Emit a more descriptive error
        const proxyError = new Error(`Proxy connection failed: ${err.message}`) as Error & { code?: string; proxyDetails?: object };
        proxyError.code = 'PROXY_ERROR';
        proxyError.proxyDetails = {
          host: proxy.host,
          port: proxy.port,
          type: proxy.type,
          target: `${targetHost}:${targetPort}`
        };
        client.emit('error', proxyError);
        return;
      }

      if (info?.socket) {
        logger.debug(`[Proxy] Connection established via ${proxy.host}:${proxy.port}`);
        client.setSocket(info.socket);
        client.emit('connect');
      } else {
        // No socket returned - connection failed
        const error = new Error('Proxy connection failed: No socket returned') as Error & { code?: string };
        error.code = 'PROXY_ERROR';
        client.emit('error', error);
      }
    });
  };
}
