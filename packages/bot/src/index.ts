/**
 * @reconmc/bot - Minecraft bot connection layer
 */

export * from './types';
export * from './bot-connector.js';
export { validateProxyConfig } from './proxy/types.js';
export { createSocksOptions, testProxyConnection, createProxiedConnect } from './proxy/socks.js';
export {
  validateAccount,
  getUsername,
  getAuthString,
  getAccessToken,
  validateCrackedAccount,
  createCrackedAccount,
  getAccountProfile,
  getAccountAuth,
  setTokenRefreshCallback,
  clearTokenRefreshCallback,
} from './auth/index.js';
export type { SocksProxyConfig } from './auth/proxied-fetch.js';
export { proxiedFetch, createFetchFn } from './auth/proxied-fetch.js';
export { pluginDetector } from './plugins/index.js';
export type { PluginDetectionResult, PluginDetectorOptions } from './plugins/index.js';
export { autoAuth } from './plugins/index.js';
export type { AutoAuthOptions, AutoAuthResult } from './plugins/index.js';
