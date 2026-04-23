import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // In dev, the browser calls the Vite origin (e.g. :5173). Forward /api to the Express server.
  const devApiTarget = env.VITE_DEV_API_URL || 'http://127.0.0.1:3000'

  return {
    plugins: [react()],
    resolve: {
      alias: [{ find: /^react-native$/, replacement: 'react-native-web' }],
    },
    define: {
      __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    },
    server: {
      proxy: {
        '/api': {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
