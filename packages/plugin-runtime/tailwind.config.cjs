/**
 * Tailwind for the sandbox runtime's `runtime.css`: every class the
 * `@quadflow/ui` components use, themed through the same preset as the shell.
 * @type {import('tailwindcss').Config}
 */
const path = require('node:path')

module.exports = {
  presets: [require('@quadflow/ui/tailwind-preset')],
  content: [
    path.join(__dirname, 'src/**/*.{ts,tsx}'),
    path.join(__dirname, '../ui/src/**/*.{ts,tsx}'),
  ],
  plugins: [require('@tailwindcss/typography')],
}
