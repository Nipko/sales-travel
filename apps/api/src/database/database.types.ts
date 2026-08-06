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
  parent_tenant_id: string | null;
  tenant_type: Generated<TenantType>;
  path: Generated<string>;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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
  created_at: Generated<Timestamp>;
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

/** Catálogo de hoteles por proveedor (ciudad→IDs). Cross-tenant; lo escribe el job de sync. */
export interface HotelInventoryTable {
  provider_code: string;
  hotel_id: string;
  city_id: number | null;
  country_code: string | null;
  name: string | null;
  stars: number | null;
  property_type: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  zipcode: string | null;
  merged_ids: unknown;
  synced_at: Generated<Timestamp>;
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

export interface AgencyPortfoliosTable {
  id: Generated<string>;
  tenant_id: string;
  credit_limit_minor: Generated<number>;
  balance_minor: Generated<number>;
  currency: Generated<string>;
  status: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PortfolioTransactionsTable {
  id: Generated<string>;
  portfolio_id: string;
  amount_minor: number;
  transaction_type: string;
  reference_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
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

export type OrderOperationType = 'cancel' | 'pay' | 'reshop' | 'retrieve';
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

export interface DB {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_invitations: UserInvitationsTable;
  provider_accounts: ProviderAccountsTable;
  domain_events: DomainEventsTable;
  airports: AirportsTable;
  hotel_inventory: HotelInventoryTable;
  quotations: QuotationsTable;
  orders: OrdersTable;
  order_operations: OrderOperationsTable;
  customers: CustomersTable;
  customer_passengers: CustomerPassengersTable;
  customer_documents_vault: CustomerDocumentsVaultTable;
  crm_opportunities: CrmOpportunitiesTable;
  crm_interactions: CrmInteractionsTable;
  agency_portfolios: AgencyPortfoliosTable;
  portfolio_transactions: PortfolioTransactionsTable;
  markup_rules: MarkupRulesTable;
  package_quotations: PackageQuotationsTable;
  package_items: PackageItemsTable;
}
