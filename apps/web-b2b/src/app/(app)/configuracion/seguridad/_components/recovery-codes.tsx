'use client';

import { Check, Copy, Download, KeyRound, Loader2, Printer } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../../../components/ui/button';
import { Checkbox } from '../../../../../components/ui/field';
import { localTimestamp, recoveryCodesFilename, recoveryCodesText } from './security-format';

/** Por qué se muestran: cambia el título y si se aclara que los anteriores dejaron de servir. */
export type RecoveryCodesReason = 'enabled' | 'rotated' | 'regenerated';

const TITLE: Record<RecoveryCodesReason, string> = {
  enabled: 'Verificación en dos pasos activada',
  rotated: 'Tu teléfono nuevo quedó configurado',
  regenerated: 'Generamos códigos de recuperación nuevos',
};

export const PRINT_ROOT_ID = 'st-recovery-codes-print';

/**
 * Al imprimir se ocultan TODOS los hijos del `<body>` salvo la hoja de códigos, que se monta como
 * hijo directo (portal). Ocultar por `display` y a nivel del body no deja páginas en blanco ni
 * depende de cómo esté armado el panel alrededor; y como la regla vive mientras los códigos están
 * en pantalla, también un Ctrl+P imprime sólo los códigos.
 */
const PRINT_CSS = `#${PRINT_ROOT_ID}{display:none}
@media print{
  body>*:not(#${PRINT_ROOT_ID}){display:none!important}
  #${PRINT_ROOT_ID}{display:block!important;color:#000;background:#fff;font:12pt/1.5 system-ui,sans-serif;padding:0 8mm}
  #${PRINT_ROOT_ID} h1{font-size:16pt;margin:0 0 4pt}
  #${PRINT_ROOT_ID} ol{columns:2;column-gap:12mm;margin:12pt 0;padding-left:24pt;font:14pt/2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
}`;

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Los códigos de recuperación recién generados. Se muestran una sola vez: por eso "Listo" no se
 * habilita hasta marcar que se guardaron, y se ofrecen tres formas de guardarlos (copiar,
 * descargar, imprimir) que no dependen de ningún servicio externo.
 */
export function RecoveryCodes({
  codes,
  reason,
  email,
  onDone,
  finishing = false,
}: {
  codes: readonly string[];
  reason: RecoveryCodesReason;
  email?: string;
  onDone: () => void;
  /** "Listo" ya se apretó y se está refrescando la pantalla. */
  finishing?: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  const [portalReady, setPortalReady] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const baseId = useId();
  const savedId = `${baseId}-saved`;
  const doneHintId = `${baseId}-done-hint`;
  // La hora se fija al mostrar los códigos, no en cada descarga: el .txt y la hoja impresa dicen lo mismo.
  const [generatedAt] = useState(() => new Date());

  // Quien usa teclado o lector de pantalla llega directo a lo nuevo, en vez de quedar en el botón
  // que acaba de desaparecer.
  useEffect(() => {
    headingRef.current?.focus();
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 2500);
    return () => clearTimeout(timer);
  }, [copy]);

  const text = recoveryCodesText(codes, { email, generatedAt });

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  function download(): void {
    // Blob local: los códigos no pasan por ningún servidor para bajarlos.
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = recoveryCodesFilename(email);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section aria-labelledby={`${baseId}-title`} className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-success)]/15 text-[var(--color-success)]"
        >
          <Check className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h3
            id={`${baseId}-title`}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold text-[var(--color-fg)] outline-none"
          >
            {TITLE[reason]}
          </h3>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Guardá estos códigos de recuperación. Cada uno sirve una sola vez para entrar si perdés
            o cambiás el teléfono.{' '}
            <strong className="font-semibold text-[var(--color-fg)]">
              No los vamos a volver a mostrar.
            </strong>
            {reason === 'enabled' ? null : ' Los códigos anteriores dejaron de servir.'}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] p-3 sm:p-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-fg-muted)]">
          <KeyRound className="size-3.5" aria-hidden="true" />
          {codes.length} códigos de recuperación
        </p>
        <ol
          aria-label="Códigos de recuperación"
          // 14 px en el teléfono para que entren dos columnas; nunca se parte un código en el guion.
          className="grid grid-cols-1 gap-x-6 gap-y-1.5 font-mono text-sm tabular-nums text-[var(--color-fg)] min-[340px]:grid-cols-2 sm:text-base"
        >
          {codes.map((code, i) => (
            <li key={`${i}-${code}`} className="flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className="w-5 text-right text-xs text-[var(--color-fg-subtle)]"
              >
                {i + 1}.
              </span>
              <span className="select-all whitespace-nowrap tracking-wide">{code}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" variant="secondary" onClick={copyAll} className="h-11 sm:h-9">
          {copy === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copy === 'copied' ? 'Copiados' : 'Copiar todos'}
        </Button>
        <Button type="button" variant="secondary" onClick={download} className="h-11 sm:h-9">
          <Download aria-hidden="true" />
          Descargar .txt
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => window.print()}
          className="h-11 sm:h-9"
        >
          <Printer aria-hidden="true" />
          Imprimir
        </Button>
      </div>
      {/* El anuncio para lector de pantalla vive siempre en el DOM; a la vista, el botón ya dice
          "Copiados", y sólo el fallo necesita un texto aparte. */}
      <p aria-live="polite" className="sr-only">
        {copy === 'copied' ? 'Copiamos los códigos al portapapeles.' : ''}
      </p>
      {copy === 'failed' ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          No pudimos copiar. Seleccioná los códigos y copialos a mano, o descargalos.
        </p>
      ) : null}

      <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <label
          htmlFor={savedId}
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-[var(--color-fg)] sm:min-h-0"
        >
          <Checkbox
            id={savedId}
            checked={saved}
            onChange={(e) => setSaved(e.currentTarget.checked)}
            className="size-5 sm:size-4"
          />
          Los guardé en un lugar seguro
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            onClick={onDone}
            disabled={!saved || finishing}
            aria-describedby={saved ? undefined : doneHintId}
            className="h-11 sm:h-9"
          >
            {finishing ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Listo
          </Button>
          {saved ? null : (
            <p id={doneHintId} className="text-xs text-[var(--color-fg-muted)]">
              Marcá la casilla cuando los tengas guardados.
            </p>
          )}
        </div>
      </div>

      {portalReady
        ? createPortal(
            <div id={PRINT_ROOT_ID} aria-hidden="true">
              <style>{PRINT_CSS}</style>
              <h1>Códigos de recuperación</h1>
              {email ? <p>Cuenta: {email}</p> : null}
              <p>Generados: {localTimestamp(generatedAt)}</p>
              <p>
                Cada código sirve una sola vez para entrar si no tenés tu teléfono. Si generás
                códigos nuevos, estos dejan de servir.
              </p>
              <ol>
                {codes.map((code, i) => (
                  <li key={`${i}-${code}`}>{code}</li>
                ))}
              </ol>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
