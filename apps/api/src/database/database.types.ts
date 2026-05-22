import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type TenantStatus = 'active' | 'suspended' | 'archived';
export type UserStatus = 'active' | 'suspended';
export type MembershipStatus = 'active' | 'suspended' | 'invited';
export type LanguageCode = 'es' | 'pt' | 'en';
export type Role = 'superadmin' | 'tenant_admin' | 'admin' | 'vendedor' | 'cliente_final';

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  country_code: string;
  default_currency: string;
  default_language: Generated<LanguageCode>;
  status: Generated<TenantStatus>;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
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
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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
  document_number: string;
  document_issuing_country: string;
  birthdate: ColumnType<Date, Date | string, Date | string>;
  gender: string;
  nationality: string;
  passport_expiry: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  preferences: Generated<unknown>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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

export interface DB {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  airports: AirportsTable;
  quotations: QuotationsTable;
  orders: OrdersTable;
  customers: CustomersTable;
  agency_portfolios: AgencyPortfoliosTable;
  portfolio_transactions: PortfolioTransactionsTable;
  markup_rules: MarkupRulesTable;
  package_quotations: PackageQuotationsTable;
  package_items: PackageItemsTable;
}
