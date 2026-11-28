import { describe, expect, it } from 'vitest';
import {
  toActivitySnapshot,
  toPackageItemInput,
  type ActivityOffer,
} from '../../actividades/_components/activity-model';
import { asSnapshot, buildItinerary } from './package-model';

/*
 * Una actividad de Despegar dentro de un paquete: el ítem que arma la sección de Actividades se
 * lee como snapshot `activity`, aparece en el día de la actividad con su hora y NO toma la
 * ocupación del hotel.
 */

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

const OFFER: ActivityOffer = {
  choiceId: 'choice-1',
  activityId: 'TOUR_KSC',
  category: 'tour',
  name: 'Kennedy Space Center',
  modalityName: 'Con traslado',
  date: '2026-12-11',
  startAt: '2026-12-11T09:30:00-05:00',
  participants: { adults: 1, childrenAges: [9] },
  prices: [{ currency: 'USD', net: usd(9000), tax: usd(900), gross: usd(9900) }],
  price: { currency: 'USD', net: usd(9000), tax: usd(900), gross: usd(9900) },
  cancellation: { refundable: false, tiers: [], conditions: [] },
  highlights: [],
};

describe('actividad en un paquete', () => {
  it('el ítem que se guarda se vuelve a leer como snapshot `activity`', () => {
    const item = toPackageItemInput(OFFER, 'USD');
    const stored = JSON.parse(JSON.stringify(item?.rawDetails)) as unknown;
    expect(asSnapshot(stored)).toMatchObject({ kind: 'activity', title: 'Kennedy Space Center' });
  });

  it('aparece en su día, con la hora del proveedor y la modalidad', () => {
    const days = buildItinerary('2026-12-10', '2026-12-13', [toActivitySnapshot(OFFER)]);
    expect(days[1]?.events).toEqual([
      { time: '09:30', icon: 'activity', text: 'Kennedy Space Center · Con traslado' },
    ]);
    expect(days[0]?.events).toEqual([]);
  });

  it('los participantes son los de la actividad, no los del hotel', () => {
    expect(toActivitySnapshot(OFFER).participants).toEqual({ adults: 1, childrenAges: [9] });
  });
});
