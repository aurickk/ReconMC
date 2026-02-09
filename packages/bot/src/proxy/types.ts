/**
 * Proxy configuration types
 */

// Re-export ProxyConfig from @reconmc/scanner
export type { ProxyConfig } from '@reconmc/scanner';

/**
 * Validate proxy configuration
 */
export function validateProxyConfig(proxy: ProxyConfig): boolean {
  return (
    typeof proxy.host === 'string' &&
    proxy.host.length > 0 &&
    typeof proxy.port === 'number' &&
    proxy.port > 0 &&
    proxy.port <= 65535 &&
    (proxy.type === 'socks4' || proxy.type === 'socks5')
  );
}
