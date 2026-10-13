'use client';

import { Activity, OctagonX, Play, RotateCcw } from 'lucide-react';
import { Button } from '../../../../../../components/ui/button';
import { ToneBadge, ToneNotice } from '../../../../../../components/wallets/wallet-ui';
import { providerMetaFor } from '../../../../../../lib/provider-display';
import {
  circuitBadge,
  ENV_KILL_SWITCH_NOTICE,
  healthCounters,
  panelKillSwitchLine,
  type ProviderHealth,
} from '../../../../../../lib/provider-health';

/**
 * La salud de un proveedor en su tarjeta: si está respondiendo (el circuito de esta réplica), las
 * cuentas en pausa y los avisos de cuenta de 24 h, el apagado de emergencia vigente y de dónde sale,
 * y las palancas de un incidente. El estado va siempre en palabras: el color sólo lo refuerza.
 *
 * `health` es `undefined` mientras la primera lectura no llegó o si no se pudo leer; las palancas
 * se ofrecen igual (apagar no puede depender de que la salud cargue).
 */
export function ProviderHealthRow({
  code,
  health,
  onKill,
  onResume,
  onReset,
}: {
  code: string;
  health: ProviderHealth | undefined;
  onKill: () => void;
  onResume: () => void;
  onReset: () => void;
}) {
  const name = providerMetaFor(code).name;
  const panel = health?.killSwitch.panel ?? null;
  const env = health?.killSwitch.env ?? null;
  const badge = health === undefined ? null : circuitBadge(health.circuit);
  const counters = health === undefined ? [] : healthCounters(health);

  return (
    <div className="space-y-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]"
          aria-live="polite"
        >
          <Activity aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
          <span>Salud:</span>
          {badge === null ? (
            <span className="text-[var(--color-fg-subtle)]">Sin datos todavía</span>
          ) : (
            <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
          )}
          {counters.map((c) => (
            <span key={c} className="text-[var(--color-fg)]">
              {c}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {health?.circuit.state === 'open' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onReset}
              aria-label={`Cerrar circuito de ${name}`}
            >
              <RotateCcw aria-hidden="true" />
              Cerrar circuito
            </Button>
          ) : null}
          {panel !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onResume}
              aria-label={`Reanudar proveedor ${name}`}
            >
              <Play aria-hidden="true" />
              Reanudar proveedor
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
            onClick={onKill}
            aria-label={`Apagado de emergencia de ${name}`}
          >
            <OctagonX aria-hidden="true" />
            Apagado de emergencia
          </Button>
        </div>
      </div>

      {panel !== null ? (
        <ToneNotice tone="danger" role="status">
          <span className="font-medium">{panelKillSwitchLine(panel)}.</span> Motivo: {panel.reason}
        </ToneNotice>
      ) : null}
      {env !== null ? <ToneNotice tone="warning">{ENV_KILL_SWITCH_NOTICE}</ToneNotice> : null}
    </div>
  );
}
