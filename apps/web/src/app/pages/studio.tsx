import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, Clapperboard, Copy, Download, Megaphone, Pause, Play, Plus, ShieldAlert, Trash2, Upload } from "lucide-react";
import { ApiError, del, post, put, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, Textarea, TextField } from "../ui";
import { useOrgAccess } from "./org";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "No se pudo completar la acción.");
const eur = (v: number) => v.toLocaleString("es-ES", { style: "currency", currency: "EUR" });

// ── Ads Manager ─────────────────────────────────────────────────────────────────────────────────
const CSTATUS: Record<string, { label: string; tone: "ok" | "warn" | "neutral" | "info" | "danger" }> = { draft: { label: "Borrador", tone: "neutral" }, in_review: { label: "En revisión", tone: "info" }, approved: { label: "Aprobada", tone: "ok" }, changes_requested: { label: "Cambios pedidos", tone: "warn" }, archived: { label: "Archivada", tone: "neutral" } };
const PLATFORM: Record<string, string> = { meta: "Meta (Facebook/Instagram)", google: "Google Ads", tiktok: "TikTok", linkedin: "LinkedIn" };
const OBJECTIVE: Record<string, string> = { leads: "Contactos", traffic: "Tráfico", awareness: "Alcance", sales: "Ventas" };
const CTAS = ["Más información", "Reservar", "Contactar", "Comprar", "Registrarse", "Solicitar presupuesto"];
type CampaignForm = { id?: string; name: string; platform: string; objective: string; dailyBudgetEur: number; startDate: string; endDate: string; locations: string; ageMin: number; ageMax: number; interests: string; landingId: string; destinationUrl: string; notes: string };
const EMPTY_C: CampaignForm = { name: "", platform: "meta", objective: "leads", dailyBudgetEur: 10, startDate: "", endDate: "", locations: "", ageMin: 18, ageMax: 65, interests: "", landingId: "", destinationUrl: "", notes: "" };

export function AdsPage() {
  const { orgId } = useParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/ads/overview`);
  const [form, setForm] = useState<CampaignForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const t = await fn();
      if (t) setMsg({ tone: "ok", text: t });
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const saveCampaign = () =>
    run("save", async () => {
      if (!form) return;
      const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const body = {
        name: form.name,
        platform: form.platform,
        objective: form.objective,
        dailyBudgetEur: Number(form.dailyBudgetEur),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        audience: { locations: list(form.locations), ageMin: Number(form.ageMin), ageMax: Number(form.ageMax), interests: list(form.interests) },
        landingId: form.landingId || null,
        destinationUrl: form.landingId ? null : form.destinationUrl || null,
        ...(form.notes ? { notes: form.notes } : {}),
      };
      if (form.id) await put(`/orgs/${orgId}/ads/campaigns/${form.id}`, body);
      else await post(`/orgs/${orgId}/ads/campaigns`, body);
      setForm(null);
      return "Borrador guardado.";
    });
  return (
    <>
      <PageHeader
        eyebrow="Pago · Ads Manager"
        title="Campañas preparadas, aprobadas y medibles"
        subtitle="Planifica campañas con presupuesto propuesto, anuncios y URL con UTM. Otra persona del equipo las aprueba dentro de los límites de Spend Guardian."
        actions={access.can("ads:draft") && !form ? <Button variant="primary" onClick={() => setForm({ ...EMPTY_C })}><Plus className="size-4" /> Nueva campaña</Button> : undefined}
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {data && (
        <div className="space-y-6">
          <Notice tone="warn" title="Sin gasto real">{data.note}</Notice>
          <Guardian orgId={orgId!} g={data.guardian} canStop={access.can("ads:emergency_stop")} canEdit={access.can("ads:approve")} onSaved={reload} />
          {form && (
            <Card title={form.id ? "Editar campaña" : "Nueva campaña"}>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Nombre" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Navidad · Madrid · Contactos" />
                <Field label="Plataforma" htmlFor="c-pl"><Select id="c-pl" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>{Object.entries(PLATFORM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                <Field label="Objetivo" htmlFor="c-ob"><Select id="c-ob" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>{Object.entries(OBJECTIVE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                <TextField label="Presupuesto diario propuesto (€)" type="number" min={1} step="0.01" required value={form.dailyBudgetEur} onChange={(e) => setForm({ ...form, dailyBudgetEur: Number(e.target.value) })} />
                <TextField label="Inicio" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
                <TextField label="Fin" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                <TextField label="Ubicaciones (separadas por comas)" value={form.locations} onChange={(e) => setForm({ ...form, locations: e.target.value })} placeholder="Madrid, Alcobendas" />
                <TextField label="Intereses (separados por comas)" value={form.interests} onChange={(e) => setForm({ ...form, interests: e.target.value })} placeholder="repostería, panadería" />
                <TextField label="Edad mínima" type="number" min={18} max={65} value={form.ageMin} onChange={(e) => setForm({ ...form, ageMin: Number(e.target.value) })} />
                <TextField label="Edad máxima" type="number" min={18} max={65} value={form.ageMax} onChange={(e) => setForm({ ...form, ageMax: Number(e.target.value) })} />
                <Field label="Landing de destino" htmlFor="c-lp"><Select id="c-lp" value={form.landingId} onChange={(e) => setForm({ ...form, landingId: e.target.value })}><option value="">— Usar una URL —</option>{data.landings.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
                {!form.landingId && <TextField label="URL de destino (https)" type="url" value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} placeholder="https://tuweb.es/oferta" />}
              </div>
              <Field label="Notas para quien aprueba" htmlFor="c-notes"><Textarea id="c-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} /></Field>
              <div className="mt-4 flex gap-2"><Button variant="primary" loading={busy === "save"} onClick={saveCampaign}>Guardar borrador</Button><Button onClick={() => setForm(null)}>Cancelar</Button></div>
            </Card>
          )}
          {data.campaigns.length === 0 && !form ? (
            <EmptyState icon={<Megaphone className="size-8" />} title="Sin campañas">Prepara tu primera campaña: objetivo, presupuesto propuesto, público, anuncios y destino con UTM para medir los contactos en el CRM.</EmptyState>
          ) : (
            <div className="space-y-4">{data.campaigns.map((c: any) => <CampaignCard key={c.id} orgId={orgId!} c={c} access={access} busy={busy} run={run} onEdit={() => setForm({ id: c.id, name: c.name, platform: c.platform, objective: c.objective, dailyBudgetEur: c.dailyBudgetEur, startDate: c.start_date ?? "", endDate: c.end_date ?? "", locations: (c.audience.locations ?? []).join(", "), ageMin: c.audience.ageMin ?? 18, ageMax: c.audience.ageMax ?? 65, interests: (c.audience.interests ?? []).join(", "), landingId: c.landing_id ?? "", destinationUrl: c.destination_url ?? "", notes: c.notes ?? "" })} />)}</div>
          )}
          <Card title="Conectores de publicación">
            <ul className="space-y-2 text-sm">{data.connectors.map((x: any) => <li key={x.platform} className="flex flex-wrap items-start gap-2"><Badge tone="warn">Bloqueado externamente</Badge><span className="font-medium">{PLATFORM[x.platform]}</span><span className="basis-full text-xs text-mute">{x.note}</span></li>)}</ul>
          </Card>
        </div>
      )}
    </>
  );
}

function Guardian({ orgId, g, canStop, canEdit, onSaved }: { orgId: string; g: any; canStop: boolean; canEdit: boolean; onSaved: () => void }) {
  const [maxDaily, setMaxDaily] = useState(g.maxDailyCents / 100);
  const [maxCamp, setMaxCamp] = useState(g.maxCampaignDailyCents / 100);
  const [err, setErr] = useState<string | null>(null);
  const save = async (killSwitch: boolean) => {
    setErr(null);
    try {
      await put(`/orgs/${orgId}/ads/guardian`, { maxDailyEur: Number(maxDaily), maxCampaignDailyEur: Number(maxCamp), killSwitch });
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><ShieldAlert className="size-5" /> Spend Guardian</span>} subtitle="Límites que ninguna aprobación puede superar" actions={<Badge tone={g.killSwitch ? "danger" : "ok"}>{g.killSwitch ? "Interruptor de emergencia ACTIVADO" : "Aprobaciones permitidas"}</Badge>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Máximo diario de la organización (€)" type="number" min={0} value={maxDaily} disabled={!canEdit} onChange={(e) => setMaxDaily(Number(e.target.value))} />
        <TextField label="Máximo diario por campaña (€)" type="number" min={0} value={maxCamp} disabled={!canEdit} onChange={(e) => setMaxCamp(Number(e.target.value))} />
        <div><p className="text-sm text-mute">Ya aprobado</p><p className="mt-2 font-serif text-3xl tabular-nums">{eur(g.approvedDailyCents / 100)}<span className="font-sans text-sm text-mute">/día propuesto</span></p></div>
      </div>
      {err && <div className="mt-3"><Notice tone="warn">{err}</Notice></div>}
      <div className="mt-4 flex flex-wrap gap-2">
        {canEdit && <Button onClick={() => save(g.killSwitch)}>Guardar límites</Button>}
        {canEdit && g.killSwitch && <Button variant="primary" onClick={() => save(false)}>Permitir aprobaciones</Button>}
        {canStop && !g.killSwitch && <Button onClick={() => save(true)}>Activar interruptor de emergencia</Button>}
      </div>
    </Card>
  );
}

function CampaignCard({ orgId, c, access, busy, run, onEdit }: { orgId: string; c: any; access: { can: (s: string) => boolean }; busy: string | null; run: (k: string, fn: () => Promise<string | void>) => void; onEdit: () => void }) {
  const [cr, setCr] = useState({ format: "1:1", headline: "", primaryText: "", description: "", cta: "Más información" });
  const editable = c.status === "draft" || c.status === "changes_requested";
  const [note, setNote] = useState("");
  return (
    <Card title={c.name} subtitle={`${PLATFORM[c.platform]} · ${OBJECTIVE[c.objective]} · ${eur(c.dailyBudgetEur)}/día propuesto`} actions={<Badge tone={CSTATUS[c.status]?.tone}>{CSTATUS[c.status]?.label}</Badge>}>
      {c.review_note && <Notice tone={c.status === "changes_requested" ? "warn" : "info"} title="Nota de revisión">{c.review_note}</Notice>}
      <p className="break-all text-xs text-mute">Destino con UTM: {c.finalUrl ?? "sin definir"}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {c.creatives.map((a: any) => (
          <div key={a.id} className="rounded-xl border border-line p-3 text-sm">
            <div className="flex items-center justify-between"><Badge>{a.format}</Badge>{editable && access.can("ads:draft") && <button type="button" aria-label="Eliminar anuncio" onClick={() => run(`delc:${a.id}`, async () => { await del(`/orgs/${orgId}/ads/creatives/${a.id}`); })}><Trash2 className="size-4 text-mute" /></button>}</div>
            <p className="mt-2 whitespace-pre-line">{a.primary_text}</p>
            <p className="mt-2 font-semibold">{a.headline}</p>
            {a.description && <p className="text-xs text-mute">{a.description}</p>}
            <span className="mt-2 inline-block rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold">{a.cta}</span>
          </div>
        ))}
      </div>
      {editable && access.can("ads:draft") && c.creatives.length < 10 && (
        <details className="mt-3 rounded-xl border border-dashed border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">Añadir anuncio</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Formato" htmlFor={`f-${c.id}`}><Select id={`f-${c.id}`} value={cr.format} onChange={(e) => setCr({ ...cr, format: e.target.value })}>{["1:1", "4:5", "9:16", "16:9"].map((f) => <option key={f}>{f}</option>)}</Select></Field>
            <Field label="Botón" htmlFor={`cta-${c.id}`}><Select id={`cta-${c.id}`} value={cr.cta} onChange={(e) => setCr({ ...cr, cta: e.target.value })}>{CTAS.map((x) => <option key={x}>{x}</option>)}</Select></Field>
            <TextField label="Titular (máx. 60)" maxLength={60} value={cr.headline} onChange={(e) => setCr({ ...cr, headline: e.target.value })} />
            <TextField label="Descripción (opcional, máx. 90)" maxLength={90} value={cr.description} onChange={(e) => setCr({ ...cr, description: e.target.value })} />
          </div>
          <Field label="Texto principal (máx. 500)" htmlFor={`pt-${c.id}`}><Textarea id={`pt-${c.id}`} maxLength={500} value={cr.primaryText} onChange={(e) => setCr({ ...cr, primaryText: e.target.value })} /></Field>
          <Button className="mt-2" loading={busy === `cr:${c.id}`} onClick={() => run(`cr:${c.id}`, async () => { await post(`/orgs/${orgId}/ads/campaigns/${c.id}/creatives`, { format: cr.format, headline: cr.headline, primaryText: cr.primaryText, cta: cr.cta, ...(cr.description ? { description: cr.description } : {}) }); setCr({ ...cr, headline: "", primaryText: "", description: "" }); return "Anuncio añadido."; })}>Añadir</Button>
        </details>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        {editable && access.can("ads:draft") && <Button onClick={onEdit}>Editar</Button>}
        {editable && access.can("ads:draft") && <Button variant="primary" loading={busy === `sub:${c.id}`} onClick={() => run(`sub:${c.id}`, async () => { await post(`/orgs/${orgId}/ads/campaigns/${c.id}/submit`, {}); return "Enviada a revisión."; })}>Enviar a revisión</Button>}
        {c.status === "in_review" && access.can("ads:approve") && (
          <>
            <Input aria-label="Nota de revisión" placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-60" />
            <Button variant="primary" loading={busy === `ap:${c.id}`} onClick={() => run(`ap:${c.id}`, async () => { await post(`/orgs/${orgId}/ads/campaigns/${c.id}/review`, { decision: "approve", ...(note ? { note } : {}) }); return "Campaña aprobada (presupuesto propuesto, no gastado)."; })}>Aprobar</Button>
            <Button loading={busy === `ch:${c.id}`} onClick={() => run(`ch:${c.id}`, async () => { await post(`/orgs/${orgId}/ads/campaigns/${c.id}/review`, { decision: "changes", ...(note ? { note } : {}) }); return "Cambios solicitados."; })}>Pedir cambios</Button>
          </>
        )}
        {c.status === "approved" && <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" href={`/api/v1/orgs/${orgId}/ads/campaigns/${c.id}/export`}><Download className="size-4" /> Paquete para subir</a>}
        {access.can("ads:draft") && <Button onClick={() => { if (confirm("¿Archivar esta campaña?")) run(`ar:${c.id}`, async () => { await post(`/orgs/${orgId}/ads/campaigns/${c.id}/archive`, {}); }); }}>Archivar</Button>}
      </div>
    </Card>
  );
}

// ── Video Studio ───────────────────────────────────────────────────────────────────────────────
type Scene = { id: string; durationMs: number; background: string; mediaId?: string | null; mediaSource?: "upload" | "generated" | null; fit: "cover" | "contain"; title: string; body: string; textColor: string; textPosition: "top" | "center" | "bottom"; transition: "none" | "fade" | "slide"; caption: string };
type Project = { scenes: Scene[]; audioId?: string | null; audioVolume: number; burnCaptions: boolean; font: "system" | "serif" | "mono" };
const SIZE: Record<string, [number, number]> = { "9:16": [720, 1280], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1280, 720] };
const FONTS: Record<Project["font"], string> = { system: "Inter, system-ui, sans-serif", serif: "Georgia, 'Times New Roman', serif", mono: "ui-monospace, Menlo, monospace" };

export function VideoPage() {
  const { orgId } = useParams();
  const [sp, setSp] = useSearchParams();
  const id = sp.get("p");
  return id ? <VideoEditor orgId={orgId!} id={id} onBack={() => setSp({})} /> : <VideoList orgId={orgId!} open={(p) => setSp({ p })} />;
}

function VideoList({ orgId, open }: { orgId: string; open: (id: string) => void }) {
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/video/projects`);
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null);
    try {
      const r = await post(`/orgs/${orgId}/video/projects`, { name, aspect });
      open(r.id);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <>
      <PageHeader eyebrow="Creatividad · Video Studio" title="Vídeos cortos con tu marca" subtitle="Escenas con texto, imágenes y subtítulos. El vídeo se renderiza en tu navegador: sin colas ni costes de servidor." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-48 rounded-2xl" />}
      {data && (
        <div className="space-y-6">
          {access.can("content:write") && (
            <Card title="Nuevo proyecto" subtitle={`${data.usage.used} de ${data.usage.limit} proyectos de tu plan`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="Roscón de Reyes · Reel" />
                <Field label="Formato" htmlFor="v-aspect"><Select id="v-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)} className="w-auto"><option value="9:16">9:16 Reels/Stories</option><option value="1:1">1:1 Cuadrado</option><option value="4:5">4:5 Feed</option><option value="16:9">16:9 Horizontal</option></Select></Field>
                <Button variant="primary" onClick={create} disabled={name.trim().length < 2}><Plus className="size-4" /> Crear</Button>
              </div>
              {err && <div className="mt-3"><Notice tone="warn">{err}</Notice></div>}
            </Card>
          )}
          {data.projects.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-8" />} title="Sin proyectos">Crea un proyecto: empezarás con 3 escenas editables (gancho, beneficio y llamada a la acción).</EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.projects.map((p: any) => (
                <Card key={p.id} title={p.name} subtitle={`${p.aspect} · ${(p.durationMs / 1000).toFixed(1)} s · editado ${timeAgo(p.updatedAt)}`} actions={p.status === "exported" ? <Badge tone="ok">Exportado</Badge> : <Badge>Borrador</Badge>}>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" onClick={() => open(p.id)}>Abrir</Button>
                    {access.can("content:write") && <Button aria-label="Duplicar" onClick={async () => { try { await post(`/orgs/${orgId}/video/projects/${p.id}/duplicate`, {}); reload(); } catch (e) { setErr(errMsg(e)); } }}><Copy className="size-4" /></Button>}
                    {access.can("content:write") && <Button aria-label="Archivar" onClick={async () => { if (confirm("¿Archivar el proyecto?")) { await del(`/orgs/${orgId}/video/projects/${p.id}`); reload(); } }}><Trash2 className="size-4" /></Button>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = t;
    }
    out.push(line);
  }
  return out;
}

function drawScene(ctx: CanvasRenderingContext2D, p: Project, s: Scene, img: ImageBitmap | undefined, local: number, W: number, H: number) {
  const tIn = Math.min(1, local / 400);
  ctx.save();
  if (s.transition === "fade") ctx.globalAlpha = tIn;
  if (s.transition === "slide") ctx.translate((1 - tIn) * W * 0.3, 0);
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const r = s.fit === "cover" ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
    const w = img.width * r;
    const h = img.height * r;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    if (s.title || s.body) {
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(0, 0, W, H);
    }
  }
  const font = FONTS[p.font];
  const pad = W * 0.08;
  ctx.fillStyle = s.textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const tSize = Math.round(W * 0.075);
  const bSize = Math.round(W * 0.045);
  ctx.font = `700 ${tSize}px ${font}`;
  const tl = s.title ? wrap(ctx, s.title, W - pad * 2) : [];
  ctx.font = `400 ${bSize}px ${font}`;
  const bl = s.body ? wrap(ctx, s.body, W - pad * 2) : [];
  const blockH = tl.length * tSize * 1.15 + (bl.length ? bSize * 0.8 : 0) + bl.length * bSize * 1.35;
  let y = s.textPosition === "top" ? H * 0.12 : s.textPosition === "bottom" ? H * 0.72 - blockH : (H - blockH) / 2;
  ctx.font = `700 ${tSize}px ${font}`;
  for (const l of tl) {
    ctx.fillText(l, W / 2, y);
    y += tSize * 1.15;
  }
  if (bl.length) y += bSize * 0.8;
  ctx.font = `400 ${bSize}px ${font}`;
  for (const l of bl) {
    ctx.fillText(l, W / 2, y);
    y += bSize * 1.35;
  }
  ctx.restore();
  if (p.burnCaptions && s.caption.trim()) {
    const cSize = Math.round(W * 0.04);
    ctx.font = `600 ${cSize}px ${font}`;
    const lines = wrap(ctx, s.caption.trim(), W * 0.8);
    const lh = cSize * 1.3;
    const boxH = lines.length * lh + cSize * 0.8;
    const top = H * 0.9 - boxH;
    ctx.fillStyle = "rgba(0,0,0,.72)";
    const boxW = Math.min(W * 0.9, Math.max(...lines.map((l) => ctx.measureText(l).width)) + cSize * 1.6);
    ctx.beginPath();
    ctx.roundRect((W - boxW) / 2, top, boxW, boxH, cSize * 0.4);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, W / 2, top + cSize * 0.4 + i * lh));
  }
}

function VideoEditor({ orgId, id, onBack }: { orgId: string; id: string; onBack: () => void }) {
  const access = useOrgAccess(orgId);
  const { data, error, reload } = useApi<any>(`/orgs/${orgId}/video/projects/${id}`);
  const media = useApi<any>(`/orgs/${orgId}/media`);
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [proj, setProj] = useState<Project | null>(null);
  const [version, setVersion] = useState(1);
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState<number | null>(null);
  const [output, setOutput] = useState<{ url: string; ext: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, ImageBitmap>());
  const stop = useRef(false);
  const canWrite = access.can("content:write");

  useEffect(() => {
    if (data?.project && !proj) {
      setName(data.project.name);
      setAspect(data.project.aspect);
      setProj(data.project.project);
      setVersion(data.project.version);
    }
  }, [data, proj]);

  const urlFor = (s: Scene) => (s.mediaId ? (s.mediaSource === "generated" ? `/api/v1/orgs/${orgId}/creative/images/${s.mediaId}/file` : `/api/v1/orgs/${orgId}/media/${s.mediaId}/file`) : null);
  const loadImages = async (p: Project) => {
    for (const s of p.scenes) {
      const u = urlFor(s);
      if (u && !images.current.has(s.mediaId!)) {
        const res = await fetch(u, { credentials: "same-origin" });
        if (res.ok) images.current.set(s.mediaId!, await createImageBitmap(await res.blob()));
      }
    }
  };
  const [W, H] = SIZE[aspect] ?? [720, 1280];
  const frameAt = (p: Project, t: number) => {
    let acc = 0;
    for (const s of p.scenes) {
      if (t < acc + s.durationMs) return { s, local: t - acc };
      acc += s.durationMs;
    }
    const last = p.scenes[p.scenes.length - 1]!;
    return { s: last, local: last.durationMs };
  };
  const paint = (t: number) => {
    const c = canvas.current?.getContext("2d");
    if (!c || !proj) return;
    const { s, local } = frameAt(proj, t);
    drawScene(c, proj, s, s.mediaId ? images.current.get(s.mediaId) : undefined, local, W, H);
  };
  useEffect(() => {
    if (!proj || playing || rendering !== null) return;
    let cancelled = false;
    loadImages(proj).then(() => {
      if (cancelled) return;
      const start = proj.scenes.slice(0, sel).reduce((a, s) => a + s.durationMs, 0);
      paint(start + 450);
    });
    return () => {
      cancelled = true;
    };
  }, [proj, sel, aspect, playing, rendering]);

  const total = proj ? proj.scenes.reduce((a, s) => a + s.durationMs, 0) : 0;
  const animate = (onFrame?: (t: number) => void) =>
    new Promise<void>((resolve) => {
      const t0 = performance.now();
      stop.current = false;
      const tick = () => {
        const t = performance.now() - t0;
        if (stop.current || t >= total) {
          paint(Math.min(t, total - 1));
          resolve();
          return;
        }
        paint(t);
        onFrame?.(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const play = async () => {
    if (!proj) return;
    await loadImages(proj);
    setPlaying(true);
    await animate();
    setPlaying(false);
  };

  const update = (p: Project) => {
    setProj(p);
    setDirty(true);
  };
  const setScene = (patchS: Partial<Scene>) => proj && update({ ...proj, scenes: proj.scenes.map((s, i) => (i === sel ? { ...s, ...patchS } : s)) });
  const save = async () => {
    if (!proj) return;
    setMsg(null);
    try {
      const r = await put(`/orgs/${orgId}/video/projects/${id}`, { name, aspect, project: proj, version });
      setVersion(r.version);
      setDirty(false);
      setMsg({ tone: "ok", text: "Proyecto guardado." });
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };

  const render = async () => {
    if (!proj || !canvas.current) return;
    if (typeof MediaRecorder === "undefined" || !canvas.current.captureStream) {
      setMsg({ tone: "warn", text: "Tu navegador no permite grabar vídeo. Usa Chrome, Edge o Firefox actualizados." });
      return;
    }
    setMsg(null);
    setOutput(null);
    await loadImages(proj);
    const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
    const stream = canvas.current.captureStream(30);
    let audioCtx: AudioContext | null = null;
    let audioEl: HTMLAudioElement | null = null;
    if (proj.audioId) {
      audioCtx = new AudioContext();
      audioEl = new Audio(`/api/v1/orgs/${orgId}/media/${proj.audioId}/file`);
      const srcNode = audioCtx.createMediaElementSource(audioEl);
      const gain = audioCtx.createGain();
      gain.gain.value = proj.audioVolume;
      const dest = audioCtx.createMediaStreamDestination();
      srcNode.connect(gain).connect(dest);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start(250);
    await audioEl?.play().catch(() => undefined);
    setRendering(0);
    await animate((t) => setRendering(Math.round((t / total) * 100)));
    rec.stop();
    audioEl?.pause();
    await done;
    await audioCtx?.close();
    setRendering(null);
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    setOutput({ url: URL.createObjectURL(blob), ext });
    await post(`/orgs/${orgId}/video/projects/${id}/exported`, { mimeType: mime.split(";")[0], bytes: blob.size, durationMs: total, width: W, height: H }).catch(() => undefined);
    setMsg({ tone: "ok", text: `Vídeo listo (${(blob.size / 1_048_576).toFixed(1)} MB, ${ext.toUpperCase()}). Descárgalo abajo.` });
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!proj) return <Skeleton className="h-96 rounded-2xl" />;
  const s = proj.scenes[sel]!;
  const images_ = [...(media.data?.uploads ?? []).filter((m: any) => m.kind === "image").map((m: any) => ({ id: m.id, label: m.name, source: "upload" })), ...(media.data?.generated ?? []).map((m: any) => ({ id: m.id, label: `IA: ${m.prompt.slice(0, 40)}`, source: "generated" }))];
  const audios = (media.data?.uploads ?? []).filter((m: any) => m.kind === "audio");
  return (
    <>
      <PageHeader
        eyebrow={<button type="button" className="hover:underline" onClick={() => (!dirty || confirm("Hay cambios sin guardar. ¿Salir?")) && onBack()}>← Video Studio</button>}
        title={name}
        subtitle={`${aspect} · ${(total / 1000).toFixed(1)} s · ${proj.scenes.length} escenas`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canWrite && <Button variant="primary" onClick={save} disabled={!dirty}>Guardar</Button>}
            <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" href={`/api/v1/orgs/${orgId}/video/projects/${id}/srt`}>SRT</a>
          </div>
        }
      />
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-3">
          <div className="mx-auto overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: `${W} / ${H}`, maxHeight: "70vh" }}>
            <canvas ref={canvas} width={W} height={H} className="h-full w-full" aria-label="Vista previa del vídeo" />
          </div>
          <div className="flex flex-wrap gap-2">
            {!playing ? <Button onClick={play} disabled={rendering !== null}><Play className="size-4" /> Reproducir</Button> : <Button onClick={() => (stop.current = true)}><Pause className="size-4" /> Parar</Button>}
            <Button variant="primary" onClick={render} disabled={playing || rendering !== null}>{rendering !== null ? `Renderizando… ${rendering} %` : "Renderizar vídeo"}</Button>
            {output && <a className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" href={output.url} download={`${name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.${output.ext}`}><Download className="size-4" /> Descargar .{output.ext}</a>}
          </div>
          <p className="text-xs text-mute">El render se graba en tiempo real en tu navegador (mantén esta pestaña visible). MP4 si tu navegador lo permite; si no, WebM (compatible con Instagram, TikTok y YouTube al subirlo).</p>
        </div>
        <div className="space-y-4">
          <Card title="Escenas">
            <ol className="flex gap-2 overflow-x-auto pb-1">
              {proj.scenes.map((sc, i) => (
                <li key={sc.id}>
                  <button type="button" onClick={() => setSel(i)} aria-current={i === sel} className={`min-w-28 rounded-xl border p-2 text-left text-xs ${i === sel ? "border-accent bg-surface-2" : "border-line"}`}>
                    <span className="block font-semibold">{i + 1}. {sc.title || "Sin título"}</span>
                    <span className="text-mute">{(sc.durationMs / 1000).toFixed(1)} s</span>
                  </button>
                </li>
              ))}
            </ol>
            {canWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button disabled={proj.scenes.length >= 40} onClick={() => { const n = { ...s, id: `s${Date.now().toString(36)}`, title: "Nueva escena", body: "", caption: "" }; update({ ...proj, scenes: [...proj.scenes.slice(0, sel + 1), n, ...proj.scenes.slice(sel + 1)] }); setSel(sel + 1); }}><Plus className="size-4" /> Escena</Button>
                <Button aria-label="Subir escena" disabled={sel === 0} onClick={() => { const a = [...proj.scenes]; [a[sel - 1], a[sel]] = [a[sel]!, a[sel - 1]!]; update({ ...proj, scenes: a }); setSel(sel - 1); }}><ArrowUp className="size-4" /></Button>
                <Button aria-label="Bajar escena" disabled={sel === proj.scenes.length - 1} onClick={() => { const a = [...proj.scenes]; [a[sel + 1], a[sel]] = [a[sel]!, a[sel + 1]!]; update({ ...proj, scenes: a }); setSel(sel + 1); }}><ArrowDown className="size-4" /></Button>
                <Button aria-label="Eliminar escena" disabled={proj.scenes.length === 1} onClick={() => { update({ ...proj, scenes: proj.scenes.filter((_, i) => i !== sel) }); setSel(Math.max(0, sel - 1)); }}><Trash2 className="size-4" /></Button>
              </div>
            )}
          </Card>
          <Card title={`Escena ${sel + 1}`}>
            <fieldset disabled={!canWrite} className="grid gap-3 sm:grid-cols-2">
              <TextField label="Título" maxLength={120} value={s.title} onChange={(e) => setScene({ title: e.target.value })} />
              <TextField label="Duración (segundos)" type="number" min={0.5} max={60} step={0.5} value={s.durationMs / 1000} onChange={(e) => setScene({ durationMs: Math.round(Math.min(60, Math.max(0.5, Number(e.target.value) || 0.5)) * 1000) })} />
              <div className="sm:col-span-2"><Field label="Texto" htmlFor="sc-body"><Textarea id="sc-body" maxLength={400} value={s.body} onChange={(e) => setScene({ body: e.target.value })} /></Field></div>
              <div className="sm:col-span-2"><TextField label="Subtítulo (también va al .srt)" maxLength={300} value={s.caption} onChange={(e) => setScene({ caption: e.target.value })} /></div>
              <Field label="Fondo" htmlFor="sc-bg"><Input id="sc-bg" type="color" value={s.background} onChange={(e) => setScene({ background: e.target.value })} className="h-10 p-1" /></Field>
              <Field label="Color del texto" htmlFor="sc-tc"><Input id="sc-tc" type="color" value={s.textColor} onChange={(e) => setScene({ textColor: e.target.value })} className="h-10 p-1" /></Field>
              <Field label="Posición del texto" htmlFor="sc-pos"><Select id="sc-pos" value={s.textPosition} onChange={(e) => setScene({ textPosition: e.target.value as Scene["textPosition"] })}><option value="top">Arriba</option><option value="center">Centro</option><option value="bottom">Abajo</option></Select></Field>
              <Field label="Transición de entrada" htmlFor="sc-tr"><Select id="sc-tr" value={s.transition} onChange={(e) => setScene({ transition: e.target.value as Scene["transition"] })}><option value="fade">Fundido</option><option value="slide">Deslizar</option><option value="none">Corte</option></Select></Field>
              <Field label="Imagen" htmlFor="sc-img"><Select id="sc-img" value={s.mediaId ?? ""} onChange={(e) => { const m = images_.find((x) => x.id === e.target.value); setScene({ mediaId: m?.id ?? null, mediaSource: (m?.source as Scene["mediaSource"]) ?? null }); }}><option value="">Sin imagen</option>{images_.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
              <Field label="Encaje" htmlFor="sc-fit"><Select id="sc-fit" value={s.fit} onChange={(e) => setScene({ fit: e.target.value as Scene["fit"] })}><option value="cover">Rellenar</option><option value="contain">Completa</option></Select></Field>
            </fieldset>
          </Card>
          <Card title="Proyecto">
            <fieldset disabled={!canWrite} className="grid gap-3 sm:grid-cols-2">
              <TextField label="Nombre" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
              <Field label="Formato" htmlFor="pj-asp"><Select id="pj-asp" value={aspect} onChange={(e) => { setAspect(e.target.value); setDirty(true); }}><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:5">4:5</option><option value="16:9">16:9</option></Select></Field>
              <Field label="Tipografía" htmlFor="pj-font"><Select id="pj-font" value={proj.font} onChange={(e) => update({ ...proj, font: e.target.value as Project["font"] })}><option value="system">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></Select></Field>
              <Field label="Música / locución" htmlFor="pj-audio"><Select id="pj-audio" value={proj.audioId ?? ""} onChange={(e) => update({ ...proj, audioId: e.target.value || null })}><option value="">Sin audio</option>{audios.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={proj.burnCaptions} onChange={(e) => update({ ...proj, burnCaptions: e.target.checked })} /> Incrustar los subtítulos en el vídeo</label>
            </fieldset>
          </Card>
          {canWrite && <MediaUpload orgId={orgId} onDone={() => media.reload()} />}
        </div>
      </div>
    </>
  );
}

export function MediaUpload({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("rightsConfirmed", rights ? "true" : "false");
      const res = await fetch(`/api/v1/orgs/${orgId}/media`, { method: "POST", credentials: "same-origin", headers: { "x-dni-csrf": "1" }, body: fd });
      const j = (await res.json().catch(() => ({}))) as { title?: string };
      if (!res.ok) throw new Error(j.title ?? "No se pudo subir el archivo.");
      setMsg({ tone: "ok", text: "Archivo subido." });
      setFile(null);
      setRights(false);
      onDone();
    } catch (e) {
      setMsg({ tone: "warn", text: e instanceof Error ? e.message : "No se pudo subir el archivo." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Subir imagen o audio" subtitle="PNG, JPG o WebP hasta 5 MB · MP3, WAV u OGG hasta 15 MB">
      <input type="file" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/ogg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" aria-label="Archivo" />
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={rights} onChange={(e) => setRights(e.target.checked)} /> Confirmo que tengo derechos para usar este archivo con fines comerciales (es mío, tengo licencia o permiso).</label>
      {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <Button className="mt-3" loading={busy} disabled={!file || !rights} onClick={upload}><Upload className="size-4" /> Subir</Button>
      <p className="mt-2 text-xs text-mute">¿Sin imágenes? Genera una en <Link className="text-accent-text hover:underline" to={`/o/${orgId}/creative`}>Creative Studio</Link>.</p>
    </Card>
  );
}
