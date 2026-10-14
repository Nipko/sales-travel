'use client';

import { Megaphone, Send } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnnouncementBannerItem } from '../../../../../../../components/layout/announcement-banner';
import {
  Checkbox,
  Field,
  Select,
  Textarea,
  TextInput,
} from '../../../../../../../components/ui/field';
import { FormSheet } from '../../../../../../../components/ui/form-sheet';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_MAX_WINDOW_DAYS,
  ANNOUNCEMENT_TITLE_MAX,
  SEVERITY_OPTIONS,
  TITLE_PLACEHOLDER,
  charCount,
  draftFromAnnouncement,
  draftToCreateBody,
  draftToPatchBody,
  emptyDraft,
  isDraftDirty,
  previewOf,
  validateDraft,
  type AdminAnnouncement,
  type AnnouncementDraft,
  type DraftErrors,
  type DraftField,
} from '../../../../../../../lib/announcements';
import {
  createAnnouncement,
  updateAnnouncement,
} from '../../../../../../../lib/announcements-client';
import { cn } from '../../../../../../../lib/cn';
import type { NodeOption } from '../../../../../../../lib/platform-orders';

/** Los nodos para "Un nodo y su red": se leen aparte y el formulario abre aunque no lleguen. */
export type NodeOptionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly options: readonly NodeOption[] };

const LEGEND = 'mb-1.5 text-xs font-semibold text-[var(--color-fg)]';

/** Una opción de radio en tarjeta: el texto entero es la etiqueta, y el foco se ve. */
function RadioCard({
  name,
  checked,
  onChange,
  disabled,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]',
        checked
          ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/6'
          : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-primary)] focus-visible:outline-none"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * Los campos del anuncio y su vista previa, sin estado propio: cada cambio sale entero por
 * `onChange`. Los errores se muestran sólo si `showErrors` (después de intentar publicar).
 */
export function AnnouncementFormFields({
  draft,
  onChange,
  errors,
  showErrors,
  nodes,
  disabled,
  selectedNodeName,
  fieldRefs,
}: {
  draft: AnnouncementDraft;
  onChange: (next: AnnouncementDraft) => void;
  errors: DraftErrors;
  showErrors: boolean;
  nodes: NodeOptionsState;
  disabled: boolean;
  /** El nombre del nodo del anuncio que se edita, por si la red no llegó. */
  selectedNodeName?: string | null;
  fieldRefs?: { current: Partial<Record<DraftField, HTMLElement | null>> };
}) {
  const severityName = useId();
  const scopeName = useId();
  const shown = (field: DraftField) => (showErrors ? errors[field] : undefined);
  const register = (field: DraftField) => (el: HTMLElement | null) => {
    if (fieldRefs) fieldRefs.current[field] = el;
  };
  const options = nodes.status === 'ready' ? nodes.options : [];
  const missing =
    draft.rootTenantId !== '' && !options.some((n) => n.id === draft.rootTenantId.toLowerCase());
  const preview = previewOf(draft);
  const severity = SEVERITY_OPTIONS.find((o) => o.value === draft.severity);

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className={LEGEND}>Gravedad</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SEVERITY_OPTIONS.map((option) => (
            <RadioCard
              key={option.value}
              name={severityName}
              checked={draft.severity === option.value}
              onChange={() => onChange({ ...draft, severity: option.value })}
              disabled={disabled}
            >
              <span className="block font-semibold">{option.label}</span>
              <span className="text-[var(--color-fg-muted)]">{option.detail}</span>
            </RadioCard>
          ))}
        </div>
      </fieldset>

      <Field
        label="Título"
        required
        error={shown('title')}
        hint={`${charCount(draft.title.trim())}/${ANNOUNCEMENT_TITLE_MAX} caracteres. Texto plano, en una línea.`}
      >
        {(a11y) => (
          <TextInput
            {...a11y}
            ref={register('title')}
            name="title"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            maxLength={ANNOUNCEMENT_TITLE_MAX}
            placeholder={TITLE_PLACEHOLDER}
            autoComplete="off"
            disabled={disabled}
          />
        )}
      </Field>

      <Field
        label="Mensaje"
        error={shown('body')}
        hint={`${charCount(draft.body.trim())}/${ANNOUNCEMENT_BODY_MAX} caracteres. Opcional. Texto plano: sin formato ni enlaces; los saltos de línea se respetan.`}
      >
        {(a11y) => (
          <Textarea
            {...a11y}
            ref={register('body')}
            name="body"
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            maxLength={ANNOUNCEMENT_BODY_MAX}
            rows={4}
            placeholder="Durante ese lapso no se podrán buscar ni reservar hoteles de TBO. Lo ya reservado no cambia."
            disabled={disabled}
          />
        )}
      </Field>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className={LEGEND}>Para</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <RadioCard
            name={scopeName}
            checked={draft.scope === 'network'}
            onChange={() => onChange({ ...draft, scope: 'network' })}
            disabled={disabled}
          >
            <span className="block font-semibold">Toda la red</span>
            <span className="text-[var(--color-fg-muted)]">
              Todas las agencias de la plataforma.
            </span>
          </RadioCard>
          <RadioCard
            name={scopeName}
            checked={draft.scope === 'node'}
            onChange={() => onChange({ ...draft, scope: 'node' })}
            disabled={disabled}
          >
            <span className="block font-semibold">Un nodo y su red</span>
            <span className="text-[var(--color-fg-muted)]">
              Ese nodo y todo lo que cuelga de él.
            </span>
          </RadioCard>
        </div>
        {draft.scope === 'node' ? (
          <Field
            label="Nodo"
            required
            error={shown('rootTenantId')}
            hint={
              nodes.status === 'error'
                ? 'No pudimos leer la red. Cierra y vuelve a abrir el formulario.'
                : undefined
            }
          >
            {(a11y) => (
              <Select
                {...a11y}
                ref={register('rootTenantId')}
                name="rootTenantId"
                value={draft.rootTenantId}
                onChange={(e) => onChange({ ...draft, rootTenantId: e.target.value })}
                disabled={disabled || nodes.status === 'loading'}
              >
                <option value="">
                  {nodes.status === 'loading' ? 'Cargando la red…' : 'Elige un nodo'}
                </option>
                {missing ? (
                  <option value={draft.rootTenantId}>
                    {selectedNodeName ?? 'Nodo seleccionado'}
                  </option>
                ) : null}
                {options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </fieldset>

      <label className="flex items-start gap-2.5 text-sm text-[var(--color-fg)]">
        <Checkbox
          checked={draft.adminsOnly}
          onChange={(e) => onChange({ ...draft, adminsOnly: e.target.checked })}
          disabled={disabled}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium">Solo administradores</span>
          <span className="block text-xs text-[var(--color-fg-muted)]">
            Lo ven solo quienes administran el nodo o uno superior; los vendedores no.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Desde"
          required
          error={shown('startsLocal')}
          hint="Hora Bogotá. Antes de esa hora queda programado."
        >
          {(a11y) => (
            <TextInput
              {...a11y}
              ref={register('startsLocal')}
              type="datetime-local"
              name="startsAt"
              value={draft.startsLocal}
              onChange={(e) => onChange({ ...draft, startsLocal: e.target.value })}
              disabled={disabled}
            />
          )}
        </Field>
        <Field
          label="Hasta"
          required
          error={shown('endsLocal')}
          hint={`Hora Bogotá. Como mucho ${ANNOUNCEMENT_MAX_WINDOW_DAYS} días después de empezar.`}
        >
          {(a11y) => (
            <TextInput
              {...a11y}
              ref={register('endsLocal')}
              type="datetime-local"
              name="endsAt"
              value={draft.endsLocal}
              onChange={(e) => onChange({ ...draft, endsLocal: e.target.value })}
              disabled={disabled}
            />
          )}
        </Field>
      </div>

      <section aria-label="Vista previa" className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--color-fg)]">Vista previa</h3>
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <AnnouncementBannerItem announcement={preview} className="border-b-0" />
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {severity?.detail} Cada panel lo muestra en hasta 5 minutos o al recargar la página.
        </p>
      </section>
    </div>
  );
}

const FIELD_ORDER: readonly DraftField[] = [
  'title',
  'body',
  'rootTenantId',
  'startsLocal',
  'endsLocal',
];

/**
 * Publicar o corregir un anuncio en el panel lateral. Revisa lo mismo que el API antes de mandar; si
 * algo falla, lleva el foco al primer campo con error. Corregir manda sólo lo que cambió.
 */
export function AnnouncementFormSheet({
  announcement,
  nodes,
  onClose,
  onSaved,
}: {
  /** El anuncio que se corrige; sin él, uno nuevo. */
  announcement?: AdminAnnouncement;
  nodes: NodeOptionsState;
  onClose: () => void;
  onSaved: (saved: AdminAnnouncement, mode: 'create' | 'edit') => void;
}) {
  const mode = announcement === undefined ? 'create' : 'edit';
  const base = useMemo(
    () =>
      announcement === undefined ? emptyDraft(new Date()) : draftFromAnnouncement(announcement),
    [announcement],
  );
  const [draft, setDraft] = useState<AnnouncementDraft>(base);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldRefs = useRef<Partial<Record<DraftField, HTMLElement | null>>>({});

  const errors = validateDraft(draft, new Date());
  const dirty =
    mode === 'create' ? draft.title !== '' || draft.body !== '' : isDraftDirty(draft, base);

  async function submit() {
    if (busy) return;
    setShowErrors(true);
    const first = FIELD_ORDER.find((f) => errors[f] !== undefined);
    if (first !== undefined) {
      fieldRefs.current[first]?.focus();
      return;
    }
    if (mode === 'edit' && !isDraftDirty(draft, base)) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    const res =
      announcement === undefined
        ? await createAnnouncement(draftToCreateBody(draft))
        : await updateAnnouncement(announcement.id, draftToPatchBody(draft, base));
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.data, mode);
  }

  return (
    <FormSheet
      title={mode === 'create' ? 'Nuevo anuncio' : 'Editar anuncio'}
      subtitle="Se muestra debajo de la barra superior del panel, a quien elijas."
      icon={<Megaphone />}
      dirty={dirty}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
      submitLabel={mode === 'create' ? 'Publicar' : 'Guardar cambios'}
      submitIcon={mode === 'create' ? <Send aria-hidden="true" /> : undefined}
      busyLabel={mode === 'create' ? 'Publicando…' : 'Guardando…'}
      status={
        error !== '' ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            {error}
          </p>
        ) : null
      }
    >
      <AnnouncementFormFields
        draft={draft}
        onChange={setDraft}
        errors={errors}
        showErrors={showErrors}
        nodes={nodes}
        disabled={busy}
        selectedNodeName={announcement?.audience.rootTenantName ?? null}
        fieldRefs={fieldRefs}
      />
    </FormSheet>
  );
}
