import { create } from "zustand";
import { api, ApiError } from "@/api/client";
import type { User } from "@claudex/shared";

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  challengeId: string | null;
  checkSession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  verifyTotp: (code: string) => Promise<void>;
  /**
   * Redeem a single-use recovery code in place of the rolling TOTP. Same
   * challenge-consumed / cookie-issued semantics as `verifyTotp`.
   */
  verifyRecoveryCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  error: null,
  challengeId: null,

  async checkSession() {
    set({ loading: true, error: null });
    try {
      const res = await api.whoami();
      set({ user: res.user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  async login(username, password) {
    set({ error: null });
    try {
      const res = await api.login({ username, password });
      // 2FA off → server already issued the JWT cookie. Skip the TOTP step
      // and resolve `user` immediately so Login.tsx redirects out.
      if (!res.requireTotp) {
        const me = await api.whoami();
        set({ user: me.user, challengeId: null });
        return;
      }
      set({ challengeId: res.challengeId });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      set({ error: code === "invalid_credentials" ? "用户名或密码不正确" : code });
      throw err;
    }
  },

  async verifyTotp(code) {
    const challengeId = get().challengeId;
    if (!challengeId) {
      set({ error: "missing_challenge" });
      throw new Error("missing_challenge");
    }
    set({ error: null });
    try {
      await api.verifyTotp({ challengeId, code });
      const res = await api.whoami();
      set({ user: res.user, challengeId: null });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      set({
        error:
          code === "invalid_totp"
            ? "验证码不正确，请重试"
            : code === "invalid_challenge"
              ? "会话已过期，请重新登录"
              : code,
      });
      if (code === "invalid_challenge") set({ challengeId: null });
      throw err;
    }
  },

  async verifyRecoveryCode(code) {
    const challengeId = get().challengeId;
    if (!challengeId) {
      set({ error: "missing_challenge" });
      throw new Error("missing_challenge");
    }
    set({ error: null });
    try {
      await api.verifyRecoveryCode({ challengeId, code });
      const res = await api.whoami();
      set({ user: res.user, challengeId: null });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      set({
        error:
          code === "invalid_recovery_code"
            ? "恢复码不正确，请重试"
            : code === "invalid_challenge"
              ? "会话已过期，请重新登录"
              : code === "rate_limited"
                ? "尝试次数过多，请稍后再试"
                : code,
      });
      if (code === "invalid_challenge") set({ challengeId: null });
      throw err;
    }
  },

  async logout() {
    try {
      await api.logout();
    } finally {
      set({ user: null, challengeId: null });
    }
  },

  clearError() {
    set({ error: null });
  },
}));
