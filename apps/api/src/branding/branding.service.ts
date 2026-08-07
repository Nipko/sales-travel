import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

export interface EffectiveBranding {
  /** Nombre de cara al cliente final. Cae al nombre legal del tenant si no hay comercial. */
  name: string;
  /** Color de marca en hex. null si ni el tenant ni sus ancestros configuraron uno. */
  color: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Identidad efectiva de un tenant, con la herencia de 0030 ya resuelta.
 *
 * Existe para que los artefactos que ve el CLIENTE FINAL —correos, PDF, vouchers— lleven
 * la marca de SU agencia y no la del consolidador. Antes las plantillas hardcodeaban
 * "PlaneTour" y un índigo #4f46e5, así que cada agencia de la red le mandaba a su cliente
 * documentos con la marca de otro.
 *
 * Global porque lo necesitan quotations, orders, auth e invitations por igual.
 */
@Injectable()
export class BrandingService {
  constructor(private readonly db: DatabaseService) {}

  async resolve(tenantId: string | null | undefined): Promise<EffectiveBranding | null> {
    if (!tenantId) return null;

    try {
      const res = await sql<{
        logo_url: string | null;
        primary_color: string | null;
        commercial_name: string | null;
        support_email: string | null;
        support_phone: string | null;
        website_url: string | null;
      }>`SELECT * FROM resolve_tenant_branding(${tenantId}::uuid)`.execute(this.db.db);

      const row = res.rows[0];
      if (!row?.commercial_name) return null;

      return {
        name: row.commercial_name,
        // Se descarta cualquier valor que no sea hex estricto: estos valores se
        // interpolan en HTML de correo y en estilos del PDF.
        color: row.primary_color && HEX.test(row.primary_color) ? row.primary_color : null,
        logoUrl: row.logo_url,
        supportEmail: row.support_email,
        supportPhone: row.support_phone,
        websiteUrl: row.website_url,
      };
    } catch {
      // El branding es decorativo: nunca debe impedir que salga un correo o una reserva.
      return null;
    }
  }
}
