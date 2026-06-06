import { z } from '@sales-travel/validation';

export const TestEmailSchema = z.object({
  tenantId: z.string().uuid(),
});
export type TestEmailDto = z.infer<typeof TestEmailSchema>;
