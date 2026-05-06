import {
  BarChart3,
  Building2,
  Calendar,
  Home,
  Settings,
  Shield,
  Ticket,
  Users,
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
  { label: 'Mis Reservas', href: '/reservas', icon: Calendar },
];

export const managementNav: NavItem[] = [
  { label: 'Clientes', href: '/clientes', icon: Users },
  { label: 'Reportes', href: '/reportes', icon: BarChart3 },
];

export const adminNav: NavItem[] = [
  { label: 'Mi Agencia', href: '/configuracion', icon: Settings },
  { label: 'Equipo (Usuarios)', href: '/admin/usuarios', icon: Shield },
];

export const superAdminNav: NavItem[] = [
  { label: 'Gestión de Agencias', href: '/admin/tenants', icon: Building2 },
];
