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
      <body>{children}</body>
    </html>
  );
}
