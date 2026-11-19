import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Briefcase, Plus } from "lucide-react";
import { ApiError, del, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Progress, Skeleton, TextField } from "../ui";
import { useOrgAccess } from "./org";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "No se pudo completar la acción.");
const eur = (v: number) => v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Used vs. limit for every plan feature (reads the same limits the API enforces). */
export function Entitlements({ orgId }: { orgId: string }) {
  const { data, error, reload } = useApi<any>(`/orgs/${orgId}/entitlements`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-40 rounded-2xl" />;
  return (
    <Card title="Qué incluye tu plan y cuánto usas" subtitle={data.inheritedFromAgency ? `Plan ${data.plan.name} heredado de tu agencia` : `Plan ${data.plan.name}`}>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {data.rows.map((r: any) => (
          <div key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>{r.label}</span>
              <span className="tabular-nums text-mute">{r.used === null ? (r.balance !== undefined ? `${r.balance} disponibles · ${r.limit}/mes` : r.limit) : `${r.used} de ${r.limit}`}</span>
            </div>
            {r.used !== null && r.limit > 0 && <div className="mt-1"><Progress value={Math.min(100, (r.used / r.limit) * 100)} /></div>}
            {r.used !== null && r.limit === 0 && <p className="mt-1 text-xs text-mute">No incluido en este plan.</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AgencyPage() {
  const { orgId } = useParams();
  const access = useOrgAccess(orgId);
  const { refresh } = useAuth();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/agency/clients`);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/orgs/${orgId}/agency/clients`, { name });
      setName("");
      setMsg({ tone: "ok", text: "Cliente creado. Entra en su espacio para auditar su web e invitarle como «Cliente (solo lectura)»." });
      await refresh();
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader eyebrow="Agencia" title="Clientes y marca blanca" subtitle="Cada cliente es un espacio aislado con sus propios datos, equipo y permisos. Tú lo gestionas; tu cliente puede entrar en modo solo lectura." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-48 rounded-2xl" />}
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {data && (
        <div className="space-y-6">
          {data.isClient ? (
            <Notice tone="info">Esta organización es cliente de una agencia: no puede tener clientes propios.</Notice>
          ) : (
            access.can("org:update") && (
              <Card title="Nuevo cliente" subtitle={`${data.usage.used} de ${data.usage.limit} organizaciones cliente en tu plan`}>
                {data.usage.limit === 0 ? (
                  <p className="text-sm">Las organizaciones cliente están incluidas en los planes Pro (5) y Agency (50). <Link className="text-accent-text hover:underline" to={`/o/${orgId}/billing`}>Ver planes</Link></p>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <TextField label="Nombre del cliente" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Clínica Dental Sol" />
                    <Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={create}><Plus className="size-4" /> Crear cliente</Button>
                  </div>
                )}
              </Card>
            )
          )}
          {data.clients.length === 0 ? (
            !data.isClient && <EmptyState icon={<Briefcase className="size-8" />} title="Sin clientes">Crea un espacio por cliente para separar sus datos y sus informes.</EmptyState>
          ) : (
            <Card title="Tus clientes" subtitle="Últimos 30 días · solo datos reales (sin contactos de prueba)">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-mute"><tr><th className="py-2 pr-3 font-medium">Cliente</th><th className="pr-3 text-right font-medium">Contactos</th><th className="pr-3 text-right font-medium">Valor ganado</th><th className="pr-3 text-right font-medium">Salud web</th><th className="pr-3 text-right font-medium">Tareas vencidas</th><th className="pr-3 font-medium">Acceso cliente</th><th /></tr></thead>
                  <tbody>
                    {data.clients.map((c: any) => (
                      <tr key={c.id} className="border-t border-line">
                        <td className="py-2 pr-3 font-medium">{c.name}</td>
                        <td className="pr-3 text-right tabular-nums">{c.leads30}</td>
                        <td className="pr-3 text-right tabular-nums">{eur(c.wonValue30)}</td>
                        <td className="pr-3 text-right tabular-nums">{c.health ?? "—"}</td>
                        <td className="pr-3 text-right tabular-nums">{c.overdue_tasks > 0 ? <Badge tone="warn">{c.overdue_tasks}</Badge> : 0}</td>
                        <td className="pr-3">{c.client_viewers > 0 ? <Badge tone="ok">{c.client_viewers} invitado(s)</Badge> : <Link className="text-xs text-accent-text hover:underline" to={`/o/${c.id}/team`}>Invitar</Link>}</td>
                        <td className="text-right"><Link className="text-accent-text hover:underline" to={`/o/${c.id}`}>Abrir</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <BrandingCard orgId={orgId!} canEdit={access.can("org:update")} />
          <Notice tone="warn" title="Bloqueado por coste">{data.blocked.map((b: any) => `${b.label}: ${b.reason}`).join(" ")}</Notice>
        </div>
      )}
    </>
  );
}

function BrandingCard({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { data, reload } = useApi<any>(`/orgs/${orgId}/branding`);
  const [f, setF] = useState({ displayName: "", logoUrl: "", accent: "#3f6212", reportFooter: "", supportEmail: "" });
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  useEffect(() => {
    if (data) setF({ displayName: data.displayName ?? "", logoUrl: data.logoUrl ?? "", accent: data.accent ?? "#3f6212", reportFooter: data.reportFooter ?? "", supportEmail: data.supportEmail ?? "" });
  }, [data]);
  const save = async () => {
    setMsg(null);
    try {
      await put(`/orgs/${orgId}/branding`, { displayName: f.displayName || null, logoUrl: f.logoUrl || null, accent: f.accent || null, reportFooter: f.reportFooter || null, supportEmail: f.supportEmail || null });
      setMsg({ tone: "ok", text: "Marca blanca guardada. Recarga la página para verla en el menú." });
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };
  return (
    <Card title="Marca blanca" subtitle={data?.inherited ? "Ahora se usa la marca de tu agencia" : "Tu nombre, logo y color en el menú y en los informes (plan Agency)"}>
      <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nombre visible" maxLength={80} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder="Agencia Luna" />
        <TextField label="Logo (URL https)" type="url" value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} placeholder="https://agencia.es/logo.png" />
        <TextField label="Color de acento" type="color" value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value })} />
        <TextField label="Email de soporte" type="email" value={f.supportEmail} onChange={(e) => setF({ ...f, supportEmail: e.target.value })} />
        <div className="sm:col-span-2"><TextField label="Pie de los informes" maxLength={300} value={f.reportFooter} onChange={(e) => setF({ ...f, reportFooter: e.target.value })} placeholder="Informe preparado por Agencia Luna" /></div>
      </fieldset>
      {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {canEdit && (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={save}>Guardar</Button>
          {data?.own && <Button onClick={async () => { await del(`/orgs/${orgId}/branding`); reload(); }}>Quitar marca blanca</Button>}
        </div>
      )}
    </Card>
  );
}
