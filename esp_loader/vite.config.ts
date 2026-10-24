import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

const esptoolBundlePath = fileURLToPath(
  new URL('./node_modules/esptool-js/bundle.js', import.meta.url),
)

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  // esptool-js discovers the target chip at runtime and then dynamically
  // imports its ROM implementation. During development that can make Vite
  // invalidate an optimized chunk while an open browser tab still references
  // its previous hash. The official single-file bundle avoids that race in
  // dev; production keeps the package's normal code-split ESM build.
  resolve: command === 'serve'
    ? {
        alias: [
          {
            find: /^esptool-js$/,
            replacement: esptoolBundlePath,
          },
        ],
      }
    : undefined,
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
}))
