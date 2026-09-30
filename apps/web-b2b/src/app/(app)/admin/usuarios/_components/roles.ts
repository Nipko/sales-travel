/** Cómo se muestra cada rol en Equipo. */
export const ROLE_CONFIG: Readonly<Record<string, { label: string; className: string }>> = {
  superadmin: { label: 'Superadmin', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  platform_admin: {
    label: 'Plataforma',
    className: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  consolidator_admin: {
    label: 'Consolidador',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  tenant_admin: { label: 'Admin', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  agency_admin: { label: 'Admin agencia', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  admin: { label: 'Manager', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  vendedor: { label: 'Vendedor', className: 'bg-teal-50 text-teal-700 border-teal-200' },
  cliente_final: {
    label: 'Cliente',
    className:
      'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border-[var(--color-border)]',
  },
};

export function roleLabel(role: string): string {
  return ROLE_CONFIG[role]?.label ?? role;
}

/**
 * Roles que se pueden invitar o asignar. Espejo de ASSIGNABLE_ROLES en el backend, con lo que
 * puede hacer cada uno dicho en una línea para quien invita.
 */
export const INVITABLE_ROLES: readonly {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}[] = [
  { value: 'vendedor', label: 'Vendedor', hint: 'Busca, cotiza y reserva para sus clientes.' },
  {
    value: 'admin',
    label: 'Manager',
    hint: 'Vende y además gestiona al equipo y las reservas del nodo.',
  },
  {
    value: 'agency_admin',
    label: 'Admin de agencia',
    hint: 'Administra la agencia: equipo, precios y credenciales propias.',
  },
  {
    value: 'tenant_admin',
    label: 'Admin',
    hint: 'Administra el nodo y su red. Se le exige verificación en dos pasos.',
  },
  {
    value: 'cliente_final',
    label: 'Cliente',
    hint: 'Sólo ve sus propias reservas; no entra al panel de gestión.',
  },
];
