import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "모두의 ETF",
  description: "자산 배분과 포트폴리오 관리를 위한 투자 도구"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
