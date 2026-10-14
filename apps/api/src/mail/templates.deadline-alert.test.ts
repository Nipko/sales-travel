import { describe, expect, it } from 'vitest';
import {
  TEST_CONTENT_NOTICE,
  TEST_CONTENT_SUBJECT_PREFIX,
  ticketingDeadlineAlertEmailHtml,
} from './templates.js';

/**
 * El aviso interno al vendedor de que vence el plazo de emisión de una reserva de vuelo (SAB-14):
 * el asunto con la hora, los datos justos (ruta, salida, nombres de pila), la hora de la oficina si
 * es otra, la cartera retenida si la hay, y la marca de prueba.
 */

const BASE = {
  orderNumber: 12,
  pnr: 'ABC123',
  threshold: '24h' as const,
  route: 'BOG → LIM',
  departureDate: '2026-10-20',
  firstNames: ['Ana', 'Luis'],
  clock: {
    source: 'agency' as const,
    when: 'mañana',
    day: 'jue 15 oct',
    time: '18:00',
    offset: 'GMT-5',
  },
  walletHeld: false,
  link: 'https://app.ejemplo.test/reservas?orden=o-1',
};

describe('ticketingDeadlineAlertEmailHtml', () => {
  it('el asunto dice la reserva y la hora; el cuerpo, qué pasa si no se emite', () => {
    const mail = ticketingDeadlineAlertEmailHtml(BASE);
    expect(mail.subject).toBe('La reserva #12 vence para emitir mañana a las 18:00');
    expect(mail.html).toContain('Plazo de emisión por vencer');
    expect(mail.html).toContain(
      'La reserva #12 todavía no tiene tiquete y vence para emitir mañana a las 18:00. Si no la emites antes, la aerolínea la cancela.',
    );
    expect(mail.html).toContain('#12 · PNR ABC123');
    expect(mail.html).toContain('BOG → LIM');
    expect(mail.html).toContain('2026-10-20');
    expect(mail.html).toContain('Ana, Luis');
    expect(mail.html).toContain('jue 15 oct, 18:00 (GMT-5, hora de tu agencia)');
    expect(mail.html).toContain('href="https://app.ejemplo.test/reservas?orden=o-1"');
    expect(mail.html).toContain('Abrir en Reservas');
    expect(mail.html).not.toContain('En la oficina emisora');
    expect(mail.html).not.toContain('saldo retenido');
    expect(mail.text).toContain('Vence: jue 15 oct, 18:00 (GMT-5, hora de tu agencia)');
    expect(mail.text).toContain('Abrir en Reservas: https://app.ejemplo.test/reservas?orden=o-1');
  });

  it('el de 2 h es urgente en el asunto, el título y el texto', () => {
    const mail = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      threshold: '2h',
      clock: { ...BASE.clock, when: 'hoy' },
    });
    expect(mail.subject).toBe('Urgente: la reserva #12 vence para emitir hoy a las 18:00');
    expect(mail.html).toContain('Plazo de emisión: menos de 2 horas');
    expect(mail.text).toContain('Quedan menos de 2 horas: la reserva #12');
  });

  it('con la oficina en otra hora, la suma aparte; sin agencia, dice de quién es la hora', () => {
    const mail = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      clock: {
        ...BASE.clock,
        time: '20:00',
        offset: 'GMT-3',
        office: { day: 'jue 15 oct', time: '18:00', offset: 'GMT-5' },
      },
    });
    expect(mail.html).toContain('En la oficina emisora');
    expect(mail.html).toContain('jue 15 oct, 18:00 (GMT-5)');
    expect(mail.text).toContain('En la oficina emisora: jue 15 oct, 18:00 (GMT-5)');

    const oficina = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      clock: { ...BASE.clock, source: 'office' },
    });
    expect(oficina.html).toContain('(GMT-5, hora de la oficina emisora)');
    const utc = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      clock: { ...BASE.clock, source: 'utc', offset: 'GMT' },
    });
    expect(utc.html).toContain('(GMT, UTC)');
  });

  it('con saldo retenido avisa que vencida sin emitir lo sigue reteniendo', () => {
    const mail = ticketingDeadlineAlertEmailHtml({ ...BASE, walletHeld: true });
    const aviso =
      'Esta reserva tiene saldo retenido en la cartera. Si vence sin emitir, el saldo sigue retenido hasta que la canceles en Reservas.';
    expect(mail.html).toContain(aviso);
    expect(mail.text).toContain(aviso);
  });

  it('una reserva de prueba avisa igual, marcada en el asunto y el cuerpo', () => {
    const mail = ticketingDeadlineAlertEmailHtml({ ...BASE, testContent: true });
    expect(mail.subject.startsWith(TEST_CONTENT_SUBJECT_PREFIX)).toBe(true);
    expect(mail.html).toContain(TEST_CONTENT_NOTICE);
    expect(mail.text.startsWith(TEST_CONTENT_NOTICE)).toBe(true);
  });

  it('sin PNR, ruta, salida ni nombres, las filas no salen vacías', () => {
    const mail = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      pnr: null,
      route: '',
      departureDate: '',
      firstNames: [],
    });
    expect(mail.html).not.toContain('PNR');
    expect(mail.html).not.toContain('>Ruta<');
    expect(mail.html).not.toContain('>Salida<');
    expect(mail.html).not.toContain('>Pasajeros<');
    expect(mail.text).not.toMatch(/\n\n\n/);
  });

  it('escapa lo que se interpola: un nombre o un enlace no inyectan HTML', () => {
    const mail = ticketingDeadlineAlertEmailHtml({
      ...BASE,
      firstNames: ['<script>x</script>'],
      link: 'https://app.ejemplo.test/reservas?orden=1"><img src=x>',
      brand: { name: 'Viajes <b>', color: 'red;background:url(x)' },
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('"><img');
    expect(mail.html).toContain('Enviado por Viajes &lt;b&gt;');
    expect(mail.html).not.toContain('url(x)');
  });
});
