import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  fieldKey,
  prefillFromAccount,
  prepareAccountSubmission,
  statusNotice,
  type ProviderForm,
} from '../../../../../lib/provider-forms';
import {
  ProviderAccountSheet,
  providerFieldId,
  type ProviderAccountSheetProps,
} from './provider-account-sheet';

/*
 * El editor de credenciales de cada proveedor en su primer pintado: las cuatro secciones, los
 * secretos enmascarados con su botón de mostrar, y los errores cableados a su campo.
 */

const noop = () => undefined;

function form(code: string): ProviderForm {
  const f = PROVIDERS[code];
  if (!f) throw new Error(`sin forma para ${code}`);
  return f;
}

function editNoticeFor(provider: ProviderForm) {
  const prefill = prefillFromAccount(provider, {
    label: 'default',
    status: 'active',
    isInheritable: true,
    config: {},
  });
  return prepareAccountSubmission(
    provider,
    { label: 'default', status: 'active', sections: { credentials: {}, config: prefill.config } },
    {
      resolved: null,
      tenantName: 'Planetour',
      ownerName: 'Planetour',
      editing: { label: 'default', droppedConfigKeys: [] },
    },
  ).edit?.notice;
}

function render(code: string, over: Partial<ProviderAccountSheetProps> = {}): string {
  const provider = form(code);
  return renderToStaticMarkup(
    createElement(ProviderAccountSheet, {
      mode: 'edit',
      provider,
      tenantName: 'Planetour',
      accountLabel: 'default',
      editNotice: editNoticeFor(provider) ?? null,
      ownershipNotice: null,
      warnings: [],
      credentials: {},
      config: {},
      fieldErrors: {},
      status: 'active',
      isInheritable: true,
      error: '',
      saving: false,
      dirty: false,
      focusRequest: 0,
      onCredentialChange: noop,
      onConfigChange: noop,
      onStatusChange: noop,
      onInheritableChange: noop,
      onSave: noop,
      onClose: noop,
      ...over,
    }),
  );
}

function inputTag(html: string, id: string): string {
  return new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
}

describe('ProviderAccountSheet — un solo patrón para todos los proveedores', () => {
  it.each(Object.keys(PROVIDERS))('%s: título, agencia y todos sus campos', (code) => {
    const provider = form(code);
    const html = render(code);
    expect(html).toContain(`Editar variables · ${provider.label}`);
    expect(html).toContain('Planetour');
    for (const field of provider.credentials) {
      expect(inputTag(html, providerFieldId('credentials', field.key))).not.toBe('');
    }
    for (const field of provider.config) {
      expect(inputTag(html, providerFieldId('config', field.key))).not.toBe('');
    }
    // Cabecera, cuerpo con scroll y pie: el mismo panel para todos.
    expect(html).toContain('data-sheet-body');
    expect(html).toContain('<footer');
  });

  it('secciones en el orden en que se decide, cada una con su encabezado', () => {
    const html = render('latam-ndc');
    const order = [
      'Reescribe la cuenta «default» entera',
      '>Credenciales<',
      '>Configuración<',
      '>Estado y herencia<',
    ].map((text) => html.indexOf(text));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Cada sección se anuncia por su encabezado.
    for (const title of ['Credenciales', 'Configuración', 'Estado y herencia']) {
      const id = new RegExp(`<h3 id="([^"]+)"[^>]*>${title}</h3>`).exec(html)?.[1];
      expect(id, title).toBeTruthy();
      expect(html).toContain(`<section aria-labelledby="${id}"`);
    }
  });

  it('el aviso de reescritura es parte de la descripción del diálogo', () => {
    const html = render('latam-ndc');
    const described = /role="dialog"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? '';
    const noticeId = described.split(' ')[1];
    expect(noticeId).toBeTruthy();
    expect(html).toMatch(
      new RegExp(`<span id="${noticeId}"[^>]*>Reescribe la cuenta «default» entera</span>`),
    );
  });

  it('el aviso de reescritura abre plegado; desplegado si además se pierde algo', () => {
    const notice = (html: string) =>
      /<details[^>]*>(?:(?!<\/details>).)*Reescribe la cuenta/.exec(html)?.[0] ?? '';
    expect(notice(render('latam-ndc'))).not.toContain(' open=""');
    expect(notice(render('latam-ndc'))).toContain('<summary');
    expect(notice(render('latam-ndc', { editNoticeExpanded: true }))).toContain(' open=""');
  });

  it('la guía del proveedor se lee abierta al conectarlo y plegada al editarlo', () => {
    const guide = (html: string) =>
      /<details[^>]*>(?:(?!<\/details>).)*Cómo se conecta TBO Holidays/.exec(html)?.[0] ?? '';
    expect(guide(render('tbo-hotels'))).not.toContain(' open=""');
    expect(
      guide(render('tbo-hotels', { mode: 'create', editNotice: null, accountLabel: undefined })),
    ).toContain(' open=""');
  });

  it('un alta no lleva aviso de reescritura y se titula Conectar', () => {
    const html = render('sabre', { mode: 'create', editNotice: null, accountLabel: undefined });
    expect(html).toContain('Conectar Sabre');
    expect(html).not.toContain('Reescribe la cuenta');
    expect(html).toContain('Se guardan cifradas y no se vuelven a mostrar.');
  });

  it('al editar dice que las credenciales se vuelven a cargar completas', () => {
    expect(render('latam-ndc')).toContain(
      'Las guardadas no se muestran: vuelve a cargarlas completas para guardar.',
    );
  });

  it('los secretos van enmascarados, sin autocompletar, con un botón de mostrar', () => {
    const html = render('latam-ndc');
    for (const key of ['apiKey', 'apiSecret']) {
      const id = providerFieldId('credentials', key);
      const tag = inputTag(html, id);
      expect(tag).toContain('type="password"');
      expect(tag).toContain('autoComplete="new-password"');
      expect(tag).toContain('autoCapitalize="none"');
      expect(tag).toContain('spellCheck="false"');
      expect(html).toMatch(
        new RegExp(
          `<button type="button" aria-label="Mostrar [^"]+" aria-pressed="false" aria-controls="${id}"`,
        ),
      );
    }
    // Un campo que no es secreto no lleva botón de mostrar.
    expect(inputTag(html, providerFieldId('credentials', 'agencyId'))).toContain('type="text"');
    expect(html).not.toContain(`aria-controls="${providerFieldId('credentials', 'agencyId')}"`);
  });

  it('un error de campo queda cableado: aria-invalid y aria-describedby a su mensaje', () => {
    const id = providerFieldId('credentials', 'epr');
    const html = render('sabre', {
      fieldErrors: { [fieldKey('credentials', 'epr')]: 'Falta el EPR.' },
      error: 'Revisa 1 campo antes de guardar.',
    });
    const tag = inputTag(html, id);
    expect(tag).toContain('aria-invalid="true"');
    expect(tag).toMatch(new RegExp(`aria-describedby="[^"]*${id}-error`));
    expect(html).toContain(`<p id="${id}-error"`);
    expect(html).toContain('Falta el EPR.');
    // El resumen va en el pie, a la vista junto a Guardar, y se anuncia.
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toMatch(/role="alert"[^>]*>.*Revisa 1 campo antes de guardar\./);
  });

  it('los obligatorios se anuncian aunque el asterisco sea decorativo', () => {
    const tag = inputTag(render('sabre'), providerFieldId('credentials', 'epr'));
    expect(tag).toContain('aria-required="true"');
  });

  it('el botón de guardar dice qué pasa con el estado elegido', () => {
    expect(render('sabre', { status: 'active' })).toContain('Guardar y activar');
    expect(render('sabre', { status: 'sandbox' })).toContain('Guardar en Sandbox');
    expect(render('sabre', { status: 'sandbox' })).toContain(statusNotice('sandbox').title);
  });

  it('guardando: deshabilitado y "Guardando…"', () => {
    const html = render('tbo-hotels', { saving: true });
    expect(html).toContain('Guardando…');
    expect(html).toContain('aria-busy="true"');
  });

  it('las URLs ocupan el ancho completo en escritorio', () => {
    const html = render('latam-ndc');
    const id = providerFieldId('config', 'apiUrl');
    expect(html).toMatch(new RegExp(`<div class="[^"]*sm:col-span-2[^"]*"><label for="${id}"`));
  });

  it('en el teléfono los campos van a 16 px y 40 px de alto: sin zoom de iOS al enfocar', () => {
    const html = render('latam-ndc');
    for (const id of [
      providerFieldId('credentials', 'apiKey'),
      providerFieldId('credentials', 'agencyId'),
    ]) {
      const classes = (/class="([^"]*)"/.exec(inputTag(html, id))?.[1] ?? '').split(' ');
      expect(classes).toContain('text-base');
      expect(classes).toContain('h-10');
      expect(classes).toContain('sm:text-sm');
    }
    // El botón de mostrar un secreto: 44 px de ancho, el alto del campo.
    const reveal = /<button type="button" aria-label="Mostrar [^"]+"[^>]*>/.exec(html)?.[0] ?? '';
    expect((/class="([^"]*)"/.exec(reveal)?.[1] ?? '').split(' ')).toContain('w-11');
  });

  it('proveedor y etiqueta: una sección Cuenta primero, el proveedor sólo al conectar', () => {
    const picker = {
      value: 'sabre',
      options: Object.entries(PROVIDERS),
      onChange: noop,
    };
    const labelField = { value: 'default', onChange: noop };
    const create = render('sabre', {
      mode: 'create',
      editNotice: null,
      accountLabel: undefined,
      providerPicker: picker,
      labelField,
    });
    expect(create).toContain('>Cuenta<');
    expect(create.indexOf('>Cuenta<')).toBeLessThan(create.indexOf('>Credenciales<'));
    expect(inputTag(create, 'byoc-account-provider')).not.toBe('');
    expect(inputTag(create, 'byoc-account-label')).toContain('value="default"');

    // Al editar el proveedor no se cambia: cambiarlo daría de alta otra cuenta.
    const edit = render('sabre', { providerPicker: picker, labelField });
    expect(inputTag(edit, 'byoc-account-provider')).toBe('');
    expect(inputTag(edit, 'byoc-account-label')).not.toBe('');
    expect(edit).toContain('Si la cambias, se crea otra cuenta y «default» queda como está.');
  });

  it('sin proveedor ni etiqueta editables, no hay sección Cuenta', () => {
    expect(render('sabre')).not.toContain('>Cuenta<');
  });

  it('la consecuencia para la red va con el estado; el rechazo por reservas vivas, en el pie', () => {
    const html = render('tbo-hotels', {
      inheritableHelp: 'Esta agencia todavía no tiene sub-agencias.',
      consequenceNotice: { tone: 'ok', title: 'Pasa a resolver la suya', body: 'Detalle.' },
      saveNotice: { tone: 'warn', title: 'La cuenta tiene reservas vivas', body: 'Espera.' },
    });
    expect(html).toContain('Esta agencia todavía no tiene sub-agencias.');
    const body = html.slice(html.indexOf('data-sheet-body'), html.indexOf('<footer'));
    expect(body).toContain('Pasa a resolver la suya');
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toMatch(/<div role="alert">.*La cuenta tiene reservas vivas/);
  });

  it('la herencia es una casilla con su etiqueta y su ayuda', () => {
    const html = render('latam-ndc', { isInheritable: false });
    const checkbox = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(checkbox).not.toContain('checked');
    const id = /id="([^"]+)"/.exec(checkbox)?.[1];
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain('Heredable por la red');
    expect(checkbox).toMatch(/aria-describedby="[^"]+"/);
  });
});
