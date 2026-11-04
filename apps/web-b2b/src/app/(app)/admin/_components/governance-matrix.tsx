'use client';

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { cn } from '../../../../lib/cn';
import {
  cellLabel,
  groupCatalog,
  PCI_LABELS,
  PCI_OUT_OF_SCOPE_WARNING,
  type CellChoice,
  type GovernanceItemKey,
  type GovernedPaymentMethod,
  type GovernedProvider,
} from '../../../../lib/governance';
import type { EnablementChoice } from '../../../../lib/provider-enablement';
import { ChoiceControl } from './provider-enablement-ui';

/*
 * La matriz proveedores × formas de pago del gobierno, con un control de tres posiciones por celda.
 * La usan el editor de perfiles («No decide»), las reglas globales y las reglas a mano de un nodo
 * («Hereda»): la misma lectura desde los tres lados.
 */

const TO_ENABLEMENT: Readonly<Record<CellChoice, EnablementChoice>> = {
  unset: 'inherit',
  on: 'enabled',
  off: 'disabled',
};

const FROM_ENABLEMENT: Readonly<Record<EnablementChoice, CellChoice>> = {
  inherit: 'unset',
  enabled: 'on',
  disabled: 'off',
};

export interface MatrixLabels {
  /** La posición «sin decisión»: «No decide» en un perfil, «Hereda» en una regla. */
  readonly unset: string;
  readonly on?: string;
  readonly off?: string;
}

function choicesFor(labels: MatrixLabels): { value: EnablementChoice; label: string }[] {
  return [
    { value: 'inherit', label: labels.unset },
    { value: 'enabled', label: labels.on ?? 'Encendido' },
    { value: 'disabled', label: labels.off ?? 'Apagado' },
  ];
}

export function PciBadge({ method }: { method: Pick<GovernedPaymentMethod, 'pci'> }) {
  if (method.pci === 'out-of-scope') {
    return (
      <Badge variant="warning">
        <AlertTriangle aria-hidden="true" />
        {PCI_LABELS['out-of-scope']}
      </Badge>
    );
  }
  return (
    <Badge>
      {method.pci === 'saq-a' ? <ShieldCheck aria-hidden="true" /> : null}
      {PCI_LABELS[method.pci]}
    </Badge>
  );
}

/** El aviso de una forma de pago que saca a la plataforma de SAQ-A: siempre a la vista. */
export function PciWarning({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/12 px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-fg)]',
        className,
      )}
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-px size-3.5 shrink-0 text-[var(--color-fg-muted)]"
      />
      {PCI_OUT_OF_SCOPE_WARNING}
    </p>
  );
}

export function GovernanceMatrix({
  catalog,
  choiceAt,
  onChange,
  labels,
  scopeLabel,
  disabled,
  extra,
}: {
  catalog: readonly GovernedProvider[];
  choiceAt: (key: GovernanceItemKey) => CellChoice;
  onChange: (key: GovernanceItemKey, choice: CellChoice) => void;
  labels: MatrixLabels;
  /** Para los lectores de pantalla: «en el perfil», «para toda la plataforma», «en Agencia Sur». */
  scopeLabel: string;
  disabled?: boolean;
  /** Algo más bajo cada celda (en un nodo: el estado efectivo y su origen). */
  extra?: (key: GovernanceItemKey) => ReactNode;
}) {
  const choices = choicesFor(labels);
  if (catalog.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
        El catálogo no tiene proveedores gobernados.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {groupCatalog(catalog).map((group) => (
        <section key={group.vertical} aria-label={group.label}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
            {group.label}
          </h3>
          <ul className="space-y-3">
            {group.providers.map((provider) => {
              const providerKey = { provider: provider.code, method: '' };
              const providerOff = choiceAt(providerKey) === 'off';
              return (
                <li
                  key={provider.code}
                  className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
                >
                  <CellRow
                    title={provider.label}
                    code={provider.code}
                    strong
                    value={choiceAt(providerKey)}
                    legend={`${provider.label} ${scopeLabel}`}
                    choices={choices}
                    disabled={disabled}
                    onChange={(c) => onChange(providerKey, c)}
                    extra={extra?.(providerKey)}
                  />
                  {provider.paymentMethods.length === 0 ? (
                    <p className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-3 py-2 text-[11px] text-[var(--color-fg-muted)] sm:px-4">
                      Sin formas de pago elegibles: se gobierna sólo el proveedor.
                    </p>
                  ) : (
                    <div
                      className={cn(
                        'border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40',
                        providerOff && 'opacity-60',
                      )}
                    >
                      {providerOff ? (
                        <p className="px-3 pt-2 text-[11px] text-[var(--color-fg-muted)] sm:px-4">
                          Con el proveedor apagado, sus formas de pago no habilitan nada.
                        </p>
                      ) : null}
                      <ul className="divide-y divide-[var(--color-border)]">
                        {provider.paymentMethods.map((method) => {
                          const key = { provider: provider.code, method: method.code };
                          return (
                            <li key={method.code} className="pl-3 sm:pl-6">
                              <CellRow
                                title={method.label}
                                description={method.description}
                                badge={<PciBadge method={method} />}
                                warning={method.pci === 'out-of-scope' ? <PciWarning /> : null}
                                value={choiceAt(key)}
                                legend={`${cellLabel(catalog, key)} ${scopeLabel}`}
                                choices={choices}
                                disabled={disabled}
                                onChange={(c) => onChange(key, c)}
                                extra={extra?.(key)}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CellRow({
  title,
  code,
  description,
  badge,
  warning,
  strong,
  value,
  legend,
  choices,
  disabled,
  onChange,
  extra,
}: {
  title: string;
  code?: string;
  description?: string;
  badge?: ReactNode;
  warning?: ReactNode;
  strong?: boolean;
  value: CellChoice;
  legend: string;
  choices: readonly { value: EnablementChoice; label: string }[];
  disabled?: boolean;
  onChange: (choice: CellChoice) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                'text-sm text-[var(--color-fg)]',
                strong ? 'font-semibold' : 'font-medium',
              )}
            >
              {title}
            </span>
            {code ? (
              <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-px font-mono text-[11px] text-[var(--color-fg-muted)]">
                {code}
              </code>
            ) : null}
            {badge}
          </p>
          {description ? (
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{description}</p>
          ) : null}
        </div>
        <ChoiceControl
          legend={legend}
          value={TO_ENABLEMENT[value]}
          onChange={(c) => onChange(FROM_ENABLEMENT[c])}
          disabled={disabled}
          choices={choices}
          className="sm:shrink-0"
        />
      </div>
      {warning}
      {extra}
    </div>
  );
}
