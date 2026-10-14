import { describe, expect, it } from 'vitest';
import {
  CERT_RUN_MAX_PNRS,
  CERT_SCENARIOS,
  CertPlanError,
  buildCertPlan,
  describeCertPlan,
  type CertPlanInput,
} from './plan.js';

const BASE: CertPlanInput = {
  scenarios: ['auth'],
  allowMoney: false,
  routes: ['BOG-LIM', 'LIM-GRU', 'BOG-MIA'],
  pax: '1ADT',
  days: 30,
};

function problems(input: Partial<CertPlanInput>): readonly string[] {
  try {
    buildCertPlan({ ...BASE, ...input });
  } catch (e) {
    if (e instanceof CertPlanError) return e.problems;
    throw e;
  }
  throw new Error('se esperaba que el plan se rechazara');
}

describe('buildCertPlan — qué corre y en qué orden', () => {
  it('los atajos por paquete se expanden, sin repetir y en el orden del catálogo', () => {
    const plan = buildCertPlan({ ...BASE, scenarios: ['book-cancel', 'sab-12', 'auth'] });
    expect(plan.scenarios.map((s) => s.id)).toEqual(['auth', 'shop', 'book-cancel']);
    expect(plan.pnrs).toBe(1);
    expect(plan.operations).toEqual([]);
    expect(plan.bookRoute).toEqual({ origin: 'BOG', destination: 'LIM' });
  });

  it('las operaciones del proceso son la unión de lo que piden los escenarios, ordenada', () => {
    const plan = buildCertPlan({
      ...BASE,
      scenarios: ['sab-21'],
      allowMoney: true,
    });
    expect(plan.operations).toEqual(['issue', 'seats', 'services', 'void']);
    expect(plan.pnrs).toBe(2);
  });

  it('sab-25 corrige los datos de los pasajeros con `modify` encendido y sin mover dinero', () => {
    const plan = buildCertPlan({ ...BASE, scenarios: ['sab-25'] });
    expect(plan.scenarios.map((s) => s.id)).toEqual(['book-modify']);
    expect(plan.operations).toEqual(['modify']);
    expect(plan.pnrs).toBe(1);
    expect(plan.allowMoney).toBe(false);
  });

  it('la ruta de reservas puede ser otra que la primera de búsqueda', () => {
    const plan = buildCertPlan({ ...BASE, bookRoute: 'lim-gru' });
    expect(plan.bookRoute).toEqual({ origin: 'LIM', destination: 'GRU' });
  });

  it('pasajeros con niños e infante', () => {
    expect(buildCertPlan({ ...BASE, pax: '2ADT1CHD1INF' }).pax).toEqual({
      adults: 2,
      children: 1,
      infants: 1,
    });
  });
});

describe('buildCertPlan — lo que mueve dinero', () => {
  it.each([['book-issue-void'], ['ancillaries'], ['book-issue-refund'], ['sab-13'], ['sab-24']])(
    '%s sin --allow-money no se arma',
    (scenario) => {
      const [motivo] = problems({ scenarios: [scenario] });
      expect(motivo).toMatch(/mueven? dinero en CERT/);
      expect(motivo).toContain('--allow-money');
    },
  );

  it('con --allow-money sí, y los pasos que mueven dinero vienen marcados', () => {
    const plan = buildCertPlan({ ...BASE, scenarios: ['sab-13'], allowMoney: true });
    expect(plan.allowMoney).toBe(true);
    const texto = describeCertPlan(plan).join('\n');
    expect(texto).toContain('$ fulfillFlightTickets');
    expect(texto).toContain('$ cancelBooking VOID');
    expect(texto).toContain('PERMITIDO (--allow-money)');
  });

  it('cada escenario que emite, anula, reembolsa o cobra un EMD está marcado como dinero', () => {
    const conDinero = Object.values(CERT_SCENARIOS).filter((s) =>
      s.steps.some((step) => step.startsWith('$')),
    );
    expect(conDinero.every((s) => s.money)).toBe(true);
    expect(Object.values(CERT_SCENARIOS).filter((s) => s.money)).toHaveLength(conDinero.length);
  });
});

describe('buildCertPlan — topes y errores, todos de una vez', () => {
  it(`no más de ${String(CERT_RUN_MAX_PNRS)} PNR por corrida`, () => {
    const motivos = problems({
      scenarios: ['book-cancel', 'book-with-seat', 'book-issue-void', 'ancillaries'],
      allowMoney: true,
    });
    expect(motivos).toEqual([
      `la corrida crearía 4 PNR y el tope es ${String(CERT_RUN_MAX_PNRS)}: pártela en dos`,
    ]);
  });

  it('dice todo lo que está mal junto', () => {
    const motivos = problems({
      scenarios: ['nope'],
      routes: ['BOGLIM'],
      pax: '3INF',
      days: 0,
    });
    expect(motivos).toHaveLength(4);
    expect(motivos.join(' | ')).toMatch(/escenario desconocido "nope"/);
  });

  it('sin escenarios, sin ruta o con ida y vuelta fuera de la ventana', () => {
    expect(problems({ scenarios: [] })[0]).toMatch(/no se pidió ningún escenario/);
    expect(problems({ routes: [] })).toContain('falta al menos una ruta');
    expect(problems({ routes: ['BOG-BOG'] })[0]).toMatch(/mismo origen y destino/);
    expect(problems({ days: 300, returnDays: 40 })[0]).toMatch(/--return-days/);
  });

  it('un infante viaja en brazos de un adulto y no hay más pasajeros de prueba que los que hay', () => {
    expect(problems({ pax: '1ADT0CHD2INF' }).join(' ')).toMatch(/en brazos/);
    expect(problems({ pax: '5ADT' }).join(' ')).toMatch(/como mucho 4 adultos/);
  });
});
