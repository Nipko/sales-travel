import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LatamNdcFlightSearchAdapter } from './latam-flight-search.adapter';
import { buildOrderCreateRequest } from './ordercreate/request.builder';

const cfg = {
  apiUrl: 'https://sandbox.api.latam.com',
  apiKey: 'k',
  apiSecret: 's',
  agencyId: 'A',
  agencyIata: '12345678',
  agencyName: 'Agencia',
  country: 'CO',
};

const VOID_OK = `<?xml version="1.0"?><IATA_OrderCancelRS><Response>
  <OrderCancelProcessing/><OrderRefID>LA1</OrderRefID>
</Response></IATA_OrderCancelRS>`;

function fetchStub(responses: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/oauth/cc/token') {
        return Promise.resolve(
          new Response('{"access_token":"t","expires_in":3600}', { status: 200 }),
        );
      }
      const r = responses[path] ?? { status: 404, body: '<html>not found</html>' };
      return Promise.resolve(new Response(r.body, { status: r.status }));
    }),
  );
  return calls;
}

describe('cancelOrder', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('una reserva sin pago se cancela por /order/cancel/bnpl', async () => {
    const calls = fetchStub({ '/ndc/v192/order/cancel/bnpl': { status: 200, body: VOID_OK } });
    const r = await new LatamNdcFlightSearchAdapter(cfg).cancelOrder('LA1', { tenantId: 't' });
    expect(r.success).toBe(true);
    expect(calls).toEqual(['/oauth/cc/token', '/ndc/v192/order/cancel/bnpl']);
  });

  it('si la cuenta no tiene el endpoint BNPL (404), usa /order/cancel', async () => {
    const calls = fetchStub({ '/ndc/v192/order/cancel': { status: 200, body: VOID_OK } });
    const r = await new LatamNdcFlightSearchAdapter(cfg).cancelOrder('LA1', { tenantId: 't' });
    expect(r.success).toBe(true);
    expect(calls.slice(1)).toEqual(['/ndc/v192/order/cancel/bnpl', '/ndc/v192/order/cancel']);
  });

  it('un error de negocio del BNPL NO dispara un segundo intento', async () => {
    const calls = fetchStub({
      '/ndc/v192/order/cancel/bnpl': {
        status: 409,
        body: '<IATA_OrderCancelRS><Error><Code>409107014</Code><DescText>Use OrderRetrieve</DescText></Error></IATA_OrderCancelRS>',
      },
    });
    const r = await new LatamNdcFlightSearchAdapter(cfg).cancelOrder('LA1', { tenantId: 't' });
    expect(r.success).toBe(false);
    expect(calls.slice(1)).toEqual(['/ndc/v192/order/cancel/bnpl']);
  });
});

describe('OrderCreate no inventa datos', () => {
  it('sin fecha de expedición, título ni código de área, no los manda', () => {
    const body = buildOrderCreateRequest(
      {
        provider: { name: 'latam-ndc', offerRef: 'o1|SEI|A' },
      } as never,
      [
        {
          paxId: 'ADT_1',
          paxType: 'ADT',
          givenName: 'Ana',
          surname: 'Paz',
          birthdate: '1990-01-01',
          gender: 'F',
          citizenshipCountryCode: 'CO',
          identityDoc: { type: 'CC', number: '123', issuingCountryCode: 'CO' },
        },
      ] as never,
      { email: 'a@b.co', phone: '3001234567' },
      cfg,
      'COP',
    );
    expect(body).not.toContain('<IssueDate>');
    expect(body).not.toContain('<TitleName>');
    expect(body).not.toContain('<AreaCodeNumber>');
    expect(body).toContain('<IdentityDocTypeCode>IN</IdentityDocTypeCode>');
  });
});

describe('enlace de pago', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('manda sólo OrderID y correo, sin tarjeta, al endpoint del enlace', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { body?: string }) => {
        if (url.endsWith('/oauth/cc/token')) {
          return Promise.resolve(
            new Response('{"access_token":"t","expires_in":3600}', { status: 200 }),
          );
        }
        bodies.push(`${new URL(url).pathname} ${init?.body ?? ''}`);
        return Promise.resolve(
          new Response(
            '<IATA_OrderViewRS><Response><Order><OrderID>LA1</OrderID></Order></Response></IATA_OrderViewRS>',
            { status: 200 },
          ),
        );
      }),
    );
    const r = await new LatamNdcFlightSearchAdapter(cfg).sendPaymentLink(
      { orderId: 'LA1', email: 'paga@cliente.co' },
      { tenantId: 't' },
    );
    expect(r).toEqual({ success: true, warnings: [] });
    expect(bodies[0]).toContain('/ndc/v192/order/change/send/payment/link');
    expect(bodies[0]).toContain('<OrderID>LA1</OrderID>');
    expect(bodies[0]).toContain('<EmailAddressText>paga@cliente.co</EmailAddressText>');
    expect(bodies[0]).not.toContain('CardNumber');
    expect(bodies[0]).not.toContain('PaymentFunctions');
  });

  it('un error de LATAM no es éxito', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/oauth/cc/token')
            ? new Response('{"access_token":"t","expires_in":3600}', { status: 200 })
            : new Response(
                '<IATA_OrderViewRS><Error><Code>404107001</Code><DescText>Order Id not found.</DescText></Error></IATA_OrderViewRS>',
                { status: 404 },
              ),
        ),
      ),
    );
    const r = await new LatamNdcFlightSearchAdapter(cfg).sendPaymentLink(
      { orderId: 'X', email: 'a@b.co' },
      { tenantId: 't' },
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('404107001');
  });
});
