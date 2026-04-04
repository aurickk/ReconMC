/**
 * SOCKS proxy handler for Minecraft bot connections
 */

import { SocksClient } from 'socks';
import * as https from 'node:https';
import * as tls from 'node:tls';
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
 * Create an https.Agent that tunnels connections through a SOCKS proxy.
 * Used by node-fetch (via yggdrasil) for Mojang session server HTTP calls.
 *
 * node-fetch v2 passes the agent to http/https.request() which calls
 * agent.createConnection() to obtain a socket. We override that to
 * establish a SOCKS tunnel first, then upgrade to TLS.
 */
export function createSocksAgent(proxy: ProxyConfig): https.Agent {
  const agent = new https.Agent({
    keepAlive: false,
  });

  // Override createConnection to route through the SOCKS proxy.
  // node-fetch calls this for each HTTPS request. We establish a
  // SOCKS tunnel to the target, then upgrade the raw TCP socket to TLS.
  (agent as any).createConnection = function (
    options: { host?: string; hostname?: string; port?: number | string; servername?: string },
    callback: (err: Error | null, socket?: tls.TLSSocket) => void
  ) {
    const targetHost = options.host || options.hostname || 'localhost';
    const targetPort = typeof options.port === 'string' ? parseInt(options.port, 10) : (options.port || 443);

    logger.debug(`[Proxy] SOCKS agent tunneling HTTPS to ${targetHost}:${targetPort}`);

    SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type === 'socks5' ? 5 : 4,
        userId: proxy.username,
        password: proxy.password,
      },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 10000,
    }).then(({ socket: rawSocket }) => {
      // Upgrade the raw SOCKS tunnel to TLS for HTTPS
      const tlsSocket = tls.connect({
        socket: rawSocket,
        host: targetHost,
        servername: options.servername || targetHost,
      });

      tlsSocket.once('secureConnect', () => {
        callback(null, tlsSocket);
      });

      tlsSocket.once('error', (err) => {
        rawSocket.destroy();
        callback(err);
      });
    }).catch((err) => {
      logger.warn(`[Proxy] SOCKS agent tunnel failed for ${targetHost}:${targetPort}: ${err.message}`);
      callback(err instanceof Error ? err : new Error(String(err)));
    });
  };

  return agent;
}

/**
 * Create a proxied connection factory for mineflayer
 * SECURITY: All connections MUST go through proxy - no direct connections allowed
 */
export function createProxiedConnect(proxy: ProxyConfig, targetHost: string, targetPort: number) {
  return function (client: { setSocket(socket: unknown): void; emit(event: string, ...args: unknown[]): void }) {
    const options = createSocksOptions(proxy, { host: targetHost, port: targetPort });

    const socksStart = Date.now();
    logger.info(`[Proxy] Establishing ${proxy.type.toUpperCase()} tunnel to ${targetHost}:${targetPort}`);

    // Add a SOCKS-level timeout (15s) so the SOCKS handshake itself fails fast
    // instead of silently hanging until the overall connection timeout fires.
    const socksTimeout = 15000;
    let socksTimedOut = false;
    const socksTimer = setTimeout(() => {
      socksTimedOut = true;
      const error = new Error(`SOCKS tunnel timeout after ${socksTimeout}ms`) as Error & { code?: string };
      error.code = 'PROXY_TIMEOUT';
      logger.warn(`[Proxy] SOCKS tunnel timed out after ${socksTimeout}ms for ${targetHost}:${targetPort}`);
      client.emit('error', error);
    }, socksTimeout);

    SocksClient.createConnection(options, (err, info) => {
      clearTimeout(socksTimer);
      if (socksTimedOut) {
        // Timer already fired — destroy the late-arriving socket to prevent leak
        if (info?.socket) info.socket.destroy();
        return;
      }

      if (err) {
        logger.error(`[Proxy] SOCKS tunnel failed after ${Date.now() - socksStart}ms: ${err.message}`);

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
        const elapsed = Date.now() - socksStart;
        logger.info(`[Proxy] SOCKS tunnel established in ${elapsed}ms`);

        // Set socket options for reliability
        const sock = info.socket as import('net').Socket;
        sock.setKeepAlive(true, 10000);
        sock.setNoDelay(true);

        client.setSocket(info.socket);
        client.emit('connect');
      } else {
        const error = new Error('Proxy connection failed: No socket returned') as Error & { code?: string };
        error.code = 'PROXY_ERROR';
        client.emit('error', error);
      }
    });
  };
}
