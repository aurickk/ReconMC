/**
 * Minimal SOCKS-proxied HTTPS fetch utility for the coordinator.
 * Re-exports shared functionality from @reconmc/scanner.
 */

export type { SocksProxyConfig } from '@reconmc/scanner';
export { createFetchFn } from '@reconmc/scanner';
