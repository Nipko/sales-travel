import { BarChart3, Calendar, Home, Settings, Ticket, Users, type LucideIcon } from 'lucide-react';
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
  { label: 'Configuración', href: '/configuracion', icon: Settings },
];
