/** @type {import('tailwindcss').Config} */
export default {
  // Theme tokens + `vibe-*` color names come from the @quadflow/ui preset
  // (packages/ui/tailwind-preset.cjs), backed by CSS variables in
  // packages/ui/src/tokens.css so the whole app follows data-theme.
  presets: [require('@quadflow/ui/tailwind-preset')],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./packages/ui/src/**/*.{ts,tsx}",
  ],
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
