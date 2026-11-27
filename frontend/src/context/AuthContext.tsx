import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, AUTH_EXPIRED_EVENT } from '../api/client';
import type { CurrentUser, Permission } from '../types';

export interface LoginChallenge {
  challengeToken: string;
  expiresAt: string;
  /** The account email the code goes to, partly hidden. */
  destination: string;
}

export interface OtpSent {
  destination: string;
  resendAt: string;
  codeExpiresAt: string;
}

interface AuthValue {
  user: CurrentUser | null;
  ready: boolean;
  /** Checks the password. Nobody is signed in until a one-time code is verified. */
  login: (email: string, password: string) => Promise<LoginChallenge>;
  sendOtp: (challengeToken: string) => Promise<OtpSent>;
  verifyOtp: (challengeToken: string, code: string) => Promise<void>;
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
    login: async (email, password) => (await api.post('/auth/login', { email, password })).data.data,
    sendOtp: async (challengeToken) => (await api.post('/auth/otp/send', { challengeToken })).data.data,
    verifyOtp: async (challengeToken, code) => {
      const res = await api.post('/auth/otp/verify', { challengeToken, code });
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
