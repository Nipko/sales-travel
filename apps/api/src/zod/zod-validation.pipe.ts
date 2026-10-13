import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /**
   * Lo que entra es lo que manda el cliente; lo que sale, `T`. Un esquema con defaults o
   * transformaciones (`z.coerce`, listas separadas por comas) tiene una entrada distinta de su salida.
   */
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fields = result.error.issues.map((i) => ({
        field: i.path.join('.') || '(general)',
        message: i.message,
      }));
      const summary = fields
        .slice(0, 5)
        .map((f) => `${f.field}: ${f.message}`)
        .join('; ');
      throw new BadRequestException({
        message: `Revisá los datos ingresados — ${summary}`,
        fields,
      });
    }
    return result.data;
  }
}
