/**
 * Plataforma → Estado › Pendientes: lo que el proyecto tiene abierto y no vive en la base (una
 * gestión con un proveedor, una decisión del founder, una deuda técnica con fecha). Lista versionada
 * a propósito (founder 2026-11-19): se cambia por PR, y la pantalla cuenta los días que lleva cada
 * uno.
 *
 * Cómo se mantiene: quien cierra un pendiente borra su entrada en el mismo PR que lo cierra; quien
 * descubre uno lo agrega con la fecha en que se abrió (o, si no se sabe, la de su registro, y lo dice
 * en `action`). Lo que el sistema ya mide solo (un proveedor caído, una conciliación que falla) no va
 * acá: lo muestran las otras áreas del Estado. Sin I/O. Un test exige fechas válidas, ids únicos y
 * que cada doc enlazado exista.
 */

export type PendingLevel = 'critical' | 'high' | 'medium' | 'low';
export type PendingOwner = 'founder' | 'claude';

export interface PendingStep {
  readonly owner: PendingOwner;
  readonly text: string;
}

export interface PendingLink {
  readonly label: string;
  /** Una ruta del repo (`docs/...`) o una URL completa (`https://...`). */
  readonly target: string;
}

export interface ProjectPending {
  readonly id: string;
  readonly title: string;
  /** `AAAA-MM-DD`: desde cuándo está abierto. */
  readonly since: string;
  readonly level: PendingLevel;
  /** Por qué importa, en una o dos frases. */
  readonly why: string;
  readonly steps: readonly PendingStep[];
  readonly links: readonly PendingLink[];
}

export const PROJECT_PENDINGS: readonly ProjectPending[] = [
  {
    id: 'sabre-h07',
    title: 'Sabre H-07: la oficina de reserva no guarda el tipo de pasajero',
    since: '2026-11-05',
    level: 'critical',
    why: 'Las reservas de Sabre salen por un rodeo temporal: se reservan a nombre de la oficina de emisión (bookOnTicketingPcc). Falta que Sabre active «Store Passenger Type In PNR» en el TJR de la oficina de reserva.',
    steps: [
      { owner: 'founder', text: 'Pedir a Sabre la activación en el TJR de la oficina de reserva.' },
      {
        owner: 'claude',
        text: 'Cuando Sabre confirme: apagar el rodeo, repetir sab-12 y quitar el rodeo del código.',
      },
    ],
    links: [{ label: 'Hallazgos del sandbox', target: 'docs/sabre/12-hallazgos-sandbox.md' }],
  },
  {
    id: 'tbo-soporte',
    title: 'TBO no responde: escribir a soporte',
    since: '2026-11-13',
    level: 'critical',
    why: 'El 13 nov fue la última búsqueda de TBO con resultados. Desde el 17 nov la conciliación recibe HTTP 503, y el 16 nov dio 403 por credenciales inválidas.',
    steps: [
      {
        owner: 'founder',
        text: 'Escribir a soporte de TBO con las fechas y los códigos, y preguntar si cambiaron las credenciales de prueba.',
      },
      {
        owner: 'claude',
        text: 'Si lo apruebas, apagar TBO desde Activación hasta que responda.',
      },
    ],
    links: [{ label: 'Preguntas para TBO', target: 'docs/tbo/10-preguntas-para-tbo.md' }],
  },
  {
    id: 'latam-tarjeta',
    title: 'LATAM: el número de tarjeta y el CVV pasan por nuestro servidor',
    since: '2026-11-19',
    level: 'critical',
    why: 'El pago con tarjeta de OrderCreate y OrderChange arma el XML con el número y el CVV. Eso contradice la regla SAQ-A de CLAUDE.md. El enlace de pago de LATAM ya existe y no toca la tarjeta. Fecha de registro; la deuda es anterior.',
    steps: [
      {
        owner: 'founder',
        text: 'Decidir si se retira el pago con tarjeta y queda solo el enlace de pago.',
      },
      {
        owner: 'claude',
        text: 'Retirarlo (P2-0), con un test que impida volver a mandar el número o el CVV.',
      },
    ],
    links: [
      {
        label: 'request.builder.ts',
        target: 'providers/latam-ndc/src/ordercreate/request.builder.ts',
      },
      { label: 'Estado y plan de LATAM', target: 'docs/latam-ndc/01-estado-y-plan.md' },
    ],
  },
  {
    id: 'sabre-cert-pnrs',
    title: 'Sabre CERT: localizadores sin cerrar',
    since: '2026-11-12',
    level: 'high',
    why: 'La prueba de emisión SAB-13 dejó el localizador STECKS vivo sin emitir y SXGFHO en duda. También quedan las corridas del 19 oct sin localizador.',
    steps: [
      {
        owner: 'founder',
        text: 'Revisar SXGFHO y cerrar STECKS en Sabre Red, o pedirle el detalle a Sabre con el Conversation-ID de la corrida.',
      },
    ],
    links: [{ label: 'Hallazgos del sandbox', target: 'docs/sabre/12-hallazgos-sandbox.md' }],
  },
  {
    id: 'node-20',
    title: 'Node 20 ya no tiene soporte',
    since: '2026-04-30',
    level: 'medium',
    why: '.nvmrc y los Dockerfile siguen en Node 20.18. GitHub Actions avisa que checkout, build-push, login y setup-buildx apuntan a Node 20 y los fuerza a correr en Node 24.',
    steps: [
      {
        owner: 'claude',
        text: 'Abrir un PR que pase a Node 22 LTS (.nvmrc, Dockerfiles y deploy.yml) y actualice las actions.',
      },
    ],
    links: [
      { label: 'deploy.yml', target: '.github/workflows/deploy.yml' },
      { label: 'Dockerfile del API', target: 'apps/api/Dockerfile' },
    ],
  },
  {
    id: 'release-0-1-7',
    title: 'La versión 0.1.7 no está publicada',
    since: '2026-10-08',
    level: 'medium',
    why: 'El PR de release-please sigue abierto y su CI espera aprobación, así que package.json sigue en 0.1.6.',
    steps: [
      {
        owner: 'founder',
        text: 'Aprobar el CI del PR y mergearlo, o cerrarlo si no se usan releases.',
      },
    ],
    links: [{ label: 'PR #31', target: 'https://github.com/Nipko/sales-travel/pull/31' }],
  },
  {
    id: 'despegar-decisiones',
    title: 'Despegar: decisiones comerciales y sandbox de certificación',
    since: '2026-11-18',
    level: 'medium',
    why: 'Faltan cuatro decisiones: cuenta corriente, modelo comisionable, contenido estático y voucher. La certificación lleva 12 de 16 puntos, y el punto 1 espera el sandbox.',
    steps: [
      {
        owner: 'founder',
        text: 'Confirmar los valores por defecto de §3 y §4, y pedirle a Despegar el sandbox para los 4 casos.',
      },
    ],
    links: [{ label: 'Brechas y plan', target: 'docs/despegar/02-brechas-y-plan.md' }],
  },
  {
    id: 'latam-cop',
    title: 'LATAM cotiza en BRL a la cuenta de Colombia',
    since: '2026-11-04',
    level: 'medium',
    why: 'En el sandbox, el punto de venta de Colombia no cotiza en COP.',
    steps: [
      {
        owner: 'founder',
        text: 'Pedirle a soporte NDC de LATAM el punto de venta de Colombia en COP.',
      },
    ],
    links: [{ label: 'Estado y plan de LATAM', target: 'docs/latam-ndc/01-estado-y-plan.md' }],
  },
  {
    id: 'agentcars-ip',
    title: 'AgentCars: IP del servidor y voucher',
    since: '2026-09-30',
    level: 'medium',
    why: 'El token de pruebas daba 401 hasta que se registrara la IP del servidor, y no consta que se haya hecho. La certificación también exige el voucher en PDF con voucherAmount.',
    steps: [
      { owner: 'founder', text: 'Confirmar con AgentCars que la IP del VPS quedó registrada.' },
      { owner: 'claude', text: 'Hacer el voucher en PDF con voucherAmount.' },
    ],
    links: [{ label: 'Referencia de AgentCars', target: 'docs/cars/agentcars-api-reference.md' }],
  },
  {
    id: 'ssh-logs',
    title: 'Quitar la clave SSH de lectura de logs',
    since: '2026-11-19',
    level: 'low',
    why: 'La clave claude-logs-sales-travel sigue autorizada para el usuario deploy del VPS. Fecha de registro.',
    steps: [
      {
        owner: 'founder',
        text: 'Quitarla de ~/.ssh/authorized_keys de deploy cuando ya no haga falta.',
      },
    ],
    links: [],
  },
];

const DAY_MS = 86_400_000;

/** El enlace, listo para la pantalla: las rutas del repo, a su archivo en `main`. */
export const REPO_BLOB_BASE = 'https://github.com/Nipko/sales-travel/blob/main/';

export interface PendingView {
  id: string;
  title: string;
  since: string;
  /** Días enteros desde `since` hasta `now` (0 si es hoy). */
  daysOpen: number;
  level: PendingLevel;
  why: string;
  steps: PendingStep[];
  links: { label: string; href: string }[];
}

const LEVEL_ORDER: Record<PendingLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Los pendientes con los días que llevan, del más grave al menos y, a igual nivel, el más viejo primero. */
export function pendingsView(pendings: readonly ProjectPending[], now: Date): PendingView[] {
  return pendings
    .map((p) => ({
      id: p.id,
      title: p.title,
      since: p.since,
      daysOpen: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(`${p.since}T00:00:00Z`)) / DAY_MS),
      ),
      level: p.level,
      why: p.why,
      steps: p.steps.map((s) => ({ ...s })),
      links: p.links.map((l) => ({
        label: l.label,
        href: l.target.startsWith('https://') ? l.target : `${REPO_BLOB_BASE}${l.target}`,
      })),
    }))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.daysOpen - a.daysOpen);
}
