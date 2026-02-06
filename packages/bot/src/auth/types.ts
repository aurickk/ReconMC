/**
 * Account types for authentication
 */

/**
 * Cracked account - just a username
 */
export interface CrackedAccount {
  type: 'cracked';
  username: string;
}

/**
 * Microsoft account with tokens
 */
export interface MicrosoftTokenAccount {
  type: 'microsoft';
  accessToken: string;
  refreshToken?: string;
  username?: string;  // Optional: Minecraft username associated with this token
}

/**
 * Union type for all account types
 */
export type Account = CrackedAccount | MicrosoftTokenAccount;

/**
 * Microsoft OAuth token response
 */
export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Xbox Live authentication response
 */
export interface XboxLiveAuthResponse {
  token: string;
  userXUID: string;
  userHash: string;
}

/**
 * XSTS authentication response
 */
export interface XSTSAuthResponse {
  token: string;
  userXUID: string;
  userHash: string;
  expiresOn: string;
}

/**
 * Minecraft authentication response
 */
export interface MinecraftAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Minecraft profile response
 */
export interface MinecraftProfile {
  id: string;
  name: string;
  skins: Array<{
    id: string;
    state: string;
    url: string;
  }>;
  capes: Array<{
    id: string;
    state: string;
    url: string;
  }>;
}

/**
 * Result of Microsoft authentication
 * Contains all tokens needed to build a prismarine-auth cache
 */
export interface AuthResult {
  success: boolean;
  accessToken?: string;      // Minecraft access token
  refreshToken?: string;     // Microsoft refresh token
  profile?: {
    id: string;
    name: string;
  };
  userHash?: string;         // Xbox Live user hash (uhs)
  error?: string;
  refreshed?: boolean;       // True if tokens were refreshed

  // Additional tokens for prismarine-auth cache
  msAccessToken?: string;    // Microsoft access token
  xblToken?: string;         // Xbox Live token
  xstsToken?: string;        // XSTS token
  expiresOn?: number;        // Token expiration timestamp
}

/**
 * Callback for reporting refreshed tokens back to coordinator
 */
export type TokenRefreshCallback = (accountId: string, tokens: {
  accessToken: string;
  refreshToken?: string;
}) => void | Promise<void>;
