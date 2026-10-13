import { ArrowRight, Users } from 'lucide-react';
import Link from 'next/link';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';

export const TEAM_CARD_TEXT =
  'Tu equipo se gestiona en Equipo (Usuarios): invitaciones, roles, accesos y seguridad.';

/**
 * La pestaña Equipo de Mi Agencia. Antes prometía un módulo "disponible próximamente" que ya existe:
 * ahora lleva a Equipo, donde se gestiona de verdad. Sólo se ofrece a los roles de administración.
 */
export function TeamCard() {
  return (
    <Card className="overflow-hidden rounded-xl border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)]">
      <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Users
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-subtle)]"
          />
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-[var(--color-fg)]">Equipo</h2>
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{TEAM_CARD_TEXT}</p>
          </div>
        </div>
        <Button asChild variant="secondary" size="sm" className="self-start sm:self-center">
          <Link href="/admin/usuarios">
            Ir a Equipo
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
