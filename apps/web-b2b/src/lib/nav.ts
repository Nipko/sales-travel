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

export const mainNav: NavItem[] = [
  { label: 'Inicio', href: '/', icon: Home },
  { label: 'Cotizaciones', href: '/cotizaciones', icon: Ticket },
  { label: 'Reservas', href: '/reservas', icon: Calendar },
  { label: 'Clientes', href: '/clientes', icon: Users },
  { label: 'Reportes', href: '/reportes', icon: BarChart3 },
];

export const settingsNav: NavItem[] = [
  { label: 'Configuracion', href: '/configuracion', icon: Settings },
];

export const adminNav: NavItem[] = [
  { label: 'Tenants', href: '/admin/tenants', icon: Building2 },
  { label: 'Usuarios', href: '/admin/usuarios', icon: Shield },
];
