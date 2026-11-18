import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Bot, Download, ImagePlus, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { ApiError, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton, cx } from "../ui";

type AiStatus = {
  workersAi: boolean;
  openRouter: boolean;
  gemini: boolean;
  groq?: boolean;
  images: boolean;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  budgetExhausted: boolean;
  neuronsToday?: number;
  neuronsDailyCap?: number;
  resetsAt?: string;
};
type Msg = { id: string; role: "user" | "assistant"; content: string; provider?: string | null; model?: string | null; servedModel?: string | null; fallback?: boolean; cached?: boolean; credits?: number; created_at?: string };

const PROVIDER_LABEL: Record<string, string> = { workers_ai: "Cloudflare Workers AI", openrouter: "OpenRouter (modelo gratuito)", gemini: "Gemini (nivel gratuito)", groq: "Groq (nivel gratuito)" };

function StatusNotice({ s }: { s: AiStatus | null }) {
  if (!s) return null;
  if (!s.workersAi && !s.openRouter && !s.gemini && !s.groq) return <Notice tone="warn" title="IA no disponible">No hay ningún proveedor de IA activo en este entorno.</Notice>;
  if (s.budgetExhausted && !s.openRouter && !s.gemini && !s.groq)
    return (
      <Notice tone="warn" title="Cupo gratuito diario agotado">
        Hoy se ha agotado el cupo gratuito de IA de la plataforma. Se renueva cada día a las {s.resetsAt ?? "00:00 UTC"} (01:00 en España peninsular en invierno). No se cobra nada.
      </Notice>
    );
  if (s.budgetExhausted)
    return <Notice tone="info" title="Respaldo gratuito activo">El cupo diario de Cloudflare se ha agotado; responden los proveedores gratuitos de respaldo hasta que se renueve a las {s.resetsAt ?? "00:00 UTC"}.</Notice>;
  return null;
}

/** Plain-text renderer with paragraph and list support (no HTML from the model is ever injected). */
function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*([-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "")}</li>
              ))}
            </ul>
          );
        return (
          <p key={i} className="whitespace-pre-wrap">
            {block.replace(/\*\*/g, "")}
          </p>
        );
      })}
    </div>
  );
}

export function AdvisorPage() {
  const { orgId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const convId = params.get("c");
  const status = useApi<AiStatus>(`/orgs/${orgId}/ai/status`);
  const convs = useApi<{ items: Array<{ id: string; title: string; updated_at: string }> }>(`/orgs/${orgId}/advisor/conversations`);
  const brands = useApi<{ items: Array<{ id: string; name: string }> }>(`/orgs/${orgId}/brands`);
  const conv = useApi<{ messages: Msg[] }>(convId ? `/orgs/${orgId}/advisor/conversations/${convId}` : null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [brandId, setBrandId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMessages(convId ? (conv.data?.messages ?? []) : []), [convId, conv.data]);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages.length, busy]);

  const [retryQ, setRetryQ] = useState<string | null>(null);
  const ask = async (e?: FormEvent, preset?: string, allowFallback = false) => {
    e?.preventDefault();
    const q = (preset ?? question).trim();
    if (q.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    setRetryQ(null);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: q }]);
    setQuestion("");
    try {
      const r = await post<{ conversationId: string; message: Msg }>(`/orgs/${orgId}/advisor`, { question: q, ...(convId ? { conversationId: convId } : brandId ? { brandId } : {}), ...(allowFallback ? { allowFallback: true } : {}) });
      setMessages((m) => [...m, r.message]);
      if (r.conversationId !== convId) setParams({ c: r.conversationId }, { replace: true });
      void convs.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "error", "Error inesperado"));
      if (err instanceof ApiError && err.code === "selected_model_failed") setRetryQ(q);
      setMessages((m) => m.slice(0, -1));
      setQuestion(q);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = ["¿Qué 3 problemas de mi web debo arreglar primero y cómo?", "Escríbeme un título y una meta descripción mejores para mi página de inicio.", "¿Cómo preparo mi web para aparecer en respuestas de ChatGPT y Google AI?"];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="IA · 1 crédito por respuesta"
        title="Asesor de crecimiento"
        subtitle="Pregunta lo que quieras sobre tu web, SEO, GEO o marketing. Responde usando los datos reales de tu última auditoría."
        actions={
          <Button onClick={() => setParams({}, { replace: true })} disabled={!convId}>
            <MessageSquarePlus className="size-4" aria-hidden /> Nueva conversación
          </Button>
        }
      />
      <StatusNotice s={status.data} />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="order-2 lg:order-1">
          <Card title="Conversaciones">
            {convs.loading ? (
              <Skeleton className="h-24" />
            ) : !convs.data?.items.length ? (
              <p className="text-sm text-mute">Aún no hay conversaciones.</p>
            ) : (
              <ul className="-mx-2 max-h-80 space-y-1 overflow-y-auto lg:max-h-[60vh]">
                {convs.data.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setParams({ c: c.id }, { replace: true })}
                      className={cx("w-full rounded-xl px-2 py-2 text-left text-sm hover:bg-surface-2", c.id === convId && "bg-surface-2")}
                    >
                      <span className="line-clamp-2">{c.title}</span>
                      <span className="text-xs text-mute">{timeAgo(c.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        <section className="order-1 flex min-h-[60vh] flex-col rounded-3xl border border-line bg-surface lg:order-2" aria-label="Chat con el asesor">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6" aria-live="polite">
            {!messages.length && !busy && (
              <div className="mx-auto max-w-lg py-6 text-center">
                <Bot className="mx-auto size-10 text-accent-text" aria-hidden />
                <p className="mt-3 font-medium">¿En qué te ayudo hoy?</p>
                {!convId && !!brands.data?.items.length && (
                  <label className="mt-4 block text-left text-sm">
                    <span className="text-mute">Marca de contexto</span>
                    <select className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                      <option value="">La más reciente</option>
                      {brands.data.items.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="mt-4 grid gap-2">
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => void ask(undefined, s)} className="rounded-2xl border border-line px-4 py-3 text-left text-sm hover:bg-surface-2">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={cx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cx("max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[80%]", m.role === "user" ? "bg-accent text-accent-ink" : "border border-line bg-surface-2")}>
                  {m.role === "assistant" ? <Answer text={m.content} /> : <p className="whitespace-pre-wrap text-sm">{m.content}</p>}
                  {m.role === "assistant" && m.provider && (
                    <p className="mt-2 text-[11px] text-mute">
                      Generado por IA · {PROVIDER_LABEL[m.provider] ?? m.provider}
                      {(m.servedModel ?? m.model) && <> · <span className="font-mono">{m.servedModel ?? m.model}</span></>}
                      {m.fallback && " · respaldo automático"}
                      {m.cached && " · respuesta reutilizada (sin gastar cupo)"} · revisa antes de aplicar
                    </p>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm text-mute">Pensando…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>
          <form onSubmit={ask} className="border-t border-line p-3 sm:p-4">
            {error && (
              <div className="mb-3">
                <ErrorState error={error} />
                {retryQ && (
                  <Button className="mt-2" onClick={() => void ask(undefined, retryQ, true)}>
                    Usar respaldo automático (gratuito)
                  </Button>
                )}
                {error.code === "insufficient_credits" && (
                  <Link to={`/o/${orgId}/billing`} className="mt-2 inline-block text-sm text-accent-text hover:underline">
                    Ver créditos
                  </Link>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <label htmlFor="advisor-q" className="sr-only">
                Tu pregunta
              </label>
              <textarea
                id="advisor-q"
                rows={2}
                maxLength={2000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) void ask(e as unknown as FormEvent);
                }}
                placeholder="Escribe tu pregunta…"
                className="min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface-2 px-4 py-3 text-base sm:text-sm"
              />
              <Button variant="primary" type="submit" loading={busy} disabled={question.trim().length < 2} aria-label="Enviar pregunta" className="min-h-11">
                <Send className="size-4" aria-hidden />
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

type Img = { id: string; prompt: string; provider: string; model: string; credits: number; created_at: string };

export function CreativePage() {
  const { orgId = "" } = useParams();
  const status = useApi<AiStatus>(`/orgs/${orgId}/ai/status`);
  const list = useApi<{ items: Img[] }>(`/orgs/${orgId}/creative/images`);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fileUrl = (id: string) => `/api/v1/orgs/${orgId}/creative/images/${id}/file`;

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/orgs/${orgId}/creative/images`, { prompt });
      setPrompt("");
      await list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "error", "Error inesperado"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="IA · 5 créditos por imagen" title="Creative Studio" subtitle="Genera imágenes para redes, banners y tu web a partir de una descripción. Cuadradas, 1024 × 1024 px." />
      <StatusNotice s={status.data} />
      {status.data && !status.data.images && <Notice tone="warn">La generación de imágenes no está activada en este entorno.</Notice>}
      <Card>
        <form onSubmit={generate} className="space-y-3">
          <label htmlFor="img-prompt" className="text-sm font-medium">
            Describe la imagen
          </label>
          <textarea
            id="img-prompt"
            rows={3}
            maxLength={1000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ej.: Barra de pan artesanal sobre una mesa de madera, luz cálida de mañana, estilo fotografía de producto"
            className="w-full resize-y rounded-2xl border border-line bg-surface-2 px-4 py-3 text-base sm:text-sm"
          />
          <p className="text-xs text-mute">No se generan desnudos, violencia, odio, logotipos de terceros ni fotos realistas de personas identificables. Revisa derechos y veracidad antes de publicar.</p>
          <ErrorState error={error} />
          <Button variant="primary" type="submit" loading={busy} disabled={prompt.trim().length < 5}>
            <Sparkles className="size-4" aria-hidden /> Generar imagen
          </Button>
        </form>
      </Card>
      {list.loading ? (
        <Skeleton className="h-48" />
      ) : !list.data?.items.length ? (
        <EmptyState icon={<ImagePlus className="size-8" />} title="Todavía no has generado imágenes">
          Escribe una descripción arriba y pulsa «Generar imagen».
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.items.map((im) => (
            <li key={im.id} className="overflow-hidden rounded-3xl border border-line bg-surface">
              <img src={fileUrl(im.id)} alt={im.prompt} loading="lazy" className="aspect-square w-full bg-surface-2 object-cover" />
              <div className="space-y-2 p-4">
                <p className="line-clamp-2 text-sm">{im.prompt}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge>{PROVIDER_LABEL[im.provider] ?? im.provider}</Badge>
                  <a href={fileUrl(im.id)} download className="inline-flex min-h-10 items-center gap-1 text-sm text-accent-text hover:underline">
                    <Download className="size-4" aria-hidden /> Descargar
                  </a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
