'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  cellLabel,
  choiceAt,
  choicesOf,
  itemKey,
  ruleChangeDialog,
  savedRuleMessage,
  type CellChoice,
  type GovernanceItemKey,
  type GovernanceRule,
  type GovernedProvider,
} from '../../../../lib/governance';
import { saveRule } from '../../../../lib/governance-client';
import { updatedLabel } from '../../../../lib/provider-enablement';
import { GovernanceMatrix } from './governance-matrix';
import { ChangeDialog } from './provider-enablement-ui';

interface Pending {
  readonly key: GovernanceItemKey;
  readonly from: CellChoice;
  readonly to: CellChoice;
}

/**
 * Las reglas a mano de un alcance —la plataforma entera (`tenantId: null`) o un nodo— sobre la
 * matriz del catálogo. Cada cambio pasa por el diálogo del motivo y se guarda al confirmarlo:
 * una regla por llamada, como las audita el API.
 */
export function GovernanceRulesEditor({
  catalog,
  rules,
  tenantId,
  tenantName,
  unsetLabel,
  onSaved,
  extra,
}: {
  catalog: readonly GovernedProvider[];
  rules: readonly GovernanceRule[];
  tenantId: string | null;
  /** `null` = reglas globales. */
  tenantName: string | null;
  unsetLabel: string;
  /** Con las reglas del alcance como quedaron; el padre decide si relee algo más. */
  onSaved: (rules: GovernanceRule[]) => Promise<void> | void;
  extra?: (key: GovernanceItemKey) => ReactNode;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const choices = useMemo(() => choicesOf(rules), [rules]);
  const byKey = useMemo(() => new Map(rules.map((r) => [itemKey(r), r] as const)), [rules]);
  const closePending = useCallback(() => setPending(null), []);
  const scope = tenantName === null ? 'toda la plataforma' : tenantName;

  async function confirm(reason: string): Promise<string | undefined> {
    if (pending === null) return undefined;
    const { key, to } = pending;
    const res = await saveRule({
      tenantId,
      provider: key.provider,
      method: key.method,
      enabled: to === 'unset' ? null : to === 'on',
      reason,
    });
    if (!res.ok) return res.message;
    setPending(null);
    toast.success(savedRuleMessage(cellLabel(catalog, key), to, scope));
    await onSaved(res.data);
    return undefined;
  }

  const current = pending === null ? undefined : byKey.get(itemKey(pending.key));

  return (
    <>
      <GovernanceMatrix
        catalog={catalog}
        choiceAt={(key) => choiceAt(choices, key)}
        onChange={(key, to) => setPending({ key, from: choiceAt(choices, key), to })}
        labels={{ unset: unsetLabel }}
        scopeLabel={tenantName === null ? 'para toda la plataforma' : `en ${tenantName}`}
        extra={(key) => {
          const rule = byKey.get(itemKey(key));
          const more = extra?.(key);
          if (rule === undefined && more == null) return null;
          return (
            <div className="space-y-1.5">
              {more}
              {rule !== undefined ? <RuleNote rule={rule} /> : null}
            </div>
          );
        }}
      />
      {pending !== null ? (
        <ChangeDialog
          key={`${itemKey(pending.key)}-${pending.to}`}
          dialog={ruleChangeDialog({
            label: cellLabel(catalog, pending.key),
            tenantName,
            from: pending.from,
            to: pending.to,
          })}
          initialReason={
            current !== undefined && pending.to === (current.enabled ? 'on' : 'off')
              ? (current.reason ?? '')
              : ''
          }
          onConfirm={confirm}
          onClose={closePending}
        />
      ) : null}
    </>
  );
}

function RuleNote({ rule }: { rule: GovernanceRule }) {
  const updated = updatedLabel({ updatedAt: rule.updatedAt, updatedByEmail: null });
  return (
    <p className="text-[11px] text-[var(--color-fg-muted)]">
      {rule.reason ? (
        <>
          Motivo: <span className="text-[var(--color-fg)]">{rule.reason}</span>
        </>
      ) : (
        'Sin motivo'
      )}
      {updated ? <span className="text-[var(--color-fg-subtle)]"> · {updated}</span> : null}
    </p>
  );
}
