import { useState } from "react";
import { useParams } from "react-router";
import { Download, Plus, Trash2, Workflow } from "lucide-react";
import { ApiError, del, post, put, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, TextField } from "../ui";
import { useOrgAccess } from "./org";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "No se pudo completar la acción.");
const STAGES: Record<string, string> = { new: "Nuevo", contacted: "Contactado", qualified: "Cualificado", proposal: "Propuesta", won: "Ganado", lost: "Perdido" };
const TRIGGERS: Record<string, string> = { lead_created: "Entra un contacto nuevo", stage_changed: "Un contacto cambia de etapa", task_overdue: "Una tarea vence sin completarse" };
const RUN: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = { done: { label: "Ejecutada", tone: "ok" }, partial: { label: "Parcial", tone: "warn" }, failed: { label: "Fallida", tone: "danger" }, skipped: { label: "Omitida", tone: "neutral" }, dry_run: { label: "Simulación", tone: "info" } };
const DELIVERY: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = { queued: { label: "En cola", tone: "neutral" }, delivered: { label: "Entregado", tone: "ok" }, failed: { label: "Reintentando", tone: "warn" }, dead: { label: "Descartado", tone: "danger" } };

type Cond = { field: string; op: string; value: unknown };
type Act = Record<string, unknown> & { type: string };
type Draft = { id?: string; name: string; trigger: string; conditions: Cond[]; actions: Act[]; enabled: boolean };
const EMPTY: Draft = { name: "", trigger: "lead_created", conditions: [], actions: [{ type: "create_task", title: "Llamar al contacto", dueHours: 24 }], enabled: false };

const NEW_COND: Record<string, () => Cond> = {
  form_id: () => ({ field: "form_id", op: "eq", value: "" }),
  utm_source: () => ({ field: "utm_source", op: "eq", value: "" }),
  stage: () => ({ field: "stage", op: "eq", value: "won" }),
  value_eur: () => ({ field: "value_eur", op: "gte", value: 1000 }),
  consent_marketing: () => ({ field: "consent_marketing", op: "eq", value: true }),
};
const COND_LABEL: Record<string, string> = { form_id: "Formulario", utm_source: "Origen (utm_source)", stage: "Etapa", value_eur: "Valor (€) mayor o igual a", consent_marketing: "Acepta comunicaciones comerciales" };
const NEW_ACT: Record<string, () => Act> = {
  create_task: () => ({ type: "create_task", title: "Llamar al contacto", dueHours: 24 }),
  set_stage: () => ({ type: "set_stage", stage: "contacted" }),
  assign: () => ({ type: "assign", userId: "" }),
  notify_team: () => ({ type: "notify_team", message: "Revisa este contacto en el CRM." }),
  webhook: () => ({ type: "webhook", url: "https://" }),
};
const ACT_LABEL: Record<string, string> = { create_task: "Crear tarea", set_stage: "Cambiar etapa", assign: "Asignar a", notify_team: "Avisar al equipo por correo", webhook: "Enviar webhook firmado" };

export function AutomationsPage() {
  const { orgId } = useParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/automations/rules`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [dry, setDry] = useState<{ ruleId: string; leadId: string; out?: any }>({ ruleId: "", leadId: "" });
  const canWrite = access.can("crm:write");

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setMsg(null);
    try {
      const body = { name: draft.name, trigger: draft.trigger, conditions: draft.conditions, actions: draft.actions, enabled: draft.enabled };
      const r = draft.id ? await put(`/orgs/${orgId}/automations/rules/${draft.id}`, body) : await post(`/orgs/${orgId}/automations/rules`, body);
      if (r.webhookSecret) setSecret(r.webhookSecret);
      setDraft(null);
      setMsg({ tone: "ok", text: draft.enabled ? "Regla guardada y activa." : "Regla guardada (desactivada). Actívala cuando la hayas probado." });
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (r: any) => {
    setBusy(r.id);
    try {
      await put(`/orgs/${orgId}/automations/rules/${r.id}`, { name: r.name, trigger: r.trigger, conditions: r.conditions, actions: r.actions, enabled: !r.enabled });
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const runDry = async () => {
    setBusy("dry");
    try {
      const out = await post(`/orgs/${orgId}/automations/rules/${dry.ruleId}/dry-run`, { leadId: dry.leadId.trim() });
      setDry((d) => ({ ...d, out }));
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Conversión · Automatizaciones"
        title="Reglas que trabajan por ti"
        subtitle="Cuando pasa algo en el CRM (entra un contacto, cambia de etapa o vence una tarea) se ejecutan tus acciones. Cada evento se procesa una sola vez y queda registrado."
        actions={canWrite && !draft ? <Button variant="primary" onClick={() => setDraft({ ...EMPTY, actions: [...EMPTY.actions] })}><Plus className="size-4" /> Nueva regla</Button> : undefined}
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {secret && (
        <div className="mb-4">
          <Notice tone="warn" title="Clave de firma del webhook (se muestra una sola vez)">
            <code className="break-all">{secret}</code>
            <p className="mt-2 text-xs">Úsala en tu servidor para verificar la cabecera <code>x-dni-signature</code> (HMAC-SHA256 de «t.cuerpo»). Guárdala en un lugar seguro.</p>
            <Button className="mt-2 min-h-8 px-3 text-xs" onClick={() => setSecret(null)}>Ya la he guardado</Button>
          </Notice>
        </div>
      )}
      {draft && data && <RuleEditor draft={draft} setDraft={setDraft} data={data} onSave={save} onCancel={() => setDraft(null)} busy={busy === "save"} />}
      {data && (
        <div className="space-y-6">
          <p className="text-xs text-mute">Reglas usadas: {data.usage.used} de {data.usage.limit} en tu plan. Las acciones nunca envían datos personales por correo ni webhook.</p>
          {data.rules.length === 0 && !draft ? (
            <EmptyState icon={<Workflow className="size-8" />} title="Sin reglas todavía" action={canWrite ? <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>Crear la primera regla</Button> : undefined}>
              Ejemplo: «Cuando entre un contacto desde Google Ads, crea una tarea para llamarle en 1 hora y avisa al equipo».
            </EmptyState>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.rules.map((r: any) => (
                <Card key={r.id} title={r.name} subtitle={TRIGGERS[r.trigger]} actions={<Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "Activa" : "Desactivada"}</Badge>}>
                  {r.conditions.length > 0 && <p className="text-xs text-mute">Si: {r.conditions.map((c: Cond) => `${COND_LABEL[c.field]} ${c.field === "stage" ? STAGES[c.value as string] : c.field === "form_id" ? (data.forms.find((f: any) => f.id === c.value)?.name ?? "formulario") : String(c.value)}`).join(" · ")}</p>}
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{r.summary.map((s: string) => <li key={s}>{s}</li>)}</ul>
                  {canWrite && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button className="min-h-9" loading={busy === r.id} onClick={() => toggle(r)}>{r.enabled ? "Desactivar" : "Activar"}</Button>
                      <Button className="min-h-9" onClick={() => setDraft({ id: r.id, name: r.name, trigger: r.trigger, conditions: r.conditions, actions: r.actions, enabled: r.enabled })}>Editar</Button>
                      <Button className="min-h-9" onClick={() => setDry({ ruleId: r.id, leadId: "" })}>Simular</Button>
                      <Button className="min-h-9" aria-label={`Eliminar ${r.name}`} onClick={async () => { if (confirm(`¿Eliminar la regla «${r.name}»? Su historial también se borrará.`)) { await del(`/orgs/${orgId}/automations/rules/${r.id}`); reload(); } }}><Trash2 className="size-4" /></Button>
                    </div>
                  )}
                  {dry.ruleId === r.id && (
                    <div className="mt-4 rounded-xl border border-line p-3">
                      <Field label="ID del contacto para simular (cópialo del CRM)" htmlFor={`dry-${r.id}`}><Input id={`dry-${r.id}`} value={dry.leadId} onChange={(e) => setDry({ ruleId: r.id, leadId: e.target.value })} placeholder="00000000-0000-…" /></Field>
                      <Button className="mt-2 min-h-9" loading={busy === "dry"} onClick={runDry} disabled={dry.leadId.trim().length !== 36}>Simular sin ejecutar</Button>
                      {dry.out && <p className="mt-2 text-sm">{dry.out.matches ? `Se cumplirían las condiciones y haría: ${dry.out.wouldDo.join("; ")}.` : "Las condiciones NO se cumplen para este contacto: no haría nada."}</p>}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Historial de ejecuciones" subtitle="Últimas 50">
              {data.runs.length === 0 ? <p className="text-sm text-mute">Sin ejecuciones aún.</p> : (
                <ul className="divide-y divide-line text-sm">
                  {data.runs.map((r: any) => {
                    const d = JSON.parse(r.detail_json || "{}");
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                        <Badge tone={RUN[r.status]?.tone}>{RUN[r.status]?.label ?? r.status}</Badge>
                        <span className="min-w-0 flex-1">{r.rule_name}{d.failed?.length ? <span className="text-xs text-danger"> · fallos: {d.failed.join(", ")}</span> : null}</span>
                        <span className="text-xs text-mute">{timeAgo(r.created_at)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title="Envíos de webhooks" subtitle="Reintentos: 1 min, 5 min, 30 min, 2 h y 12 h; después se descarta">
              {data.deliveries.length === 0 ? <p className="text-sm text-mute">Sin envíos.</p> : (
                <ul className="divide-y divide-line text-sm">
                  {data.deliveries.map((d: any) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                      <Badge tone={DELIVERY[d.status]?.tone}>{DELIVERY[d.status]?.label}</Badge>
                      <span className="min-w-0 flex-1 break-all text-xs">{d.url} · {d.attempts} intento(s){d.last_error ? ` · ${d.last_error}` : ""}</span>
                      {canWrite && (d.status === "dead" || d.status === "failed") && <Button className="min-h-8 px-3 text-xs" onClick={async () => { await post(`/orgs/${orgId}/automations/deliveries/${d.id}/retry`, {}); reload(); }}>Reintentar</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function RuleEditor({ draft, setDraft, data, onSave, onCancel, busy }: { draft: Draft; setDraft: (d: Draft) => void; data: any; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const setCond = (i: number, p: Partial<Cond>) => set({ conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setAct = (i: number, p: Record<string, unknown>) => set({ actions: draft.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  return (
    <Card className="mb-6" title={draft.id ? "Editar regla" : "Nueva regla"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Nombre" required minLength={3} maxLength={120} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Llamar a contactos de Google Ads" />
        <Field label="Cuando…" htmlFor="rule-trigger">
          <Select id="rule-trigger" value={draft.trigger} onChange={(e) => set({ trigger: e.target.value })}>{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
      </div>
      <h3 className="mt-5 text-sm font-semibold">Solo si… (todas se cumplen)</h3>
      <div className="mt-2 space-y-2">
        {draft.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-line p-2">
            <span className="text-sm font-medium">{COND_LABEL[c.field]}</span>
            {c.field === "form_id" && <Select aria-label="Formulario" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })} className="w-auto">{[<option key="" value="">Elige…</option>, ...data.forms.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)]}</Select>}
            {c.field === "utm_source" && (
              <>
                <Select aria-label="Comparación" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="w-auto"><option value="eq">es</option><option value="contains">contiene</option></Select>
                <Input aria-label="Valor" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })} className="w-40" placeholder="google" />
              </>
            )}
            {c.field === "stage" && <Select aria-label="Etapa" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value })} className="w-auto">{Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
            {c.field === "value_eur" && <Input aria-label="Valor mínimo" type="number" min={0} value={Number(c.value)} onChange={(e) => setCond(i, { value: Number(e.target.value) })} className="w-32" />}
            {c.field === "consent_marketing" && <Select aria-label="Consentimiento" value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value === "true" })} className="w-auto"><option value="true">Sí</option><option value="false">No</option></Select>}
            <Button className="ml-auto min-h-9 px-2" aria-label="Quitar condición" onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Select aria-label="Añadir condición" value="" onChange={(e) => e.target.value && set({ conditions: [...draft.conditions, NEW_COND[e.target.value]!()] })} className="w-auto">
          <option value="">+ Añadir condición</option>
          {Object.entries(COND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      <h3 className="mt-5 text-sm font-semibold">Entonces… (máximo 5 acciones)</h3>
      <div className="mt-2 space-y-2">
        {draft.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-line p-2">
            <span className="text-sm font-medium">{ACT_LABEL[a.type]}</span>
            {a.type === "create_task" && (
              <>
                <Input aria-label="Título de la tarea" value={String(a.title)} onChange={(e) => setAct(i, { title: e.target.value })} className="min-w-48 flex-1" />
                <Input aria-label="Vence en horas" type="number" min={1} max={720} value={Number(a.dueHours)} onChange={(e) => setAct(i, { dueHours: Number(e.target.value) })} className="w-24" />
                <span className="text-xs text-mute">h</span>
              </>
            )}
            {a.type === "set_stage" && <Select aria-label="Nueva etapa" value={String(a.stage)} onChange={(e) => setAct(i, { stage: e.target.value })} className="w-auto">{Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
            {a.type === "assign" && <Select aria-label="Persona" value={String(a.userId)} onChange={(e) => setAct(i, { userId: e.target.value })} className="w-auto">{[<option key="" value="">Elige…</option>, ...data.members.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)]}</Select>}
            {a.type === "notify_team" && <Input aria-label="Mensaje" value={String(a.message)} onChange={(e) => setAct(i, { message: e.target.value })} className="min-w-48 flex-1" maxLength={300} />}
            {a.type === "webhook" && <Input aria-label="URL https del webhook" type="url" value={String(a.url)} onChange={(e) => setAct(i, { url: e.target.value })} className="min-w-48 flex-1" />}
            <Button className="ml-auto min-h-9 px-2" aria-label="Quitar acción" onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {draft.actions.length < 5 && (
          <Select aria-label="Añadir acción" value="" onChange={(e) => e.target.value && set({ actions: [...draft.actions, NEW_ACT[e.target.value]!()] })} className="w-auto">
            <option value="">+ Añadir acción</option>
            {Object.entries(ACT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        )}
      </div>
      <label className="mt-5 flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Activar la regla al guardar</label>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" loading={busy} onClick={onSave} disabled={draft.name.trim().length < 3 || draft.actions.length === 0}>Guardar</Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
    </Card>
  );
}

// ── Attribution ─────────────────────────────────────────────────────────────────────────────────
const GROUPS: Record<string, string> = { source: "Origen / medio", campaign: "Campaña (utm_campaign)", landing: "Landing", form: "Formulario" };
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")} %`);
const eur = (v: number) => v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export function AttributionPage() {
  const { orgId } = useParams();
  const [days, setDays] = useState("90");
  const [group, setGroup] = useState("source");
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/crm/attribution?days=${days}&group=${group}`);
  const max = Math.max(1, ...(data?.rows ?? []).map((r: any) => r.leads));
  return (
    <>
      <PageHeader
        eyebrow="Medición · Atribución"
        title="¿Qué canales traen clientes?"
        subtitle="Del clic (UTM) al formulario, del formulario al CRM y del CRM a la venta ganada. Solo con tus contactos reales."
        actions={<a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" href={`/api/v1/orgs/${orgId}/crm/attribution?days=${days}&group=${group}&format=csv`}><Download className="size-4" /> CSV</a>}
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <Field label="Periodo" htmlFor="att-days"><Select id="att-days" value={days} onChange={(e) => setDays(e.target.value)} className="w-auto"><option value="30">30 días</option><option value="90">90 días</option><option value="180">180 días</option><option value="365">12 meses</option></Select></Field>
        <Field label="Agrupar por" htmlFor="att-group"><Select id="att-group" value={group} onChange={(e) => setGroup(e.target.value)} className="w-auto">{Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-line bg-surface p-4"><p className="text-sm text-mute">Contactos</p><p className="mt-1 font-serif text-3xl tabular-nums">{data.total.leads}</p></div>
            <div className="rounded-2xl border border-line bg-surface p-4"><p className="text-sm text-mute">Ganados</p><p className="mt-1 font-serif text-3xl tabular-nums">{data.total.won}</p></div>
            <div className="rounded-2xl border border-line bg-surface p-4"><div className="flex justify-between"><p className="text-sm text-mute">Valor ganado (declarado)</p><Badge tone="info">Derivado</Badge></div><p className="mt-1 font-serif text-3xl tabular-nums">{eur(data.total.wonValue)}</p></div>
          </div>
          <Card title={GROUPS[group]} subtitle={data.model}>
            {data.rows.length === 0 ? (
              <p className="text-sm text-mute">Sin contactos reales en este periodo. Publica un formulario o una landing con enlaces etiquetados con UTM.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead className="text-left text-xs text-mute"><tr><th className="py-2 pr-3 font-medium">Canal</th><th className="pr-3 font-medium">Contactos</th><th className="pr-3 text-right font-medium">Cualif.</th><th className="pr-3 text-right font-medium">Ganados</th><th className="pr-3 text-right font-medium">Cierre</th><th className="pr-3 text-right font-medium">Valor ganado</th><th className="text-right font-medium">En curso</th></tr></thead>
                  <tbody>
                    {data.rows.map((r: any) => (
                      <tr key={r.channel} className="border-t border-line">
                        <td className="max-w-[220px] break-words py-2 pr-3">{r.channel}</td>
                        <td className="pr-3"><div className="flex items-center gap-2"><div className="h-2 rounded-full bg-accent" style={{ width: `${(r.leads / max) * 80}px` }} aria-hidden /><span className="tabular-nums">{r.leads}</span></div></td>
                        <td className="pr-3 text-right tabular-nums">{r.qualified}</td>
                        <td className="pr-3 text-right tabular-nums">{r.won}</td>
                        <td className="pr-3 text-right tabular-nums" title="Ganados / (ganados + perdidos)">{pct(r.winRate)}</td>
                        <td className="pr-3 text-right tabular-nums">{eur(r.wonValue)}</td>
                        <td className="text-right tabular-nums">{eur(r.openValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Notice tone="info" title="Cómo leer estos datos">
            <ul className="list-disc space-y-1 pl-5">{data.caveats.map((c: string) => <li key={c}>{c}</li>)}</ul>
            <p className="mt-2 text-xs">Fuente: {data.source}. Periodo desde {new Date(data.period.since).toLocaleDateString("es-ES")}.</p>
          </Notice>
        </div>
      )}
    </>
  );
}
