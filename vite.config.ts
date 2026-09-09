import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyWorkerModuleGraph } from './scripts/verify-worker-module-graph.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveRoot = (...segments: string[]) => path.resolve(__dirname, ...segments);

export default defineConfig({
  plugins: [{ name: 'verify-mv3-static-modules', apply: 'build', generateBundle(_options, bundle) { verifyWorkerModuleGraph(bundle, 'background.js'); } }],
  root: __dirname,
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },
  resolve: {
    alias: [
      { find: '@shared', replacement: resolveRoot('src/shared') },
      { find: '@background', replacement: resolveRoot('src/background') },
      // The ECharts 6 word-cloud package imports utilities from the full entry; bind that exact import to core.
      { find: /^echarts$/, replacement: 'echarts/core' },
    ],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      preserveEntrySignatures: 'allow-extension',
      input: {
        background: 'src/background/index.ts',
        popup: 'popup/index.html',
        dashboard: 'dashboard/index.html',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        strictExecutionOrder: true,
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            // Static MV3 imports remain valid while the shared database library stays below the chunk budget.
            { name: 'dexie', test: /node_modules[\\/]dexie[\\/]/, priority: 10 },
            {
              name: 'echarts-word-cloud',
              test: /node_modules[\\/]@echarts-x[\\/]custom-word-cloud[\\/]/,
              priority: 30,
            },
            {
              name: 'echarts-renderer',
              test: /node_modules[\\/]zrender[\\/]/,
              priority: 20,
            },
            {
              name: 'echarts',
              test: /node_modules[\\/]echarts[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
