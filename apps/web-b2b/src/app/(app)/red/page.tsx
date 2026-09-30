'use client';

import {
  AlertTriangle,
  Building2,
  Calculator,
  ChevronRight,
  KeyRound,
  Mail,
  Network,
  Pencil,
  Percent,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useViewer } from '../../../components/layout/viewer-context';
import { NodeKindBadge, NodeKindPicker } from '../../../components/network/node-kind';
import { Button } from '../../../components/ui/button';
import { Dialog } from '../../../components/ui/dialog';
import { Label } from '../../../components/ui/label';
import { cn } from '../../../lib/cn';
import {
  DEFAULT_ACCOUNT_LABEL,
  PROVIDERS,
  STATUS_LABELS,
  accountCertainty,
  accountCertaintyNotice,
  accountConfigSummary,
  accountDraftChanged,
  draftWarnings,
  inheritableHelp,
  isProviderAccountStatus,
  ownershipNotice,
  prefillFromAccount,
  prepareAccountSubmission,
  providerFormFor,
  providerFormsForNode,
  statusEnablesProvider,
  validateProviderDraft,
  type AccountEditorDraft,
  type Notice,
  type NoticeTone,
  type ProviderAccountStatus,
  type ProviderForm,
} from '../../../lib/provider-forms';
import { providerMetaFor } from '../../../lib/provider-display';
import { providerAccountSaveError } from '../../../lib/provider-account-errors';
import { canManageWalletsFromNetwork } from '../../../lib/wallet-access';
import { parseCreatedNode } from '../../../lib/tenant-admin-client';
import { createdMessage, seatFieldsPolicy } from '../../../lib/tenant-admin-form';
import { idleError, parseIdle, parseSeats, seatsError } from '../../../lib/tenant-admin-seats';
import { SeatPolicyFields } from '../admin/tenants/_components/seat-policy-fields';
import { ProviderAccountSheet } from '../admin/proveedores/_components/provider-account-sheet';
import {
  buildForest,
  createActionLabel,
  createFields,
  creatableKinds,
  networkRoot,
  newNodeLabel,
  slugify,
  statusLabel,
  type CreatableKind,
} from '../../../lib/tenant-network';

interface NetworkTenant {
  id: string;
  slug: string;
  name: string;
  tenantType: string;
  /** Sucursal de Planetour (0050): se muestra como "Sucursal". */
  isBranch?: boolean;
  parentTenantId: string | null;
  status: string;
  depth: number;
}

interface ProviderAccount {
  id: string;
  providerCode: string;
  label: string;
  /** Ya saneada por el servidor: sólo las claves que el proveedor declaró seguras de mostrar. */
  config: Record<string, unknown>;
  /**
   * Nombres —nunca valores— de las claves de `config` que el servidor NO devuelve. Hacen falta
   * para editar: el upsert reemplaza la `config` entera, así que una clave que el formulario no
   * puede recargar es una clave que se borra al guardar, y eso hay que decirlo antes.
   */
  redactedConfigKeys?: string[];
  isInheritable: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateForm {
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultLanguage: 'es' | 'pt' | 'en';
  kind: CreatableKind | undefined;
  /** El admin inicial se invita por correo y elige su contraseña: sólo se pide su email. */
  adminEmail: string;
  /** Puestos e inactividad propios; `''` = heredar. Sólo los fija el superadmin. */
  concurrentSeats: string;
  idleTimeoutMinutes: string;
}

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';
const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  suspended: 'bg-red-500',
  archived: 'bg-zinc-400',
};

/** De dónde sale hoy la credencial de un proveedor para este tenant (`GET /provider-accounts/resolve`). */
interface ResolvedOrigin {
  ownerTenantId: string;
  label: string;
  inherited: boolean;
  /**
   * Veredicto del servidor sobre si la cuenta está COMPLETA. Opcionales y sin tipar porque no
   * todos los despliegues del API los mandan: `accountCertainty` los valida y, si no vienen, la
   * pantalla dice que no lo sabe en vez de suponer que la cuenta sirve.
   */
  readiness?: unknown;
  missingRequiredFields?: unknown;
}

/**
 * Resultado de consultar el origen. `'none'` (no resuelve nada) y `'unknown'` (la consulta falló)
 * se mantienen separados a propósito: son consejos opuestos para el operador.
 */
type OriginLookup = ResolvedOrigin | 'none' | 'unknown';

function isResolvedOrigin(lookup: OriginLookup | undefined): lookup is ResolvedOrigin {
  return typeof lookup === 'object' && lookup !== null;
}

/**
 * Qué está haciendo el formulario BYOC. `null` = cerrado.
 *
 * `edit` arrastra la cuenta original y las claves de `config` que no se pudieron recargar porque
 * las dos cosas se necesitan DESPUÉS, al redactar el aviso: qué fila se va a reescribir (la
 * etiqueta se puede editar, así que no se puede deducir del input) y qué se va a perder.
 */
type EditorState = { initial: AccountEditorDraft } & (
  | { kind: 'create' }
  | { kind: 'edit'; account: ProviderAccount; droppedConfigKeys: readonly string[] }
);

interface SalesRow {
  tenantId: string;
  ordersTotal: number;
  ordersConfirmed: number;
  quotationsTotal: number;
}

export default function RedPage() {
  const { superadmin } = useViewer();
  const [tenants, setTenants] = useState<NetworkTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [createFor, setCreateFor] = useState<NetworkTenant | null>(null);
  const [credsFor, setCredsFor] = useState<NetworkTenant | null>(null);
  const [pricingFor, setPricingFor] = useState<NetworkTenant | null>(null);
  const [emailFor, setEmailFor] = useState<NetworkTenant | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [sales, setSales] = useState<Map<string, SalesRow>>(new Map());

  useEffect(() => {
    void fetchNetwork();
  }, []);

  async function fetchNetwork() {
    setLoading(true);
    try {
      const res = await fetch('/api/tenants/network');
      const data = (await res.json()) as { tenants?: NetworkTenant[] };
      const list = data.tenants ?? [];
      setTenants(list);
      void fetchSales(list);
    } catch {
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }

  // Trae el agregado de ventas por nodo, consultándolo para cada raíz de la red.
  async function fetchSales(list: NetworkTenant[]) {
    const ids = new Set(list.map((t) => t.id));
    const rootIds = list
      .filter((t) => !t.parentTenantId || !ids.has(t.parentTenantId))
      .map((t) => t.id);
    const map = new Map<string, SalesRow>();
    await Promise.all(
      rootIds.map(async (rootId) => {
        try {
          const r = await fetch(
            `/api/tenants/network/sales?tenantId=${encodeURIComponent(rootId)}`,
          );
          const d = (await r.json()) as { summary?: SalesRow[] };
          for (const row of d.summary ?? []) map.set(row.tenantId, row);
        } catch {
          /* sin datos de ventas para esta raíz */
        }
      }),
    );
    setSales(map);
  }

  // El árbol a partir de parentTenantId (raíces = nodos cuyo padre no está en la red visible). La
  // raíz de la red es la plataforma por su tipo, no la primera por orden alfabético.
  const { roots, childrenOf } = useMemo(() => buildForest(tenants), [tenants]);
  const root = useMemo(() => networkRoot(tenants), [tenants]);
  const rootKinds = root ? creatableKinds(root, { superadmin }) : [];

  // Para nombrar al dueño de una credencial heredada: `resolve` devuelve el id, no el nombre.
  const tenantNames = useMemo(
    () => new Map(tenants.map((t) => [t.id, t.name] as const)),
    [tenants],
  );

  function renderRows(nodes: readonly NetworkTenant[], level: number): React.ReactNode[] {
    return nodes.flatMap((t) => {
      const kids = childrenOf.get(t.id) ?? [];
      const childKinds = creatableKinds(t, { superadmin });
      return [
        <tr
          key={t.id}
          className="bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <td className="px-4 py-3">
            <div className="flex items-center gap-2" style={{ paddingLeft: `${level * 20}px` }}>
              {level > 0 && (
                <ChevronRight
                  className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
                  aria-hidden
                />
              )}
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                <Building2 className="size-3.5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-fg)]">{t.name}</div>
                <code className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                  {t.slug}
                </code>
              </div>
            </div>
          </td>
          <td className="px-4 py-3">
            <NodeKindBadge node={t} />
          </td>
          <td className="px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
              <span
                className={cn('size-1.5 rounded-full', STATUS_DOT[t.status] ?? 'bg-zinc-400')}
              />
              {statusLabel(t.status)}
            </span>
          </td>
          <td className="px-4 py-3">
            {(() => {
              const s = sales.get(t.id);
              if (!s) return <span className="text-xs text-[var(--color-fg-subtle)]">—</span>;
              return (
                <div className="flex items-center gap-3 text-xs tabular-nums text-[var(--color-fg-muted)]">
                  <span title="Reservas (confirmadas)">
                    <span className="font-medium text-[var(--color-fg)]">{s.ordersConfirmed}</span>
                    <span className="text-[var(--color-fg-subtle)]">/{s.ordersTotal}</span> res.
                  </span>
                  <span title="Cotizaciones">
                    <span className="font-medium text-[var(--color-fg)]">{s.quotationsTotal}</span>{' '}
                    cot.
                  </span>
                </div>
              );
            })()}
          </td>
          <td className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setPricingFor(t)}
              >
                <Percent className="size-3.5" />
                Reglas
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setCredsFor(t)}>
                <KeyRound className="size-3.5" />
                Credenciales
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setEmailFor(t)}>
                <Mail className="size-3.5" />
                Email
              </Button>
              <Button asChild variant="ghost" size="sm" className="gap-1.5">
                <Link href={`/admin/usuarios?tenant=${encodeURIComponent(t.id)}`}>
                  <Users className="size-3.5" aria-hidden="true" />
                  Usuarios
                  <span className="sr-only"> de {t.name}</span>
                </Link>
              </Button>
              {canManageWalletsFromNetwork(tenants, t, { superadmin }) ? (
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <Link href={`/red/${t.id}/carteras`}>
                    <Wallet className="size-3.5" aria-hidden="true" />
                    Carteras
                    <span className="sr-only"> de {t.name}</span>
                  </Link>
                </Button>
              ) : null}
              {childKinds.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  aria-label={`${createActionLabel(childKinds)} bajo ${t.name}`}
                  onClick={() => setCreateFor(t)}
                >
                  <Plus className="size-3.5" />
                  {createActionLabel(childKinds)}
                </Button>
              ) : null}
            </div>
          </td>
        </tr>,
        ...renderRows(kids, level + 1),
      ];
    });
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      {/* `flex-wrap`: en el teléfono el título y los dos botones no entran en una fila, y la fila
          ensanchaba la página entera —el navegador del teléfono la achicaba para que entrara—. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            <Network className="size-5 text-[var(--color-primary)]" />
            Mi Red
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {tenants.length} {tenants.length === 1 ? 'nodo' : 'nodos'}
            {(() => {
              const vals = [...sales.values()];
              if (!vals.length) return null;
              const o = vals.reduce((a, v) => a + v.ordersTotal, 0);
              const q = vals.reduce((a, v) => a + v.quotationsTotal, 0);
              return ` · ${o} reservas · ${q} cotizaciones en tu red`;
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="gap-2"
            onClick={() => setShowAudit(true)}
            disabled={!root}
          >
            <ScrollText className="size-4" />
            Actividad
          </Button>
          {rootKinds.length > 0 ? (
            <Button className="gap-2" onClick={() => setCreateFor(root ?? null)}>
              <Plus className="size-4" />
              {newNodeLabel(rootKinds)}
            </Button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          ))}
        </div>
      ) : tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
          <Network className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Aún no hay agencias en tu red
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Crea una agencia para empezar a construir tu consolidador.
          </p>
        </div>
      ) : (
        // `relative`: los `sr-only` de los enlaces son `position: absolute` y, sin un ancestro
        // posicionado, escapaban del scroll horizontal de la tabla y ensanchaban la página a 586 px
        // en un teléfono de 375 (y con ella, los diálogos abiertos encima).
        <div className="relative overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Agencia
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Tipo
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Estado
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Ventas
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">{renderRows(roots, 0)}</tbody>
          </table>
        </div>
      )}

      {createFor && (
        <CreateAgencyModal
          parent={createFor}
          superadmin={superadmin}
          onClose={() => setCreateFor(null)}
          onCreated={() => {
            setCreateFor(null);
            void fetchNetwork();
          }}
        />
      )}

      {credsFor && (
        <CredentialsModal
          tenant={credsFor}
          childCount={(childrenOf.get(credsFor.id) ?? []).length}
          tenantNames={tenantNames}
          onClose={() => setCredsFor(null)}
        />
      )}

      {pricingFor && <PricingModal tenant={pricingFor} onClose={() => setPricingFor(null)} />}

      {emailFor && <EmailModal tenant={emailFor} onClose={() => setEmailFor(null)} />}

      {showAudit && root && <AuditModal rootId={root.id} onClose={() => setShowAudit(false)} />}
    </div>
  );
}

/**
 * Alta de un nodo bajo `parent`. El tipo lo decide el padre (D4 A): bajo la plataforma nace una
 * agencia (o una sucursal o un consolidador, si quien crea es el superadmin); bajo un consolidador,
 * una agencia; bajo una agencia, una sub-agencia. La API vuelve a validarlo.
 */
function CreateAgencyModal({
  parent,
  superadmin,
  onClose,
  onCreated,
}: {
  parent: NetworkTenant;
  superadmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const kinds = creatableKinds(parent, { superadmin });
  const [form, setForm] = useState<CreateForm>({
    name: '',
    slug: '',
    countryCode: 'CO',
    defaultCurrency: 'COP',
    defaultLanguage: 'es',
    kind: kinds[0],
    adminEmail: '',
    concurrentSeats: '',
    idleTimeoutMinutes: '',
  });
  // Puestos e inactividad: sólo el superadmin, y bajo la plataforma el cupo es obligatorio (sin él
  // el nodo no tendría de quién heredarlo y quedaría sin límite).
  const seatPolicy = seatFieldsPolicy(superadmin, parent.tenantType);
  const [seatErrors, setSeatErrors] = useState<{
    concurrentSeats?: string;
    idleTimeoutMinutes?: string;
  }>({});

  function onName(name: string) {
    setForm((f) => ({ ...f, name, slug: slugify(name) }));
  }

  async function submit() {
    setError('');
    if (!form.name.trim() || !form.slug.trim()) {
      setError('Nombre y slug son requeridos.');
      return;
    }
    if (form.kind === undefined) {
      setError('Elige qué tipo de nodo crear.');
      return;
    }
    if (seatPolicy !== undefined) {
      const concurrentSeats = seatsError(form.concurrentSeats, seatPolicy.seatsRequired);
      const idleTimeoutMinutes = idleError(form.idleTimeoutMinutes);
      setSeatErrors({ concurrentSeats, idleTimeoutMinutes });
      if (concurrentSeats !== undefined || idleTimeoutMinutes !== undefined) return;
    }
    const {
      kind,
      adminEmail,
      concurrentSeats: seatsDraft,
      idleTimeoutMinutes: idleDraft,
      ...rest
    } = form;
    const seats = seatPolicy === undefined ? undefined : parseSeats(seatsDraft);
    const idle = seatPolicy === undefined ? undefined : parseIdle(idleDraft);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...rest,
          ...createFields(kind),
          parentTenantId: parent.id,
          // Vacío es "sin admin": no se manda, en vez de un '' que el API tenga que interpretar.
          ...(adminEmail.trim() ? { adminEmail: adminEmail.trim() } : {}),
          ...(seats === undefined ? {} : { concurrentSeats: seats }),
          ...(idle === undefined ? {} : { idleTimeoutMinutes: idle }),
        }),
      });
      const data = (await res.json()) as unknown;
      if (!res.ok) {
        setError((data as { error?: string } | null)?.error ?? 'No se pudo crear el nodo.');
        return;
      }
      const created = parseCreatedNode(data);
      const msg =
        created === undefined
          ? undefined
          : createdMessage(created, kind, rest.name.trim(), parent.name);
      if (msg?.warn) toast.warning(msg.title, { description: msg.detail });
      else if (msg) toast.success(msg.title, { description: msg.detail });
      onCreated();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={newNodeLabel(kinds)}
      className="max-w-lg"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button className="gap-1.5" disabled={saving} onClick={() => void submit()}>
            <Plus className="size-3.5" />
            {saving ? 'Creando…' : 'Crear agencia'}
          </Button>
        </ModalFooter>
      }
    >
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
        Colgará de <span className="font-medium text-[var(--color-fg)]">{parent.name}</span>.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2" label="Nombre">
          <input
            value={form.name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Agencia Sur"
            className={inputClass}
          />
        </Field>
        <Field className="sm:col-span-2" label="Slug (URL)">
          <input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder="agencia-sur"
            className={inputClass}
          />
        </Field>
        <div className="sm:col-span-2">
          <NodeKindPicker
            kinds={kinds}
            value={form.kind}
            onChange={(kind) => setForm({ ...form, kind })}
          />
        </div>
        <Field label="País">
          <select
            value={form.countryCode}
            onChange={(e) => setForm({ ...form, countryCode: e.target.value })}
            className={selectClass}
          >
            <option value="CO">Colombia</option>
            <option value="BR">Brasil</option>
            <option value="PE">Perú</option>
            <option value="CL">Chile</option>
            <option value="MX">México</option>
            <option value="AR">Argentina</option>
          </select>
        </Field>
        <Field label="Moneda">
          <select
            value={form.defaultCurrency}
            onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value })}
            className={selectClass}
          >
            <option value="COP">COP</option>
            <option value="BRL">BRL</option>
            <option value="PEN">PEN</option>
            <option value="USD">USD</option>
          </select>
        </Field>
        <Field label="Idioma">
          <select
            value={form.defaultLanguage}
            onChange={(e) =>
              setForm({ ...form, defaultLanguage: e.target.value as 'es' | 'pt' | 'en' })
            }
            className={selectClass}
          >
            <option value="es">Español</option>
            <option value="pt">Portugués</option>
            <option value="en">Inglés</option>
          </select>
        </Field>
        {seatPolicy !== undefined ? (
          <div className="sm:col-span-2">
            <SeatPolicyFields
              seats={form.concurrentSeats}
              idle={form.idleTimeoutMinutes}
              onSeats={(v) => setForm((f) => ({ ...f, concurrentSeats: v }))}
              onIdle={(v) => setForm((f) => ({ ...f, idleTimeoutMinutes: v }))}
              required={seatPolicy.seatsRequired}
              parentName={parent.name}
              errors={seatErrors}
            />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <div className="my-1 border-t border-[var(--color-border)]" />
          <p className="text-xs font-medium text-[var(--color-fg-muted)]">
            Admin de la agencia (opcional)
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
            Le enviamos una invitación por correo: al aceptarla elige su propia contraseña.
          </p>
        </div>
        <Field className="sm:col-span-2" label="Email admin">
          <input
            type="email"
            autoComplete="off"
            value={form.adminEmail}
            onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            placeholder="admin@agencia.com"
            className={inputClass}
          />
        </Field>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </Dialog>
  );
}

/**
 * Gestión BYOC de un nodo: de dónde salen HOY sus credenciales por proveedor, qué cuentas
 * propias tiene, y el alta de una nueva.
 *
 * El panel tiene que explicar dos cosas que el modelo de datos hace en silencio y que, sin
 * cartelería, dejan al operador mirando una búsqueda sin resultados:
 *
 *  1. `resolve_provider_account` sólo mira cuentas con `status = 'active'`. Una cuenta guardada
 *     en Sandbox —el default del API— no habilita nada y no produce ningún error.
 *  2. La resolución sube por el árbol: sin cuenta propia activa, se usa la del ancestro
 *     heredable más cercano. Esa es la herencia del modelo consolidador, y hasta ahora el panel
 *     no la mostraba en ningún sitio.
 */
function CredentialsModal({
  tenant,
  childCount,
  tenantNames,
  onClose,
}: {
  tenant: NetworkTenant;
  childCount: number;
  tenantNames: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [origins, setOrigins] = useState<Map<string, OriginLookup> | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** El 409 de una cuenta con reservas vivas: un aviso, no un error del formulario. */
  const [inUse, setInUse] = useState<Notice | null>(null);

  const [providerCode, setProviderCode] = useState('latam-ndc');
  const [label, setLabel] = useState('default');
  const [isInheritable, setIsInheritable] = useState(true);
  const [status, setStatus] = useState<ProviderAccountStatus>('sandbox');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  /** Sube en cada guardado rechazado por validación: el editor lleva el foco al primer error. */
  const [focusRequest, setFocusRequest] = useState(0);

  const provider = providerFormFor(providerCode);
  const ownerNameOf = useCallback(
    (ownerTenantId: string) => tenantNames.get(ownerTenantId) ?? 'un ancestro de tu red',
    [tenantNames],
  );

  const draftLookup = origins?.get(providerCode);
  const draftOrigin = isResolvedOrigin(draftLookup) ? draftLookup : null;

  /**
   * Lo que se va a anunciar Y lo que se va a mandar, calculado en el MISMO sitio.
   *
   * Que la etiqueta se normalizara dos veces —en crudo para el aviso, con `trim() || 'default'`
   * para el `POST`— es lo que hacía que con el campo vacío la pantalla dijera "no cambia la cuenta
   * que está en uso" mientras el guardado pisaba la cuenta `default` activa. Aquí sale una sola
   * etiqueta y de ella cuelgan las dos cosas.
   */
  const submission = useMemo(
    () =>
      provider
        ? prepareAccountSubmission(
            provider,
            { label, status, sections: { credentials, config } },
            {
              resolved: draftOrigin && {
                inherited: draftOrigin.inherited,
                label: draftOrigin.label,
              },
              tenantName: tenant.name,
              ownerName: draftOrigin ? ownerNameOf(draftOrigin.ownerTenantId) : 'el consolidador',
              editing:
                editor?.kind === 'edit'
                  ? {
                      label: editor.account.label,
                      droppedConfigKeys: editor.droppedConfigKeys,
                    }
                  : null,
            },
          )
        : null,
    [provider, label, status, credentials, config, draftOrigin, tenant.name, ownerNameOf, editor],
  );

  const warnings = useMemo(
    () => (provider ? draftWarnings(provider, { credentials, config }) : []),
    [provider, credentials, config],
  );
  // Sólo aparece al editar una cuenta que este nodo no puede tener: el alta ya no se la ofrece.
  const ownershipCallout = provider ? ownershipNotice(provider, tenant.tenantType) : null;
  const dirty =
    editor !== null && provider !== undefined
      ? accountDraftChanged(provider, editor.initial, {
          label,
          status,
          isInheritable,
          sections: { credentials, config },
        })
      : false;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/provider-accounts?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { accounts?: ProviderAccount[] };
      // El correo se gestiona en su propia sección "Email"; acá sólo proveedores de viaje.
      setAccounts((data.accounts ?? []).filter((a) => a.providerCode !== 'email'));
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [tenant.id]);

  /**
   * Pregunta al API, proveedor por proveedor, qué cuenta resolvería este tenant. Es la única
   * fuente fiable del origen: replicar aquí la regla de resolución sería una segunda copia que se
   * desincroniza con la función de Postgres.
   *
   * Un proveedor que falle queda en `'unknown'`, NO en `'none'`. Pintar un 403 o un 500 como
   * "sin credenciales" empujaría al operador a cargar credenciales que a lo mejor ya tiene, y a
   * pisar la cuenta activa del consolidador con una suya en sandbox.
   */
  const loadOrigins = useCallback(async () => {
    const entries = await Promise.all(
      Object.keys(PROVIDERS).map(async (code): Promise<[string, OriginLookup]> => {
        try {
          const res = await fetch(
            `/api/provider-accounts/resolve?tenantId=${encodeURIComponent(tenant.id)}&providerCode=${encodeURIComponent(code)}`,
          );
          if (!res.ok) return [code, 'unknown'];
          const data = (await res.json()) as { resolved?: ResolvedOrigin | null };
          // `{ resolved: null }` es la respuesta del 404 del API: no resuelve ninguna cuenta.
          return [code, data.resolved ?? 'none'];
        } catch {
          return [code, 'unknown'];
        }
      }),
    );
    setOrigins(new Map(entries));
  }, [tenant.id]);

  useEffect(() => {
    void load();
    void loadOrigins();
  }, [load, loadOrigins]);

  /** Cambiar de proveedor limpia lo tecleado: los campos de uno no significan nada en el otro. */
  function selectProvider(code: string) {
    setProviderCode(code);
    // Un proveedor que pide verificar la credencial antes de habilitarlo arranca en Sandbox.
    const initialStatus = providerFormFor(code)?.initialStatus;
    if (initialStatus) setStatus(initialStatus);
    setCredentials({});
    setConfig({});
    setFieldErrors({});
    setError('');
    setInUse(null);
  }

  /** Alta: arranca siempre limpio, incluso viniendo de cerrar una edición. */
  function startCreate() {
    setProviderCode('latam-ndc');
    setLabel(DEFAULT_ACCOUNT_LABEL);
    setStatus('sandbox');
    setIsInheritable(true);
    setCredentials({});
    setConfig({});
    setFieldErrors({});
    setError('');
    setInUse(null);
    setEditor({
      kind: 'create',
      initial: {
        label: DEFAULT_ACCOUNT_LABEL,
        status: 'sandbox',
        isInheritable: true,
        sections: { credentials: {}, config: {} },
      },
    });
  }

  /**
   * Abre una cuenta guardada para modificarla.
   *
   * Precarga sólo la mitad que el API devuelve —etiqueta, estado, herencia y la `config` visible—.
   * Las credenciales arrancan VACÍAS y no es un fallo del formulario: van cifradas y no vuelven,
   * así que guardar exige cargarlas de nuevo enteras. El aviso de `submission.edit` lo dice antes
   * de que el operador teclee nada.
   */
  function startEdit(account: ProviderAccount) {
    const form = providerFormFor(account.providerCode);
    // Sin formulario declarado no sabemos qué campos pide: recargarla sería pisarla con la forma
    // de credencial de otro proveedor. El botón ya viene deshabilitado; esto cierra la puerta.
    if (!form) return;

    const prefill = prefillFromAccount(form, account);
    setProviderCode(account.providerCode);
    setLabel(prefill.label);
    setStatus(prefill.status);
    setIsInheritable(prefill.isInheritable);
    setConfig({ ...prefill.config });
    setCredentials({});
    setFieldErrors({});
    setError('');
    setInUse(null);
    setEditor({
      kind: 'edit',
      account,
      droppedConfigKeys: prefill.droppedConfigKeys,
      initial: {
        label: prefill.label,
        status: prefill.status,
        isInheritable: prefill.isInheritable,
        sections: { credentials: {}, config: { ...prefill.config } },
      },
    });
  }

  function closeEditor() {
    setEditor(null);
    // Lo tecleado no sobrevive al cierre: las credenciales no se quedan en memoria de la pantalla.
    setCredentials({});
    setFieldErrors({});
    setError('');
    setInUse(null);
  }

  async function save() {
    setError('');
    setInUse(null);
    setFieldErrors({});
    if (!provider || !submission) {
      setError(
        `El proveedor "${providerCode}" no está soportado por este panel. Actualiza la plataforma antes de cargarle credenciales.`,
      );
      return;
    }

    const validation = validateProviderDraft(provider, { credentials, config });
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setError(validation.summary ?? 'Revisa los campos marcados.');
      setFocusRequest((n) => n + 1);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/provider-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          providerCode,
          // La etiqueta del aviso, no otra: es la misma que decidió qué decía la cartelería.
          label: submission.label,
          credentials: submission.payload.credentials,
          config: submission.payload.config,
          isInheritable,
          status,
        }),
      });
      const data = (await res.json()) as unknown;
      if (!res.ok) {
        const failure = providerAccountSaveError(res.status, data, 'Error al guardar credenciales');
        if (failure.kind === 'in-use') setInUse(failure.notice);
        else setError(failure.message);
        return;
      }
      setEditor(null);
      setCredentials({});
      setConfig({});
      void load();
      void loadOrigins();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  /**
   * `config` de la cuenta PROPIA que resuelve, para poder decir algo sobre si está completa.
   * `undefined` cuando no la tenemos: cuenta heredada (su fila es de un ancestro y la RLS no la
   * deja leer) o listado todavía cargando. En los dos casos la pantalla se calla en vez de
   * afirmar que funciona.
   */
  const resolvedOwnConfig = useCallback(
    (code: string, origin: ResolvedOrigin): Record<string, unknown> | undefined => {
      if (origin.inherited || loading) return undefined;
      return accounts.find((a) => a.providerCode === code && a.label === origin.label)?.config;
    },
    [accounts, loading],
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Credenciales · ${tenant.name}`}
      className="max-w-2xl"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
          <Button className="gap-1.5" onClick={startCreate}>
            <Plus className="size-3.5" />
            Conectar credenciales
          </Button>
        </ModalFooter>
      }
    >
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" />
        <span>
          Las credenciales se cifran y nunca se muestran de vuelta. Sólo cuentan las cuentas en
          estado <strong className="text-[var(--color-fg)]">Activo</strong>: si esta agencia no
          tiene una propia activa, usa la del ancestro heredable más cercano que la tenga. Qué pasa
          cuando no hay ninguna depende del proveedor — Sabre y TBO Holidays quedan fuera de las
          búsquedas, y otros caen a las credenciales de la plataforma.
        </span>
      </div>

      {/* Origen efectivo por proveedor: el corazón del modelo consolidador, visible. */}
      <section aria-labelledby="origen-credenciales" className="mb-5">
        <h3
          id="origen-credenciales"
          className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]"
        >
          De dónde salen hoy las credenciales de {tenant.name}
        </h3>
        {origins === null ? (
          <div className="h-20 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
        ) : (
          <ul className="space-y-1.5">
            {Object.entries(PROVIDERS).map(([code, form]) => (
              <li
                key={code}
                className="flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
              >
                <span className="text-sm font-medium text-[var(--color-fg)]">{form.label}</span>
                <ProviderOrigin
                  form={form}
                  origin={origins.get(code) ?? 'unknown'}
                  ownerNameOf={ownerNameOf}
                  visibleConfig={(origin) => resolvedOwnConfig(code, origin)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
        Cuentas propias de {tenant.name}
      </h3>
      {/* Esqueleto sólo en la primera carga: al recargar tras guardar, la lista queda en su lugar y
          el foco vuelve al "Editar" que abrió el editor en vez de perderse con un botón que ya no
          está. */}
      {loading && accounts.length === 0 ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-8 text-center text-xs text-[var(--color-fg-muted)]">
          Sin credenciales propias. {tenant.name} opera con las del consolidador (si son
          heredables).
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => {
            const form = providerFormFor(a.providerCode);
            const summary = form ? accountConfigSummary(form, a.config) : [];
            return (
              <div
                key={a.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <KeyRound className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-subtle)]" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--color-fg)]">
                        {form?.label ?? a.providerCode}{' '}
                        <span className="font-normal text-[var(--color-fg-subtle)]">
                          · {a.label}
                        </span>
                      </div>
                      <div className="text-[10px] text-[var(--color-fg-subtle)]">
                        {a.isInheritable ? 'Heredable por sub-agencias' : 'No heredable'}
                        {summary.length > 0 ? ` · ${summary.join(' · ')}` : ''}
                      </div>
                      {/* Una cuenta con un código que este panel no conoce no se puede editar sin
                          arriesgarse a pisarla con la forma de credencial de otro proveedor. */}
                      {!form && (
                        <div className="text-[10px] font-medium text-[var(--color-danger)]">
                          Proveedor desconocido para esta versión del panel: no sabemos qué campos
                          pide, así que no se puede editar desde acá sin riesgo de dejarla
                          inservible.
                        </div>
                      )}
                      {form && ownershipNotice(form, tenant.tenantType) && (
                        <div className="text-[10px] font-medium text-amber-800">
                          {form.ownerRestriction?.explanation}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                        statusEnablesProvider(a.status)
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : a.status === 'sandbox'
                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                            : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
                      )}
                    >
                      {isProviderAccountStatus(a.status) ? STATUS_LABELS[a.status] : a.status}
                    </span>
                    {/* Con varias cuentas en la lista hay varios botones "Editar": el nombre
                        accesible tiene que decir CUÁL, o en la lista de botones son todos iguales. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      disabled={!form}
                      onClick={() => startEdit(a)}
                      aria-label={`Editar la cuenta «${a.label}» de ${form?.label ?? a.providerCode}`}
                    >
                      <Pencil className="size-3.5" />
                      Editar
                    </Button>
                  </div>
                </div>
                {/* El operador ve una cuenta cargada y asume que funciona. No funciona. */}
                {!statusEnablesProvider(a.status) && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                    <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                    <span>
                      Guardada pero <strong>sin efecto</strong>: sólo las cuentas en estado Activo
                      habilitan el proveedor. Para promoverla, abre <strong>Editar</strong> y
                      guárdala con estado <strong>Activo</strong>; tendrás que cargar las
                      credenciales otra vez, porque el API no las devuelve.
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* El editor es el mismo panel de /admin/proveedores: cabecera y pie fijos, un solo scroll. */}
      {editor !== null && provider ? (
        <ProviderAccountSheet
          mode={editor.kind}
          provider={provider}
          icon={providerMetaFor(providerCode, provider.label).icon}
          tenantName={tenant.name}
          accountLabel={editor.kind === 'edit' ? editor.account.label : undefined}
          editNotice={submission?.edit?.notice ?? null}
          editNoticeExpanded={
            submission?.edit?.outcome === 'forks' ||
            (editor.kind === 'edit' && editor.droppedConfigKeys.length > 0)
          }
          ownershipNotice={ownershipCallout}
          warnings={warnings}
          providerPicker={{
            value: providerCode,
            options: providerFormsForNode(tenant.tenantType),
            onChange: selectProvider,
          }}
          labelField={{ value: label, onChange: setLabel }}
          inheritableHelp={inheritableHelp(childCount)}
          // Qué le pasa a la herencia al guardar con ese estado. Sólo cuando SABEMOS de dónde salen
          // hoy las credenciales: con la consulta a medias o fallida diríamos "no resuelve ninguna
          // cuenta" sobre un tenant que quizá hereda, que es lo contrario de la verdad.
          consequenceNotice={
            submission && draftLookup !== undefined && draftLookup !== 'unknown'
              ? submission.notice
              : null
          }
          saveNotice={inUse}
          credentials={credentials}
          config={config}
          fieldErrors={fieldErrors}
          status={status}
          isInheritable={isInheritable}
          error={error}
          saving={saving}
          dirty={dirty}
          focusRequest={focusRequest}
          onCredentialChange={(key, value) => setCredentials((prev) => ({ ...prev, [key]: value }))}
          onConfigChange={(key, value) => setConfig((prev) => ({ ...prev, [key]: value }))}
          onStatusChange={setStatus}
          onInheritableChange={setIsInheritable}
          onSave={() => void save()}
          onClose={closeEditor}
        />
      ) : null}
    </Dialog>
  );
}

const CERTAINTY_TEXT: Record<NoticeTone, string> = {
  warn: 'text-amber-800',
  ok: 'text-emerald-800',
  muted: 'text-[var(--color-fg-subtle)]',
};

/**
 * De dónde sale la credencial de un proveedor, y QUÉ TANTO se puede afirmar de eso.
 *
 * Hasta esta tanda esta línea decía "Credenciales propias · cuenta «default»" en verde para una
 * cuenta que la búsqueda rechaza: el diagnóstico sólo miraba la puerta SQL (`status = 'active'`) y
 * no si la credencial sirve. Es el caso real de las cuentas de Sabre cargadas por API sin
 * `homePcc`. Ahora la línea dice de dónde sale —que es lo que sí sabe— y debajo dice lo que no
 * sabe, en vez de pintar de verde una suposición.
 */
function ProviderOrigin({
  form,
  origin,
  ownerNameOf,
  visibleConfig,
}: {
  form: ProviderForm;
  origin: OriginLookup;
  ownerNameOf: (ownerTenantId: string) => string;
  visibleConfig: (origin: ResolvedOrigin) => Record<string, unknown> | undefined;
}) {
  if (origin === 'unknown') {
    return (
      <span className="text-xs text-[var(--color-fg-muted)] sm:text-right">
        No pudimos consultar el origen · reintenta abriendo de nuevo esta pantalla
      </span>
    );
  }

  if (origin === 'none') {
    return (
      <span className="text-xs text-[var(--color-fg-muted)] sm:text-right">
        <span className="font-medium text-[var(--color-fg)]">
          Sin credenciales propias ni heredadas
        </span>
      </span>
    );
  }

  const certainty = accountCertaintyNotice(
    accountCertainty(form, visibleConfig(origin), {
      readiness: origin.readiness,
      missingRequiredFields: origin.missingRequiredFields,
    }),
  );

  return (
    <div className="text-xs text-[var(--color-fg-muted)] sm:max-w-[70%] sm:text-right">
      {origin.inherited ? (
        <p>
          <span className="font-medium text-sky-700">Heredadas</span> de{' '}
          <span className="font-medium text-[var(--color-fg)]">
            {ownerNameOf(origin.ownerTenantId)}
          </span>{' '}
          · cuenta «{origin.label}»
        </p>
      ) : (
        <p>
          <span className="font-medium text-[var(--color-fg)]">Credenciales propias</span> · cuenta
          «{origin.label}»
        </p>
      )}
      {certainty && (
        <p className={cn('mt-0.5 leading-snug', CERTAINTY_TEXT[certainty.tone])}>
          {certainty.text}
        </p>
      )}
    </div>
  );
}

interface MarkupRule {
  id: string;
  vertical: string;
  ruleType: string;
  valueMinor: number;
  priority: number;
  status: string;
}

interface WaterfallStep {
  tenantName: string;
  level: number;
  ruleType: string;
  addedMinor: number;
}

const VERTICALS = ['all', 'flights', 'hotels', 'cars', 'assistance', 'activities'];

function PricingModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [rules, setRules] = useState<MarkupRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ vertical: 'all', ruleType: 'percentage', value: '' });

  // Simulador
  const [simVertical, setSimVertical] = useState('flights');
  const [simNet, setSimNet] = useState('100000');
  const [sim, setSim] = useState<{ final: number; markup: number; steps: WaterfallStep[] } | null>(
    null,
  );
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/pricing/rules?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { rules?: MarkupRule[] };
      setRules(data.rules ?? []);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }

  async function addRule() {
    setError('');
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Ingresa un valor válido.');
      return;
    }
    // percentage: el usuario ingresa % (ej 5) → value_minor = %×100. fixed: monto en unidad mayor → minor.
    const valueMinor =
      form.ruleType === 'percentage' ? Math.round(value * 100) : Math.round(value * 100);
    setSaving(true);
    try {
      const res = await fetch('/api/pricing/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          vertical: form.vertical,
          ruleType: form.ruleType,
          valueMinor,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Error al crear la regla');
        return;
      }
      setForm({ vertical: 'all', ruleType: 'percentage', value: '' });
      void load();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(id: string) {
    await fetch(`/api/pricing/rules/${id}?tenantId=${encodeURIComponent(tenant.id)}`, {
      method: 'DELETE',
    });
    void load();
  }

  async function simulate() {
    setSimulating(true);
    try {
      const res = await fetch('/api/pricing/waterfall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          vertical: simVertical,
          netMinor: Math.round(Number(simNet) * 100),
        }),
      });
      const data = (await res.json()) as {
        finalMinor: number;
        totalMarkupMinor: number;
        breakdown: WaterfallStep[];
      };
      setSim({
        final: data.finalMinor,
        markup: data.totalMarkupMinor,
        steps: data.breakdown ?? [],
      });
    } catch {
      setSim(null);
    } finally {
      setSimulating(false);
    }
  }

  const money = (minor: number) =>
    (minor / 100).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reglas de pricing · ${tenant.name}`}
      className="max-w-2xl"
      // Al abrir, el alta de una regla y no el primer botón de la lista, que borra una regla.
      initialFocus="[data-dialog-body] select"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </ModalFooter>
      }
    >
      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
        Las reglas de este nodo se aplican <strong>en cascada</strong> junto con las de sus
        ancestros (consolidador → agencia → sub-agencia) sobre el neto del proveedor.
      </p>

      {/* Reglas propias */}
      {loading ? (
        <div className="h-12 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-xs text-[var(--color-fg-muted)]">
          Sin reglas propias. Este nodo aplica sólo las heredadas de sus ancestros.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--color-fg-muted)]">
                  {r.vertical}
                </span>
                <span className="font-medium text-[var(--color-fg)]">
                  {r.ruleType === 'percentage'
                    ? `+${(r.valueMinor / 100).toLocaleString('es-CO')}%`
                    : `+${money(r.valueMinor)}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void removeRule(r.id)}
                className="rounded p-1 text-[var(--color-fg-subtle)] hover:bg-red-50 hover:text-red-600"
                aria-label="Eliminar regla"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Agregar regla */}
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
        <div className="space-y-1">
          <Label>Vertical</Label>
          <select
            value={form.vertical}
            onChange={(e) => setForm({ ...form, vertical: e.target.value })}
            className={selectClass + ' w-32'}
          >
            {VERTICALS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Tipo</Label>
          <select
            value={form.ruleType}
            onChange={(e) => setForm({ ...form, ruleType: e.target.value })}
            className={selectClass + ' w-32'}
          >
            <option value="percentage">Porcentaje (%)</option>
            <option value="fixed">Monto fijo</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>{form.ruleType === 'percentage' ? 'Valor (%)' : 'Valor'}</Label>
          <input
            type="number"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder={form.ruleType === 'percentage' ? '5' : '10000'}
            className={inputClass + ' w-28'}
          />
        </div>
        <Button size="sm" className="gap-1.5" disabled={saving} onClick={() => void addRule()}>
          <Plus className="size-3.5" />
          {saving ? '…' : 'Agregar'}
        </Button>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Simulador */}
      <div className="mt-5 rounded-xl border border-[var(--color-border)] p-3">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--color-fg)]">
          <Calculator className="size-4 text-[var(--color-primary)]" />
          Simulador de cascada
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Vertical</Label>
            <select
              value={simVertical}
              onChange={(e) => setSimVertical(e.target.value)}
              className={selectClass + ' w-32'}
            >
              {VERTICALS.filter((v) => v !== 'all').map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Neto del proveedor</Label>
            <input
              type="number"
              value={simNet}
              onChange={(e) => setSimNet(e.target.value)}
              className={inputClass + ' w-32'}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={simulating}
            onClick={() => void simulate()}
          >
            {simulating ? 'Calculando…' : 'Simular'}
          </Button>
        </div>

        {sim && (
          <div className="mt-3 space-y-1.5 text-sm">
            {sim.steps.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]"
              >
                <span>
                  {s.tenantName}{' '}
                  <span className="text-[var(--color-fg-subtle)]">(nivel {s.level})</span>
                </span>
                <span>+ {money(s.addedMinor)}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-[var(--color-border)] pt-2 font-medium text-[var(--color-fg)]">
              <span>Precio final</span>
              <span>
                {money(sim.final)}{' '}
                <span className="text-xs font-normal text-emerald-600">
                  (+{money(sim.markup)} markup)
                </span>
              </span>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

interface AuditEntry {
  id: string;
  occurredAt: string;
  eventType: string;
  tenantName: string | null;
  actorEmail: string | null;
  payload: Record<string, unknown>;
}

const EVENT_LABELS: Record<string, string> = {
  TenantCreated: 'Agencia creada',
  ProviderCredentialsUpdated: 'Credenciales actualizadas',
  MembershipRoleChanged: 'Rol cambiado',
  MarkupRuleCreated: 'Regla de markup creada',
  MarkupRuleDeleted: 'Regla de markup eliminada',
};

function AuditModal({ rootId, onClose }: { rootId: string; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/tenants/network/audit?tenantId=${encodeURIComponent(rootId)}`,
        );
        const data = (await res.json()) as { events?: AuditEntry[] };
        setEvents(data.events ?? []);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [rootId]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Actividad de la red"
      className="max-w-2xl"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
        </ModalFooter>
      }
    >
      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
        Registro inmutable de acciones sensibles en tu red (credenciales, roles, reglas de pricing,
        altas de agencias).
      </p>
      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-10 text-center text-xs text-[var(--color-fg-muted)]">
          Sin actividad registrada todavía.
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--color-fg)]">
                  {EVENT_LABELS[e.eventType] ?? e.eventType}
                </div>
                <div className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                  {e.tenantName ?? '—'}
                  {e.actorEmail ? ` · ${e.actorEmail}` : ''}
                </div>
              </div>
              <time className="shrink-0 text-[10px] text-[var(--color-fg-subtle)]">
                {new Date(e.occurredAt).toLocaleString('es-CO', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Extrae el mensaje de negocio del cuerpo de error del API (HttpException → { message }). */
function apiError(data: { message?: string | string[]; error?: string }, fallback: string): string {
  const m = Array.isArray(data.message) ? data.message.join(', ') : data.message;
  return m ?? data.error ?? fallback;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface EmailAccountView {
  providerCode: string;
  config: Record<string, unknown>;
  isInheritable: boolean;
  status: string;
  updatedAt: string;
}

function EmailModal({ tenant, onClose }: { tenant: NetworkTenant; onClose: () => void }) {
  const [existing, setExisting] = useState<EmailAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    fromName: '',
    fromEmail: '',
    host: 'smtp.gmail.com',
    port: '587',
    user: '',
    appPassword: '',
    isInheritable: true,
  });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/provider-accounts?tenantId=${encodeURIComponent(tenant.id)}`);
      const data = (await res.json()) as { accounts?: EmailAccountView[] };
      const acc = (data.accounts ?? []).find((a) => a.providerCode === 'email') ?? null;
      setExisting(acc);
      if (acc) {
        const c = acc.config ?? {};
        setForm((f) => ({
          ...f,
          fromName: asStr(c['fromName']),
          fromEmail: asStr(c['fromEmail']),
          host: asStr(c['host']) || f.host,
          port:
            typeof c['port'] === 'number' || typeof c['port'] === 'string'
              ? String(c['port'])
              : f.port,
          isInheritable: acc.isInheritable,
        }));
      }
    } catch {
      setExisting(null);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setError('');
    setSaved(false);
    if (!form.host.trim() || !form.user.trim() || !form.appPassword) {
      setError('Servidor, correo y clave de aplicación son requeridos.');
      return;
    }
    setSaving(true);
    try {
      const port = Number(form.port) || 587;
      const res = await fetch('/api/provider-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          providerCode: 'email',
          label: 'default',
          credentials: { user: form.user.trim(), password: form.appPassword },
          config: {
            host: form.host.trim(),
            port,
            secure: port === 465,
            fromEmail: form.fromEmail.trim() || form.user.trim(),
            fromName: form.fromName.trim(),
          },
          isInheritable: form.isInheritable,
          status: 'active',
        }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        setError(apiError(data, 'No se pudo guardar la configuración de email'));
        return;
      }
      setForm((f) => ({ ...f, appPassword: '' }));
      setSaved(true);
      void load();
    } catch {
      setError('Error de conexión');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch('/api/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.id }),
      });
      const data = (await res.json()) as {
        sent?: boolean;
        to?: string;
        from?: string;
        reason?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setTestMsg({ ok: false, text: apiError(data, 'No se pudo enviar la prueba.') });
        return;
      }
      if (data.sent) {
        setTestMsg({
          ok: true,
          text: `Correo de prueba enviado a ${data.to ?? ''}${data.from ? ` (desde ${data.from})` : ''}.`,
        });
      } else {
        setTestMsg({ ok: false, text: data.reason ?? 'No se pudo enviar la prueba.' });
      }
    } catch {
      setTestMsg({ ok: false, text: 'Error de conexión.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Email · ${tenant.name}`}
      className="max-w-2xl"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Cerrar
          </Button>
          <Button disabled={saving || loading} onClick={() => void save()}>
            {saving ? 'Guardando…' : 'Guardar email'}
          </Button>
        </ModalFooter>
      }
    >
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]" />
        <span>
          Correo desde el que esta agencia envía sus notificaciones. La clave se cifra y nunca se
          muestra de vuelta. <strong className="text-[var(--color-fg)]">Si lo dejas vacío</strong>,
          se usa el correo del sistema (o el del consolidador, si lo heredas).
        </span>
      </div>

      {loading ? (
        <div className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
      ) : (
        <>
          {existing && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <Mail className="size-3.5 shrink-0" />
              <span>
                Correo configurado
                {asStr(existing.config['fromEmail'])
                  ? ` (${asStr(existing.config['fromEmail'])})`
                  : ''}
                . Para reemplazarlo, completa de nuevo el correo y la clave.
              </span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre del remitente">
              <input
                value={form.fromName}
                onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                placeholder="Agencia Sur"
                className={inputClass}
              />
            </Field>
            <Field label="Correo del remitente">
              <input
                type="email"
                value={form.fromEmail}
                onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
                placeholder="notificaciones@agencia.com"
                className={inputClass}
              />
            </Field>
            <Field label="Servidor SMTP">
              <input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="smtp.gmail.com"
                className={inputClass}
              />
            </Field>
            <Field label="Puerto">
              <input
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="587"
                className={inputClass}
              />
            </Field>
            <Field label="Usuario (correo de la cuenta)">
              <input
                type="email"
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value })}
                placeholder="cuenta@agencia.com"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
            <Field label="Clave de aplicación">
              <input
                type="password"
                value={form.appPassword}
                onChange={(e) => setForm({ ...form, appPassword: e.target.value })}
                placeholder="••••••••••••"
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">
            En Gmail/Workspace usa una{' '}
            <span className="font-medium text-[var(--color-fg-muted)]">clave de aplicación</span>{' '}
            (no tu contraseña normal). Puerto 587 (TLS) o 465 (SSL).
          </p>
          <label className="mt-3 flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              checked={form.isInheritable}
              onChange={(e) => setForm({ ...form, isInheritable: e.target.checked })}
              className="size-4 rounded border-[var(--color-border)]"
            />
            Heredable: las sub-agencias sin correo propio usan éste
          </label>
          {error && <ErrorBox>{error}</ErrorBox>}
          {saved && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Configuración de email guardada.
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={testing}
              onClick={() => void sendTest()}
            >
              {testing ? 'Enviando…' : 'Enviar correo de prueba'}
            </Button>
            <span className="text-[11px] text-[var(--color-fg-subtle)]">
              Prueba el correo guardado/efectivo (guarda primero si cambiaste algo).
            </span>
            {testMsg && (
              <span
                className={cn('w-full text-xs', testMsg.ok ? 'text-emerald-700' : 'text-red-700')}
              >
                {testMsg.text}
              </span>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

/* ---------- primitivos de UI locales ---------- */

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** `role="alert"` para que el error se anuncie al aparecer: sin eso sólo lo ve quien mira. */
function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
    >
      {children}
    </div>
  );
}

/** Las acciones del pie fijo del diálogo: apiladas en el teléfono, en fila desde `sm`. */
function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}
