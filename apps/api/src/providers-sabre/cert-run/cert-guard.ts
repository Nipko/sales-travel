import { SABRE_HOSTS, sabreHostEnvironment, type SabreConfig } from '@sales-travel/sabre';

/**
 * La puerta dura del arnés de certificación (SAB-11): nada sale si la cuenta no es de CERT.
 *
 * No se fía de `config.environment`. La cuenta lo declara, pero el host se puede sobrescribir por
 * separado (`config.host`, `config.soapHost`), así que una cuenta marcada CERT puede apuntar a
 * producción. Lo que decide es el host YA RESUELTO —el mismo con el que el ACL arma cada URL— contra
 * los hosts de CERT de {@link SABRE_HOSTS}, y además cada petición vuelve a pasar por
 * {@link assertCertRequestUrl} en el transporte, justo antes del cable.
 */

/** Los orígenes de CERT exactos: esquema, host y puerto. Se sacan de `SABRE_HOSTS`, no se repiten. */
export const SABRE_CERT_ORIGINS: readonly string[] = Object.values(SABRE_HOSTS.cert).map(
  (url) => new URL(url).origin,
);

/** El arnés se negó a correr. `reasons` dice por qué, sin valores de credenciales. */
export class SabreCertGuardError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`el arnés sólo corre contra Sabre CERT: ${reasons.join('; ')}`);
    this.name = 'SabreCertGuardError';
  }
}

/**
 * ¿La URL es EXACTAMENTE un origen de CERT? Más estricto que {@link sabreHostEnvironment}: además del
 * host exige `https`, el puerto por defecto y ningún usuario en la URL. Un `http://` al host de CERT
 * es CERT para clasificar una cuenta, pero no es por donde el arnés deja salir una credencial.
 */
export function isCertOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  if (parsed.port !== '' && parsed.port !== '443') return false;
  return sabreHostEnvironment(url) === 'cert' && SABRE_CERT_ORIGINS.includes(originOf(parsed));
}

/** El origen sin el punto final de un FQDN, que apunta al mismo host. */
function originOf(url: URL): string {
  return `${url.protocol}//${url.hostname.toLowerCase().replace(/\.$/, '')}`;
}

export interface CertTargetInput {
  /** `config.environment` tal cual está guardado en la cuenta. */
  readonly declaredEnvironment: unknown;
  /** La config ya resuelta por el factory: los hosts con los que el ACL armaría cada URL. */
  readonly cfg: Pick<SabreConfig, 'host' | 'soapHost' | 'environment'>;
  /** El entorno que el factory le dio a la cuenta (`TenantAdapter.providerEnvironment`). */
  readonly providerEnvironment?: string;
}

/**
 * Todo lo que impide correr contra esta cuenta. Vacío = es CERT por los cuatro lados: lo que declara,
 * lo que resolvió el factory, el host REST y el SOAP.
 */
export function certTargetViolations(input: CertTargetInput): string[] {
  const violations: string[] = [];
  const declared = input.declaredEnvironment;
  if (declared !== undefined && declared !== null && declared !== '' && declared !== 'cert') {
    violations.push('la cuenta no declara environment "cert"');
  }
  if (input.cfg.environment !== 'cert') {
    violations.push('el factory resolvió la cuenta fuera de CERT');
  }
  if (!isCertOrigin(input.cfg.host)) {
    violations.push(`el host REST no es el de CERT (${describeHost(input.cfg.host)})`);
  }
  if (input.cfg.soapHost !== undefined && !isCertOrigin(input.cfg.soapHost)) {
    violations.push(`el host SOAP no es el de CERT (${describeHost(input.cfg.soapHost)})`);
  }
  if (input.providerEnvironment !== undefined && input.providerEnvironment !== 'test') {
    violations.push('la cuenta no es de pruebas para la plataforma (providerEnvironment)');
  }
  return violations;
}

export function assertCertTarget(input: CertTargetInput): void {
  const violations = certTargetViolations(input);
  if (violations.length > 0) throw new SabreCertGuardError(violations);
}

/**
 * La segunda puerta, en el transporte: cada petición del proceso vuelve a comprobar su URL. Así un
 * camino que no pase por la primera —una cuenta que cambió entre la comprobación y la llamada, un
 * adapter construido con otra config— tampoco puede salir de CERT.
 */
export function assertCertRequestUrl(url: string): void {
  if (!isCertOrigin(url)) {
    throw new SabreCertGuardError([
      `petición bloqueada antes de salir: ${describeHost(url)} no es CERT`,
    ]);
  }
}

/**
 * Qué host se rechazó, para el mensaje. Sólo esquema, host y puerto: nunca usuario, contraseña,
 * ruta ni query, que podrían llevar una credencial.
 */
function describeHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'URL ilegible';
  }
}
