import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://portfolio-rebalancer-alpha.vercel.app"),
  title: "모두의 ETF",
  description: "자산 배분과 포트폴리오 관리를 위한 투자 도구",
  openGraph: {
    title: "모두의 ETF",
    description: "자산 배분과 포트폴리오 관리를 위한 투자 도구",
    url: "https://portfolio-rebalancer-alpha.vercel.app",
    siteName: "모두의 ETF",
    locale: "ko_KR",
    type: "website",
    images: [
      {
        url: "/og-image.svg",
        width: 1200,
        height: 630,
        alt: "모두의 ETF 자산배분 썸네일",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "모두의 ETF",
    description: "자산 배분과 포트폴리오 관리를 위한 투자 도구",
    images: ["/og-image.svg"],
  },
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
