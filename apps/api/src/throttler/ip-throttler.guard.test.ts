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

  it('directo al api: CF-Connecting-IP inventada en cada intento no abre cupo nuevo', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const keys = await Promise.all(
      ['1.1.1.1', '8.8.8.8', '9.9.9.9'].map((claimed) =>
        probe.tracker({
          ip: '172.18.0.2',
          headers: { 'x-edge-peer-ip': '203.0.113.7', 'cf-connecting-ip': claimed },
        }),
      ),
    );
    expect(new Set(keys)).toEqual(new Set(['203.0.113.7']));
  });

  it('el mismo usuario por el panel y directo al api cuenta contra el mismo cupo', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const panel = await probe.tracker({
      ip: '172.18.0.5',
      headers: { 'x-internal-proxy': SECRET, 'x-client-ip': '190.24.8.9' },
    });
    const direct = await probe.tracker({
      ip: '172.18.0.2',
      headers: { 'x-edge-peer-ip': '190.24.8.9' },
    });
    expect(panel).toBe(direct);
  });

  it('IPv6: toda la red /64 del usuario es un cupo', async () => {
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    const a = await probe.tracker({
      ip: '172.18.0.2',
      headers: { 'x-edge-peer-ip': '2800:e2:5c80:1a::1' },
    });
    const b = await probe.tracker({
      ip: '172.18.0.2',
      headers: { 'x-edge-peer-ip': '2800:e2:5c80:1a::2' },
    });
    expect(a).toBe('2800:e2:5c80:1a::/64');
    expect(b).toBe(a);
  });
});
