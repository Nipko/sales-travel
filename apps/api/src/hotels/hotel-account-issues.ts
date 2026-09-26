import type { AuditEvent } from '../audit/audit.service.js';
import {
  supportsHotelAccountIssues,
  type HotelProviderAccountFingerprint,
  type ResolvedHotelProvider,
} from '../providers/hotel-provider.types.js';
import { HOTEL_EVENTS } from './hotel-events.js';

export interface HotelAccountIssueInput {
  readonly provider: Pick<
    ResolvedHotelProvider,
    'code' | 'adapter' | 'credentialSource' | 'accountOwnerTenantId'
  >;
  readonly err: unknown;
  /** Quien vendía: el dueño tiene que saber qué agencia de su red se quedó sin poder reservar. */
  readonly sellerTenantId: string;
  readonly actorUserId?: string;
  readonly stage: 'prebook' | 'book';
  readonly orderId?: string;
}

/** La cuenta con que salió el adapter, si la expone. */
function accountOf(adapter: object): string | undefined {
  return (adapter as { searchAccount?: HotelProviderAccountFingerprint }).searchAccount?.accountId;
}

/**
 * El `ProviderAccountIssueDetected` de un rechazo del proveedor, o `undefined` si el error no es de
 * la cuenta (RF-23; docs/tbo/03 §6).
 *
 * Va al tenant DUEÑO de la cuenta: con una cuenta heredada, la sub-agencia no puede cargar saldo en
 * el proveedor ni debe enterarse del de su consolidador, y los eventos de un ancestro no le son
 * visibles (`domain_events_subtree_read`, 0029). El payload no lleva importes ni texto del
 * proveedor: el saldo no lo conocemos, y el mensaje del proveedor podría citarlo.
 *
 * Sin dueño conocido no hay evento: `AuditService` pondría el tenant del request, que es justo la
 * agencia que no tiene que verlo.
 */
export function providerAccountIssueEvent(input: HotelAccountIssueInput): AuditEvent | undefined {
  const { provider } = input;
  if (!supportsHotelAccountIssues(provider.adapter)) return undefined;
  const issue = provider.adapter.accountIssueOf(input.err);
  const owner = provider.accountOwnerTenantId;
  if (issue === undefined || owner === undefined) return undefined;
  const accountId = accountOf(provider.adapter);
  return {
    eventType: HOTEL_EVENTS.providerAccountIssue,
    tenantId: owner,
    ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
    aggregateType: 'provider_account',
    ...(accountId === undefined ? {} : { aggregateId: accountId }),
    payload: {
      provider: provider.code,
      vertical: 'hotels',
      reason: issue,
      stage: input.stage,
      credentialSource: provider.credentialSource,
      sellerTenantId: input.sellerTenantId,
      ...(accountId === undefined ? {} : { providerAccountId: accountId }),
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
    },
  };
}
