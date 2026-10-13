'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readJson } from '../../../lib/read-json';
import type { OrderOperationView } from './cancel-retry-policy';
import {
  ISSUE_POLL_EVERY_MS,
  issuePollDecision,
  type IssuePollDecision,
  type TrackedIssue,
} from './issue-ticket-view';

/** Cómo terminó el seguimiento de una emisión: su desenlace, o el plazo de la pantalla vencido. */
export type IssueSettlement = Exclude<IssuePollDecision, { kind: 'keep' }>;

async function readOperations(orderId: string): Promise<OrderOperationView[] | null> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/operations`);
    const read = await readJson<{ operations?: OrderOperationView[] }>(res);
    if (!read.ok || !res.ok || !Array.isArray(read.data.operations)) return null;
    return read.data.operations;
  } catch {
    return null;
  }
}

/**
 * Sigue desde Reservas las emisiones pedidas en esta pestaña: lee el historial de cada una cada 5 s
 * hasta su desenlace o hasta 2 minutos, y avisa una vez con `onSettled`. Vive en la página y no en
 * el diálogo para que el vendedor pueda cerrarlo y seguir trabajando.
 *
 * Una vuelta del sondeo no se solapa con la siguiente, y una lectura que falla no corta el
 * seguimiento: el plazo de 2 minutos corre igual.
 */
export function useIssueTracker(onSettled: (orderId: string, settlement: IssueSettlement) => void) {
  const [tracked, setTracked] = useState<Readonly<Record<string, TrackedIssue>>>({});
  const onSettledRef = useRef(onSettled);
  const polling = useRef(false);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const track = useCallback((orderId: string, operationId: string) => {
    setTracked((prev) => ({ ...prev, [orderId]: { operationId, startedAt: Date.now() } }));
  }, []);

  const entries = Object.entries(tracked);
  const active = entries.length > 0;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void (async () => {
        try {
          for (const [orderId, issue] of Object.entries(tracked)) {
            const decision = issuePollDecision(issue, Date.now(), await readOperations(orderId));
            if (decision.kind === 'keep') continue;
            setTracked((prev) => {
              if (prev[orderId]?.operationId !== issue.operationId) return prev;
              const next = { ...prev };
              delete next[orderId];
              return next;
            });
            onSettledRef.current(orderId, decision);
          }
        } finally {
          polling.current = false;
        }
      })();
    }, ISSUE_POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, tracked]);

  return { tracked, track };
}
