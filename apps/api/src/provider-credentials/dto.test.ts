import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { UpsertProviderAccountSchema } from './dto.js';

/**
 * El borde REAL: el mismo pipe que corre en `POST /provider-accounts`. Probar el schema suelto
 * dejaría fuera la traducción a 400 y el texto que finalmente lee quien carga la cuenta, que es
 * media mitad de lo que esta tanda arregla.
 */
const pipe = new ZodValidationPipe(UpsertProviderAccountSchema);

const TENANT = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'p4ssw0rd-de-la-oficina';

interface UpsertBody {
  tenantId: string;
  providerCode: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
  status?: string;
}

function body(over: Partial<UpsertBody> = {}): UpsertBody {
  return {
    tenantId: TENANT,
    providerCode: 'sabre',
    credentials: { epr: '1234567', password: PASSWORD, homePcc: 'AB1C' },
    ...over,
  };
}

/** Los pares `campo: mensaje` del 400, tal cual los devuelve el pipe. */
function rejection(input: UpsertBody): { fields: { field: string; message: string }[] } {
  try {
    pipe.transform(input);
  } catch (err) {
    if (err instanceof BadRequestException) {
      return err.getResponse() as { fields: { field: string; message: string }[] };
    }
    throw err;
  }
  throw new Error('se esperaba un 400 y el cuerpo pasó');
}

describe('POST /provider-accounts — el borde exige la forma DECLARADA del proveedor', () => {
  it('una cuenta de Sabre completa se acepta', () => {
    expect(() => pipe.transform(body())).not.toThrow();
  });

  it('sin `homePcc` se RECHAZA: era la cuenta inservible que se guardaba en silencio', () => {
    const { fields } = rejection(body({ credentials: { epr: '1234567', password: PASSWORD } }));
    expect(fields.map((f) => f.field)).toContain('credentials.homePcc');
  });

  it('el motivo explica POR QUÉ hace falta, no dice "campo requerido"', () => {
    const { fields } = rejection(body({ credentials: { epr: '1234567', password: PASSWORD } }));
    const motivo = fields.find((f) => f.field === 'credentials.homePcc')?.message ?? '';
    expect(motivo).toContain('clientId');
    expect(motivo).toMatch(/no hay autenticación posible/i);
    expect(motivo).not.toMatch(/^required$/i);
  });

  it('sin `epr` y sin `password` protesta por los dos, no sólo por el primero', () => {
    const { fields } = rejection(body({ credentials: { homePcc: 'AB1C' } }));
    expect(fields.map((f) => f.field).sort()).toEqual(['credentials.epr', 'credentials.password']);
  });

  it('acepta `homePcc` desde `config`, porque es de donde el factory también lo lee', () => {
    // El borde no puede rechazar una forma que el sistema sí honra: sería la misma mentira al
    // revés — decir "no sirve" de una cuenta que funciona.
    expect(() =>
      pipe.transform(
        body({ credentials: { epr: '1234567', password: PASSWORD }, config: { homePcc: 'AB1C' } }),
      ),
    ).not.toThrow();
  });

  it('la contraseña NO puede viajar en `config` ni aunque venga además cifrada', () => {
    const { fields } = rejection(body({ config: { password: PASSWORD } }));
    const issue = fields.find((f) => f.field === 'config.password');
    expect(issue?.message).toMatch(/sin cifrar/i);
  });

  it('un `homePcc` fuera del rango 3–4 se corta acá y no en la primera búsqueda', () => {
    const { fields } = rejection(
      body({ credentials: { epr: '1234567', password: PASSWORD, homePcc: 'A' } }),
    );
    expect(fields.find((f) => f.field === 'credentials.homePcc')?.message).toContain(
      '3 caracteres',
    );
  });

  it('el `ticketingPcc`, que es opcional, sólo se valida si vino', () => {
    expect(() => pipe.transform(body({ config: { ticketingPcc: 'AB1C' } }))).not.toThrow();
    const { fields } = rejection(body({ config: { ticketingPcc: 'ABCDE' } }));
    expect(fields.map((f) => f.field)).toContain('config.ticketingPcc');
  });

  it('una cuenta declarada `mock` se acepta sin credenciales reales: no autentica contra nadie', () => {
    expect(() =>
      pipe.transform(body({ credentials: { placeholder: 'x' }, config: { mock: true } })),
    ).not.toThrow();
  });

  it('ningún mensaje de error hace eco del VALOR de una credencial', () => {
    const { fields } = rejection(
      body({ credentials: { epr: '1234567', password: PASSWORD, homePcc: 'A' } }),
    );
    const texto = JSON.stringify(fields);
    expect(texto).not.toContain(PASSWORD);
    expect(texto).not.toContain('1234567');
  });
});

describe('POST /provider-accounts — lo que ya funcionaba sigue funcionando', () => {
  it.each([
    ['latam-ndc', { apiKey: 'k', apiSecret: 's' }],
    ['agent-cars', { accessToken: 't' }],
    ['email', { user: 'u@x.test', password: 'pw' }],
  ])('%s no gana requisitos que nadie verificó contra su ACL', (providerCode, credentials) => {
    expect(() => pipe.transform(body({ providerCode, credentials }))).not.toThrow();
  });

  it('un proveedor SIN reglas declaradas se acepta exactamente como hasta hoy', () => {
    expect(() =>
      pipe.transform(body({ providerCode: 'proveedor-nuevo', credentials: { loQueSea: 'x' } })),
    ).not.toThrow();
  });

  it('`credentials` vacío sigue siendo un 400', () => {
    const { fields } = rejection(body({ providerCode: 'proveedor-nuevo', credentials: {} }));
    expect(fields.map((f) => f.field)).toContain('credentials');
  });

  it('el resto del cuerpo sigue validándose igual (tenantId, providerCode)', () => {
    expect(() => pipe.transform(body({ tenantId: 'no-es-uuid' }))).toThrow(BadRequestException);
    expect(() => pipe.transform(body({ providerCode: 'Sabre GDS' }))).toThrow(BadRequestException);
  });
});
