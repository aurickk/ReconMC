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
 * Microsoft account with access token
 * Sessions are disposable -- no refresh tokens
 */
export interface MicrosoftTokenAccount {
  type: 'microsoft';
  accessToken: string;
  username?: string;  // Optional: Minecraft username associated with this token
}

/**
 * Union type for all account types
 */
export type Account = CrackedAccount | MicrosoftTokenAccount;

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
 * Result of authentication
 * Simplified -- no refresh tokens, no extended OAuth token data
 */
export interface AuthResult {
  success: boolean;
  accessToken?: string;      // Minecraft access token
  profile?: {
    id: string;
    name: string;
  };
  userHash?: string;         // Xbox Live user hash (uhs)
  error?: string;
}
