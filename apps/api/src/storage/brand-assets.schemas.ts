import { z } from '@sales-travel/validation';

export const UploadBrandAssetSchema = z
  .object({
    kind: z.enum(['logo', 'favicon']),
    /** Contenido en base64. El tamaño real se valida sobre el buffer decodificado. */
    dataBase64: z.string().min(1).max(1_400_000),
  })
  .strict();
export type UploadBrandAssetDto = z.infer<typeof UploadBrandAssetSchema>;
