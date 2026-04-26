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

export interface DB {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
}
