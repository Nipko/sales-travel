import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookingPermissionsPlan,
  bookingPermissionsReply,
  loadBookingPermissions,
  parseBookingPermissions,
  reasonProblem,
  updateBookingPermissions,
} from './booking-permissions';

const NODO = '10000000-0000-4000-8000-000000000001';

const VIEW = {
  tenant: {
    id: NODO,
    name: 'Agencia Sur',
    tenantType: 'agency',
    isBranch: false,
    status: 'active',
  },
  nonRefundableRates: {
    setting: 'blocked',
    effective: 'blocked',
    inheritedBlock: false,
    updatedAt: '2026-09-29T15:00:00.000Z',
    updatedByName: 'Carla Consolidadora',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseBookingPermissions', () => {
  it('lee la vista de quien financia', () => {
    expect(parseBookingPermissions(VIEW)).toEqual({
      tenant: { id: NODO, name: 'Agencia Sur' },
      nonRefundableRates: {
        setting: 'blocked',
        effective: 'blocked',
        inheritedBlock: false,
        updatedAt: '2026-09-29T15:00:00.000Z',
        updatedByName: 'Carla Consolidadora',
      },
    });
  });

  it('sin fijar: fechas y autor nulos; una forma que no se entiende no es una vista', () => {
    expect(
      parseBookingPermissions({
        ...VIEW,
        nonRefundableRates: { setting: 'allowed', effective: 'blocked', inheritedBlock: true },
      })?.nonRefundableRates,
    ).toEqual({
      setting: 'allowed',
      effective: 'blocked',
      inheritedBlock: true,
      updatedAt: null,
      updatedByName: null,
    });
    expect(parseBookingPermissions(null)).toBeUndefined();
    expect(
      parseBookingPermissions({ ...VIEW, nonRefundableRates: { setting: 'quizás' } }),
    ).toBeUndefined();
    expect(parseBookingPermissions({ ...VIEW, tenant: { id: 1 } })).toBeUndefined();
  });
});

describe('bookingPermissionsPlan — lo que la ruta reenvía', () => {
  it('GET y PUT del nodo, con el cuerpo rearmado', () => {
    expect(bookingPermissionsPlan(NODO.toUpperCase(), 'GET', undefined)).toEqual({
      ok: true,
      path: `/tenants/${NODO}/booking-permissions`,
      method: 'GET',
    });
    expect(
      bookingPermissionsPlan(NODO, 'PUT', {
        nonRefundableRates: 'blocked',
        reason: '  Riesgo  ',
        tenantId: 'otro',
      }),
    ).toEqual({
      ok: true,
      path: `/tenants/${NODO}/booking-permissions`,
      method: 'PUT',
      body: { nonRefundableRates: 'blocked', reason: 'Riesgo' },
    });
  });

  it('rechaza un nodo que no es UUID, otro método o un cuerpo incompleto', () => {
    expect(bookingPermissionsPlan('../admin', 'GET', undefined)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(bookingPermissionsPlan(NODO, 'DELETE', undefined)).toMatchObject({
      ok: false,
      status: 405,
    });
    expect(
      bookingPermissionsPlan(NODO, 'PUT', { nonRefundableRates: 'blocked', reason: 'no' }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(bookingPermissionsPlan(NODO, 'PUT', { reason: 'Riesgo alto' })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('el error del API sale con su motivo máquina', () => {
    expect(
      bookingPermissionsReply({
        kind: 'json',
        status: 403,
        body: { message: 'Sólo quien financia…', reason: 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED' },
      }),
    ).toEqual({
      status: 403,
      body: { error: 'Sólo quien financia…', reason: 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED' },
    });
  });
});

describe('reasonProblem', () => {
  it('obligatorio y acotado', () => {
    expect(reasonProblem('  a ')).toMatch(/al menos 3/);
    expect(reasonProblem('x'.repeat(501))).toMatch(/500/);
    expect(reasonProblem('Riesgo')).toBeUndefined();
  });
});

describe('las llamadas del panel', () => {
  function respuesta(status: number, body: unknown) {
    return vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  it('lee y cambia el permiso por la ruta del nodo', async () => {
    const fetchMock = respuesta(200, VIEW);
    vi.stubGlobal('fetch', fetchMock);

    const leido = await loadBookingPermissions(NODO);
    const cambiado = await updateBookingPermissions(NODO, {
      nonRefundableRates: 'blocked',
      reason: 'Riesgo',
    });

    expect(leido.ok && leido.data.nonRefundableRates.effective).toBe('blocked');
    expect(cambiado.ok).toBe(true);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(`/api/tenants/${NODO}/booking-permissions`);
    expect(calls[1]![1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ nonRefundableRates: 'blocked', reason: 'Riesgo' }),
    });
  });

  it('un 403 sin mensaje dice quién lo decide, con el motivo', async () => {
    vi.stubGlobal(
      'fetch',
      respuesta(403, { error: '', reason: 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED' }),
    );
    const res = await loadBookingPermissions(NODO);
    expect(res).toMatchObject({
      ok: false,
      status: 403,
      reason: 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED',
    });
    expect(!res.ok && res.message).toMatch(/Sólo quien financia/);
  });

  it('sin conexión o con una respuesta que no se entiende, lo dice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(await loadBookingPermissions(NODO)).toMatchObject({ ok: false, status: 0 });

    vi.stubGlobal('fetch', respuesta(200, { hola: 1 }));
    expect(await loadBookingPermissions(NODO)).toMatchObject({ ok: false, status: 200 });

    vi.stubGlobal('fetch', respuesta(500, { error: 'Falló' }));
    expect(
      await updateBookingPermissions(NODO, { nonRefundableRates: 'allowed', reason: 'Ok ok' }),
    ).toMatchObject({
      ok: false,
      message: 'Falló',
    });
  });
});
