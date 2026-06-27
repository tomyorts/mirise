import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIRISE Intercom",
  description: "Wi-Fi/LTE voice intercom MVP for clinic staff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
