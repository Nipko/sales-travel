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
  Settings,
  Shield,
  Ticket,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';

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
];
