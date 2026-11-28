'use client';

import { ArrowLeft, Check, Copy, FileDown, Loader2, MessageCircle, Printer } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';
import { updatePackageAction } from '../actions';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  expired: 'Vencida',
};

/** La barra del vendedor sobre la cotización. No se imprime: el cliente ve sólo el documento. */
export function QuoteActions({
  packageId,
  status,
  shownStatus,
  showBreakdown,
  whatsappText,
}: {
  packageId: string;
  status: string;
  /** El estado a mostrar (vencida incluida); `status` es el guardado y decide las acciones. */
  shownStatus: string;
  showBreakdown: boolean;
  whatsappText: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();

  function patch(change: Parameters<typeof updatePackageAction>[1]) {
    setError(undefined);
    startTransition(async () => {
      const res = await updatePackageAction(packageId, change);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  function sendWhatsapp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(whatsappText)}`, '_blank', 'noopener');
    if (status === 'draft') patch({ status: 'sent' });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(whatsappText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('No pudimos copiar el texto. Selecciónalo a mano.');
    }
  }

  return (
    <div className="mx-auto mb-4 w-full max-w-3xl space-y-3 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/paquetes/guardados">
            <ArrowLeft /> Paquetes
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium',
              shownStatus === 'accepted'
                ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                : shownStatus === 'sent'
                  ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                  : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
            )}
          >
            {STATUS_LABEL[shownStatus] ?? shownStatus}
          </span>
          {status !== 'accepted' ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => patch({ status: 'accepted' })}
            >
              <Check /> Marcar aceptada
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-xs)]">
        <Button
          type="button"
          size="sm"
          onClick={sendWhatsapp}
          className="bg-[#1fa855] hover:bg-[#178f47]"
        >
          <MessageCircle /> Enviar por WhatsApp
        </Button>
        <Button asChild variant="secondary" size="sm">
          <a href={`/api/packages/${packageId}/pdf`} target="_blank" rel="noopener">
            <FileDown /> PDF
          </a>
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => window.print()}>
          <Printer /> Imprimir
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar texto'}
        </Button>
        <label className="ml-auto flex cursor-pointer items-center gap-2 px-2 text-xs text-[var(--color-fg-muted)]">
          {pending ? <Loader2 className="size-3 animate-spin" /> : null}
          <input
            type="checkbox"
            checked={showBreakdown}
            disabled={pending}
            onChange={(e) => patch({ showBreakdown: e.target.checked })}
            className="size-4 accent-[var(--color-primary)]"
          />
          Mostrar precio por servicio
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
