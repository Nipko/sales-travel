import { describe, expect, it } from 'vitest';
import { summarizeTrip } from './search-summary';

const pax = { adults: 1, children: 0, infants: 0 };

describe('la búsqueda plegada', () => {
  it('multidestino encadena las ciudades y cuenta los tramos', () => {
    const s = summarizeTrip({
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      legs: [
        { origin: 'CTG', destination: 'MIA', departureDate: '2026-12-09' },
        { origin: 'MIA', destination: 'ORL', departureDate: '2026-12-13' },
        { origin: 'ORL', destination: 'CTG', departureDate: '2026-12-19' },
      ],
      paxCount: pax,
      cabin: 'economy',
    });
    expect(s.route).toBe('CTG → MIA → ORL → CTG');
    expect(s.when).toMatch(/3 tramos$/);
  });

  it('ida y vuelta y solo ida se distinguen', () => {
    const base = {
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      paxCount: pax,
      cabin: 'economy',
    };
    expect(summarizeTrip({ ...base, returnDate: '2026-12-19' }).route).toBe('CTG ⇄ MIA');
    expect(summarizeTrip(base).when).toMatch(/Solo ida$/);
  });
});
