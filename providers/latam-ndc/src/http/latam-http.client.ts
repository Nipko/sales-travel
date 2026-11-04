import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { LatamNdcConfig } from '../config';
import { LatamApiError } from '../errors';
import type { LatamTokenService } from '../auth/token.service';

export type LatamLang = 'EN' | 'ES' | 'PT';

export interface LatamRequestOptions {
  /** Lang override. Por defecto, el del país (ver {@link langForCountry}). */
  lang?: LatamLang;
  /** Country override del header `X-latam-Country`. Por defecto, el de la cuenta. */
  country?: string;
}

/** Respuesta parseada más el Track-Id con que se envió: es lo que pide el soporte de LATAM. */
export interface LatamResponse<T> {
  data: T;
  trackId: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Todo queda como TEXTO. Con la conversión numérica, un tiquete `0452100686786` llegaba como
  // 452100686786 (sin el cero del emisor) y un número de vuelo `0450` como 450. Los montos se
  // convierten donde se leen (`xml.money`).
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseLatamXml<T = unknown>(xml: string): T {
  return xmlParser.parse(xml) as T;
}

function hasNdcRoot(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return Object.keys(data).some((k) => /^IATA_\w+RS$|^\w+RS$/.test(k));
}

/**
 * Idioma según el país del punto de venta. El portal lo pide así (`/ndc/headers`: CL y PE → ES,
 * BR → PT, US → EN); el resto de la región habla español.
 */
export function langForCountry(country: string | undefined): LatamLang {
  if (country === 'BR') return 'PT';
  if (country === 'US') return 'EN';
  return 'ES';
}

/**
 * Wrapper de fetch que arma los headers obligatorios de LATAM NDC, pide el token cuando hace
 * falta y parsea el XML de vuelta.
 *
 * El `X-latam-Track-Id` es ÚNICO POR REQUEST (`/ndc/headers`: «Unique per request to provide for
 * troubleshooting»). Antes se reusaba el id de nuestra request para todo el flujo, y con eso el
 * soporte de LATAM no podía ubicar una llamada concreta.
 */
export class LatamHttpClient {
  constructor(
    private readonly cfg: LatamNdcConfig,
    private readonly tokens: LatamTokenService,
  ) {}

  async postNdc<T = unknown>(
    path: string,
    xmlBody: string,
    opts: LatamRequestOptions = {},
  ): Promise<LatamResponse<T>> {
    if (!this.cfg.apiKey || !this.cfg.country || !this.cfg.agencyName) {
      throw new LatamApiError(401, 'apiKey, country, agencyName required', path);
    }

    const token = await this.tokens.getToken();
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}${path}`;
    const trackId = randomUUID();
    const country = opts.country ?? this.cfg.country;
    const lang = opts.lang ?? langForCountry(country);

    // El XML lleva PII (pasajeros, documentos, contacto) — NO se loguea por defecto.
    // Verbose solo con LATAM_DEBUG_HTTP=true (dev/troubleshooting), nunca en prod.
    const debug = process.env['LATAM_DEBUG_HTTP'] === 'true';
    if (debug) {
      console.warn(`[latam-ndc] >>> POST ${path} track=${trackId} country=${country}`);
      console.warn(
        `[latam-ndc] XML req (first 800): ${xmlBody.replace(/\s+/g, ' ').slice(0, 800)}`,
      );
    }

    // Timeout 30s (la búsqueda NDC puede ser lenta); red/abort → LatamApiError(status 0).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-latam-api-key': this.cfg.apiKey,
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
          'X-latam-Track-Id': trackId,
          'x-latam-request-id': trackId,
          'X-latam-Application-Name': this.cfg.applicationName ?? this.cfg.agencyName,
          'X-latam-client-name': this.cfg.agencyName,
          'X-latam-Country': country,
          'X-latam-Lang': lang,
          'x-latam-api-version': 'V2',
        },
        body: xmlBody,
        signal: controller.signal,
      });
    } catch (err) {
      throw new LatamApiError(
        0,
        (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message,
        path,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (debug) {
      console.warn(`[latam-ndc] <<< ${path} status=${res.status} track=${trackId}`);
      console.warn(
        `[latam-ndc] XML resp (first 1000): ${text.replace(/\s+/g, ' ').slice(0, 1000)}`,
      );
    } else if (!res.ok) {
      // En prod, sólo status y Track-Id (sin cuerpo con PII): con el Track-Id LATAM ubica la llamada.
      console.warn(`[latam-ndc] ${path} returned status ${res.status} track=${trackId}`);
    }

    // LATAM devuelve errores de negocio como XML también en 4xx: se parsean y los mappers los
    // convierten en `LatamBusinessError`. Sólo lo que no se puede parsear es un LatamApiError.
    let data: T;
    try {
      data = parseLatamXml<T>(text);
    } catch {
      throw new LatamApiError(res.status, 'respuesta no parseable', path);
    }
    // Un 4xx/5xx sin mensaje NDC (página HTML del gateway, cuerpo vacío) no es un error de negocio:
    // es una falla de transporte y se reporta con su status real.
    if (!res.ok && !hasNdcRoot(data)) {
      throw new LatamApiError(res.status, 'respuesta sin mensaje NDC', path);
    }
    return { data, trackId };
  }
}
