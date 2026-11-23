/**
 * Respuestas de la API de actividades de Despegar armadas con los ESQUEMAS y los ejemplos de la
 * documentación (docs/despegar/03-actividades-api.md), no capturadas de la API real: la clave de
 * sandbox responde 403 en actividades (2026-11-23). Cuando se habilite, reemplazarlas por las que
 * guarde `node tools/despegar/activities-smoke.mjs --save <carpeta>`.
 *
 * Los valores siguen los casos de la certificación: Universal Orlando (`UN_ORL`) para 2 adultos +
 * niño de 7 + bebé de 1, con precio en USD y en BRL (site `br`).
 */

export const DISCOVERY_ORL = [
  {
    items: [
      { tracking_id: 'UN_ORL', type: 'TICKET', name: 'Universal Orlando Resort' },
      { tracking_id: 'DY_ORL', type: 'TICKET', name: 'Walt Disney World' },
      { tracking_id: 'TOUR_KSC_123', type: 'TOUR', name: 'Kennedy Space Center con traslado' },
    ],
  },
  // Un duplicado en otro grupo no se repite.
  { items: [{ tracking_id: 'UN_ORL', type: 'TICKET', name: 'Universal Orlando Resort' }] },
];

export const MODALITIES_UN_ORL = {
  ticket_id: 'UN_ORL',
  tracking_id: 'UN_ORL',
  id: 'UN_ORL',
  type: 'TICKET',
  name: 'Universal Orlando Resort',
  description: 'Entradas a los parques de Universal Orlando.',
  duration: { type: 'DAY', value: 1 },
  modalities: [
    {
      id: 'ORL_1P1D_EPIC',
      modality_type: 'Modality',
      name: '1 parque, 1 día',
      available_dates: [
        { date: '2026-12-10', hours: [] },
        { date: '2026-12-11', hours: [] },
      ],
      prices: [
        { currency: 'USD', unit_price: 139.0 },
        { currency: 'BRL', unit_price: 765.5 },
      ],
      max_capacity: 9,
      adult_age_range: { min_age: 10, max_age: 99 },
      child_age_range: { min_age: 3, max_age: 9 },
      infant_age_range: { min_age: 0, max_age: 2 },
      additionals: [
        {
          id: 'EXPRESS',
          title: 'Universal Express',
          description: 'Acceso preferencial a las atracciones',
          price: [{ currency: 'USD', unit_price: 89 }],
          inclusions: [],
          exclusions: [],
        },
      ],
    },
    {
      id: 'TOUR_MORNING',
      modality_type: 'Modality',
      name: 'Visita guiada de mañana',
      available_dates: [
        {
          date: '2026-12-10',
          hours: [
            { id: 1, hour: 930 },
            { id: 2, hour: 11 },
          ],
        },
      ],
      prices: [{ currency: 'USD', unit_price: 60 }],
      max_capacity: 0,
      additionals: [],
    },
    // Sin id: se descarta.
    { name: 'rota' },
  ],
  images: [
    { url: 'https://media.despegar.com/un_orl/1.jpg', key: '1', width: 800, height: 600 },
    { url: 'http://media.despegar.com/un_orl/2.jpg', key: '2', width: 800, height: 600 },
    { url: 'ftp://nope/3.jpg', key: '3', width: 1, height: 1 },
  ],
  inclusions: ['Entrada a un parque', { description: 'Estacionamiento' }],
  exclusions: ['Comidas'],
};

export const AVAILABILITY_UN_ORL_FAMILY = {
  choice_id: 'eyJjaG9pY2UiOiJVTl9PUkwtMjAyNi0xMi0xMCJ9',
  name: 'Universal Orlando Resort',
  modality_choice_name: '1 parque, 1 día',
  type: 'TICKET',
  language: 'es',
  site: 'BR',
  destination: 'ORL',
  from: '2026-12-10T09:00:00-05:00',
  to: '2026-12-10T21:00:00-05:00',
  distribution: {
    adults: 2,
    adults_ages: [],
    children_ages: [7],
    infants_ages: [1],
    adult_max_age: 120,
    child_max_age: 9,
    infant_max_age: 2,
  },
  additions_chosen: [],
  price_details: [
    {
      total: 417.0,
      net: 380.0,
      tax: 37.0,
      gross: 417.0,
      currency: 'USD',
      currency_to_usd_change_rate: 1,
      usd_to_currency_change_rate: 1,
      price_disaggregation: { agency_commission: { gross: 41.7, net: 38, tax: 3.7 } },
    },
    {
      total: '2296.50',
      net: 2092.9,
      tax: 203.6,
      gross: 2296.5,
      currency: 'BRL',
      currency_to_usd_change_rate: 0.1816,
      usd_to_currency_change_rate: 5.507,
      price_disaggregation: { agency_commission: { gross: 229.65, net: 209.29, tax: 20.36 } },
    },
  ],
  cancellation_policy: {
    title: 'Cancelación con cargo según la fecha',
    cancellable: true,
    ranges: [
      {
        from: '2026-11-23',
        to: '2026-12-05',
        penalty: { USD: 0, BRL: 0 },
        percentage: 0.0,
        label: 'Gratis',
      },
      {
        from: '2026-12-05',
        to: '2026-12-09',
        penalty: { USD: 208.5, BRL: 1148.25 },
        percentage: 50.0,
        label: '50%',
      },
      {
        from: '2026-12-09',
        penalty: { USD: 417, BRL: 2296.5 },
        percentage: 100.0,
        label: 'Sin reembolso',
      },
    ],
    conditions: ['La cancelación aplica a todos los participantes.'],
  },
  highlights: ['Harry Potter', 'Jurassic World VelociCoaster'],
  ticket_validity: { use_date: '2026-12-10', use_expiration_date: '2026-12-10T23:59:59Z' },
};

/** Dos días de Disney: la respuesta trae `choice_id` por modalidad y día. */
export const SHOPPING_DY_ORL = [
  {
    tracking_id: 'DY_ORL',
    name: 'Walt Disney World',
    description: '<p>Parques de Disney en Orlando</p>',
    logo: 'https://media.despegar.com/dy_orl/logo.png',
    images: [{ url: 'https://media.despegar.com/dy_orl/1.jpg', key: '1', width: 800, height: 600 }],
    modalities: [
      {
        modality_type: 'Modality',
        id: '1-DAY-MK',
        name: 'Magic Kingdom 1 día',
        description: 'Un día en Magic Kingdom',
        duration: { type: 'DAY', value: '1' },
        inclusions: ['Entrada'],
        exclusions: [],
        availabilities: [
          {
            choice_id: 'eyJzYW1wbGUiOiJ0cnVlIn0=',
            date: '2026-12-10',
            price_details: [{ total: 100, currency: 'USD', net: 95, tax: 5, gross: 100 }],
            additionals: [],
            distribution: {
              adults: 2,
              adults_ages: [],
              children_ages: [5, 9],
              infants_ages: [],
              adult_max_age: 120,
              child_max_age: 9,
              infant_max_age: 2,
            },
            cancellation_policy: {
              title: 'Free cancellation',
              cancellable: true,
              ranges: [
                {
                  from: '2026-11-23T00:00:00Z',
                  to: '2026-12-09T23:59:59Z',
                  penalty: { USD: 0 },
                  percentage: 0,
                  label: 'Gratis',
                },
                {
                  from: '2026-12-10T00:00:00Z',
                  penalty: { USD: 100 },
                  percentage: 100,
                  label: '100%',
                },
              ],
              conditions: [],
            },
            ticket_validity: {
              use_date: '2026-12-10',
              use_expiration_date: '2026-12-10T23:59:59Z',
            },
          },
          {
            choice_id: 'eyJkYXkiOiIyMDI2LTEyLTExIn0=',
            date: '2026-12-11',
            price_details: [{ total: 110, currency: 'USD', net: 104, tax: 6, gross: 110 }],
            additionals: [],
            distribution: { adults: 2, adults_ages: [], children_ages: [5, 9], infants_ages: [] },
            cancellation_policy: {
              title: 'No reembolsable',
              cancellable: false,
              ranges: [],
              conditions: [],
            },
          },
          // Sin precio: no es vendible.
          { choice_id: 'sin-precio', date: '2026-12-12', price_details: [] },
        ],
      },
    ],
  },
];

export const SUGGESTIONS_ACTIVITIES = {
  items: [
    {
      id: 'POI_649980',
      display: 'Universal Studios, Orlando, Florida',
      highlight: '<em>Univ</em>ersal Studios',
      target: {
        id: '649980',
        gid: 'POI_649980',
        type: 'POI',
        parents: {
          continent: 'C_1',
          country: 'CO_US',
          administrative_division: 'AD_FL',
          city: 'CI_ORL',
        },
      },
    },
  ],
};

export const PREBOOK_ACTIVITY = {
  prebook_id: 'prebook-act-1',
  expiration: '2026-11-23T22:08:18Z',
  status: 'OK',
  flow: 'DEFAULT',
  total: 417,
  currency: 'USD',
  commission: { amount: 41.7, max_amount: 41.7, min_amount: 0 },
  extended_info: {
    exchange_policies: {
      K0: {
        product_type: 'TICKET',
        product_title: 'Universal Orlando Resort',
        range: [],
        conditions: [
          {
            title: 'Cambios',
            question_and_answer: [
              { question: '¿Puedo cambiar la fecha?', answer: 'No se admiten cambios.' },
            ],
          },
        ],
        disclaimers: [{ title: 'Importante', description: 'Presentar documento en la entrada.' }],
        summary: {
          operations_summaries: [
            { title: 'Cancelación', description: 'Hasta el 5/12 sin cargo', permit: true },
          ],
          disclaimers: [{ description: 'Los horarios pueden cambiar.' }],
        },
      },
    },
    hints: [
      {
        modality: 'PAYINADVANCE',
        payment_option: 'CURRENT_ACCOUNT',
        hint: {
          form: { travelers: { hint_type: 'ALL_TRAVELERS', validations: ['BIRTH_DATE_REQUIRED'] } },
        },
      },
    ],
  },
};

export const PAYMENTS_CURRENT_ACCOUNT = {
  modalities: [
    {
      modality: 'PAYINADVANCE',
      price_information: {
        total: { base: 380, taxes: 37, fees: 0, discount: 0, total: 417 },
        currency: 'USD',
      },
      payment_options: [
        { option_type: 'CURRENT_ACCOUNT' },
        {
          option_type: 'ONE_CARD',
          group_plans: [
            {
              type: 'CARD',
              plans: [
                {
                  id: 'plan-1',
                  type: 'CREDIT',
                  installments: 1,
                  card_brand: 'VI',
                  price: { currency: 'USD', total: 417 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const PAYMENTS_CARD_ONLY = {
  modalities: [
    {
      modality: 'PAYINADVANCE',
      price_information: { total: { total: 417 }, currency: 'USD' },
      payment_options: [{ option_type: 'ONE_CARD', group_plans: [] }],
    },
  ],
};

export const BOOK_SUCCESS = {
  reservationId: '815222296950',
  status: 'SUCCESS',
  products: [{ type: 'TICKET', plataform_id: 24315872051, pnr: 77812 }],
};

export const BOOK_INSUFFICIENT_FUNDS = {
  reservation_id: '815222296951',
  status: 'ERROR',
  sub_status: 'INSUFFICIENT_FUNDS',
  message: 'Insufficient funds',
  products: [],
};

export const RESERVATIONS_TICKET = {
  items: [
    {
      id: 'item-1',
      product: {
        product_id: '99001',
        product_type: 'TICKET',
        transaction_id: '55001',
        status: 'ISSUED',
        purchase_date_time: '2026-11-23T15:00:00Z',
        pnr: '77812',
        reservation_id: '815222296950',
        sale_price: { currency: 'USD', price: 417, conversion_rate: 1 },
        passengers: [
          {
            type: 'ADULT',
            first_name: 'José',
            last_name: 'Peña',
            birth_date: '1990-01-01T00:00:00Z',
          },
          { type: 'CHILD', first_name: 'Ana', last_name: 'Peña' },
          { type: 'INFANT', first_name: 'Iñaki', last_name: 'Peña' },
        ],
        use_date: '2026-12-10T00:00:00Z',
        use_expiration_date: '2026-12-10T23:59:59Z',
        use_type: 'FIXED',
        ticket_type: 'UNIVERSAL',
        duration: 1,
        highlights: ['Harry Potter'],
        all_travelers_required: true,
        cancellation_policy: { cancellable: true, conditions: [], descriptions: [], ranges: [] },
        download_voucher_url: '/v3/vouchers/815222296950.pdf',
      },
    },
    // Un hotel de la misma reserva no es una actividad.
    { id: 'item-2', product: { product_id: '99002', product_type: 'HOTEL', status: 'ISSUED' } },
  ],
};

export const CANCEL_ALLOWED = {
  product_allowance: {
    product_type: 'TICKET',
    product_id: 99001,
    allowance: 'ALLOWED',
    refund_policy: 'TOTAL_REFUND',
    policy: 'BY_POLICIES',
  },
  related_products_allowances: [],
};

export const CANCEL_DISALLOWED = {
  product_allowance: {
    product_type: 'TICKET',
    product_id: 99001,
    allowance: 'DISALLOWED',
    disallowed_reason: 'TICKET_STATUS_USED',
  },
};

export const CANCEL_QUOTE = {
  allowance_info: {
    product_allowance: { product_type: 'TICKET', product_id: 99001, allowance: 'ALLOWED' },
    quote: {
      product_quote: {
        quote_id: 'Q-1',
        product_data: {
          product_type: 'TICKET',
          product_id: 99001,
          transaction_id: 55001,
          currency: 'USD',
        },
        refund_policy: 'TOTAL_REFUND',
        resolution: 'AUTOMATIC',
        guaranteed: true,
        status: 'QUOTED',
        price_box: {
          refunds: [
            {
              original_payment_method: 'CURRENT_ACCOUNT',
              refund_method_price_box: {
                currency: 'USD',
                payment_amount: 417,
                applied_penalty: 0,
                refund_amount: 417,
              },
            },
          ],
        },
      },
    },
  },
};

export const CANCEL_DONE = { flow_id: 'CAN-123', product_id: '99001', product_type: 'TICKET' };

export const ERROR_NO_AVAILABILITY = {
  code: 'ACTIVITY_PROVIDER_ERROR',
  message: 'Error with activity provider.',
};

export const ERROR_PAST_DATE = {
  code: 'INVALID_FIELD',
  message: "Invalid date value '2024-01-01' for field 'date'. It's a past date.",
};

export const ERROR_FORBIDDEN = { message: "doesn't have access to this method" };
