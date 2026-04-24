import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "pi-island — Dynamic Island for your agent",
  description:
    "A Dynamic-Island-style status capsule for the pi coding agent on macOS and Windows. Pinned at the top of your screen, live on every turn.",
  openGraph: {
    title: "pi-island",
    description:
      "Dynamic Island status capsule for the pi coding agent. Native on macOS and Windows, notch-aware on MacBooks.",
    url: "https://pi-island.vercel.app",
    siteName: "pi-island",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "pi-island",
    description:
      "Dynamic Island status capsule for the pi coding agent. Native on macOS and Windows, notch-aware on MacBooks.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
