import { promises as fs } from "fs";
import path from "path";

type PortfolioRow = {
  "종목코드": string;
  "종목명": string;
  "현재가"?: number;
  "종합점수": number;
  "비중(%)": number;
  "투자금액": number;
  "투자스타일": string;
  "ROE"?: number;
  "순현금점수"?: number;
};

type RankingRow = {
  "종목코드": string;
  "랭킹": number;
  "종목명": string;
  "현재가"?: number;
  "종합점수_100": number;
  "성장점수": number;
  "저평가점수": number;
  "ROE점수"?: number;
  "순현금점수"?: number;
  "ROE"?: number;
  "영업이익_3Y성장률"?: number;
  "순이익_3Y성장률"?: number;
  "영업이익_PER"?: number;
  "순이익_PER"?: number;
  "투자스타일": string;
};

export type DashboardData = {
  generatedAt: string;
  profile: string;
  investAmount: number;
  selectedStockCount: number;
  selectedGicodes: string[];
  excludedStocks: string[];
  excludedDetails?: Array<{
    "종목명": string;
    "사유": string;
  }>;
  selectionPresets: Record<string, string[]>;
  summary: {
    rankedCount: number;
    excludedCount: number;
    topScore: number;
  };
  topPortfolio: PortfolioRow[];
  topRankings: RankingRow[];
  allRankings: RankingRow[];
  stockUniverse: Array<{
    "종목코드": string;
    "종목명": string;
    "시장"?: string;
    "시장시총순위"?: number;
    "통합시총순위"?: number;
    "시가총액"?: number;
    "현재가"?: number;
  }>;
};

const fallbackData: DashboardData = {
  generatedAt: new Date().toISOString(),
  profile: "균형형",
  investAmount: 10_000_000,
  selectedStockCount: 0,
  selectedGicodes: [],
  excludedStocks: [],
  excludedDetails: [],
  selectionPresets: {},
  summary: {
    rankedCount: 0,
    excludedCount: 0,
    topScore: 0
  },
  topPortfolio: [],
  topRankings: [],
  allRankings: [],
  stockUniverse: []
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
