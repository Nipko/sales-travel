/**
 * El estado de los proveedores que usa la agencia (`GET /search/provider-status`, 0096): la regla
 * vive en el API; aquí sólo se valida y se rotula. Lo usan la pastilla de la barra superior y el
 * bloque Hoy del Inicio.
 */

export type ProviderStatusKind = 'ok' | 'provider' | 'paused' | 'internal' | 'idle';

export interface ProviderStatus {
  readonly providerCode: string;
  readonly vertical: string;
  readonly status: ProviderStatusKind;
  readonly message: string;
}

const KINDS: readonly ProviderStatusKind[] = ['ok', 'provider', 'paused', 'internal', 'idle'];
/** Lo más grave manda. */
const SEVERITY: Record<ProviderStatusKind, number> = {
  internal: 4,
  provider: 3,
  paused: 2,
  ok: 1,
  idle: 0,
};

export const PROVIDER_STATUS_LABEL: Record<ProviderStatusKind, string> = {
  ok: 'Operando',
  idle: 'Sin uso reciente',
  paused: 'En pausa',
  provider: 'Falla del proveedor',
  internal: 'Falla nuestra',
};

export function parseProviderStatus(body: unknown): ProviderStatus[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { providers?: unknown }).providers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): ProviderStatus[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const r = raw as Record<string, unknown>;
    const status = r['status'];
    if (
      typeof r['providerCode'] !== 'string' ||
      typeof r['vertical'] !== 'string' ||
      typeof status !== 'string' ||
      !KINDS.includes(status as ProviderStatusKind)
    ) {
      return [];
    }
    return [
      {
        providerCode: r['providerCode'],
        vertical: r['vertical'],
        status: status as ProviderStatusKind,
        message: typeof r['message'] === 'string' ? r['message'] : '',
      },
    ];
  });
}

/** El estado más grave de la lista. */
export function worstStatus(
  providers: readonly { status: ProviderStatusKind }[],
): ProviderStatusKind {
  return providers.reduce<ProviderStatusKind>(
    (acc, p) => (SEVERITY[p.status] > SEVERITY[acc] ? p.status : acc),
    'idle',
  );
}
