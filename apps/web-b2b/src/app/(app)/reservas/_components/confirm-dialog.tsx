'use client';

import { Wallet } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Dialog } from '../../../../components/ui/dialog';

/**
 * La confirmación de una acción que no se deshace (cancelar una reserva, reintentar una
 * cancelación). Va sobre `Dialog`: foco atrapado, Escape y el fondo inerte. El foco arranca en
 * «No, volver», no en el botón que borra.
 */
export function ConfirmDialog({
  title,
  message,
  note,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  /** Un aviso aparte, debajo del mensaje (p. ej. el saldo retenido que se libera). */
  note?: string | undefined;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={() => {
        if (!loading) onClose();
      }}
      title={title}
      description={message}
      initialFocus="[data-confirm-back]"
      className="max-w-sm"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" data-confirm-back disabled={loading} onClick={onClose}>
            No, volver
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={loading}
            onClick={() => void onConfirm()}
          >
            {loading ? 'Procesando…' : confirmLabel}
          </Button>
        </div>
      }
    >
      {note ? (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)]">
          <Wallet aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}
    </Dialog>
  );
}
