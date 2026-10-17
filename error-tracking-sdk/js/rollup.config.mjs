import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

// Minified, still ES5. Source maps keep the SDK's own stack frames readable.
const minify = terser({ ecma: 5, format: { comments: false } });

export default {
  input: 'src/index.ts',
  output: [
    { file: 'dist/index.mjs', format: 'es', sourcemap: true, plugins: [minify] },
    { file: 'dist/index.cjs', format: 'cjs', sourcemap: true, exports: 'named', plugins: [minify] },
  ],
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      include: ['src/**/*.ts'],
      declaration: false,
      noEmitHelpers: false,
    }),
  ],
  treeshake: { moduleSideEffects: false },
};
