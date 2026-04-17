import "./globals.css";
import type { Metadata } from "next";
import { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Reddit Pixel + CAPI Test Site",
  description: "Validate Reddit client and server event tracking.",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }]
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
