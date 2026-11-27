import { expect, test } from '@playwright/test';
import { como, nodo, type Respuesta } from './support/cliente';

/**
 * Validaciones del servidor que el inventario encontró sueltas (docs/qa/01 §6). Ninguna de estas
 * pruebas llega a un proveedor ni deja datos: todas esperan un 400 de validación.
 *
 * Las de pasajeros usan `POST /orders` con una oferta inválida a propósito: Zod junta TODOS los
 * errores del cuerpo, así que la respuesta dice qué campos de los pasajeros rechazó el servidor sin
 * que la reserva llegue a armarse.
 */

type ErrorZod = { fields?: { field: string; message: string }[] };
const campos = (r: Respuesta<ErrorZod>) => (r.body?.fields ?? []).map((f) => f.field);

function enDias(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
}

const BUSQUEDA = (paxCount: Record<string, number>) => ({
  origin: 'BOG',
  destination: 'MDE',
  departureDate: enDias(40),
  paxCount,
  currency: 'COP',
});

test('VUE-06 la API no acepta más de 9 pasajeros en total (QA-H-12)', async () => {
  const api = await como('vendedorA');
  const r = await api.post<ErrorZod>('/orders', {
    offer: {},
    searchCriteria: BUSQUEDA({ adults: 9, children: 9, infants: 0 }),
    passengers: [{}],
    contactInfo: {},
  });
  expect(r.status).toBe(400);
  expect(campos(r), 'debería rechazar searchCriteria.paxCount con 18 pasajeros').toContain(
    'searchCriteria.paxCount',
  );
});

test('CHK-09 el servidor valida cada pasajero de vuelo (QA-H-13)', async () => {
  const api = await como('vendedorA');
  const r = await api.post<ErrorZod>('/orders', {
    offer: {},
    searchCriteria: BUSQUEDA({ adults: 1, children: 1, infants: 0 }),
    passengers: [
      {
        paxId: 'p1',
        paxType: 'ADT',
        givenName: 'J0hn<script>',
        surname: '',
        birthdate: '2099-01-01',
        gender: 'X',
        citizenshipCountryCode: 'ZZ',
        identityDoc: { type: 'P', number: '1', issuingCountryCode: 'ZZ', expiryDate: '2001-01-01' },
      },
      {
        paxId: 'p2',
        paxType: 'CHD',
        givenName: 'Ana',
        surname: 'PRUEBA',
        // 40 años: no es un niño.
        birthdate: `${new Date().getUTCFullYear() - 40}-01-01`,
        gender: 'F',
        citizenshipCountryCode: 'CO',
        identityDoc: { type: 'CC', number: '1234567', issuingCountryCode: 'CO' },
      },
    ],
    contactInfo: {},
  });
  expect(r.status).toBe(400);
  const f = campos(r);
  const esperados = [
    'passengers.0.givenName',
    'passengers.0.surname',
    'passengers.0.birthdate',
    'passengers.0.gender',
    'passengers.0.citizenshipCountryCode',
    'passengers.0.identityDoc.number',
    'passengers.0.identityDoc.issuingCountryCode',
    'passengers.0.identityDoc.expiryDate',
    // La edad contra el tipo (el pasajero 2 tiene 40 años y va como CHD) depende de la fecha del
    // viaje: la revisa OrdersService después de Zod, con una oferta válida. Se prueba en la Ola 4,
    // con proveedores falsos (INF-4).
  ];
  const faltan = esperados.filter((e) => !f.includes(e));
  expect(faltan, `el servidor no rechazó: ${faltan.join(', ')} (rechazó: ${f.join(', ')})`).toEqual(
    [],
  );
});

test('RED-09 reglas de pricing validadas con 400, sin truncar (QA-H-10)', async () => {
  const api = await como('adminA');
  const tenantId = await nodo('e2e-agencia-a');
  const casos: [string, Record<string, unknown>][] = [
    ['ruleType inválido', { tenantId, vertical: 'all', ruleType: 'bogus', valueMinor: 500 }],
    ['valor negativo', { tenantId, vertical: 'all', ruleType: 'percentage', valueMinor: -500 }],
    ['valor cero', { tenantId, vertical: 'all', ruleType: 'fixed', valueMinor: 0 }],
    [
      'porcentaje sobre 100 %',
      { tenantId, vertical: 'all', ruleType: 'percentage', valueMinor: 20_000 },
    ],
    ['vertical inventada', { tenantId, vertical: 'cruceros', ruleType: 'fixed', valueMinor: 500 }],
    ['tenantId no UUID', { tenantId: 'x', vertical: 'all', ruleType: 'fixed', valueMinor: 500 }],
  ];
  type Reglas = { rules?: { id: string }[] };
  const antes = new Set(
    ((await api.get<Reglas>(`/pricing/rules?tenantId=${tenantId}`)).body?.rules ?? []).map(
      (r) => r.id,
    ),
  );
  const malas: string[] = [];
  try {
    for (const [nombre, body] of casos) {
      const r = await api.post('/pricing/rules', body);
      if (r.status !== 400) malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 100)}`);
    }
    const w = await api.post('/pricing/waterfall', { tenantId, vertical: 'all', netMinor: -100 });
    if (w.status !== 400) malas.push(`waterfall con neto negativo → ${w.status}`);
  } finally {
    // Si el servidor aceptó alguna regla basura, se borra: cambiaría el precio de las ventas @real.
    const despues =
      (await api.get<Reglas>(`/pricing/rules?tenantId=${tenantId}`)).body?.rules ?? [];
    for (const r of despues.filter((x) => !antes.has(x.id)))
      await api.delete(`/pricing/rules/${r.id}?tenantId=${tenantId}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});
