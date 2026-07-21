import type { Metadata } from "next";
import React, { Suspense } from "react";
import { Poppins, Roboto, Manrope, DM_Sans } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "../components/providers/ToastProvider";
import { ReactQueryProvider } from "../components/providers/ReactQueryProvider";
import { I18nProvider } from "../components/providers/I18nProvider";
import { WalletProvider } from "../components/providers/WalletProvider";
import NetworkMismatchBanner from "../components/blockchain/NetworkMismatchBanner";
import { ThemeProvider } from "../components/providers/ThemeProvider";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-poppins",
});

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-roboto",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-manrope",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: "Health Chain",
  description: "Transparent healthcare donation platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pre-hydration theme script — prevents flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='dark'||((!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches)){d.classList.add('dark');}else{d.classList.remove('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${poppins.variable} ${roboto.variable} ${manrope.variable} ${dmSans.variable} antialiased bg-surface text-text-primary`}
      >
        <ThemeProvider>
          <Suspense fallback={null}>
            <I18nProvider>
              <ReactQueryProvider>
                <WalletProvider>
                  <ToastProvider>{children}</ToastProvider>
                  <NetworkMismatchBanner />
                </WalletProvider>
              </ReactQueryProvider>
            </I18nProvider>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
