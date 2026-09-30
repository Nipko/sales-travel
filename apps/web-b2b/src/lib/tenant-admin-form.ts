import { invitationExpiry } from './invitation-expiry';
import type { CreatedNode, NewNodeInput } from './tenant-admin-client';
import { idleError, parseIdle, parseSeats, seatsError } from './tenant-admin-seats';
import { CREATABLE_KIND_LABEL, createFields, type CreatableKind } from './tenant-network';

/**
 * El formulario de alta de un nodo en "Gestión de Agencias": borrador, validación y lo que se manda.
 * Sin I/O. Las reglas son las del API (CreateTenantSchema), dichas antes de enviar.
 */

export type Language = 'es' | 'pt' | 'en';

export interface NodeDraft {
  readonly kind: CreatableKind | undefined;
  readonly parentTenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly defaultLanguage: Language;
  /** El admin inicial se invita por correo y elige su contraseña: sólo se pide su email. */
  readonly adminEmail: string;
  /** Puestos simultáneos propios; `''` = comparte el cupo de su padre. Sólo lo fija el superadmin. */
  readonly concurrentSeats: string;
  /** Minutos de inactividad; `''` = hereda. Sólo lo fija el superadmin. */
  readonly idleTimeoutMinutes: string;
}

/** Países de operación, con la moneda que se propone al elegirlos. */
export const COUNTRY_OPTIONS: readonly {
  readonly code: string;
  readonly label: string;
  readonly currency: string;
}[] = [
  { code: 'CO', label: 'Colombia', currency: 'COP' },
  { code: 'BR', label: 'Brasil', currency: 'BRL' },
  { code: 'PE', label: 'Perú', currency: 'PEN' },
  { code: 'CL', label: 'Chile', currency: 'CLP' },
  { code: 'MX', label: 'México', currency: 'MXN' },
  { code: 'AR', label: 'Argentina', currency: 'ARS' },
  { code: 'EC', label: 'Ecuador', currency: 'USD' },
];

export const CURRENCY_OPTIONS: readonly string[] = [
  'COP',
  'BRL',
  'PEN',
  'CLP',
  'MXN',
  'ARS',
  'USD',
];

export const LANGUAGE_OPTIONS: readonly { readonly code: Language; readonly label: string }[] = [
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Portugués' },
  { code: 'en', label: 'Inglés' },
];

/** La moneda que se propone para un país; la actual si el país no está en la lista. */
export function currencyForCountry(code: string, current: string): string {
  return COUNTRY_OPTIONS.find((c) => c.code === code)?.currency ?? current;
}

export function emptyDraft(kind: CreatableKind | undefined, parentTenantId: string): NodeDraft {
  return {
    kind,
    parentTenantId,
    name: '',
    slug: '',
    countryCode: 'CO',
    defaultCurrency: 'COP',
    defaultLanguage: 'es',
    adminEmail: '',
    concurrentSeats: '',
    idleTimeoutMinutes: '',
  };
}

export type DraftField =
  | 'kind'
  | 'parentTenantId'
  | 'name'
  | 'slug'
  | 'adminEmail'
  | 'concurrentSeats'
  | 'idleTimeoutMinutes';

/**
 * Qué pide el alta sobre puestos e inactividad. Sólo el superadmin los ve (`undefined` = no se
 * piden). Bajo la plataforma el cupo es obligatorio: un consolidador o una agencia directa sin
 * cupo no tendría de quién heredarlo y quedaría sin límite.
 */
export interface SeatFieldsPolicy {
  readonly seatsRequired: boolean;
}

/** La política de puestos del alta según el padre elegido; `undefined` si no la fija quien crea. */
export function seatFieldsPolicy(
  superadmin: boolean,
  parentType: string | undefined,
): SeatFieldsPolicy | undefined {
  if (!superadmin) return undefined;
  return { seatsRequired: parentType === 'platform' };
}

const SLUG = /^[a-z0-9-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Los errores por campo; vacío si se puede enviar. */
export function validateNodeDraft(
  draft: NodeDraft,
  seats?: SeatFieldsPolicy,
): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  if (draft.kind === undefined) errors.kind = 'Elegí qué tipo de nodo crear.';
  if (draft.parentTenantId === '') errors.parentTenantId = 'Elegí de qué nodo cuelga.';
  const name = draft.name.trim();
  if (name.length < 2) errors.name = 'El nombre necesita al menos 2 caracteres.';
  else if (name.length > 120) errors.name = 'El nombre admite hasta 120 caracteres.';
  const slug = draft.slug.trim();
  if (slug.length < 2 || slug.length > 50) {
    errors.slug = 'El slug necesita entre 2 y 50 caracteres.';
  } else if (!SLUG.test(slug)) {
    errors.slug = 'Sólo minúsculas, números y guiones, sin espacios ni tildes.';
  }
  const email = draft.adminEmail.trim();
  if (email !== '' && !EMAIL.test(email)) errors.adminEmail = 'Ese email no parece válido.';
  if (seats !== undefined) {
    const seatsMessage = seatsError(draft.concurrentSeats, seats.seatsRequired);
    if (seatsMessage !== undefined) errors.concurrentSeats = seatsMessage;
    const idleMessage = idleError(draft.idleTimeoutMinutes);
    if (idleMessage !== undefined) errors.idleTimeoutMinutes = idleMessage;
  }
  return errors;
}

/**
 * Lo que se manda al API. Sin email de admin, el nodo se crea sin él (antes un '' daba un 400); con
 * email, se le invita y elige su contraseña.
 */
export function nodeDraftPayload(draft: NodeDraft): NewNodeInput | undefined {
  if (draft.kind === undefined || draft.parentTenantId === '') return undefined;
  const email = draft.adminEmail.trim().toLowerCase();
  // Vacío es heredar: no viaja (y así quien no es superadmin nunca los manda, que sería un 403).
  const concurrentSeats = parseSeats(draft.concurrentSeats);
  const idleTimeoutMinutes = parseIdle(draft.idleTimeoutMinutes);
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    countryCode: draft.countryCode,
    defaultCurrency: draft.defaultCurrency,
    defaultLanguage: draft.defaultLanguage,
    parentTenantId: draft.parentTenantId,
    ...createFields(draft.kind),
    ...(email === '' ? {} : { adminEmail: email }),
    ...(concurrentSeats === undefined ? {} : { concurrentSeats }),
    ...(idleTimeoutMinutes === undefined ? {} : { idleTimeoutMinutes }),
  };
}

/**
 * El aviso al terminar el alta, con lo que pasó con el admin: invitado y cuándo vence, o que la
 * invitación no salió. Las dos se resuelven en Equipo (reenviar o invitar).
 */
export function createdMessage(
  created: CreatedNode,
  kind: CreatableKind,
  name: string,
  parentName: string,
  now: Date = new Date(),
): { readonly title: string; readonly detail?: string; readonly warn: boolean } {
  const participle = kind === 'consolidator' ? 'creado' : 'creada';
  const title = `${CREATABLE_KIND_LABEL[kind]} ${name} ${participle} bajo ${parentName}.`;
  switch (created.admin?.status) {
    case 'invited': {
      const expiry =
        created.admin.expiresAt === undefined
          ? undefined
          : invitationExpiry(created.admin.expiresAt, now);
      const when = expiry === undefined ? '' : ` (la invitación ${expiry.label})`;
      return {
        title,
        detail: `Invitamos a ${created.admin.email}${when}: elige su contraseña al aceptar. Si no le llega, reenvíala desde Equipo.`,
        warn: false,
      };
    }
    case 'invite_failed':
      return {
        title,
        detail: `La invitación a ${created.admin.email} no salió: invítalo desde Equipo.`,
        warn: true,
      };
    default:
      return { title, warn: false };
  }
}
