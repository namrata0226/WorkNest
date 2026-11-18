import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, AUTH_EXPIRED_EVENT } from '../api/client';
import type { CurrentUser, Permission } from '../types';

interface AuthValue {
  user: CurrentUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [ready, setReady] = useState(false);

  const refreshProfile = useCallback(async () => {
    const res = await api.get('/auth/me');
    setUser(res.data.data);
  }, []);

  useEffect(() => {
    refreshProfile().catch(() => setUser(null)).finally(() => setReady(true));
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [refreshProfile]);

  const value = useMemo<AuthValue>(() => ({
    user,
    ready,
    refreshProfile,
    login: async (email, password) => {
      const res = await api.post('/auth/login', { email, password });
      setUser(res.data.data);
    },
    logout: async () => {
      try {
        await api.post('/auth/logout');
      } finally {
        setUser(null);
      }
    },
    can: (permission) => Boolean(user?.permissions.includes(permission)),
  }), [user, ready, refreshProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
