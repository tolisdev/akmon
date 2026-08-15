/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        canvas: '#09090b',
        card: '#18181b',
        cardBorder: '#27272a',
        up: '#10b981',
        down: '#f43f5e',
        degraded: '#f59e0b'
      },
      fontFamily: {
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      }
    },
  },
  plugins: [],
}
