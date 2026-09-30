import {
  BarChart3,
  Building2,
  Calendar,
  Car,
  FileText,
  Home,
  Hotel,
  KeyRound,
  Lock,
  MapPin,
  Network,
  Plug,
  Settings,
  Shield,
  Ticket,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';
import { navForViewer, type Viewer } from './viewer';

export interface NavItem {
  label: string;
  href: Route;
  icon: LucideIcon;
}

export const operationsNav: NavItem[] = [
  { label: 'Inicio', href: '/', icon: Home },
  { label: 'Buscar / Cotizar', href: '/cotizaciones', icon: Ticket },
  { label: 'Hoteles', href: '/hoteles', icon: Hotel },
  { label: 'Autos', href: '/autos', icon: Car },
  { label: 'Oficinas', href: '/autos/oficinas', icon: MapPin },
  { label: 'Reporte autos', href: '/autos/reporte', icon: FileText },
  { label: 'Mis Reservas', href: '/reservas', icon: Calendar },
];

export const managementNav: NavItem[] = [
  { label: 'Clientes', href: '/clientes', icon: Users },
  { label: 'Cartera B2B', href: '/carteras', icon: Wallet },
  { label: 'Reportes', href: '/reportes', icon: BarChart3 },
];

export const adminNav: NavItem[] = [
  { label: 'Mi Red', href: '/red', icon: Network },
  { label: 'Proveedores (GDS)', href: '/admin/proveedores', icon: KeyRound },
  { label: 'Mi Agencia', href: '/configuracion', icon: Settings },
  { label: 'Equipo (Usuarios)', href: '/admin/usuarios', icon: Shield },
];

/**
 * Seguridad de la propia cuenta (2FA, contraseña, dispositivos). Va aparte de adminNav
 * porque no es administración de la agencia: la usa cualquier usuario, incluido un vendedor.
 */
export const accountNav: NavItem[] = [
  { label: 'Seguridad', href: '/configuracion/seguridad', icon: Lock },
];

export const superAdminNav: NavItem[] = [
  { label: 'Gestión de Agencias', href: '/admin/tenants', icon: Building2 },
  // Fuera de `/admin/proveedores` a propósito: el sidebar marca activo por prefijo y esa ruta es
  // la de las credenciales de la agencia (adminNav).
  { label: 'Proveedores de la plataforma', href: '/admin/plataforma/proveedores', icon: Plug },
];

/** Roles que ven la sección Administración. */
const ADMIN_NAV_ROLES: readonly string[] = [
  'superadmin',
  'platform_admin',
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
];

export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Las secciones del menú que ve este usuario con el rol de la agencia activa. La misma lista para
 * el sidebar y para la paleta de comandos (⌘K): si no, una ofrecía pantallas que la otra no.
 */
export function navSections(role: string | undefined, viewer: Viewer): NavSection[] {
  const sections: NavSection[] = [
    // El superadmin no vende: sin Buscar/Cotizar, Hoteles ni Autos (lib/viewer.ts).
    { label: 'Operaciones', items: navForViewer(operationsNav, viewer) },
    { label: 'Gestión', items: managementNav },
  ];
  if (ADMIN_NAV_ROLES.includes(role ?? '')) {
    sections.push({ label: 'Administración', items: adminNav });
  }
  // La seguridad de la propia cuenta no es administración: la ve cualquiera.
  sections.push({ label: 'Mi cuenta', items: accountNav });
  if (role === 'superadmin') sections.push({ label: 'Super Admin', items: superAdminNav });
  return sections;
}
