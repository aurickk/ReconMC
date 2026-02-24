import { atom, computed } from 'nanostores';
import { persistentAtom } from '@nanostores/persistent';
import { api } from '@/lib/api';

export interface AuthState {
  apiKey: string | null;
  isAuthenticated: boolean;
  authRequired: boolean;
  loading: boolean;
  error: string | null;
}

const $apiKey = persistentAtom<string | null>('reconmc_api_key', null, {
  encode: (value) => JSON.stringify(value),
  decode: (value) => {
    try {
      const parsed = JSON.parse(value);
      return parsed ?? null;
    } catch {
      return null;
    }
  },
});

const $authRequired = atom<boolean>(true);
const $loading = atom<boolean>(false);
const $error = atom<string | null>(null);

export const $isAuthenticated = computed(
  [$apiKey, $authRequired],
  (key, required) => {
    if (!required) return true;
    return key !== null && key.length > 0;
  }
);

export const $authState = computed(
  [$apiKey, $isAuthenticated, $authRequired, $loading, $error],
  (apiKey, isAuthenticated, authRequired, loading, error): AuthState => ({
    apiKey,
    isAuthenticated,
    authRequired,
    loading,
    error,
  })
);

export function setApiKey(key: string | null) {
  $apiKey.set(key);
  api.setApiKey(key);
  $error.set(null);
}

export function clearAuth() {
  $apiKey.set(null);
  api.setApiKey(null);
  $error.set(null);
}

export async function checkAuthStatus() {
  $loading.set(true);
  $error.set(null);

  const response = await api.getAuthStatus();

  if (response.error) {
    $error.set(response.error);
    $loading.set(false);
    return false;
  }

  const authRequired = response.data?.authRequired ?? true;
  $authRequired.set(authRequired);

  const storedKey = $apiKey.get();
  if (storedKey) {
    api.setApiKey(storedKey);
  }

  // If auth is disabled, set a placeholder key so isAuthenticated becomes true
  if (!authRequired && !$apiKey.get()) {
    $apiKey.set('disabled');
    api.setApiKey('disabled');
  }

  $loading.set(false);
  return true;
}

export async function verifyApiKey(key: string): Promise<boolean> {
  $loading.set(true);
  $error.set(null);

  api.setApiKey(key);

  const response = await api.getHealth();

  if (response.error) {
    $error.set(response.error);
    api.setApiKey($apiKey.get());
    $loading.set(false);
    return false;
  }

  $apiKey.set(key);
  $loading.set(false);
  return true;
}

export { $apiKey, $authRequired, $loading, $error };
