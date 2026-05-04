import { BarChart3, Calendar, Home, Settings, Ticket, Users, type LucideIcon } from 'lucide-react';
import type { Route } from 'next';

export interface NavItem {
  label: string;
  href: Route;
  icon: LucideIcon;
}

export const mainNav: NavItem[] = [
  { label: 'Inicio', href: '/' as Route, icon: Home },
  { label: 'Cotizaciones', href: '/cotizaciones' as Route, icon: Ticket },
  { label: 'Reservas', href: '/reservas' as Route, icon: Calendar },
  { label: 'Clientes', href: '/clientes' as Route, icon: Users },
  { label: 'Reportes', href: '/reportes' as Route, icon: BarChart3 },
];

export const settingsNav: NavItem[] = [
  { label: 'Configuración', href: '/configuracion' as Route, icon: Settings },
];
