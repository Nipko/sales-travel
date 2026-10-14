import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  REDACTED,
  SABRE_HOSTS,
  SabreHttpClient,
  SabreTokenService,
  deriveSabreSecret,
  type SabreConfig,
} from '@sales-travel/sabre';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUEST_OMITTED,
  CertEvidenceRecorder,
  CertEvidenceWriter,
  SecretScrubber,
  createCertTransport,
  evidenceBody,
  safeHeaders,
  stepFileName,
  type CertEvidenceSink,
} from './captures.js';
import { SabreCertGuardError } from './cert-guard.js';

/** Testigos: ninguno puede aparecer en un archivo de evidencia. */
const EPR = 'EPR-OFICINA-77';
const PASSWORD = 'Pa55w0rd!oficina';
const HOME_PCC = 'Q7RZ';
const ACCESS_TOKEN = 'T1RLAQKx9f8sZz-token-de-sabre-QWERTY12345';
const PAN = '4111111111111111';
const PAN_SEPARADO = '5555 5555 5555 4444';

const CFG: SabreConfig = {
  host: SABRE_HOSTS.cert.rest,
  environment: 'cert',
  epr: EPR,
  password: PASSWORD,
  homePcc: HOME_PCC,
  tokenTtlSeconds: 3600,
  maxConcurrentRequests: 2,
  requestTimeoutMs: 5_000,
};

const SECRET = deriveSabreSecret({ epr: EPR, homePcc: HOME_PCC, password: PASSWORD, domain: 'AA' });

function memorySink(): CertEvidenceSink & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    mkdir: () => Promise.resolve(),
    write: (path, content) => {
      files.set(path.replace(/\\/g, '/'), content);
      return Promise.resolve();
    },
  };
}

/** Lo que Sabre devolvería: el token, y un eco de la reserva con PII, tarjeta y el token dentro. */
function fakeSabre(): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 604800 }),
      );
    }
    return Promise.resolve(
      Response.json(
        {
          confirmationId: 'ABCDEF',
          travelers: [
            {
              givenName: 'PASAJERO UNO',
              surname: 'TEST',
              birthDate: '1980-01-01',
              identityDocuments: [{ documentNumber: 'TEST000001' }],
              emails: ['cert-run@example.com'],
            },
          ],
          payments: { formsOfPayment: [{ cardNumber: PAN, securityCode: '123' }] },
          // Lo peor que puede pasar: el proveedor hace eco del token y de un PAN bajo claves
          // inocuas, donde la redacción por clave no mira.
          diagnostico: {
            echo: `sesión ${ACCESS_TOKEN}`,
            ref: PAN_SEPARADO,
            numero: 4111111111111111,
          },
          office: { pseudoCityCode: HOME_PCC },
        },
        { headers: { 'Conversation-ID': 'conv-1', 'Set-Cookie': 'sesion=secreta' } },
      ),
    );
  });
}

describe('createCertTransport — la segunda puerta y la grabadora', () => {
  it('una URL que no es CERT no llega al cable y no queda grabada', async () => {
    const inner = vi.fn<typeof fetch>();
    const recorder = new CertEvidenceRecorder();
    const transport = createCertTransport({ inner, recorder, scrubber: new SecretScrubber() });
    recorder.begin('shop', 'shop BOG-LIM');

    await expect(
      transport(`${SABRE_HOSTS.prod.rest}/v5/offers/shop`, { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(SabreCertGuardError);
    expect(inner).not.toHaveBeenCalled();
    expect(recorder.steps[0]?.exchanges).toEqual([]);
  });

  it('el ACL real por su puerta pública (postJson): la evidencia no lleva credencial, token, PII ni PAN', async () => {
    const recorder = new CertEvidenceRecorder();
    const scrubber = new SecretScrubber();
    for (const value of [EPR, PASSWORD, HOME_PCC, SECRET]) scrubber.add(value);
    const transport = createCertTransport({ inner: fakeSabre(), recorder, scrubber });
    const tokens = new SabreTokenService(CFG, { fetch: transport, cacheNamespace: 't' });
    const http = new SabreHttpClient(CFG, tokens, { fetch: transport });

    recorder.begin('book-cancel', 'getBooking');
    const result = await http.postJson<{ confirmationId: string }>('/v1/trip/orders/getBooking', {
      confirmationId: 'ABCDEF',
      travelers: [{ givenName: 'PASAJERO UNO', surname: 'TEST' }],
      contactInfo: { emails: ['cert-run@example.com'], phones: ['5710000000'] },
    });
    const record = recorder.end('ok', { result: { pnr: result.data.confirmationId } });
    // El ACL sigue recibiendo la respuesta entera: grabar no consume el cuerpo.
    expect(result.data.confirmationId).toBe('ABCDEF');

    const sink = memorySink();
    const writer = new CertEvidenceWriter('/tmp/cert', scrubber, sink);
    await writer.writeJson(stepFileName(1, record!), record);
    const texto = [...sink.files.values()].join('\n');

    for (const testigo of [
      EPR,
      PASSWORD,
      HOME_PCC,
      SECRET,
      ACCESS_TOKEN,
      PAN,
      PAN_SEPARADO,
      'PASAJERO UNO',
      'cert-run@example.com',
      '5710000000',
      'TEST000001',
      '1980-01-01',
      'Bearer',
      'sesion=secreta',
    ]) {
      expect(texto, `se filtró ${testigo}`).not.toContain(testigo);
    }
    // Lo que sirve para diagnosticar sigue ahí.
    expect(texto).toContain('ABCDEF');
    expect(texto).toContain('/v1/trip/orders/getBooking');
    expect(texto).toContain('"conversation-id"');

    // Dos llamadas: el token y la lectura, con el token reducido a su vida.
    const [token, lectura] = record!.exchanges;
    expect(token?.request.body).toBe(AUTH_REQUEST_OMITTED);
    expect(token?.response?.body).toEqual({
      token_type: 'bearer',
      expires_in: 604800,
      access_token: REDACTED,
    });
    expect(lectura?.request.headers).not.toHaveProperty('authorization');
    // El eco del token bajo una clave inocua sólo lo tapó la tercera capa, y queda contado.
    expect(writer.secretsScrubbed).toBeGreaterThan(0);
  });

  it('una redirección de CERT a otro host no se sigue: el destino no recibe nada', async () => {
    // Con un `fetch` real: es él quien sigue los 3xx por dentro, donde la URL de destino ya no
    // pasa por la puerta. CERT es un servidor local que responde 307 hacia otro, que no puede
    // recibir ni la petición ni su cuerpo.
    const robado: string[] = [];
    const listen = (server: Server) =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
        });
      });
    const ladron = createServer((req, res) => {
      robado.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.end('{}');
    });
    const ladronUrl = await listen(ladron);
    const cert = createServer((_req, res) => {
      res.writeHead(307, { location: `${ladronUrl}/robar` });
      res.end();
    });
    const certUrl = await listen(cert);
    try {
      // El arnés comprueba la URL de CERT; el cable va al servidor local que hace de CERT.
      const inner: typeof fetch = (input, init) => {
        const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
        return fetch(url.replace(SABRE_HOSTS.cert.rest, certUrl), init);
      };
      const recorder = new CertEvidenceRecorder();
      const transport = createCertTransport({ inner, recorder, scrubber: new SecretScrubber() });
      recorder.begin('book-cancel', 'createBooking');

      await expect(
        transport(`${SABRE_HOSTS.cert.rest}/v1/trip/orders/createBooking`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          body: JSON.stringify({ travelers: [{ surname: 'TEST' }] }),
        }),
      ).rejects.toThrow(TypeError);
      expect(robado).toEqual([]);
      expect(recorder.steps[0]?.exchanges[0]?.transportError).toBe('TypeError');
    } finally {
      await new Promise((resolve) => cert.close(resolve));
      await new Promise((resolve) => ladron.close(resolve));
    }
  });

  it('un fallo de red queda grabado por nombre y se propaga igual', async () => {
    const recorder = new CertEvidenceRecorder();
    const inner = vi.fn(() =>
      Promise.reject(new TypeError(`connect ECONNREFUSED ${SABRE_HOSTS.cert.rest}?k=${PASSWORD}`)),
    ) as unknown as typeof fetch;
    const transport = createCertTransport({ inner, recorder, scrubber: new SecretScrubber() });
    recorder.begin('auth', 'token');

    await expect(transport(`${SABRE_HOSTS.cert.rest}/v2/auth/token`, {})).rejects.toThrow(
      TypeError,
    );
    const [exchange] = recorder.steps[0]!.exchanges;
    expect(exchange?.transportError).toBe('TypeError');
    expect(JSON.stringify(exchange)).not.toContain(PASSWORD);
  });
});

describe('las piezas de la redacción', () => {
  it('un cuerpo que no es JSON pasa por la redacción de texto', () => {
    expect(evidenceBody(`password=${PASSWORD}&grant_type=client_credentials`)).not.toContain(
      PASSWORD,
    );
    expect(evidenceBody(undefined)).toBeNull();
  });

  it('las cabeceras salen de una lista blanca', () => {
    expect(
      safeHeaders({
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'X-Sabre-Group': HOME_PCC,
        'Content-Type': 'application/json',
        'Conversation-ID': 'conv-9',
      }),
    ).toEqual({ 'content-type': 'application/json', 'conversation-id': 'conv-9' });
  });

  it('el scrubber tapa los valores conocidos, el más largo primero, y no busca los cortos', () => {
    const scrubber = new SecretScrubber();
    scrubber.add('BOG');
    scrubber.add(PASSWORD);
    scrubber.add(`${PASSWORD}-extendida`);
    const { text, hits } = scrubber.scrub(`BOG ${PASSWORD}-extendida y ${PASSWORD}`);
    expect(text).toBe(`BOG ${REDACTED} y ${REDACTED}`);
    expect(hits).toBe(2);
  });

  it('el nombre del archivo de un paso no deja pasar separadores de ruta', () => {
    expect(stepFileName(3, { scenario: 'book-cancel', step: 'shop ../BOG-LIM' })).toBe(
      '03-book-cancel-shop-bog-lim.json',
    );
  });
});
