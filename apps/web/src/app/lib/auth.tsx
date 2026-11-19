import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Membership {
  id: string;
  name: string;
  slug: string;
  plan_code: string;
  /** Plan whose modules apply (client organisations inherit their agency's plan). */
  effective_plan?: string;
  role: string;
}
export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; isPlatformAdmin?: boolean } | null;
  memberships: Membership[];
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<Me | null> }>({ me: null, loading: true, refresh: async () => null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("/auth/me");
      setMe(m);
      return m;
    } catch {
      setMe({ user: null, memberships: [] });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
