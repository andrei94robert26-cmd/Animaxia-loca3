import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Animaxia — Anime, Filme, Seriale și Mai Mult",
  description:
    "Animaxia este o platformă completă de streaming: anime, filme, seriale, sport și știri, pe un backend enterprise Express + Neon PostgreSQL cu extractor de stream-uri integrat.",
  keywords: ["Animaxia", "anime", "filme", "seriale", "streaming", "player", "sport", "știri"],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Animaxia — Vizionează totul",
    description: "Anime, filme, seriale, sport și știri pe o singură platformă.",
    siteName: "Animaxia",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#e11d48",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ro" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0a0a10] text-zinc-100`}
      >
        {children}
      </body>
    </html>
  );
}
