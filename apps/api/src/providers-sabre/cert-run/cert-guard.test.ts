import { SABRE_HOSTS } from '@sales-travel/sabre';
import { describe, expect, it } from 'vitest';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../../provider-credentials/provider-credentials.service.js';
import { SABRE_PROVIDER_CODE, SabreProviderFactory } from '../sabre.factory.js';
import {
  SabreCertGuardError,
  assertCertRequestUrl,
  assertCertTarget,
  certTargetViolations,
  isCertOrigin,
} from './cert-guard.js';

const PASSWORD = 'p4ssw0rd-de-la-oficina';

const CERT = {
  host: SABRE_HOSTS.cert.rest,
  soapHost: SABRE_HOSTS.cert.soap,
  environment: 'cert' as const,
};

describe('isCertOrigin — sólo el origen exacto de CERT deja salir la credencial', () => {
  it.each([
    [SABRE_HOSTS.cert.rest],
    [SABRE_HOSTS.cert.soap],
    [`${SABRE_HOSTS.cert.rest}/v2/auth/token`],
  ])('%s es CERT', (url) => {
    expect(isCertOrigin(url)).toBe(true);
  });

  it.each([
    ['producción REST', SABRE_HOSTS.prod.rest],
    ['producción SOAP', SABRE_HOSTS.prod.soap],
    ['CERT sin TLS', 'http://api.cert.platform.sabre.com'],
    ['CERT en otro puerto', 'https://api.cert.platform.sabre.com:8443'],
    ['CERT con usuario en la URL', 'https://u:p@api.cert.platform.sabre.com'],
    ['un parecido', 'https://api.cert.platform.sabre.com.evil.test'],
    ['un doble local', 'http://127.0.0.1:4010'],
    ['otro host de Sabre', 'https://api.havail.sabre.com'],
    ['basura', 'no es una url'],
  ])('%s no es CERT', (_caso, url) => {
    expect(isCertOrigin(url)).toBe(false);
  });
});

describe('certTargetViolations — la cuenta tiene que ser CERT por el host, no sólo por lo que declara', () => {
  it('una cuenta CERT con sus hosts de siempre pasa', () => {
    expect(certTargetViolations({ declaredEnvironment: 'cert', cfg: CERT })).toEqual([]);
    expect(
      certTargetViolations({
        declaredEnvironment: undefined,
        cfg: CERT,
        providerEnvironment: 'test',
      }),
    ).toEqual([]);
  });

  it('declarar CERT no alcanza si el host REST es de producción', () => {
    const violations = certTargetViolations({
      declaredEnvironment: 'cert',
      cfg: { ...CERT, host: SABRE_HOSTS.prod.rest },
    });
    expect(violations).toEqual(['el host REST no es el de CERT (https://api.platform.sabre.com)']);
  });

  it('ni si el SOAP es de producción', () => {
    expect(
      certTargetViolations({
        declaredEnvironment: 'cert',
        cfg: { ...CERT, soapHost: SABRE_HOSTS.prod.soap },
      }),
    ).toHaveLength(1);
  });

  it('una cuenta que declara producción no corre aunque apunte a CERT', () => {
    expect(certTargetViolations({ declaredEnvironment: 'prod', cfg: CERT })).toEqual([
      'la cuenta no declara environment "cert"',
    ]);
  });

  it('ni una que el factory resolvió fuera de CERT, ni una que la plataforma trata como real', () => {
    expect(
      certTargetViolations({ declaredEnvironment: 'cert', cfg: { ...CERT, environment: 'prod' } }),
    ).toEqual(['el factory resolvió la cuenta fuera de CERT']);
    expect(
      certTargetViolations({ declaredEnvironment: 'cert', cfg: CERT, providerEnvironment: 'live' }),
    ).toEqual(['la cuenta no es de pruebas para la plataforma (providerEnvironment)']);
  });

  it('el motivo nombra el host sin usuario, contraseña, ruta ni query', () => {
    const [motivo] = certTargetViolations({
      declaredEnvironment: 'cert',
      cfg: { ...CERT, host: `https://epr:${PASSWORD}@api.platform.sabre.com/v1?token=abc` },
    });
    expect(motivo).toContain('api.platform.sabre.com');
    expect(motivo).not.toContain(PASSWORD);
    expect(motivo).not.toContain('token=abc');
  });

  it('assertCertTarget lanza con todos los motivos juntos', () => {
    const error = (() => {
      try {
        assertCertTarget({
          declaredEnvironment: 'prod',
          cfg: { host: SABRE_HOSTS.prod.rest, environment: 'prod' },
        });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SabreCertGuardError);
    expect((error as SabreCertGuardError).reasons).toHaveLength(3);
  });
});

describe('la guarda contra lo que REALMENTE resuelve el factory', () => {
  function resolved(config: Record<string, unknown>): ResolvedProviderAccount {
    return {
      id: 'acc-cert',
      ownerTenantId: 'owner-1',
      providerCode: SABRE_PROVIDER_CODE,
      label: 'default',
      config,
      credentials: { epr: 'EPR-1', password: PASSWORD, homePcc: 'A1B2' },
      inherited: false,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    };
  }
  const factory = new SabreProviderFactory({} as ProviderCredentialsService);

  it('la cuenta CERT de siempre pasa', () => {
    const account = resolved({ environment: 'cert' });
    expect(
      certTargetViolations({
        declaredEnvironment: account.config['environment'],
        cfg: factory.configFor(account),
      }),
    ).toEqual([]);
  });

  it('una cuenta marcada CERT con el host de producción sobrescrito NO pasa', () => {
    const account = resolved({ environment: 'cert', host: SABRE_HOSTS.prod.rest });
    const violations = certTargetViolations({
      declaredEnvironment: account.config['environment'],
      cfg: factory.configFor(account),
    });
    expect(violations.some((v) => v.startsWith('el host REST no es el de CERT'))).toBe(true);
  });
});

describe('assertCertRequestUrl — la segunda puerta, en cada petición', () => {
  it('deja salir CERT', () => {
    expect(() => assertCertRequestUrl(`${SABRE_HOSTS.cert.rest}/v5/offers/shop`)).not.toThrow();
  });

  it('bloquea producción y no repite la query', () => {
    expect(() =>
      assertCertRequestUrl(`${SABRE_HOSTS.prod.rest}/v1/trip/orders/getBooking?pnr=ABC123`),
    ).toThrow(/api\.platform\.sabre\.com no es CERT/);
    try {
      assertCertRequestUrl(`${SABRE_HOSTS.prod.rest}/x?pnr=ABC123`);
    } catch (e) {
      expect((e as Error).message).not.toContain('ABC123');
    }
  });
});
