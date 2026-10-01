import type { Metadata } from "next";
import { IBM_Plex_Sans, Newsreader } from "next/font/google";
import Link from "next/link";

import "./globals.css";

// Newsreader carries the story; Plex Sans carries the interface and every number (tabular figures).
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", style: ["normal", "italic"], display: "swap" });
const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });

// Every page renders per request, so Next can put the CSP nonce from src/middleware.ts on its scripts
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Veridia",
  description:
    "The people of Snowmoon, living on zipcoin: private payments, real-time sales tax, burns to be heard. A living story running on Ethereum's cryptographic world computer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${plex.variable}`}>
      <body className="min-h-screen bg-snow font-sans text-pine antialiased">
        <header className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-4 px-5 pb-2 pt-6 sm:px-8">
          <Link href="/" className="font-story text-2xl tracking-tight">
            Veridia
          </Link>
          <nav className="flex gap-6 text-sm text-lichen">
            <Link href="/" className="hover:text-pine">
              Today
            </Link>
            <Link href="/residents" className="hover:text-pine">
              Residents
            </Link>
            <Link href="/wallet" className="hover:text-pine">
              Wallet
            </Link>
            <Link href="/network" className="hover:text-pine">
              How it works
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-5 pb-24 sm:px-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 pb-10 text-[0.8rem] leading-relaxed text-lichen sm:px-8">
          A living fan simulation inspired by Vitalik Buterin&apos;s novel <cite>Snowmoon</cite>. Not affiliated with the author. The residents are
          AI agents; their money is real zipcoin moving through a privacy pool.
        </footer>
      </body>
    </html>
  );
}
