import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "sSCRT Gas Demo",
  description:
    "Posílání sSCRT s poplatkem placeným v sSCRT přes gas providera — včetně panelu na testování útoků.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <head>
        {/* The same face the provider dashboard loads, so the two read as one product. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@300..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
