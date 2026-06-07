import {
  BarChart3,
  Building2,
  Calendar,
  Home,
  Hotel,
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
  { label: 'Mis Reservas', href: '/reservas', icon: Calendar },
];

export const managementNav: NavItem[] = [
  { label: 'Clientes', href: '/clientes', icon: Users },
  { label: 'Cartera B2B', href: '/carteras', icon: Wallet },
  { label: 'Reportes', href: '/reportes', icon: BarChart3 },
];

export const adminNav: NavItem[] = [
  { label: 'Mi Red', href: '/red', icon: Network },
  { label: 'Mi Agencia', href: '/configuracion', icon: Settings },
  { label: 'Equipo (Usuarios)', href: '/admin/usuarios', icon: Shield },
];

export const superAdminNav: NavItem[] = [
  { label: 'Gestión de Agencias', href: '/admin/tenants', icon: Building2 },
];
