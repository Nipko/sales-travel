import { describe, expect, it } from 'vitest';
import { voseoIn } from '../__fixtures__/voseo.js';
import {
  SECURITY_NOTICE_CLOSING,
  SECURITY_NOTICE_KINDS,
  noticeTime,
  securityNoticeEmail,
  type SecurityNoticeKind,
} from './security-notices.js';

const NODO = 'Viajes Sur';

/** Lo que se espera de cada aviso: el asunto exacto y una frase del cuerpo. */
const ESPERADO: Record<SecurityNoticeKind, { subject: string; body: string }> = {
  mfa_reset: {
    subject: 'Restablecimos tu verificación en dos pasos · PlaneTour',
    body: 'Un administrador de Viajes Sur restableció tu verificación en dos pasos. Al próximo ingreso puedes configurarla de nuevo.',
  },
  mfa_enabled: {
    subject: 'Activaste la verificación en dos pasos · PlaneTour',
    body: 'Activaste la verificación en dos pasos en tu cuenta de PlaneTour.',
  },
  mfa_changed: {
    subject: 'Cambiaste tu app de autenticación · PlaneTour',
    body: 'Cambiaste la app de autenticación de tu cuenta de PlaneTour.',
  },
  mfa_disabled: {
    subject: 'Desactivaste la verificación en dos pasos · PlaneTour',
    body: 'Desde ahora, para ingresar basta con tu contraseña.',
  },
  sessions_revoked: {
    subject: 'Cerramos tus sesiones abiertas · PlaneTour',
    body: 'Un administrador de Viajes Sur cerró tus sesiones. Puedes volver a ingresar con tu contraseña.',
  },
  session_revoked: {
    subject: 'Cerramos una de tus sesiones · PlaneTour',
    body: 'Un administrador de Viajes Sur cerró una de tus sesiones; las demás siguen abiertas.',
  },
  unlocked: {
    subject: 'Desbloqueamos tu cuenta · PlaneTour',
    body: 'Un administrador de Viajes Sur levantó el bloqueo por intentos fallidos.',
  },
  role_changed: {
    subject: 'Tu rol en Viajes Sur cambió · PlaneTour',
    body: 'Ahora eres Admin de agencia en Viajes Sur.',
  },
  membership_suspended: {
    subject: 'Tu acceso a Viajes Sur fue suspendido · PlaneTour',
    body: 'Un administrador suspendió tu acceso a Viajes Sur',
  },
  membership_reactivated: {
    subject: 'Tu acceso a Viajes Sur fue reactivado · PlaneTour',
    body: 'Un administrador reactivó tu acceso a Viajes Sur.',
  },
  membership_removed: {
    subject: 'Ya no formas parte de Viajes Sur · PlaneTour',
    body: 'para volver, necesitas una invitación nueva.',
  },
  account_suspended: {
    subject: 'Tu cuenta de PlaneTour fue suspendida',
    body: 'Un administrador de la plataforma suspendió tu cuenta',
  },
  account_reactivated: {
    subject: 'Tu cuenta de PlaneTour fue reactivada',
    body: 'Un administrador de la plataforma reactivó tu cuenta.',
  },
  password_changed: {
    subject: 'Tu contraseña cambió · PlaneTour',
    body: 'La contraseña de tu cuenta de PlaneTour cambió y cerramos las sesiones que tenías abiertas con la anterior.',
  },
};

function aviso(kind: SecurityNoticeKind, nodeName: string | null = NODO, personName = 'Ana') {
  return securityNoticeEmail(kind, { nodeName, personName, role: 'agency_admin' });
}

describe('avisos de seguridad: qué dice cada uno', () => {
  it.each(SECURITY_NOTICE_KINDS)('%s: asunto, saludo, cuerpo y la línea final', (kind) => {
    const { subject, text, html } = aviso(kind);

    expect(subject).toBe(ESPERADO[kind].subject);
    expect(text).toContain(ESPERADO[kind].body);
    expect(text.startsWith(`${subject.replace(' · PlaneTour', '')}\n\nHola, Ana:\n\n`)).toBe(true);
    // Todo cuerpo termina igual: quien no lo esperaba sabe qué hacer.
    expect(text.endsWith(`\n\n${SECURITY_NOTICE_CLOSING}`)).toBe(true);
    expect(html).toContain(ESPERADO[kind].body);
    expect(html).toContain(SECURITY_NOTICE_CLOSING);
  });

  it.each(SECURITY_NOTICE_KINDS)('%s: en tú', (kind) => {
    const { subject, text, html } = aviso(kind);
    expect(voseoIn(`${subject}\n${html}\n${text}`)).toEqual([]);
  });

  it.each(SECURITY_NOTICE_KINDS)('%s: sin enlaces ni nada que parezca un token', (kind) => {
    const { subject, text, html } = aviso(kind);
    for (const part of [subject, text, html]) {
      expect(part).not.toMatch(/https?:|www\.|href|token/i);
    }
  });

  it('la lista de avisos no tiene repetidos', () => {
    expect(new Set(SECURITY_NOTICE_KINDS).size).toBe(SECURITY_NOTICE_KINDS.length);
  });

  it('restablecer el 2FA cuenta todo lo que arrastró: códigos, equipos de confianza y sesiones', () => {
    expect(aviso('mfa_reset').text).toContain(
      'Tus códigos de recuperación y tus equipos de confianza ya no sirven, y cerramos tus sesiones abiertas.',
    );
  });

  it('cambiar el rol: el nombre con que Equipo lo ofrece, y si exige 2FA, lo dice', () => {
    const admin = securityNoticeEmail('role_changed', { nodeName: NODO, role: 'tenant_admin' });
    expect(admin.text).toContain('Ahora eres Admin en Viajes Sur.');
    expect(admin.text).toContain('Este rol exige verificación en dos pasos');

    const consolidador = securityNoticeEmail('role_changed', {
      nodeName: NODO,
      role: 'consolidator_admin',
    });
    expect(consolidador.text).toContain('Ahora eres Admin de consolidador en Viajes Sur.');

    const vendedor = securityNoticeEmail('role_changed', { nodeName: NODO, role: 'vendedor' });
    expect(vendedor.text).toContain('Ahora eres Vendedor en Viajes Sur.');
    expect(vendedor.text).not.toContain('dos pasos');

    const manager = securityNoticeEmail('role_changed', { nodeName: NODO, role: 'admin' });
    expect(manager.text).toContain('Ahora eres Manager en Viajes Sur.');

    const sinRol = securityNoticeEmail('role_changed', { nodeName: NODO });
    expect(sinRol.text).toContain('Un administrador cambió tu rol en Viajes Sur.');
    expect(sinRol.text).not.toContain('Ahora eres');
  });

  it('la contraseña cambiada dice qué hacer si no fue la persona, sin nombrar un nodo', () => {
    const { text } = aviso('password_changed');
    // El texto del enlace tal como lo muestra la pantalla de ingreso (credentials-step.tsx).
    expect(text).toContain('Si no fuiste tú, elige una nueva desde «¿Olvidaste tu contraseña?»');
    expect(text).not.toContain(NODO);
  });

  it('activar el 2FA: cuándo, en la zona del país de su correo y con el desfase, y qué hacer si no fue', () => {
    const at = new Date('2026-10-13T15:42:10Z');
    const co = securityNoticeEmail('mfa_enabled', {
      personName: 'Ana',
      nodeName: NODO,
      at,
      countryCode: 'CO',
    });
    expect(co.text).toContain(
      'Activaste la verificación en dos pasos en tu cuenta de PlaneTour el 13 de octubre de 2026 a las 10:42 (GMT-5).',
    );
    expect(co.html).toContain('el 13 de octubre de 2026 a las 10:42 (GMT-5).');
    expect(co.text).toContain(
      'Si no fuiste tú, alguien conoce tu contraseña: elige una nueva desde «¿Olvidaste tu contraseña?»',
    );
    expect(co.text).toContain('pídele a tu administrador que restablezca tu verificación');
    expect(co.text).toContain('Si tenías sesiones abiertas en otros equipos, las cerramos.');
    // Lo hizo la persona, no un admin: no nombra ningún nodo.
    expect(co.text).not.toContain('Un administrador');
    expect(co.text).not.toContain(NODO);

    expect(securityNoticeEmail('mfa_enabled', { at, countryCode: 'br' }).text).toContain(
      'a las 12:42 (GMT-3).',
    );
    // Sin país conocido, la hora de Bogotá, pero siempre con el desfase.
    for (const countryCode of [null, 'ZZ']) {
      expect(securityNoticeEmail('mfa_enabled', { at, countryCode }).text).toContain(
        'a las 10:42 (GMT-5).',
      );
    }
  });

  it('cambiar de app y desactivar el 2FA: cuándo, qué dejó de servir y qué hacer si no fue', () => {
    const at = new Date('2026-10-13T15:42:10Z');
    const changed = securityNoticeEmail('mfa_changed', {
      personName: 'Ana',
      nodeName: NODO,
      at,
      countryCode: 'PE',
    });
    expect(changed.text).toContain(
      'Cambiaste la app de autenticación de tu cuenta de PlaneTour el 13 de octubre de 2026 a las 10:42 (GMT-5).',
    );
    expect(changed.text).toContain('La app anterior ya no sirve para ingresar');
    expect(changed.text).toContain('pídele a tu administrador que restablezca tu verificación');

    const disabled = securityNoticeEmail('mfa_disabled', { at, countryCode: 'BR' });
    expect(disabled.text).toContain(
      'Desactivaste la verificación en dos pasos en tu cuenta de PlaneTour el 13 de octubre de 2026 a las 12:42 (GMT-3).',
    );
    expect(disabled.text).toContain(
      'elige una nueva desde «¿Olvidaste tu contraseña?» en la pantalla de ingreso y vuelve a activarla en Mi cuenta → Seguridad.',
    );
    for (const { text } of [changed, disabled]) {
      // Lo hizo la persona, no un admin: no nombra ningún nodo.
      expect(text).not.toContain('Un administrador');
      expect(text).not.toContain(NODO);
      expect(voseoIn(text)).toEqual([]);
    }
  });

  it('noticeTime: el día que cambia con la zona', () => {
    const at = new Date('2026-10-14T02:30:00Z');
    expect(noticeTime(at, 'PE')).toBe('13 de octubre de 2026 a las 21:30 (GMT-5)');
    expect(noticeTime(at, 'BR')).toBe('13 de octubre de 2026 a las 23:30 (GMT-3)');
    expect(noticeTime(at, 'MX')).toBe('13 de octubre de 2026 a las 20:30 (GMT-6)');
  });

  it('suspender el acceso a un nodo aclara que los demás nodos siguen igual', () => {
    expect(aviso('membership_suspended').text).toContain(
      'Si trabajas en otros nodos, tu acceso a ellos no cambia.',
    );
  });
});

describe('avisos de seguridad: lo que escriben otros no inyecta nada', () => {
  const HOSTIL = '<a href="https://phish.example">Viajes</a> & "Cía"';

  it.each(SECURITY_NOTICE_KINDS)(
    '%s: el nombre del nodo y el de la persona van escapados en el HTML',
    (kind) => {
      const { html } = securityNoticeEmail(kind, {
        nodeName: HOSTIL,
        personName: '<img src=x onerror=alert(1)>',
        role: 'vendedor',
      });

      expect(html).not.toContain('<a href');
      expect(html).not.toContain('<img');
      expect(html).toContain('Hola, &lt;img src=x onerror=alert(1)&gt;:');
    },
  );

  it('en un aviso que nombra el nodo, el nombre escapado aparece entero', () => {
    const { html, text } = securityNoticeEmail('unlocked', { nodeName: HOSTIL });
    expect(html).toContain(
      'Un administrador de &lt;a href=&quot;https://phish.example&quot;&gt;Viajes&lt;/a&gt; &amp; &quot;Cía&quot; levantó',
    );
    // El texto plano no interpreta markup: va tal cual.
    expect(text).toContain(`Un administrador de ${HOSTIL} levantó`);
  });

  it('un salto de línea en el nombre del nodo no llega al asunto', () => {
    const { subject, text } = securityNoticeEmail('role_changed', {
      nodeName: 'Agencia\r\nBcc: todos@example.com',
      role: 'vendedor',
    });
    expect(subject).toBe('Tu rol en Agencia Bcc: todos@example.com cambió · PlaneTour');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text).not.toContain('\r');
  });

  it('sin nombre de nodo legible dice "la plataforma"; sin nombre de la persona, "Hola:"', () => {
    for (const nodeName of [null, '', ' \u0000 ']) {
      const { subject, text } = securityNoticeEmail('membership_suspended', {
        nodeName,
        personName: '\u0007',
      });
      expect(subject).toBe('Tu acceso a la plataforma fue suspendido · PlaneTour');
      expect(text).toContain('\n\nHola:\n\n');
    }
    expect(securityNoticeEmail('unlocked').text).toContain(
      'Un administrador de la plataforma levantó el bloqueo',
    );
  });
});
