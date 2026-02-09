/**
 * SOCKS-proxied HTTPS fetch utility.
 * Routes HTTP/HTTPS requests through a SOCKS4/5 proxy to avoid rate limiting
 * from Microsoft/Mojang APIs when validating accounts.
 *
 * Uses the `socks` library (already a dependency) to create TCP tunnels
 * through the proxy, then upgrades to TLS for HTTPS endpoints.
 */

import { SocksClient } from 'socks';
import * as tls from 'node:tls';
import * as https from 'node:https';
import * as http from 'node:http';

export interface SocksProxyConfig {
  host: string;
  port: number;
  type: 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

/**
 * Minimal fetch-like response interface.
 * Compatible with how the auth code uses fetch() responses.
 */
export interface ProxiedResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  text(): Promise<string>;
}

/**
 * Fetch-like request options.
 */
export interface ProxiedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Make an HTTPS request tunneled through a SOCKS proxy.
 * API mimics the native fetch() for easy drop-in replacement.
 */
export async function proxiedFetch(
  url: string,
  init: ProxiedRequestInit = {},
  proxy: SocksProxyConfig
): Promise<ProxiedResponse> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const targetHost = parsed.hostname;
  const targetPort = parseInt(parsed.port) || (isHttps ? 443 : 80);

  // Step 1: Establish SOCKS tunnel to the target
  const { socket: rawSocket } = await SocksClient.createConnection({
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
  });

  // Step 2: If HTTPS, upgrade the raw socket to TLS
  let socket: typeof rawSocket | tls.TLSSocket = rawSocket;
  if (isHttps) {
    const tlsSocket = tls.connect({
      socket: rawSocket,
      host: targetHost,
      servername: targetHost,
    });

    await new Promise<void>((resolve, reject) => {
      tlsSocket.once('secureConnect', resolve);
      tlsSocket.once('error', reject);
    });

    socket = tlsSocket;
  }

  // Step 3: Make the HTTP request using the tunneled (TLS) socket
  return new Promise<ProxiedResponse>((resolve, reject) => {
    const requestModule = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: targetHost,
      port: targetPort,
      path: parsed.pathname + parsed.search,
      method: init.method || 'GET',
      headers: init.headers || {},
      // Use the pre-established socket — bypass normal DNS/TCP
      createConnection: () => socket as any,
      agent: false,
    };

    const req = requestModule.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode || 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          json: () => {
            try {
              return Promise.resolve(JSON.parse(body));
            } catch (e) {
              return Promise.reject(new Error(`Failed to parse JSON: ${body.substring(0, 200)}`));
            }
          },
          text: () => Promise.resolve(body),
        });
      });
      res.on('error', reject);
    });

    req.on('error', (err) => {
      // Clean up socket on error
      socket.destroy();
      reject(err);
    });

    // Handle abort signal
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy();
        socket.destroy();
        reject(new Error('Request aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        req.destroy();
        socket.destroy();
        reject(new Error('Request aborted'));
      }, { once: true });
    }

    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
}

/**
 * Create a fetch function that optionally routes through a SOCKS proxy.
 * If no proxy is provided, falls back to native fetch.
 * This makes it easy to swap between proxied and direct requests.
 */
export function createFetchFn(proxy?: SocksProxyConfig): typeof fetch {
  if (!proxy) {
    return globalThis.fetch;
  }

  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return proxiedFetch(urlStr, {
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
      signal: init?.signal ?? undefined,
    }, proxy);
  }) as typeof fetch;
}
