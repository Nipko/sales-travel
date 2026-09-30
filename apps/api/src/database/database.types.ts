import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type TenantStatus = 'active' | 'suspended' | 'archived';
export type TenantType = 'platform' | 'consolidator' | 'agency' | 'subagency';
export type UserStatus = 'active' | 'suspended';
export type MembershipStatus = 'active' | 'suspended' | 'invited';
export type LanguageCode = 'es' | 'pt' | 'en';
export type Role =
  | 'superadmin'
  | 'platform_admin'
  | 'consolidator_admin'
  | 'tenant_admin'
  | 'agency_admin'
  | 'admin'
  | 'vendedor'
  | 'cliente_final';
export type ProviderAccountStatus = 'active' | 'sandbox' | 'disabled';

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  country_code: string;
  default_currency: string;
  default_language: Generated<LanguageCode>;
  status: Generated<TenantStatus>;
  // Modelo consolidador (jerarquía B2B2B). path lo mantiene un trigger (ltree → string).
  // Qué tipo cuelga de cuál lo valida la base (0050, D4 A): raíz sólo 'platform', y una sola;
  // bajo ella 'consolidator' y 'agency'; bajo un consolidador 'agency'; bajo una agencia
  // 'subagency'. El padre no se cambia por UPDATE: se mueve con move_tenant_subtree (0051).
  parent_tenant_id: string | null;
  tenant_type: Generated<TenantType>;
  path: Generated<string>;
  /** 0050: sucursal de Planetour (agencia hija directa de la plataforma, con vendedores propios). */
  is_branch: Generated<boolean>;
  // Branding heredable por la jerarquía (0030). NULL = hereda del ancestro más cercano.
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  commercial_name: string | null;
  support_email: string | null;
  support_phone: string | null;
  website_url: string | null;
  /** 0032: búsquedas/hora permitidas. NULL = usa el tope de la plataforma. */
  search_quota_per_hour: number | null;
  /** 0036: ¿los resultados nombran al proveedor de cada oferta? NULL = hereda del ancestro. */
  show_provider_in_results: boolean | null;
  /** 0033: host propio de la agencia. Sólo resuelve si está verificado. */
  custom_domain: string | null;
  custom_domain_verified_at: Timestamp | null;
  /**
   * 0007: crédito interno que la red le da a la agencia, en unidades MAYORES de
   * `default_currency` (NUMERIC(14,2), que `pg` devuelve como texto). 0 = sin crédito.
   *
   * FUERA DE USO desde 0053: su valor pasó al cupo de la cartera en `default_currency`
   * (`agency_portfolios.credit_limit_minor`), que fija quien financia al nodo. Se conserva como dato;
   * la API ya no lo lee (la retención usa sólo el cupo de la cartera).
   */
  credit_limit: Generated<string>;
  /**
   * 0055: sesiones simultáneas que admite el nodo (1-10000). NULL = consume del ancestro más
   * cercano que lo tenga (`seat_pool_of`); si ninguno, sin límite. Sólo lo fija el superadmin.
   */
  concurrent_seats: number | null;
  /**
   * 0055: minutos sin actividad antes de cerrar la sesión (5-480). NULL = hereda del ancestro más
   * cercano; si ninguno, 30 (`effective_idle_timeout_minutes`). Sólo lo fija el superadmin.
   */
  idle_timeout_minutes: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type SearchVertical = 'flights' | 'hotels' | 'cars';
export type SearchOutcome = 'ok' | 'empty' | 'error' | 'simulated';

export type CrmTaskKind =
  | 'FOLLOW_UP'
  | 'CALL'
  | 'QUOTE_EXPIRY'
  | 'TRAVEL_START'
  | 'POST_TRAVEL'
  | 'BIRTHDAY'
  | 'DOCUMENT_EXPIRY'
  | 'OTHER';

export interface CrmTasksTable {
  id: Generated<string>;
  tenant_id: string;
  opportunity_id: string | null;
  customer_id: string | null;
  assigned_user_id: string | null;
  title: string;
  notes: string | null;
  kind: Generated<CrmTaskKind>;
  due_at: Timestamp;
  completed_at: Timestamp | null;
  created_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SearchLogsTable {
  id: Generated<string>;
  occurred_at: Generated<Timestamp>;
  tenant_id: string | null;
  /**
   * Búsqueda del usuario a la que pertenece esta fila (0035). Varias filas con el mismo
   * grupo son UN fan-out y la cuota las cuenta una sola vez. NULL sólo en las filas
   * anteriores a la columna, que `count_recent_searches` sigue contando 1 cada una.
   *
   * Obligatorio al insertar a propósito: sin default en la BD, una fila nueva sin grupo
   * sería una búsqueda extra en la cuota del tenant y nadie se enteraría.
   */
  search_group_id: string | null;
  actor_user_id: string | null;
  vertical: SearchVertical;
  provider_code: string;
  duration_ms: number;
  result_count: Generated<number>;
  outcome: SearchOutcome;
  error_code: string | null;
  /** Criterio REDUCIDO (ruta, fechas, pax). Nunca PII. */
  criteria: Generated<unknown>;
}

export interface ProviderAccountsTable {
  id: Generated<string>;
  tenant_id: string;
  provider_code: string;
  label: Generated<string>;
  credentials_enc: Buffer;
  config: Generated<unknown>;
  is_inheritable: Generated<boolean>;
  status: Generated<ProviderAccountStatus>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string | null;
  name: string | null;
  status: Generated<UserStatus>;
  email_verified_at: Timestamp | null;
  // Hardening de login (account lockout anti brute-force).
  failed_login_attempts: Generated<number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  // 0026: invalida cualquier token emitido antes de este cambio de contraseña.
  password_changed_at: Timestamp | null;
  // 0027: MFA TOTP. mfa_secret va cifrado (AES-256-GCM), nunca en claro.
  mfa_secret: string | null;
  mfa_enabled_at: Timestamp | null;
  mfa_last_used_step: string | null;
  /**
   * 0055: secreto nuevo del enrolamiento o de "cambiar de teléfono", cifrado igual que `mfa_secret`.
   * Pasa a `mfa_secret` recién cuando /auth/mfa/confirm verifica un código contra él.
   */
  mfa_pending_secret: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SessionsTable {
  /** Viaja como claim `jti` del access token. */
  id: Generated<string>;
  user_id: string;
  tenant_id: string | null;
  // Timestamp (no Generated<Timestamp>): su tipo de inserción ya admite undefined, así
  // que sigue siendo opcional al insertar, pero el SELECT devuelve Date en vez de
  // ColumnType anidado.
  issued_at: Timestamp;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  ip: string | null;
  user_agent: string | null;
  /**
   * 0055: tope de inactividad de ESTA sesión, snapshot de `effective_idle_timeout_minutes * 60` al
   * emitirla. La base lo acota a 300-28800 (5 min a 8 h).
   */
  idle_timeout_seconds: Generated<number>;
  /**
   * 0055: nodo del cupo que consume (`seat_pool_of` del tenant al emitir). NULL = no consume
   * puesto: usuario de plataforma o nodo sin límite.
   */
  seat_tenant_id: string | null;
  /** 0055: la sesión pasó el segundo factor (TOTP, código de recuperación o equipo de confianza). */
  mfa_verified_at: Timestamp | null;
}

/** Un instante sin default en la base: obligatorio al insertar. */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * 0055: desafío MFA del login. El `id` viaja como `jti` del mfaToken; máximo 5 intentos y un solo
 * consumo (`UPDATE ... WHERE consumed_at IS NULL AND attempts < 5 RETURNING`). RLS por usuario.
 */
export interface MfaChallengesTable {
  id: Generated<string>;
  user_id: string;
  attempts: Generated<number>;
  remember_device: Generated<boolean>;
  created_at: Timestamp;
  expires_at: RequiredTimestamp;
  consumed_at: Timestamp | null;
}

/**
 * 0055: "recordar este equipo". Sólo el sha256 hex (64 caracteres en minúscula, lo exige la base)
 * del token, que vive en la cookie `st_trusted`. Válido si no está revocado ni vencido y
 * `created_at` es posterior a `users.password_changed_at` y a `users.mfa_enabled_at`. RLS por
 * usuario; "quitar" es revocar, la app no borra.
 */
export interface TrustedDevicesTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  created_at: Timestamp;
  last_used_at: Timestamp;
  expires_at: RequiredTimestamp;
  revoked_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
}

/**
 * 0055: `jti` de tokens firmados de un solo uso ya canjeados (el de liberar un puesto). Consumir es
 * `INSERT ... ON CONFLICT (jti) DO NOTHING RETURNING jti`: 0 filas = ya se usó. Sin RLS; la app
 * sólo inserta y lee.
 */
export interface ConsumedTokensTable {
  jti: string;
  purpose: string;
  consumed_at: Timestamp;
  expires_at: RequiredTimestamp;
}

export interface MfaRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  requested_ip: string | null;
  created_at: Generated<Timestamp>;
}

export interface UserInvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  revoked_at: Timestamp | null;
  // Timestamp (no Generated<Timestamp>): sigue siendo opcional al insertar y el SELECT
  // devuelve Date en vez de un ColumnType anidado. Ver SessionsTable.
  created_at: Timestamp;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: Role;
  status: Generated<MembershipStatus>;
  invited_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AirportsTable {
  code: string;
  name: string;
  city: string;
  country_code: string | null;
  country_name: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  updated_at: Generated<Timestamp>;
}

/**
 * `pg` devuelve NUMERIC como string (no hay type parser registrado) para no perder precisión.
 * Tiparlo como `number` dejaría compilar `a.score + b.score`, que en ejecución concatena.
 */
type Numeric = ColumnType<string, number | string, number | string>;

/**
 * Catálogo de hoteles por proveedor (ciudad→IDs). Cross-tenant; lo escribe el job de sync y la
 * app sólo lo lee (0041 le quitó la escritura que 0001 daba por defecto a toda tabla nueva).
 */
export interface HotelInventoryTable {
  provider_code: string;
  hotel_id: string;
  /** Id de ciudad de Despegar. Los demás proveedores usan `provider_city_code`. */
  city_id: number | null;
  country_code: string | null;
  name: string | null;
  /** NUMERIC(2,1): llega como `'4.5'`, no como `4.5`. */
  stars: Numeric | null;
  property_type: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  zipcode: string | null;
  merged_ids: unknown;
  synced_at: Generated<Timestamp>;
  /** 0041: código de ciudad en el espacio de ids del propio proveedor. NULL en Despegar. */
  provider_city_code: string | null;
  /** 0041: baja lógica. La búsqueda sólo usa activos; el inactivo se conserva para vouchers. */
  active: Generated<boolean>;
  /** 0041: inicio de la última corrida que vio el hotel. NULL si el catálogo se reemplaza entero. */
  last_seen_at: Timestamp | null;
}

/** 0041: ciudades de cada proveedor y checkpoint del sync. Cross-tenant; la app sólo lee. */
export interface HotelProviderCityTable {
  provider_code: string;
  provider_city_code: string;
  country_code: string;
  name: string;
  /** Minúsculas, sin acentos ni puntuación. Lo calcula el sync, no la base. */
  name_norm: string;
  hotel_count: number | null;
  /** Mediana de las coordenadas de sus hoteles activos. */
  centroid_lat: number | null;
  centroid_lng: number | null;
  synced_at: Timestamp | null;
  last_status_code: number | null;
}

export type HotelDestinationMapMethod = 'overlap' | 'centroid' | 'manual';
export type HotelDestinationMapStatus = 'accepted' | 'ambiguous' | 'rejected';

/** 0041: destino de la UI → ciudades de otro proveedor. Sólo `accepted` se usa para vender. */
export interface HotelDestinationMapTable {
  source_provider_code: string;
  source_city_id: string;
  target_provider_code: string;
  target_city_code: string;
  method: HotelDestinationMapMethod;
  score: Numeric | null;
  status: HotelDestinationMapStatus;
  computed_at: Generated<Timestamp>;
}

export type HotelMatchMethod = 'heuristic' | 'manual' | 'giata';
export type HotelMatchStatus = 'accepted' | 'review' | 'rejected';

/** 0041: el mismo hotel en varios proveedores comparte `canonical_hotel_id`. */
export interface HotelMatchTable {
  canonical_hotel_id: string;
  provider_code: string;
  hotel_id: string;
  method: HotelMatchMethod;
  score: Numeric | null;
  status: HotelMatchStatus;
  computed_at: Generated<Timestamp>;
}

/** Qué llamada del proveedor produjo el contenido: `details` gana sobre `listing`. */
export type HotelContentSource = 'details' | 'listing';

/** 0041: contenido de hotel por proveedor e idioma. */
export interface HotelContentTable {
  provider_code: string;
  hotel_id: string;
  lang: LanguageCode;
  name: string | null;
  /** Saneado con lista blanca al ingerir. */
  description_html: string | null;
  /** `[{ label, text }]`. */
  sections: unknown;
  /** `string[]`. */
  facilities: unknown;
  attractions_html: string | null;
  /** `string[]` de URLs: se enlazan, no se copian. */
  images: unknown;
  phone: string | null;
  website_url: string | null;
  /** TIME: `pg` lo devuelve como `'HH:MM:SS'`. */
  check_in_time: string | null;
  check_out_time: string | null;
  source: HotelContentSource;
  content_hash: string;
  fetched_at: Generated<Timestamp>;
}

/** 0041: contenido por habitación. `room_id` nunca es `'0'` (centinela de "sin mapeo"). */
export interface HotelRoomContentTable {
  provider_code: string;
  hotel_id: string;
  room_id: string;
  lang: LanguageCode;
  name: string | null;
  size_text: string | null;
  description: string | null;
  images: unknown;
  fetched_at: Generated<Timestamp>;
}

export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'expired' | 'cancelled';
export type OrderStatus = 'pending' | 'confirmed' | 'ticketed' | 'cancelled' | 'failed';

export interface QuotationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  status: Generated<QuotationStatus>;
  search_criteria: unknown;
  selected_offer: unknown;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  notes: string | null;
  quote_number: number;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrdersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  quotation_id: string | null;
  provider: string;
  provider_order_id: string | null;
  status: Generated<OrderStatus>;
  search_criteria: unknown;
  selected_offer: unknown;
  passengers: unknown;
  contact_info: unknown;
  total_amount: number;
  currency: string;
  order_number: number;
  provider_raw: unknown;
  error_message: string | null;
  create_request_key: string | null;
  /**
   * 0042: referencia de reserva que generamos y mandamos al proveedor. Se escribe con el intent,
   * antes de llamar, y es única por proveedor ENTRE tenants (no sólo dentro del tenant).
   */
  provider_booking_ref: string | null;
  /** 0042: cuenta BYOC con la que se creó la reserva; la post-venta usa esta, no la vigente. */
  provider_account_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/*
 * 0042: vocabularios cerrados de `hotel_order_tracking`. Son valores y no sólo tipos porque los
 * CHECK de la migración tienen que decir lo mismo, y un test los compara con el SQL.
 */
export const HOTEL_ORDER_SUB_STATUSES = [
  'create-pending',
  'create-uncertain',
  'create-not-found-yet',
  'cancel-requested',
  'cancel-unverified',
  'unverified-read',
  'unknown',
] as const;
export type HotelOrderSubStatus = (typeof HOTEL_ORDER_SUB_STATUSES)[number];

export const PROVIDER_STATUS_SOURCES = [
  'book',
  'verify',
  'retrieve',
  'cancel',
  'hcn',
  'reconciliation',
] as const;
export type ProviderStatusSource = (typeof PROVIDER_STATUS_SOURCES)[number];

export const HCN_STATES = ['out-of-window', 'scheduled', 'received', 'missing', 'stopped'] as const;
export type HcnState = (typeof HCN_STATES)[number];

export const HCN_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P4+', 'P5'] as const;
export type HcnPriority = (typeof HCN_PRIORITIES)[number];

/**
 * 0042: seguimiento de una orden de hotel, una fila por orden. Con tenant_id y RLS forzada, y
 * `(order_id, tenant_id)` apunta a `(id, tenant_id)` de `orders`: no puede colgar de una orden
 * de otro tenant. Es la fuente de verdad de los jobs de post-venta. Sin PII.
 */
export interface HotelOrderTrackingTable {
  order_id: string;
  tenant_id: string;
  /** Crudo, sin normalizar ni CHECK: un valor desconocido se guarda con `sub_status = 'unknown'`. */
  provider_status: string | null;
  /** Booleano o texto según el proveedor; se guarda como texto. */
  provider_voucher_status: string | null;
  /** Va junto con `provider_status_source`: los dos o ninguno. */
  provider_status_at: Timestamp | null;
  provider_status_source: ProviderStatusSource | null;
  /** NULL = el estado crudo alcanza para describir la orden. */
  sub_status: HotelOrderSubStatus | null;
  refund_awaited: Generated<boolean>;
  invoice_number: string | null;
  client_reference_id: string | null;
  /** Nunca en blanco: "sin HCN" es NULL. */
  hcn: string | null;
  hcn_received_at: Timestamp | null;
  hcn_state: HcnState | null;
  hcn_priority: HcnPriority | null;
  /** Sólo en `out-of-window` y `scheduled`; el barrido despierta las vencidas. */
  hcn_next_check_at: Timestamp | null;
  hcn_attempts: Generated<number>;
  /**
   * 0044: calendario de verificación de una reserva sin respuesta. El ancla y el paso van juntos;
   * `verify_next_at` sólo existe con calendario y es lo que despierta el barrido.
   */
  verify_anchor_at: Timestamp | null;
  /** Índice del PRÓXIMO paso; sólo avanza. */
  verify_step: number | null;
  verify_next_at: Timestamp | null;
  /**
   * 0046: calendario de la lectura que verifica una cancelación aceptada sin terminar o sin
   * respuesta. Mismas reglas que el de 0044, en columnas propias.
   */
  cancel_verify_anchor_at: Timestamp | null;
  cancel_verify_step: number | null;
  cancel_verify_next_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CustomersTable {
  id: Generated<string>;
  tenant_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  document_type: string;
  // PII: el número va cifrado en document_number_enc + blind index en _hash.
  // La columna plana queda nullable (legacy/fallback); las filas nuevas la dejan NULL.
  document_number: string | null;
  document_number_enc: Buffer | null;
  document_number_hash: string | null;
  document_issuing_country: string;
  birthdate: ColumnType<Date, Date | string, Date | string>;
  gender: string;
  nationality: string;
  passport_expiry: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  preferences: Generated<unknown>;
  frequent_flyer_program: Generated<unknown>;
  travel_preferences: Generated<unknown>;
  tags: Generated<string[]>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CustomerPassengersTable {
  id: Generated<string>;
  customer_id: string;
  relationship: string;
  first_name: string;
  last_name: string;
  document_type: string;
  document_number: string;
  document_issuing_country: string;
  birthdate: ColumnType<Date, Date | string, Date | string>;
  gender: string;
  nationality: string;
  passport_expiry: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CustomerDocumentsVaultTable {
  id: Generated<string>;
  customer_id: string;
  document_category: string;
  document_number: string | null;
  issue_date: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  expiry_date: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  file_url: string | null;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export type CrmOpportunityStage =
  | 'AI_HANDLING'
  | 'LEAD_UNASSIGNED'
  | 'QUALIFIED_LEAD'
  | 'QUOTE_SENT'
  | 'NEGOTIATION'
  | 'BOOKING_CONFIRMED'
  | 'IN_TRAVEL'
  | 'POST_TRAVEL_COMPLETED'
  | 'CLOSED_LOST';

export interface CrmOpportunitiesTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  assigned_user_id: string | null;
  stage: Generated<CrmOpportunityStage>;
  title: string;
  estimated_value_minor: Generated<number>;
  currency: Generated<string>;
  destination_city: string | null;
  travel_start_date: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  travel_end_date: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  pax_count: Generated<number>;
  package_quotation_id: string | null;
  order_id: string | null;
  source_channel: Generated<string>;
  is_ai_controlled: Generated<boolean>;
  lost_reason: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CrmInteractionsTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  opportunity_id: string | null;
  channel: string;
  direction: string;
  summary: string;
  payload: Generated<unknown>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export type PortfolioStatus = 'active' | 'suspended' | 'overlimit';

/**
 * Carteras B2B (0010). Desde 0052, una por (tenant, moneda): la moneda es obligatoria y no cambia
 * (STW01 `portfolio_identity_immutable`). El cupo y el estado —y abrir una cartera con cupo o
 * saldo— los escribe sólo quien financia al nodo (`can_finance_tenant`), con `app.current_user_id`
 * del que actúa: sin él la base responde 42501 `portfolio_financier_required`. `app_user` no la
 * borra (se llevaría su libro y su deuda).
 */
export interface AgencyPortfoliosTable {
  id: Generated<string>;
  tenant_id: string;
  /** Unidades menores de `currency`, entre 0 y 2^53 − 1. */
  credit_limit_minor: Generated<number>;
  balance_minor: Generated<number>;
  /** ISO 4217 en mayúsculas. Sin default desde 0052. */
  currency: string;
  status: Generated<PortfolioStatus>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * El libro de la cartera. Desde 0052 es de sólo agregar para `app_user` (sin UPDATE ni DELETE), y un
 * `DEPOSIT_PAYMENT` o un `MANUAL_ADJUSTMENT` exige ser quien financia al dueño de la cartera, va
 * firmado por el que actúa (`created_by` = `app.current_user_id`, si no 42501
 * `portfolio_entry_author`) y su `created_at` lo pone la base.
 */
export interface PortfolioTransactionsTable {
  id: Generated<string>;
  portfolio_id: string;
  amount_minor: number;
  transaction_type: string;
  reference_id: string | null;
  idempotency_key: Generated<string | null>;
  notes: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
}

export type DepositReportStatus = 'pending' | 'approved' | 'rejected';

/**
 * Depósitos que informa una agencia (0052). Nacen `pending` (los informa la agencia con
 * `app.current_tenant_id` = su tenant y `reported_by` = `app.current_user_id`) y quien financia al
 * nodo los pasa UNA vez a `approved` —enlazando el `DEPOSIT_PAYMENT` de esa cartera por ese monto— o
 * a `rejected` con motivo. `reported_at` y `resolved_at` los fija la base, y cada paso deja su
 * `domain_event` (`portfolio.deposit_report.submitted | approved | rejected`) desde un trigger: la
 * API no escribe otro. Nadie los borra desde la aplicación.
 */
export interface PortfolioDepositReportsTable {
  id: Generated<string>;
  tenant_id: string;
  portfolio_id: string;
  /** Unidades menores, entre 1 y 2^53 − 1. */
  amount_minor: number;
  /** La de la cartera (FK compuesta a agency_portfolios). */
  currency: string;
  /** Referencia de la transferencia o consignación, hasta 100 caracteres. */
  reference: string;
  deposited_on: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Comentario de la agencia, hasta 500 caracteres. No va a los domain_events. */
  notes: string | null;
  status: Generated<DepositReportStatus>;
  idempotency_key: string | null;
  reported_by: string;
  reported_at: Generated<Timestamp>;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
  /** Obligatorio al rechazar; hasta 500 caracteres. */
  resolution_reason: string | null;
  portfolio_transaction_id: string | null;
  updated_at: Generated<Timestamp>;
}

export type NonRefundableRatesPermission = 'allowed' | 'blocked';

/**
 * Permisos de reserva de un nodo (0055) que fija QUIEN LO FINANCIA (`can_finance_tenant`, 0052): por
 * ahora, si puede reservar tarifas no reembolsables. Sin fila rige `allowed`. Un `blocked` rige
 * también para todo lo que cuelga del nodo (`non_refundable_rates_block`). `updated_by` tiene que ser
 * `app.current_user_id` (42501 `booking_permissions_author`) y `updated_at` lo pone la base. `app_user`
 * no la borra.
 */
export interface TenantBookingPermissionsTable {
  tenant_id: string;
  non_refundable_rates: Generated<NonRefundableRatesPermission>;
  updated_by: string;
  /** La pone la base (trigger de 0055): se puede omitir al insertar. */
  updated_at: Timestamp;
}

export interface MarkupRulesTable {
  id: Generated<string>;
  tenant_id: string;
  vertical: string;
  rule_type: string;
  value_minor: number;
  priority: Generated<number>;
  conditions: Generated<unknown>;
  status: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PackageQuotationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  status: Generated<string>;
  title: string;
  total_amount_minor: Generated<number>;
  currency: string;
  customer_id: string | null;
  global_markup_minor: Generated<number>;
  notes: string | null;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PackageItemsTable {
  id: Generated<string>;
  package_id: string;
  vertical: string;
  provider_name: string;
  provider_item_id: string;
  raw_details: unknown;
  base_fare_minor: number;
  taxes_minor: number;
  markup_minor: number;
  total_minor: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * `hcn-check`, `hcn-ticket` y `reconcile` (0042) son de la post-venta de hotel. En la base
 * `type` es TEXT sin CHECK (0021): sumar uno no necesita migración.
 */
export type OrderOperationType =
  | 'cancel'
  | 'pay'
  | 'reshop'
  | 'retrieve'
  | 'hcn-check'
  | 'hcn-ticket'
  | 'reconcile';
export type OrderOperationStatus = 'pending' | 'success' | 'failed';

export interface OrderOperationsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  type: OrderOperationType;
  status: Generated<OrderOperationStatus>;
  attempts: Generated<number>;
  last_error: string | null;
  result: Generated<unknown>;
  actor_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/*
 * 0047: vocabularios cerrados de la conciliación. Valores y no sólo tipos porque los CHECK de la
 * migración tienen que decir lo mismo, y un test los compara con el SQL.
 */
export const RECONCILIATION_RUN_TRIGGERS = ['scheduled', 'sweep', 'forced'] as const;
export type ReconciliationRunTrigger = (typeof RECONCILIATION_RUN_TRIGGERS)[number];

export const RECONCILIATION_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'invalid',
  'abandoned',
] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const RECONCILIATION_ITEM_ACTIONS = [
  'recovered',
  'cancelled',
  'cancellation-verifying',
  'failed',
  'reported',
  'recorded',
  'review',
] as const;
export type ReconciliationItemAction = (typeof RECONCILIATION_ITEM_ACTIONS)[number];

/**
 * 0047: una corrida de la conciliación de UNA cuenta de proveedor. Del dueño de la cuenta, con RLS
 * forzada. Una sola `running` por cuenta (índice único parcial).
 */
export interface ProviderReconciliationRunsTable {
  id: Generated<string>;
  tenant_id: string;
  account_id: string;
  provider_code: string;
  trigger: ReconciliationRunTrigger;
  requested_by: string | null;
  status: Generated<ReconciliationRunStatus>;
  windows: Generated<unknown>;
  rows_read: Generated<number>;
  rows_matched: Generated<number>;
  discrepancies: Generated<number>;
  summary: Generated<unknown>;
  error_class: string | null;
  started_at: Generated<Timestamp>;
  finished_at: Timestamp | null;
}

/**
 * 0047: una divergencia R1-R8. Del tenant de la orden o, en R2 y R6, del dueño de la cuenta.
 * Append-only para `app_user`; única por `(account_id, dedupe_key)`.
 */
export interface ProviderReconciliationItemsTable {
  id: Generated<string>;
  tenant_id: string;
  run_id: string;
  account_id: string;
  provider_code: string;
  kind: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';
  severity: 'info' | 'warning' | 'critical';
  action: ReconciliationItemAction;
  order_id: string | null;
  provider_booking_id: string | null;
  dedupe_key: string;
  details: Generated<unknown>;
  created_at: Generated<Timestamp>;
}

/**
 * 0048: ajuste del superadmin sobre un proveedor. `tenant_id` NULL = global; con valor, vale para
 * ese tenant y su red. Lectura abierta para el servidor; sólo escribe un superadmin (RLS).
 */
export interface ProviderEnablementTable {
  id: Generated<string>;
  provider_code: string;
  tenant_id: string | null;
  enabled: boolean;
  reason: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DomainEventsTable {
  id: Generated<string>;
  occurred_at: Generated<Timestamp>;
  tenant_id: string | null;
  actor_user_id: string | null;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Generated<unknown>;
  meta: Generated<unknown>;
}

/**
 * 0043: vocabulario de `provider_payloads.environment`. Valor y no sólo tipo porque el CHECK de la
 * migración tiene que decir lo mismo, y un test los compara.
 */
export const PROVIDER_PAYLOAD_ENVIRONMENTS = ['test', 'live'] as const;
export type ProviderPayloadEnvironment = (typeof PROVIDER_PAYLOAD_ENVIRONMENTS)[number];

/**
 * 0043: bóveda de RQ/RS completos de proveedor. Los cuerpos llegan cifrados desde la app; la base
 * no ve ninguno en claro. Sin UPDATE ni DELETE para `app_user`: se borra sólo con
 * `purge_expired_provider_payloads`. La lectura la acota `can_read_provider_payloads`.
 */
export interface ProviderPayloadsTable {
  id: Generated<string>;
  provider_code: string;
  request_id: string;
  attempt: number;
  operation: string;
  environment: ProviderPayloadEnvironment;
  owner_tenant_id: string;
  provider_account_id: string | null;
  account_ref: string | null;
  tenant_id: string | null;
  /** Sin FK: la fila se escribe en segundo plano, fuera de la transacción de la orden. */
  order_id: string | null;
  sent_at: Timestamp;
  duration_ms: number;
  /** 0 = no llegó una respuesta completa. */
  http_status: number;
  provider_status_code: number | null;
  outcome: string;
  key_id: string;
  /** Tamaño del cuerpo original; NULL = no hubo cuerpo. */
  request_bytes: number | null;
  /** NULL con `request_bytes` = no se guardó por su tamaño. */
  request_enc: Buffer | null;
  response_bytes: number | null;
  response_enc: Buffer | null;
  /** A lo sumo 90 días después de `created_at` (CHECK de la migración). */
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface DB {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  mfa_challenges: MfaChallengesTable;
  trusted_devices: TrustedDevicesTable;
  consumed_tokens: ConsumedTokensTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_invitations: UserInvitationsTable;
  search_logs: SearchLogsTable;
  crm_tasks: CrmTasksTable;
  provider_accounts: ProviderAccountsTable;
  domain_events: DomainEventsTable;
  provider_payloads: ProviderPayloadsTable;
  airports: AirportsTable;
  hotel_inventory: HotelInventoryTable;
  hotel_provider_city: HotelProviderCityTable;
  hotel_destination_map: HotelDestinationMapTable;
  hotel_match: HotelMatchTable;
  hotel_content: HotelContentTable;
  hotel_room_content: HotelRoomContentTable;
  quotations: QuotationsTable;
  orders: OrdersTable;
  order_operations: OrderOperationsTable;
  hotel_order_tracking: HotelOrderTrackingTable;
  provider_reconciliation_runs: ProviderReconciliationRunsTable;
  provider_reconciliation_items: ProviderReconciliationItemsTable;
  provider_enablement: ProviderEnablementTable;
  customers: CustomersTable;
  customer_passengers: CustomerPassengersTable;
  customer_documents_vault: CustomerDocumentsVaultTable;
  crm_opportunities: CrmOpportunitiesTable;
  crm_interactions: CrmInteractionsTable;
  agency_portfolios: AgencyPortfoliosTable;
  portfolio_transactions: PortfolioTransactionsTable;
  portfolio_deposit_reports: PortfolioDepositReportsTable;
  tenant_booking_permissions: TenantBookingPermissionsTable;
  markup_rules: MarkupRulesTable;
  package_quotations: PackageQuotationsTable;
  package_items: PackageItemsTable;
}
