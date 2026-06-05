import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { LatamNdcConfig } from '../config';
import type { LatamTokenService } from '../auth/token.service';

export interface LatamRequestOptions {
  /** Track ID por sesión (puede repetirse en múltiples requests del mismo flujo). */
  trackId?: string;
  /** Lang override (default EN). */
  lang?: 'EN' | 'ES' | 'PT';
  /** Country override — determines currency in response (CO→COP, BR→BRL, CL→CLP). */
  country?: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: true,
  trimValues: true,
});

/**
 * Wrapper de fetch que arma todos los headers obligatorios de LATAM NDC,
 * pide el token cuando hace falta, y parsea XML de vuelta.
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
  ): Promise<T> {
    if (!this.cfg.apiKey || !this.cfg.country || !this.cfg.agencyName) {
      throw new Error('LatamHttpClient: apiKey, country, agencyName required');
    }

    const token = await this.tokens.getToken();
    const url = `${this.cfg.apiUrl.replace(/\/$/, '')}${path}`;
    const trackId = opts.trackId ?? randomUUID();
    const requestId = randomUUID();
    const country = opts.country ?? this.cfg.country;

    // El XML lleva PII (pasajeros, documentos, contacto) — NO se loguea por defecto.
    // Verbose solo con LATAM_DEBUG_HTTP=true (dev/troubleshooting), nunca en prod.
    const debug = process.env['LATAM_DEBUG_HTTP'] === 'true';
    if (debug) {
      console.warn(
        `[latam-ndc] >>> POST ${path} track=${trackId} req=${requestId} country=${country}`,
      );
      console.warn(
        `[latam-ndc] XML req (first 800): ${xmlBody.replace(/\s+/g, ' ').slice(0, 800)}`,
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-latam-api-key': this.cfg.apiKey,
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
        'X-latam-Track-Id': trackId,
        'x-latam-request-id': requestId,
        'X-latam-Application-Name': this.cfg.agencyName,
        'X-latam-client-name': this.cfg.agencyName,
        'X-latam-Country': country,
        'X-latam-Lang': opts.lang ?? 'EN',
        'x-latam-api-version': 'V2',
      },
      body: xmlBody,
    });

    const text = await res.text();
    if (debug) {
      console.warn(`[latam-ndc] <<< ${path} status=${res.status}`);
      console.warn(
        `[latam-ndc] XML resp (first 1000): ${text.replace(/\s+/g, ' ').slice(0, 1000)}`,
      );
    } else if (!res.ok) {
      // En prod, sólo el status del error (sin cuerpo con PII).
      console.warn(`[latam-ndc] ${path} returned status ${res.status}`);
    }

    // Always try to parse XML — LATAM returns structured errors in 4xx bodies
    // that response mappers handle gracefully. Only throw on non-parseable responses.
    if (!res.ok) {
      try {
        return xmlParser.parse(text) as T;
      } catch {
        throw new Error(`LATAM ${path} ${res.status}: ${text.slice(0, 400)}`);
      }
    }

    return xmlParser.parse(text) as T;
  }
}
