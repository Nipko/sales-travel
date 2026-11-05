import { describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from './api';
import {
  CUSTOMER_PROXY_UNREADABLE,
  CUSTOMER_SEARCH_INVALID,
  CUSTOMER_UPSERT_INVALID,
  customerSearchQuery,
  customerUpsertBody,
  proxyCustomerSearch,
  proxyCustomerUpsert,
} from './customer-search-proxy';

function llamada(reply: ApiResponse) {
  return vi.fn((_path: string, _init: RequestInit): Promise<ApiResponse> => Promise.resolve(reply));
}

function pedido(body: string): Request {
  return new Request('http://panel.test/api/customers/upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('proxyCustomerSearch', () => {
  it('rearma la consulta: término recortado y límite acotado', async () => {
    const body = { customers: [] };
    const call = llamada({ kind: 'json', status: 200, body });
    const reply = await proxyCustomerSearch(
      new URLSearchParams({ q: '  ana  ruiz ', limit: '500', extra: 'x' }),
      call,
    );
    expect(reply).toEqual({ status: 200, body });
    expect(call).toHaveBeenCalledWith('/customers/search?q=ana+ruiz&limit=25', { method: 'GET' });
  });

  it('con menos de dos letras no llega al API', async () => {
    const call = llamada({ kind: 'json', status: 200, body: {} });
    expect(await proxyCustomerSearch(new URLSearchParams({ q: 'a' }), call)).toEqual({
      status: 400,
      body: CUSTOMER_SEARCH_INVALID,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('un límite que no es número cae en 10', () => {
    expect(customerSearchQuery(new URLSearchParams({ q: 'ana', limit: 'mucho' }))).toBe(
      'q=ana&limit=10',
    );
  });

  it('lo que no se puede leer sale como 5xx', async () => {
    const call = llamada({ kind: 'not-json', status: 404, message: 'html' });
    expect(await proxyCustomerSearch(new URLSearchParams({ q: 'ana' }), call)).toEqual({
      status: 502,
      body: { statusCode: 502, message: CUSTOMER_PROXY_UNREADABLE },
    });
  });
});

describe('customerUpsertBody', () => {
  const persona = {
    customerType: 'person',
    firstName: ' Ana ',
    lastName: 'Ruiz',
    documentType: 'CC',
    documentNumber: '1020',
    documentIssuingCountry: 'CO',
    birthdate: '1990-01-01',
    gender: 'F',
    nationality: 'CO',
    email: '',
    preferences: { asiento: 'pasillo' },
    tenantId: 'otro',
  };

  it('sólo deja pasar los campos de un cliente, recortados; los vacíos se omiten', () => {
    expect(customerUpsertBody(persona)).toEqual({
      customerType: 'person',
      firstName: 'Ana',
      lastName: 'Ruiz',
      documentType: 'CC',
      documentNumber: '1020',
      documentIssuingCountry: 'CO',
      birthdate: '1990-01-01',
      gender: 'F',
      nationality: 'CO',
    });
  });

  it('una empresa va sin apellido', () => {
    expect(
      customerUpsertBody({ ...persona, customerType: 'company', lastName: 'algo' })?.lastName,
    ).toBe('');
  });

  it('rechaza lo que falta, lo que no es texto y lo que se pasa de largo', () => {
    expect(customerUpsertBody({ ...persona, documentNumber: ' ' })).toBeNull();
    expect(customerUpsertBody({ ...persona, phone: 3001234567 })).toBeNull();
    expect(customerUpsertBody({ ...persona, countryCode: 'COL' })).toBeNull();
    expect(customerUpsertBody({ ...persona, customerType: 'admin' })).toBeNull();
    expect(customerUpsertBody([persona])).toBeNull();
  });
});

describe('proxyCustomerUpsert', () => {
  it('reenvía el cuerpo rearmado y la respuesta tal cual', async () => {
    const body = { customer: { id: 'x' }, created: true };
    const call = llamada({ kind: 'json', status: 201, body });
    const reply = await proxyCustomerUpsert(
      pedido(
        JSON.stringify({
          firstName: 'Ana',
          lastName: 'Ruiz',
          documentType: 'CC',
          documentNumber: '1',
          documentIssuingCountry: 'CO',
        }),
      ),
      call,
    );
    expect(reply).toEqual({ status: 201, body });
    const [path, init] = call.mock.calls[0]!;
    expect(path).toBe('/customers/upsert');
    expect(JSON.parse(init.body as string)).toEqual({
      customerType: 'person',
      firstName: 'Ana',
      lastName: 'Ruiz',
      documentType: 'CC',
      documentNumber: '1',
      documentIssuingCountry: 'CO',
    });
  });

  it('un cuerpo ilegible o incompleto no llega al API', async () => {
    const call = llamada({ kind: 'json', status: 201, body: {} });
    for (const raw of ['{', '{}']) {
      expect(await proxyCustomerUpsert(pedido(raw), call)).toEqual({
        status: 400,
        body: CUSTOMER_UPSERT_INVALID,
      });
    }
    expect(call).not.toHaveBeenCalled();
  });
});
