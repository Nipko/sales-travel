import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';

/**
 * Body de `POST CityList` (docs/tbo/05 §2.3, p. 53): `{"CountryCode":"AT"}`. Sin nada más: el
 * body de salida pasa por un Zod `.strict()`.
 *
 * El código es ISO2 en mayúsculas y no se corrige: la lista de países del sync ya viene validada
 * (`TBO_SYNC_COUNTRIES`, 05 §6.3 E0), y una minúscula aquí es un error de quien llama.
 */
const TboCityListRequestSchema = z.object({ CountryCode: z.string().regex(/^[A-Z]{2}$/) }).strict();

/** El body exacto que sale al cable. Tipo crudo de TBO: no sale del paquete. */
export type TboCityListRequest = z.infer<typeof TboCityListRequestSchema>;

export function buildTboCityListRequest(countryCode: string): TboCityListRequest {
  const parsed = TboCityListRequestSchema.safeParse({ CountryCode: countryCode });
  if (!parsed.success) {
    throw new TboRequestBuildError(
      TBO_OPERATIONS.cityList.path,
      'SCHEMA',
      zodIssueRefs(parsed.error),
    );
  }
  return parsed.data;
}
