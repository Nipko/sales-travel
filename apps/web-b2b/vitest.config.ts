import { defineConfig } from 'vitest/config';

// El panel compila con Next (`jsx: preserve`), que usa el runtime automático de React. Sin esto,
// esbuild transforma el JSX al clásico `React.createElement` y un test que renderiza un componente
// falla con "React is not defined".
export default defineConfig({
  esbuild: { jsx: 'automatic' },
});
