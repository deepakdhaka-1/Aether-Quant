import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Aether Quant: AI algo strategies on Hyperliquid", template: "%s · Aether Quant" },
  description:
    "AI-built algorithmic strategies for US stocks and commodities, executed automatically on Hyperliquid. You keep custody.",
};

export const viewport: Viewport = { themeColor: "#05080d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-ink-950 font-sans text-mist-100">{children}</body>
    </html>
  );
}
