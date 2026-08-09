import { z } from '@sales-travel/validation';

/**
 * Etapas del pipeline. Espejo del comentario de 0024 y del CHECK que agrega 0031: hasta
 * ahora `stage` era un VARCHAR(40) libre sin validación en ningún borde, así que un
 * typo o un cliente malicioso podía dejar oportunidades en una etapa inexistente, que el
 * Kanban no renderiza en ninguna columna — desaparecían de la vista sin borrarse.
 */
export const CRM_STAGES = [
  'AI_HANDLING',
  'LEAD_UNASSIGNED',
  'QUALIFIED_LEAD',
  'QUOTE_SENT',
  'NEGOTIATION',
  'BOOKING_CONFIRMED',
  'IN_TRAVEL',
  'POST_TRAVEL_COMPLETED',
  'CLOSED_LOST',
] as const;

export const SOURCE_CHANNELS = ['WHATSAPP', 'WEB_B2B', 'WEB_B2C', 'MANUAL'] as const;

const StageSchema = z.enum(CRM_STAGES);
const Dateish = z.union([z.string(), z.date()]).nullable().optional();

export const CreateOpportunitySchema = z
  .object({
    customerId: z.string().uuid(),
    assignedUserId: z.string().uuid().nullable().optional(),
    stage: StageSchema.optional(),
    title: z.string().min(1).max(200),
    estimatedValueMinor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    destinationCity: z.string().max(100).nullable().optional(),
    travelStartDate: Dateish,
    travelEndDate: Dateish,
    paxCount: z.number().int().min(1).max(99).optional(),
    packageQuotationId: z.string().uuid().nullable().optional(),
    sourceChannel: z.enum(SOURCE_CHANNELS).optional(),
    isAiControlled: z.boolean().optional(),
  })
  .strict();
export type CreateOpportunityDto = z.infer<typeof CreateOpportunitySchema>;

export const UpdateOpportunitySchema = z
  .object({
    assignedUserId: z.string().uuid().nullable().optional(),
    stage: StageSchema.optional(),
    title: z.string().min(1).max(200).optional(),
    estimatedValueMinor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    destinationCity: z.string().max(100).nullable().optional(),
    travelStartDate: Dateish,
    travelEndDate: Dateish,
    paxCount: z.number().int().min(1).max(99).optional(),
    packageQuotationId: z.string().uuid().nullable().optional(),
    orderId: z.string().uuid().nullable().optional(),
    sourceChannel: z.enum(SOURCE_CHANNELS).optional(),
    isAiControlled: z.boolean().optional(),
    lostReason: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateOpportunityDto = z.infer<typeof UpdateOpportunitySchema>;

export const CreateInteractionSchema = z
  .object({
    customerId: z.string().uuid(),
    opportunityId: z.string().uuid().nullable().optional(),
    channel: z.enum(['WHATSAPP', 'VOICE_CALL', 'EMAIL', 'INTERNAL_NOTE', 'AI_SYSTEM_EVENT']),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']),
    summary: z.string().min(1).max(4000),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();
export type CreateInteractionDto = z.infer<typeof CreateInteractionSchema>;
