/**
 * Proxy configuration types
 */

/**
 * Proxy configuration for SOCKS connections
 */
export interface ProxyConfig {
  host: string;
  port: number;
  type: 'socks5' | 'socks4';
  username?: string;
  password?: string;
}

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
