import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Activity, Cpu, Power, RefreshCw, Search, ShieldCheck, Stethoscope } from "lucide-react";
import { ApiError, patch, post, fmtDate, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Select, Skeleton, cx } from "../ui";

type Model = {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  maxOutput: number | null;
  inputModalities: string[];
  capabilities: string[];
  categories: string[];
  freeClass: string;
  label: string;
  reasons: string[];
  eligible: boolean;
  isRouter: boolean;
  expirationDate: string | null;
  lastCheckedAt: string;
  coolingDown: boolean;
  health: { status: string | null; checkedAt: string | null };
  tasks: string[];
};
type Catalog = { items: Model[]; categories: Array<{ key: string; label: string; rule: string }>; tasks: Array<{ key: string; label: string }>; source: string };
type Status = {
  policy: { statement: string };
  openrouter: {
    configured: boolean;
    connected: boolean;
    reason: string | null;
    enabledGlobally: boolean;
    halted: { reason: string; at: string } | null;
    lastSync: { at: string; ok: boolean; error?: string } | null;
    catalogCount: number;
    eligibleCount: number;
    quota: { usedToday: number; dailyLimit: number; perMinute: number; perOrgDaily: number; perUserDaily: number; source: string; note: string; reset: string };
  };
  workersAi: { configured: boolean; dailyBudgetUsd: number; spentTodayUsd: number };
  gemini: { configured: boolean; note: string };
  imageGeneration: { note: string };
  legacy?: {
    workersAiModel?: string;
    groq?: boolean;
    groqModel?: string;
    gemini?: boolean;
    geminiModel?: string;
    order?: string[];
    neuronsToday?: number;
    neuronsDailyCap?: number;
    neuronsFreePerDay?: number;
    cacheTtlHours?: number;
    resetsAt?: string;
    budgetExhausted?: boolean;
  };
};
type Prefs = { strategy: string; manualModelId: string | null; fallbackPolicy: "auto" | "ask"; privacyFirst: boolean; openrouterEnabled: boolean };
type Usage = {
  period: string;
  source: string;
  observedAt: string;
  totals: { calls: number; ok: number; fallback_ok: number; billed: number; openrouter_ok: number; openrouter_zero_confirmed: number } | null;
  recent: Array<{ task: string; provider: string; model: string; served_model: string | null; status: string; error_code: string | null; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; reported_cost_usd: number | null; cost_state: string; is_fallback: number; created_at: string }>;
  quotaToday: { organization: { used: number; limit: number }; user: { used: number; limit: number } };
};

const STRATEGIES: Array<{ key: string; label: string; help: string }> = [
  {
    key: "automatic_free",
    label: "Automático gratuito (recomendado)",
    help: "Primero Workers AI de Cloudflare (cupo gratuito diario). Si se agota o falla: Groq y Gemini en su nivel gratuito (si están activados) y, por último, modelos gratuitos de OpenRouter.",
  },
  { key: "manual_free", label: "Elegir modelo gratuito", help: "Usa primero el modelo gratuito de OpenRouter que elijas. Solo aparecen modelos gratuitos verificados." },
  { key: "openrouter_free_router", label: "Enrutador gratuito de OpenRouter", help: "OpenRouter elige primero entre sus modelos gratuitos. Comprobamos que el modelo servido sea gratuito." },
  { key: "cloudflare_only", label: "Solo Cloudflare", help: "Toda la IA se ejecuta en Workers AI de Cloudflare; ningún texto sale a otros proveedores." },
];

const REASON_TEXT: Record<string, string> = {
  no_configurado: "Falta la clave de OpenRouter en los secretos de Cloudflare. Mientras tanto responde Workers AI.",
  desactivado_por_administrador: "Detenido por el administrador de la plataforma. Responde Workers AI.",
  desactivado_para_esta_empresa: "Desactivado en tu organización. Responde Workers AI.",
  limite_de_frecuencia_temporal: "OpenRouter ha pedido esperar (límite de frecuencia). Se reanuda solo; mientras tanto responde Workers AI.",
};
const reasonText = (r: string) => REASON_TEXT[r] ?? (r.startsWith("detenido:") ? "Bloqueado por seguridad (" + r.slice(9).replace(/_/g, " ") + "). Responde Workers AI." : "Política no segura detectada (" + r.replace(/_/g, " ") + "): OpenRouter bloqueado.");

const classTone = (c: string) => (c === "verified" ? "ok" : c === "restricted" ? "warn" : c === "paid" ? "danger" : "neutral");
const providerLabel = (p: string) => ({ openrouter: "OpenRouter", workers_ai: "Workers AI", gemini: "Gemini", groq: "Groq", cache: "Caché (sin coste)" })[p] ?? p;
const nf = new Intl.NumberFormat("es-ES", { useGrouping: "always" });

type ProviderTest = { ok: boolean; provider: string; model?: string; latencyMs: number; error?: string };
const TESTABLE = [
  { key: "workers_ai", label: "Workers AI" },
  { key: "groq", label: "Groq" },
  { key: "gemini", label: "Gemini" },
] as const;

/** Platform admins only: one tiny real request per provider (max. 20 a day for the platform). */
function ProviderTests() {
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, ProviderTest | string>>({});
  const run = async (provider: string) => {
    setBusy(provider);
    try {
      const r = await post<ProviderTest>("/admin/ai/providers/test", { provider });
      setRes((x) => ({ ...x, [provider]: r }));
    } catch (e) {
      setRes((x) => ({ ...x, [provider]: e instanceof ApiError ? e.message : "Error" }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-sm font-medium">Probar conexión (administración)</p>
      <p className="text-xs text-mute">Una petición mínima y real a cada proveedor, sin caché ni respaldo. Máximo 20 pruebas al día; queda en la auditoría.</p>
      <ul className="mt-2 space-y-2">
        {TESTABLE.map((p) => {
          const r = res[p.key];
          return (
            <li key={p.key} className="flex flex-wrap items-center gap-2 text-sm">
              <Button variant="ghost" onClick={() => void run(p.key)} loading={busy === p.key} disabled={!!busy}>
                <Stethoscope className="size-4" aria-hidden /> {p.label}
              </Button>
              {typeof r === "string" && <span className="text-danger">{r}</span>}
              {r && typeof r !== "string" &&
                (r.ok ? (
                  <span>
                    <Badge tone="ok">Responde</Badge> {r.model} · {nf.format(r.latencyMs)} ms
                  </span>
                ) : (
                  <span>
                    <Badge tone="danger">No responde</Badge> {r.error}
                  </span>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EnginePanel({ s, admin }: { s: Status; admin: boolean }) {
  const l = s.legacy ?? {};
  const cap = l.neuronsDailyCap ?? 0;
  const used = l.neuronsToday ?? 0;
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const order = (l.order ?? ["workers_ai"]).map(providerLabel);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Motor principal: Cloudflare Workers AI" subtitle={l.workersAiModel ? `Modelo ${l.workersAiModel} · sin «pensamiento» para ahorrar cupo` : undefined}>
        <p className="flex items-center gap-2 text-sm">
          <Badge tone={s.workersAi.configured ? "ok" : "neutral"}>{s.workersAi.configured ? "Activo" : "No disponible"}</Badge>
          {l.budgetExhausted && <Badge tone="warn">Cupo de hoy agotado</Badge>}
        </p>
        <p className="mt-3 text-2xl font-semibold tabular-nums">
          {nf.format(used)} <span className="text-base font-normal text-mute">/ {nf.format(cap)} neuronas hoy</span>
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Cupo gratuito diario de Workers AI usado">
          <div className={cx("h-full rounded-full", pct > 85 ? "bg-danger" : "bg-accent")} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-mute">
          Estimación de DNI Growth con los precios oficiales. Tope propio por debajo de las {nf.format(l.neuronsFreePerDay ?? 10000)} neuronas gratuitas diarias de Cloudflare: al llegar, se para (no hay cobros). Se renueva a las {l.resetsAt ?? "00:00 UTC"}.
        </p>
      </Card>
      <Card title="Orden de respaldo (todo gratuito)" subtitle={`Respuestas repetidas: caché de ${l.cacheTtlHours ?? 24} h por organización`}>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {order.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-mute">
          Groq ({l.groqModel ?? "openai/gpt-oss-20b"}): {l.groq ? "activado" : "sin clave (opcional)"} · Gemini ({l.geminiModel ?? "gemini-3.5-flash-lite"}): {l.gemini ? "activado" : "sin clave"}. Los datos personales o secretos solo se procesan en Cloudflare.
        </p>
        {admin && <ProviderTests />}
      </Card>
    </div>
  );
}

function StatusPanel({ s }: { s: Status }) {
  const or = s.openrouter;
  const pct = or.quota.dailyLimit ? Math.min(100, Math.round((or.quota.usedToday / or.quota.dailyLimit) * 100)) : 0;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="OpenRouter (solo gratis)" subtitle={s.policy.statement}>
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2">
            <Badge tone={or.connected ? "ok" : or.configured ? "warn" : "neutral"}>{or.connected ? "Disponible" : or.configured ? "En pausa" : "No configurado"}</Badge>
            {or.halted && <Badge tone="danger">Bloqueado: {or.halted.reason.replace(/_/g, " ")}</Badge>}
          </p>
          {!or.connected && or.reason && <p className="text-mute">{reasonText(or.reason)}</p>}
          <p className="text-mute">
            {or.eligibleCount} modelos gratuitos elegibles de {or.catalogCount} gratuitos catalogados · sincronizado {or.lastSync ? timeAgo(or.lastSync.at) : "nunca"}
            {or.lastSync && !or.lastSync.ok && " (último intento fallido; se conserva la versión anterior)"}
          </p>
        </div>
      </Card>
      <Card title="Cuota gratuita de hoy" subtitle={or.quota.source === "reported_by_openrouter" ? "Límite informado por OpenRouter" : "Límite estimado (conservador)"}>
        <p className="text-2xl font-semibold tabular-nums">
          {or.quota.usedToday} <span className="text-base font-normal text-mute">/ {or.quota.dailyLimit} solicitudes</span>
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Cuota diaria usada">
          <div className={cx("h-full rounded-full", pct > 85 ? "bg-danger" : "bg-accent")} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-mute">
          Compartida por toda la plataforma · máx. {or.quota.perMinute}/min · {or.quota.perOrgDaily}/día por organización · {or.quota.perUserDaily}/día por usuario. {or.quota.reset}
        </p>
      </Card>
      <Card title="Imágenes" subtitle="Workers AI · mismo cupo diario gratuito">
        <p className="text-xs text-mute">{s.imageGeneration.note}</p>
      </Card>
    </div>
  );
}

function Preferences({ orgId, models, canEdit }: { orgId: string; models: Model[]; canEdit: boolean }) {
  const prefs = useApi<Prefs>(`/orgs/${orgId}/ai/preferences`);
  const [draft, setDraft] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const p = draft ?? prefs.data;
  const choosable = models.filter((m) => m.eligible && !m.isRouter);
  if (prefs.loading || !p) return <Skeleton className="h-40" />;
  const set = (patchP: Partial<Prefs>) => {
    setSaved(false);
    setDraft({ ...p, ...patchP });
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await patch<Prefs>(`/orgs/${orgId}/ai/preferences`, { ...p, manualModelId: p.strategy === "manual_free" ? p.manualModelId : null });
      prefs.setData(r);
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "error", "Error inesperado"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title="Cómo elige la IA tu organización" subtitle={canEdit ? "Solo se pueden elegir modelos gratuitos verificados. El servidor vuelve a comprobarlo en cada solicitud." : "Solo propietarios, administradores y responsables de marketing pueden cambiar esto."}>
      <fieldset disabled={!canEdit} className="space-y-4">
        <legend className="sr-only">Estrategia de selección de modelo</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {STRATEGIES.map((s) => (
            <label key={s.key} className={cx("cursor-pointer rounded-2xl border p-3 text-sm", p.strategy === s.key ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2")}>
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="strategy" value={s.key} checked={p.strategy === s.key} onChange={() => set({ strategy: s.key })} />
                {s.label}
              </span>
              <span className="mt-1 block text-xs text-mute">{s.help}</span>
            </label>
          ))}
        </div>
        {p.strategy === "manual_free" && (
          <label className="block text-sm">
            <span className="font-medium">Modelo gratuito</span>
            <Select className="mt-1" value={p.manualModelId ?? ""} onChange={(e) => set({ manualModelId: e.target.value || null })}>
              <option value="">Elige un modelo…</option>
              {choosable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {Math.round(m.contextLength / 1000)}k
                </option>
              ))}
            </Select>
          </label>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={p.fallbackPolicy === "auto"} onChange={(e) => set({ fallbackPolicy: e.target.checked ? "auto" : "ask" })} />
            <span>
              Respaldo automático
              <span className="block text-xs text-mute">Si un modelo falla, usar otro gratuito o Workers AI sin preguntar.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={p.privacyFirst} onChange={(e) => set({ privacyFirst: e.target.checked })} />
            <span>
              Privacidad primero
              <span className="block text-xs text-mute">Pide a OpenRouter proveedores sin retención de datos y omite Gemini. Puede haber menos modelos disponibles.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={p.openrouterEnabled} onChange={(e) => set({ openrouterEnabled: e.target.checked })} />
            <span>
              Usar OpenRouter
              <span className="block text-xs text-mute">Interruptor de la organización. Desactivado = no se usa OpenRouter (siguen Workers AI y los demás respaldos gratuitos).</span>
            </span>
          </label>
        </div>
      </fieldset>
      {error && (
        <div className="mt-3">
          <ErrorState error={error} />
        </div>
      )}
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!draft || (p.strategy === "manual_free" && !p.manualModelId)}>
            Guardar preferencias
          </Button>
          {saved && <span className="text-sm text-ok">Guardado.</span>}
        </div>
      )}
    </Card>
  );
}

function CatalogTable({ data, admin, onChanged }: { data: Catalog; admin: boolean; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [onlyFree, setOnlyFree] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const items = useMemo(
    () =>
      data.items.filter(
        (m) => (!onlyFree || m.eligible) && (!cat || m.categories.includes(cat)) && (!q || `${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data.items, q, cat, onlyFree],
  );
  const health = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await post<{ ok: boolean; latencyMs?: number; reportedCostUsd?: number | null; error?: string }>("/admin/ai/models/health-check", { modelId: id });
      setMsg(r.ok ? `${id}: responde en ${r.latencyMs} ms · coste informado ${r.reportedCostUsd ?? "no informado"} USD` : `${id}: no responde (${r.error})`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Catálogo de modelos gratuitos" subtitle={`Fuente: ${data.source}. Las descripciones vienen del proveedor y se muestran como texto, sin enlaces.`}>
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_220px_auto]">
        <label className="relative block">
          <span className="sr-only">Buscar modelo</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar modelo…" className="min-h-10 w-full rounded-xl border border-line bg-surface-2 pl-9 pr-3 text-base sm:text-sm" />
        </label>
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {data.categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> Solo utilizables
        </label>
      </div>
      {msg && <p className="mb-3 text-sm text-mute">{msg}</p>}
      {!items.length ? (
        <EmptyState icon={<Cpu className="size-8" />} title="Sin modelos que mostrar">
          {data.items.length ? "Ningún modelo coincide con el filtro." : "El catálogo aún no se ha sincronizado. Se sincroniza automáticamente cada 12 horas."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((m) => (
            <li key={m.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{m.name}</p>
                  <p className="break-all font-mono text-xs text-mute">{m.id}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge tone={classTone(m.freeClass)}>{m.label}</Badge>
                  {m.coolingDown && <Badge tone="warn">En pausa por fallos</Badge>}
                  {m.health.status === "ok" && <Badge tone="ok">Prueba: responde</Badge>}
                  {m.health.status === "failed" && <Badge tone="warn">Prueba: no respondió</Badge>}
                </div>
              </div>
              {m.description && <p className="mt-1 line-clamp-2 text-sm text-mute">{m.description}</p>}
              <p className="mt-1 text-xs text-mute">
                Contexto {m.isRouter ? "variable" : `${Math.round(m.contextLength / 1000)}k tokens`} · {m.capabilities.join(", ") || "chat"}
                {m.expirationDate && ` · gratis hasta ${m.expirationDate}`} · precio revisado {timeAgo(m.lastCheckedAt)}
              </p>
              {!m.eligible && m.reasons.length > 0 && <p className="mt-1 text-xs text-danger">No utilizable: {m.reasons.join("; ")}</p>}
              {admin && m.eligible && !m.isRouter && (
                <Button className="mt-2" variant="ghost" onClick={() => void health(m.id)} loading={busy === m.id}>
                  <Stethoscope className="size-4" aria-hidden /> Probar (1 solicitud gratuita)
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AdminPanel({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    try {
      setMsg(await fn());
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  };
  const or = status.openrouter;
  return (
    <Card title="Administración de la plataforma" subtitle="Visible solo para administradores de DNI Growth. Afecta a todas las organizaciones.">
      <div className="flex flex-wrap gap-2">
        <Button
          loading={busy === "sync"}
          onClick={() => void run("sync", async () => {
            const r = await post<{ eligible: number; seen: number; added: number; priceChanged: number }>("/admin/ai/models/sync");
            return `Sincronizado: ${r.seen} modelos revisados, ${r.eligible} gratuitos elegibles, ${r.added} nuevos, ${r.priceChanged} cambios de precio.`;
          })}
        >
          <RefreshCw className="size-4" aria-hidden /> Sincronizar catálogo
        </Button>
        <Button
          variant={or.enabledGlobally ? "danger" : "primary"}
          loading={busy === "kill"}
          onClick={() => void run("kill", async () => {
            const r = await post<{ enabled: boolean }>("/admin/ai/openrouter/kill-switch", { enabled: !or.enabledGlobally });
            return r.enabled ? "OpenRouter reactivado para toda la plataforma." : "OpenRouter detenido para toda la plataforma.";
          })}
        >
          <Power className="size-4" aria-hidden /> {or.enabledGlobally ? "Detener OpenRouter (global)" : "Reactivar OpenRouter"}
        </Button>
        {or.halted && (
          <Button
            loading={busy === "halt"}
            onClick={() => {
              if (window.confirm(`OpenRouter se bloqueó por «${or.halted!.reason}». Revisa la cuenta de OpenRouter antes de continuar. ¿Quitar el bloqueo?`))
                void run("halt", async () => (await post("/admin/ai/openrouter/reset-halt"), "Bloqueo retirado."));
            }}
          >
            <ShieldCheck className="size-4" aria-hidden /> Quitar bloqueo de seguridad
          </Button>
        )}
      </div>
      {msg && <p className="mt-3 text-sm text-mute">{msg}</p>}
    </Card>
  );
}

function UsageTable({ orgId }: { orgId: string }) {
  const usage = useApi<Usage>(`/orgs/${orgId}/ai/usage`);
  if (usage.loading) return <Skeleton className="h-40" />;
  if (usage.error) return <ErrorState error={usage.error} onRetry={() => void usage.reload()} />;
  const u = usage.data!;
  const t = u.totals;
  return (
    <Card title="Actividad de IA de tu organización" subtitle={`${u.period} · medido (${u.source}) · ${fmtDate(u.observedAt)}`}>
      <div className="mb-4 grid gap-3 text-sm sm:grid-cols-4">
        <p>
          <span className="block text-2xl font-semibold tabular-nums">{t?.calls ?? 0}</span>
          <span className="text-mute">solicitudes</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold tabular-nums">{t?.openrouter_zero_confirmed ?? 0}</span>
          <span className="text-mute">OpenRouter con coste 0 confirmado</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold tabular-nums">{t?.fallback_ok ?? 0}</span>
          <span className="text-mute">resueltas por respaldo</span>
        </p>
        <p>
          <span className="block text-2xl font-semibold tabular-nums">
            {u.quotaToday.organization.used}/{u.quotaToday.organization.limit}
          </span>
          <span className="text-mute">cuota gratuita hoy (organización)</span>
        </p>
      </div>
      {(t?.billed ?? 0) > 0 && (
        <Notice tone="warn" title="Cobro detectado">
          OpenRouter informó coste en alguna solicitud. La plataforma lo bloqueó automáticamente.
        </Notice>
      )}
      {!u.recent.length ? (
        <p className="text-sm text-mute">Aún no hay actividad.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-mute">
              <tr>
                <th className="px-4 py-2 font-medium sm:px-2">Cuándo</th>
                <th className="px-2 py-2 font-medium">Tarea</th>
                <th className="px-2 py-2 font-medium">Proveedor y modelo</th>
                <th className="px-2 py-2 font-medium">Estado</th>
                <th className="px-2 py-2 font-medium">Tokens</th>
                <th className="px-2 py-2 font-medium">Coste</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {u.recent.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-4 py-2 text-mute sm:px-2">{timeAgo(r.created_at)}</td>
                  <td className="px-2 py-2">{r.task}</td>
                  <td className="px-2 py-2">
                    {providerLabel(r.provider)}
                    <span className="block break-all font-mono text-xs text-mute">{r.served_model ?? r.model}</span>
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={r.status === "ok" ? "ok" : r.status === "blocked" ? "danger" : "warn"}>{r.status === "ok" ? (r.is_fallback ? "OK (respaldo)" : "OK") : r.status === "blocked" ? "Bloqueado" : "Falló"}</Badge>
                    {r.error_code && <span className="block text-xs text-mute">{r.error_code}</span>}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-mute">{(r.input_tokens ?? 0) + (r.output_tokens ?? 0) || "—"}</td>
                  <td className="px-2 py-2 text-xs">
                    {r.cost_state === "zero_confirmed" ? "0 USD (confirmado)" : r.cost_state === "billed" ? `${r.reported_cost_usd} USD (bloqueado)` : r.provider === "openrouter" ? "0 USD (esperado)" : "Incluido en Cloudflare"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AiHubPage() {
  const { orgId = "" } = useParams();
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const canEdit = ["owner", "admin", "marketing_manager"].includes(role);
  const admin = !!me?.user?.isPlatformAdmin;
  const status = useApi<Status>(`/orgs/${orgId}/ai/provider-status`);
  const catalog = useApi<Catalog>(`/orgs/${orgId}/ai/models?freeOnly=false`);
  const reload = () => {
    void status.reload();
    void catalog.reload();
  };
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="IA · solo modelos gratuitos"
        title="Centro de IA"
        subtitle="Qué modelos usa DNI Growth, cuánto queda de la cuota gratuita y cómo se decide qué IA responde. Nunca se usan modelos de pago."
        actions={
          <Button onClick={reload}>
            <Activity className="size-4" aria-hidden /> Actualizar
          </Button>
        }
      />
      {status.error ? <ErrorState error={status.error} onRetry={reload} /> : status.data ? (
        <div className="space-y-4">
          <EnginePanel s={status.data} admin={admin} />
          <StatusPanel s={status.data} />
        </div>
      ) : <Skeleton className="h-36" />}
      {admin && status.data && <AdminPanel status={status.data} onChanged={reload} />}
      <Preferences orgId={orgId} models={catalog.data?.items ?? []} canEdit={canEdit} />
      {catalog.error ? <ErrorState error={catalog.error} onRetry={reload} /> : catalog.data ? <CatalogTable data={catalog.data} admin={admin} onChanged={reload} /> : <Skeleton className="h-60" />}
      <UsageTable orgId={orgId} />
    </div>
  );
}
