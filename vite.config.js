import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { localApiPlugin } from './scripts/local-api.mjs'
import { strategyApiPlugin } from './scripts/strategy-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), strategyApiPlugin(env), localApiPlugin(env)],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
  }
})
