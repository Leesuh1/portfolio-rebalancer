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
  "전일종가"?: number;
  "전일종가대비등락률"?: number;
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
  domesticDataMeta?: {
    priceUpdatedAt: string | null;
    forecastUpdatedAt: string | null;
    priceFallbackCount?: number | null;
  };
  externalDataMeta?: {
    priceUpdatedAt: string | null;
  };
  exchangeRate: {
    value: number;
    asOf: string | null;
    updatedAt: string | null;
    changePct?: number;
    source: string;
    fallback: boolean;
  };
  extraAssetUniverse: Array<{
    code: string;
    name: string;
    market: string;
    category: "usd_cash" | "gold" | "crypto" | "us_stock";
    currentPrice: number;
    nativePrice: number;
    nativeCurrency: string;
    tradedAt: string | null;
    changePct?: number;
    quantityStep: number;
    quantityPrecision: number;
    unitLabel: string;
    priceInputMode?: "krw" | "usd";
  }>;
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
    "전일종가"?: number;
    "전일종가대비등락률"?: number;
  }>;
};

const fallbackData: DashboardData = {
  generatedAt: new Date().toISOString(),
  domesticDataMeta: {
    priceUpdatedAt: null,
    forecastUpdatedAt: null,
    priceFallbackCount: 0
  },
  externalDataMeta: {
    priceUpdatedAt: null
  },
  exchangeRate: {
    value: 1400,
    asOf: null,
    updatedAt: null,
    changePct: undefined,
    source: "네이버 증권 fallback",
    fallback: true
  },
  extraAssetUniverse: [],
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

const EXTERNAL_ASSET_REVALIDATE_SECONDS = 60 * 20;

function buildNaverExchangeDateLabel(rawLabel: string | null) {
  if (!rawLabel) {
    return null;
  }
  const isoMatch = rawLabel.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch?.[1]) {
    return isoMatch[1];
  }

  const trimmed = rawLabel.trim();
  const monthDayMatch = trimmed.match(/(\d{2})\.(\d{2})\./);
  if (monthDayMatch) {
    const now = new Date();
    return `${now.getFullYear()}-${monthDayMatch[1]}-${monthDayMatch[2]}`;
  }

  return trimmed;
}

function buildNaverExchangeDateTimeLabel(rawLabel: string | null) {
  if (!rawLabel) {
    return null;
  }
  const isoMatch = rawLabel.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]} ${isoMatch[2]}`;
  }

  const trimmed = rawLabel.trim();
  const monthDayTimeMatch = trimmed.match(/(\d{2})\.(\d{2})\.\s+(\d{2}:\d{2})/);
  if (monthDayTimeMatch) {
    const now = new Date();
    return `${now.getFullYear()}-${monthDayTimeMatch[1]}-${monthDayTimeMatch[2]} ${monthDayTimeMatch[3]}`;
  }

  return trimmed;
}

function extractHanaExchangeUpdatedAt(html: string) {
  const visibleTimeMatch = html.match(/<time>(\d{2}\.\d{2}\.\s+\d{2}:\d{2})<\/time><span[^>]*>실시간<\/span>/);
  if (visibleTimeMatch?.[1]) {
    return buildNaverExchangeDateTimeLabel(visibleTimeMatch[1]);
  }

  const localTradedAtMatch = html.match(/"localTradedAt":"([^"]+)"/);
  if (localTradedAtMatch?.[1]) {
    return buildNaverExchangeDateTimeLabel(localTradedAtMatch[1]);
  }

  return null;
}

async function getUsdKrwExchangeRate() {
  const url = "https://m.stock.naver.com/marketindex/exchange/FX_USDKRW";
  try {
    const response = await fetch(url, {
      next: { revalidate: EXTERNAL_ASSET_REVALIDATE_SECONDS }
    });

    if (!response.ok) {
      return fallbackData.exchangeRate;
    }

    const html = await response.text();
    const priceMatch = html.match(/"closePrice":"([\d,]+\.\d+)"/);
    if (!priceMatch?.[1]) {
      return fallbackData.exchangeRate;
    }
    const asOfMatch = html.match(/"localTradedAt":"([^"]+)"/);
    const hanaUpdatedAt = extractHanaExchangeUpdatedAt(html);
    const parsedValue = Number(priceMatch[1].replaceAll(",", ""));

    if (!Number.isFinite(parsedValue)) {
      return fallbackData.exchangeRate;
    }

    return {
      value: parsedValue,
      asOf: buildNaverExchangeDateLabel(asOfMatch?.[1] ?? null),
      updatedAt: hanaUpdatedAt,
      changePct:
        extractJsonValue(html, /"fluctuationsRatio":"?(-?[\d.]+)"?/, (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }) ?? undefined,
      source: "네이버 증권",
      fallback: false
    };
  } catch {
    return fallbackData.exchangeRate;
  }
}

function extractJsonValue<T>(html: string, pattern: RegExp, parser: (value: string) => T | null) {
  const match = html.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  return parser(match[1]);
}

function parseFiniteNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

type StooqDailyMetrics = {
  nativePrice: number;
  tradedAt: string | null;
  changePct?: number;
};

async function getStooqDailyMetrics(ticker: string): Promise<StooqDailyMetrics | null> {
  try {
    const [latestCsv, historyCsv] = await Promise.all([
      fetch(`https://stooq.com/q/l/?s=${ticker}&i=d`, {
        next: { revalidate: EXTERNAL_ASSET_REVALIDATE_SECONDS }
      }).then((response) => response.text()),
      fetch(`https://stooq.com/q/d/l/?s=${ticker}&i=d`, {
        next: { revalidate: EXTERNAL_ASSET_REVALIDATE_SECONDS }
      }).then((response) => response.text())
    ]);

    const latestParts = latestCsv.trim().split(",");
    if (latestParts.length < 7) {
      return null;
    }

    const [, latestDate, , , , , latestClose] = latestParts;
    const nativePrice = parseFiniteNumber(latestClose);
    if (nativePrice === null) {
      return null;
    }

    const historyLines = historyCsv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean);
    const previousRow = historyLines.at(-2)?.split(",");
    const previousClose = parseFiniteNumber(previousRow?.[4] ?? null);
    const changePct =
      previousClose && previousClose > 0
        ? ((nativePrice - previousClose) / previousClose) * 100
        : undefined;

    return {
      nativePrice,
      tradedAt: buildNaverExchangeDateLabel(latestDate ?? null),
      changePct
    };
  } catch {
    return null;
  }
}

function mergeExtraAsset(
  snapshotItem: DashboardData["extraAssetUniverse"][number] | undefined,
  liveItem: DashboardData["extraAssetUniverse"][number]
) {
  return {
    ...snapshotItem,
    ...liveItem,
    changePct: liveItem.changePct ?? snapshotItem?.changePct
  };
}

async function getGoldEtfAsset(exchangeRate: number) {
  try {
    const metrics = await getStooqDailyMetrics("gld.us");
    if (!metrics) {
      return null;
    }

    return {
      code: "ALT:GLD",
      name: "금 (GLD)",
      market: "금",
      category: "gold" as const,
      currentPrice: metrics.nativePrice * exchangeRate,
      nativePrice: metrics.nativePrice,
      nativeCurrency: "USD",
      tradedAt: metrics.tradedAt,
      changePct: metrics.changePct,
      quantityStep: 1,
      quantityPrecision: 0,
      unitLabel: "주",
      priceInputMode: "usd" as const
    };
  } catch {
    return null;
  }
}

async function getNaverBitcoinPrice() {
  const url = "https://m.stock.naver.com/crypto/UPBIT/BTC";
  try {
    const html = await fetch(url, { next: { revalidate: EXTERNAL_ASSET_REVALIDATE_SECONDS } }).then((response) => response.text());
    const price = extractJsonValue(html, /"tradePrice":([\d.]+)/, (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    });

    if (!price) {
      return null;
    }

    return {
      code: "ALT:BTC",
      name: "비트코인",
      market: "가상자산",
      category: "crypto" as const,
      currentPrice: price,
      nativePrice: price,
      nativeCurrency: "KRW",
      tradedAt: buildNaverExchangeDateLabel(extractJsonValue(html, /"koreaTradedAt":"([^"]+)"/, (value) => value)),
      changePct:
        extractJsonValue(html, /"fluctuationsRatio":(-?[\d.]+)/, (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }) ??
        extractJsonValue(html, /"changeRate":(-?[\d.]+)/, (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }) ??
        undefined,
      quantityStep: 0.000001,
      quantityPrecision: 6,
      unitLabel: "BTC",
      priceInputMode: "krw" as const
    };
  } catch {
    return null;
  }
}

async function getNaverEthereumPrice() {
  const url = "https://m.stock.naver.com/crypto/UPBIT/ETH";
  try {
    const html = await fetch(url, { next: { revalidate: EXTERNAL_ASSET_REVALIDATE_SECONDS } }).then((response) => response.text());
    const price = extractJsonValue(html, /"tradePrice":([\d.]+)/, (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    });

    if (!price) {
      return null;
    }

    return {
      code: "ALT:ETH",
      name: "이더리움",
      market: "가상자산",
      category: "crypto" as const,
      currentPrice: price,
      nativePrice: price,
      nativeCurrency: "KRW",
      tradedAt: buildNaverExchangeDateLabel(extractJsonValue(html, /"koreaTradedAt":"([^"]+)"/, (value) => value)),
      changePct:
        extractJsonValue(html, /"fluctuationsRatio":(-?[\d.]+)/, (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }) ??
        extractJsonValue(html, /"changeRate":(-?[\d.]+)/, (value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }) ??
        undefined,
      quantityStep: 0.000001,
      quantityPrecision: 6,
      unitLabel: "ETH",
      priceInputMode: "krw" as const
    };
  } catch {
    return null;
  }
}

async function getUsdCashAsset(exchangeRate: number, asOf: string | null, changePct?: number) {
  return {
    code: "ALT:USD",
    name: "달러",
    market: "달러",
    category: "usd_cash" as const,
    currentPrice: exchangeRate,
    nativePrice: 1,
    nativeCurrency: "USD",
    tradedAt: asOf,
    changePct,
    quantityStep: 0.01,
    quantityPrecision: 2,
    unitLabel: "USD",
    priceInputMode: "krw" as const
  };
}

const usTopAssets = [
  { code: "ALT:US:MSFT", reutersCode: "MSFT.O", stooqTicker: "msft.us", name: "Microsoft" },
  { code: "ALT:US:AAPL", reutersCode: "AAPL.O", stooqTicker: "aapl.us", name: "Apple" },
  { code: "ALT:US:NVDA", reutersCode: "NVDA.O", stooqTicker: "nvda.us", name: "NVIDIA" },
  { code: "ALT:US:AMZN", reutersCode: "AMZN.O", stooqTicker: "amzn.us", name: "Amazon" },
  { code: "ALT:US:GOOGL", reutersCode: "GOOGL.O", stooqTicker: "googl.us", name: "Alphabet" },
  { code: "ALT:US:META", reutersCode: "META.O", stooqTicker: "meta.us", name: "Meta" },
  { code: "ALT:US:BRKB", reutersCode: "BRK.B", stooqTicker: "brk-b.us", name: "Berkshire Hathaway B" },
  { code: "ALT:US:AVGO", reutersCode: "AVGO.O", stooqTicker: "avgo.us", name: "Broadcom" },
  { code: "ALT:US:TSLA", reutersCode: "TSLA.O", stooqTicker: "tsla.us", name: "Tesla" },
  { code: "ALT:US:JPM", reutersCode: "JPM.N", stooqTicker: "jpm.us", name: "JPMorgan Chase" }
] as const;

async function getUsStockUniverse(exchangeRate: number) {
  const results = await Promise.all(
    usTopAssets.map(async (item) => {
      try {
        const metrics = await getStooqDailyMetrics(item.stooqTicker);
        if (!metrics) {
          return null;
        }
        return {
          code: item.code,
          name: item.name,
          market: "미국주식",
          category: "us_stock" as const,
          currentPrice: metrics.nativePrice * exchangeRate,
          nativePrice: metrics.nativePrice,
          nativeCurrency: "USD",
          tradedAt: metrics.tradedAt,
          changePct: metrics.changePct,
          quantityStep: 1,
          quantityPrecision: 0,
          unitLabel: "주",
          priceInputMode: "usd" as const
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export async function getDashboardData(): Promise<DashboardData> {
  const filePath = path.join(process.cwd(), "public", "data", "dashboard_data.json");

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DashboardData>;
    const snapshotExchangeRate = parsed.exchangeRate ?? fallbackData.exchangeRate;
    const snapshotExtraAssets = parsed.extraAssetUniverse ?? [];
    const exchangeRate = await getUsdKrwExchangeRate();
    const effectiveExchangeRate = exchangeRate.fallback ? snapshotExchangeRate : exchangeRate;
    const [usdCashAsset, goldAsset, bitcoinAsset, ethereumAsset, usStockUniverse] = await Promise.all([
      getUsdCashAsset(effectiveExchangeRate.value, effectiveExchangeRate.asOf, effectiveExchangeRate.changePct),
      getGoldEtfAsset(effectiveExchangeRate.value),
      getNaverBitcoinPrice(),
      getNaverEthereumPrice(),
      getUsStockUniverse(effectiveExchangeRate.value)
    ]);

    const liveAssets = [
      usdCashAsset,
      ...(goldAsset ? [goldAsset] : []),
      ...(bitcoinAsset ? [bitcoinAsset] : []),
      ...(ethereumAsset ? [ethereumAsset] : []),
      ...usStockUniverse
    ];
    const mergedExtraAssetUniverse = new Map(snapshotExtraAssets.map((item) => [item.code, item]));
    liveAssets.forEach((item) => {
      mergedExtraAssetUniverse.set(item.code, mergeExtraAsset(mergedExtraAssetUniverse.get(item.code), item));
    });

    return {
      ...fallbackData,
      ...parsed,
      exchangeRate: effectiveExchangeRate,
      extraAssetUniverse: [...mergedExtraAssetUniverse.values()]
    };
  } catch {
    return fallbackData;
  }
}
