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
  /** active | suspended (suspended organisations show a notice instead of the modules). */
  status?: string;
}
export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; isPlatformAdmin?: boolean } | null;
  memberships: Membership[];
  /** Organisations this user deleted as owner and can still restore (30 days). */
  deletedOrganizations?: Array<{ id: string; name: string; deleted_at: string; purge_after: string }>;
  /** Only present for platform staff. */
  platform?: { member: boolean; unlocked: boolean; role: string | null; claimed: boolean; legacy: boolean };
  supportAccess?: Array<{ id: string; name: string; expires_at: string; grant_id: string }>;
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
