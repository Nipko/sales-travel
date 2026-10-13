import { describe, expect, it } from 'vitest';
import {
  IMPACT_UNAVAILABLE,
  heldLabel,
  lastSaleLabel,
  nodeDepositsHref,
  nodeReasonError,
  parseNodeImpact,
  parseNodeStatsList,
  pendingDepositsLabel,
  reactivateCopy,
  seatsCell,
  statusDoneToast,
  suspendCopy,
  type NodeImpact,
} from './platform-node-stats';
import { voseoIn } from './voseo';

const NODE = 'AAAAAAAA-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-10-13T15:00:00.000Z');

function statsPayload(extra: Record<string, unknown> = {}) {
  return {
    tenantId: NODE,
    seatLimit: 5,
    seatsUsed: 3,
    liveSessions: 3,
    activeUsers: 4,
    orders30d: 12,
    lastOrderAt: '2026-10-10T15:00:00.000Z',
    openOrders: 2,
    pendingDepositReports: 1,
    pendingInvitations: 0,
    held: [{ currency: 'COP', exponent: 2, amountMinor: 150_000 }],
    ...extra,
  };
}

function impact(extra: Partial<NodeImpact> = {}): NodeImpact {
  return {
    tenant: {
      id: NODE.toLowerCase(),
      name: 'Agencia Norte',
      tenantType: 'agency',
      isBranch: false,
      status: 'active',
    },
    descendants: 2,
    activeUsers: 7,
    liveSessions: 3,
    openOrders: 4,
    held: [],
    pendingDepositReports: 0,
    pendingInvitations: 0,
    ...extra,
  };
}

describe('parseNodeStatsList: GET /admin/tenants/stats', () => {
  it('lee cada nodo por id, en minúsculas', () => {
    const byId = parseNodeStatsList({ nodes: [statsPayload()] });
    expect(byId?.get(NODE.toLowerCase())).toEqual({
      ...statsPayload(),
      tenantId: NODE.toLowerCase(),
    });
  });

  it('sin cupo propio y sin ventas: null en los dos', () => {
    const byId = parseNodeStatsList({
      nodes: [statsPayload({ seatLimit: null, seatsUsed: null, lastOrderAt: null, held: [] })],
    });
    expect(byId?.get(NODE.toLowerCase())).toMatchObject({
      seatLimit: null,
      seatsUsed: null,
      lastOrderAt: null,
    });
  });

  it('una fila ilegible se descarta y el resto se lee', () => {
    const byId = parseNodeStatsList({
      nodes: [
        statsPayload({ tenantId: OTHER }),
        statsPayload({ orders30d: '12' }),
        statsPayload({ held: [{ currency: 'pesos', amountMinor: 1 }] }),
        statsPayload({ seatLimit: -1 }),
        statsPayload({ lastOrderAt: 7 }),
        { tenantId: 'x' },
      ],
    });
    expect([...(byId?.keys() ?? [])]).toEqual([OTHER]);
  });

  it('una moneda sin exponente conocido va con null', () => {
    const byId = parseNodeStatsList({
      nodes: [statsPayload({ held: [{ currency: 'XXY', exponent: null, amountMinor: 5 }] })],
    });
    expect(byId?.get(NODE.toLowerCase())?.held).toEqual([
      { currency: 'XXY', exponent: null, amountMinor: 5 },
    ]);
  });

  it('una forma inesperada es un error, no una red sin números', () => {
    expect(parseNodeStatsList([statsPayload()])).toBeUndefined();
    expect(parseNodeStatsList({ nodes: 'x' })).toBeUndefined();
    expect(parseNodeStatsList(null)).toBeUndefined();
  });
});

describe('parseNodeImpact: GET /admin/tenants/:id/impact', () => {
  it('lee el nodo y los números de su red', () => {
    const payload = { ...impact(), tenant: { ...impact().tenant, id: NODE } };
    expect(parseNodeImpact(payload)).toEqual(impact());
  });

  it('lo incompleto no se lee', () => {
    expect(parseNodeImpact({ ...impact(), descendants: -1 })).toBeUndefined();
    expect(parseNodeImpact({ ...impact(), held: 'COP 10' })).toBeUndefined();
    expect(parseNodeImpact({ ...impact(), tenant: { id: NODE } })).toBeUndefined();
    expect(
      parseNodeImpact({ ...impact(), tenant: { ...impact().tenant, status: 1 } }),
    ).toBeUndefined();
    expect(parseNodeImpact({ ...impact(), tenant: null })).toBeUndefined();
    expect(parseNodeImpact(undefined)).toBeUndefined();
  });
});

describe('la fila de la red', () => {
  it('puestos: "3/5" neutro; al 90 % o más, ámbar y "al límite" (como el Resumen)', () => {
    expect(seatsCell({ seatLimit: 5, seatsUsed: 3 })).toEqual({
      text: '3/5',
      tone: 'neutral',
      note: null,
      label: '3 de 5 puestos en uso',
    });
    // Con 5 puestos, el 90 % redondeado hacia arriba es 5.
    expect(seatsCell({ seatLimit: 5, seatsUsed: 4 })?.tone).toBe('neutral');
    expect(seatsCell({ seatLimit: 5, seatsUsed: 5 })).toEqual({
      text: '5/5',
      tone: 'warning',
      note: 'al límite',
      label: '5 de 5 puestos en uso, al límite',
    });
    expect(seatsCell({ seatLimit: 10, seatsUsed: 9 })?.tone).toBe('warning');
    expect(seatsCell({ seatLimit: 10, seatsUsed: 8 })?.tone).toBe('neutral');
    // Sobre el cupo (se bajó con sesiones abiertas): sigue al límite.
    expect(seatsCell({ seatLimit: 2, seatsUsed: 3 })?.tone).toBe('warning');
    expect(seatsCell({ seatLimit: 1, seatsUsed: 0 })?.label).toBe('0 de 1 puesto en uso');
  });

  it('sin cupo propio no hay celda: comparte el de su red', () => {
    expect(seatsCell({ seatLimit: null, seatsUsed: null })).toBeNull();
    expect(seatsCell({ seatLimit: 0, seatsUsed: 0 })).toBeNull();
  });

  it('la última venta, relativa; sin ventas, "Nunca"', () => {
    expect(lastSaleLabel('2026-10-10T15:00:00.000Z', NOW)).toBe('hace 3 días');
    expect(lastSaleLabel('2026-10-13T14:59:30.000Z', NOW)).toBe('hace un momento');
    expect(lastSaleLabel(null, NOW)).toBe('Nunca');
    expect(lastSaleLabel('no es una fecha', NOW)).toBe('Nunca');
  });

  it('los depósitos por aprobar, en singular y plural; sin ninguno, nada', () => {
    expect(pendingDepositsLabel(1)).toBe('1 depósito por aprobar');
    expect(pendingDepositsLabel(3)).toBe('3 depósitos por aprobar');
    expect(pendingDepositsLabel(0)).toBeNull();
  });

  it('el enlace de los depósitos abre Carteras acotada al nodo (?nodo=)', () => {
    expect(nodeDepositsHref(NODE)).toBe(`/admin/plataforma/carteras?nodo=${NODE.toLowerCase()}`);
  });
});

describe('el motivo', () => {
  it('suspender lo exige; reactivar lo admite vacío', () => {
    expect(nodeReasonError('', true)).toBe(
      'Escribe el motivo de la suspensión: queda en la auditoría.',
    );
    expect(nodeReasonError('   ', true)).toBeDefined();
    expect(nodeReasonError('', false)).toBeUndefined();
    expect(nodeReasonError('Deuda vencida', true)).toBeUndefined();
  });

  it('entre 5 y 500 caracteres, sin caracteres de control, recortado', () => {
    expect(nodeReasonError('  no  ', true)).toBe('Escribe al menos 5 caracteres.');
    expect(nodeReasonError('no', false)).toBe('Escribe al menos 5 caracteres.');
    expect(nodeReasonError('x'.repeat(501), true)).toBe(
      'El motivo puede tener hasta 500 caracteres.',
    );
    expect(nodeReasonError('Deuda\u0000 vencida', true)).toBe(
      'El motivo tiene caracteres no válidos.',
    );
    expect(nodeReasonError('Deuda\nvencida\tcon Planetour', true)).toBeUndefined();
  });
});

describe('suspendCopy: lo que se corta, con números', () => {
  it('el texto completo, en tú', () => {
    const copy = suspendCopy('Agencia Norte', impact());
    expect(copy).toMatchObject({
      title: 'Suspender Agencia Norte',
      confirmLabel: 'Suspender Agencia Norte',
      destructive: true,
      reasonRequired: true,
      details: [],
    });
    expect(copy.body).toBe(
      'Se corta de inmediato el acceso a Agencia Norte y a los 2 nodos que cuelgan de él: 7 personas dejan de poder operar y sus 3 sesiones abiertas dejan de funcionar. Las 4 reservas vigentes no se cancelan, pero nadie del nodo podrá gestionarlas mientras siga suspendido.',
    );
    expect(voseoIn(copy.body)).toEqual([]);
  });

  it('en singular', () => {
    expect(
      suspendCopy(
        'Norte',
        impact({ descendants: 1, activeUsers: 1, liveSessions: 1, openOrders: 1 }),
      ).body,
    ).toBe(
      'Se corta de inmediato el acceso a Norte y al nodo que cuelga de él: 1 persona deja de poder operar y su sesión abierta deja de funcionar. La reserva vigente no se cancela, pero nadie del nodo podrá gestionarla mientras siga suspendido.',
    );
  });

  it('una hoja sin personas, sesiones ni reservas', () => {
    expect(
      suspendCopy(
        'Norte',
        impact({ descendants: 0, activeUsers: 0, liveSessions: 2, openOrders: 0 }),
      ).body,
    ).toBe(
      'Se corta de inmediato el acceso a Norte: no hay personas con acceso activo. No tiene reservas vigentes.',
    );
  });

  it('el saldo retenido por moneda y los depósitos por aprobar, aparte', () => {
    const copy = suspendCopy(
      'Norte',
      impact({
        held: [
          { currency: 'COP', exponent: 2, amountMinor: 150_000 },
          { currency: 'USD', exponent: 2, amountMinor: 2_050 },
        ],
        pendingDepositReports: 2,
      }),
    );
    expect(copy.details).toHaveLength(2);
    expect(copy.details[0]).toMatch(/^Saldo retenido: .*1\.500.* · .*20,50.*\.$/);
    expect(copy.details[1]).toBe('Depósitos por aprobar: 2.');
  });

  it('sin el impacto, el mismo corte sin números', () => {
    const copy = suspendCopy('Norte', null);
    expect(copy.body).not.toMatch(/\d/);
    expect(copy.body).toMatch(/^Se corta de inmediato el acceso a Norte/);
    expect(copy.details).toEqual([]);
    expect(IMPACT_UNAVAILABLE).toBe('No pudimos calcular el impacto.');
  });
});

describe('reactivateCopy', () => {
  it('vuelven a ingresar; el motivo es opcional y el botón no es de peligro', () => {
    expect(reactivateCopy('Norte', null)).toEqual({
      title: 'Reactivar Norte',
      body: 'Vuelven a poder ingresar las personas con acceso activo a Norte y a su red.',
      details: [],
      confirmLabel: 'Reactivar',
      pendingLabel: 'Reactivando…',
      destructive: false,
      reasonRequired: false,
    });
  });

  it('con un ancestro suspendido, lo dice antes', () => {
    expect(reactivateCopy('Norte', 'Consolidador Andes').body).toBe(
      'Norte queda activo, pero nadie de su red podrá operar mientras Consolidador Andes siga suspendido.',
    );
  });
});

describe('textos sueltos', () => {
  it('el saldo retenido no suma monedas', () => {
    expect(
      heldLabel([
        { currency: 'COP', exponent: 2, amountMinor: 100 },
        { currency: 'USD', exponent: 2, amountMinor: 100 },
      ]).split(' · '),
    ).toHaveLength(2);
    expect(heldLabel([])).toBe('');
  });

  it('el aviso al terminar', () => {
    expect(statusDoneToast('Norte', 'suspended')).toBe('Norte quedó suspendido.');
    expect(statusDoneToast('Norte', 'active')).toBe('Norte quedó activo.');
  });
});
