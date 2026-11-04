'use client';

import { AlertCircle, ChevronDown, Plane, UserPlus, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';
import { cn } from '../../../../lib/cn';
import { splitFullName } from '../../../../lib/full-name';
import { priceChangeQuestion } from './offer-price-flow';
import {
  birthdateIssue,
  formatBirthdateInput,
  formatBirthdateValue,
  parseBirthdate,
} from '../../../../lib/birthdate';

interface PaxCount {
  adults: number;
  children: number;
  infants: number;
}

export interface ReservationPassenger {
  paxId: string;
  /** Índice global 0-based de la búsqueda: ADT, luego CHD y luego INF. */
  requestedTravelerIndex: number;
  paxType: 'ADT' | 'CHD' | 'INF';
  title: 'Mr' | 'Mrs' | 'Miss' | 'Dr';
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    issueDate?: string;
    /** Opcional: una cédula no vence, y mandar `''` tumbaba la reserva entera. */
    expiryDate?: string;
  };
}

export interface ReservationContact {
  email: string;
  phone: string;
  countryDialingCode: string;
  areaCode: string;
}

type Passenger = ReservationPassenger;
type ContactInfo = ReservationContact;

interface PassengerFormProps {
  paxCount: PaxCount;
  /** Cliente/contacto único (vive en la página). Se usa como contacto de la reserva. */
  customerName?: string;
  contactEmail?: string;
  contactPhone?: string;
  /**
   * La revalidación vio otro precio y nadie lo aceptó todavía: el total nuevo, ya formateado. El
   * formulario pregunta junto al botón y, si se acepta, vuelve a enviar lo mismo que ya se tecleó.
   */
  priceChangeTotal?: string;
  onSubmit: (
    passengers: Passenger[],
    contactInfo: ContactInfo,
    options?: { acceptNewPrice?: boolean },
  ) => Promise<void>;
  /**
   * Los nombres de pila a medida que se escriben, por `requestedTravelerIndex`. Los usa la elección
   * de asientos para decir «Ana 12C» en vez de «Adulto 1 12C» (SAB-16).
   */
  onGivenNamesChange?: (names: readonly string[]) => void;
}

export function buildEmptyPassengers(paxCount: PaxCount): Passenger[] {
  const make = (
    type: 'ADT' | 'CHD' | 'INF',
    i: number,
    requestedTravelerIndex: number,
  ): Passenger => ({
    paxId: `${type}_${i}`,
    requestedTravelerIndex,
    paxType: type,
    title: 'Mr',
    givenName: '',
    surname: '',
    birthdate: '',
    gender: 'M',
    citizenshipCountryCode: 'CO',
    identityDoc: { type: 'CC', number: '', issuingCountryCode: 'CO', expiryDate: '' },
  });
  const pax: Passenger[] = [];
  for (let i = 1; i <= paxCount.adults; i++) pax.push(make('ADT', i, pax.length));
  for (let i = 1; i <= paxCount.children; i++) pax.push(make('CHD', i, pax.length));
  for (let i = 1; i <= paxCount.infants; i++) pax.push(make('INF', i, pax.length));
  return pax;
}

/**
 * El pasajero 1 con el nombre del cliente cuando «El cliente es quien viaja» está marcado.
 *
 * Se deriva en cada render en vez de copiarse: así sigue al nombre del cliente si se corrige en
 * «Cliente y contacto», y lo que el vendedor tecleó a mano en el pasajero 1 no se pisa (vuelve si
 * desmarca). El reparto nombre/apellido vive en `lib/full-name` (dos apellidos en LATAM).
 */
export function withCustomerAsFirstPassenger<T extends { givenName: string; surname: string }>(
  passengers: readonly T[],
  customerName: string | undefined,
  clientTravels: boolean,
): T[] {
  const full = (customerName ?? '').trim();
  if (!clientTravels || !full) return [...passengers];
  const names = splitFullName(full);
  return passengers.map((p, i) => (i === 0 ? { ...p, ...names } : p));
}

/**
 * El tratamiento quedó dentro de «Más datos (opcional)»: si sigue en el valor por defecto de un
 * género (Sr/Sra), acompaña al género elegido; uno que el vendedor cambió a mano (Srta, Dr) se
 * respeta.
 */
export function titleForGender(
  title: Passenger['title'],
  gender: Passenger['gender'],
): Passenger['title'] {
  if (title !== 'Mr' && title !== 'Mrs') return title;
  return gender === 'F' ? 'Mrs' : 'Mr';
}

const PAX_TYPE_LABELS: Record<string, string> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
};

const TITLE_OPTIONS = [
  { value: 'Mr', label: 'Sr (Mr)' },
  { value: 'Mrs', label: 'Sra (Mrs)' },
  { value: 'Miss', label: 'Srta (Miss)' },
  { value: 'Dr', label: 'Dr' },
];

const DOC_TYPE_OPTIONS = [
  { value: 'CC', label: 'Cédula (CC)' },
  { value: 'CE', label: 'Cédula Extranjería (CE)' },
  { value: 'P', label: 'Pasaporte' },
  { value: 'DNI', label: 'DNI' },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const inputClass =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

/**
 * Fecha de nacimiento en UN campo que se teclea.
 *
 * Antes eran tres `<select>`. El motivo original era bueno —el date-picker nativo obliga a
 * recorrer décadas para llegar a 1978— y la solución arrastraba el mismo coste por otro lado:
 * cargar un pasajero eran tres aperturas de desplegable y tres búsquedas visuales en listas de
 * 31, 12 y 101 elementos. Con cuatro pasajeros, doce interacciones donde bastan ocho teclas.
 *
 * Acá se teclea `09071978` de corrido, sin soltar el teclado, y las barras las pone el campo.
 * La lógica vive en `lib/birthdate.ts` —parsear fechas escritas por humanos falla por los bordes
 * (`31/02`, `29/02/1900`, futuras) y eso se fija con tests, no mirando la pantalla—.
 */
function DobField({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  // El texto visible es estado propio: mientras se escribe hay estados que todavía no son una
  // fecha, y el valor de fuera sólo acepta fechas completas.
  const [texto, setTexto] = useState(() => formatBirthdateValue(value));
  const hoy = new Date().toISOString().slice(0, 10);
  const problema = birthdateIssue(texto, hoy);

  function handle(raw: string) {
    const formateado = formatBirthdateInput(raw);
    setTexto(formateado);
    // Emite '' mientras no sea usable: el formulario ya sabe tratar el vacío como «falta».
    onChange(parseBirthdate(formateado, hoy) ?? '');
  }

  return (
    <div className="space-y-1">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="bday"
        placeholder="DD/MM/AAAA"
        aria-label="Fecha de nacimiento"
        aria-invalid={invalid === true || problema !== null ? true : undefined}
        value={texto}
        onChange={(e) => handle(e.target.value)}
        className={cn(inputClass, (invalid === true || problema !== null) && errClass)}
      />
      {problema !== null && <p className="text-[11px] text-red-600">{problema}</p>}
    </div>
  );
}

/** Borde rojo para campos obligatorios sin completar (sólo tras intentar reservar). */
const errClass = 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/20';

/** Marca de campo obligatorio. */
function Req() {
  return <span className="text-red-500"> *</span>;
}

/** Etiqueta "(opcional)" sutil. */
function Opt() {
  return <span className="font-normal text-[var(--color-fg-subtle)]"> (opcional)</span>;
}

function passengerLabel(pax: Passenger): string {
  return `${PAX_TYPE_LABELS[pax.paxType] ?? pax.paxType} ${pax.paxId.split('_')[1] ?? ''}`.trim();
}

export function PassengerForm({
  paxCount,
  customerName,
  contactEmail,
  contactPhone,
  priceChangeTotal,
  onSubmit,
  onGivenNamesChange,
}: PassengerFormProps) {
  const [typed, setTyped] = useState<Passenger[]>(() => buildEmptyPassengers(paxCount));
  const customer = (customerName ?? '').trim();

  /*
   * «El cliente es quien viaja», marcado de entrada cuando hay cliente. En la mayoría de las
   * reservas —un solo pasajero— el vendedor escribía el mismo nombre dos veces, una en «Cliente y
   * contacto» y otra en «Pasajero 1». Ahora el pasajero 1 toma el nombre del cliente y sólo pide lo
   * que falta para el billete (nacimiento y documento).
   */
  const [clientTravels, setClientTravels] = useState(() => customer.length > 0);
  // Si el cliente se escribe después de abrir el formulario, se marca solo, salvo que el vendedor
  // ya haya decidido o ya haya escrito a mano en el pasajero 1.
  const clientChoiceMade = useRef(false);
  const firstTyped = typed[0];
  const firstTypedBlank =
    firstTyped === undefined || (!firstTyped.givenName.trim() && !firstTyped.surname.trim());
  useEffect(() => {
    if (clientChoiceMade.current || clientTravels || !customer || !firstTypedBlank) return;
    setClientTravels(true);
  }, [customer, clientTravels, firstTypedBlank]);

  const fromCustomer = clientTravels && customer.length > 0;
  const passengers = withCustomerAsFirstPassenger(typed, customer, fromCustomer);

  // Una clave estable por contenido: el efecto avisa cuando cambia un nombre, no en cada render.
  const givenNames = JSON.stringify(passengers.map((p) => p.givenName.trim()));
  useEffect(() => {
    onGivenNamesChange?.(JSON.parse(givenNames) as string[]);
  }, [givenNames, onGivenNamesChange]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `attempted` activa el marcado de errores recién cuando el usuario intenta reservar.
  const [attempted, setAttempted] = useState(false);

  const email = (contactEmail ?? '').trim();
  const phone = (contactPhone ?? '').trim();

  function updatePax(idx: number, patch: Partial<Passenger>) {
    setTyped((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function updateDoc(idx: number, patch: Partial<Passenger['identityDoc']>) {
    setTyped((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, identityDoc: { ...p.identityDoc, ...patch } } : p)),
    );
  }

  function updateGender(idx: number, gender: Passenger['gender']) {
    setTyped((prev) =>
      prev.map((p, i) =>
        i === idx ? { ...p, gender, title: titleForGender(p.title, gender) } : p,
      ),
    );
  }

  function setClientIsTraveler(value: boolean) {
    clientChoiceMade.current = true;
    setClientTravels(value);
  }

  /** «Editar»: deja de seguir al cliente y abre los campos con su nombre ya puesto. */
  function editCustomerName() {
    setClientIsTraveler(false);
    if (customer) updatePax(0, splitFullName(customer));
  }

  /**
   * Quita del pasajero los opcionales que quedaron en blanco.
   *
   * El estado del formulario los arranca en `''` porque un `<input>` controlado no admite
   * `undefined`, y eso está bien DENTRO del formulario. Lo que no puede es salir: un `''` no
   * significa «vacío», significa «no lo rellené», y para el proveedor son cosas distintas. La
   * reserva con cédula fallaba entera con `expiryDate:invalid_string` — y la cédula no vence, así
   * que el campo no se rellenaba nunca.
   */
  function sinCamposEnBlanco(p: Passenger): Passenger {
    const { expiryDate, issueDate, ...doc } = p.identityDoc;
    return {
      ...p,
      identityDoc: {
        ...doc,
        ...(expiryDate?.trim() ? { expiryDate } : {}),
        ...(issueDate?.trim() ? { issueDate } : {}),
      },
    };
  }

  // ---- Validación: campos realmente obligatorios para emitir la reserva ----
  function paxIssues(p: Passenger): string[] {
    const out: string[] = [];
    if (!p.givenName.trim()) out.push('nombre');
    if (!p.surname.trim()) out.push('apellido');
    if (!p.birthdate) out.push('fecha de nacimiento');
    if (!p.identityDoc.number.trim()) out.push('número de documento');
    if (p.identityDoc.type === 'P' && !p.identityDoc.expiryDate)
      out.push('vencimiento del pasaporte');
    return out;
  }

  function validationMessages(): string[] {
    const m: string[] = [];
    if (!email || !EMAIL_RE.test(email)) {
      m.push('Email de contacto válido (en "Cliente y contacto").');
    }
    if (!phone) m.push('Teléfono de contacto (en "Cliente y contacto").');
    passengers.forEach((p, idx) => {
      const issues = paxIssues(p);
      if (!issues.length) return;
      const where =
        idx === 0 && fromCustomer && issues.includes('apellido')
          ? ' Escribe el nombre completo del cliente o pulsa «Editar».'
          : '';
      m.push(`${passengerLabel(p)}: completa ${issues.join(', ')}.${where}`);
    });
    return m;
  }

  const problems = validationMessages();
  const canSubmit = problems.length === 0;

  async function handleSubmit(acceptNewPrice = false) {
    setAttempted(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const contactInfo: ContactInfo = {
        email,
        phone,
        countryDialingCode: '57',
        areaCode: '1',
      };
      await onSubmit(
        passengers.map(sinCamposEnBlanco),
        contactInfo,
        acceptNewPrice ? { acceptNewPrice: true } : undefined,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear la reserva');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="relative p-5">
        {submitting && <BookingOverlay />}
        <fieldset
          disabled={submitting}
          className={cn('m-0 min-w-0 border-0 p-0', submitting && 'opacity-60')}
        >
          <div className="mb-1 flex items-center gap-2">
            <UserPlus className="size-4 text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              Pasajeros de la reserva
            </h2>
          </div>
          <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
            Sólo lo que pide el billete. El contacto de la reserva es el del cliente (arriba).
          </p>

          {/* Passengers */}
          <div className="space-y-4">
            {passengers.map((pax, idx) => {
              const issues = attempted ? paxIssues(pax) : [];
              const bad = (field: string) => issues.includes(field);
              const id = (field: string) => `pax-${pax.paxId}-${field}`;
              const namesFromCustomer = idx === 0 && fromCustomer;
              return (
                <div key={pax.paxId} className="rounded-lg border border-[var(--color-border)] p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Plane aria-hidden="true" className="size-3.5 text-[var(--color-fg-subtle)]" />
                    <span className="text-xs font-medium text-[var(--color-fg)]">
                      {passengerLabel(pax)}
                    </span>
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[9px] font-medium text-[var(--color-fg-muted)]">
                      {pax.paxType}
                    </span>
                  </div>

                  {idx === 0 && customer && (
                    <label className="mb-3 flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-fg)]">
                      <input
                        type="checkbox"
                        checked={clientTravels}
                        onChange={(e) => setClientIsTraveler(e.target.checked)}
                        className="size-4 rounded border-[var(--color-border)] accent-[var(--color-primary)]"
                      />
                      El cliente es quien viaja
                    </label>
                  )}

                  {namesFromCustomer && (
                    <p
                      className={cn(
                        'mb-3 rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]',
                        (bad('nombre') || bad('apellido')) && 'bg-red-50 text-red-800',
                      )}
                    >
                      Nombre en el documento:{' '}
                      <span className="font-medium text-[var(--color-fg)]">
                        {pax.givenName} {pax.surname}
                      </span>
                      {!pax.surname.trim() && <span> · falta el apellido</span>} ·{' '}
                      <button
                        type="button"
                        onClick={editCustomerName}
                        className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                      >
                        Editar
                      </button>
                    </p>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {!namesFromCustomer && (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor={id('given')}>
                            Nombre(s)
                            <Req />
                          </Label>
                          <input
                            id={id('given')}
                            type="text"
                            autoComplete="off"
                            value={pax.givenName}
                            onChange={(e) => updatePax(idx, { givenName: e.target.value })}
                            placeholder="OLIVER"
                            aria-invalid={bad('nombre') || undefined}
                            className={cn(inputClass, bad('nombre') && errClass)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={id('surname')}>
                            Apellido(s)
                            <Req />
                          </Label>
                          <input
                            id={id('surname')}
                            type="text"
                            autoComplete="off"
                            value={pax.surname}
                            onChange={(e) => updatePax(idx, { surname: e.target.value })}
                            placeholder="JACKSON"
                            aria-invalid={bad('apellido') || undefined}
                            className={cn(inputClass, bad('apellido') && errClass)}
                          />
                        </div>
                      </>
                    )}
                    <div className="space-y-1">
                      <Label>
                        Fecha de nacimiento
                        <Req />
                      </Label>
                      <DobField
                        value={pax.birthdate}
                        onChange={(v) => updatePax(idx, { birthdate: v })}
                        invalid={bad('fecha de nacimiento')}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={id('gender')}>Género</Label>
                      <select
                        id={id('gender')}
                        value={pax.gender}
                        onChange={(e) => updateGender(idx, e.target.value as 'M' | 'F')}
                        className={selectClass}
                      >
                        <option value="M">Masculino</option>
                        <option value="F">Femenino</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={id('doc-type')}>
                        Tipo de documento
                        <Req />
                      </Label>
                      <select
                        id={id('doc-type')}
                        value={pax.identityDoc.type}
                        onChange={(e) =>
                          updateDoc(idx, { type: e.target.value as 'P' | 'DNI' | 'CC' | 'CE' })
                        }
                        className={selectClass}
                      >
                        {DOC_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={id('doc-number')}>
                        Número de documento
                        <Req />
                      </Label>
                      <input
                        id={id('doc-number')}
                        type="text"
                        autoComplete="off"
                        value={pax.identityDoc.number}
                        onChange={(e) => updateDoc(idx, { number: e.target.value })}
                        placeholder="1234567890"
                        aria-invalid={bad('número de documento') || undefined}
                        className={cn(inputClass, bad('número de documento') && errClass)}
                      />
                    </div>
                    {pax.identityDoc.type === 'P' && (
                      <div className="space-y-1">
                        <Label htmlFor={id('doc-expiry')}>
                          Vencimiento pasaporte
                          <Req />
                        </Label>
                        <input
                          id={id('doc-expiry')}
                          type="date"
                          value={pax.identityDoc.expiryDate ?? ''}
                          onChange={(e) => updateDoc(idx, { expiryDate: e.target.value })}
                          aria-invalid={bad('vencimiento del pasaporte') || undefined}
                          className={cn(inputClass, bad('vencimiento del pasaporte') && errClass)}
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label htmlFor={id('nationality')}>Nacionalidad</Label>
                      <input
                        id={id('nationality')}
                        type="text"
                        value={pax.citizenshipCountryCode}
                        onChange={(e) =>
                          updatePax(idx, { citizenshipCountryCode: e.target.value.toUpperCase() })
                        }
                        placeholder="CO"
                        maxLength={2}
                        className={inputClass}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={id('doc-country')}>País emisor doc.</Label>
                      <input
                        id={id('doc-country')}
                        type="text"
                        value={pax.identityDoc.issuingCountryCode}
                        onChange={(e) =>
                          updateDoc(idx, { issuingCountryCode: e.target.value.toUpperCase() })
                        }
                        placeholder="CO"
                        maxLength={2}
                        className={inputClass}
                      />
                    </div>
                  </div>

                  {/* Lo opcional, plegado: no hace falta para reservar y no debe competir con lo
                      que sí. `<details>` da teclado y lector de pantalla sin JavaScript. */}
                  <details className="group mt-3">
                    <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 [&::-webkit-details-marker]:hidden">
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 transition-transform group-open:rotate-180"
                      />
                      Más datos (opcional)
                    </summary>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="space-y-1">
                        <Label htmlFor={id('title')}>
                          Tratamiento
                          <Opt />
                        </Label>
                        <select
                          id={id('title')}
                          value={pax.title}
                          onChange={(e) =>
                            updatePax(idx, {
                              title: e.target.value as 'Mr' | 'Mrs' | 'Miss' | 'Dr',
                            })
                          }
                          className={selectClass}
                        >
                          {TITLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {pax.identityDoc.type === 'P' && (
                        <div className="space-y-1">
                          <Label htmlFor={id('doc-issue')}>
                            Emisión pasaporte
                            <Opt />
                          </Label>
                          <input
                            id={id('doc-issue')}
                            type="date"
                            value={pax.identityDoc.issueDate ?? ''}
                            onChange={(e) =>
                              updateDoc(idx, { issueDate: e.target.value || undefined })
                            }
                            className={inputClass}
                          />
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>

          {/*
            Sin cobro en este paso, y sin un solo campo de tarjeta: la reserva sale sin forma de
            pago y el API rechaza `payment` en createOrder. Un formulario de tarjeta aquí sólo
            serviría para que un PAN llegue a nuestro servidor (D1), que es justo lo que no se hace.
          */}
          <section
            aria-labelledby="checkout-pago"
            className="mt-6 border-t border-[var(--color-border)] pt-5"
          >
            <div className="mb-3 flex items-center gap-2">
              <Wallet className="size-4 text-[var(--color-primary)]" aria-hidden="true" />
              <h3 id="checkout-pago" className="text-sm font-semibold text-[var(--color-fg)]">
                Pago y emisión
              </h3>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
              <p className="text-xs font-medium text-[var(--color-fg)]">Reserva sin cobro</p>
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                Se crea el PNR sin cobrar nada. El pago y la emisión se hacen después desde
                Reservas, cuando el proveedor los permite.
              </p>
            </div>
          </section>

          {/* Resumen de validación: qué falta, en claro */}
          {attempted && problems.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertCircle className="size-3.5" />
                Faltan datos para crear la reserva
              </div>
              <ul className="ml-5 list-disc space-y-0.5">
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
            >
              {error}
            </div>
          )}

          {priceChangeTotal ? (
            <div
              role="alert"
              className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-sm text-amber-900">{priceChangeQuestion(priceChangeTotal)}</p>
              <Button
                variant="primary"
                size="sm"
                disabled={submitting}
                onClick={() => void handleSubmit(true)}
                className="h-10 shrink-0 gap-2 sm:h-9"
              >
                <Plane className="size-4" />
                Reservar con el nuevo precio
              </Button>
            </div>
          ) : (
            <div className="mt-5 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                disabled={submitting}
                onClick={() => void handleSubmit()}
                className="h-10 w-full gap-2 sm:h-9 sm:w-auto"
              >
                <Plane className="size-4" />
                {submitting ? 'Creando reserva…' : 'Crear reserva'}
              </Button>
            </div>
          )}
        </fieldset>
      </CardContent>
    </Card>
  );
}

/** Overlay que bloquea el formulario mientras se crea la reserva (no editar a mitad del proceso). */
function BookingOverlay() {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-[var(--color-surface)]/80 backdrop-blur-sm">
      <div className="relative flex size-14 items-center justify-center">
        <span className="absolute size-14 animate-ping rounded-full bg-[var(--color-primary)]/20" />
        <span className="absolute size-11 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
        <Plane className="size-5 text-[var(--color-primary)]" />
      </div>
      <p className="text-sm font-semibold text-[var(--color-fg)]">Creando tu reserva…</p>
      <p className="text-xs text-[var(--color-fg-muted)]">
        Confirmando con la aerolínea. No cierres ni recargues esta ventana.
      </p>
    </div>
  );
}
