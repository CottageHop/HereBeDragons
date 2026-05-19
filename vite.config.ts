import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const isLib = mode === 'lib' || process.env.BUILD_LIB === '1';

  return {
    plugins: isLib
      ? [
          dts({
            entryRoot: 'src',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/**/*.worker.ts'],
            insertTypesEntry: true
          })
        ]
      : [],
    worker: {
      format: 'es'
    },
    build: isLib
      ? {
          lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'index.js'
          },
          sourcemap: true,
          rollupOptions: {
            external: ['three']
          },
          target: 'es2022',
          minify: false
        }
      : {
          target: 'es2022',
          sourcemap: true
        },
    server: {
      port: 5173,
      open: '/index.html'
    },
    test: {
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts', 'src/**/*.test.ts']
    }
  };
});
