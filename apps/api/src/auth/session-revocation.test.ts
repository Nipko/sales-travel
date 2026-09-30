import { describe, expect, it } from 'vitest';
import { reasonForRevocation } from './session-revocation.js';

describe('reasonForRevocation: revoked_reason → reason del 401', () => {
  it.each([
    ['idle_timeout', 'SESSION_IDLE'],
    ['replaced', 'SESSION_REPLACED'],
    ['admin_released', 'SESSION_RELEASED'],
    ['released_at_login', 'SESSION_RELEASED'],
  ])('%s → %s', (revokedReason, reason) => {
    expect(reasonForRevocation(revokedReason)).toBe(reason);
  });

  it.each([
    'logout',
    'logout_all',
    'password_changed',
    'password_reset',
    'mfa_reset',
    'mfa_enrolled',
    'mfa_disabled',
    'user_suspended',
    'membership_suspended',
    'tenant_switched',
    'revoked_by_user',
    'algo-que-no-existe',
  ])('%s → SESSION_REVOKED', (revokedReason) => {
    expect(reasonForRevocation(revokedReason)).toBe('SESSION_REVOKED');
  });

  it('sin motivo guardado → SESSION_REVOKED', () => {
    expect(reasonForRevocation(null)).toBe('SESSION_REVOKED');
  });
});
