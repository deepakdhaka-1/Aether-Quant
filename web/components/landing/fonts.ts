import { IBM_Plex_Mono, Inter, Newsreader } from "next/font/google";

export const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--aq-serif" });
export const sans = Inter({ subsets: ["latin"], variable: "--aq-sans" });
export const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--aq-mono" });

export const fontVars = `${serif.variable} ${sans.variable} ${mono.variable}`;
