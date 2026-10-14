import type { LoggerPort } from '@sales-travel/core';
import {
  SabreFlightSearchAdapter,
  SabreHttpClient,
  SabreOrderManageAdapter,
  SabreTokenService,
  type SabreConfig,
} from '@sales-travel/sabre';
import { sabreShopOptionsFromAccountConfig } from '../sabre.factory.js';
import type { CertEvidenceRecorder } from './captures.js';
import type { CertAclPort } from './scenarios.js';

/** Espacio de la caché del token del arnés: no comparte memoria con el de la búsqueda de la red. */
const CERT_RUN_TOKEN_NAMESPACE = 'sabre-cert-run';

/**
 * Un `LoggerPort` que deja cada línea del ACL en el paso abierto de la evidencia. El ACL ya redacta
 * la meta (`logRedacted`); el recorder vuelve a pasar la línea por `redactText`.
 */
export function certLoggerPort(
  recorder: CertEvidenceRecorder,
  bindings: Record<string, unknown> = {},
): LoggerPort {
  const line = (level: string, message: string, meta?: Record<string, unknown>) =>
    recorder.recordLog(
      `${level} ${message}${meta === undefined ? '' : ` ${JSON.stringify({ ...bindings, ...meta })}`}`,
    );
  return {
    debug: (message, meta) => line('debug', message, meta),
    info: (message, meta) => line('info', message, meta),
    warn: (message, meta) => line('warn', message, meta),
    error: (message, meta) => line('error', message, meta),
    child: (extra) => certLoggerPort(recorder, { ...bindings, ...extra }),
  };
}

/**
 * Lo que el arnés le pide al ACL sin pasar por el adapter de producción, sobre la MISMA config que el
 * factory resolvió y que la guarda ya comprobó contra CERT:
 *
 * - `authenticate`: un token, para certificar la credencial y la vida del token (P-08).
 * - `shopNdc`: la búsqueda con `ndcContent` encendido SÓLO para esta llamada. La cuenta no se toca;
 *   lo que importa es la respuesta cruda, que es el fixture que pide el mapper NDC (SAB-22).
 * - `refund`: el reembolso por `cancelBooking` con `REFUND`. Producción no lo cablea hasta SAB-23 y
 *   sigue apagado por D9; esto sólo certifica en CERT con `--allow-money`.
 */
export function buildCertAcl(
  cfg: SabreConfig,
  accountConfig: Readonly<Record<string, unknown>>,
  recorder: CertEvidenceRecorder,
): CertAclPort {
  const logger = certLoggerPort(recorder);
  const tokens = new SabreTokenService(cfg, { cacheNamespace: CERT_RUN_TOKEN_NAMESPACE, logger });
  const http = new SabreHttpClient(cfg, tokens, { logger });

  return {
    authenticate: async () => {
      await tokens.getToken();
    },

    shopNdc: async (criteria, ctx) => {
      const { options } = sabreShopOptionsFromAccountConfig({ ...accountConfig, ndcContent: true });
      const warnings: Record<string, number> = {};
      const capture: LoggerPort = {
        ...logger,
        warn: (message, meta) => {
          const counts = meta?.['warnings'];
          if (message === 'sabre.shop.warnings' && typeof counts === 'object' && counts !== null) {
            for (const [code, count] of Object.entries(counts as Record<string, unknown>)) {
              if (typeof count === 'number') warnings[code] = (warnings[code] ?? 0) + count;
            }
          }
          logger.warn(message, meta);
        },
      };
      const search = new SabreFlightSearchAdapter(cfg, {
        cacheNamespace: CERT_RUN_TOKEN_NAMESPACE,
        tokens,
        http,
        logger: capture,
        shopOptions: options,
      });
      const offers = await search.search(criteria, ctx);
      return { offers, warnings };
    },

    refund: async (orderId, ctx) => {
      const manage = new SabreOrderManageAdapter(cfg, http, { logger });
      const outcome = await manage.cancelBooking(orderId, ctx, {
        ticketOperation: 'REFUND',
        refundDocumentsType: 'Tickets and EMDs',
      });
      return {
        outcome: outcome.outcome,
        result: outcome.result,
        refundedDocuments: outcome.detail.refundedTickets.length,
      };
    },
  };
}
