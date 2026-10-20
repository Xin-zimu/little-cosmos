import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'src/main.js',
  output: {
    file: 'game.bundle.js',
    format: 'iife',
    name: 'LittleCosmos',
    sourcemap: false,
    inlineDynamicImports: true,
  },
  plugins: [nodeResolve()],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
};
