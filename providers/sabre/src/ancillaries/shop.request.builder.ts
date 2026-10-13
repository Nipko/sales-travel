import { z } from 'zod';

/**
 * Stateless Ancillaries 1.0 (`stateless-ancillaries-api-1.0.yml`), carril ATPCO sobre PNR.
 *
 * Es el producto de Digital Connect que consulta, agrega y quita ancillares de un PNR sin sesión.
 * Que el PCC de la cuenta lo tenga habilitado está por confirmar en CERT (P-06, SAB-21): la página
 * del producto lo declara para aerolíneas y pide hablar con el account manager. Si no lo tiene, la
 * alternativa es Manage Ancillary 1.1 (`/v1/ancillaries/*`), con otra forma de petición.
 *
 * `basePath: /v1/dc/ancillaries` (`:11`).
 */
export const SABRE_ANCILLARIES_BASE_PATH = '/v1/dc/ancillaries';

/** `POST /shop` (`:28-46`). Es una lectura: no toca la reserva. */
export const SABRE_ANCILLARIES_SHOP_PATH = `${SABRE_ANCILLARIES_BASE_PATH}/shop`;

/**
 * `PnrLocator` es `^[A-Z0-9]{1,8}$` (`:896-900`); un localizador de Sabre tiene seis caracteres, y
 * por debajo de eso no es un PNR. Un id de orden NDC no cabe aquí, y es mejor: ese carril no se
 * consulta por esta API (P-12).
 */
export const SABRE_ANCILLARY_PNR_PATTERN = /^[A-Z0-9]{6,8}$/;

export const SabreAncillaryPnrSchema = z.string().regex(SABRE_ANCILLARY_PNR_PATTERN);

/**
 * `AncillaryShopRequest` (`:99-164`) en su modo por PNR: «for all segments in the PNR»
 * (`help/stateless-ancillaries-api-1.0/1.0-index.txt`). Sólo el localizador.
 *
 * Sin `clientContext`: el PCC sale del token ATK, como en el resto del ACL, y ponerlo en el cuerpo
 * sólo serviría para actuar sobre otra oficina sin pasar por el carril de grupo. Sin
 * `passengers` ni `segments`: Sabre ya los conoce, y mandarlos llevaría nombres al cable.
 */
export const SabreAncillaryShopRequestSchema = z
  .object({ pnrLocator: SabreAncillaryPnrSchema })
  .strict();
export type SabreAncillaryShopRequest = z.infer<typeof SabreAncillaryShopRequestSchema>;

export type SabreAncillaryOperation = 'shop' | 'add' | 'remove';

/**
 * La petición no se pudo armar: no sale al cable. Lleva rutas y códigos de Zod, nunca valores
 * (un localizador o un id del alta son identificadores de la reserva).
 */
export class SabreAncillaryRequestError extends Error {
  constructor(
    readonly operation: SabreAncillaryOperation,
    readonly issues: readonly string[],
  ) {
    super(
      `petición de ancillares (${operation}) inválida: ${issues.join(', ') || '<root>'}; no se envió`,
    );
    this.name = 'SabreAncillaryRequestError';
  }
}

export interface SabreAncillaryShopPlan {
  readonly path: typeof SABRE_ANCILLARIES_SHOP_PATH;
  readonly body: SabreAncillaryShopRequest;
}

export function buildSabreAncillaryShopRequest(input: {
  readonly pnrLocator: string;
}): SabreAncillaryShopPlan {
  const parsed = SabreAncillaryShopRequestSchema.safeParse({ pnrLocator: input.pnrLocator });
  if (!parsed.success)
    throw new SabreAncillaryRequestError('shop', sabreAncillaryZodIssues(parsed.error));
  return { path: SABRE_ANCILLARIES_SHOP_PATH, body: parsed.data };
}

/** `ruta:código` por issue. Nunca el valor recibido ni el mensaje de Zod, que puede citarlo. */
export function sabreAncillaryZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`);
}
