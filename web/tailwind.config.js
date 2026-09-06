/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Menlo", "monospace"]
      },
      colors: {
        shell: {
          950: "#0a0b0a",
          900: "#111311",
          800: "#1b1f1b",
          700: "#2a302b"
        },
        signal: {
          400: "#6ee7b7",
          500: "#34d399",
          600: "#10b981"
        },
        warn: {
          400: "#fbbf24"
        }
      }
    }
  },
  plugins: []
};

