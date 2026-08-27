import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_LABEL,
  PROVIDERS,
  accountCertainty,
  accountCertaintyNotice,
  accountConfigSummary,
  buildProviderAccountPayload,
  fieldKey,
  inheritableHelp,
  normalizeAccountLabel,
  prefillFromAccount,
  prepareAccountSubmission,
  providerFormFor,
  statusEnablesProvider,
  statusNotice,
  validateProviderDraft,
  type AccountSubmission,
  type DraftSections,
  type ProviderAccountStatus,
  type ProviderForm,
  type ResolvedAccountRef,
  type SavedAccountView,
} from './provider-forms';

function sabre(): ProviderForm {
  const form = providerFormFor('sabre');
  if (!form) throw new Error('el panel tiene que conocer el proveedor "sabre"');
  return form;
}

/** Borrador mínimo que SÍ pasa: las tres credenciales que el ACL exige. */
function validSabreDraft(): DraftSections {
  return {
    credentials: { epr: '1234567', password: 'sup3rsecreta', homePcc: 'AB1C' },
    config: {},
  };
}

describe('catálogo de proveedores', () => {
  it('incluye a Sabre junto a los dos que ya estaban', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['agent-cars', 'latam-ndc', 'sabre']);
  });

  it('no inventa un formulario para un código desconocido', () => {
    // Sin fallback: caer a otro proveedor guardaría la credencial con la forma equivocada.
    expect(providerFormFor('amadeus')).toBeUndefined();
  });

  it('reparte las mitades de Sabre como las lee el factory', () => {
    const form = sabre();
    const credKeys = form.credentials.map((f) => f.key);
    const configKeys = form.config.map((f) => f.key);

    // epr/password/homePcc/ticketingPcc viven en el blob cifrado: es donde el factory mira primero.
    expect(credKeys).toEqual(['epr', 'password', 'homePcc', 'ticketingPcc']);
    // `password` NO puede ofrecerse en config: config es JSONB en claro y se devuelve por el listado.
    expect(configKeys).not.toContain('password');
    expect(configKeys).toContain('environment');
  });

  it('marca secreta sólo la contraseña; el PCC y el EPR no lo son', () => {
    const byKey = new Map(sabre().credentials.map((f) => [f.key, f]));
    expect(byKey.get('password')?.secret).toBe(true);
    expect(byKey.get('homePcc')?.secret).not.toBe(true);
    expect(byKey.get('epr')?.secret).not.toBe(true);
  });
});

describe('validateProviderDraft — Sabre', () => {
  it('acepta el borrador con EPR, contraseña y PCC', () => {
    const result = validateProviderDraft(sabre(), validSabreDraft());
    expect(result.ok).toBe(true);
    expect(result.fieldErrors).toEqual({});
    expect(result.summary).toBeNull();
  });

  it('rechaza guardar sin homePcc y explica por qué', () => {
    const draft = validSabreDraft();
    const result = validateProviderDraft(sabre(), {
      ...draft,
      credentials: { ...draft.credentials, homePcc: '' },
    });

    expect(result.ok).toBe(false);
    const message = result.fieldErrors[fieldKey('credentials', 'homePcc')];
    expect(message).toBeDefined();
    // El motivo concreto, no un "campo requerido": el PCC va dentro del clientId del token.
    expect(message).toContain('clientId');
    expect(result.summary).toContain('clientId');
  });

  it('trata un homePcc de sólo espacios como ausente', () => {
    const draft = validSabreDraft();
    const result = validateProviderDraft(sabre(), {
      ...draft,
      credentials: { ...draft.credentials, homePcc: '   ' },
    });
    expect(result.fieldErrors[fieldKey('credentials', 'homePcc')]).toBeDefined();
  });

  it('exige también EPR y contraseña, que son las otras dos piezas del token', () => {
    const result = validateProviderDraft(sabre(), { credentials: {}, config: {} });
    expect(result.fieldErrors[fieldKey('credentials', 'epr')]).toBeDefined();
    expect(result.fieldErrors[fieldKey('credentials', 'password')]).toBeDefined();
    expect(result.summary).toContain('3 campos');
  });

  it.each([
    ['AB', false],
    ['AB1', true],
    ['AB1C', true],
    ['AB1CD', false],
  ])('acepta un PCC de 3–4 caracteres: %s → %s', (pcc, valid) => {
    // Los límites son los de SabreConfigSchema: fuera de rango revienta en la primera búsqueda.
    const draft = validSabreDraft();
    const result = validateProviderDraft(sabre(), {
      ...draft,
      credentials: { ...draft.credentials, homePcc: pcc },
    });
    expect(result.fieldErrors[fieldKey('credentials', 'homePcc')] === undefined).toBe(valid);
  });

  it('no exige el PCC de emisión, pero le aplica el mismo rango', () => {
    const draft = validSabreDraft();
    const ok = validateProviderDraft(sabre(), draft);
    expect(ok.fieldErrors[fieldKey('credentials', 'ticketingPcc')]).toBeUndefined();

    const tooLong = validateProviderDraft(sabre(), {
      ...draft,
      credentials: { ...draft.credentials, ticketingPcc: 'ABCDE' },
    });
    expect(tooLong.fieldErrors[fieldKey('credentials', 'ticketingPcc')]).toBeDefined();
  });

  it('rechaza un entorno que no sea cert o prod', () => {
    const result = validateProviderDraft(sabre(), {
      ...validSabreDraft(),
      config: { environment: 'staging' },
    });
    expect(result.fieldErrors[fieldKey('config', 'environment')]).toBeDefined();
  });

  it('rechaza un host que no sea una URL absoluta', () => {
    const bad = validateProviderDraft(sabre(), {
      ...validSabreDraft(),
      config: { host: 'api.cert.platform.sabre.com' },
    });
    expect(bad.fieldErrors[fieldKey('config', 'host')]).toBeDefined();

    const good = validateProviderDraft(sabre(), {
      ...validSabreDraft(),
      config: { host: 'https://api.cert.platform.sabre.com' },
    });
    expect(good.ok).toBe(true);
  });

  it.each([
    ['ftp://api.cert.platform.sabre.com'],
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<script>'],
  ])('rechaza %s: parsea como URL pero no es http(s)', (host) => {
    // Estos cuatro NO los rechaza `new URL()` —parsean sin lanzar—, así que sólo caen por el
    // filtro de protocolo. Sin él, el host del proveedor podría ser un `javascript:`.
    const result = validateProviderDraft(sabre(), { ...validSabreDraft(), config: { host } });
    expect(result.fieldErrors[fieldKey('config', 'host')]).toBeDefined();
  });
});

describe('validateProviderDraft — los proveedores que ya existían', () => {
  it.each([
    ['latam-ndc', { apiKey: 'k' }],
    ['agent-cars', { accessToken: 't' }],
  ])('no le inventa campos obligatorios nuevos a %s', (code, credentials) => {
    const form = providerFormFor(code);
    if (!form) throw new Error(`${code} tiene que seguir en el catálogo`);
    // Con UNA credencial cargada y todo lo demás vacío pasa: ningún campo suyo es obligatorio.
    const result = validateProviderDraft(form, { credentials, config: {} });
    expect(result.fieldErrors).toEqual({});
    expect(result.ok).toBe(true);
  });
});

describe('validateProviderDraft — el cuerpo vacío que el API rechaza', () => {
  it('corta el guardado sin ninguna credencial antes de mandarlo', () => {
    // `UpsertProviderAccountSchema` exige `credentials` NO VACÍO. Sin este corte, abrir una cuenta
    // sólo para cambiarle el estado —el caso más común de la edición— manda `credentials: {}` y
    // vuelve un 400 crudo del API.
    const form = providerFormFor('latam-ndc');
    if (!form) throw new Error('latam-ndc tiene que seguir en el catálogo');

    const result = validateProviderDraft(form, { credentials: {}, config: {} });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('al menos una credencial');
    // Y explica por qué no alcanza con las que ya están guardadas.
    expect(result.summary).toContain('no se devuelven');
  });

  it('un campo con sólo espacios sigue siendo un cuerpo vacío', () => {
    // El borrador lo tolera; el PAYLOAD lo recorta y lo omite, así que al API llega `{}` igual.
    const form = providerFormFor('agent-cars');
    if (!form) throw new Error('agent-cars tiene que seguir en el catálogo');
    expect(
      validateProviderDraft(form, { credentials: { accessToken: '   ' }, config: {} }).ok,
    ).toBe(false);
  });

  it('la config sola no salva el guardado: lo que el API exige es credentials', () => {
    const form = providerFormFor('agent-cars');
    if (!form) throw new Error('agent-cars tiene que seguir en el catálogo');
    const result = validateProviderDraft(form, {
      credentials: {},
      config: { sourceCountry: 'CO' },
    });
    expect(result.ok).toBe(false);
  });

  it('los errores de campo mandan sobre el cuerpo vacío: son más concretos', () => {
    // Con Sabre vacío las dos cosas son ciertas. Decir "cargá al menos una credencial" en vez de
    // nombrar EPR, contraseña y PCC sería cambiar tres instrucciones por una vaga.
    const result = validateProviderDraft(sabre(), { credentials: {}, config: {} });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('3 campos');
    expect(result.fieldErrors[fieldKey('credentials', 'epr')]).toBeDefined();
  });
});

describe('buildProviderAccountPayload', () => {
  it('aplica el entorno por defecto cuando nadie toca el select', () => {
    const payload = buildProviderAccountPayload(sabre(), validSabreDraft());
    // cert y no prod: el default tiene que ser el entorno que no factura ni emite.
    expect(payload.config['environment']).toBe('cert');
  });

  it('no filtra la contraseña al JSONB en claro', () => {
    const payload = buildProviderAccountPayload(sabre(), validSabreDraft());
    expect(payload.credentials['password']).toBe('sup3rsecreta');
    expect(payload.config).not.toHaveProperty('password');
  });

  it('descarta lo tecleado para OTRO proveedor', () => {
    // El formulario conserva el estado al cambiar de proveedor en el select: sin este filtro,
    // el apiKey de LATAM acabaría dentro del blob cifrado de la cuenta de Sabre.
    const draft = validSabreDraft();
    const payload = buildProviderAccountPayload(sabre(), {
      credentials: {
        ...draft.credentials,
        apiKey: 'clave-de-latam',
        accessToken: 'token-agentcars',
      },
      config: { apiUrl: 'https://latam.example', environment: 'prod' },
    });

    expect(payload.credentials).not.toHaveProperty('apiKey');
    expect(payload.credentials).not.toHaveProperty('accessToken');
    expect(payload.config).not.toHaveProperty('apiUrl');
    expect(payload.config['environment']).toBe('prod');
  });

  it('omite los opcionales vacíos en vez de guardarlos como cadena vacía', () => {
    const payload = buildProviderAccountPayload(sabre(), {
      ...validSabreDraft(),
      config: { agencyIata: '', domain: '   ' },
    });
    expect(payload.config).not.toHaveProperty('agencyIata');
    expect(payload.config).not.toHaveProperty('domain');
  });

  it('recorta los espacios de lo tecleado', () => {
    const payload = buildProviderAccountPayload(sabre(), {
      credentials: { epr: '  1234567 ', password: 'x', homePcc: ' AB1C ' },
      config: {},
    });
    expect(payload.credentials['epr']).toBe('1234567');
    expect(payload.credentials['homePcc']).toBe('AB1C');
  });
});

describe('estado de la cuenta', () => {
  it('sólo "active" habilita el proveedor', () => {
    // Es literalmente el filtro de resolve_provider_account: pa.status = 'active'.
    expect(statusEnablesProvider('active')).toBe(true);
    expect(statusEnablesProvider('sandbox')).toBe(false);
    expect(statusEnablesProvider('disabled')).toBe(false);
  });

  it('avisa que sandbox no habilita nada y dice cómo se promueve', () => {
    const notice = statusNotice('sandbox');
    expect(notice.tone).toBe('warn');
    expect(notice.title).toContain('NO habilita');
    expect(notice.body).toContain('Activo');
  });

  it('presenta "active" como el estado que sí habilita', () => {
    expect(statusNotice('active').tone).toBe('ok');
  });

  it('explica que deshabilitar puede devolver la agencia a las credenciales del ancestro', () => {
    expect(statusNotice('disabled').body).toContain('ancestro');
  });
});

describe('normalizeAccountLabel', () => {
  it('deja la etiqueta escrita tal cual, sin espacios de borde', () => {
    expect(normalizeAccountLabel('  pruebas ')).toBe('pruebas');
  });

  it('convierte el campo vacío en la etiqueta que aplica el API', () => {
    // No es cosmética: el upsert es por (tenant, provider, label) y `default` es una cuenta REAL.
    expect(normalizeAccountLabel('')).toBe(DEFAULT_ACCOUNT_LABEL);
    expect(normalizeAccountLabel('   ')).toBe(DEFAULT_ACCOUNT_LABEL);
  });
});

const OWN_DEFAULT: ResolvedAccountRef = { inherited: false, label: 'default' };
const INHERITED_DEFAULT: ResolvedAccountRef = { inherited: true, label: 'default' };

function submit(opts: {
  label: string;
  status: ProviderAccountStatus;
  resolved: ResolvedAccountRef | null;
  form?: ProviderForm;
  sections?: DraftSections;
}): AccountSubmission {
  return prepareAccountSubmission(
    opts.form ?? sabre(),
    {
      label: opts.label,
      status: opts.status,
      sections: opts.sections ?? validSabreDraft(),
    },
    { resolved: opts.resolved, tenantName: 'Agencia Sur', ownerName: 'Planetour' },
  );
}

describe('prepareAccountSubmission — la etiqueta que se anuncia es la que se guarda', () => {
  it('con el campo VACÍO avisa de que va a pisar la cuenta «default» activa', () => {
    // El fallo que esto cierra: el aviso miraba la etiqueta en crudo ('') y decía "no cambia la
    // cuenta que está en uso", mientras el POST mandaba 'default' y APAGABA el proveedor.
    const s = submit({ label: '', status: 'sandbox', resolved: OWN_DEFAULT });

    expect(s.label).toBe('default');
    expect(s.effect).toBe('downgrades-own');
    expect(s.notice.tone).toBe('warn');
  });

  it('con espacios y la misma etiqueta, también', () => {
    const s = submit({ label: '  default  ', status: 'sandbox', resolved: OWN_DEFAULT });
    expect(s.label).toBe('default');
    expect(s.effect).toBe('downgrades-own');
  });

  it('la etiqueta del aviso y la del payload son literalmente la misma', () => {
    const s = submit({ label: '  pruebas  ', status: 'active', resolved: null });
    expect(s.label).toBe('pruebas');
    expect(s.notice.body).toContain('Sabre');
    // El payload sigue siendo el del proveedor elegido: la etiqueta no lo toca.
    expect(s.payload.credentials['homePcc']).toBe('AB1C');
  });

  it('sandbox con OTRA etiqueta sigue sin tocar la propia activa', () => {
    const s = submit({ label: 'pruebas', status: 'sandbox', resolved: OWN_DEFAULT });
    expect(s.effect).toBe('keeps-own');
    expect(s.notice.tone).toBe('muted');
  });
});

describe('prepareAccountSubmission — dos cuentas propias activas', () => {
  it('con la MISMA etiqueta sí reemplaza: el upsert sobrescribe esa fila', () => {
    const s = submit({ label: 'default', status: 'active', resolved: OWN_DEFAULT });
    expect(s.effect).toBe('replaces-own');
    expect(s.notice.body).toContain('SOBRESCRIBE');
  });

  it('con OTRA etiqueta NO reemplaza: quedan dos activas y no se sabe cuál gana', () => {
    // `resolve_provider_account` ordena sólo por `nlevel(t.path) DESC`. Dos cuentas del MISMO
    // tenant tienen el mismo path: empatan y la consulta no tiene desempate.
    const s = submit({ label: 'produccion', status: 'active', resolved: OWN_DEFAULT });

    expect(s.effect).toBe('rivals-own');
    expect(s.notice.tone).toBe('warn');
    expect(s.notice.body).toContain('no podemos decirte cuál');
    // Y sobre todo: no puede seguir prometiendo el reemplazo.
    expect(s.notice.title).not.toContain('Reemplaza');
    expect(s.notice.body).not.toContain('se sustituyen');
    // Nombra las dos etiquetas, que es lo que el operador necesita para decidir.
    expect(s.notice.body).toContain('«default»');
    expect(s.notice.body).toContain('«produccion»');
  });
});

describe('prepareAccountSubmission — herencia', () => {
  it('activa sobre heredada: la propia gana y se nombra al padre', () => {
    const s = submit({ label: 'default', status: 'active', resolved: INHERITED_DEFAULT });
    expect(s.effect).toBe('overrides-inherited');
    expect(s.notice.tone).toBe('warn');
    expect(s.notice.title).toContain('Planetour');
    expect(s.notice.body).toContain('Agencia Sur');
  });

  it('sandbox sobre heredada: la del padre sigue mandando', () => {
    const s = submit({ label: 'default', status: 'sandbox', resolved: INHERITED_DEFAULT });
    expect(s.effect).toBe('keeps-inherited');
    expect(s.notice.tone).toBe('muted');
  });

  it('activa sin nada resuelto: pasa a ser la cuenta que resuelve', () => {
    const s = submit({ label: 'default', status: 'active', resolved: null });
    expect(s.effect).toBe('first-own');
    expect(s.notice.tone).toBe('ok');
  });

  it('inactiva sin nada resuelto: no cambia nada', () => {
    const s = submit({ label: 'default', status: 'disabled', resolved: null });
    expect(s.effect).toBe('no-effect');
    expect(s.notice.tone).toBe('muted');
  });
});

describe('la cartelería no promete lo que el sistema no cumple', () => {
  it('apagar la cuenta en uso no promete que el proveedor desaparezca', () => {
    // Puede caer en otra cuenta propia activa o en la de un ancestro heredable, y esta pantalla
    // no sabe si alguna de las dos existe.
    const body = submit({ label: 'default', status: 'sandbox', resolved: OWN_DEFAULT }).notice.body;
    expect(body).toContain('la que siga');
    expect(body).toContain('si no hay ninguna');
  });

  it('el alta que resuelve por primera vez no promete que ya se pueda cotizar', () => {
    const body = submit({ label: 'default', status: 'active', resolved: null }).notice.body;
    // Lo que esta pantalla garantiza es QUÉ CUENTA RESUELVE. Que el proveedor aparezca en la
    // búsqueda depende además de dos interruptores del servidor que el panel ni ve.
    expect(body).toContain('pasa a ser la cuenta que resuelve');
    expect(body).toContain('las credenciales estén completas');
    expect(body).toContain('habilitado en la plataforma');
    // Y la prueba de que no promete: ninguna forma de "ya aparece".
    expect(body).not.toContain('empieza a aparecer');
    expect(body).not.toContain('empieza a cotizar');
  });

  it('la frase de ausencia distingue si el proveedor cae a credenciales de plataforma', () => {
    // Sabre es BYOC puro: sin cuenta queda AUSENTE. LATAM tiene envConfig() y sigue cotizando.
    // Afirmar lo mismo de los dos es mentirle a la mitad de los operadores.
    const sinFallback = submit({ label: 'default', status: 'active', resolved: null }).notice.body;
    expect(sinFallback).toContain('no aparece en las búsquedas');
    expect(sinFallback).not.toContain('credenciales de la plataforma');
  });

  it('el estado Activo se presenta como necesario, no como suficiente', () => {
    expect(statusNotice('active').body).toContain('completas');
  });

  it('guardar en Sandbox habla de ESTA cuenta, no del proveedor entero', () => {
    // Guardar una cuenta en sandbox no apaga un proveedor que la agencia resuelve por otra vía
    // (otra cuenta propia activa, o la de un ancestro heredable).
    const body = statusNotice('sandbox').body;
    expect(body).toContain('esta cuenta no va a habilitar nada');
    expect(body).not.toContain('el proveedor va a seguir sin aparecer');
  });

  it('marcar heredable no promete que las sub-agencias vayan a cotizar con esta cuenta', () => {
    // Depende del estado, de si ellas cargan la suya, y de si hay un nodo intermedio con la suya.
    const help = inheritableHelp(2);
    expect(help).toContain('pueden heredar');
    expect(help).toContain('Activa');
    expect(help).not.toContain('van a cotizar con estas credenciales');
  });

  it('desmarcar heredable no promete que las sub-agencias se queden sin proveedor', () => {
    // Pueden caer en el ancestro heredable que siga hacia arriba.
    expect(inheritableHelp(2)).toContain('ancestro heredable que siga');
  });
});

describe('inheritableHelp', () => {
  it('dice que en una agencia hoja hoy no cambia nada', () => {
    expect(inheritableHelp(0)).toContain('todavía no tiene sub-agencias');
  });

  it('cuenta cuántas sub-agencias se ven afectadas', () => {
    expect(inheritableHelp(3)).toContain('sus 3 sub-agencias');
    expect(inheritableHelp(1)).toContain('su sub-agencia');
  });
});

describe('accountCertainty — qué se puede afirmar de la cuenta resuelta', () => {
  it('no puede verificar las tres credenciales de Sabre ni con la config a la vista', () => {
    // Es el caso real: las cuentas de Sabre se cargan por API y pueden venir sin `homePcc`.
    // `epr`, `password` y `homePcc` viven en `credentials_enc`; ni el listado ni `/resolve` los
    // devuelven, así que la pantalla NO puede decir que la cuenta funciona.
    const certainty = accountCertainty(sabre(), { environment: 'cert' });

    expect(certainty.kind).toBe('unverifiable');
    if (certainty.kind !== 'unverifiable') throw new Error('rama imposible');
    expect(certainty.fields).toEqual([
      'EPR (usuario de la oficina)',
      'Contraseña',
      'PCC de la oficina',
    ]);
  });

  it('una cuenta heredada tampoco es verificable: su fila es de un ancestro', () => {
    expect(accountCertainty(sabre(), undefined).kind).toBe('unverifiable');
  });

  it('no inventa un defecto por un obligatorio de config que tiene default declarado', () => {
    // `environment` es obligatorio pero cae a `cert`: decir "le falta Entorno" sería otra mentira.
    const certainty = accountCertainty(sabre(), {});
    expect(certainty.kind).toBe('unverifiable');
    if (certainty.kind !== 'unverifiable') throw new Error('rama imposible');
    expect(certainty.fields).not.toContain('Entorno');
  });

  it('sí señala el obligatorio de config, sin default, que la cuenta guardada no trae', () => {
    const form: ProviderForm = {
      label: 'Proveedor de prueba',
      credentials: [],
      config: [{ key: 'pos', label: 'País (POS)', required: true }],
      fallsBackToPlatformCredentials: false,
    };

    expect(accountCertainty(form, { pos: 'CO' }).kind).toBe('nothing-required');

    const missing = accountCertainty(form, { pos: '   ' });
    expect(missing.kind).toBe('missing-fields');
    if (missing.kind !== 'missing-fields') throw new Error('rama imposible');
    expect(missing.fields).toEqual(['País (POS)']);
  });

  it('un defecto conocido gana sobre una duda', () => {
    const form: ProviderForm = {
      label: 'Proveedor de prueba',
      credentials: [{ key: 'secreto', label: 'Secreto', secret: true, required: true }],
      config: [{ key: 'pos', label: 'País (POS)', required: true }],
      fallsBackToPlatformCredentials: false,
    };
    expect(accountCertainty(form, {}).kind).toBe('missing-fields');
  });

  it('un proveedor sin obligatorios no genera ninguna afirmación', () => {
    const form = providerFormFor('latam-ndc');
    if (!form) throw new Error('latam-ndc tiene que seguir en el catálogo');
    expect(accountCertainty(form, {}).kind).toBe('nothing-required');
    expect(accountCertaintyNotice(accountCertainty(form, {}))).toBeNull();
  });
});

describe('accountCertainty — cuando el API sí se pronuncia', () => {
  it('traduce el "incomplete" del servidor a los campos que le faltan, con su nombre visible', () => {
    // El servidor ve el blob descifrado; el panel sólo ve claves. La pantalla habla en etiquetas.
    const certainty = accountCertainty(
      sabre(),
      {},
      {
        readiness: 'incomplete',
        missingRequiredFields: ['homePcc'],
      },
    );

    expect(certainty.kind).toBe('missing-fields');
    if (certainty.kind !== 'missing-fields') throw new Error('rama imposible');
    expect(certainty.fields).toEqual(['PCC de la oficina']);
  });

  it('una clave que este panel no conoce se muestra tal cual en vez de perderse', () => {
    const certainty = accountCertainty(
      sabre(),
      {},
      {
        readiness: 'incomplete',
        missingRequiredFields: ['campoNuevo'],
      },
    );
    if (certainty.kind !== 'missing-fields') throw new Error('rama imposible');
    expect(certainty.fields).toEqual(['campoNuevo']);
  });

  it('"complete" es lo único que autoriza a decir que la cuenta está completa', () => {
    expect(accountCertainty(sabre(), {}, { readiness: 'complete' }).kind).toBe('complete');
  });

  it('"simulated" se dice, porque devuelve tarifas inventadas con forma de reales', () => {
    const notice = accountCertaintyNotice(
      accountCertainty(sabre(), {}, { readiness: 'simulated' }),
    );
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('simulada');
  });

  it.each([
    ['un API que todavía no manda el veredicto', undefined],
    ['un veredicto que no reconocemos', { readiness: 'listo' }],
    ['un "unknown" explícito', { readiness: 'unknown' }],
    ['un "incomplete" sin decir qué falta', { readiness: 'incomplete', missingRequiredFields: [] }],
    [
      'un "incomplete" con una lista que no es de strings',
      { readiness: 'incomplete', missingRequiredFields: 3 },
    ],
  ])('con %s la pantalla vuelve a decir que no lo sabe', (_caso, server) => {
    // Ninguna de estas entradas puede convertirse en "está completa": el silencio del API no es
    // un sí.
    expect(accountCertainty(sabre(), {}, server).kind).toBe('unverifiable');
  });
});

describe('accountCertaintyNotice', () => {
  it('la duda se dice como duda, nunca como que funciona', () => {
    const notice = accountCertaintyNotice(accountCertainty(sabre(), {}));
    expect(notice).not.toBeNull();
    if (!notice) throw new Error('rama imposible');

    expect(notice.tone).toBe('muted');
    expect(notice.text).toContain('no lo podemos ver');
    expect(notice.text).toContain('PCC de la oficina');
    // Nada de prometer servicio: es justo lo que la pantalla afirmaba y no cumplía.
    expect(notice.text).not.toMatch(/funciona|está lista|operativa/i);
  });

  it('el defecto conocido se dice como defecto', () => {
    const notice = accountCertaintyNotice({ kind: 'missing-fields', fields: ['PCC', 'EPR'] });
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('PCC y EPR');
  });
});

/* ---------- editar una cuenta ya guardada ---------- */

/** Una cuenta de Sabre como la devuelve el listado: activa, completa, sin secretos a la vista. */
function savedSabreAccount(over: Partial<SavedAccountView> = {}): SavedAccountView {
  return {
    label: 'default',
    status: 'active',
    isInheritable: true,
    config: { environment: 'prod', agencyIata: '12345678' },
    ...over,
  };
}

describe('prefillFromAccount — la mitad que sí se puede recuperar', () => {
  it('recupera etiqueta, estado, herencia y la config visible', () => {
    // Es la diferencia entre "editar" y "empezar de cero": sin esto, corregir un PCC obliga a
    // acordarse de memoria del entorno, la etiqueta y si la cuenta era heredable.
    const prefill = prefillFromAccount(sabre(), savedSabreAccount({ isInheritable: false }));

    expect(prefill.label).toBe('default');
    expect(prefill.status).toBe('active');
    expect(prefill.isInheritable).toBe(false);
    expect(prefill.config).toEqual({ environment: 'prod', agencyIata: '12345678' });
  });

  it('NO precarga ninguna credencial: el API no las devuelve', () => {
    // El contrato entero de la edición cuelga de acá. `AccountPrefill` no tiene sección
    // `credentials`, así que ni por accidente se puede pintar una contraseña inventada.
    const prefill = prefillFromAccount(sabre(), savedSabreAccount());
    expect(prefill).not.toHaveProperty('credentials');
    // Y las claves de credenciales que hubieran llegado por config no se cuelan como config.
    expect(Object.keys(prefill.config)).toEqual(['environment', 'agencyIata']);
  });

  it('declara como pérdida la config que el servidor no devolvió', () => {
    // `redactedConfigKeys` = claves que existen en la fila pero cuyo valor no salió por el API.
    // El upsert reemplaza la config ENTERA, así que reguardar sin ellas las borra.
    const prefill = prefillFromAccount(
      sabre(),
      savedSabreAccount({ redactedConfigKeys: ['algoRaro'] }),
    );
    expect(prefill.droppedConfigKeys).toContain('algoRaro');
  });

  it('declara como pérdida la config que este formulario no sabe pintar', () => {
    // Claves no declaradas en el formulario y `mock` están en la lista blanca del servidor pero no en el formulario, así
    // que `buildProviderAccountPayload` los filtra y al guardar desaparecen de la fila.
    const prefill = prefillFromAccount(
      sabre(),
      savedSabreAccount({
        config: { environment: 'cert', otraClaveDesconocida: 'off', mock: true },
      }),
    );

    expect(prefill.config).toEqual({ environment: 'cert' });
    expect(prefill.droppedConfigKeys).toEqual(['mock', 'otraClaveDesconocida']);
  });

  it('no convierte un booleano en texto: `mock: true` no puede volver como "true"', () => {
    // Sería el peor caso de todos. El servidor compara `config.mock === true`; recargado como
    // string, la cuenta dejaría de ser simulada y pasaría a cotizar de verdad sin que nadie lo
    // pidiera. Se declara pérdida —visible— en vez de convertirla —silencioso—.
    const form: ProviderForm = {
      label: 'Proveedor de prueba',
      credentials: [{ key: 'token', label: 'Token', secret: true }],
      config: [{ key: 'mock', label: 'Simulada' }],
      fallsBackToPlatformCredentials: false,
    };
    const prefill = prefillFromAccount(form, {
      label: 'default',
      status: 'active',
      isInheritable: true,
      config: { mock: true },
    });

    expect(prefill.config).toEqual({});
    expect(prefill.droppedConfigKeys).toEqual(['mock']);
  });

  it('una clave vacía no se precarga ni se anuncia como pérdida: no hay nada que perder', () => {
    const prefill = prefillFromAccount(
      sabre(),
      savedSabreAccount({ config: { environment: 'cert', agencyIata: '  ' } }),
    );
    expect(prefill.config).toEqual({ environment: 'cert' });
    expect(prefill.droppedConfigKeys).toEqual([]);
  });

  it('un estado que este panel no conoce no se presenta como Activo', () => {
    // Un API más nuevo con un cuarto estado. `sandbox` es el único de los tres que no habilita
    // nada: equivocarse hacia "no habilita" es corregible; hacia "activo" es una cuenta viva.
    expect(prefillFromAccount(sabre(), savedSabreAccount({ status: 'suspendida' })).status).toBe(
      'sandbox',
    );
  });

  it('lo precargado vuelve a salir por el payload sin cambiar de sitio', () => {
    // La prueba de que el ciclo cierra: lo que se recupera se reenvía tal cual, en `config`.
    const prefill = prefillFromAccount(sabre(), savedSabreAccount());
    const payload = buildProviderAccountPayload(sabre(), {
      credentials: { epr: '1234567', password: 'x', homePcc: 'AB1C' },
      config: { ...prefill.config },
    });

    expect(payload.config['environment']).toBe('prod');
    expect(payload.config['agencyIata']).toBe('12345678');
  });
});

describe('prepareAccountSubmission — editar es reescribir, y hay que decirlo', () => {
  function edit(opts: {
    label: string;
    status?: ProviderAccountStatus;
    resolved?: ResolvedAccountRef | null;
    editing: { label: string; droppedConfigKeys?: readonly string[] };
  }): AccountSubmission {
    return prepareAccountSubmission(
      sabre(),
      {
        label: opts.label,
        status: opts.status ?? 'active',
        sections: validSabreDraft(),
      },
      {
        resolved: opts.resolved ?? OWN_DEFAULT,
        tenantName: 'Agencia Sur',
        ownerName: 'Planetour',
        editing: opts.editing,
      },
    );
  }

  it('un alta no lleva plan de edición', () => {
    expect(submit({ label: 'default', status: 'active', resolved: null }).edit).toBeNull();
  });

  it('con la misma etiqueta reescribe, y avisa de que las credenciales van de nuevo', () => {
    const plan = edit({ label: 'default', editing: { label: 'default' } }).edit;
    expect(plan?.outcome).toBe('rewrites');
    expect(plan?.notice.tone).toBe('warn');
    expect(plan?.notice.title).toContain('«default»');
    // El motivo, no sólo la orden: por qué no se pueden precargar.
    expect(plan?.notice.body).toContain('cifradas');
    expect(plan?.notice.body).toContain('el API no las devuelve');
    // Y el caso más común de todos: promover de Sandbox a Activo también las exige.
    expect(plan?.notice.body).toContain('el estado');
  });

  it('con OTRA etiqueta ya no está editando, y no finge que sí', () => {
    // El upsert va por (tenant, proveedor, etiqueta): con otra etiqueta se crea una segunda fila
    // y la original queda entera. Llamar a eso "editar" dejaría dos cuentas donde el operador
    // cree que hay una.
    const plan = edit({ label: 'produccion', editing: { label: 'default' } }).edit;

    expect(plan?.outcome).toBe('forks');
    expect(plan?.notice.tone).toBe('warn');
    expect(plan?.notice.title).toContain('deja de editar «default»');
    expect(plan?.notice.body).toContain('«default» queda como está');
    expect(plan?.notice.body).toContain('segunda cuenta');
  });

  it('la etiqueta vacía se compara ya normalizada, no en crudo', () => {
    // Vaciar el campo etiqueta editando la cuenta «default» sigue siendo editar «default»: el
    // POST manda `default`. Comparar en crudo lo llamaría "crear una cuenta aparte".
    expect(edit({ label: '   ', editing: { label: 'default' } }).edit?.outcome).toBe('rewrites');
  });

  it('nombra la config que se va a perder, con sus claves', () => {
    const plan = edit({
      label: 'default',
      editing: { label: 'default', droppedConfigKeys: ['callPolicy', 'mock'] },
    }).edit;
    expect(plan?.notice.body).toContain('callPolicy y mock');
    expect(plan?.notice.body).toContain('se pierde');
  });

  it('sin pérdidas no inventa una advertencia de pérdida', () => {
    const plan = edit({ label: 'default', editing: { label: 'default' } }).edit;
    expect(plan?.notice.body).not.toContain('se pierde');
  });

  it('editar y guardar sigue mandando el payload del proveedor, por la misma puerta', () => {
    // Editar no puede tener su propio camino al API: se guarda con el MISMO upsert.
    const s = edit({ label: 'default', editing: { label: 'default' } });
    expect(s.label).toBe('default');
    expect(s.payload.credentials['homePcc']).toBe('AB1C');
    expect(s.payload.config['environment']).toBe('cert');
  });

  it('el aviso de herencia habla de la cuenta que resuelve, no de la que se edita', () => {
    // Editar la cuenta «pruebas», en sandbox, mientras resuelve «default»: son dos hechos
    // distintos y el operador necesita los dos. Colapsarlos en uno se lleva puesto alguno.
    const s = edit({
      label: 'pruebas',
      status: 'sandbox',
      resolved: OWN_DEFAULT,
      editing: { label: 'pruebas' },
    });

    expect(s.effect).toBe('keeps-own');
    expect(s.notice.title).toBe('No cambia la cuenta que está en uso');
    expect(s.edit?.outcome).toBe('rewrites');
    expect(s.edit?.notice.title).toContain('«pruebas»');
  });

  it('promover de Sandbox a Activo pisando la cuenta en uso avisa por los dos lados', () => {
    // El caso real del founder: la cuenta guardada es la que resuelve y se reguarda activa.
    const s = edit({ label: 'default', status: 'active', editing: { label: 'default' } });
    expect(s.effect).toBe('replaces-own');
    expect(s.notice.body).toContain('SOBRESCRIBE');
    expect(s.edit?.outcome).toBe('rewrites');
  });
});

describe('accountConfigSummary', () => {
  it('traduce el entorno guardado a la etiqueta que ve el operador', () => {
    expect(accountConfigSummary(sabre(), { environment: 'cert' })).toEqual([
      'Entorno: CERT (pruebas)',
    ]);
  });

  it('ignora claves que el formulario no declara', () => {
    // config es un JSONB que cualquiera pudo escribir por API: no se pinta a ciegas.
    expect(accountConfigSummary(sabre(), { loQueSea: 'valor' })).toEqual([]);
  });

  it('omite los campos ausentes o vacíos', () => {
    expect(accountConfigSummary(sabre(), { environment: 'prod', agencyIata: '' })).toEqual([
      'Entorno: Producción',
    ]);
  });
});
