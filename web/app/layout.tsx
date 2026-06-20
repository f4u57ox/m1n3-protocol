"use client";

import "./globals.css";
import "@mysten/dapp-kit/dist/index.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Navigation } from "@/components/Navigation";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { Footer } from "@/components/Footer";
import { SUI_NETWORK } from "@/lib/constants";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

const networks = {
  devnet: { url: getJsonRpcFullnodeUrl("devnet"), network: "devnet" as const },
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" as const },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" as const },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isFullBleed = pathname === "/";
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchInterval: 30_000,
          },
        },
      })
  );

  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <title>m1n3</title>
        <link rel="icon" href="/m1n3.svg" type="image/svg+xml" />
      </head>
      <body className="min-h-screen bg-background font-mono antialiased flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <QueryClientProvider client={queryClient}>
            <SuiClientProvider
              networks={networks}
              defaultNetwork={SUI_NETWORK as "devnet" | "testnet" | "mainnet"}
            >
              <WalletProvider>
                <Navigation />
                {isFullBleed ? (
                  <>
                    <div className="fixed right-3 top-16 z-50 sm:right-4">
                      <ConnectionIndicator />
                    </div>
                    {children}
                  </>
                ) : (
                  <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
                    <div className="flex justify-end mb-4">
                      <ConnectionIndicator />
                    </div>
                    {children}
                  </div>
                )}
                <Footer />
              </WalletProvider>
            </SuiClientProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
