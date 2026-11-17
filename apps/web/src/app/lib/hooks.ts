import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/** Minimal data hook: loading / error / data / reload, optional polling while a predicate holds. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (d: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "error", "Error inesperado"));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    setLoading(!!path);
    const run = async () => {
      const d = await load();
      const o = optsRef.current;
      if (alive && d && o.pollMs && o.pollWhile?.(d)) timer = window.setTimeout(run, o.pollMs);
    };
    void run();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [load, path]);

  return { data, error, loading, reload: load, setData };
}

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("dni.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("dni.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}
