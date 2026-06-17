/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './*.html',
    './partials/**/*.html',
    './js/**/*.js',
  ],
  theme: {
    extend: {
      // Accent palette resolves to CSS variables (R G B triplets) defined in
      // css/main.css per `[data-theme]`. Swapping the theme attribute on <html>
      // re-tints every `accent-*` utility app-wide. `<alpha-value>` keeps
      // opacity modifiers (e.g. bg-accent-500/20) working.
      colors: {
        // Mid-step between gray-700 (#374151) and gray-800 (#1f2937); several
        // cards reference bg-gray-750 — define it so they get an actual surface.
        gray: { 750: '#2b3544' },
        accent: {
          50: 'rgb(var(--accent-50) / <alpha-value>)',
          100: 'rgb(var(--accent-100) / <alpha-value>)',
          200: 'rgb(var(--accent-200) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)',
          600: 'rgb(var(--accent-600) / <alpha-value>)',
          700: 'rgb(var(--accent-700) / <alpha-value>)',
          800: 'rgb(var(--accent-800) / <alpha-value>)',
          900: 'rgb(var(--accent-900) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
