import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpThrottlerGuard } from './ip-throttler.guard.js';

const SECRET = 'p'.repeat(64);

/** Expone la clave del throttler sin levantar Nest. */
class Probe extends IpThrottlerGuard {
  tracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

const probe = new Probe({ throttlers: [] }, {} as never, {} as never);

describe('IpThrottlerGuard.getTracker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('dos usuarios que entran por el panel no comparten cupo', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const panel = (clientIp: string) => ({
      ip: '172.18.0.5',
      headers: { 'x-internal-proxy': SECRET, 'x-client-ip': clientIp },
    });
    const a = await probe.tracker(panel('190.24.8.9'));
    const b = await probe.tracker(panel('181.50.1.2'));
    expect(a).toBe('190.24.8.9');
    expect(b).toBe('181.50.1.2');
  });

  it('sin el secreto, x-client-ip no abre un cupo nuevo', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const forged = await probe.tracker({
      ip: '203.0.113.7',
      headers: { 'x-client-ip': '190.24.8.9', 'x-edge-peer-ip': '203.0.113.7' },
    });
    expect(forged).toBe('203.0.113.7');
  });
});
