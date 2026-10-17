import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// BDO Grotesk (SIL OFL 1.1, LCTipografi/BDO-Grotesk; licence in ./fonts/bdo-grotesk/OFL.txt) — the one
// family used across the whole site. Self-hosted, so no third-party font requests.
const bdo = localFont({
  src: [
    { path: "./fonts/bdo-grotesk/BDOGrotesk-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/bdo-grotesk/BDOGrotesk-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/bdo-grotesk/BDOGrotesk-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/bdo-grotesk/BDOGrotesk-DemiBold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/bdo-grotesk/BDOGrotesk-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: { default: "Aether Quant: AI algo strategies on Hyperliquid", template: "%s · Aether Quant" },
  description:
    "AI-built algorithmic strategies for US stocks and commodities, executed automatically on Hyperliquid. You keep custody.",
};

export const viewport: Viewport = { themeColor: "#05080d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={bdo.variable}>
      <body className="min-h-screen bg-ink-950 font-sans text-mist-100">{children}</body>
    </html>
  );
}
