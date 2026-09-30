import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OtpInput, type OtpInputProps } from './otp-input';
import { PasswordInput, type PasswordInputProps } from './password-input';

/*
 * El primer pintado de las primitivas de auth: lo que anuncia un lector de pantalla, lo que viaja en
 * el formulario y lo que necesita el teclado del teléfono. El comportamiento está en
 * `otp-input.test.ts` (lógica pura); acá, los atributos.
 */

function otp(props: Partial<OtpInputProps> = {}): string {
  return renderToStaticMarkup(createElement(OtpInput, { name: 'code', ...props }));
}

function inputsOf(html: string): string[] {
  return html.match(/<input[^>]*>/g) ?? [];
}

describe('OtpInput', () => {
  it('una casilla real por dígito, con nombre accesible propio', () => {
    const boxes = inputsOf(otp()).filter((i) => !i.includes('type="hidden"'));
    expect(boxes).toHaveLength(6);
    boxes.forEach((box, i) => {
      expect(box).toContain(`aria-label="Dígito ${i + 1} de 6"`);
    });
  });

  it('teclado numérico y autocompletado del código en cada casilla, sin maxLength', () => {
    for (const box of inputsOf(otp()).filter((i) => !i.includes('type="hidden"'))) {
      expect(box).toContain('inputMode="numeric"');
      expect(box).toContain('autoComplete="one-time-code"');
      expect(box).toContain('pattern="[0-9]*"');
      // maxLength=1 truncaría a un dígito el código que iOS pone entero en una casilla.
      expect(box).not.toMatch(/maxLength|maxlength/);
      // 20 px: por encima de los 16 px que evitan el zoom de iOS al enfocar.
      expect(box).toContain('text-xl');
    }
  });

  it('el valor viaja en un único input oculto con el name pedido', () => {
    const hidden = inputsOf(otp({ name: 'mfaCode' })).filter((i) => i.includes('type="hidden"'));
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toContain('name="mfaCode"');
    expect(hidden[0]).toContain('value=""');
  });

  it('es un grupo con nombre y descripción; la descripción también en la primera casilla', () => {
    const html = otp({ 'aria-describedby': 'mfa-help', id: 'code' });
    expect(html).toMatch(
      /<div role="group" aria-label="Código de verificación" aria-describedby="mfa-help"/,
    );
    const [first, second] = inputsOf(html);
    expect(first).toContain('id="code"');
    expect(first).toContain('aria-describedby="mfa-help"');
    expect(second).not.toContain('aria-describedby');
    expect(second).not.toMatch(/\sid="/);
  });

  it('con aria-labelledby no pisa el nombre con uno propio', () => {
    const html = otp({ 'aria-labelledby': 'mfa-title' });
    expect(html).toContain('aria-labelledby="mfa-title"');
    expect(html).not.toContain('aria-label="Código de verificación"');
  });

  it('deshabilitado e inválido se reflejan en cada casilla, no en el oculto', () => {
    const html = otp({ disabled: true, invalid: true });
    const boxes = inputsOf(html).filter((i) => !i.includes('type="hidden"'));
    for (const box of boxes) {
      expect(box).toContain('disabled=""');
      expect(box).toContain('aria-invalid="true"');
    }
    const hidden = inputsOf(html).find((i) => i.includes('type="hidden"'));
    // Un input deshabilitado no viaja en el formulario: el oculto nunca se deshabilita.
    expect(hidden).not.toContain('disabled');
  });

  it('otra longitud, otras casillas', () => {
    const boxes = inputsOf(otp({ length: 4 })).filter((i) => !i.includes('type="hidden"'));
    expect(boxes).toHaveLength(4);
    expect(boxes[3]).toContain('aria-label="Dígito 4 de 4"');
  });
});

function password(props: PasswordInputProps = {}): string {
  return renderToStaticMarkup(createElement(PasswordInput, props));
}

describe('PasswordInput', () => {
  it('arranca oculta, con un toggle de nombre fijo y estado en aria-pressed', () => {
    const html = password({ id: 'password', name: 'password' });
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<input[^>]*name="password"/);
    expect(html).toMatch(
      /<button type="button"[^>]*aria-label="Mostrar contraseña" aria-pressed="false" aria-controls="password"/,
    );
  });

  it('el aviso de Bloq Mayús vive siempre, vacío, en una región aria-live', () => {
    const html = password({ id: 'password' });
    expect(html).toMatch(/<p id="password-caps" aria-live="polite"[^>]*><\/p>/);
  });

  it('conserva la descripción que le pasan', () => {
    const html = password({ id: 'password', 'aria-describedby': 'password-error' });
    expect(html).toMatch(/<input[^>]*aria-describedby="password-error"/);
  });

  it('16 px en móvil para que iOS no haga zoom', () => {
    expect(password()).toMatch(/<input[^>]*class="[^"]*\btext-base\b/);
  });

  it('deshabilitada, también el toggle', () => {
    const html = password({ disabled: true });
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});
