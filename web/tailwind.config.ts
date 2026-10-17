import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#F5F7F7", 900: "#FFFFFF", 850: "#F0F4F4", 800: "#E3E8EA", 700: "#D5DDE0", 600: "#C9D2D7" },
        mist: { 100: "#0C1A26", 300: "#3E4C58", 400: "#5A6874", 500: "#7A8790" },
        aether: { DEFAULT: "#1E6B62", soft: "#2D8277", deep: "#15564F" },
        loss: "#C74747",
        warn: "#9A650C",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      boxShadow: { glow: "0 0 0 1px rgba(30,107,98,.18), 0 8px 32px -14px rgba(30,107,98,.24)" },
    },
  },
  plugins: [],
} satisfies Config;
