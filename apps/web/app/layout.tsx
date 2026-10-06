import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MIRAI LINK | 院内音声インカム",
  description: "MIRAI LINK — 医療機関スタッフ向けの院内音声インカム",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
