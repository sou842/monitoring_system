import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: [
    { file: 'dist/index.mjs', format: 'es', sourcemap: true },
    { file: 'dist/index.cjs', format: 'cjs', sourcemap: true, exports: 'named' },
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
