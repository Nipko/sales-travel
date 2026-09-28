import { isSearchToken } from '../_components/hotel-search-handoff';
import { HotelCheckout } from './_components/hotel-checkout';

/**
 * Checkout de hotel, paso 1 (PR-6.3): la tarifa elegida se revalida con el proveedor (PreBook) y
 * se muestran el precio final, el aviso si cambió, la política de cancelación y las condiciones
 * del hotel. La tarifa elegida queda en este navegador; la URL lleva sólo su identificador.
 */
export default async function HotelCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ tarifa?: string | string[] }>;
}) {
  const { tarifa } = await searchParams;
  const rateToken = isSearchToken(tarifa) ? tarifa : undefined;
  // `key`: otra tarifa en la misma pestaña es otro checkout, sin arrastrar la aceptación anterior.
  return <HotelCheckout key={rateToken ?? 'sin-tarifa'} rateToken={rateToken} />;
}
