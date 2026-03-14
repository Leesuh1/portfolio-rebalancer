import { promises as fs } from "fs";
import path from "path";

type PortfolioRow = {
  "종목명": string;
  "종합점수": number;
  "비중(%)": number;
  "투자금액": number;
  "투자스타일": string;
};

type RankingRow = {
  "랭킹": number;
  "종목명": string;
  "종합점수_100": number;
  "성장점수": number;
  "저평가점수": number;
  "투자스타일": string;
};

export type DashboardData = {
  generatedAt: string;
  profile: string;
  investAmount: number;
  selectedStockCount: number;
  excludedStocks: string[];
  summary: {
    rankedCount: number;
    excludedCount: number;
    topScore: number;
  };
  topPortfolio: PortfolioRow[];
  topRankings: RankingRow[];
};

const fallbackData: DashboardData = {
  generatedAt: new Date().toISOString(),
  profile: "균형형",
  investAmount: 10_000_000,
  selectedStockCount: 0,
  excludedStocks: [],
  summary: {
    rankedCount: 0,
    excludedCount: 0,
    topScore: 0
  },
  topPortfolio: [],
  topRankings: []
};

export async function getDashboardData(): Promise<DashboardData> {
  const filePath = path.join(process.cwd(), "public", "data", "dashboard_data.json");

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as DashboardData;
  } catch {
    return fallbackData;
  }
}
