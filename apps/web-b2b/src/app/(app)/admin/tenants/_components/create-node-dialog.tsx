'use client';

import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useViewer } from '../../../../../components/layout/viewer-context';
import { NodeKindPicker } from '../../../../../components/network/node-kind';
import { Button } from '../../../../../components/ui/button';
import { Dialog } from '../../../../../components/ui/dialog';
import { Field, Select, TextInput } from '../../../../../components/ui/field';
import {
  createNode,
  type AdminNetworkNode,
  type CreatedNode,
} from '../../../../../lib/tenant-admin-client';
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  PASSWORD_MIN,
  currencyForCountry,
  emptyDraft,
  nodeDraftPayload,
  seatFieldsPolicy,
  validateNodeDraft,
  type Language,
  type NodeDraft,
} from '../../../../../lib/tenant-admin-form';
import { SeatPolicyFields } from './seat-policy-fields';
import {
  CREATABLE_KIND_LABEL,
  defaultParent,
  lineageLabel,
  newNodeLabel,
  parentOptions,
  slugify,
  type CreatableKind,
} from '../../../../../lib/tenant-network';

const SUPERADMIN = { superadmin: true } as const;

/**
 * Alta de un nodo por el superadmin: agencia, sucursal, consolidador o sub-agencia, con Planetour
 * como padre por defecto y sólo los padres que admite D4 para el tipo elegido. Desde la acción de
 * una fila el padre viene fijo y sólo se elige entre los tipos que ese padre admite.
 */
export function CreateNodeDialog({
  nodes,
  kinds,
  fixedParent,
  onCreated,
  onClose,
}: {
  nodes: readonly AdminNetworkNode[];
  kinds: readonly CreatableKind[];
  fixedParent?: AdminNetworkNode;
  onCreated: (created: CreatedNode, draft: NodeDraft, parentName: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NodeDraft>(() => {
    const kind = kinds[0];
    const parent =
      fixedParent ?? (kind === undefined ? undefined : defaultParent(nodes, kind, SUPERADMIN));
    return emptyDraft(kind, parent?.id ?? '');
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  // Puestos e inactividad los fija sólo el superadmin; esta pantalla ya es suya, pero si alguna vez
  // la abre otro rol, los campos no aparecen y no viajan (el API respondería 403).
  const { superadmin } = useViewer();

  const savingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  const options = useMemo(
    () => (draft.kind === undefined ? [] : parentOptions(nodes, draft.kind, SUPERADMIN)),
    [nodes, draft.kind],
  );
  const parent = nodes.find((n) => n.id === draft.parentTenantId);
  const seatPolicy = seatFieldsPolicy(superadmin, parent?.tenantType);
  const errors = submitted ? validateNodeDraft(draft, seatPolicy) : {};

  function set<K extends keyof NodeDraft>(key: K, value: NodeDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function chooseKind(kind: CreatableKind) {
    setDraft((d) => {
      if (fixedParent !== undefined) return { ...d, kind };
      const stillValid = parentOptions(nodes, kind, SUPERADMIN).some(
        (n) => n.id === d.parentTenantId,
      );
      return {
        ...d,
        kind,
        parentTenantId: stillValid
          ? d.parentTenantId
          : (defaultParent(nodes, kind, SUPERADMIN)?.id ?? ''),
      };
    });
  }

  async function submit() {
    if (savingRef.current) return;
    setSubmitted(true);
    setServerError('');
    if (Object.keys(validateNodeDraft(draft, seatPolicy)).length > 0) return;
    const payload = nodeDraftPayload(
      seatPolicy === undefined ? { ...draft, concurrentSeats: '', idleTimeoutMinutes: '' } : draft,
    );
    if (payload === undefined) return;

    savingRef.current = true;
    setSaving(true);
    const res = await createNode(payload);
    savingRef.current = false;
    if (!res.ok) {
      setSaving(false);
      setServerError(res.message);
      return;
    }
    const parentName = nodes.find((n) => n.id === draft.parentTenantId)?.name ?? '';
    onCreated(res.data, draft, parentName);
  }

  const title = newNodeLabel(kinds);
  const description =
    fixedParent === undefined
      ? 'Cuelga de Planetour salvo que elijas otro padre. Hereda de su padre credenciales, reglas de precio y marca.'
      : `Cuelga de ${fixedParent.name} y hereda sus credenciales, reglas de precio y marca.`;

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={description}
      className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto"
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-5"
      >
        <NodeKindPicker kinds={kinds} value={draft.kind} onChange={chooseKind} />
        {errors.kind ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {errors.kind}
          </p>
        ) : null}

        {fixedParent === undefined ? (
          <Field
            label="Cuelga de"
            required
            error={errors.parentTenantId}
            hint={
              options.length === 0 && draft.kind !== undefined
                ? `Ningún nodo de la red puede recibir un nodo de tipo ${CREATABLE_KIND_LABEL[draft.kind].toLowerCase()}.`
                : 'Sólo se listan los padres que admiten este tipo de nodo.'
            }
          >
            {(a11y) => (
              <Select
                {...a11y}
                value={draft.parentTenantId}
                onChange={(e) => set('parentTenantId', e.target.value)}
                disabled={options.length === 0}
              >
                <option value="" disabled>
                  Elegí el padre…
                </option>
                {options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {lineageLabel(nodes, n.id)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" required error={errors.name} className="sm:col-span-2">
            {(a11y) => (
              <TextInput
                {...a11y}
                value={draft.name}
                autoComplete="organization"
                maxLength={120}
                placeholder={draft.kind === 'branch' ? 'Planetour Bogotá Norte' : 'Agencia Sur'}
                onChange={(e) => {
                  const name = e.target.value;
                  setDraft((d) => ({ ...d, name, slug: slugTouched ? d.slug : slugify(name) }));
                }}
              />
            )}
          </Field>
          <Field
            label="Slug"
            required
            error={errors.slug}
            hint="Identifica al nodo en la red. Minúsculas, números y guiones."
            className="sm:col-span-2"
          >
            {(a11y) => (
              <TextInput
                {...a11y}
                value={draft.slug}
                maxLength={50}
                spellCheck={false}
                autoCapitalize="none"
                className="font-mono"
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value);
                }}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="País">
            {(a11y) => (
              <Select
                {...a11y}
                value={draft.countryCode}
                onChange={(e) => {
                  const code = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    countryCode: code,
                    defaultCurrency: currencyForCountry(code, d.defaultCurrency),
                  }));
                }}
              >
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Moneda">
            {(a11y) => (
              <Select
                {...a11y}
                value={draft.defaultCurrency}
                onChange={(e) => set('defaultCurrency', e.target.value)}
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Idioma">
            {(a11y) => (
              <Select
                {...a11y}
                value={draft.defaultLanguage}
                onChange={(e) => set('defaultLanguage', e.target.value as Language)}
              >
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {seatPolicy !== undefined ? (
          <SeatPolicyFields
            seats={draft.concurrentSeats}
            idle={draft.idleTimeoutMinutes}
            onSeats={(v) => set('concurrentSeats', v)}
            onIdle={(v) => set('idleTimeoutMinutes', v)}
            required={seatPolicy.seatsRequired}
            parentName={parent?.name}
            errors={errors}
          />
        ) : null}

        <fieldset className="space-y-4 border-t border-[var(--color-border)] pt-4">
          <legend className="sr-only">Admin inicial (opcional)</legend>
          <div>
            <p aria-hidden="true" className="text-xs font-semibold text-[var(--color-fg)]">
              Admin inicial{' '}
              <span className="font-normal text-[var(--color-fg-muted)]">(opcional)</span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
              Si el email ya tiene cuenta, o si no ponés contraseña, se lo invita y elige la suya.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" error={errors.adminEmail}>
              {(a11y) => (
                <TextInput
                  {...a11y}
                  type="email"
                  autoComplete="off"
                  value={draft.adminEmail}
                  onChange={(e) => set('adminEmail', e.target.value)}
                  placeholder="admin@agencia.com"
                />
              )}
            </Field>
            <Field label="Nombre">
              {(a11y) => (
                <TextInput
                  {...a11y}
                  autoComplete="off"
                  value={draft.adminName}
                  onChange={(e) => set('adminName', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Contraseña"
              error={errors.adminPassword}
              hint={`Al menos ${PASSWORD_MIN} caracteres.`}
              className="sm:col-span-2"
            >
              {(a11y) => (
                <TextInput
                  {...a11y}
                  type="password"
                  autoComplete="new-password"
                  value={draft.adminPassword}
                  onChange={(e) => set('adminPassword', e.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>

        {serverError ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            {serverError}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <RefreshCw aria-hidden="true" className="animate-spin" />
            ) : (
              <Plus aria-hidden="true" />
            )}
            {saving
              ? 'Creando…'
              : draft.kind === undefined
                ? 'Crear'
                : `Crear ${CREATABLE_KIND_LABEL[draft.kind].toLowerCase()}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
