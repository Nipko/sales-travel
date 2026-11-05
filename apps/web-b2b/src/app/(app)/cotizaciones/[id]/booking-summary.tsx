'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Loader2,
  Mail,
  MessageCircle,
  Plane,
  RefreshCw,
  Share2,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/ui/button';
import { describeBaggage } from '../../../../lib/baggage';
import { cn } from '../../../../lib/cn';
import { describePolicy, policyState } from '../../../../lib/fare-policy';
import { formatMoney } from '../../../../lib/flight-format';
import { saleBreakdown, salePerPax, type PaxSale } from '../../../../lib/sale-breakdown';
import type { Offer } from '../actions';
import type { PriceStatusLine } from './offer-price-flow';

/*
 * Las piezas del resumen del checkout: el precio desglosado, las condiciones de la tarifa, el
 * estado del precio y «Compartir cotización». El detalle de la reserva reusa el desglose y las
 * condiciones, para que lo que se vio al reservar sea lo mismo que se ve después.
 */

const PAX_NAMES: Readonly<Record<PaxSale['paxType'], readonly [string, string]>> = {
  ADT: ['Adulto', 'Adultos'],
  CHD: ['Niño', 'Niños'],
  INF: ['Infante', 'Infantes'],
};

function Row({
  label,
  value,
  strong = false,
  muted = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3',
        className,
        strong ? 'text-sm font-semibold text-[var(--color-fg)]' : 'text-xs',
        muted ? 'text-[var(--color-fg-subtle)]' : !strong && 'text-[var(--color-fg-muted)]',
      )}
    >
      <dt className="min-w-0">{label}</dt>
      <dd className="shrink-0 font-mono tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * El precio de venta desglosado: por pasajero, base, impuestos y total. El neto del proveedor no
 * se enseña nunca (ver `lib/sale-breakdown.ts`); el costo y el margen son sólo para el vendedor.
 */
export function PriceBreakdown({
  offer,
  totalLabel = 'Total',
  totalMinorOverride,
}: {
  offer: Offer;
  totalLabel?: string;
  /** El total que quedó guardado en la reserva, si difiere del de la oferta. */
  totalMinorOverride?: number;
}) {
  const venta = saleBreakdown(offer);
  const porPasajero = salePerPax(offer);
  const total = totalMinorOverride ?? venta.sellMinor;
  return (
    <dl className="space-y-1.5">
      {porPasajero.length > 0
        ? porPasajero.map((sale, index) => {
            const [uno, varios] = PAX_NAMES[sale.paxType];
            return (
              <Row
                key={`${sale.paxType}-${index}`}
                label={sale.paxCount === 1 ? uno : `${varios} × ${sale.paxCount}`}
                value={
                  <>
                    {formatMoney(sale.sellPerPaxMinor, venta.currency)}
                    {sale.paxCount > 1 ? <span className="font-sans"> c/u</span> : null}
                  </>
                }
              />
            );
          })
        : null}
      <Row label="Tarifa base" value={formatMoney(venta.baseMinor, venta.currency)} />
      <Row label="Impuestos y tasas" value={formatMoney(venta.taxesMinor, venta.currency)} />
      <Row
        label={totalLabel}
        value={formatMoney(total, venta.currency)}
        strong
        className="!mt-3 border-t border-[var(--color-border)] pt-3"
      />
      {venta.ownMarginMinor !== undefined && venta.costMinor !== undefined ? (
        <Row
          muted
          label={`Tu costo ${formatMoney(venta.costMinor, venta.currency)}`}
          value={`Margen ${formatMoney(venta.ownMarginMinor, venta.currency)}`}
        />
      ) : null}
    </dl>
  );
}

/** Equipaje, cambios y reembolso del viaje completo, en una lista de dos columnas. */
export function OfferConditions({ offer, className }: { offer: Offer; className?: string }) {
  const rows: [string, string][] = [
    ['Equipaje de mano', describeBaggage(offer.baggage?.carryOn)],
    ['Maleta facturada', describeBaggage(offer.baggage?.checked)],
    ['Cambios', describePolicy(policyState(offer.policies, 'change'), 'change', formatMoney)],
    ['Reembolso', describePolicy(policyState(offer.policies, 'refund'), 'refund', formatMoney)],
  ];
  return (
    <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs', className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--color-fg-muted)]">{label}</dt>
          <dd className="text-right font-medium text-[var(--color-fg)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * El estado del precio. Región viva siempre presente: el lector de pantalla anuncia el cambio
 * aunque la revalidación termine mientras se mira otra parte de la página.
 */
export function PriceStatus({
  line,
  onRetry,
  className,
}: {
  line: PriceStatusLine | null;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn('min-h-4 text-[11px]', className)}>
      {line ? (
        <p
          className={cn(
            'flex items-start gap-1.5',
            line.tone === 'error' && 'text-[var(--color-danger)]',
            line.tone === 'warning' && 'text-[var(--color-fg)]',
            line.tone === 'ok' && 'text-[var(--color-fg)]',
            line.tone === 'pending' && 'text-[var(--color-fg-muted)]',
          )}
        >
          {line.tone === 'pending' ? (
            <RefreshCw aria-hidden="true" className="mt-px size-3 shrink-0 animate-spin" />
          ) : line.tone === 'ok' ? (
            <CheckCircle2
              aria-hidden="true"
              className="mt-px size-3 shrink-0 text-[var(--color-success)]"
            />
          ) : null}
          <span>
            {line.text}
            {line.retry ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onRetry}
                  className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                >
                  Reintentar
                </button>
              </>
            ) : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}

const ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium text-[var(--color-fg)] outline-none transition-colors data-[highlighted]:bg-[var(--color-surface-muted)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/**
 * «Compartir cotización»: lo que antes eran cuatro botones a la vista. Compartir es secundario
 * frente a reservar, así que va en un menú; lo que no se puede hacer todavía dice por qué.
 */
export function ShareQuoteMenu({
  quoteNumber,
  emailDisabledReason,
  emailSending,
  onEmail,
  whatsappDisabledReason,
  onWhatsApp,
  copied,
  onCopyLink,
  pdfHref,
  align = 'end',
  className,
}: {
  quoteNumber: number;
  /** `undefined` = se puede enviar. */
  emailDisabledReason?: string;
  emailSending: boolean;
  onEmail: () => void;
  whatsappDisabledReason?: string;
  onWhatsApp: () => void;
  copied: boolean;
  onCopyLink: () => void;
  pdfHref: string;
  align?: 'start' | 'end';
  className?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="secondary" size="sm" className={cn('gap-1.5', className)}>
          {emailSending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : copied ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <Share2 aria-hidden="true" />
          )}
          {emailSending ? 'Enviando…' : copied ? 'Enlace copiado' : 'Compartir cotización'}
          <ChevronDown aria-hidden="true" className="!size-3.5 opacity-60" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-[260px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-[var(--color-fg-subtle)]">
            Cotización #{quoteNumber}
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className={ITEM}
            disabled={emailDisabledReason !== undefined || emailSending}
            onSelect={onEmail}
          >
            <Mail aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            <span className="min-w-0">
              Enviar por email
              {emailDisabledReason ? (
                <span className="block text-[11px] font-normal text-[var(--color-fg-subtle)]">
                  {emailDisabledReason}
                </span>
              ) : null}
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM}
            disabled={whatsappDisabledReason !== undefined}
            onSelect={onWhatsApp}
          >
            <MessageCircle aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            <span className="min-w-0">
              Enviar por WhatsApp
              {whatsappDisabledReason ? (
                <span className="block text-[11px] font-normal text-[var(--color-fg-subtle)]">
                  {whatsappDisabledReason}
                </span>
              ) : null}
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={onCopyLink}>
            <Copy aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
            Copiar enlace
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} asChild>
            <a href={pdfHref} target="_blank" rel="noopener noreferrer">
              <Download aria-hidden="true" className="size-4 text-[var(--color-fg-muted)]" />
              Descargar PDF
              <span className="sr-only"> (se abre en otra pestaña)</span>
            </a>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * En el teléfono el resumen baja a una barra fija: el total y «Reservar» siempre a mano, y el
 * desglose a un toque. En escritorio no se pinta: ahí está la columna derecha.
 */
export function MobileCheckoutBar({
  total,
  caption,
  reserveLabel,
  reserving,
  onReserve,
  children,
}: {
  total: string;
  caption: string;
  reserveLabel: string;
  reserving: boolean;
  onReserve: () => void;
  /** El resumen completo, que se despliega encima de la barra. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
      {open ? (
        <div
          id={panelId}
          className="max-h-[60vh] overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pb-3 pt-4 shadow-[var(--shadow-xl)]"
        >
          {children}
        </div>
      ) : null}
      <div className="flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-surface)]/85 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
            {caption}
            {open ? (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronUp aria-hidden="true" className="size-3.5" />
            )}
            <span className="sr-only">{open ? 'Ocultar resumen' : 'Ver resumen'}</span>
          </span>
          <span className="truncate font-mono text-lg font-bold tabular-nums text-[var(--color-fg)]">
            {total}
          </span>
        </button>
        <Button
          variant="primary"
          size="lg"
          disabled={reserving}
          onClick={onReserve}
          className="h-11 shrink-0 gap-2"
        >
          {reserving ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Plane aria-hidden="true" />
          )}
          {reserving ? 'Reservando…' : reserveLabel}
        </Button>
      </div>
    </div>
  );
}
