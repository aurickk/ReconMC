import { useStore } from '@nanostores/vue';
import {
  $authState,
  $isAuthenticated,
  $loading,
  $error,
  setApiKey,
  clearAuth,
  checkAuthStatus,
  verifyApiKey,
} from '@/stores/auth';

export function useAuth() {
  const authState = useStore($authState);
  const isAuthenticated = useStore($isAuthenticated);
  const loading = useStore($loading);
  const error = useStore($error);

  return {
    authState,
    isAuthenticated,
    loading,
    error,
    setApiKey,
    clearAuth,
    checkAuthStatus,
    verifyApiKey,
  };
}
