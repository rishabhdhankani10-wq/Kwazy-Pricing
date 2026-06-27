import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kwazy Pricing Desk",
  description: "TBO cost vs competitor retail: markup, reward rate, and margin per room-night.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
