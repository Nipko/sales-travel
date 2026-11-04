/**
 * Catálogo de lo que gobierna el superadmin: proveedores y, de cada uno, sus formas de pago.
 *
 * Es la única lista. La base guarda reglas y perfiles con estos códigos
 * (`db/migrations/0089_governance_profiles.sql`) y el API rechaza cualquier otro. Un proveedor o
 * una forma de pago nueva entra aquí con un PR y nace APAGADA: nada se vende ni se cobra si un
 * superadmin no lo encendió (`docs/platform/14-opciones-de-pago.md`).
 *
 * La cartera de la red (`network-wallet`) no es una forma de pago elegible, es cómo se liquida con el
 * proveedor; el cupo `Limit` de TBO tampoco. Por eso no aparecen.
 */

export const GOVERNANCE_VERTICALS = ['flights', 'hotels', 'cars'] as const;
export type GovernanceVertical = (typeof GOVERNANCE_VERTICALS)[number];

/**
 * Alcance PCI de una forma de pago:
 * - `none`: no hay tarjeta (efectivo, a cuenta, factura, cupo).
 * - `saq-a`: la tarjeta la captura el proveedor o un checkout alojado; nunca toca nuestro servidor.
 * - `out-of-scope`: el número y el CVV pasan por nuestro servidor. Fuera de SAQ-A (`CLAUDE.md`).
 */
export type PaymentPciScope = 'none' | 'saq-a' | 'out-of-scope';

export interface GovernedPaymentMethod {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly pci: PaymentPciScope;
}

export interface GovernedProvider {
  readonly code: string;
  readonly label: string;
  readonly vertical: GovernanceVertical;
  readonly paymentMethods: readonly GovernedPaymentMethod[];
}

export const GOVERNANCE_CATALOG: readonly GovernedProvider[] = [
  {
    code: 'latam-ndc',
    label: 'LATAM NDC',
    vertical: 'flights',
    paymentMethods: [
      {
        code: 'payment_link',
        label: 'Enlace de pago LATAM',
        description:
          'LATAM le envía al pagador un enlace para pagar en su sitio. La tarjeta nunca pasa por la plataforma.',
        pci: 'saq-a',
      },
      {
        code: 'cash',
        label: 'Efectivo / BSP',
        description: 'Pago de agencia (Cash), liquidado por BSP.',
        pci: 'none',
      },
      {
        code: 'gov',
        label: 'GOV',
        description: 'Forma de pago GOV de LATAM.',
        pci: 'none',
      },
      {
        code: 'card',
        label: 'Tarjeta digitada en la plataforma',
        description:
          'El vendedor digita la tarjeta y el número y el CVV pasan por nuestro servidor hacia LATAM. Fuera de PCI SAQ-A.',
        pci: 'out-of-scope',
      },
    ],
  },
  {
    code: 'sabre',
    label: 'Sabre',
    vertical: 'flights',
    paymentMethods: [
      {
        code: 'cash',
        label: 'Emisión en efectivo (BSP)',
        description: 'Forma de pago de emisión CASH, liquidada por BSP.',
        pci: 'none',
      },
      {
        code: 'on_account',
        label: 'Emisión a cuenta',
        description: 'Forma de pago de emisión ON_ACCOUNT.',
        pci: 'none',
      },
      {
        code: 'invoice',
        label: 'Emisión con factura',
        description: 'Forma de pago de emisión INVOICE.',
        pci: 'none',
      },
    ],
  },
  {
    code: 'despegar-hotels',
    label: 'Despegar hoteles',
    vertical: 'hotels',
    paymentMethods: [
      {
        code: 'card_token',
        label: 'Tarjeta tokenizada',
        description: 'Tarjeta capturada en el checkout alojado de Despegar; llega como token.',
        pci: 'saq-a',
      },
    ],
  },
  {
    code: 'tbo-hotels',
    label: 'TBO hoteles',
    vertical: 'hotels',
    paymentMethods: [],
  },
  {
    code: 'agent-cars',
    label: 'AgentCars',
    vertical: 'cars',
    paymentMethods: [
      {
        code: 'prepaid',
        label: 'Prepago',
        description: 'El auto se paga al reservar.',
        pci: 'none',
      },
      {
        code: 'pay_at_destination',
        label: 'Pago en destino',
        description: 'El cliente paga el auto al retirarlo.',
        pci: 'none',
      },
    ],
  },
];

/** `''` es el proveedor mismo; otro valor, una de sus formas de pago. */
export interface GovernanceItemKey {
  readonly provider: string;
  readonly method: string;
}

export function governedProvider(code: string): GovernedProvider | undefined {
  return GOVERNANCE_CATALOG.find((p) => p.code === code);
}

/** ¿El par existe en el catálogo? `method: ''` pregunta por el proveedor. */
export function isGovernedItem(key: GovernanceItemKey): boolean {
  const provider = governedProvider(key.provider);
  if (!provider) return false;
  return key.method === '' || provider.paymentMethods.some((m) => m.code === key.method);
}

/** Todos los elementos del catálogo: cada proveedor y cada una de sus formas de pago. */
export function governanceItems(): GovernanceItemKey[] {
  return GOVERNANCE_CATALOG.flatMap((p) => [
    { provider: p.code, method: '' },
    ...p.paymentMethods.map((m) => ({ provider: p.code, method: m.code })),
  ]);
}
