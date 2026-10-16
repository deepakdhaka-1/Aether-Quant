import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Aether Quant: AI algo strategies on Hyperliquid", template: "%s · Aether Quant" },
  description:
    "AI-built algorithmic strategies for US stocks and commodities, executed automatically on Hyperliquid. You keep custody.",
};

export const viewport: Viewport = { themeColor: "#05080d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-ink-950 font-sans text-mist-100">{children}</body>
    </html>
  );
}
