import { create } from "zustand";

const LS_UTOK = "anet:utok";
const LS_NTOK = "anet:ntok";
const LS_USER = "anet:user";
const LS_NET = "anet:networkId";

export type AnetUser = {
  id: string;
  email: string;
  display_name?: string;
};

type AuthState = {
  utok: string | null;
  ntok: string | null;
  networkId: string | null;
  user: AnetUser | null;
  setSession: (s: {
    utok: string;
    user: AnetUser;
    ntok?: string | null;
    networkId?: string | null;
  }) => void;
  setNetworkContext: (networkId: string, ntok: string) => void;
  logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  utok: localStorage.getItem(LS_UTOK),
  ntok: localStorage.getItem(LS_NTOK),
  networkId: localStorage.getItem(LS_NET),
  user: ((): AnetUser | null => {
    const raw = localStorage.getItem(LS_USER);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AnetUser;
    } catch {
      return null;
    }
  })(),
  setSession: ({ utok, user, ntok, networkId }) => {
    localStorage.setItem(LS_UTOK, utok);
    localStorage.setItem(LS_USER, JSON.stringify(user));
    if (ntok) localStorage.setItem(LS_NTOK, ntok);
    if (networkId) localStorage.setItem(LS_NET, networkId);
    set({ utok, user, ntok: ntok ?? null, networkId: networkId ?? null });
  },
  setNetworkContext: (networkId, ntok) => {
    localStorage.setItem(LS_NET, networkId);
    localStorage.setItem(LS_NTOK, ntok);
    set({ networkId, ntok });
  },
  logout: () => {
    localStorage.removeItem(LS_UTOK);
    localStorage.removeItem(LS_NTOK);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_NET);
    set({ utok: null, ntok: null, user: null, networkId: null });
  }
}));

export function selfAlias(user: AnetUser | null): string {
  if (!user) return "anon";
  // 跟 commhub 已有惯例对齐: user-<userId> 作为 client APP 用户的 alias
  return `user-${user.id}`;
}
