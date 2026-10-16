import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#05080d", 900: "#0a0f17", 850: "#0e1520", 800: "#131c2a", 700: "#1d2a3d", 600: "#2a3b54" },
        mist: { 100: "#e8eef6", 300: "#a9b6c8", 400: "#8291a7", 500: "#5f6f86" },
        aether: { DEFAULT: "#7cf5d4", soft: "#97fce4", deep: "#2fbf9b" },
        loss: "#ff6b81",
        warn: "#f5c46b",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      boxShadow: { glow: "0 0 0 1px rgba(124,245,212,.25), 0 8px 40px -12px rgba(124,245,212,.35)" },
    },
  },
  plugins: [],
} satisfies Config;
