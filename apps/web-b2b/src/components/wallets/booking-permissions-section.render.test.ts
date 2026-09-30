import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BookingPermissionsSection } from './booking-permissions-section';
import { NonRefundableRatesDialog } from './wallet-dialogs';

describe('BookingPermissionsSection en su primer pintado', () => {
  it('se titula y anuncia que está cargando, sin ofrecer cambiar nada todavía', () => {
    const html = renderToStaticMarkup(
      createElement(BookingPermissionsSection, {
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    );
    expect(html).toContain('Tarifas no reembolsables');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="switch"');
  });
});

describe('NonRefundableRatesDialog', () => {
  function dialog(to: 'allowed' | 'blocked', inheritedBlock = false): string {
    return renderToStaticMarkup(
      createElement(NonRefundableRatesDialog, {
        nodeName: 'Agencia Sur',
        to,
        inheritedBlock,
        onSubmit: () => Promise.resolve(undefined),
        onClose: () => undefined,
      }),
    );
  }

  it('bloquear: dice qué pasa, pide motivo y no toca lo ya reservado', () => {
    const html = dialog('blocked');
    expect(html).toContain('Bloquear tarifas no reembolsables');
    expect(html).toContain('Las reservas ya hechas no cambian.');
    expect(html).toContain('Motivo');
    expect(html).toContain('>Bloquear<');
  });

  it('permitir con un bloqueo de arriba: avisa que no alcanza', () => {
    const html = dialog('allowed', true);
    expect(html).toContain('Permitir tarifas no reembolsables');
    expect(html).toContain('confirmación obligatoria');
    expect(html).toContain('Un nivel de arriba de la red las tiene bloqueadas');
    expect(dialog('allowed')).not.toContain('Un nivel de arriba');
  });
});
