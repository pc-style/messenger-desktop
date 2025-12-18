import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Messenger Unleashed — Messenger, but better.",
  description: "A supercharged desktop client for Messenger with privacy features, deep customization, and power-user tools. Block read receipts, choose from 17+ themes, schedule messages.",
  keywords: ["messenger", "desktop", "electron", "privacy", "themes", "customization", "read receipts"],
  authors: [{ name: "pcstyle" }],
  openGraph: {
    title: "Messenger Unleashed",
    description: "Messenger, but better. Privacy features, customization, and power-user tools.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
