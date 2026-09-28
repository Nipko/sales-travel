/**
 * Clientes del CRM del tenant de certificación (docs/tbo/07 §7.3.7): el formulario de huéspedes
 * los ofrece para prellenar, y la nacionalidad sale de aquí (alfa-3 → alfa-2 en la web).
 *
 * Ficticios de punta a punta. Correos en `example.com` (RFC 2606, no entrega a nadie), sin
 * teléfono y con documentos que no siguen el formato de ningún país. Varias nacionalidades para
 * que el tester vea que la tarifa depende de la del huésped líder (CK-01).
 */
export interface FictitiousCustomer {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly documentType: 'PASAPORTE';
  readonly documentNumber: string;
  /** ISO 3166-1 alfa-3, como guarda `customers`. */
  readonly documentIssuingCountry: string;
  readonly birthdate: string;
  readonly gender: 'F' | 'M';
  readonly nationality: string;
}

/** Etiqueta del CRM que marca lo sembrado; también sirve para encontrarlo a mano. */
export const SEED_CUSTOMER_TAG = 'certificacion-tbo';

export const FICTITIOUS_CUSTOMERS: readonly FictitiousCustomer[] = Object.freeze([
  {
    firstName: 'Ana',
    lastName: 'Prueba',
    email: 'ana.prueba@example.com',
    documentType: 'PASAPORTE',
    documentNumber: 'TBOCERT0001',
    documentIssuingCountry: 'COL',
    birthdate: '1988-03-14',
    gender: 'F',
    nationality: 'COL',
  },
  {
    firstName: 'Bruno',
    lastName: 'Teste',
    email: 'bruno.teste@example.com',
    documentType: 'PASAPORTE',
    documentNumber: 'TBOCERT0002',
    documentIssuingCountry: 'BRA',
    birthdate: '1979-11-02',
    gender: 'M',
    nationality: 'BRA',
  },
  {
    firstName: 'Carla',
    lastName: 'Ensayo',
    email: 'carla.ensayo@example.com',
    documentType: 'PASAPORTE',
    documentNumber: 'TBOCERT0003',
    documentIssuingCountry: 'PER',
    birthdate: '1995-07-21',
    gender: 'F',
    nationality: 'PER',
  },
  {
    firstName: 'John',
    lastName: 'Sample',
    email: 'john.sample@example.com',
    documentType: 'PASAPORTE',
    documentNumber: 'TBOCERT0004',
    documentIssuingCountry: 'USA',
    birthdate: '1983-01-30',
    gender: 'M',
    nationality: 'USA',
  },
]);
