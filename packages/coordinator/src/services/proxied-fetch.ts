/**
 * Minimal SOCKS-proxied HTTPS fetch utility for the coordinator.
 * Used to route account validation API calls through proxies from the pool,
 * avoiding rate limiting from Microsoft/Mojang APIs.
 */

import { SocksClient } from 'socks';
import * as tls from 'node:tls';
import * as https from 'node:https';

export interface SocksProxyConfig {
  host: string;
  port: number;
  type: 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

interface FetchLikeResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  text(): Promise<string>;
}

/**
 * Make an HTTPS request tunneled through a SOCKS proxy.
 * Drop-in replacement for fetch() in auth code.
 */
async function proxiedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  proxy: SocksProxyConfig
): Promise<FetchLikeResponse> {
  const parsed = new URL(url);
  const targetHost = parsed.hostname;
  const targetPort = parseInt(parsed.port) || 443;

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

  const tlsSocket = tls.connect({
    socket: rawSocket,
    host: targetHost,
    servername: targetHost,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('secureConnect', resolve);
    tlsSocket.once('error', reject);
  });

  return new Promise<FetchLikeResponse>((resolve, reject) => {
    const req = https.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: parsed.pathname + parsed.search,
        method: init.method || 'GET',
        headers: init.headers || {},
        createConnection: () => tlsSocket as any,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            json: () => {
              try { return Promise.resolve(JSON.parse(body)); }
              catch { return Promise.reject(new Error(`JSON parse error: ${body.substring(0, 200)}`)); }
            },
            text: () => Promise.resolve(body),
          });
        });
        res.on('error', reject);
      }
    );

    req.on('error', (err) => {
      tlsSocket.destroy();
      reject(err);
    });

    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * Returns a fetch function that routes through the given SOCKS proxy.
 * If no proxy provided, returns native fetch (direct connection).
 */
export function createFetchFn(proxy?: SocksProxyConfig): typeof fetch {
  if (!proxy) return globalThis.fetch;

  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    return proxiedFetch(urlStr, {
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
    }, proxy);
  }) as typeof fetch;
}
