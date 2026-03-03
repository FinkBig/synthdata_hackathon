/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        synth: '#3b82f6',    // blue
        derive: '#f97316',   // orange
        poly: '#22c55e',     // green
        edge: '#eab308',     // yellow
      },
    },
  },
  plugins: [],
}
