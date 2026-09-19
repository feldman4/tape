import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/tape/loop-pad/',
  plugins: [react()],
})