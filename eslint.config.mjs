import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Claves de tarjeta de la regla D1 (ver el bloque D1 más abajo). La lista es explícita y sin flag
// `i` porque la expresión va anclada (`^…$`): la insensibilidad a mayúsculas no alcanzaría
// `CardHolderFirstName` ni `PaymentInfo`, y además aflojaría claves de otros proveedores sin que
// nadie lo decidiera.
const D1_CARD_KEYS = [
  // Sabre y el resto de proveedores camelCase.
  'cardNumber',
  'cardSecurityCode',
  'cardTypeCode',
  'cardHolder',
  'authentications',
  'virtualCard',
  'cvv',
  'cvc',
  'securityCode',
  'unmaskPaymentCardNumbers',
  // TBO Hotels (docs/tbo/03-prebook-y-book.md §7.3): PascalCase, así que ninguna casaba con la
  // lista de arriba. `CardHolderlastName` con `l` minúscula es como lo escriben los ejemplos del
  // PDF (p. 34-38) y se prohíbe junto a la forma de la tabla.
  //
  // `PaymentInfo` también es el nombre de un tipo de dominio que importan los builders de
  // latam-ndc: los selectores miran claves escritas y lecturas de miembro, no identificadores de
  // tipo, y esos builders siguen verdes.
  'PaymentInfo',
  'CardNumber',
  'CvvNumber',
  'CardExpirationMonth',
  'CardExpirationYear',
  'CardHolderFirstName',
  'CardHolderLastName',
  'CardHolderlastName',
  'CardHolderAddress',
].join('|');

const D1_OUTBOUND_FILES = [
  '**/request.builder.ts',
  '**/*.request.builder.ts',
  '**/*.serializer.ts',
];

const D1_CARD_KEY_SELECTORS = [
  {
    selector: `Property[key.name=/^(${D1_CARD_KEYS})$/]`,
    message:
      'D1: un fichero que construye un cuerpo de salida no puede escribir un campo de tarjeta. Se reserva y se emite sin PAN (CASH/ON_ACCOUNT/INVOICE) y se cobra por hosted checkout del PSP (PCI SAQ-A). Si esto es el carril SAQ-D, vive en otro fichero y detrás de un flag por tenant.',
  },
  {
    selector: `Property[key.value=/^(${D1_CARD_KEYS})$/]`,
    message:
      'D1: lo mismo con la clave entre comillas. Ver la nota de eslint.config.mjs sobre el alcance de esta regla.',
  },
  {
    selector: `MemberExpression[property.name=/^(${D1_CARD_KEYS})$/]`,
    message:
      'D1: leer un campo de tarjeta dentro de un builder de salida es el paso previo a escribirlo. El dato de tarjeta no entra en este carril.',
  },
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // -------------------------------------------------------------------------------------------
  // D1 (docs/sabre/10-requisitos-maestro.md §9) — nada con forma de dato de tarjeta se ESCRIBE en
  // un cuerpo de salida.
  //
  // El alcance es deliberadamente estrecho: sólo los ficheros que construyen lo que SALE. Aplicar
  // esto a un provider entero sería un error concreto, no un exceso de celo: `getBooking` devuelve
  // la tarjeta ya ENMASCARADA por Sabre y enseñarle los cuatro últimos dígitos al vendedor es
  // funcionalidad legítima, que obliga a nombrar el campo en el mapper de LECTURA. Prohibir el
  // nombre en todas partes obligaría a desactivar la regla justo donde el dato es real.
  //
  // Se prohíbe **escribir la clave**, no nombrarla: el selector es `Property`, que en ESTree cubre
  // literales de objeto y patrones de desestructuración, y NO cubre `TSPropertySignature`. Esa
  // distinción es la que deja en pie la barrera de compilación de D1 —los siete campos de tarjeta
  // declarados `?: never` en `providers/sabre/src/booking/create.request.builder.ts`—, que es una
  // defensa más fuerte que este lint y que una regla más ancha borraría.
  //
  // `cardType` y `binNumber` NO están en la lista: son el carril de BIN de `offers/price`, que el
  // contrato admite y que el builder cierra tras `allowCardBinPricing`, apagado por defecto. Que
  // esté apagado se comprueba con tests, no prohibiendo un nombre legítimo.
  //
  // Los bytes de salida los vigila además `providers/sabre/src/pan-egress.guard.test.ts`, que
  // corre en la suite. Este lint es la red que dispara antes, al escribir.
  {
    files: D1_OUTBOUND_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...D1_CARD_KEY_SELECTORS],
    },
  },
  // D1 en los builders de TBO (docs/tbo/03-prebook-y-book.md §7; 08 RNF-04 capa 4): además de las
  // claves, los modos de pago con tarjeta. `NewCard` y `SavedCard` obligan a mandar `PaymentInfo`
  // con PAN o CVV; nosotros sólo reservamos con `Limit`. Son valores del enum de TBO (p. 70) y
  // fuera de este paquete no significan nada, por eso el bloque no sale de `providers/tbo-hotels`.
  //
  // El bloque REPITE los selectores de claves: en la configuración plana, las opciones de
  // `no-restricted-syntax` de un bloque posterior reemplazan a las del anterior, y un bloque con
  // sólo el `Literal` apagaría la prohibición de claves justo en estos builders. Lo fija
  // `providers/tbo-hotels/src/pan-lint-rule.guard.test.ts`.
  //
  // `Literal` también casa con los tipos literales (`'NewCard'` en una unión), y aquí se quiere:
  // un builder de TBO no tiene por qué nombrar esos modos ni en un tipo. `Identifier` cubre el
  // otro modo natural de escribirlos, `PaymentMode.NewCard` desde un enum declarado en otro
  // fichero, donde en el builder no queda ningún literal. `PaymentMode: 'Limit'` y
  // `PaymentInfo?: never` siguen permitidos.
  {
    files: D1_OUTBOUND_FILES.map((glob) => `providers/tbo-hotels/${glob}`),
    rules: {
      'no-restricted-syntax': [
        'error',
        ...D1_CARD_KEY_SELECTORS,
        {
          selector:
            ':matches(Literal[value=/^(NewCard|SavedCard)$/], Identifier[name=/^(NewCard|SavedCard)$/])',
          message:
            'D1: un builder de TBO sólo reserva con PaymentMode "Limit". NewCard y SavedCard mandan PaymentInfo con PAN o CVV por nuestro servidor (docs/tbo/03-prebook-y-book.md §7): no se nombran ni como valor ni como tipo.',
        },
      ],
    },
  },
  {
    files: ['apps/web-b2b/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
);
