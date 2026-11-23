import { api } from '../../../../lib/api';
import { isValidHex } from '../../../../lib/brand-tokens';
import { getActiveTenant } from '../../../../lib/session';

/** La marca EFECTIVA de la agencia (con la herencia de la red), para lo que ve el cliente final. */
export interface AgencyBranding {
  name: string;
  color: string;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

interface TenantBrandingReply {
  logoUrl: string | null;
  primaryColor: string | null;
  commercialName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

/** El naranja de la plataforma, sólo si la red no configuró ninguna marca. */
const FALLBACK_COLOR = '#e8701a';

export async function agencyBranding(): Promise<AgencyBranding> {
  const tenantId = await getActiveTenant();
  const res = tenantId
    ? await api<TenantBrandingReply>(`/tenants/${tenantId}/branding`).catch(() => null)
    : null;
  const b = res?.ok ? res.data : null;
  return {
    name: b?.commercialName?.trim() || 'Tu agencia de viajes',
    color: isValidHex(b?.primaryColor) ? b.primaryColor : FALLBACK_COLOR,
    logoUrl: b?.logoUrl ?? null,
    supportEmail: b?.supportEmail ?? null,
    supportPhone: b?.supportPhone ?? null,
    websiteUrl: b?.websiteUrl ?? null,
  };
}
