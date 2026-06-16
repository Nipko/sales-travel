import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

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
