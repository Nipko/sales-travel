import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
    files: ['**/request.builder.ts', '**/*.request.builder.ts', '**/*.serializer.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Property[key.name=/^(cardNumber|cardSecurityCode|cardTypeCode|cardHolder|authentications|virtualCard|cvv|cvc|securityCode|unmaskPaymentCardNumbers)$/]',
          message:
            'D1: un fichero que construye un cuerpo de salida no puede escribir un campo de tarjeta. Se reserva y se emite sin PAN (CASH/ON_ACCOUNT/INVOICE) y se cobra por hosted checkout del PSP (PCI SAQ-A). Si esto es el carril SAQ-D, vive en otro fichero y detrás de un flag por tenant.',
        },
        {
          selector:
            'Property[key.value=/^(cardNumber|cardSecurityCode|cardTypeCode|cardHolder|authentications|virtualCard|cvv|cvc|securityCode|unmaskPaymentCardNumbers)$/]',
          message:
            'D1: lo mismo con la clave entre comillas. Ver la nota de eslint.config.mjs sobre el alcance de esta regla.',
        },
        {
          selector:
            'MemberExpression[property.name=/^(cardNumber|cardSecurityCode|cardTypeCode|cardHolder|authentications|virtualCard|cvv|cvc|securityCode|unmaskPaymentCardNumbers)$/]',
          message:
            'D1: leer un campo de tarjeta dentro de un builder de salida es el paso previo a escribirlo. El dato de tarjeta no entra en este carril.',
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
