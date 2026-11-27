import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { BlobsController } from './blobs.controller.js';
import type { LocalDiskStorageAdapter } from './local-disk-storage.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOGO = 'logo-0123456789abcdef.png';

function banco() {
  const get = vi.fn(() => Promise.resolve(Buffer.from('png')));
  const controller = new BlobsController({ get } as unknown as LocalDiskStorageAdapter);
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    send: vi.fn(),
  } as unknown as Response;
  return { controller, get, res, headers };
}

describe('BlobsController (QA-H-38)', () => {
  it('sirve el logo con el tipo de su extensión y nosniff', async () => {
    const b = banco();
    await b.controller.brandAsset(TENANT, LOGO, b.res);
    expect(b.get).toHaveBeenCalledWith(`tenants/${TENANT}/${LOGO}`);
    expect(b.headers['Content-Type']).toBe('image/png');
    expect(b.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it.each([
    ['tenant que no es uuid', '..', LOGO],
    ['archivo con ruta', TENANT, '../../etc/passwd'],
    ['sidecar de tipo', TENANT, `${LOGO}.type`],
    ['extensión no admitida', TENANT, 'logo-0123456789abcdef.html'],
    ['otro nombre', TENANT, 'secreto-0123456789abcdef.png'],
  ])('%s: 404 sin tocar el disco', async (_caso, tenant, file) => {
    const b = banco();
    await expect(b.controller.brandAsset(tenant, file, b.res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(b.get).not.toHaveBeenCalled();
  });
});
