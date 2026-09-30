'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Checkbox, Select, TextInput } from '../../../../../components/ui/field';
import { FormSheet } from '../../../../../components/ui/form-sheet';
import { cn } from '../../../../../lib/cn';
import {
  DEFAULT_ACCOUNT_LABEL,
  PROVIDER_ACCOUNT_STATUSES,
  STATUS_LABELS,
  fieldKey,
  isProviderAccountStatus,
  statusEnablesProvider,
  statusNotice,
  type Notice,
  type ProviderAccountStatus,
  type ProviderField,
  type ProviderForm,
  type ProviderSection,
} from '../../../../../lib/provider-forms';

/** Id del control de un campo. Estable: el foco al primer error y las pruebas lo buscan por acá. */
export function providerFieldId(section: ProviderSection, key: string): string {
  return `byoc-${section}-${key}`;
}

/**
 * 16 px y 40 px de alto en el teléfono: con menos de 16 px iOS hace zoom al enfocar, y dentro de un
 * panel a pantalla completa ese zoom saca de la vista la cabecera y el pie fijos. Mismo criterio que
 * `components/auth/password-input`.
 */
const CONTROL_SIZE = 'h-10 text-base sm:h-9 sm:text-sm';

export interface ProviderAccountSheetProps {
  mode: 'create' | 'edit';
  provider: ProviderForm;
  /** Ícono del proveedor, el mismo de su tarjeta. */
  icon?: LucideIcon;
  tenantName: string;
  /** Etiqueta de la cuenta que se abrió a editar. */
  accountLabel?: string;
  /** Qué le pasa a la cuenta abierta al guardar (reescritura). Sólo al editar. */
  editNotice: Notice | null;
  /**
   * El aviso de reescritura abre plegado: el título ya dice lo que pasa y la sección de credenciales
   * repite qué hacer. Abre desplegado cuando además se pierde algo que no está en pantalla.
   */
  editNoticeExpanded?: boolean;
  ownershipNotice: Notice | null;
  warnings: readonly Notice[];
  /**
   * Elegir el proveedor al conectar. Sin esto el proveedor viene dado (la tarjeta de la que se
   * abrió). Al editar no se ofrece: la cuenta se guarda por agencia + proveedor + etiqueta, así que
   * cambiarlo daría de alta otra en vez de modificar ésta.
   */
  providerPicker?: {
    readonly value: string;
    readonly options: readonly (readonly [string, ProviderForm])[];
    readonly onChange: (code: string) => void;
  };
  /** La etiqueta de la cuenta, editable. Sin esto la fija la pantalla. */
  labelField?: { readonly value: string; readonly onChange: (label: string) => void };
  /** Ayuda de la casilla de herencia; sin ella, la genérica. */
  inheritableHelp?: string;
  /** Qué le pasa a la herencia de la red al guardar con este estado. */
  consequenceNotice?: Notice | null;
  /**
   * Un guardado rechazado que no es un error del formulario —la cuenta tiene reservas vivas—: un
   * aviso en el pie, junto a Guardar, y no el rojo de "Error al guardar".
   */
  saveNotice?: Notice | null;
  credentials: Readonly<Record<string, string>>;
  config: Readonly<Record<string, string>>;
  fieldErrors: Readonly<Record<string, string>>;
  status: ProviderAccountStatus;
  isInheritable: boolean;
  error: string;
  saving: boolean;
  dirty: boolean;
  /** Sube en cada guardado rechazado por validación: el foco va al primer campo con error. */
  focusRequest: number;
  onCredentialChange: (key: string, value: string) => void;
  onConfigChange: (key: string, value: string) => void;
  onStatusChange: (status: ProviderAccountStatus) => void;
  onInheritableChange: (value: boolean) => void;
  onSave: () => void;
  onClose: () => void;
}

/**
 * El editor de la cuenta de un proveedor (LATAM NDC, Sabre, TBO, AgentCars…): los campos salen de
 * la forma declarada en `lib/provider-forms`, así que un proveedor nuevo no necesita pantalla nueva.
 *
 * Cuatro bloques en el orden en que se decide: qué pasa al guardar (el aviso de reescritura), las
 * credenciales, la configuración y, al final, el estado y la herencia, que deciden si todo lo
 * anterior habilita algo.
 */
export function ProviderAccountSheet(props: ProviderAccountSheetProps) {
  const {
    mode,
    provider,
    icon: Icon = KeyRound,
    tenantName,
    accountLabel,
    editNotice,
    editNoticeExpanded = false,
    ownershipNotice,
    warnings,
    providerPicker,
    labelField,
    consequenceNotice,
    saveNotice,
    credentials,
    config,
    fieldErrors,
    status,
    isInheritable,
    error,
    saving,
    dirty,
    focusRequest,
  } = props;
  const noticeId = useId();
  const statusId = useId();
  const inheritableHelpId = useId();

  // Al rechazar un guardado, el foco va al primer campo marcado —o al primero de todos si el
  // problema no es de un campo—: el resumen del pie dice qué pasa, el foco dice dónde.
  useEffect(() => {
    if (focusRequest === 0) return;
    const body = document.querySelector<HTMLElement>('[data-sheet-body]');
    const target =
      body?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      body?.querySelector<HTMLElement>('input:not([type="checkbox"]), select');
    target?.focus();
    target?.scrollIntoView({ block: 'center' });
  }, [focusRequest]);

  const enables = statusEnablesProvider(status);
  const showPicker = providerPicker !== undefined && mode === 'create';
  const hasAccountSection = showPicker || labelField !== undefined;
  const hasIntro = Boolean(editNotice || provider.note || ownershipNotice);
  // Al editar se viene a recargar las credenciales: el foco va a la primera aunque arriba haya una
  // etiqueta editable.
  const firstCredential = provider.credentials[0];
  const initialFocus =
    mode === 'edit' && firstCredential
      ? `[data-sheet-body] #${providerFieldId('credentials', firstCredential.key)}`
      : undefined;

  return (
    <FormSheet
      title={
        mode === 'edit' ? `Editar variables · ${provider.label}` : `Conectar ${provider.label}`
      }
      subtitle={
        <>
          Agencia <strong className="font-semibold text-[var(--color-fg)]">{tenantName}</strong>
          {mode === 'edit' && accountLabel ? <> · cuenta «{accountLabel}»</> : null}
        </>
      }
      icon={<Icon />}
      describedBy={editNotice ? noticeId : undefined}
      initialFocus={initialFocus}
      dirty={dirty}
      busy={saving}
      onClose={props.onClose}
      onSubmit={props.onSave}
      submitIcon={<CheckCircle2 aria-hidden="true" />}
      submitLabel={enables ? 'Guardar y activar' : `Guardar en ${STATUS_LABELS[status]}`}
      status={
        error || saveNotice ? (
          <>
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs leading-relaxed text-[var(--color-fg)]"
              >
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-danger)]"
                />
                <span>{error}</span>
              </p>
            ) : null}
            {saveNotice ? (
              <div role="alert">
                <NoticeCallout notice={saveNotice} />
              </div>
            ) : null}
          </>
        ) : null
      }
    >
      <div className="space-y-6">
        {editNotice || provider.note || ownershipNotice ? (
          <div className="space-y-2.5 pt-3">
            {editNotice ? (
              <NoticeCallout
                titleId={noticeId}
                notice={editNotice}
                collapsible
                defaultOpen={editNoticeExpanded}
              />
            ) : null}
            {/* La guía del proveedor: abierta al conectarlo por primera vez, plegada al editar. */}
            {provider.note ? (
              <NoticeCallout
                notice={{
                  tone: 'muted',
                  title: `Cómo se conecta ${provider.label}`,
                  body: provider.note,
                }}
                collapsible
                defaultOpen={mode === 'create'}
              />
            ) : null}
            {/* Sólo al editar una cuenta cargada por API: el alta ya no se le ofrece a este nodo. */}
            {ownershipNotice ? <NoticeCallout notice={ownershipNotice} /> : null}
          </div>
        ) : null}

        {hasAccountSection ? (
          <SheetSection
            title="Cuenta"
            description="Con qué proveedor y con qué nombre se guarda en la agencia."
            first={!hasIntro}
          >
            <FieldGrid>
              {showPicker ? (
                <div className="min-w-0 space-y-1.5">
                  <label
                    htmlFor="byoc-account-provider"
                    className="block text-xs font-semibold text-[var(--color-fg)]"
                  >
                    Proveedor
                  </label>
                  <Select
                    id="byoc-account-provider"
                    value={providerPicker.value}
                    onChange={(e) => providerPicker.onChange(e.target.value)}
                    className={CONTROL_SIZE}
                  >
                    {providerPicker.options.map(([code, p]) => (
                      <option key={code} value={code}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {labelField ? (
                <div className="min-w-0 space-y-1.5">
                  <label
                    htmlFor="byoc-account-label"
                    className="block text-xs font-semibold text-[var(--color-fg)]"
                  >
                    Etiqueta
                  </label>
                  <TextInput
                    id="byoc-account-label"
                    value={labelField.value}
                    placeholder={DEFAULT_ACCOUNT_LABEL}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-describedby="byoc-account-label-help"
                    className={CONTROL_SIZE}
                    onChange={(e) => labelField.onChange(e.target.value)}
                  />
                  <p
                    id="byoc-account-label-help"
                    className="text-[11px] leading-relaxed text-[var(--color-fg-subtle)]"
                  >
                    {mode === 'edit' && accountLabel
                      ? `Si la cambias, se crea otra cuenta y «${accountLabel}» queda como está.`
                      : 'Distingue esta cuenta de otras del mismo proveedor en la agencia.'}
                  </p>
                </div>
              ) : null}
            </FieldGrid>
          </SheetSection>
        ) : null}

        <SheetSection
          title="Credenciales"
          description={
            mode === 'edit'
              ? 'Las guardadas no se muestran: vuelve a cargarlas completas para guardar.'
              : 'Se guardan cifradas y no se vuelven a mostrar.'
          }
          meta={
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
              <Lock aria-hidden="true" className="size-3" />
              Cifradas · AES-GCM
            </span>
          }
          first={!hasIntro && !hasAccountSection}
        >
          <FieldGrid>
            {provider.credentials.map((field) => (
              <ProviderFieldControl
                key={fieldKey('credentials', field.key)}
                section="credentials"
                field={field}
                value={credentials[field.key] ?? ''}
                error={fieldErrors[fieldKey('credentials', field.key)]}
                onChange={(value) => props.onCredentialChange(field.key, value)}
              />
            ))}
          </FieldGrid>
        </SheetSection>

        {provider.config.length > 0 ? (
          <SheetSection
            title="Configuración"
            description="Parámetros con los que opera la cuenta. Se guardan sin cifrar: aquí no va ninguna contraseña. Sin tocar, cada uno usa su valor por defecto."
          >
            <FieldGrid>
              {provider.config.map((field) => (
                <ProviderFieldControl
                  key={fieldKey('config', field.key)}
                  section="config"
                  field={field}
                  value={config[field.key] ?? ''}
                  error={fieldErrors[fieldKey('config', field.key)]}
                  onChange={(value) => props.onConfigChange(field.key, value)}
                />
              ))}
            </FieldGrid>
            {warnings.length > 0 ? (
              <div className="space-y-2.5">
                {warnings.map((notice) => (
                  <NoticeCallout key={notice.title} notice={notice} />
                ))}
              </div>
            ) : null}
          </SheetSection>
        ) : null}

        <SheetSection
          title="Estado y herencia"
          description="Deciden si esta cuenta habilita el proveedor y si la usa la red que cuelga de la agencia."
        >
          <FieldGrid>
            <div className="space-y-1.5">
              <label
                htmlFor={statusId}
                className="block text-xs font-semibold text-[var(--color-fg)]"
              >
                Estado de la cuenta
              </label>
              <Select
                id={statusId}
                value={status}
                className={CONTROL_SIZE}
                onChange={(e) => {
                  const next = e.target.value;
                  if (isProviderAccountStatus(next)) props.onStatusChange(next);
                }}
              >
                {PROVIDER_ACCOUNT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-start gap-2.5 sm:pt-6">
              <Checkbox
                id={`${statusId}-inheritable`}
                checked={isInheritable}
                onChange={(e) => props.onInheritableChange(e.target.checked)}
                aria-describedby={inheritableHelpId}
                className="mt-0.5 shrink-0"
              />
              <div className="min-w-0">
                <label
                  htmlFor={`${statusId}-inheritable`}
                  className="block cursor-pointer text-xs font-semibold text-[var(--color-fg)]"
                >
                  Heredable por la red
                </label>
                <p
                  id={inheritableHelpId}
                  className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-fg-muted)]"
                >
                  {props.inheritableHelp ??
                    'Las sub-agencias sin cuenta propia pueden usar ésta mientras esté Activa.'}
                </p>
              </div>
            </div>
          </FieldGrid>
          {/* Qué significa el estado elegido: guardar en Sandbox no habilita nada. */}
          <NoticeCallout notice={statusNotice(status)} />
          {consequenceNotice ? <NoticeCallout notice={consequenceNotice} /> : null}
        </SheetSection>
      </div>
    </FormSheet>
  );
}

function SheetSection({
  title,
  description,
  meta,
  first = false,
  children,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
  /** La primera del cuerpo no lleva la línea divisoria de arriba. */
  first?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn('space-y-4', first ? 'pt-3' : 'border-t border-[var(--color-border)] pt-5')}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-56">
          <h3 id={headingId} className="text-sm font-semibold text-[var(--color-fg)]">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {description}
            </p>
          ) : null}
        </div>
        {meta}
      </div>
      {children}
    </section>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">{children}</div>;
}

const NOTICE_STYLES: Record<Notice['tone'], { box: string; icon: LucideIcon; iconClass: string }> =
  {
    warn: {
      box: 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10',
      icon: AlertTriangle,
      iconClass: 'text-[oklch(0.55_0.13_70)] dark:text-[var(--color-warning)]',
    },
    ok: {
      box: 'border-[var(--color-success)]/35 bg-[var(--color-success)]/8',
      icon: CheckCircle2,
      iconClass: 'text-[var(--color-success)]',
    },
    muted: {
      box: 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/60',
      icon: Info,
      iconClass: 'text-[var(--color-fg-subtle)]',
    },
  };

/**
 * Un aviso compacto: ícono, título en negrita y el cuerpo en la misma caja. `collapsible` lo vuelve
 * un <details> —teclado y lector de pantalla incluidos— cuyo resumen es el título.
 */
function NoticeCallout({
  notice,
  titleId,
  collapsible = false,
  defaultOpen = true,
}: {
  notice: Notice;
  /** Id del título, para que el diálogo lo lea como parte de su descripción. */
  titleId?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const style = NOTICE_STYLES[notice.tone];
  const Icon = style.icon;
  if (collapsible) {
    return (
      <details
        open={defaultOpen}
        className={cn('group rounded-lg border text-xs leading-relaxed', style.box)}
      >
        <summary className="flex cursor-pointer list-none items-start gap-2.5 rounded-lg px-3 py-2.5 text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 [&::-webkit-details-marker]:hidden">
          <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', style.iconClass)} />
          <span id={titleId} className="min-w-0 flex-1 font-semibold">
            {notice.title}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
            <span className="group-open:hidden">Ver detalle</span>
            <span className="hidden group-open:inline">Ocultar</span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-180"
            />
          </span>
        </summary>
        <p className="px-3 pb-2.5 pl-9 text-[var(--color-fg-muted)]">{notice.body}</p>
      </details>
    );
  }
  return (
    <div
      id={titleId}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)]',
        style.box,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', style.iconClass)} />
      <div className="min-w-0">
        {notice.title ? <p className="font-semibold">{notice.title}</p> : null}
        <p className={cn('text-[var(--color-fg-muted)]', notice.title && 'mt-0.5')}>
          {notice.body}
        </p>
      </div>
    </div>
  );
}

/**
 * Un campo declarado por el proveedor. Todos son identificadores, códigos o URLs que se pegan desde
 * el correo del proveedor: sin autocorrección, sin mayúscula inicial del teclado del teléfono y sin
 * que el navegador ofrezca la contraseña guardada del usuario en un campo secreto.
 */
function ProviderFieldControl({
  section,
  field,
  value,
  error,
  onChange,
}: {
  section: ProviderSection;
  field: ProviderField;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = providerFieldId(section, field.key);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const [revealed, setRevealed] = useState(false);
  const describedBy =
    [field.help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const a11y = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required === true ? true : undefined,
  };
  const secret = field.secret === true;

  return (
    <div className={cn('min-w-0 space-y-1.5', field.url === true && 'sm:col-span-2')}>
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
        {field.label}
        {field.required === true ? (
          <span aria-hidden="true" className="ml-0.5 text-[var(--color-danger)]">
            *
          </span>
        ) : null}
      </label>
      {field.options ? (
        <Select
          {...a11y}
          value={value || field.defaultValue || ''}
          className={CONTROL_SIZE}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <div className="relative">
          <TextInput
            {...a11y}
            type={secret && !revealed ? 'password' : 'text'}
            value={value || field.defaultValue || ''}
            placeholder={field.placeholder}
            inputMode={field.url === true ? 'url' : undefined}
            autoComplete={secret ? 'new-password' : 'off'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore={secret ? 'true' : undefined}
            data-lpignore={secret ? 'true' : undefined}
            className={cn(CONTROL_SIZE, secret && 'pr-11 font-mono')}
            onChange={(e) => onChange(e.target.value)}
          />
          {secret ? (
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={`Mostrar ${field.label}`}
              aria-pressed={revealed}
              aria-controls={id}
              className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-lg text-[var(--color-fg-subtle)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/40"
            >
              {revealed ? (
                <EyeOff aria-hidden="true" className="size-4" />
              ) : (
                <Eye aria-hidden="true" className="size-4" />
              )}
            </button>
          ) : null}
        </div>
      )}
      {field.help ? (
        <p id={helpId} className="text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
          {field.help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[11px] font-semibold text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
