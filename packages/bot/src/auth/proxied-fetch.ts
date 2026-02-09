/**
 * SOCKS-proxied HTTPS fetch utility.
 * Re-exports shared functionality from @reconmc/scanner.
 */

export type { SocksProxyConfig, ProxiedResponse, ProxiedRequestInit } from '@reconmc/scanner';
export { proxiedFetch, createFetchFn } from '@reconmc/scanner';
