import { useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router";
import { CheckCircle2, Circle, Code2, Download, Mail, Phone, Plus, Search, Target, Trash2, UserPlus } from "lucide-react";
import { ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, TextField, cx } from "../ui";
import { useOrgAccess } from "./org";

type Stage = "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";
const STAGES: Array<{ key: Stage; label: string; tone: "neutral" | "info" | "warn" | "ok" | "danger" }> = [
  { key: "new", label: "Nuevo", tone: "info" },
  { key: "contacted", label: "Contactado", tone: "neutral" },
  { key: "qualified", label: "Cualificado", tone: "neutral" },
  { key: "proposal", label: "Propuesta", tone: "warn" },
  { key: "won", label: "Ganado", tone: "ok" },
  { key: "lost", label: "Perdido", tone: "danger" },
];
const stageOf = (s: string) => STAGES.find((x) => x.key === s) ?? STAGES[0]!;

type Lead = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  source: "form" | "manual";
  form_name: string | null;
  source_url: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  stage: Stage;
  lost_reason: string | null;
  value: number | null;
  assigned_user_id: string | null;
  assigned_name: string | null;
  consent_contact: boolean;
  consent_marketing: boolean;
  consent_text: string | null;
  marketing_text: string | null;
  consent_at: string | null;
  submissions: number;
  is_test: boolean;
  open_tasks: number;
  created_at: string;
  updated_at: string;
  last_submitted_at: string | null;
};
type LeadList = {
  items: Lead[];
  stages: Array<{ stage: Stage; label: string; count: number; value: number }>;
  summary: { total: number; openPipelineValue: number; wonValue: number; winRate: number | null; measurement: string; note: string };
  caveats: string[];
};
type LeadEvent = { id: string; kind: string; data: Record<string, any>; created_at: string; actor_name: string | null };
type Task = { id: string; title: string; due_at: string | null; status: "open" | "done"; assigned_name: string | null; lead_id?: string; lead_name?: string };
type Form = {
  id: string;
  name: string;
  consent_text: string;
  marketing_text: string | null;
  privacy_url: string | null;
  success_message: string;
  redirect_url: string | null;
  allowedOrigins: string[];
  ask_phone: boolean;
  ask_company: boolean;
  notify: boolean;
  status: "active" | "paused" | "archived";
  submissions: number;
  spam_blocked: number;
  created_at: string;
};
type Member = { user_id: string; name: string; role: string; status: string };

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2, useGrouping: "always" });
const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : eur.format(v));
const CRM_ROLES = new Set(["owner", "admin", "marketing_manager"]);

const EVENT_LABEL: Record<string, (d: Record<string, any>) => string> = {
  submitted: (d) => `${d.first ? "Envió" : "Volvió a enviar"} el formulario «${d.formName ?? "—"}»${d.utm?.source ? ` · ${d.utm.source}${d.utm.medium ? `/${d.utm.medium}` : ""}${d.utm.campaign ? ` · ${d.utm.campaign}` : ""}` : ""}`,
  created_manually: (d) => `Creado a mano${d.isTest ? " (contacto de prueba)" : ""}`,
  stage_changed: (d) => `Etapa: ${stageOf(d.from).label} → ${stageOf(d.to).label}${d.lostReason ? ` (${d.lostReason})` : ""}`,
  value_changed: (d) => `Valor: ${money(d.from)} → ${money(d.to)}`,
  assigned: () => "Responsable cambiado",
  updated: (d) => `Datos actualizados (${d.field})`,
  note: () => "Nota",
  task_created: (d) => `Tarea creada: ${d.title}${d.dueAt ? ` · vence ${fmtDate(d.dueAt)}` : ""}`,
  task_done: (d) => `Tarea hecha: ${d.title}`,
  task_reopened: (d) => `Tarea reabierta: ${d.title}`,
};

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : "No se pudo completar la acción.";
}

export function CrmPage() {
  const { orgId } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "pipeline";
  const access = useOrgAccess(orgId);
  const base = `/orgs/${orgId}/crm`;
  const setTab = (t: string) => setSp((p) => (p.set("tab", t), p.delete("lead"), p));
  if (access.role && !access.can("crm:read"))
    return (
      <>
        <PageHeader eyebrow="F5 · CRM" title="CRM / Leads" />
        <Notice tone="warn" title="Sin acceso">
          Los contactos son datos personales: solo los ven propietario, administración y responsable de marketing.
        </Notice>
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow="F5 · CRM"
        title="CRM / Leads"
        subtitle="Contactos de tus formularios, sin duplicados, con su consentimiento, de dónde vienen y en qué punto están."
        actions={
          access.can("crm:write") ? (
            <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm hover:bg-surface-2" href={`/api/v1${base}/export`}>
              <Download className="size-4" aria-hidden /> Exportar CSV
            </a>
          ) : undefined
        }
      />
      <div role="tablist" aria-label="Secciones del CRM" className="mb-4 flex flex-wrap gap-2">
        {[
          ["pipeline", "Pipeline"],
          ["tasks", "Tareas"],
          ["forms", "Formularios"],
        ].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k!)} className={cx("min-h-10 rounded-full border px-4 text-sm", tab === k ? "border-ink bg-ink text-bg" : "border-line hover:bg-surface-2")}>
            {l}
          </button>
        ))}
      </div>
      {tab === "pipeline" && <Pipeline base={base} orgId={orgId!} canWrite={access.can("crm:write")} canDelete={access.can("crm:delete")} />}
      {tab === "tasks" && <Tasks base={base} />}
      {tab === "forms" && <Forms base={base} canManage={access.can("forms:manage")} />}
    </>
  );
}

function Pipeline({ base, orgId, canWrite, canDelete }: { base: string; orgId: string; canWrite: boolean; canDelete: boolean }) {
  const [sp, setSp] = useSearchParams();
  const [stage, setStage] = useState<string>("");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(false);
  const qs = new URLSearchParams({ ...(stage ? { stage } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(mine ? { mine: "1" } : {}) }).toString();
  const list = useApi<LeadList>(`${base}/leads${qs ? `?${qs}` : ""}`);
  const selected = sp.get("lead");
  const open = (id: string | null) => setSp((p) => (id ? p.set("lead", id) : p.delete("lead"), p));
  const d = list.data;
  return (
    <div className="space-y-4">
      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["Contactos", String(d.summary.total)],
            ["En curso (valor)", money(d.summary.openPipelineValue)],
            ["Ganado (valor)", money(d.summary.wonValue)],
            ["Tasa de cierre", d.summary.winRate === null ? "—" : `${Math.round(d.summary.winRate * 100)} %`],
          ].map(([l, v]) => (
            <div key={l} className="rounded-2xl border border-line bg-surface p-4">
              <p className="text-xs text-mute">{l}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{v}</p>
              <p className="text-xs text-mute">observado</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setStage("")} aria-pressed={!stage} className={cx("min-h-9 rounded-full border px-3 text-sm", !stage ? "border-ink bg-ink text-bg" : "border-line")}>
          Todos {d ? `· ${d.summary.total}` : ""}
        </button>
        {STAGES.map((s) => (
          <button key={s.key} type="button" onClick={() => setStage(s.key)} aria-pressed={stage === s.key} className={cx("min-h-9 rounded-full border px-3 text-sm", stage === s.key ? "border-ink bg-ink text-bg" : "border-line")}>
            {s.label} {d ? `· ${d.stages.find((x) => x.stage === s.key)?.count ?? 0}` : ""}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <label className="relative block">
          <span className="sr-only">Buscar contacto</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, email o empresa…" className="pl-9" />
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Solo los míos
        </label>
        {canWrite && (
          <Button onClick={() => setAdding((x) => !x)}>
            <UserPlus className="size-4" aria-hidden /> Añadir contacto
          </Button>
        )}
      </div>
      {adding && <AddLead base={base} onDone={(id) => (setAdding(false), list.reload(), id && open(id))} />}
      <div className={cx("grid gap-4", selected && "lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]")}>
        <div className={cx(selected && "hidden lg:block")}>
          {list.error && <ErrorState error={list.error} onRetry={list.reload} />}
          {!d && !list.error && <Spinner />}
          {d && d.items.length === 0 && (
            <EmptyState icon={<Target className="size-6" />} title={q || stage || mine ? "Ningún contacto coincide" : "Aún no hay contactos"}>
              {q || stage || mine ? "Prueba con otro filtro." : "Crea un formulario en la pestaña «Formularios» y pégalo en tu web: cada envío aparecerá aquí."}
            </EmptyState>
          )}
          {d && d.items.length > 0 && (
            <ul className="space-y-2">
              {d.items.map((l) => {
                const s = stageOf(l.stage);
                return (
                  <li key={l.id}>
                    <button type="button" onClick={() => open(l.id)} aria-current={selected === l.id} className={cx("w-full rounded-2xl border bg-surface p-4 text-left hover:border-ink/40", selected === l.id ? "border-ink" : "border-line")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 truncate font-medium">
                          {l.name} {l.company && <span className="font-normal text-mute">· {l.company}</span>}
                        </p>
                        <span className="flex items-center gap-2">
                          {l.is_test && <Badge>Prueba</Badge>}
                          <Badge tone={s.tone}>{s.label}</Badge>
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm text-mute">{l.email}</p>
                      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mute">
                        <span>{l.source === "form" ? `Formulario: ${l.form_name ?? "—"}` : "Alta manual"}</span>
                        {l.utm_source && <span>Origen: {l.utm_source}</span>}
                        {l.value !== null && <span className="text-ink">{money(l.value)}</span>}
                        {l.assigned_name && <span>Responsable: {l.assigned_name}</span>}
                        {l.open_tasks > 0 && <span>{l.open_tasks} tarea{l.open_tasks === 1 ? "" : "s"}</span>}
                        <span>Actualizado {timeAgo(l.updated_at)}</span>
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {d && (
            <div className="mt-3 space-y-1 text-xs text-mute">
              <p>{d.summary.note}</p>
              {d.caveats.map((c) => (
                <p key={c}>{c}</p>
              ))}
            </div>
          )}
        </div>
        {selected && <LeadDetail key={selected} base={base} orgId={orgId} leadId={selected} canWrite={canWrite} canDelete={canDelete} onClose={() => open(null)} onChanged={list.reload} />}
      </div>
    </div>
  );
}

function AddLead({ base, onDone }: { base: string; onDone: (id: string | null) => void }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "", value: "", isTest: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ id: string }>(`${base}/leads`, { name: f.name, email: f.email, phone: f.phone || null, company: f.company || null, valueEur: f.value ? Number(f.value.replace(",", ".")) : null, isTest: f.isTest });
      onDone(r.id);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Nuevo contacto" subtitle="Para contactos que llegan por teléfono, email o en persona. Asegúrate de tener una base legal para guardarlos.">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nombre" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        <TextField label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={254} />
        <TextField label="Teléfono (opcional)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} />
        <TextField label="Empresa (opcional)" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} maxLength={160} />
        <TextField label="Valor estimado en € (opcional)" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={f.isTest} onChange={(e) => setF({ ...f, isTest: e.target.checked })} /> Contacto de prueba (no cuenta en las cifras)
        </label>
        {err && <p className="text-sm text-danger sm:col-span-2">{err}</p>}
        <div className="flex gap-2 sm:col-span-2">
          <Button variant="primary" type="submit" loading={busy}>
            Guardar contacto
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function LeadDetail({ base, orgId, leadId, canWrite, canDelete, onClose, onChanged }: { base: string; orgId: string; leadId: string; canWrite: boolean; canDelete: boolean; onClose: () => void; onChanged: () => void }) {
  const r = useApi<{ lead: Lead; events: LeadEvent[]; tasks: Task[] }>(`${base}/leads/${leadId}`);
  const members = useApi<{ members: Member[] }>(canWrite ? `/orgs/${orgId}/members` : null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [task, setTask] = useState({ title: "", due: "" });
  const [value, setValue] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      r.reload();
      onChanged();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const crmMembers = useMemo(() => (members.data?.members ?? []).filter((m) => m.status === "active" && CRM_ROLES.has(m.role)), [members.data]);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Spinner />;
  const { lead: l, events, tasks } = r.data;
  const update = (body: Record<string, unknown>) => run("lead", () => patch(`${base}/leads/${l.id}`, body));
  return (
    <Card
      title={l.name}
      subtitle={l.company ?? undefined}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-3 hover:bg-surface-2" href={`mailto:${l.email}`}>
            <Mail className="size-4" aria-hidden /> <span className="break-all">{l.email}</span>
          </a>
          {l.phone && (
            <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-3 hover:bg-surface-2" href={`tel:${l.phone.replace(/[^\d+]/g, "")}`}>
              <Phone className="size-4" aria-hidden /> {l.phone}
            </a>
          )}
          {l.is_test && <Badge>Contacto de prueba</Badge>}
        </div>
        {msg && <p className="text-danger">{msg}</p>}

        {canWrite ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Etapa" htmlFor="lead-stage">
              <Select id="lead-stage" value={l.stage} disabled={busy === "lead"} onChange={(e) => (e.target.value === "lost" ? update({ stage: "lost", lostReason: lostReason || null }) : update({ stage: e.target.value }))}>
                {STAGES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Responsable" htmlFor="lead-owner">
              <Select id="lead-owner" value={l.assigned_user_id ?? ""} disabled={busy === "lead"} onChange={(e) => update({ assignedUserId: e.target.value || null })}>
                <option value="">Sin asignar</option>
                {crmMembers.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Valor (€)" htmlFor="lead-value" hint="Lo introduce tu equipo; no se estima.">
              <div className="flex gap-2">
                <Input id="lead-value" inputMode="decimal" value={value ?? (l.value === null ? "" : String(l.value).replace(".", ","))} onChange={(e) => setValue(e.target.value)} />
                <Button disabled={value === null || busy === "lead"} onClick={() => update({ valueEur: value && value.trim() ? Number(value.replace(",", ".")) : null }).then(() => setValue(null))}>
                  Guardar
                </Button>
              </div>
            </Field>
            {l.stage === "lost" ? (
              <Field label="Motivo de pérdida" htmlFor="lead-lost">
                <div className="flex gap-2">
                  <Input id="lead-lost" defaultValue={l.lost_reason ?? ""} onChange={(e) => setLostReason(e.target.value)} maxLength={300} />
                  <Button disabled={busy === "lead"} onClick={() => update({ lostReason: lostReason || null })}>
                    Guardar
                  </Button>
                </div>
              </Field>
            ) : (
              <label className="flex items-center gap-2 self-end">
                <input type="checkbox" checked={l.is_test} onChange={(e) => update({ isTest: e.target.checked })} /> Contacto de prueba
              </label>
            )}
          </div>
        ) : (
          <p>
            <Badge tone={stageOf(l.stage).tone}>{stageOf(l.stage).label}</Badge> · Valor {money(l.value)} · {l.assigned_name ?? "Sin asignar"}
          </p>
        )}

        {l.message && (
          <div>
            <p className="text-mute">Último mensaje</p>
            <p className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-surface-2/60 p-3">{l.message}</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-mute">Origen</p>
            <ul className="mt-1 space-y-0.5">
              <li>{l.source === "form" ? `Formulario «${l.form_name ?? "—"}»` : "Alta manual"}</li>
              {l.source_url && <li className="break-all">Página: {l.source_url}</li>}
              {l.referrer_host && <li>Llegó desde: {l.referrer_host}</li>}
              {(l.utm_source || l.utm_medium || l.utm_campaign) && <li>UTM: {[l.utm_source, l.utm_medium, l.utm_campaign, l.utm_term, l.utm_content].filter(Boolean).join(" · ")}</li>}
              <li>
                Envíos: {l.submissions} · alta {fmtDate(l.created_at)}
              </li>
            </ul>
          </div>
          <div>
            <p className="text-mute">Consentimiento</p>
            <ul className="mt-1 space-y-0.5">
              <li>
                Responder a su solicitud: <strong>{l.consent_contact ? "sí" : "no consta"}</strong>
              </li>
              <li>
                Comunicaciones comerciales: <strong>{l.consent_marketing ? "sí" : "no"}</strong>
              </li>
              {l.consent_at && <li>Fecha: {fmtDate(l.consent_at)}</li>}
              {l.consent_text && <li className="text-xs text-mute">Texto aceptado: «{l.consent_text}»</li>}
            </ul>
          </div>
        </div>

        <div>
          <p className="font-medium">Tareas</p>
          {tasks.length === 0 && <p className="text-mute">Sin tareas.</p>}
          <ul className="mt-1 space-y-1">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                <button type="button" disabled={!canWrite || busy === t.id} aria-label={t.status === "done" ? `Reabrir tarea ${t.title}` : `Marcar como hecha ${t.title}`} onClick={() => run(t.id, () => patch(`${base}/tasks/${t.id}`, { status: t.status === "done" ? "open" : "done" }))} className="mt-0.5">
                  {t.status === "done" ? <CheckCircle2 className="size-5 text-ok" aria-hidden /> : <Circle className="size-5 text-mute" aria-hidden />}
                </button>
                <span className={cx(t.status === "done" && "text-mute line-through")}>
                  {t.title}
                  {t.due_at && <span className={cx("ml-1 text-xs", t.status === "open" && Date.parse(t.due_at) < Date.now() ? "text-danger" : "text-mute")}>· vence {fmtDate(t.due_at)}</span>}
                  {t.assigned_name && <span className="ml-1 text-xs text-mute">· {t.assigned_name}</span>}
                </span>
              </li>
            ))}
          </ul>
          {canWrite && (
            <form
              className="mt-2 grid gap-2 sm:grid-cols-[1fr_170px_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!task.title.trim()) return;
                void run("task", () => post(`${base}/leads/${l.id}/tasks`, { title: task.title, dueAt: task.due ? new Date(`${task.due}T09:00:00`).toISOString() : null })).then(() => setTask({ title: "", due: "" }));
              }}
            >
              <label className="sr-only" htmlFor="task-title">
                Nueva tarea
              </label>
              <Input id="task-title" placeholder="Nueva tarea (p. ej. llamar el martes)" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} maxLength={200} />
              <label className="sr-only" htmlFor="task-due">
                Fecha de vencimiento
              </label>
              <Input id="task-due" type="date" value={task.due} onChange={(e) => setTask({ ...task, due: e.target.value })} />
              <Button type="submit" loading={busy === "task"}>
                <Plus className="size-4" aria-hidden /> Añadir
              </Button>
            </form>
          )}
        </div>

        {canWrite && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) return;
              void run("note", () => post(`${base}/leads/${l.id}/notes`, { text: note })).then(() => setNote(""));
            }}
          >
            <Field label="Añadir nota" htmlFor="lead-note">
              <Textarea id="lead-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Resumen de la llamada, próximos pasos…" />
            </Field>
            <Button className="mt-2" type="submit" loading={busy === "note"}>
              Guardar nota
            </Button>
          </form>
        )}

        <div>
          <p className="font-medium">Historial</p>
          <ol className="mt-2 space-y-2 border-l border-line pl-4">
            {events.map((e) => (
              <li key={e.id}>
                <p className="text-xs text-mute">
                  {fmtDate(e.created_at)}
                  {e.actor_name ? ` · ${e.actor_name}` : e.kind === "submitted" ? " · formulario web" : ""}
                </p>
                <p>{(EVENT_LABEL[e.kind] ?? (() => e.kind))(e.data)}</p>
                {e.kind === "note" && <p className="whitespace-pre-wrap break-words text-mute">{e.data.text}</p>}
                {e.kind === "submitted" && e.data.message && <p className="line-clamp-3 whitespace-pre-wrap break-words text-mute">{e.data.message}</p>}
              </li>
            ))}
          </ol>
        </div>

        {canDelete && (
          <div className="border-t border-line pt-3">
            <Button
              variant="ghost"
              className="text-danger"
              loading={busy === "delete"}
              onClick={() => {
                if (!window.confirm(`¿Borrar definitivamente a ${l.name}, su historial y sus tareas? Úsalo cuando la persona ejerza su derecho de supresión. No se puede deshacer.`)) return;
                void run("delete", () => del(`${base}/leads/${l.id}`)).then(onClose);
              }}
            >
              <Trash2 className="size-4" aria-hidden /> Borrar contacto (derecho de supresión)
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Tasks({ base }: { base: string }) {
  const [mine, setMine] = useState(true);
  const [, setSp] = useSearchParams();
  const r = useApi<{ items: Task[] }>(`${base}/tasks${mine ? "?mine=1" : ""}`);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Card
      title="Tareas abiertas"
      actions={
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Solo las mías
        </label>
      }
    >
      {r.error && <ErrorState error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Spinner />}
      {r.data && r.data.items.length === 0 && <p className="text-sm text-mute">No hay tareas abiertas.</p>}
      <ul className="divide-y divide-line">
        {r.data?.items.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <button
              type="button"
              aria-label={`Marcar como hecha ${t.title}`}
              disabled={busy === t.id}
              onClick={async () => {
                setBusy(t.id);
                try {
                  await patch(`${base}/tasks/${t.id}`, { status: "done" });
                  r.reload();
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Circle className="size-5 text-mute" aria-hidden />
            </button>
            <span className="min-w-0 flex-1">
              {t.title}
              <span className="block text-xs text-mute">
                <button type="button" className="text-accent-text hover:underline" onClick={() => setSp(new URLSearchParams({ tab: "pipeline", lead: t.lead_id! }))}>
                  {t.lead_name}
                </button>
                {t.assigned_name && ` · ${t.assigned_name}`}
              </span>
            </span>
            <span className={cx("text-xs", t.due_at && Date.parse(t.due_at) < Date.now() ? "text-danger" : "text-mute")}>{t.due_at ? `Vence ${fmtDate(t.due_at)}` : "Sin fecha"}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const h = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function embedCode(submitBase: string, f: Form): string {
  const action = `${submitBase}/${f.id}/submit`;
  const lines = [
    `<form action="${action}" method="post" class="dni-lead-form">`,
    `  <p><label>Nombre<br><input name="name" required maxlength="120" autocomplete="name"></label></p>`,
    `  <p><label>Email<br><input name="email" type="email" required maxlength="254" autocomplete="email"></label></p>`,
    f.ask_phone ? `  <p><label>Teléfono (opcional)<br><input name="phone" type="tel" maxlength="40" autocomplete="tel"></label></p>` : null,
    f.ask_company ? `  <p><label>Empresa (opcional)<br><input name="company" maxlength="160" autocomplete="organization"></label></p>` : null,
    `  <p><label>Mensaje<br><textarea name="message" maxlength="3000" rows="4"></textarea></label></p>`,
    `  <!-- Antispam: no lo borres ni lo muestres -->`,
    `  <p style="position:absolute;left:-9999px" aria-hidden="true"><label>No rellenar<input name="website" tabindex="-1" autocomplete="off"></label></p>`,
    `  <p><label><input type="checkbox" name="consent" required> ${h(f.consent_text)}${f.privacy_url ? ` <a href="${h(f.privacy_url)}" target="_blank" rel="noopener">Política de privacidad</a>` : ""}</label></p>`,
    f.marketing_text ? `  <p><label><input type="checkbox" name="marketing"> ${h(f.marketing_text)}</label></p>` : null,
    `  <input type="hidden" name="_t"><input type="hidden" name="page_url"><input type="hidden" name="referrer">`,
    `  <button type="submit">Enviar</button>`,
    `</form>`,
    `<script>(function(f){var q=new URLSearchParams(location.search);f._t.value=Date.now();f.page_url.value=location.href;f.referrer.value=document.referrer;["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(function(k){if(q.get(k)){var i=document.createElement("input");i.type="hidden";i.name=k;i.value=q.get(k).slice(0,200);f.appendChild(i)}})})(document.currentScript.previousElementSibling);</script>`,
  ];
  return lines.filter(Boolean).join("\n");
}

function Forms({ base, canManage }: { base: string; canManage: boolean }) {
  const r = useApi<{ items: Form[]; usage: { used: number; limit: number; plan: string }; submitBase: string }>(`${base}/forms`);
  const [editing, setEditing] = useState<Form | "new" | null>(null);
  const [embed, setEmbed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Spinner />;
  const { items, usage, submitBase } = r.data;
  return (
    <div className="space-y-4">
      <Card
        title="Formularios de captación"
        subtitle={`${usage.used} de ${usage.limit} en tu plan. Antispam sin cookies ni rastreo: campo trampa, tiempo mínimo, límite de envíos por IP y por día, y solo desde las webs que autorices.`}
        actions={
          canManage && usage.used < usage.limit ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" aria-hidden /> Nuevo formulario
            </Button>
          ) : undefined
        }
      >
        {items.length === 0 && <p className="text-sm text-mute">Aún no hay formularios.</p>}
        <ul className="divide-y divide-line">
          {items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {f.name} <Badge tone={f.status === "active" ? "ok" : "neutral"}>{f.status === "active" ? "Activo" : "En pausa"}</Badge>
                </p>
                <p className="text-xs text-mute">
                  {f.submissions} envíos · {f.spam_blocked} bloqueados como spam · webs autorizadas: {f.allowedOrigins.length ? f.allowedOrigins.join(", ") : "solo DNI Growth"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => (setEmbed(embed === f.id ? null : f.id), setCopied(false))}>
                  <Code2 className="size-4" aria-hidden /> Código
                </Button>
                {canManage && (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(f)}>
                      Editar
                    </Button>
                    <Button variant="ghost" onClick={() => patch(`${base}/forms/${f.id}`, { status: f.status === "active" ? "paused" : "active" }).then(r.reload)}>
                      {f.status === "active" ? "Pausar" : "Activar"}
                    </Button>
                  </>
                )}
              </div>
              {embed === f.id && (
                <div className="w-full">
                  <p className="mb-2 text-xs text-mute">Pega este código en tu web (en una de las webs autorizadas). Funciona también sin JavaScript. Dale el estilo que quieras con la clase «dni-lead-form».</p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-2 p-3 text-xs">{embedCode(submitBase, f)}</pre>
                  <Button className="mt-2" onClick={() => navigator.clipboard.writeText(embedCode(submitBase, f)).then(() => setCopied(true))}>
                    {copied ? "Copiado" : "Copiar código"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {editing && <FormEditor base={base} form={editing === "new" ? null : editing} onDone={() => (setEditing(null), r.reload())} />}
    </div>
  );
}

function FormEditor({ base, form, onDone }: { base: string; form: Form | null; onDone: () => void }) {
  const [f, setF] = useState({
    name: form?.name ?? "Contacto web",
    allowedOrigins: (form?.allowedOrigins ?? []).join("\n"),
    privacyUrl: form?.privacy_url ?? "",
    redirectUrl: form?.redirect_url ?? "",
    consentText: form?.consent_text ?? "",
    marketingText: form?.marketing_text ?? "",
    successMessage: form?.success_message ?? "",
    askPhone: form?.ask_phone ?? true,
    askCompany: form?.ask_company ?? true,
    notify: form?.notify ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = {
      name: f.name,
      allowedOrigins: f.allowedOrigins.split(/[\s,]+/).filter(Boolean),
      privacyUrl: f.privacyUrl.trim() || null,
      redirectUrl: f.redirectUrl.trim() || null,
      askPhone: f.askPhone,
      askCompany: f.askCompany,
      notify: f.notify,
      marketingText: f.marketingText.trim() || null,
    };
    if (f.consentText.trim()) body.consentText = f.consentText;
    if (f.successMessage.trim()) body.successMessage = f.successMessage;
    try {
      if (form) await patch(`${base}/forms/${form.id}`, body);
      else await post(`${base}/forms`, body);
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={form ? `Editar «${form.name}»` : "Nuevo formulario"}>
      <form onSubmit={save} className="grid gap-3">
        <TextField label="Nombre interno" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        <Field label="Webs autorizadas (una por línea)" htmlFor="ff-origins" hint="Ej.: https://tuweb.es. Los envíos desde otras webs se rechazan.">
          <Textarea id="ff-origins" value={f.allowedOrigins} onChange={(e) => setF({ ...f, allowedOrigins: e.target.value })} placeholder="https://tuweb.es" />
        </Field>
        <TextField label="URL de tu política de privacidad" type="url" value={f.privacyUrl} onChange={(e) => setF({ ...f, privacyUrl: e.target.value })} placeholder="https://tuweb.es/privacidad" />
        <TextField label="Texto del consentimiento obligatorio" value={f.consentText} onChange={(e) => setF({ ...f, consentText: e.target.value })} placeholder="Acepto que se traten mis datos para responder a mi solicitud, según la política de privacidad." maxLength={500} />
        <TextField label="Texto de comunicaciones comerciales (opcional; vacío = no se pregunta)" value={f.marketingText} onChange={(e) => setF({ ...f, marketingText: e.target.value })} maxLength={300} />
        <TextField label="Mensaje tras enviar" value={f.successMessage} onChange={(e) => setF({ ...f, successMessage: e.target.value })} placeholder="Gracias. Hemos recibido tu mensaje…" maxLength={300} />
        <TextField label="Página de gracias (opcional, https)" type="url" value={f.redirectUrl} onChange={(e) => setF({ ...f, redirectUrl: e.target.value })} />
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.askPhone} onChange={(e) => setF({ ...f, askPhone: e.target.checked })} /> Pedir teléfono
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.askCompany} onChange={(e) => setF({ ...f, askCompany: e.target.checked })} /> Pedir empresa
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /> Avisarme por email (sin datos personales)
          </label>
        </div>
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex gap-2">
          <Button variant="primary" type="submit" loading={busy}>
            Guardar
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}
