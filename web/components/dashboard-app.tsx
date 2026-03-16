"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { DashboardData } from "@/lib/get-dashboard-data";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Props = {
  data: DashboardData;
};

type HoldingLot = {
  id: string;
  shares: number;
  buyPrice: number;
  boughtAt: string;
  nativeBuyPrice?: number;
  fundingBuyPrice?: number;
};

type HoldingPosition = {
  code: string;
  lots: HoldingLot[];
};

type TradeDraft = {
  shares: number;
  price: number;
};

type PendingTrade = {
  id: string;
  code: string;
  name: string;
  side: "매수" | "매도";
  shares: number;
  price: number;
  settlementPrice: number;
};

type AssetCandidate = {
  code: string;
  name: string;
  market: string;
  price: number;
  nativePrice?: number;
  nativeCurrency?: string;
  priceInputMode?: "krw" | "usd";
  quantityStep: number;
  quantityPrecision: number;
  unitLabel: string;
};

type CashAdjustmentType = "입금" | "출금";

type SavedProfile = {
  id: string;
  name: string;
  updatedAt: string;
  selectedCodes: string[];
  profile: typeof profileLabels[number];
  totalAsset: number;
  holdings: HoldingPosition[];
  realizedProfit?: number;
};

type WorkspaceMode = "update" | "rebalance";

type StorageEnvelope = {
  version: 1;
  activeProfileId: string | null;
  lastSession: SavedProfile | null;
  profiles: SavedProfile[];
};

type VisiblePortfolioRow = {
  code: string;
  name: string;
  score100: number;
  weightPct: number;
  targetAmount: number;
  style: string;
  growthScore: number;
  valueScore: number;
  roeScore: number;
  roe: number;
  operatingGrowth: number;
  netGrowth: number;
  operatingPer: number;
  netPer: number;
  currentPrice: number;
};

type RebalanceRow = {
  code: string;
  name: string;
  price: number;
  currentShares: number;
  targetShares: number;
  currentAmount: number;
  targetAmount: number;
  currentWeightPct: number;
  targetWeightPct: number;
  diffShares: number;
  diffAmount: number;
  action: "신규 편입" | "비중 확대" | "비중 축소" | "전량 매도" | "유지";
};

const profileLabels = ["안정형", "밸런스형", "공격형"] as const;
const assetClassLabels = ["현금/예적금/채권", "금", "가상자산", "주식"] as const;
const portfolioSegmentPalette: string[] = ["#3182f6", "#4f95f8", "#69a6fb", "#84b6fc", "#9dc5fd", "#b4d3fe", "#c7defe", "#d8e8ff", "#e6f1ff", "#f0f7ff"];
const presetOrder = [
  "기본 관심 종목",
  "코스피 대표 30개",
  "코스닥 대표 20개",
  "코스피 전체",
  "코스닥 전체",
  "코스피+코스닥 전체"
] as const;
const profileWeights = {
  안정형: { growth: 0.2, value: 0.5, roe: 0.3 },
  밸런스형: { growth: 0.4, value: 0.4, roe: 0.2 },
  공격형: { growth: 0.6, value: 0.3, roe: 0.1 }
} as const;
const topN = 10;
const totalAssetMin = 10_000_000;
const totalAssetMax = 1_000_000_000;
const createProfileAssetStep = 10_000_000;
const createProfileQuickAdds = [5_000_000, 10_000_000, 100_000_000] as const;
const cashAdjustmentQuickAdds = [100_000, 500_000, 1_000_000, 5_000_000] as const;
const visiblePickerLimit = 100;
const storageKey = "portfolio-rebalancer-profiles-v1";
const exchangeRateFloor = 1300;
const exchangeRateCeiling = 1500;
const assetAllocationPresets = {
  안정형: {
    "현금/예적금/채권": 50,
    금: 20,
    가상자산: 0,
    주식: 30,
  },
  밸런스형: {
    "현금/예적금/채권": 30,
    금: 10,
    가상자산: 10,
    주식: 50,
  },
  공격형: {
    "현금/예적금/채권": 20,
    금: 0,
    가상자산: 20,
    주식: 60,
  },
} as const satisfies Record<
  (typeof profileLabels)[number],
  Record<(typeof assetClassLabels)[number], number>
>;

type DbProfileRow = {
  id: string;
  name: string;
  profile: string;
  total_asset: number;
  selected_codes: string[] | null;
  holdings: HoldingPosition[] | null;
  realized_profit: number | null;
  updated_at: string;
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(value);
}

function formatUsdCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function getKoreanTickSize(price: number) {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

function snapPriceToTick(price: number) {
  if (price <= 0) {
    return 0;
  }
  const tick = getKoreanTickSize(price);
  return Math.round(price / tick) * tick;
}

function stepPriceByTicks(price: number, count: number, direction: 1 | -1) {
  let current = Math.max(0, snapPriceToTick(price));
  for (let index = 0; index < count; index += 1) {
    if (current <= 0 && direction < 0) {
      return 0;
    }
    const tickBase = direction > 0 ? Math.max(current, 1) : Math.max(current - 1, 1);
    const tick = getKoreanTickSize(tickBase);
    current = Math.max(0, current + tick * direction);
  }
  return snapPriceToTick(current);
}

function stepPriceByDelta(price: number, delta: number, direction: 1 | -1, precision = 2) {
  const next = Math.max(0, price + delta * direction);
  return roundToPrecision(next, precision);
}

function formatScore(value: number) {
  return value.toFixed(1);
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatCompactDate(value: string | null | undefined) {
  if (!value || value.length !== 8) {
    return value ?? "-";
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function roundToPrecision(value: number, precision: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clampAsset(value: number) {
  return Math.min(totalAssetMax, Math.max(0, value));
}

function clampExchangeRate(value: number) {
  return Math.min(exchangeRateCeiling, Math.max(exchangeRateFloor, Math.round(value)));
}

function getLinearDomesticShare(exchangeRate: number) {
  const safeRate = clampExchangeRate(exchangeRate);
  return Number(((safeRate - exchangeRateFloor) / (exchangeRateCeiling - exchangeRateFloor)).toFixed(4));
}

function buildDonutStyle(segments: Array<{ value: number; color: string }>) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) {
    return { background: "conic-gradient(#e5e8eb 0deg 360deg)" } satisfies CSSProperties;
  }

  let angle = 0;
  const parts = segments.map((segment) => {
    const span = (segment.value / total) * 360;
    const start = angle;
    angle += span;
    return `${segment.color} ${start}deg ${angle}deg`;
  });

  return {
    background: `conic-gradient(${parts.join(", ")})`
  } satisfies CSSProperties;
}

function arraysEqualAsSet(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  const leftSet = new Set(left);
  return right.every((item) => leftSet.has(item));
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSupabaseErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) {
      return `${fallback}: ${message}`;
    }
  }
  return fallback;
}

function isUuidLike(value: string | null | undefined) {
  if (!value) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sortProfilesByUpdatedAt(profiles: SavedProfile[]) {
  return [...profiles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function todayLabel() {
  return new Date().toISOString().slice(0, 10);
}

function calculateCombinedScore(
  row: DashboardData["allRankings"][number],
  weights: { growth: number; value: number; roe: number }
) {
  const roeScore = Number(row["ROE점수"] ?? 0);
  return row["성장점수"] * weights.growth + row["저평가점수"] * weights.value + roeScore * weights.roe;
}

function buildHoldingRowsFromRankings(rows: DashboardData["allRankings"]): HoldingPosition[] {
  return rows
    .slice(0, 10)
    .map((item) => {
      const price = Number(item["현재가"] ?? 0);
      return {
        code: item["종목코드"],
        lots: [
          {
            id: makeId("lot"),
            shares: 1,
            buyPrice: price,
            boughtAt: todayLabel(),
          },
        ],
      };
    });
}

function buildHoldingRowsFromCodes(
  data: DashboardData,
  codes: string[],
  weights: { growth: number; value: number; roe: number }
) {
  const codeSet = new Set(codes);
  const rankedRows = data.allRankings
    .filter((item) => codeSet.has(item["종목코드"]))
    .map((item) => ({
      ...item,
      __combinedScore: calculateCombinedScore(item, weights),
    }))
    .sort((a, b) => b.__combinedScore - a.__combinedScore);

  return buildHoldingRowsFromRankings(rankedRows);
}

function buildInitialHoldings(
  data: DashboardData,
  codes: string[],
  weights: { growth: number; value: number; roe: number }
): HoldingPosition[] {
  return [];
}

function sanitizeLots(lots: HoldingLot[]): HoldingLot[] {
  return lots
    .map((lot) => ({
      id: lot.id || makeId("lot"),
      shares: Math.max(0, Number(lot.shares) || 0),
      buyPrice: Math.max(0, Number(lot.buyPrice) || 0),
      boughtAt: lot.boughtAt || todayLabel(),
      nativeBuyPrice: lot.nativeBuyPrice !== undefined ? Math.max(0, Number(lot.nativeBuyPrice) || 0) : undefined,
      fundingBuyPrice: lot.fundingBuyPrice !== undefined ? Math.max(0, Number(lot.fundingBuyPrice) || 0) : undefined,
    }))
    .filter((lot) => lot.shares > 0);
}

function sanitizeHoldings(holdings: HoldingPosition[]): HoldingPosition[] {
  return holdings
    .map((position) => ({
      code: position.code,
      lots: sanitizeLots(position.lots ?? []),
    }))
    .filter((position) => position.code);
}

function aggregatePosition(position: HoldingPosition) {
  const lots = sanitizeLots(position.lots);
  const shares = lots.reduce((sum, lot) => sum + lot.shares, 0);
  const purchaseTotal = lots.reduce((sum, lot) => sum + lot.shares * lot.buyPrice, 0);
  const latestLot = lots[lots.length - 1];
  return {
    shares,
    purchaseTotal,
    avgBuyPrice: shares > 0 ? purchaseTotal / shares : 0,
    latestBuyPrice: latestLot?.buyPrice ?? 0,
    lots,
  };
}

function applyLifoSell(lots: HoldingLot[], sellShares: number): HoldingLot[] {
  let remaining = Math.max(0, Number(sellShares) || 0);
  const nextLots = sanitizeLots(lots).map((lot) => ({ ...lot }));

  for (let index = nextLots.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const lot = nextLots[index];
    const sold = Math.min(lot.shares, remaining);
    lot.shares -= sold;
    remaining -= sold;
  }

  return nextLots.filter((lot) => lot.shares > 0);
}

function isUsdSettledCode(code: string) {
  return code === "ALT:GLD" || code.startsWith("ALT:US:");
}

function consumeUsdLots(lots: HoldingLot[], usdAmount: number) {
  let remaining = roundToPrecision(Math.max(0, usdAmount), 2);
  const nextLots = sanitizeLots(lots).map((lot) => ({ ...lot }));
  const consumedParts: Array<{ shares: number; buyPrice: number }> = [];

  for (let index = nextLots.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const lot = nextLots[index];
    const consumed = Math.min(lot.shares, remaining);
    if (consumed <= 0) {
      continue;
    }
    lot.shares = roundToPrecision(lot.shares - consumed, 2);
    remaining = roundToPrecision(remaining - consumed, 2);
    consumedParts.push({ shares: consumed, buyPrice: lot.buyPrice });
  }

  const consumedTotal = consumedParts.reduce((sum, part) => sum + part.shares, 0);
  const weightedBuyPrice =
    consumedTotal > 0
      ? consumedParts.reduce((sum, part) => sum + part.shares * part.buyPrice, 0) / consumedTotal
      : 0;

  return {
    nextLots: nextLots.filter((lot) => lot.shares > 0),
    weightedBuyPrice,
  };
}

function sellLotsWithDetails(lots: HoldingLot[], sellShares: number) {
  let remaining = Math.max(0, Number(sellShares) || 0);
  const nextLots = sanitizeLots(lots).map((lot) => ({ ...lot }));
  const soldParts: Array<{ sold: number; lot: HoldingLot }> = [];

  for (let index = nextLots.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const lot = nextLots[index];
    const sold = Math.min(lot.shares, remaining);
    if (sold <= 0) {
      continue;
    }
    soldParts.push({ sold, lot: { ...lot } });
    lot.shares -= sold;
    remaining -= sold;
  }

  return {
    nextLots: nextLots.filter((lot) => lot.shares > 0),
    soldParts,
  };
}

function createProfileSnapshot(params: {
  id: string;
  name: string;
  selectedCodes: string[];
  profile: typeof profileLabels[number];
  totalAsset: number;
  holdings: HoldingPosition[];
  realizedProfit?: number;
}): SavedProfile {
  return {
    id: params.id,
    name: params.name,
    updatedAt: new Date().toISOString(),
    selectedCodes: [...params.selectedCodes],
    profile: params.profile,
    totalAsset: params.totalAsset,
    holdings: sanitizeHoldings(params.holdings),
    realizedProfit: Number(params.realizedProfit ?? 0),
  };
}

function calculateTradeRealizedProfit(baseHoldings: HoldingPosition[], trades: PendingTrade[]) {
  const lotsMap = new Map(
    sanitizeHoldings(baseHoldings).map((position) => [position.code, sanitizeLots(position.lots).map((lot) => ({ ...lot }))])
  );
  let realized = 0;

  [...trades].reverse().forEach((trade) => {
    const currentLots = lotsMap.get(trade.code) ?? [];
    const usdLots = lotsMap.get("ALT:USD") ?? [];

    if (isUsdSettledCode(trade.code)) {
      if (trade.side === "매수") {
        const usdAmount = roundToPrecision(trade.shares * trade.price, 2);
        const consumed = consumeUsdLots(usdLots, usdAmount);
        const fundingBuyPrice =
          consumed.weightedBuyPrice > 0
            ? consumed.weightedBuyPrice
            : trade.price > 0
              ? trade.settlementPrice / trade.price
              : 0;
        const krwBuyPrice = roundToPrecision(fundingBuyPrice * trade.price, 2);
        currentLots.push({
          id: makeId("lot"),
          shares: trade.shares,
          buyPrice: krwBuyPrice,
          boughtAt: todayLabel(),
          nativeBuyPrice: trade.price,
          fundingBuyPrice,
        });
        lotsMap.set(trade.code, currentLots);
        lotsMap.set("ALT:USD", consumed.nextLots);
        return;
      }

      const soldResult = sellLotsWithDetails(currentLots, trade.shares);
      const nextUsdLots = [...sanitizeLots(usdLots).map((lot) => ({ ...lot }))];
      soldResult.soldParts.forEach(({ sold, lot }) => {
        const returnedUsdShares = roundToPrecision(sold * trade.price, 2);
        if (returnedUsdShares > 0) {
          const originalPrincipalKrw = lot.buyPrice * sold;
          const returnedUsdBuyPrice = roundToPrecision(originalPrincipalKrw / returnedUsdShares, 2);
          nextUsdLots.push({
            id: makeId("lot"),
            shares: returnedUsdShares,
            buyPrice: returnedUsdBuyPrice,
            boughtAt: todayLabel(),
          });
        }
      });

      if (soldResult.nextLots.length > 0) {
        lotsMap.set(trade.code, soldResult.nextLots);
      } else {
        lotsMap.delete(trade.code);
      }
      lotsMap.set("ALT:USD", sanitizeLots(nextUsdLots));
      return;
    }

    if (trade.side === "매수") {
      currentLots.push({
        id: makeId("lot"),
        shares: trade.shares,
        buyPrice: trade.settlementPrice,
        boughtAt: todayLabel(),
      });
      lotsMap.set(trade.code, currentLots);
      return;
    }

    let remaining = trade.shares;
    for (let index = currentLots.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const lot = currentLots[index];
      const sold = Math.min(lot.shares, remaining);
      realized += (trade.settlementPrice - lot.buyPrice) * sold;
      lot.shares -= sold;
      remaining -= sold;
    }

    lotsMap.set(
      trade.code,
      currentLots.filter((lot) => lot.shares > 0)
    );
  });

  return realized;
}

function applyPendingTrades(baseHoldings: HoldingPosition[], trades: PendingTrade[]) {
  const lotsMap = new Map(
    sanitizeHoldings(baseHoldings).map((position) => [position.code, sanitizeLots(position.lots).map((lot) => ({ ...lot }))])
  );

  [...trades].reverse().forEach((trade) => {
    const currentLots = lotsMap.get(trade.code) ?? [];
    const usdLots = lotsMap.get("ALT:USD") ?? [];

    if (isUsdSettledCode(trade.code)) {
      if (trade.side === "매수") {
        const usdAmount = roundToPrecision(trade.shares * trade.price, 2);
        const consumed = consumeUsdLots(usdLots, usdAmount);
        const fundingBuyPrice =
          consumed.weightedBuyPrice > 0
            ? consumed.weightedBuyPrice
            : trade.price > 0
              ? trade.settlementPrice / trade.price
              : 0;
        const krwBuyPrice = roundToPrecision(fundingBuyPrice * trade.price, 2);
        currentLots.push({
          id: makeId("lot"),
          shares: trade.shares,
          buyPrice: krwBuyPrice,
          boughtAt: todayLabel(),
          nativeBuyPrice: trade.price,
          fundingBuyPrice,
        });
        lotsMap.set(trade.code, currentLots);
        lotsMap.set("ALT:USD", consumed.nextLots);
        return;
      }

      const soldResult = sellLotsWithDetails(currentLots, trade.shares);
      const nextUsdLots = [...sanitizeLots(usdLots).map((lot) => ({ ...lot }))];
      soldResult.soldParts.forEach(({ sold, lot }) => {
        const returnedUsdShares = roundToPrecision(sold * trade.price, 2);
        if (returnedUsdShares > 0) {
          const originalPrincipalKrw = lot.buyPrice * sold;
          const returnedUsdBuyPrice = roundToPrecision(originalPrincipalKrw / returnedUsdShares, 2);
          nextUsdLots.push({
            id: makeId("lot"),
            shares: returnedUsdShares,
            buyPrice: returnedUsdBuyPrice,
            boughtAt: todayLabel(),
          });
        }
      });

      if (soldResult.nextLots.length > 0) {
        lotsMap.set(trade.code, soldResult.nextLots);
      } else {
        lotsMap.delete(trade.code);
      }
      lotsMap.set("ALT:USD", sanitizeLots(nextUsdLots));
      return;
    }

    if (trade.side === "매수") {
      currentLots.push({
        id: makeId("lot"),
        shares: trade.shares,
        buyPrice: trade.settlementPrice,
        boughtAt: todayLabel(),
      });
      lotsMap.set(trade.code, currentLots);
      return;
    }

    const nextLots = applyLifoSell(currentLots, trade.shares);
    if (nextLots.length > 0) {
      lotsMap.set(trade.code, nextLots);
    } else {
      lotsMap.delete(trade.code);
    }
  });

  return [...lotsMap.entries()].map(([code, lots]) => ({ code, lots }));
}

function getStyleLabel(growthScore: number, valueScore: number) {
  if (growthScore >= 0.6 && valueScore >= 0.6) {
    return "고성장 저평가";
  }
  if (growthScore >= 0.6) {
    return "성장형";
  }
  if (valueScore >= 0.6) {
    return "가치형";
  }
  return "균형 관찰형";
}

function getActionDescription(action: RebalanceRow["action"]) {
  switch (action) {
    case "신규 편입":
      return "새로 편입해야 하는 종목";
    case "비중 확대":
      return "조금 더 사서 비중을 늘릴 종목";
    case "비중 축소":
      return "일부만 줄이면 되는 종목";
    case "전량 매도":
      return "포트폴리오에서 제외할 종목";
    default:
      return "현재 비중을 유지해도 되는 종목";
  }
}

function getAssetAllocationBucket(code: string) {
  if (code === "ALT:GLD") {
    return "gold" as const;
  }
  if (code === "ALT:BTC" || code === "ALT:ETH") {
    return "crypto" as const;
  }
  if (code === "ALT:USD") {
    return "usd_cash" as const;
  }
  if (code.startsWith("ALT:US:")) {
    return "us_stock" as const;
  }
  return "domestic_stock" as const;
}

function normalizeProfileLabel(value: string | null | undefined): typeof profileLabels[number] {
  if (value === "균형형") {
    return "밸런스형";
  }
  if (value && profileLabels.includes(value as (typeof profileLabels)[number])) {
    return value as (typeof profileLabels)[number];
  }
  return "밸런스형";
}

function actionPriority(action: RebalanceRow["action"]) {
  switch (action) {
    case "전량 매도":
      return 0;
    case "비중 축소":
      return 1;
    case "신규 편입":
      return 2;
    case "비중 확대":
      return 3;
    default:
      return 4;
  }
}

function getExecutionTrade(row: RebalanceRow): PendingTrade | null {
  if (row.diffShares === 0 || row.price <= 0) {
    return null;
  }

  return {
    id: makeId("rebalance-trade"),
    code: row.code,
    name: row.name,
    side: row.diffShares > 0 ? "매수" : "매도",
    shares: Math.abs(row.diffShares),
    price: row.price,
    settlementPrice: row.price,
  };
}

export function DashboardApp({ data }: Props) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const supabaseEnabled = Boolean(supabase);
  const stockUniverse = data.stockUniverse ?? [];
  const selectionPresets = data.selectionPresets ?? {};
  const defaultSelection = data.selectionPresets?.["기본 관심 종목"]?.length
    ? data.selectionPresets["기본 관심 종목"]
    : (data.selectedGicodes ?? []);
  const [selectedCodes, setSelectedCodes] = useState<string[]>(defaultSelection);
  const [profile, setProfile] = useState<typeof profileLabels[number]>(
    normalizeProfileLabel(data.profile)
  );
  const [totalAsset, setTotalAsset] = useState<number>(data.investAmount || 10_000_000);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [holdingSearchTerm, setHoldingSearchTerm] = useState("");
  const [profileNameInput, setProfileNameInput] = useState("기본 포트폴리오");
  const [newProfileNameInput, setNewProfileNameInput] = useState("");
  const [newProfileAsset, setNewProfileAsset] = useState<number>(10_000_000);
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [activeSavedProfileId, setActiveSavedProfileId] = useState<string | null>(null);
  const [tradeDrafts, setTradeDrafts] = useState<Record<string, TradeDraft>>({});
  const [pendingTrades, setPendingTrades] = useState<PendingTrade[]>([]);
  const [rebalancePendingTrades, setRebalancePendingTrades] = useState<PendingTrade[]>([]);
  const [selectedTradeCode, setSelectedTradeCode] = useState<string | null>(null);
  const [cashAdjustmentType, setCashAdjustmentType] = useState<CashAdjustmentType>("입금");
  const [cashAdjustmentDraft, setCashAdjustmentDraft] = useState<number>(0);
  const [pendingCashAdjustment, setPendingCashAdjustment] = useState<number>(0);
  const [storageReady, setStorageReady] = useState(false);
  const [authReady, setAuthReady] = useState(!supabaseEnabled);
  const [remoteReady, setRemoteReady] = useState(!supabaseEnabled);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("rebalance");
  const [baselineProfile, setBaselineProfile] = useState<SavedProfile | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [realizedProfit, setRealizedProfit] = useState<number>(0);
  const controlPanelRef = useRef<HTMLElement | null>(null);
  const portfolioPieRef = useRef<HTMLElement | null>(null);
  const factorMapRef = useRef<HTMLElement | null>(null);
  const [portfolioListHeight, setPortfolioListHeight] = useState<number | null>(null);
  const [factorPanelHeight, setFactorPanelHeight] = useState<number | null>(null);
  const [rebalanceComparison, setRebalanceComparison] = useState<{
    before: SavedProfile | null;
    after: SavedProfile | null;
  }>({
    before: null,
    after: null,
  });
  const canManagePortfolio = !supabaseEnabled || Boolean(authUser);
  const showPersonalAllocationGuide = !supabaseEnabled || Boolean(authUser);
  const resetSignedOutWorkspace = useCallback(() => {
    setSavedProfiles([]);
    setActiveSavedProfileId(null);
    setBaselineProfile(null);
    setProfileNameInput("기본 포트폴리오");
    setSelectedCodes(defaultSelection);
    setProfile(normalizeProfileLabel(data.profile));
    setTotalAsset(clampAsset(data.investAmount || 10_000_000));
    setHoldings([]);
    setRealizedProfit(0);
    setTradeDrafts({});
    setPendingTrades([]);
    setRebalancePendingTrades([]);
    setPendingCashAdjustment(0);
    setWorkspaceMode("rebalance");
  }, [data.investAmount, data.profile, defaultSelection]);
  const activeWeights = profileWeights[profile as keyof typeof profileWeights] ?? profileWeights.밸런스형;
  const exchangeRate = clampExchangeRate(data.exchangeRate?.value ?? 1400);
  const exchangeRateAsOf = data.exchangeRate?.asOf;
  const exchangeRateSource = data.exchangeRate?.source ?? "네이버 증권";
  const exchangeRateFallback = Boolean(data.exchangeRate?.fallback);
  const effectiveTotalAsset = clampAsset(totalAsset + pendingCashAdjustment);
  const activeAssetAllocation =
    assetAllocationPresets[profile as keyof typeof assetAllocationPresets] ?? assetAllocationPresets.밸런스형;
  const domesticPreference = getLinearDomesticShare(exchangeRate);
  const overseasPreference = Number((1 - domesticPreference).toFixed(4));
  const cashBondPct = activeAssetAllocation["현금/예적금/채권"];
  const stockPct = activeAssetAllocation.주식;
  const domesticStockPct = Number((stockPct * domesticPreference).toFixed(2));
  const overseasStockPct = Number((stockPct * overseasPreference).toFixed(2));
  const krwCashPct = Number((cashBondPct * domesticPreference).toFixed(2));
  const usdCashPct = Number((cashBondPct * overseasPreference).toFixed(2));
  const [holdings, setHoldings] = useState<HoldingPosition[]>(() =>
    buildInitialHoldings(data, defaultSelection, activeWeights)
  );

  const mapDbProfileToSaved = (row: DbProfileRow): SavedProfile => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    selectedCodes: row.selected_codes ?? [],
    profile: normalizeProfileLabel(row.profile),
    totalAsset: Number(row.total_asset ?? totalAssetMin),
    holdings: sanitizeHoldings(row.holdings ?? []),
    realizedProfit: Number(row.realized_profit ?? 0),
  });

  const mapSavedProfileToDb = (snapshot: SavedProfile) => ({
    user_id: authUser?.id,
    name: snapshot.name,
    profile: snapshot.profile,
    total_asset: snapshot.totalAsset,
    selected_codes: snapshot.selectedCodes,
    holdings: sanitizeHoldings(snapshot.holdings),
    realized_profit: Number(snapshot.realizedProfit ?? 0),
    updated_at: new Date().toISOString(),
  });

  const stockMap = useMemo(
    () => new Map(stockUniverse.map((item) => [item["종목코드"], item])),
    [stockUniverse]
  );

  const rankedMap = useMemo(
    () => new Map(data.allRankings.map((item) => [item["종목코드"], item])),
    [data.allRankings]
  );

  const extraAssetMap = useMemo(
    () =>
      new Map(
        (data.extraAssetUniverse ?? []).map((item) => [
          item.code,
          {
            code: item.code,
            name: item.name,
            market: item.market,
            price: item.currentPrice,
            nativePrice: item.nativePrice,
            nativeCurrency: item.nativeCurrency,
            priceInputMode: item.priceInputMode ?? "krw",
            quantityStep: item.quantityStep,
            quantityPrecision: item.quantityPrecision,
            unitLabel: item.unitLabel,
          },
        ])
      ),
    [data.extraAssetUniverse]
  );

  const getAssetCandidate = useCallback(
    (code: string): AssetCandidate | null => {
      const stock = stockMap.get(code);
      if (stock) {
        return {
          code,
          name: stock["종목명"],
          market: stock["시장"] ?? "국내주식",
          price: Number(stock["현재가"] ?? rankedMap.get(code)?.["현재가"] ?? 0),
          nativePrice: Number(stock["현재가"] ?? rankedMap.get(code)?.["현재가"] ?? 0),
          nativeCurrency: "KRW",
          priceInputMode: "krw",
          quantityStep: 1,
          quantityPrecision: 0,
          unitLabel: "주",
        };
      }
      const extra = extraAssetMap.get(code);
      if (extra) {
        return extra;
      }
      const ranked = rankedMap.get(code);
      if (ranked) {
        return {
          code,
          name: ranked["종목명"],
          market: "국내주식",
          price: Number(ranked["현재가"] ?? 0),
          nativePrice: Number(ranked["현재가"] ?? 0),
          nativeCurrency: "KRW",
          priceInputMode: "krw",
          quantityStep: 1,
          quantityPrecision: 0,
          unitLabel: "주",
        };
      }
      return null;
    },
    [extraAssetMap, rankedMap, stockMap]
  );

  const clampTradeQuantity = useCallback(
    (code: string, value: number) => {
      const candidate = getAssetCandidate(code);
      const precision = candidate?.quantityPrecision ?? 0;
      return Math.max(0, roundToPrecision(Number(value) || 0, precision));
    },
    [getAssetCandidate]
  );

  const formatTradeQuantity = useCallback(
    (code: string, value: number) => {
      const candidate = getAssetCandidate(code);
      const precision = candidate?.quantityPrecision ?? 0;
      return new Intl.NumberFormat("ko-KR", {
        minimumFractionDigits: precision === 0 ? 0 : 0,
        maximumFractionDigits: precision,
      }).format(value);
    },
    [getAssetCandidate]
  );

  const getPriceInputStep = useCallback(
    (code: string) => {
      const candidate = getAssetCandidate(code);
      return candidate?.priceInputMode === "usd" ? "0.01" : "1";
    },
    [getAssetCandidate]
  );

  const formatCandidatePrice = useCallback(
    (candidate: AssetCandidate | null, price: number) => {
      if (!candidate) {
        return formatCurrency(price);
      }
      if (candidate.priceInputMode === "usd") {
        return `${formatUsdCurrency(price)} · ${formatCurrency(price * exchangeRate)}`;
      }
      return formatCurrency(candidate.price);
    },
    [exchangeRate]
  );

  const toStoredTradePrice = useCallback(
    (candidate: AssetCandidate | null, inputPrice: number) => {
      if (!candidate) {
        return Math.max(0, snapPriceToTick(inputPrice));
      }
      if (candidate.priceInputMode === "usd") {
        return Math.max(0, snapPriceToTick(inputPrice * exchangeRate));
      }
      return Math.max(0, snapPriceToTick(inputPrice));
    },
    [exchangeRate]
  );

  const fromStoredTradePrice = useCallback(
    (candidate: AssetCandidate | null, storedPrice: number) => {
      if (!candidate) {
        return storedPrice;
      }
      if (candidate.priceInputMode === "usd") {
        return roundToPrecision(exchangeRate > 0 ? storedPrice / exchangeRate : storedPrice, 2);
      }
      return storedPrice;
    },
    [exchangeRate]
  );

  const formatStoredTradePrice = useCallback(
    (code: string, inputPrice: number) => {
      const candidate = getAssetCandidate(code);
      return formatCandidatePrice(candidate, inputPrice);
    },
    [formatCandidatePrice, getAssetCandidate]
  );

  const formatStoredTradeTotal = useCallback(
    (code: string, shares: number, inputPrice: number, settlementPrice: number) => {
      const candidate = getAssetCandidate(code);
      if (candidate?.priceInputMode === "usd") {
        return `${formatUsdCurrency(shares * inputPrice)} · ${formatCurrency(shares * settlementPrice)}`;
      }
      return formatCurrency(shares * settlementPrice);
    },
    [getAssetCandidate]
  );

  const isUsdSettledAsset = useCallback(
    (code: string) => {
      const candidate = getAssetCandidate(code);
      return code !== "ALT:USD" && candidate?.priceInputMode === "usd";
    },
    [getAssetCandidate]
  );

  const getUsdHoldingBalance = useCallback((holdingsSource: HoldingPosition[]) => {
    const usdPosition = sanitizeHoldings(holdingsSource).find((item) => item.code === "ALT:USD");
    return usdPosition ? aggregatePosition(usdPosition).shares : 0;
  }, []);

  const getProjectedUsdBalance = useCallback(
    (holdingsSource: HoldingPosition[], trades: PendingTrade[]) => {
      let balance = getUsdHoldingBalance(holdingsSource);
      [...trades].reverse().forEach((trade) => {
        if (trade.code === "ALT:USD") {
          balance += trade.side === "매수" ? trade.shares : -trade.shares;
          return;
        }
        if (isUsdSettledAsset(trade.code)) {
          balance += trade.side === "매도" ? trade.shares * trade.price : -(trade.shares * trade.price);
        }
      });
      return roundToPrecision(balance, 2);
    },
    [getUsdHoldingBalance, isUsdSettledAsset]
  );

  const showInsufficientUsdAlert = useCallback((projectedUsdBalance: number) => {
    if (typeof window === "undefined") {
      return;
    }
    const shortage = Math.abs(Math.min(projectedUsdBalance, 0));
    window.alert(`달러 보유량이 부족합니다.\n부족한 달러: ${formatTradeQuantity("ALT:USD", shortage)}USD\n먼저 달러를 매수하거나 보유 달러를 확인해 주세요.`);
  }, [formatTradeQuantity]);

  const orderedPresetNames = useMemo(() => {
    const existing = new Set(Object.keys(selectionPresets));
    const ordered = presetOrder.filter((item) => existing.has(item));
    const remaining = Object.keys(selectionPresets).filter((item) => !presetOrder.includes(item as never));
    return [...ordered, ...remaining];
  }, [selectionPresets]);

  const activePresetName = useMemo(
    () =>
      orderedPresetNames.find((presetName) =>
        arraysEqualAsSet(selectedCodes, selectionPresets[presetName] ?? [])
      ) ?? null,
    [orderedPresetNames, selectedCodes, selectionPresets]
  );

  const selectedChipCollapsed =
    activePresetName === "코스피 전체" ||
    activePresetName === "코스닥 전체" ||
    activePresetName === "코스피+코스닥 전체";

  const recalculatedRankings = useMemo(() => {
    const codeSet = new Set(selectedCodes);
    const sourceRows = data.allRankings.filter((item) => codeSet.size === 0 || codeSet.has(item["종목코드"]));
    const safeRows = sourceRows.length > 0 ? sourceRows : data.allRankings;

    return safeRows
      .map((item) => {
        const roeScore = Number(item["ROE점수"] ?? 0);
        const combinedScore =
          item["성장점수"] * activeWeights.growth +
          item["저평가점수"] * activeWeights.value +
          roeScore * activeWeights.roe;

        return {
          ...item,
          "종합점수_100": Number((combinedScore * 100).toFixed(2)),
          "투자스타일": getStyleLabel(item["성장점수"], item["저평가점수"])
        };
      })
      .sort((a, b) => b["종합점수_100"] - a["종합점수_100"])
      .map((item, index) => ({
        ...item,
        "랭킹": index + 1
      }));
  }, [activeWeights.growth, activeWeights.value, data.allRankings, selectedCodes]);

  const baseVisiblePortfolio = useMemo<VisiblePortfolioRow[]>(() => {
    const topRows = recalculatedRankings.slice(0, topN);
    const totalScore =
      topRows.reduce((sum, item) => sum + item["종합점수_100"] ** 2, 0) || 1;

    return topRows.map((item) => {
      const weight = item["종합점수_100"] ** 2 / totalScore;
      return {
        code: item["종목코드"],
        name: item["종목명"],
        score100: item["종합점수_100"],
        weightPct: Number((weight * 100).toFixed(2)),
        targetAmount: 0,
        style: item["투자스타일"],
        growthScore: item["성장점수"],
        valueScore: item["저평가점수"],
        roeScore: Number(item["ROE점수"] ?? 0),
        roe: Number(item["ROE"] ?? 0),
        operatingGrowth: Number(item["영업이익_3Y성장률"] ?? 0),
        netGrowth: Number(item["순이익_3Y성장률"] ?? 0),
        operatingPer: Number(item["영업이익_PER"] ?? 0),
        netPer: Number(item["순이익_PER"] ?? 0),
        currentPrice: Number(item["현재가"] ?? stockMap.get(item["종목코드"])?.["현재가"] ?? 0)
      };
    });
  }, [recalculatedRankings, stockMap]);

  const selectedStocks = useMemo(() => {
    return stockUniverse
      .filter((item) => selectedCodes.includes(item["종목코드"]))
      .sort((a, b) => {
        const aRank = Number(a["통합시총순위"] ?? 999999);
        const bRank = Number(b["통합시총순위"] ?? 999999);
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return a["종목명"].localeCompare(b["종목명"], "ko");
      });
  }, [selectedCodes, stockUniverse]);

  const filteredStocks = useMemo(() => {
    const normalized = searchTerm.trim().toLowerCase();
    return [...stockUniverse]
      .filter((item) => {
        const matchesSearch =
          !normalized ||
          item["종목명"].toLowerCase().includes(normalized) ||
          item["종목코드"].toLowerCase().includes(normalized);
        const matchesSelected = !selectedOnly || selectedCodes.includes(item["종목코드"]);
        return matchesSearch && matchesSelected;
      })
      .sort((a, b) => {
        const aSelected = selectedCodes.includes(a["종목코드"]) ? 1 : 0;
        const bSelected = selectedCodes.includes(b["종목코드"]) ? 1 : 0;
        if (aSelected !== bSelected) {
          return bSelected - aSelected;
        }
        const aRank = Number(a["통합시총순위"] ?? 999999);
        const bRank = Number(b["통합시총순위"] ?? 999999);
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return a["종목명"].localeCompare(b["종목명"], "ko");
      });
  }, [searchTerm, selectedCodes, selectedOnly, stockUniverse]);

  const visiblePickerStocks = filteredStocks.slice(0, visiblePickerLimit);
  const hiddenPickerCount = Math.max(0, filteredStocks.length - visiblePickerStocks.length);

  const presetCoverage = useMemo(() => {
    const scored = new Set(recalculatedRankings.map((item) => item["종목코드"]));
    return {
      selected: selectedCodes.length,
      scored: selectedCodes.filter((code) => scored.has(code)).length
    };
  }, [recalculatedRankings, selectedCodes]);

  const updatePreviewHoldings = useMemo(
    () => applyPendingTrades(baselineProfile?.holdings ?? holdings, pendingTrades),
    [baselineProfile?.holdings, holdings, pendingTrades]
  );

  const displayHoldings = workspaceMode === "update" ? updatePreviewHoldings : sanitizeHoldings(baselineProfile?.holdings ?? holdings);

  const normalizedHoldings = useMemo(
    () =>
      displayHoldings
        .filter((item) => item.code)
        .map((item) => {
          const aggregate = aggregatePosition(item);
          const asset = getAssetCandidate(item.code);
          const fallbackPrice = Number(asset?.price ?? 0);
          return {
            code: item.code,
            name: asset?.name ?? item.code,
            market: asset?.market ?? "",
            unitLabel: asset?.unitLabel ?? "주",
            quantityPrecision: asset?.quantityPrecision ?? 0,
            shares: aggregate.shares,
            price: fallbackPrice,
            avgBuyPrice: aggregate.avgBuyPrice,
            latestBuyPrice: aggregate.latestBuyPrice,
            purchaseTotal: aggregate.purchaseTotal,
            lotCount: aggregate.lots.length,
            lots: aggregate.lots,
          };
        }),
    [displayHoldings, getAssetCandidate]
  );

  const sortedHoldings = useMemo(
    () =>
      [...normalizedHoldings].sort((a, b) => {
        const aRank = Number(stockMap.get(a.code)?.["통합시총순위"] ?? rankedMap.get(a.code)?.["랭킹"] ?? 999999);
        const bRank = Number(stockMap.get(b.code)?.["통합시총순위"] ?? rankedMap.get(b.code)?.["랭킹"] ?? 999999);
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return a.name.localeCompare(b.name, "ko");
      }),
    [normalizedHoldings, rankedMap, stockMap]
  );

  const holdingInputMap = useMemo(
    () =>
      new Map(
        normalizedHoldings.map((item) => [
          item.code,
          {
            shares: item.shares,
            avgBuyPrice: item.avgBuyPrice,
            price: item.price,
            purchaseTotal: item.purchaseTotal,
            lotCount: item.lotCount,
          },
        ])
      ),
    [normalizedHoldings]
  );

  const holdingsValue = useMemo(
    () => normalizedHoldings.reduce((sum, item) => sum + item.shares * item.price, 0),
    [normalizedHoldings]
  );

  const holdingsPurchaseTotal = useMemo(
    () => normalizedHoldings.reduce((sum, item) => sum + item.purchaseTotal, 0),
    [normalizedHoldings]
  );

  const valuationCash = Math.max(0, effectiveTotalAsset - holdingsPurchaseTotal);
  const allocationBaseAmount = normalizedHoldings.length > 0 ? holdingsValue + valuationCash : effectiveTotalAsset;
  const domesticStockBudget = Math.round(allocationBaseAmount * (domesticStockPct / 100));
  const nonDomesticReserveAmount = Math.max(0, allocationBaseAmount - domesticStockBudget);
  const allocationSummaryRows = assetClassLabels.map((label) => {
    const pct = activeAssetAllocation[label];
    const amount = Math.round(allocationBaseAmount * (pct / 100));
    return {
      key: label,
      label,
      pct,
      amount,
      accent:
        label === "주식"
          ? "positive"
          : label === "가상자산"
            ? "negative"
            : "neutral",
    };
  });
  const allocationDonutSegments = allocationSummaryRows.map((item) => ({
    value: item.amount,
    color:
      item.key === "주식"
        ? "#ff8da1"
        : item.key === "가상자산"
          ? "#7fb0ff"
          : item.key === "금"
            ? "#f0c36d"
            : "#8aa0b8",
  }));
  const allocationDetailRows = [
    {
      key: "krw-cash",
      label: "원화 현금",
      pct: krwCashPct,
      amount: Math.round(allocationBaseAmount * (krwCashPct / 100)),
      direction: "positive" as const,
      note: "현금·예적금·채권 내 원화 비중",
    },
    {
      key: "usd-cash",
      label: "달러 현금",
      pct: usdCashPct,
      amount: Math.round(allocationBaseAmount * (usdCashPct / 100)),
      direction: "negative" as const,
      note: "현금·예적금·채권 내 달러 비중",
    },
    {
      key: "domestic-stock",
      label: "한국주식",
      pct: domesticStockPct,
      amount: domesticStockBudget,
      direction: "positive" as const,
      note: "환율 선형 보간",
    },
    {
      key: "overseas-stock",
      label: "미국주식",
      pct: overseasStockPct,
      amount: Math.round(allocationBaseAmount * (overseasStockPct / 100)),
      direction: "negative" as const,
      note: "해외 ETF/주식용 가이드",
    },
  ];
  const personalAllocation = useMemo(() => {
    const totals = {
      krwCash: Math.max(0, valuationCash),
      usdCash: 0,
      gold: 0,
      crypto: 0,
      domesticStock: 0,
      usStock: 0,
    };

    normalizedHoldings.forEach((item) => {
      const amount = item.shares * item.price;
      const bucket = getAssetAllocationBucket(item.code);
      if (bucket === "usd_cash") {
        totals.usdCash += amount;
      } else if (bucket === "gold") {
        totals.gold += amount;
      } else if (bucket === "crypto") {
        totals.crypto += amount;
      } else if (bucket === "us_stock") {
        totals.usStock += amount;
      } else {
        totals.domesticStock += amount;
      }
    });

    const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
    const topRows = [
      {
        key: "cashBond",
        label: "현금/예적금/채권",
        amount: totals.krwCash + totals.usdCash,
        targetPct: cashBondPct,
        color: "#8aa0b8",
      },
      {
        key: "gold",
        label: "금",
        amount: totals.gold,
        targetPct: activeAssetAllocation["금"],
        color: "#f0c36d",
      },
      {
        key: "crypto",
        label: "가상자산",
        amount: totals.crypto,
        targetPct: activeAssetAllocation["가상자산"],
        color: "#7fb0ff",
      },
      {
        key: "stock",
        label: "주식",
        amount: totals.domesticStock + totals.usStock,
        targetPct: stockPct,
        color: "#ff8da1",
      },
    ].map((item) => ({
      ...item,
      currentPct: total > 0 ? (item.amount / total) * 100 : 0,
      diffPct: (total > 0 ? (item.amount / total) * 100 : 0) - item.targetPct,
    }));

    const detailRows = [
      {
        key: "krwCash",
        label: "원화 현금",
        amount: totals.krwCash,
        targetPct: krwCashPct,
        currentPct: total > 0 ? (totals.krwCash / total) * 100 : 0,
      },
      {
        key: "usdCash",
        label: "달러 현금",
        amount: totals.usdCash,
        targetPct: usdCashPct,
        currentPct: total > 0 ? (totals.usdCash / total) * 100 : 0,
      },
      {
        key: "domesticStock",
        label: "한국주식",
        amount: totals.domesticStock,
        targetPct: domesticStockPct,
        currentPct: total > 0 ? (totals.domesticStock / total) * 100 : 0,
      },
      {
        key: "usStock",
        label: "미국주식",
        amount: totals.usStock,
        targetPct: overseasStockPct,
        currentPct: total > 0 ? (totals.usStock / total) * 100 : 0,
      },
    ].map((item) => ({
      ...item,
      diffPct: item.currentPct - item.targetPct,
    }));

    return { total, topRows, detailRows };
  }, [
    activeAssetAllocation,
    cashBondPct,
    domesticStockPct,
    normalizedHoldings,
    overseasStockPct,
    stockPct,
    usdCashPct,
    valuationCash,
    krwCashPct,
  ]);
  const personalAllocationDonutSegments = personalAllocation.topRows.map((item) => ({
    value: item.amount,
    color: item.color,
  }));
  const personalAllocationDiffRows = personalAllocation.topRows
    .map((item) => {
      const direction =
        item.diffPct > 0.25 ? "over" : item.diffPct < -0.25 ? "under" : "aligned";
      return {
        ...item,
        direction,
      };
    })
    .sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));

  const visiblePortfolio = useMemo<VisiblePortfolioRow[]>(
    () =>
      baseVisiblePortfolio.map((item) => ({
        ...item,
        targetAmount: Math.round((item.weightPct / 100) * domesticStockBudget),
      })),
    [baseVisiblePortfolio, domesticStockBudget]
  );

  const holdingsProfit = holdingsValue - holdingsPurchaseTotal;
  const holdingsReturnPct = holdingsPurchaseTotal > 0 ? (holdingsProfit / holdingsPurchaseTotal) * 100 : 0;

  const baselineHoldings = useMemo(() => sanitizeHoldings(baselineProfile?.holdings ?? []), [baselineProfile]);

  const baselineSummary = useMemo(() => {
    const purchaseTotal = baselineHoldings.reduce((sum, position) => {
      const aggregate = aggregatePosition(position);
      return sum + aggregate.purchaseTotal;
    }, 0);
    const value = baselineHoldings.reduce((sum, position) => {
      const aggregate = aggregatePosition(position);
      const price = Number(getAssetCandidate(position.code)?.price ?? 0);
      return sum + aggregate.shares * price;
    }, 0);
    const profit = value - purchaseTotal;
    const principal = Number(baselineProfile?.totalAsset ?? 0);
    const realizedProfitTotal = Number(baselineProfile?.realizedProfit ?? 0);
    const totalProfit = realizedProfitTotal + profit;
    const returnPct = principal > 0 ? (totalProfit / principal) * 100 : 0;
    const cash = Math.max(0, principal - purchaseTotal);
    return { purchaseTotal, value, profit, returnPct, cash };
  }, [baselineHoldings, baselineProfile?.realizedProfit, baselineProfile?.totalAsset, getAssetCandidate]);

  const savedProfileMetrics = useMemo(
    () =>
      new Map(
        savedProfiles.map((saved) => {
          const sanitized = sanitizeHoldings(saved.holdings);
          const holdingsCount = sanitized.filter((position) => aggregatePosition(position).shares > 0).length;
          const stockValue = sanitized.reduce((sum, position) => {
            const aggregate = aggregatePosition(position);
            const price = Number(getAssetCandidate(position.code)?.price ?? 0);
            return sum + aggregate.shares * price;
          }, 0);
          const purchaseTotal = sanitized.reduce((sum, position) => sum + aggregatePosition(position).purchaseTotal, 0);
          const cash = Math.max(0, Number(saved.totalAsset ?? 0) - purchaseTotal);
          const portfolioValue = stockValue + cash;
          return [saved.id, { holdingsCount, portfolioValue }] as const;
        })
      ),
    [getAssetCandidate, savedProfiles]
  );

  const derivedCash = valuationCash;
  const rebalanceBudget = domesticStockBudget;
  const assetGap = effectiveTotalAsset - holdingsPurchaseTotal;

  const targetShareMap = useMemo(() => {
    const eligibleRows = visiblePortfolio.filter((item) => item.currentPrice > 0);
    const floors = new Map<string, number>();
    let spent = 0;

    const candidates = eligibleRows.map((item) => {
      const idealShares = (rebalanceBudget * (item.weightPct / 100)) / item.currentPrice;
      const floorShares = Math.floor(idealShares);
      floors.set(item.code, floorShares);
      spent += floorShares * item.currentPrice;
      return {
        code: item.code,
        price: item.currentPrice,
        fraction: idealShares - floorShares,
        weightPct: item.weightPct
      };
    });

    let remainingCash = rebalanceBudget - spent;
    candidates
      .sort((a, b) => {
        if (b.fraction !== a.fraction) {
          return b.fraction - a.fraction;
        }
        return b.weightPct - a.weightPct;
      })
      .forEach((item) => {
        if (item.price <= remainingCash) {
          floors.set(item.code, (floors.get(item.code) ?? 0) + 1);
          remainingCash -= item.price;
        }
      });

    return {
      targetShares: floors,
      leftoverCash: Math.max(0, remainingCash)
    };
  }, [rebalanceBudget, visiblePortfolio]);

  const holdingSummary = useMemo<RebalanceRow[]>(() => {
    const domesticHoldings = normalizedHoldings.filter((item) => !item.code.startsWith("ALT:"));
    const currentMap = new Map(
      domesticHoldings.map((item) => [
        item.code,
        {
          name: item.name,
          shares: item.shares,
          price: item.price
        }
      ])
    );

    const rows = new Map<string, RebalanceRow>();

    visiblePortfolio.forEach((item) => {
      const current = currentMap.get(item.code);
      const price = item.currentPrice || current?.price || 0;
      const currentShares = current?.shares ?? 0;
      const targetShares = targetShareMap.targetShares.get(item.code) ?? 0;
      const currentAmount = currentShares * price;
      const targetAmount = targetShares * price;
      const diffShares = targetShares - currentShares;
      const diffAmount = targetAmount - currentAmount;

      let action: RebalanceRow["action"] = "유지";
      if (currentShares === 0 && targetShares > 0) action = "신규 편입";
      else if (currentShares > 0 && targetShares === 0) action = "전량 매도";
      else if (diffShares > 0) action = "비중 확대";
      else if (diffShares < 0) action = "비중 축소";

      rows.set(item.code, {
        code: item.code,
        name: item.name,
        price,
        currentShares,
        targetShares,
        currentAmount,
        targetAmount,
      currentWeightPct: rebalanceBudget > 0 ? Number(((currentAmount / rebalanceBudget) * 100).toFixed(2)) : 0,
      targetWeightPct: rebalanceBudget > 0 ? Number(((targetAmount / rebalanceBudget) * 100).toFixed(2)) : 0,
        diffShares,
        diffAmount,
        action
      });
    });

    domesticHoldings.forEach((item) => {
      if (rows.has(item.code)) {
        return;
      }
      const currentAmount = item.shares * item.price;
      rows.set(item.code, {
        code: item.code,
        name: item.name,
        price: item.price,
        currentShares: item.shares,
        targetShares: 0,
        currentAmount,
        targetAmount: 0,
        currentWeightPct: rebalanceBudget > 0 ? Number(((currentAmount / rebalanceBudget) * 100).toFixed(2)) : 0,
        targetWeightPct: 0,
        diffShares: -item.shares,
        diffAmount: -currentAmount,
        action: item.shares > 0 ? "전량 매도" : "유지"
      });
    });
    return [...rows.values()].sort((a, b) => Math.abs(b.diffAmount) - Math.abs(a.diffAmount));
  }, [normalizedHoldings, rebalanceBudget, targetShareMap.targetShares, visiblePortfolio]);

  const rebalanceGroups = useMemo(() => {
    const newBuys = holdingSummary.filter((item) => item.action === "신규 편입");
    const addMore = holdingSummary.filter((item) => item.action === "비중 확대");
    const trim = holdingSummary.filter((item) => item.action === "비중 축소");
    const exit = holdingSummary.filter((item) => item.action === "전량 매도");
    const keep = holdingSummary.filter((item) => item.action === "유지");
    return { newBuys, addMore, trim, exit, keep };
  }, [holdingSummary]);

  const orderedExecutionRows = useMemo(
    () => {
      const rankMap = new Map(
        recalculatedRankings.map((item, index) => [item["종목코드"], index + 1])
      );

      return [...holdingSummary].sort((a, b) => {
        const priorityDiff = actionPriority(a.action) - actionPriority(b.action);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        const aRank = rankMap.get(a.code) ?? 999999;
        const bRank = rankMap.get(b.code) ?? 999999;
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return Math.abs(b.diffAmount) - Math.abs(a.diffAmount);
      });
    },
    [holdingSummary, recalculatedRankings]
  );

  const selectedRebalanceTradeCodes = useMemo(
    () => new Set(rebalancePendingTrades.map((item) => item.code)),
    [rebalancePendingTrades]
  );

  const marketTopCandidates = useMemo(() => {
    const sourceCodes = selectedCodes.length > 0 ? selectedCodes : defaultSelection;
    const sourceSet = new Set(sourceCodes);
    return stockUniverse
      .filter((item) => sourceSet.has(item["종목코드"]))
      .sort((a, b) => {
        const aRank = Number(a["통합시총순위"] ?? 999999);
        const bRank = Number(b["통합시총순위"] ?? 999999);
        return aRank - bRank;
      })
      .slice(0, 20);
  }, [defaultSelection, selectedCodes, stockUniverse]);

  const rebalanceSummary = useMemo(() => {
    const buyAmount = holdingSummary
      .filter((item) => item.diffAmount > 0)
      .reduce((sum, item) => sum + item.diffAmount, 0);
    const sellAmount = holdingSummary
      .filter((item) => item.diffAmount < 0)
      .reduce((sum, item) => sum + Math.abs(item.diffAmount), 0);
    const actionCount = holdingSummary.filter((item) => item.action !== "유지").length;
    const finalCash = Math.max(0, effectiveTotalAsset - (domesticStockBudget + buyAmount - sellAmount));

    return {
      currentAssetValue: holdingsValue,
      purchaseTotal: holdingsPurchaseTotal,
      rebalanceBudget,
      buyAmount,
      sellAmount,
      actionCount,
      finalCash
    };
  }, [domesticStockBudget, effectiveTotalAsset, holdingSummary, holdingsPurchaseTotal, holdingsValue, rebalanceBudget]);

  const buildPortfolioSnapshot = (params: {
    id?: string;
    name?: string;
    totalAsset: number;
    holdings: HoldingPosition[];
    realizedProfit?: number;
  }) =>
    createProfileSnapshot({
      id: params.id ?? activeSavedProfileId ?? "rebalance-preview",
      name: params.name ?? (profileNameInput.trim() || "현재 포트폴리오"),
      selectedCodes,
      profile,
      totalAsset: params.totalAsset,
      holdings: params.holdings,
      realizedProfit: params.realizedProfit ?? realizedProfit,
    });

  const buildAssetSegments = useCallback((positions: HoldingPosition[], cashAmount = 0) => {
    const segments = sanitizeHoldings(positions)
      .map((position, index) => {
        const aggregate = aggregatePosition(position);
        const asset = getAssetCandidate(position.code);
        const price = Number(asset?.price ?? 0);
        return {
          label: asset?.name ?? position.code,
          value: aggregate.shares * price,
          color: portfolioSegmentPalette[index % portfolioSegmentPalette.length],
        };
      })
      .filter((item) => item.value > 0);

    if (cashAmount > 0) {
      segments.push({ label: "현금", value: cashAmount, color: "#dce8f8" });
    }

    return segments;
  }, [getAssetCandidate]);

  const buildSectorSegments = useCallback((positions: HoldingPosition[], cashAmount = 0) => {
    const totals = {
      cashBond: Math.max(0, cashAmount),
      gold: 0,
      crypto: 0,
      stock: 0,
    };

    sanitizeHoldings(positions).forEach((position) => {
      const aggregate = aggregatePosition(position);
      const asset = getAssetCandidate(position.code);
      const amount = aggregate.shares * Number(asset?.price ?? 0);
      const bucket = getAssetAllocationBucket(position.code);

      if (bucket === "gold") {
        totals.gold += amount;
        return;
      }
      if (bucket === "crypto") {
        totals.crypto += amount;
        return;
      }
      if (bucket === "usd_cash") {
        totals.cashBond += amount;
        return;
      }
      totals.stock += amount;
    });

    return [
      { label: "현금/예적금/채권", value: totals.cashBond, color: "#8aa0b8" },
      { label: "금", value: totals.gold, color: "#f0c36d" },
      { label: "가상자산", value: totals.crypto, color: "#7fb0ff" },
      { label: "주식", value: totals.stock, color: "#ff8da1" },
    ].filter((item) => item.value > 0);
  }, [getAssetCandidate]);

  const collapseLegendRows = useCallback(
    <T extends { label: string; color: string; pct: number }>(items: T[]) => {
      if (items.length <= 10) {
        return items;
      }

      const topRows = items.slice(0, 10);
      const rest = items.slice(10);
      const otherPct = rest.reduce((sum, item) => sum + item.pct, 0);

      if (otherPct <= 0) {
        return topRows;
      }

      return [
        ...topRows,
        {
          ...topRows[topRows.length - 1],
          label: "기타",
          color: "#dce8f8",
          pct: otherPct,
        },
      ];
    },
    []
  );

  const buildPortfolioSegmentsFromSnapshot = useCallback((snapshot: SavedProfile | null) => {
    if (!snapshot) {
      return [];
    }
    const holdingsSource = sanitizeHoldings(snapshot.holdings);
    const purchaseTotal = holdingsSource.reduce((sum, position) => sum + aggregatePosition(position).purchaseTotal, 0);
    return buildAssetSegments(holdingsSource, Math.max(0, snapshot.totalAsset - purchaseTotal));
  }, [buildAssetSegments]);

  const portfolioChartSegments = useMemo(
    () =>
      visiblePortfolio.map((item, index) => ({
        label: item.name,
        value: item.weightPct,
        color: portfolioSegmentPalette[index % portfolioSegmentPalette.length]
      })),
    [visiblePortfolio]
  );

  const currentPortfolioChartSegments = useMemo(
    () => buildAssetSegments(displayHoldings, valuationCash),
    [buildAssetSegments, displayHoldings, valuationCash]
  );

  const targetPortfolioChartSegments = useMemo(() => {
    const segments = visiblePortfolio.map((item, index) => ({
      label: item.name,
      value: item.targetAmount,
      color: portfolioSegmentPalette[index % portfolioSegmentPalette.length]
    }));

    if (nonDomesticReserveAmount > 0) {
      segments.push({ label: "비주식 자산", value: nonDomesticReserveAmount, color: "#dce8f8" });
    }
    if (targetShareMap.leftoverCash > 0) {
      segments.push({ label: "국내주식 잔여 현금", value: targetShareMap.leftoverCash, color: "#f0f7ff" });
    }
    return segments;
  }, [nonDomesticReserveAmount, targetShareMap.leftoverCash, visiblePortfolio]);

  const currentPortfolioLegend = useMemo(() => {
    const total = currentPortfolioChartSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    const rows = currentPortfolioChartSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
    return collapseLegendRows(rows);
  }, [collapseLegendRows, currentPortfolioChartSegments]);

  const baselinePortfolioSegments = useMemo(
    () => buildAssetSegments(baselineProfile?.holdings ?? [], baselineSummary.cash),
    [baselineProfile?.holdings, baselineSummary.cash, buildAssetSegments]
  );

  const baselinePortfolioLegend = useMemo(() => {
    const total = baselinePortfolioSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    const rows = baselinePortfolioSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
    return collapseLegendRows(rows);
  }, [baselinePortfolioSegments, collapseLegendRows]);

  const baselineSectorSegments = useMemo(
    () => buildSectorSegments(baselineProfile?.holdings ?? [], baselineSummary.cash),
    [baselineProfile?.holdings, baselineSummary.cash, buildSectorSegments]
  );

  const baselineSectorLegend = useMemo(() => {
    const total = baselineSectorSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    return baselineSectorSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
  }, [baselineSectorSegments]);

  const baselinePerformanceLegend = useMemo(() => {
    const baselineTotal = baselinePortfolioSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    const rows = baselineHoldings
      .map((position, index) => {
        const aggregate = aggregatePosition(position);
        const asset = getAssetCandidate(position.code);
        const price = Number(asset?.price ?? 0);
        const value = aggregate.shares * price;
        const profit = value - aggregate.purchaseTotal;
        const returnPct = aggregate.purchaseTotal > 0 ? (profit / aggregate.purchaseTotal) * 100 : 0;
        return {
          label: asset?.name ?? position.code,
          color: baselinePortfolioSegments[index]?.color ?? "#3182f6",
          shares: aggregate.shares,
          weightPct: (value / baselineTotal) * 100,
          returnPct,
        };
      })
      .sort((a, b) => b.returnPct - a.returnPct);

    const cashSegment = baselinePortfolioSegments.find((item) => item.label === "현금");
    if (cashSegment) {
      rows.push({
        label: "현금",
        color: cashSegment.color,
        shares: 0,
        weightPct: (cashSegment.value / baselineTotal) * 100,
        returnPct: 0,
      });
    }
    return rows;
  }, [baselineHoldings, baselinePortfolioSegments, getAssetCandidate]);

  const baselineHoldingRows = useMemo(() => {
    return baselineHoldings
      .map((position) => {
        const aggregate = aggregatePosition(position);
        const price = Number(getAssetCandidate(position.code)?.price ?? 0);
        const value = aggregate.shares * price;
        const profit = value - aggregate.purchaseTotal;
        const returnPct = aggregate.purchaseTotal > 0 ? (profit / aggregate.purchaseTotal) * 100 : 0;
        const weightPct = baselineSummary.value > 0 ? (value / baselineSummary.value) * 100 : 0;
        return {
          code: position.code,
          name: getAssetCandidate(position.code)?.name ?? position.code,
          unitLabel: getAssetCandidate(position.code)?.unitLabel ?? "주",
          shares: aggregate.shares,
          value,
          weightPct,
          avgBuyPrice: aggregate.avgBuyPrice,
          price,
          returnPct,
          profit,
        };
      })
      .sort((a, b) => b.weightPct - a.weightPct);
  }, [baselineHoldings, baselineSummary.value, getAssetCandidate]);

  const updateComparisonRows = useMemo(() => {
    const baselineMap = new Map(
      baselineHoldings.map((position) => {
        const aggregate = aggregatePosition(position);
        const asset = getAssetCandidate(position.code);
        const price = Number(asset?.price ?? 0);
        const amount = aggregate.shares * price;
        return [
          position.code,
          {
            name: asset?.name ?? position.code,
            shares: aggregate.shares,
            amount,
          },
        ] as const;
      })
    );
    const currentMap = new Map(
      normalizedHoldings.map((item) => [
        item.code,
        {
          name: item.name,
          shares: item.shares,
          amount: item.shares * item.price,
        },
      ] as const)
    );
    const codes = new Set([...baselineMap.keys(), ...currentMap.keys()]);
    return [...codes]
      .map((code) => {
        const before = baselineMap.get(code) ?? { name: currentMap.get(code)?.name ?? code, shares: 0, amount: 0 };
        const after = currentMap.get(code) ?? { name: before.name, shares: 0, amount: 0 };
        const beforeWeight = baselineSummary.value > 0 ? (before.amount / baselineSummary.value) * 100 : 0;
        const afterWeight = holdingsValue > 0 ? (after.amount / holdingsValue) * 100 : 0;
        return {
          code,
          name: after.name || before.name,
          beforeShares: before.shares,
          afterShares: after.shares,
          beforeWeight,
          afterWeight,
          diffShares: after.shares - before.shares,
          diffWeight: afterWeight - beforeWeight,
        };
      })
      .filter((item) => item.beforeShares !== item.afterShares)
      .sort((a, b) => b.afterWeight - a.afterWeight);
  }, [baselineHoldings, baselineSummary.value, getAssetCandidate, holdingsValue, normalizedHoldings]);

  const updateCashComparison = useMemo(() => {
    if (pendingCashAdjustment === 0) {
      return null;
    }
    return {
      beforeTotalAsset: totalAsset,
      afterTotalAsset: effectiveTotalAsset,
      diffAmount: pendingCashAdjustment,
    };
  }, [effectiveTotalAsset, pendingCashAdjustment, totalAsset]);

  const rebalanceComparisonRows = useMemo(() => {
    const beforeHoldingsSource = baselineProfile?.holdings ?? holdings;
    const afterHoldingsSource = applyPendingTrades(beforeHoldingsSource, rebalancePendingTrades);
    const beforeTotalValue = sanitizeHoldings(beforeHoldingsSource).reduce((sum, position) => {
      const aggregate = aggregatePosition(position);
      const price = Number(getAssetCandidate(position.code)?.price ?? 0);
      return sum + aggregate.shares * price;
    }, 0);
    const afterTotalValue = sanitizeHoldings(afterHoldingsSource).reduce((sum, position) => {
      const aggregate = aggregatePosition(position);
      const price = Number(getAssetCandidate(position.code)?.price ?? 0);
      return sum + aggregate.shares * price;
    }, 0);
    const beforeMap = new Map(
      sanitizeHoldings(beforeHoldingsSource).map((position) => {
        const aggregate = aggregatePosition(position);
        const price = Number(getAssetCandidate(position.code)?.price ?? 0);
        return [
          position.code,
          {
            shares: aggregate.shares,
            amount: aggregate.shares * price,
          },
        ] as const;
      })
    );
    const afterMap = new Map(
      sanitizeHoldings(afterHoldingsSource).map((position) => {
        const aggregate = aggregatePosition(position);
        const price = Number(getAssetCandidate(position.code)?.price ?? 0);
        return [
          position.code,
          {
            shares: aggregate.shares,
            amount: aggregate.shares * price,
          },
        ] as const;
      })
    );

    return rebalancePendingTrades
      .map((trade) => {
        const before = beforeMap.get(trade.code) ?? { shares: 0, amount: 0 };
        const after = afterMap.get(trade.code) ?? { shares: 0, amount: 0 };
        return {
          code: trade.code,
          name: trade.name,
          side: trade.side,
          beforeShares: before.shares,
          afterShares: after.shares,
          beforeWeight: beforeTotalValue > 0 ? (before.amount / beforeTotalValue) * 100 : 0,
          afterWeight: afterTotalValue > 0 ? (after.amount / afterTotalValue) * 100 : 0,
          diffShares: after.shares - before.shares,
        };
      })
      .filter((item) => item.diffShares !== 0)
      .sort((a, b) => b.afterWeight - a.afterWeight);
  }, [baselineProfile?.holdings, getAssetCandidate, holdings, rebalancePendingTrades]);

  const rebalanceCashComparison = useMemo(() => {
    if (pendingCashAdjustment === 0) {
      return null;
    }
    const beforeTotalAsset = baselineProfile?.totalAsset ?? totalAsset;
    return {
      beforeTotalAsset,
      afterTotalAsset: clampAsset(beforeTotalAsset + pendingCashAdjustment),
      diffAmount: pendingCashAdjustment,
    };
  }, [baselineProfile?.totalAsset, pendingCashAdjustment, totalAsset]);

  const targetPortfolioLegend = useMemo(() => {
    const total = targetPortfolioChartSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    return targetPortfolioChartSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
  }, [targetPortfolioChartSegments]);

  const rebalanceBeforeSegments = useMemo(
    () => buildPortfolioSegmentsFromSnapshot(rebalanceComparison.before),
    [rebalanceComparison.before, rankedMap, stockMap]
  );

  const rebalanceAfterSegments = useMemo(
    () => buildPortfolioSegmentsFromSnapshot(rebalanceComparison.after),
    [rebalanceComparison.after, rankedMap, stockMap]
  );

  const rebalanceBeforeLegend = useMemo(() => {
    const total = rebalanceBeforeSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    const rows = rebalanceBeforeSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
    return collapseLegendRows(rows);
  }, [collapseLegendRows, rebalanceBeforeSegments]);

  const rebalanceAfterLegend = useMemo(() => {
    const total = rebalanceAfterSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    const rows = rebalanceAfterSegments
      .map((item) => ({
        ...item,
        pct: (item.value / total) * 100,
      }))
      .sort((a, b) => b.pct - a.pct);
    return collapseLegendRows(rows);
  }, [collapseLegendRows, rebalanceAfterSegments]);

  const rebalanceBeforeCount = useMemo(
    () =>
      sanitizeHoldings(rebalanceComparison.before?.holdings ?? []).filter(
        (position) => aggregatePosition(position).shares > 0
      ).length,
    [rebalanceComparison.before]
  );

  const rebalanceAfterCount = useMemo(
    () =>
      sanitizeHoldings(rebalanceComparison.after?.holdings ?? []).filter(
        (position) => aggregatePosition(position).shares > 0
      ).length,
    [rebalanceComparison.after]
  );

  const factorQuadrants = useMemo(() => {
    const sourceRows = selectedChipCollapsed
      ? []
      : recalculatedRankings.filter((item) => selectedCodes.includes(item["종목코드"]));
    const groups = {
      highHigh: [] as typeof recalculatedRankings,
      growth: [] as typeof recalculatedRankings,
      value: [] as typeof recalculatedRankings,
      neutral: [] as typeof recalculatedRankings
    };

    sourceRows.forEach((item) => {
      if (item["성장점수"] >= 0.6 && item["저평가점수"] >= 0.6) groups.highHigh.push(item);
      else if (item["성장점수"] >= 0.6) groups.growth.push(item);
      else if (item["저평가점수"] >= 0.6) groups.value.push(item);
      else groups.neutral.push(item);
    });

    return groups;
  }, [recalculatedRankings, selectedChipCollapsed, selectedCodes]);

  const selectedFactorRows = useMemo(() => {
    if (selectedChipCollapsed) {
      return [];
    }
    return recalculatedRankings.filter((item) => selectedCodes.includes(item["종목코드"]));
  }, [recalculatedRankings, selectedChipCollapsed, selectedCodes]);

  const extraAssetCandidates = useMemo<AssetCandidate[]>(() => [...extraAssetMap.values()], [extraAssetMap]);

  const holdingSearchResults = useMemo<AssetCandidate[]>(() => {
    const normalized = holdingSearchTerm.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const domestic = stockUniverse
      .filter((item) => {
        return (
          item["종목명"].toLowerCase().includes(normalized) ||
          item["종목코드"].toLowerCase().includes(normalized)
        );
      })
      .sort((a, b) => {
        const aRank = Number(a["통합시총순위"] ?? 999999);
        const bRank = Number(b["통합시총순위"] ?? 999999);
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return a["종목명"].localeCompare(b["종목명"], "ko");
      })
      .slice(0, 8)
      .map((item) => ({
        code: item["종목코드"],
        name: item["종목명"],
        market: item["시장"] ?? "국내주식",
        price: Number(item["현재가"] ?? 0),
        quantityStep: 1,
        quantityPrecision: 0,
        unitLabel: "주",
      }));

    const extras = extraAssetCandidates.filter((item) =>
      item.name.toLowerCase().includes(normalized) || item.code.toLowerCase().includes(normalized)
    );

    return [...domestic, ...extras].slice(0, 12);
  }, [extraAssetCandidates, holdingSearchTerm, stockUniverse]);

  const tradePickerCandidates = useMemo<AssetCandidate[]>(() => {
    if (holdingSearchTerm.trim()) {
      return holdingSearchResults.slice(0, 20);
    }
    return [
      ...marketTopCandidates.map((item) => ({
        code: item["종목코드"],
        name: item["종목명"],
        market: item["시장"] ?? "국내주식",
        price: Number(item["현재가"] ?? 0),
        quantityStep: 1,
        quantityPrecision: 0,
        unitLabel: "주",
      })),
      ...extraAssetCandidates,
    ];
  }, [extraAssetCandidates, holdingSearchResults, holdingSearchTerm, marketTopCandidates]);

  const selectedTradeStock = useMemo(
    () => tradePickerCandidates.find((item) => item.code === selectedTradeCode) ?? null,
    [selectedTradeCode, tradePickerCandidates]
  );

  useEffect(() => {
    if (!tradePickerCandidates.length) {
      setSelectedTradeCode(null);
      return;
    }
    if (!selectedTradeCode || !tradePickerCandidates.some((item) => item.code === selectedTradeCode)) {
      setSelectedTradeCode(tradePickerCandidates[0].code);
    }
  }, [selectedTradeCode, tradePickerCandidates]);

  const groupedExcluded = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const item of data.excludedDetails ?? []) {
      const reason = item["사유"] || "데이터 확인 필요";
      const current = grouped.get(reason) ?? [];
      current.push(item["종목명"]);
      grouped.set(reason, current);
    }

    return [...grouped.entries()].map(([reason, names]) => ({
      reason,
      names: [...new Set(names)].sort((a, b) => a.localeCompare(b, "ko")),
    }));
  }, [data.excludedDetails]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let mounted = true;
    supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!mounted) {
        return;
      }
      setAuthUser(sessionData.session?.user ?? null);
      setAuthReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setAuthReady(true);
      if (!session?.user) {
        resetSignedOutWorkspace();
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [resetSignedOutWorkspace, supabase]);

  useEffect(() => {
    if (!supabaseEnabled) {
      return;
    }
    if (!authReady) {
      return;
    }
    if (!authUser || !supabase) {
      setRemoteReady(true);
      setStorageReady(true);
      return;
    }

    let cancelled = false;
    setRemoteReady(false);

    (supabase as any)
      .from("profiles")
      .select("id,name,profile,total_asset,selected_codes,holdings,realized_profit,updated_at")
      .eq("user_id", authUser.id)
      .order("updated_at", { ascending: false })
      .then(({ data: rows, error }: { data: DbProfileRow[] | null; error: unknown }) => {
        if (cancelled) {
          return;
        }
        if (error) {
          setAuthMessage("저장된 포트폴리오를 불러오지 못했습니다.");
          setSavedProfiles([]);
          setRemoteReady(true);
          setStorageReady(true);
          return;
        }

        const profiles = sortProfilesByUpdatedAt(((rows ?? []) as DbProfileRow[]).map(mapDbProfileToSaved));
        setSavedProfiles(profiles);
        const source = profiles.find((item) => item.id === activeSavedProfileId) ?? profiles[0] ?? null;
        if (source) {
          setActiveSavedProfileId(source.id);
          setSelectedCodes(source.selectedCodes?.length ? source.selectedCodes : defaultSelection);
          setProfile(normalizeProfileLabel(source.profile ?? data.profile));
          setTotalAsset(clampAsset(source.totalAsset ?? (data.investAmount || 10_000_000)));
          setHoldings(sanitizeHoldings(source.holdings ?? []));
          setRealizedProfit(Number(source.realizedProfit ?? 0));
          setPendingTrades([]);
          setRebalancePendingTrades([]);
          setPendingCashAdjustment(0);
          setProfileNameInput(source.name || "기본 포트폴리오");
          setBaselineProfile({
            ...source,
            profile: normalizeProfileLabel(source.profile),
            holdings: sanitizeHoldings(source.holdings ?? []),
          });
        }
        setRemoteReady(true);
        setStorageReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSavedProfileId, authReady, authUser, data.investAmount, data.profile, defaultSelection, supabase, supabaseEnabled]);

  useEffect(() => {
    if (supabaseEnabled) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setStorageReady(true);
        return;
      }

      const parsed = JSON.parse(raw) as StorageEnvelope;
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      const lastSession = parsed.lastSession;

      setSavedProfiles(profiles.map((item) => ({ ...item, profile: normalizeProfileLabel(item.profile) })));
      setActiveSavedProfileId(parsed.activeProfileId ?? null);

      const source = lastSession ?? profiles.find((item) => item.id === parsed.activeProfileId) ?? null;
      if (source) {
        setSelectedCodes(source.selectedCodes?.length ? source.selectedCodes : defaultSelection);
        setProfile(normalizeProfileLabel(source.profile ?? data.profile));
        setTotalAsset(clampAsset(source.totalAsset ?? (data.investAmount || 10_000_000)));
        setHoldings(sanitizeHoldings(source.holdings ?? []));
        setRealizedProfit(Number(source.realizedProfit ?? 0));
        setPendingTrades([]);
        setRebalancePendingTrades([]);
        setPendingCashAdjustment(0);
        setProfileNameInput(source.name || "기본 포트폴리오");
        setBaselineProfile({
          ...source,
          profile: normalizeProfileLabel(source.profile),
          holdings: sanitizeHoldings(source.holdings ?? []),
        });
      }
    } catch {
      // Ignore invalid client-side storage and continue with server defaults.
    } finally {
      setStorageReady(true);
    }
  }, [data.investAmount, data.profile, defaultSelection]);

  useEffect(() => {
    if (supabaseEnabled) {
      return;
    }
    if (!storageReady || typeof window === "undefined") {
      return;
    }

    const lastSession = createProfileSnapshot({
      id: activeSavedProfileId ?? "last-session",
      name: profileNameInput || "기본 포트폴리오",
      selectedCodes,
      profile,
      totalAsset,
      holdings,
      realizedProfit,
    });

    const payload: StorageEnvelope = {
      version: 1,
      activeProfileId: activeSavedProfileId,
      lastSession,
      profiles: savedProfiles,
    };

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [activeSavedProfileId, holdings, profile, profileNameInput, realizedProfit, savedProfiles, selectedCodes, storageReady, totalAsset]);

  useEffect(() => {
    if (!confirmMessage) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmMessage(null), 2500);
    return () => window.clearTimeout(timer);
  }, [confirmMessage]);

  useEffect(() => {
    if (supabaseEnabled && !authUser && workspaceMode === "update") {
      setWorkspaceMode("rebalance");
    }
  }, [authUser, supabaseEnabled, workspaceMode]);

  useEffect(() => {
    if (supabaseEnabled && authUser) {
      setWorkspaceMode("update");
    }
  }, [authUser, supabaseEnabled]);

  useEffect(() => {
    const syncHeights = () => {
      setPortfolioListHeight(portfolioPieRef.current?.offsetHeight ?? null);
      setFactorPanelHeight(factorMapRef.current?.offsetHeight ?? null);
    };

    const frame = window.requestAnimationFrame(syncHeights);
    const observer = new ResizeObserver(() => syncHeights());
    if (portfolioPieRef.current) {
      observer.observe(portfolioPieRef.current);
    }
    if (factorMapRef.current) {
      observer.observe(factorMapRef.current);
    }
    window.addEventListener("resize", syncHeights);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncHeights);
    };
  }, [selectedCodes.length, visiblePortfolio.length, selectedFactorRows.length, selectedChipCollapsed, workspaceMode]);

  useEffect(() => {
    if (workspaceMode !== "rebalance") {
      return;
    }

    const source = baselineProfile
      ? buildPortfolioSnapshot({
          id: baselineProfile.id,
          name: baselineProfile.name,
          totalAsset: baselineProfile.totalAsset,
          holdings: baselineProfile.holdings,
          realizedProfit: baselineProfile.realizedProfit,
        })
      : buildPortfolioSnapshot({
          totalAsset,
          holdings,
          realizedProfit,
        });

    const baseHoldingsSource = baselineProfile?.holdings ?? holdings;
    const afterHoldings = applyPendingTrades(baseHoldingsSource, rebalancePendingTrades);
    const afterRealizedProfit =
      Number(baselineProfile?.realizedProfit ?? realizedProfit ?? 0) +
      calculateTradeRealizedProfit(baseHoldingsSource, rebalancePendingTrades);

    setRebalanceComparison({
      before: source,
      after: buildPortfolioSnapshot({
        id: source.id,
        name: source.name,
        totalAsset: clampAsset(source.totalAsset + pendingCashAdjustment),
        holdings: afterHoldings,
        realizedProfit: afterRealizedProfit,
      }),
    });
  }, [
    baselineProfile,
    holdings,
    pendingCashAdjustment,
    rebalancePendingTrades,
    realizedProfit,
    totalAsset,
    workspaceMode,
  ]);

  const applyPreset = (presetName: string) => {
    const safePreset = selectionPresets[presetName];
    if (safePreset) {
      setSelectedCodes(safePreset);
      setSearchTerm("");
      setSelectedOnly(false);
    }
  };

  const toggleCode = (code: string) => {
    setSelectedCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
    );
  };

  const updateTradeDraft = (code: string, patch: Partial<TradeDraft>) => {
    setTradeDrafts((current) => {
      const asset = getAssetCandidate(code);
      const fallbackPrice = Number(asset?.priceInputMode === "usd" ? asset?.nativePrice ?? 0 : asset?.price ?? 0);
      const base = current[code] ?? { shares: 0, price: fallbackPrice };
      const nextPrice = patch.price ?? base.price;
      return {
        ...current,
        [code]: {
          shares: clampTradeQuantity(code, Number(patch.shares ?? base.shares) || 0),
          price:
            asset?.priceInputMode === "usd"
              ? Math.max(0, roundToPrecision(Number(nextPrice) || 0, 2))
              : Math.max(0, snapPriceToTick(Number(nextPrice) || 0)),
        },
      };
    });
  };

  const upsertHoldingPosition = (code: string, updater: (position: HoldingPosition) => HoldingPosition | null) => {
    setHoldings((current) => {
      const index = current.findIndex((item) => item.code === code);
      const existing = index >= 0 ? current[index] : { code, lots: [] };
      const updated = updater(existing);

      if (!updated) {
        return current.filter((item) => item.code !== code);
      }

      if (index >= 0) {
        return current.map((item, itemIndex) => (itemIndex === index ? updated : item));
      }

      return [...current, updated];
    });
  };

  const hasDuplicateProfileName = (name: string, excludeId?: string | null) => {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return savedProfiles.some((item) => item.id !== excludeId && item.name.trim().toLowerCase() === normalized);
  };

  const saveCurrentProfile = (saveAsNew: boolean) => {
    const targetId = saveAsNew || !activeSavedProfileId ? makeId("profile") : activeSavedProfileId;
    const targetName = profileNameInput.trim() || `저장 슬롯 ${savedProfiles.length + 1}`;
    const snapshot = createProfileSnapshot({
      id: targetId,
      name: targetName,
      selectedCodes,
      profile,
      totalAsset,
      holdings,
    });

    setSavedProfiles((current) => {
      const without = current.filter((item) => item.id !== targetId);
      return sortProfilesByUpdatedAt([snapshot, ...without]);
    });
    setActiveSavedProfileId(targetId);
    setProfileNameInput(targetName);
    setBaselineProfile(snapshot);
  };

  const loadSavedProfile = (profileId: string) => {
    const snapshot = savedProfiles.find((item) => item.id === profileId);
    if (!snapshot) {
      return;
    }
    setActiveSavedProfileId(snapshot.id);
    setProfileNameInput(snapshot.name);
    setSelectedCodes(snapshot.selectedCodes);
    setProfile(normalizeProfileLabel(snapshot.profile));
    setTotalAsset(clampAsset(snapshot.totalAsset));
    setHoldings(sanitizeHoldings(snapshot.holdings));
    setTradeDrafts({});
    setPendingTrades([]);
    setRebalancePendingTrades([]);
    setPendingCashAdjustment(0);
    setRealizedProfit(Number(snapshot.realizedProfit ?? 0));
    setBaselineProfile({
      ...snapshot,
      holdings: sanitizeHoldings(snapshot.holdings),
    });
    setSearchTerm("");
    setSelectedOnly(false);
    setWorkspaceMode("update");
    setConfirmMessage(null);
  };

  const deleteSavedProfile = (profileId: string) => {
    if (!profileId) {
      return;
    }
    const profile = savedProfiles.find((item) => item.id === profileId);
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(`"${profile?.name ?? "이 포트폴리오"}"를 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.`);
    if (!confirmed) {
      return;
    }
    const clearCurrentProfile = () => {
      if (activeSavedProfileId === profileId) {
        setActiveSavedProfileId(null);
        setProfileNameInput("기본 포트폴리오");
        setBaselineProfile(null);
        setHoldings([]);
        setRealizedProfit(0);
        setTradeDrafts({});
        setPendingTrades([]);
        setRebalancePendingTrades([]);
        setPendingCashAdjustment(0);
      }
    };
    const applyDelete = () => {
      setSavedProfiles((current) => current.filter((item) => item.id !== profileId));
      clearCurrentProfile();
    };
    if (supabase && authUser) {
      (supabase as any).from("profiles").delete().eq("id", profileId).eq("user_id", authUser.id).then(({ error }: { error: unknown }) => {
        if (error) {
          setConfirmMessage("포트폴리오 삭제에 실패했습니다.");
          return;
        }
        applyDelete();
      });
      return;
    }
    applyDelete();
  };

  const persistProfileSnapshot = (params: {
    snapshot: SavedProfile;
    errorMessage: string;
    onSuccess: (savedSnapshot: SavedProfile) => void;
  }) => {
    const { snapshot, errorMessage, onSuccess } = params;
    const isExistingRemoteProfile = isUuidLike(activeSavedProfileId);

    const finish = (savedSnapshot: SavedProfile) => {
      setSavedProfiles((current) => {
        const without = current.filter((item) => item.id !== savedSnapshot.id);
        return sortProfilesByUpdatedAt([savedSnapshot, ...without]);
      });
      setActiveSavedProfileId(savedSnapshot.id);
      setProfileNameInput(savedSnapshot.name);
      onSuccess(savedSnapshot);
    };

    if (supabase && authUser) {
      if (isExistingRemoteProfile) {
        (supabase as any)
          .from("profiles")
          .update(mapSavedProfileToDb(snapshot))
          .eq("id", activeSavedProfileId)
          .eq("user_id", authUser.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              setConfirmMessage(getSupabaseErrorMessage(error, errorMessage));
              return;
            }
            finish(snapshot);
          });
      } else {
        (supabase as any)
          .from("profiles")
          .insert(mapSavedProfileToDb(snapshot))
          .select()
          .single()
          .then(({ data: inserted, error }: { data?: DbProfileRow; error: unknown }) => {
            if (error) {
              setConfirmMessage(getSupabaseErrorMessage(error, errorMessage));
              return;
            }
            if (inserted?.id) {
              snapshot.id = inserted.id;
            }
            finish(snapshot);
          });
      }
      return;
    }

    finish(snapshot);
  };

  const confirmPortfolioUpdate = () => {
    const targetId = activeSavedProfileId ?? makeId("profile");
    const targetName = profileNameInput.trim() || (activeSavedProfileId ? "현재 포트폴리오" : "새 포트폴리오");
    if (hasDuplicateProfileName(targetName, activeSavedProfileId)) {
      setConfirmMessage("같은 이름의 포트폴리오는 만들 수 없습니다.");
      return;
    }
    if (assetGap < 0) {
      setConfirmMessage("현재 반영 자산이 매입총액보다 작아 적용할 수 없습니다. 현금 인출 금액을 줄이거나 보유 내역을 확인해 주세요.");
      return;
    }
    const updateBaseHoldings = baselineProfile?.holdings ?? holdings;
    if (getProjectedUsdBalance(updateBaseHoldings, pendingTrades) < 0) {
      setConfirmMessage("달러 보유량이 부족합니다. 먼저 달러를 매수하거나 미국 자산 매수 금액을 줄여 주세요.");
      return;
    }
    const nextRealizedProfit =
      Number(baselineProfile?.realizedProfit ?? realizedProfit ?? 0) +
      calculateTradeRealizedProfit(baselineHoldings, pendingTrades);
    const snapshot = createProfileSnapshot({
      id: targetId,
      name: targetName,
      selectedCodes,
      profile,
      totalAsset: effectiveTotalAsset,
      holdings: updatePreviewHoldings,
      realizedProfit: nextRealizedProfit,
    });

    persistProfileSnapshot({
      snapshot,
      errorMessage: "포트폴리오 저장에 실패했습니다.",
      onSuccess: (savedSnapshot) => {
        setBaselineProfile(savedSnapshot);
        setHoldings(savedSnapshot.holdings);
        setTotalAsset(savedSnapshot.totalAsset);
        setRealizedProfit(nextRealizedProfit);
        setPendingTrades([]);
        setRebalancePendingTrades([]);
        setPendingCashAdjustment(0);
        setConfirmMessage("포트폴리오 변경이 저장되었습니다.");
      },
    });
  };

  const createEmptyProfile = () => {
    if (supabase && !authUser?.id) {
      setConfirmMessage("로그인 상태를 다시 확인한 뒤 시도해 주세요.");
      return;
    }
    let targetName = newProfileNameInput.trim() || `새 포트폴리오 ${savedProfiles.length + 1}`;
    let nextIndex = savedProfiles.length + 2;
    while (hasDuplicateProfileName(targetName)) {
      targetName = `새 포트폴리오 ${nextIndex}`;
      nextIndex += 1;
    }
    const snapshot = createProfileSnapshot({
      id: makeId("profile"),
      name: targetName,
      selectedCodes,
      profile: "밸런스형",
      totalAsset: Math.min(totalAssetMax, Math.max(totalAssetMin, newProfileAsset)),
      holdings: [],
      realizedProfit: 0,
    });

    const finish = () => {
      setSavedProfiles((current) => sortProfilesByUpdatedAt([snapshot, ...current]));
      setActiveSavedProfileId(snapshot.id);
      setProfileNameInput(targetName);
      setProfile("밸런스형");
      setTotalAsset(snapshot.totalAsset);
      setHoldings([]);
      setRealizedProfit(0);
      setTradeDrafts({});
      setPendingTrades([]);
      setRebalancePendingTrades([]);
      setPendingCashAdjustment(0);
      setBaselineProfile(snapshot);
      setWorkspaceMode("update");
      setNewProfileNameInput("");
      setConfirmMessage("신규 포트폴리오가 생성되었습니다.");
    };
    if (supabase && authUser) {
      (supabase as any)
        .from("profiles")
        .insert(mapSavedProfileToDb(snapshot))
        .select()
        .single()
        .then(({ data: inserted, error }: { data?: DbProfileRow; error: unknown }) => {
          if (error) {
            setConfirmMessage(getSupabaseErrorMessage(error, "신규 포트폴리오 생성에 실패했습니다."));
            return;
          }
          if (inserted?.id) {
            snapshot.id = inserted.id;
          }
          finish();
        });
      return;
    }
    finish();
  };

  const duplicateSavedProfile = (profileId: string) => {
    const source = savedProfiles.find((item) => item.id === profileId);
    if (!source) {
      return;
    }
    let nextName = `${source.name} 복사본`;
    let copyIndex = 2;
    while (hasDuplicateProfileName(nextName)) {
      nextName = `${source.name} 복사본 ${copyIndex}`;
      copyIndex += 1;
    }
    const snapshot = createProfileSnapshot({
      id: makeId("profile"),
      name: nextName,
      selectedCodes: source.selectedCodes,
      profile: source.profile,
      totalAsset: source.totalAsset,
      holdings: source.holdings,
      realizedProfit: source.realizedProfit ?? 0,
    });
    const finish = () => {
      setSavedProfiles((current) => sortProfilesByUpdatedAt([snapshot, ...current]));
      setActiveSavedProfileId(snapshot.id);
      setProfileNameInput(snapshot.name);
      setSelectedCodes(snapshot.selectedCodes);
      setProfile(normalizeProfileLabel(snapshot.profile));
      setTotalAsset(clampAsset(snapshot.totalAsset));
      setHoldings(sanitizeHoldings(snapshot.holdings));
      setRealizedProfit(Number(snapshot.realizedProfit ?? 0));
      setTradeDrafts({});
      setPendingTrades([]);
      setRebalancePendingTrades([]);
      setPendingCashAdjustment(0);
      setBaselineProfile(snapshot);
      setWorkspaceMode("update");
      setConfirmMessage("포트폴리오 복사본이 생성되었습니다.");
    };
    if (supabase && authUser) {
      (supabase as any)
        .from("profiles")
        .insert(mapSavedProfileToDb(snapshot))
        .select()
        .single()
        .then(({ data: inserted, error }: { data?: DbProfileRow; error: unknown }) => {
          if (error) {
            setConfirmMessage(getSupabaseErrorMessage(error, "포트폴리오 복사에 실패했습니다."));
            return;
          }
          if (inserted?.id) {
            snapshot.id = inserted.id;
          }
          finish();
        });
      return;
    }
    finish();
  };

  const renameSavedProfile = (profileId: string) => {
    if (typeof window === "undefined") {
      return;
    }
    const source = savedProfiles.find((item) => item.id === profileId);
    if (!source) {
      return;
    }
    const nextName = window.prompt("새 포트폴리오 이름을 입력해 주세요.", source.name)?.trim();
    if (!nextName) {
      return;
    }
    if (hasDuplicateProfileName(nextName, profileId)) {
      setConfirmMessage("같은 이름의 포트폴리오는 만들 수 없습니다.");
      return;
    }
    const updatedAt = new Date().toISOString();
    const finish = () => {
      setSavedProfiles((current) =>
        current.map((item) => (item.id === profileId ? { ...item, name: nextName, updatedAt } : item))
      );
      if (activeSavedProfileId === profileId) {
        setProfileNameInput(nextName);
        setBaselineProfile((current) => (current ? { ...current, name: nextName, updatedAt } : current));
      }
      setConfirmMessage("포트폴리오 이름이 변경되었습니다.");
    };
    if (supabase && authUser) {
      (supabase as any)
        .from("profiles")
        .update({ name: nextName, updated_at: updatedAt })
        .eq("id", profileId)
        .eq("user_id", authUser.id)
        .then(({ error }: { error: unknown }) => {
          if (error) {
            setConfirmMessage(getSupabaseErrorMessage(error, "포트폴리오 이름 변경에 실패했습니다."));
            return;
          }
          finish();
        });
      return;
    }
    finish();
  };

  const signInWithGoogle = async () => {
    if (!supabase) {
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
      },
    });
    setAuthMessage(error ? getSupabaseErrorMessage(error, "Google 로그인에 실패했습니다.") : null);
  };

  const signOut = async () => {
    if (!supabase) {
      return;
    }
    resetSignedOutWorkspace();
    await supabase.auth.signOut();
    setAuthMessage("로그아웃되었습니다.");
  };

  const queueTrade = (code: string, side: "매수" | "매도") => {
    const asset = getAssetCandidate(code);
    const draft = tradeDrafts[code] ?? {
      shares: 0,
      price: Number(asset?.priceInputMode === "usd" ? asset?.nativePrice ?? 0 : asset?.price ?? 0),
    };
    const shares = clampTradeQuantity(code, Number(draft?.shares) || 0);
    const inputPrice = Number(draft?.price) || Number(asset?.priceInputMode === "usd" ? asset?.nativePrice ?? 0 : asset?.price ?? 0);
    const price = toStoredTradePrice(asset, inputPrice);
    const currentHolding = updatePreviewHoldings.find((item) => item.code === code);
    const currentShares = currentHolding ? aggregatePosition(currentHolding).shares : 0;
    if (!asset || shares <= 0 || price <= 0) {
      return;
    }
    if (side === "매도" && currentShares <= 0) {
      return;
    }

    const nextTrade: PendingTrade = {
      id: makeId("trade"),
      code,
      name: asset.name,
      side,
      shares,
      price: inputPrice,
      settlementPrice: price,
    };
    const updateBaseHoldings = baselineProfile?.holdings ?? holdings;
    const projectedUsdBalance = getProjectedUsdBalance(updateBaseHoldings, [nextTrade, ...pendingTrades]);
    if (projectedUsdBalance < 0) {
      showInsufficientUsdAlert(projectedUsdBalance);
      return;
    }

    setPendingTrades((current) => [
      nextTrade,
      ...current,
    ]);

    setTradeDrafts((current) => ({
      ...current,
      [code]: {
        shares: 0,
        price: inputPrice,
      },
    }));
  };

  const queueRebalanceTrade = (code: string, side: "매수" | "매도") => {
    const asset = getAssetCandidate(code);
    const draft = tradeDrafts[code] ?? {
      shares: 0,
      price: Number(asset?.priceInputMode === "usd" ? asset?.nativePrice ?? 0 : asset?.price ?? 0),
    };
    const shares = clampTradeQuantity(code, Number(draft?.shares) || 0);
    const inputPrice = Number(draft?.price) || Number(asset?.priceInputMode === "usd" ? asset?.nativePrice ?? 0 : asset?.price ?? 0);
    const price = toStoredTradePrice(asset, inputPrice);
    const currentHolding = sanitizeHoldings(baselineProfile?.holdings ?? holdings).find((item) => item.code === code);
    const currentShares = currentHolding ? aggregatePosition(currentHolding).shares : 0;
    if (!asset || shares <= 0 || price <= 0) {
      return;
    }
    if (side === "매도" && currentShares <= 0) {
      return;
    }

    const nextTrade: PendingTrade = {
      id: makeId("rebalance-trade"),
      code,
      name: asset.name,
      side,
      shares,
      price: inputPrice,
      settlementPrice: price,
    };
    const rebalanceBaseHoldings = baselineProfile?.holdings ?? holdings;
    const projectedUsdBalance = getProjectedUsdBalance(rebalanceBaseHoldings, [nextTrade, ...rebalancePendingTrades]);
    if (projectedUsdBalance < 0) {
      showInsufficientUsdAlert(projectedUsdBalance);
      return;
    }

    setRebalancePendingTrades((current) => [
      nextTrade,
      ...current,
    ]);

    setTradeDrafts((current) => ({
      ...current,
      [code]: {
        shares: 0,
        price: inputPrice,
      },
    }));
  };

  const updatePendingTrade = (id: string, patch: Partial<Pick<PendingTrade, "shares" | "price">>) => {
    setPendingTrades((current) =>
      {
        const nextTrades = current.map((item) =>
          item.id === id
            ? (() => {
                const candidate = getAssetCandidate(item.code);
                const nextPrice =
                  patch.price !== undefined
                    ? candidate?.priceInputMode === "usd"
                      ? Math.max(0, roundToPrecision(patch.price, 2))
                      : Math.max(0, snapPriceToTick(Math.round(patch.price)))
                    : item.price;
                return {
                  ...item,
                  shares: patch.shares !== undefined ? clampTradeQuantity(item.code, patch.shares) : item.shares,
                  price: nextPrice,
                  settlementPrice:
                    patch.price !== undefined ? toStoredTradePrice(candidate, nextPrice) : item.settlementPrice,
                };
              })()
            : item
        );
        const updateBaseHoldings = baselineProfile?.holdings ?? holdings;
        const projectedUsdBalance = getProjectedUsdBalance(updateBaseHoldings, nextTrades);
        if (projectedUsdBalance < 0) {
          showInsufficientUsdAlert(projectedUsdBalance);
          return current;
        }
        return nextTrades;
      }
    );
  };

  const removePendingTrade = (id: string) => {
    setPendingTrades((current) => current.filter((item) => item.id !== id));
  };

  const toggleRebalanceTrade = (row: RebalanceRow) => {
    const suggestedTrade = getExecutionTrade(row);
    if (!suggestedTrade) {
      return;
    }

    setRebalancePendingTrades((current) => {
      const existing = current.find((item) => item.code === row.code);
      if (existing) {
        return current.filter((item) => item.code !== row.code);
      }
      return [suggestedTrade, ...current];
    });
  };

  const updateRebalancePendingTrade = (id: string, patch: Partial<Pick<PendingTrade, "shares" | "price">>) => {
    setRebalancePendingTrades((current) =>
      {
        const nextTrades = current.map((item) =>
          item.id === id
            ? (() => {
                const candidate = getAssetCandidate(item.code);
                const nextPrice =
                  patch.price !== undefined
                    ? candidate?.priceInputMode === "usd"
                      ? Math.max(0, roundToPrecision(patch.price, 2))
                      : Math.max(0, snapPriceToTick(Math.round(patch.price)))
                    : item.price;
                return {
                  ...item,
                  shares: patch.shares !== undefined ? clampTradeQuantity(item.code, patch.shares) : item.shares,
                  price: nextPrice,
                  settlementPrice:
                    patch.price !== undefined ? toStoredTradePrice(candidate, nextPrice) : item.settlementPrice,
                };
              })()
            : item
        );
        const rebalanceBaseHoldings = baselineProfile?.holdings ?? holdings;
        const projectedUsdBalance = getProjectedUsdBalance(rebalanceBaseHoldings, nextTrades);
        if (projectedUsdBalance < 0) {
          showInsufficientUsdAlert(projectedUsdBalance);
          return current;
        }
        return nextTrades;
      }
    );
  };

  const removeRebalancePendingTrade = (id: string) => {
    setRebalancePendingTrades((current) => current.filter((item) => item.id !== id));
  };

  const queueCashAdjustment = () => {
    const amount = Math.max(0, Math.round(cashAdjustmentDraft));
    if (amount <= 0) {
      return;
    }

    setPendingCashAdjustment((current) => current + (cashAdjustmentType === "입금" ? amount : -amount));
    setCashAdjustmentDraft(0);
  };

  const persistRebalanceChanges = () => {
    if (!baselineProfile && !activeSavedProfileId) {
      setConfirmMessage("내 포트 관리하기에서 저장된 포트폴리오를 먼저 선택해 주세요.");
      return;
    }
    if (rebalancePendingTrades.length === 0 && pendingCashAdjustment === 0) {
      setConfirmMessage("먼저 실행 순서나 현금 변동을 장바구니에 담아 주세요.");
      return;
    }
    if (assetGap < 0) {
      setConfirmMessage("현재 반영 자산이 매입총액보다 작아 적용할 수 없습니다. 현금 인출 금액을 줄이거나 보유 내역을 확인해 주세요.");
      return;
    }
    const rebalanceBaseHoldings = baselineProfile?.holdings ?? holdings;
    if (getProjectedUsdBalance(rebalanceBaseHoldings, rebalancePendingTrades) < 0) {
      setConfirmMessage("달러 보유량이 부족합니다. 먼저 달러를 매수하거나 미국 자산 매수 금액을 줄여 주세요.");
      return;
    }

    const targetId = activeSavedProfileId ?? makeId("profile");
    const targetName = profileNameInput.trim() || (activeSavedProfileId ? "현재 포트폴리오" : "새 포트폴리오");
    const baseHoldingsSource = baselineProfile?.holdings ?? holdings;
    const nextRealizedProfit =
      Number(baselineProfile?.realizedProfit ?? realizedProfit ?? 0) +
      calculateTradeRealizedProfit(baseHoldingsSource, rebalancePendingTrades);
    const beforeSnapshot = buildPortfolioSnapshot({
      id: targetId,
      name: targetName,
      totalAsset,
      holdings: baseHoldingsSource,
      realizedProfit: baselineProfile?.realizedProfit ?? realizedProfit,
    });
    const snapshot = createProfileSnapshot({
      id: targetId,
      name: targetName,
      selectedCodes,
      profile,
      totalAsset: effectiveTotalAsset,
      holdings: applyPendingTrades(baseHoldingsSource, rebalancePendingTrades),
      realizedProfit: nextRealizedProfit,
    });

    persistProfileSnapshot({
      snapshot,
      errorMessage: "포트폴리오 반영에 실패했습니다.",
      onSuccess: (savedSnapshot) => {
        setBaselineProfile(savedSnapshot);
        setHoldings(savedSnapshot.holdings);
        setTotalAsset(savedSnapshot.totalAsset);
        setRealizedProfit(nextRealizedProfit);
        setPendingTrades([]);
        setRebalancePendingTrades([]);
        setPendingCashAdjustment(0);
        setRebalanceComparison({
          before: beforeSnapshot,
          after: buildPortfolioSnapshot({
            id: savedSnapshot.id,
            name: savedSnapshot.name,
            totalAsset: savedSnapshot.totalAsset,
            holdings: savedSnapshot.holdings,
            realizedProfit: savedSnapshot.realizedProfit,
          }),
        });
        setConfirmMessage("선택한 실행과 현금 변동이 포트폴리오에 반영되었습니다.");
      },
    });
  };

  const scrollToWorkspace = (mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    requestAnimationFrame(() => {
      controlPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <main className="page-shell">
      <section className="hero simple-hero">
        <div className="hero-main">
          <div className="hero-topbar">
            <div className="hero-brand">
              <p className="eyebrow">Modoo ETF</p>
              <strong>모두의 ETF</strong>
            </div>
          </div>

          <div className="hero-copy compact hero-copy-upgraded">
            <h1>
              추천 포트폴리오를 확인하고,
              <br />
              필요한 포트폴리오 변화를 자동으로 관리하세요.
            </h1>
            <p className="hero-text">
              원하는 종목 구성을 빠르게 고르고, 투자 성향에 맞춘 추천 포트폴리오를 바로 확인할 수 있습니다.
              로그인하면 거래내역과 현재 보유 포트폴리오를 저장하고, 필요한 포트폴리오 변화를 여러 기기에서
              이어서 관리할 수 있습니다.
            </p>
            <div className="hero-cta-row">
              <button className="chip-button ghost" onClick={() => scrollToWorkspace("rebalance")}>
                추천 포트폴리오 보기
              </button>
              {supabaseEnabled ? authUser ? (
                <button className="saved-slot-copy" onClick={signOut}>
                  로그아웃
                </button>
              ) : (
                <button className="saved-slot-copy" onClick={signInWithGoogle}>
                  구글로 로그인하기
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="hero-side">
          <div className="auth-landing-visual" aria-hidden="true">
            <div className="auth-visual-ring">
              <div className="auth-visual-center">
                <strong>TOP 10</strong>
                <span>추천 포트폴리오</span>
              </div>
            </div>
            <div className="auth-visual-stack">
              <div className="auth-visual-card">
                <span>추천 방식</span>
                <strong>성향 · 시장상황 기반</strong>
                <small>성장성 · PER · ROE 반영</small>
              </div>
              <div className="auth-visual-card">
                <span>저장 방식</span>
                <strong>{authUser ? "계정 저장" : "Google 로그인 후 저장"}</strong>
                <small>로그인 없이도 추천 보기 가능</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel control-panel" ref={controlPanelRef}>
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">{canManagePortfolio ? "Portfolio" : "Rebalancing"}</p>
            <h2>{canManagePortfolio ? "내 포트 관리하기" : "추천 포트폴리오 보기"}</h2>
          </div>
          <p className="section-note">
            {canManagePortfolio
              ? "계정에 신규 포트폴리오를 등록하거나 기존에 저장된 포트폴리오를 불러옵니다."
              : "로그인 없이 추천 포트폴리오를 바로 확인하고, 원하는 종목과 투자 성향을 먼저 살펴볼 수 있습니다."}
          </p>
        </div>

        {canManagePortfolio ? (
        <div className="control-card save-slot-card">
          <div className="save-slot-head">
            <div>
              <h3>{supabaseEnabled ? "내 포트폴리오" : "내 포트 관리하기"}</h3>
              <p>
                {supabaseEnabled
                  ? authUser
                    ? `${authUser.email ?? "로그인 사용자"} 계정으로 저장합니다.`
                    : "로그인하면 포트폴리오와 거래내역을 계정에 저장하고 여러 기기에서 이어서 관리할 수 있습니다."
                  : "브라우저 로컬에 저장합니다. 다시 방문해도 마지막 상태를 자동 복원하고, 원하는 조합은 슬롯으로 따로 보관할 수 있습니다."}
              </p>
            </div>
          </div>
          {supabaseEnabled && !authReady ? (
            <div className="auth-card">
              <strong>로그인 상태를 확인하는 중입니다.</strong>
            </div>
          ) : (
          <div className="saved-slot-stack">
            <div className="saved-slot-create-card">
              <div className="saved-slot-create-main">
                <strong>신규 포트폴리오 만들기</strong>
                <label className="search-input inline-search">
                  <span>포트폴리오 이름</span>
                  <input
                    type="text"
                    placeholder="예: 배당형 포트폴리오"
                    value={newProfileNameInput}
                    onChange={(event) => setNewProfileNameInput(event.target.value)}
                  />
                </label>
                <div className="new-profile-asset-box">
                  <span>투자가능금액</span>
                  <strong>{formatCurrency(newProfileAsset)}</strong>
                  <div className="new-profile-asset-actions">
                    <button type="button" className="chip-button ghost" onClick={() => setNewProfileAsset(totalAssetMin)}>
                      기본 1,000만
                    </button>
                    {createProfileQuickAdds.map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        className="chip-button ghost"
                        onClick={() =>
                          setNewProfileAsset((current) =>
                            Math.min(totalAssetMax, Math.max(totalAssetMin, current + amount))
                          )
                        }
                      >
                        +{amount === 100_000_000 ? "1억" : `${amount / 1_0000}만`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button className="saved-slot-copy" onClick={createEmptyProfile}>
                만들기
              </button>
            </div>
            <div className="saved-slot-list">
              {savedProfiles.map((saved) => (
                <div
                  key={saved.id}
                  className={saved.id === activeSavedProfileId ? "saved-slot-card active-filter" : "saved-slot-card"}
                >
                  <button className="saved-slot-body" onClick={() => loadSavedProfile(saved.id)}>
                    {saved.id === activeSavedProfileId ? <em className="active-profile-badge">현재 선택</em> : null}
                    <strong>{saved.name}</strong>
                    <span>{new Date(saved.updatedAt).toLocaleDateString("ko-KR")} 수정</span>
                    <small>
                      {saved.profile} · 종목 {formatNumber(savedProfileMetrics.get(saved.id)?.holdingsCount ?? 0)}개 · 총평가액{" "}
                      {formatCurrency(savedProfileMetrics.get(saved.id)?.portfolioValue ?? 0)}
                    </small>
                  </button>
                  <div className="saved-slot-actions">
                    <button className="saved-slot-copy" onClick={() => renameSavedProfile(saved.id)}>
                      이름 변경
                    </button>
                    <button className="saved-slot-copy" onClick={() => duplicateSavedProfile(saved.id)}>
                      복사하기
                    </button>
                    <button className="saved-slot-delete" onClick={() => deleteSavedProfile(saved.id)}>
                      삭제하기
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}
        </div>
        ) : null}

        <div className="control-card workspace-card">
          {canManagePortfolio ? (
            <div className="workspace-tabs">
              <button
                className={workspaceMode === "update" ? "profile-button active" : "profile-button"}
                onClick={() => setWorkspaceMode("update")}
              >
                내 포트 관리하기
              </button>
              <button
                className={workspaceMode === "rebalance" ? "profile-button active" : "profile-button"}
                onClick={() => setWorkspaceMode("rebalance")}
              >
                추천 포트폴리오 보기
              </button>
            </div>
          ) : null}
          {canManagePortfolio && workspaceMode === "update" ? (
            <p className="workspace-note">
              현재 포트폴리오를 검토하고 거래내역을 입력한 뒤, 변경 내용을 확인하고 확정하는 화면입니다.
            </p>
          ) : (
            <div className="workspace-note-stack">
              <p>저장된 보유 상태를 기준으로 추천 포트폴리오와 리밸런싱 결과를 확인하는 화면입니다.</p>
              <p>기본적으로 포트폴리오는 아래와 같이 구성됩니다.</p>
              <p>종목 카테고리 : 기본 관심 종목, 투자 성향 : 밸런스형, 투자 금액 : 1,000만원</p>
              <p>수정을 원하시면 아래 탭에서 선택하시면 됩니다.</p>
              <p>
                종목의 경우 각 카테고리별로 선택된 내역이 아래쪽에 파란색으로 표시되고, 원하는 종목을 추가하고
                싶으시면 아래 종목 검색 탭에서 추가하시면 됩니다.
              </p>
            </div>
          )}
        </div>

        {supabaseEnabled && authUser && !remoteReady ? (
          <div className="control-card auth-card">
            <strong>저장된 포트폴리오를 불러오는 중입니다.</strong>
          </div>
        ) : null}

        {workspaceMode === "rebalance" ? (
        <>
        <div className="control-grid refined">
          <div className="control-card">
            <h3>투자 성향</h3>
            <div className="profile-grid">
              {profileLabels.map((item) => (
                <button
                  key={item}
                  className={item === profile ? "profile-button active" : "profile-button"}
                  onClick={() => setProfile(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <p className="weight-caption">
              점수 비중 기준 성장 {Math.round(activeWeights.growth * 100)} / 가치 {Math.round(activeWeights.value * 100)} / ROE {Math.round(activeWeights.roe * 100)}
            </p>
          </div>
        </div>

        <div className="control-card asset-allocation-card">
          <div className="asset-allocation-head">
            <div>
              <h3>자산배분 가이드</h3>
              <p>
                총자산을 먼저 상위 자산군으로 나누고, 주식과 현금은 환율 기준으로 국내·해외와 원화·달러 비중을
                선형 보간합니다.
              </p>
            </div>
          </div>
          <div className="asset-allocation-visual">
            <article className="asset-allocation-donut-card">
              <div className="donut-wrap">
                <div className="donut-ring large" style={buildDonutStyle(allocationDonutSegments)}>
                  <div className="donut-center">
                    <strong>{formatCurrency(allocationBaseAmount)}</strong>
                    <span>총 평가액 기준</span>
                  </div>
                </div>
              </div>
              <div className="donut-legend">
                {allocationSummaryRows.map((item, index) => (
                  <div className="legend-row" key={item.key}>
                    <span className="legend-dot" style={{ backgroundColor: allocationDonutSegments[index]?.color ?? "#3182f6" }} />
                    <strong>{item.label}</strong>
                    <span>{item.pct}% · {formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            </article>
            <div className="asset-allocation-detail-panel">
              <div className="asset-split-grid">
                {allocationDetailRows.map((item) => (
                  <article className={`allocation-detail-card ${item.direction}`} key={item.key}>
                    <div>
                      <span>{item.label}</span>
                      <strong>{item.pct.toFixed(2)}%</strong>
                    </div>
                    <small>{item.note}</small>
                    <em>{formatCurrency(item.amount)}</em>
                  </article>
                ))}
              </div>
              <div className="exchange-rate-panel">
                <div className="exchange-rate-source-card">
                  <div className="exchange-rate-source-head">
                    <span>{exchangeRateSource}</span>
                    <strong>{exchangeRateAsOf ? `${formatCompactDate(exchangeRateAsOf)} 기준` : "최근 영업일 기준"}</strong>
                  </div>
                  <div className="exchange-rate-inline-badge">
                    <span>적용 환율</span>
                    <strong>{formatNumber(exchangeRate)}원/USD</strong>
                  </div>
                  <small>
                    {exchangeRateFallback
                      ? "네이버 증권 환율을 읽지 못해 내부 기본값 1,400원을 사용 중입니다."
                      : "사용자 입력 없이 네이버 증권 환율로 자동 계산합니다."}
                  </small>
                </div>
                <div className="exchange-rate-legend">
                  <div className="exchange-rate-table">
                    <div className="exchange-rate-row exchange-rate-head">
                      <span>환율 구간</span>
                      <span>주식 배분</span>
                      <span>현금 배분</span>
                    </div>
                    <div className="exchange-rate-row">
                      <strong>1,300원 이하</strong>
                      <span>해외 100 / 국내 0</span>
                      <span>달러 100 / 원화 0</span>
                    </div>
                    <div className="exchange-rate-row">
                      <strong>1,400원</strong>
                      <span>해외 50 / 국내 50</span>
                      <span>달러 50 / 원화 50</span>
                    </div>
                    <div className="exchange-rate-row">
                      <strong>1,500원 이상</strong>
                      <span>해외 0 / 국내 100</span>
                      <span>달러 0 / 원화 100</span>
                    </div>
                    <small className="exchange-rate-footnote">그 사이 구간은 선형 보간으로 비중을 계산합니다.</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {showPersonalAllocationGuide ? (
            <div className="personal-allocation-card">
              <div className="personal-allocation-head">
                <div>
                  <h4>현재 내 자산 비중</h4>
                  <p>미국주식은 종목과 관계없이 하나로 묶고, 비트코인과 이더리움은 가상자산 합계로 비교합니다.</p>
                </div>
                <div className="summary-chip compact">
                  <span>현재 평가금액</span>
                  <strong>{formatCurrency(personalAllocation.total)}</strong>
                </div>
              </div>
              <div className="personal-allocation-grid">
                <article className="asset-allocation-donut-card personal-donut-card">
                  <div className="donut-wrap">
                    <div className="donut-ring large" style={buildDonutStyle(personalAllocationDonutSegments)}>
                      <div className="donut-center">
                        <strong>{formatCurrency(personalAllocation.total)}</strong>
                        <span>현재 비중</span>
                      </div>
                    </div>
                  </div>
                  <div className="donut-legend">
                    {personalAllocation.topRows.map((item, index) => (
                      <div className="legend-row" key={`personal-${item.key}`}>
                        <span className="legend-dot" style={{ backgroundColor: personalAllocationDonutSegments[index]?.color ?? "#3182f6" }} />
                        <strong>{item.label}</strong>
                        <span>{item.currentPct.toFixed(2)}% · {formatCurrency(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                </article>
                <div className="personal-allocation-side">
                  <div className="personal-allocation-diff-list">
                    {personalAllocationDiffRows.map((item) => (
                      <article className="personal-allocation-diff-row" key={`diff-${item.key}`}>
                        <strong>{item.label}</strong>
                        <small>현재 {item.currentPct.toFixed(2)}%</small>
                        <small>가이드 {item.targetPct.toFixed(2)}%</small>
                        <small className="personal-allocation-diff-copy">
                          {item.direction === "over" ? (
                            <>
                              가이드보다 <strong className="metric-negative">{item.diffPct.toFixed(2)}%p</strong> 높음
                            </>
                          ) : item.direction === "under" ? (
                            <>
                              가이드보다 <strong className="metric-positive">{Math.abs(item.diffPct).toFixed(2)}%p</strong> 낮음
                            </>
                          ) : (
                            "가이드와 유사"
                          )}
                        </small>
                      </article>
                    ))}
                  </div>
                  <div className="personal-allocation-detail-grid">
                    {personalAllocation.detailRows.map((item) => (
                      <article className="personal-allocation-detail-row" key={`detail-${item.key}`}>
                        <strong>{item.label}</strong>
                        <small>현재 {item.currentPct.toFixed(2)}%</small>
                        <small>가이드 {item.targetPct.toFixed(2)}%</small>
                        <small className="personal-allocation-diff-copy">
                          {item.diffPct > 0.25 ? (
                            <>
                              가이드보다 <strong className="metric-negative">{item.diffPct.toFixed(2)}%p</strong> 높음
                            </>
                          ) : item.diffPct < -0.25 ? (
                            <>
                              가이드보다 <strong className="metric-positive">{Math.abs(item.diffPct).toFixed(2)}%p</strong> 낮음
                            </>
                          ) : (
                            "가이드와 유사"
                          )}
                        </small>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="control-card wide-card">
          <h3>종목 카테고리</h3>
          <div className="chip-grid">
            {orderedPresetNames.map((presetName) => (
              <button
                key={presetName}
                className={presetName === activePresetName ? "chip-button active-filter" : "chip-button"}
                onClick={() => applyPreset(presetName)}
              >
                {presetName}
              </button>
            ))}
            <button className="chip-button ghost" onClick={() => setSelectedCodes([])}>
              전체 해제
            </button>
          </div>
        </div>

        <div className="selection-toolbar spaced-toolbar">
          <label className="search-input">
            <span>종목 검색</span>
            <input
              type="text"
              placeholder="종목명 또는 코드"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
          <button
            className={selectedOnly ? "chip-button active-filter" : "chip-button ghost"}
            onClick={() => setSelectedOnly((current) => !current)}
          >
            {selectedOnly ? "전체 보기" : "선택 종목만 보기"}
          </button>
          <div className="selection-summary">
            <strong>{formatNumber(selectedCodes.length)}</strong>
            <span>개 선택됨</span>
          </div>
        </div>

        {selectedChipCollapsed ? (
          <div className="collapsed-selection-note">
            {activePresetName} 선택 중입니다. 전체 시장 선택일 때는 긴 종목 리스트를 상단에 따로 띄우지 않습니다.
          </div>
        ) : selectedStocks.length > 0 ? (
          <div className="selected-strip refined-strip">
            {selectedStocks.map((stock) => (
              <button
                key={stock["종목코드"]}
                className="selected-pill"
                onClick={() => toggleCode(stock["종목코드"])}
              >
                {stock["종목명"]}
                <span>x</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-strip">선택된 종목이 없습니다. 위 프리셋이나 검색으로 추가해 주세요.</div>
        )}

        <div className="picker-meta">
          <span>{formatNumber(filteredStocks.length)}개 검색됨</span>
          {hiddenPickerCount > 0 ? <span>화면에는 상위 {formatNumber(visiblePickerLimit)}개만 표시</span> : null}
        </div>

        <div className="stock-picker soft-picker">
          {visiblePickerStocks.map((stock) => {
            const active = selectedCodes.includes(stock["종목코드"]);
            return (
              <button
                key={stock["종목코드"]}
                className={active ? "stock-chip active" : "stock-chip"}
                onClick={() => toggleCode(stock["종목코드"])}
              >
                <span>{stock["종목명"]}</span>
                <small>
                  {stock["시장"]} · {stock["시장시총순위"] ? `${stock["시장시총순위"]}위` : "순위 없음"}
                </small>
              </button>
            );
          })}
        </div>
        </>
        ) : null}
      </section>

      {workspaceMode === "rebalance" ? (
      <section className="panel portfolio-panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Target Portfolio</p>
            <h2>국내주식 추천 포트폴리오</h2>
          </div>
          <p className="section-note">현재 설정된 종목 카테고리, 투자 성향, 자산배분 비율, 환율 기준으로 산출한 국내주식 추천 포트폴리오입니다.</p>
        </div>

        <div className="asset-budget-strip single-budget-strip">
          <div className="summary-chip compact metric-positive">
            <span>총 평가금액 {formatCurrency(allocationBaseAmount)} 중 국내주식 배정</span>
            <strong>{formatCurrency(domesticStockBudget)}</strong>
          </div>
        </div>
        <p className="domestic-allocation-note">아래부터는 국내주식 배분 기준으로 산출한 추천 포트폴리오입니다.</p>

        <div className="portfolio-layout">
          <article className="portfolio-pie-card" ref={portfolioPieRef}>
            <div className="donut-wrap">
                <div className="donut-ring large" style={buildDonutStyle(portfolioChartSegments)}>
                <div className="donut-center">
                  <strong>TOP {visiblePortfolio.length}</strong>
                  <span>{formatCurrency(domesticStockBudget)}</span>
                </div>
              </div>
            </div>
            <div className="donut-legend">
              {visiblePortfolio.map((item, index) => (
                <div className="legend-row" key={item.code}>
                  <span
                    className="legend-dot"
                    style={{ backgroundColor: portfolioChartSegments[index]?.color ?? "#3182f6" }}
                  />
                  <strong>{item.name}</strong>
                  <span>{item.weightPct}%</span>
                </div>
              ))}
            </div>
          </article>

          <div className="portfolio-list" style={portfolioListHeight ? { height: portfolioListHeight } : undefined}>
            {visiblePortfolio.map((item) => {
              const targetShares = item.currentPrice > 0 ? Math.round(item.targetAmount / item.currentPrice) : 0;
              const avgGrowth = ((item.operatingGrowth + item.netGrowth) / 2) * 100;
              const perValues = [item.operatingPer, item.netPer].filter((value) => value > 0);
              const avgPer = perValues.length > 0 ? perValues.reduce((sum, value) => sum + value, 0) / perValues.length : 0;
              return (
                <article key={item.code} className="portfolio-row-card slim">
                  <div className="portfolio-row-head">
                    <div>
                      <div className="portfolio-title-line">
                        <strong>{item.name}</strong>
                        <div className="portfolio-head-factors">
                          <span className="factor-chip growth-chip">
                            <em>성장률</em>
                            <strong>{formatScore(avgGrowth)}%</strong>
                          </span>
                          <span className="factor-chip value-chip">
                            <em>PER</em>
                            <strong>{avgPer ? avgPer.toFixed(2) : "-"}</strong>
                          </span>
                          <span className="factor-chip roe-chip">
                            <em>ROE</em>
                            <strong>{item.roe ? `${item.roe.toFixed(1)}%` : "-"}</strong>
                          </span>
                          <span className="factor-chip neutral-chip">
                            <em>총 점수</em>
                            <strong>{formatScore(item.score100)}</strong>
                          </span>
                        </div>
                      </div>
                      <p>{item.style}</p>
                    </div>
                  </div>
                  <div className="portfolio-row-metrics compact">
                    <div>
                      <span>비중</span>
                      <strong>{item.weightPct}%</strong>
                    </div>
                    <div>
                      <span>현재 주가</span>
                      <strong>{item.currentPrice > 0 ? formatCurrency(item.currentPrice) : "-"}</strong>
                    </div>
                    <div>
                      <span>목표 금액</span>
                      <strong>{formatCurrency(item.targetAmount)}</strong>
                    </div>
                    <div>
                      <span>목표 주수</span>
                      <strong>{targetShares > 0 ? `${formatNumber(targetShares)}주` : "-"}</strong>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="portfolio-insights section-divider-top">
          <article className="insight-card factor-map-card" ref={factorMapRef}>
            <div className="insight-head">
              <h3>종목 성향 한눈에 보기</h3>
              <p>성장 점수와 가치 점수를 기준으로 종목 성향을 나누고, ROE는 최종 점수에 반영합니다.</p>
            </div>
            {selectedChipCollapsed ? (
              <div className="collapsed-selection-note">
                전체 시장 선택 상태에서는 종목 수가 너무 많아 맵을 숨깁니다. 개별 종목이나 Top 프리셋에서 확인해 주세요.
              </div>
            ) : (
              <div className="quadrant-scroll">
                <div className="quadrant-grid compact-quadrants">
                  <article className="quadrant-card">
                    <h3>성장·저평가 동시 충족</h3>
                    <div className="quadrant-chips">
                      {factorQuadrants.highHigh.map((item) => (
                        <span key={item["종목코드"]}>{item["종목명"]}</span>
                      ))}
                    </div>
                  </article>
                  <article className="quadrant-card">
                    <h3>성장형</h3>
                    <div className="quadrant-chips">
                      {factorQuadrants.growth.map((item) => (
                        <span key={item["종목코드"]}>{item["종목명"]}</span>
                      ))}
                    </div>
                  </article>
                  <article className="quadrant-card">
                    <h3>가치형</h3>
                    <div className="quadrant-chips">
                      {factorQuadrants.value.map((item) => (
                        <span key={item["종목코드"]}>{item["종목명"]}</span>
                      ))}
                    </div>
                  </article>
                  <article className="quadrant-card">
                    <h3>균형 관찰형</h3>
                    <div className="quadrant-chips">
                      {factorQuadrants.neutral.map((item) => (
                        <span key={item["종목코드"]}>{item["종목명"]}</span>
                      ))}
                    </div>
                  </article>
                </div>
              </div>
            )}
          </article>

          <article
            className="insight-card scroll-panel"
            style={
              factorPanelHeight
                ? { height: factorPanelHeight, maxHeight: factorPanelHeight, minHeight: factorPanelHeight }
                : undefined
            }
          >
            <div className="insight-head">
              <h3>종목 점수 비교표</h3>
              <p>선택한 종목의 성장, 가치(PER), ROE 점수를 같은 높이 안에서 비교합니다.</p>
            </div>
            {selectedChipCollapsed ? (
              <div className="collapsed-selection-note">전체 시장 선택 상태에서는 히트맵을 숨깁니다.</div>
            ) : (
              <div className="mini-heatmap">
                {selectedFactorRows.map((item) => (
                  <div className="heatmap-row" key={item["종목코드"]}>
                    <strong>{item["종목명"]}</strong>
                    <div className="heat-cells">
                      <span
                        className="heat-cell growth"
                        style={{ opacity: item["성장점수"] >= 0.6 ? 0.96 : 0.38 }}
                      >
                        성장 {formatScore(item["성장점수"] * 100)}
                      </span>
                      <span
                        className="heat-cell value"
                        style={{ opacity: item["저평가점수"] >= 0.6 ? 0.96 : 0.38 }}
                      >
                        가치 {formatScore(item["저평가점수"] * 100)}
                      </span>
                      <span
                        className="heat-cell roe"
                        style={{ opacity: Number(item["ROE점수"] ?? 0) >= 0.6 ? 0.96 : 0.38 }}
                      >
                        ROE {formatScore(Number(item["ROE점수"] ?? 0) * 100)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>
      ) : null}

      <section className="panel rebalance-panel">
          <div className="section-head compact-head">
            <div>
              <p className="section-kicker">Rebalancing</p>
              <h2>{workspaceMode === "update" ? "내 포트 관리하기" : "추천 포트폴리오 보기"}</h2>
            </div>
            <p className="section-note">
              {workspaceMode === "update"
                ? "저장된 포트폴리오를 먼저 확인하고, 거래내역을 반영한 뒤 변경 내용을 확정합니다."
                : "저장된 보유 자산과 보유 현금을 기준으로 리밸런싱 재원과 실행 순서를 계산합니다."}
            </p>
          </div>

          {workspaceMode === "update" ? (
            <div className="update-balance-card">
              <div className="section-head compact-head balance-head">
                <div>
                  <p className="section-kicker">Balance</p>
                  <h3>{baselineProfile?.name ? `${baselineProfile.name} 보유 포트폴리오` : "현재 보유 포트폴리오"}</h3>
                </div>
                <p className="section-note">증권사 잔고처럼 현재 보유 상태와 수익 현황을 먼저 확인한 뒤, 아래에서 거래를 추가하세요.</p>
              </div>
              <div className="balance-summary-grid wide-balance-grid">
                <div className="summary-chip">
                  <span>총매입액</span>
                  <strong>{formatCurrency(baselineSummary.purchaseTotal)}</strong>
                </div>
                <div className="summary-chip">
                  <span>총평가액</span>
                  <strong>{formatCurrency(baselineSummary.value)}</strong>
                </div>
                <div className={`summary-chip ${baselineSummary.profit >= 0 ? "metric-positive" : "metric-negative"}`}>
                  <span>총평가손익</span>
                  <strong>{formatCurrency(baselineSummary.profit)}</strong>
                </div>
                <div className={`summary-chip ${baselineSummary.returnPct >= 0 ? "metric-positive" : "metric-negative"}`}>
                  <span>총수익률</span>
                  <strong>{formatPercent(baselineSummary.returnPct)}</strong>
                </div>
                <div className={`summary-chip ${(baselineProfile?.realizedProfit ?? 0) >= 0 ? "metric-positive" : "metric-negative"}`}>
                  <span>총 실현 손익</span>
                  <strong>{formatCurrency(Number(baselineProfile?.realizedProfit ?? 0))}</strong>
                </div>
                <div className="summary-chip">
                  <span>총 현금 보유량</span>
                  <strong>{formatCurrency(baselineSummary.cash)}</strong>
                </div>
              </div>
              <div className="portfolio-insights balance-chart-grid">
                <article className="insight-card balance-chart-card">
                  <div className="balance-chart-head">
                    <div>
                      <strong>종목별 현재 비중</strong>
                      <small>현재 잔고 기준으로 각 자산을 그대로 나눠 봅니다.</small>
                    </div>
                  </div>
                  <div className="comparison-body balance-chart-body">
                    <div className="comparison-block">
                      <div className="donut-wrap">
                        <div className="donut-ring large" style={buildDonutStyle(baselinePortfolioSegments)}>
                          <div className="donut-center">
                            <strong>{formatNumber(baselinePortfolioSegments.length)}</strong>
                            <span>현재 자산</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="comparison-legend">
                      {baselinePortfolioLegend.map((item) => (
                        <div className="legend-row" key={`balance-asset-${item.label}`}>
                          <span className="legend-dot" style={{ backgroundColor: item.color }} />
                          <strong>{item.label}</strong>
                          <span>{formatPercent(item.pct)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
                <article className="insight-card balance-chart-card">
                  <div className="balance-chart-head">
                    <div>
                      <strong>4개 자산군 비중</strong>
                      <small>현금/예적금/채권, 금, 가상자산, 주식 기준으로 다시 묶어 봅니다.</small>
                    </div>
                  </div>
                  <div className="comparison-body balance-chart-body">
                    <div className="comparison-block">
                      <div className="donut-wrap">
                        <div className="donut-ring large" style={buildDonutStyle(baselineSectorSegments)}>
                          <div className="donut-center">
                            <strong>{formatNumber(baselineSectorSegments.length)}</strong>
                            <span>자산군</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="comparison-legend">
                      {baselineSectorLegend.map((item) => (
                        <div className="legend-row" key={`balance-sector-${item.label}`}>
                          <span className="legend-dot" style={{ backgroundColor: item.color }} />
                          <strong>{item.label}</strong>
                          <span>{formatPercent(item.pct)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              </div>
              <div className="portfolio-holdings-table">
                <div className="portfolio-table-head">
                  <span>종목</span>
                  <span>보유 수량</span>
                  <span>평가금액</span>
                  <span>비중</span>
                  <span>평균 매입 단가</span>
                  <span>현재가</span>
                  <span>수익률</span>
                  <span>평가손익</span>
                </div>
                <div className="portfolio-table-body">
                  {baselineHoldingRows.map((item) => (
                    <div className="portfolio-table-row" key={`balance-${item.code}`}>
                      <strong>{item.name}</strong>
                      <span>{formatTradeQuantity(item.code, item.shares)}{item.unitLabel}</span>
                      <span>{formatCurrency(item.value)}</span>
                      <span>{formatPercent(item.weightPct)}</span>
                      <span>{formatCurrency(item.avgBuyPrice)}</span>
                      <span>{formatCurrency(item.price)}</span>
                      <span className={item.returnPct >= 0 ? "metric-positive" : "metric-negative"}>{formatPercent(item.returnPct)}</span>
                      <span className={item.profit >= 0 ? "metric-positive" : "metric-negative"}>{formatCurrency(item.profit)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {assetGap < 0 ? (
            <div className="warning-banner">
              현재 반영 자산보다 매입총액이 더 큽니다. 추가 현금 납입을 늘리거나 보유 수량·매입 단가를 다시 확인해 주세요.
            </div>
          ) : null}

          {workspaceMode === "rebalance" ? (
          <div className="action-overview">
            {[
              { label: "신규 편입", count: rebalanceGroups.newBuys.length, colorClass: "buy" },
              { label: "비중 확대", count: rebalanceGroups.addMore.length, colorClass: "add" },
              { label: "비중 축소", count: rebalanceGroups.trim.length, colorClass: "trim" },
              { label: "전량 매도", count: rebalanceGroups.exit.length, colorClass: "exit" }
            ].map((item) => (
              <article className={`action-card ${item.colorClass}`} key={item.label}>
                <span>{item.label}</span>
                <strong>{item.count}</strong>
                <p>{getActionDescription(item.label as RebalanceRow["action"])}</p>
              </article>
            ))}
          </div>
          ) : null}

          <div className={workspaceMode === "update" ? "rebalance-columns single-mode" : "rebalance-columns"}>
            <div className={workspaceMode === "update" ? "holding-card holding-card-update" : "holding-card"}>
              {workspaceMode === "update" ? (
                <>
                  <div className="holding-card-head">
                    <h3>거래내역</h3>
                    <p>보유 포트폴리오를 먼저 확인하고, 아래에서 매수·매도 거래를 입력한 뒤 변경 전후를 비교해 확정하세요.</p>
                  </div>

                  <div className="holding-search-box">
                    <label className="search-input">
                      <span>거래 종목 검색</span>
                      <input
                        type="text"
                        placeholder="종목명 또는 코드로 검색"
                        value={holdingSearchTerm}
                        onChange={(event) => setHoldingSearchTerm(event.target.value)}
                      />
                    </label>
                    <div className="stock-picker trade-card-picker">
                    {tradePickerCandidates.map((stock) => (
                      <button
                        key={`trade-${stock.code}`}
                        className={selectedTradeCode === stock.code ? "stock-chip active" : "stock-chip"}
                        onClick={() => setSelectedTradeCode(stock.code)}
                        >
                          <span>{stock.name}</span>
                          <small>
                            {stock.market} · 현재가 {formatCandidatePrice(stock, stock.nativePrice ?? stock.price)}
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedTradeStock ? (
                    <div className="trade-editor-card">
                      <div className="trade-editor-head">
                        <div>
                          <strong>{selectedTradeStock.name}</strong>
                          <small>
                            {selectedTradeStock.market} · 현재가 {formatCandidatePrice(selectedTradeStock, Number(selectedTradeStock.nativePrice ?? selectedTradeStock.price ?? 0))}
                          </small>
                        </div>
                      </div>
                      <div className="trade-amount-presets">
                        <div className="trade-preset-group">
                          <span>빠른 수량 선택</span>
                          <div className="trade-amount-preset-list">
                            <button
                              type="button"
                              className="asset-quick-add"
                              onClick={() => {
                                const currentShares = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.price ?? 0),
                                }).shares;
                                updateTradeDraft(selectedTradeStock.code, { shares: currentShares + selectedTradeStock.quantityStep * 5 });
                              }}
                            >
                              +5
                            </button>
                            <button
                              type="button"
                              className="asset-quick-add"
                              onClick={() => {
                                const currentShares = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.price ?? 0),
                                }).shares;
                                updateTradeDraft(selectedTradeStock.code, { shares: currentShares + selectedTradeStock.quantityStep * 10 });
                              }}
                            >
                              +10
                            </button>
                            <button
                              type="button"
                              className="asset-quick-add"
                              onClick={() => {
                                const currentShares = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.price ?? 0),
                                }).shares;
                                updateTradeDraft(selectedTradeStock.code, {
                                  shares: currentShares > selectedTradeStock.quantityStep
                                    ? roundToPrecision(currentShares / 2, selectedTradeStock.quantityPrecision)
                                    : currentShares,
                                });
                              }}
                            >
                              1/2
                            </button>
                          </div>
                        </div>
                        <div className="trade-preset-group">
                          <span>빠른 단가 조정</span>
                          <div className="price-adjust-groups">
                            {([-1, 1] as const).map((direction) => (
                              <div
                                key={`${selectedTradeStock.code}-direction-${direction}`}
                                className={direction < 0 ? "price-adjust-group negative-adjust" : "price-adjust-group positive-adjust"}
                              >
                                <small>{direction < 0 ? "단가 내리기" : "단가 올리기"}</small>
                                <div className="trade-amount-preset-list trade-amount-preset-grid">
                                  {[5, 10, 50].map((multiplier) => {
                                    const basePrice =
                                      (tradeDrafts[selectedTradeStock.code] ?? {
                                        shares: 0,
                                        price: Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0),
                                      }).price || Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0);
                                    const steppedPrice = selectedTradeStock.priceInputMode === "usd"
                                      ? stepPriceByDelta(basePrice, multiplier === 50 ? 1 : multiplier === 10 ? 0.5 : 0.1, direction, 2)
                                      : stepPriceByTicks(basePrice, multiplier, direction);
                                    const delta = Math.abs(steppedPrice - basePrice);
                                    return (
                                      <button
                                        key={`${selectedTradeStock.code}-tick-${direction}-${multiplier}`}
                                        type="button"
                                        className={direction < 0 ? "asset-quick-add minus-quick-add" : "asset-quick-add plus-quick-add"}
                                        onClick={() => {
                                          updateTradeDraft(selectedTradeStock.code, {
                                            price: steppedPrice,
                                          });
                                        }}
                                      >
                                        {direction > 0 ? "+" : "-"}
                                        {selectedTradeStock.priceInputMode === "usd" ? `${delta.toFixed(2)}달러` : `${formatNumber(delta)}원`}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="trade-editor-grid">
                        <label className="search-input">
                          <span>거래 수량</span>
                          <div className="stepper-input">
                            <button
                              type="button"
                              className="stepper-button"
                              onClick={() => {
                                const currentShares = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.price ?? 0),
                                }).shares;
                                updateTradeDraft(selectedTradeStock.code, {
                                  shares: Math.max(0, currentShares - selectedTradeStock.quantityStep),
                                });
                              }}
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min="0"
                              step={String(selectedTradeStock.quantityStep)}
                              value={(tradeDrafts[selectedTradeStock.code] ?? {
                                shares: 0,
                                price: Number(selectedTradeStock.price ?? 0),
                              }).shares > 0
                                ? String((tradeDrafts[selectedTradeStock.code] ?? {
                                    shares: 0,
                                    price: Number(selectedTradeStock.price ?? 0),
                                  }).shares)
                                : ""}
                              onChange={(event) => {
                                if (event.target.value === "") {
                                  updateTradeDraft(selectedTradeStock.code, { shares: 0 });
                                  return;
                                }
                                const value = Number(event.target.value);
                                updateTradeDraft(selectedTradeStock.code, {
                                  shares: Number.isFinite(value) && value > 0 ? value : 0,
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="stepper-button"
                              onClick={() => {
                                const currentShares = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.price ?? 0),
                                }).shares;
                                updateTradeDraft(selectedTradeStock.code, {
                                  shares: currentShares + selectedTradeStock.quantityStep,
                                });
                              }}
                            >
                              +
                            </button>
                          </div>
                        </label>
                        <label className="search-input">
                          <span>{selectedTradeStock.priceInputMode === "usd" ? "달러 기준 단가" : "단가"}</span>
                          <div className="stepper-input">
                            <button
                              type="button"
                              className="stepper-button"
                              onClick={() => {
                                const currentPrice = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0),
                                }).price;
                                updateTradeDraft(selectedTradeStock.code, {
                                  price: selectedTradeStock.priceInputMode === "usd"
                                    ? stepPriceByDelta(currentPrice || Number(selectedTradeStock.nativePrice ?? 0), 0.01, -1, 2)
                                    : stepPriceByTicks(currentPrice || Number(selectedTradeStock.price ?? 0), 1, -1),
                                });
                              }}
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min="0"
                              step={getPriceInputStep(selectedTradeStock.code)}
                              value={(tradeDrafts[selectedTradeStock.code] ?? {
                                shares: 0,
                                price: Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0),
                              }).price > 0
                                ? String((tradeDrafts[selectedTradeStock.code] ?? {
                                    shares: 0,
                                    price: Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0),
                                  }).price)
                                : ""}
                              onChange={(event) => {
                                if (event.target.value === "") {
                                  updateTradeDraft(selectedTradeStock.code, { price: 0 });
                                  return;
                                }
                                const value = Number(event.target.value);
                                updateTradeDraft(selectedTradeStock.code, {
                                  price: Number.isFinite(value) && value > 0 ? value : 0,
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="stepper-button"
                              onClick={() => {
                                const currentPrice = (tradeDrafts[selectedTradeStock.code] ?? {
                                  shares: 0,
                                  price: Number(selectedTradeStock.priceInputMode === "usd" ? selectedTradeStock.nativePrice ?? 0 : selectedTradeStock.price ?? 0),
                                }).price;
                                updateTradeDraft(selectedTradeStock.code, {
                                  price: selectedTradeStock.priceInputMode === "usd"
                                    ? stepPriceByDelta(currentPrice || Number(selectedTradeStock.nativePrice ?? 0), 0.01, 1, 2)
                                    : stepPriceByTicks(currentPrice || Number(selectedTradeStock.price ?? 0), 1, 1),
                                });
                              }}
                            >
                              +
                            </button>
                          </div>
                        </label>
                        <div className="trade-editor-actions">
                          <button
                            className="chip-button trade-buy-button"
                            onClick={() => queueTrade(selectedTradeStock.code, "매수")}
                          >
                            매수 담기
                          </button>
                          <button
                            className="chip-button trade-sell-button"
                            onClick={() => queueTrade(selectedTradeStock.code, "매도")}
                          >
                            매도 담기
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="cash-adjust-card rebalance-cash-panel">
                    <div className="cash-adjust-head">
                      <div>
                        <strong>추가 현금 납입</strong>
                        <p>현금을 추가하거나 빼서 현재 포트폴리오 변경과 함께 반영합니다.</p>
                      </div>
                      <span className={pendingCashAdjustment >= 0 ? "active-profile-badge" : "active-profile-badge negative-badge"}>
                        {pendingCashAdjustment > 0 ? "+" : ""}
                        {formatCurrency(pendingCashAdjustment)}
                      </span>
                    </div>
                    <div className="cash-adjust-tabs">
                      {(["입금", "출금"] as const).map((type) => (
                        <button
                          key={`update-cash-${type}`}
                          type="button"
                          className={cashAdjustmentType === type ? "profile-button active" : "profile-button"}
                          onClick={() => setCashAdjustmentType(type)}
                        >
                          {type === "입금" ? "현금 추가" : "현금 인출"}
                        </button>
                      ))}
                    </div>
                    <div className="trade-amount-preset-list">
                      {cashAdjustmentQuickAdds.map((amount) => (
                        <button
                          key={`update-cash-${amount}`}
                          type="button"
                          className="asset-quick-add"
                          onClick={() => setCashAdjustmentDraft((current) => Math.max(0, current + amount))}
                        >
                          +{amount / 10_000}만
                        </button>
                      ))}
                      <button type="button" className="asset-quick-add" onClick={() => setCashAdjustmentDraft(0)}>
                        초기화
                      </button>
                    </div>
                    <div className="cash-adjust-form">
                      <label className="search-input">
                        <span>{cashAdjustmentType === "입금" ? "추가할 현금" : "뺄 현금"}</span>
                        <div className="stepper-input">
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() => setCashAdjustmentDraft((current) => Math.max(0, current - 100_000))}
                          >
                            -
                          </button>
                          <input
                            type="number"
                            min="0"
                            step="100000"
                            value={cashAdjustmentDraft > 0 ? String(cashAdjustmentDraft) : ""}
                            onChange={(event) => {
                              if (event.target.value === "") {
                                setCashAdjustmentDraft(0);
                                return;
                              }
                              const value = Number(event.target.value);
                              setCashAdjustmentDraft(Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
                            }}
                          />
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() => setCashAdjustmentDraft((current) => current + 100_000)}
                          >
                            +
                          </button>
                        </div>
                      </label>
                      <button type="button" className="chip-button active-filter" onClick={queueCashAdjustment}>
                        장바구니에 담기
                      </button>
                    </div>
                  </div>

                  <div className="cart-list-head">
                    <h4>거래 장바구니</h4>
                    <span>{formatNumber(pendingTrades.length + (pendingCashAdjustment !== 0 ? 1 : 0))}건</span>
                  </div>
                  <div className="rebalance-list paired-list paired-scroll cart-list">
                    {pendingCashAdjustment !== 0 ? (
                      <div className="cart-row paired-card cash-cart-row">
                        <div className="holding-name-cell cart-name-cell">
                          <strong>현금 변동</strong>
                          <small>{pendingCashAdjustment > 0 ? "추가 현금 납입" : "현금 인출"}</small>
                        </div>
                        <div className="summary-chip compact cart-chip">
                          <span>변동 금액</span>
                          <strong>
                            {pendingCashAdjustment > 0 ? "+" : ""}
                            {formatCurrency(pendingCashAdjustment)}
                          </strong>
                        </div>
                        <div className="summary-chip compact cart-chip">
                          <span>반영 후 총 원금</span>
                          <strong>{formatCurrency(effectiveTotalAsset)}</strong>
                        </div>
                        <div className="summary-chip compact cart-chip cart-total-chip">
                          <span>조정</span>
                          <div className="cart-total-actions">
                            <strong>{pendingCashAdjustment > 0 ? "현금 추가" : "현금 인출"}</strong>
                            <button className="remove-row-button" onClick={() => setPendingCashAdjustment(0)}>
                              제거
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {pendingTrades.length > 0 ? (
                      pendingTrades.map((trade) => (
                        <div
                          className={`cart-row paired-card ${trade.side === "매수" ? "cart-row-buy" : "cart-row-sell"}`}
                          key={trade.id}
                        >
                          <div className="holding-name-cell cart-name-cell">
                            <strong>{trade.name}</strong>
                            <small className={trade.side === "매수" ? "cart-side-buy" : "cart-side-sell"}>
                              {trade.side} 장바구니
                            </small>
                          </div>
                          <div className="summary-chip compact cart-chip">
                            <span>거래 수량</span>
                            <div className="stepper-input compact-stepper">
                              <button
                                type="button"
                                className="stepper-button"
                                onClick={() =>
                                  updatePendingTrade(trade.id, {
                                    shares: Math.max(0, trade.shares - (getAssetCandidate(trade.code)?.quantityStep ?? 1)),
                                  })
                                }
                              >
                                -
                              </button>
                              <input
                                type="number"
                                min="0"
                                step={String(getAssetCandidate(trade.code)?.quantityStep ?? 1)}
                                value={trade.shares > 0 ? String(trade.shares) : ""}
                                onChange={(event) => {
                                  if (event.target.value === "") {
                                    updatePendingTrade(trade.id, { shares: 0 });
                                    return;
                                  }
                                  const value = Number(event.target.value);
                                  updatePendingTrade(trade.id, { shares: Number.isFinite(value) && value > 0 ? value : 0 });
                                }}
                              />
                              <button
                                type="button"
                                className="stepper-button"
                                onClick={() =>
                                  updatePendingTrade(trade.id, {
                                    shares: trade.shares + (getAssetCandidate(trade.code)?.quantityStep ?? 1),
                                  })
                                }
                              >
                                +
                              </button>
                            </div>
                          </div>
                          <div className="summary-chip compact cart-chip">
                            <span>{trade.side === "매도" ? "매도 단가" : "매입 단가"}</span>
                            <div className="stepper-input compact-stepper">
                              <button
                                type="button"
                                className="stepper-button"
                                onClick={() => {
                                  const candidate = getAssetCandidate(trade.code);
                                  updatePendingTrade(trade.id, {
                                    price: candidate?.priceInputMode === "usd"
                                      ? stepPriceByDelta(trade.price || Number(candidate?.nativePrice ?? 0), 0.01, -1, 2)
                                      : stepPriceByTicks(trade.price, 1, -1),
                                  });
                                }}
                              >
                                -
                              </button>
                              <input
                                type="number"
                                min="0"
                                step={getPriceInputStep(trade.code)}
                                value={trade.price > 0 ? String(trade.price) : ""}
                                onChange={(event) => {
                                  if (event.target.value === "") {
                                    updatePendingTrade(trade.id, { price: 0 });
                                    return;
                                  }
                                  const value = Number(event.target.value);
                                  updatePendingTrade(trade.id, {
                                    price: Number.isFinite(value) && value > 0 ? value : 0,
                                  });
                                }}
                              />
                              <button
                                type="button"
                                className="stepper-button"
                                onClick={() => {
                                  const candidate = getAssetCandidate(trade.code);
                                  updatePendingTrade(trade.id, {
                                    price: candidate?.priceInputMode === "usd"
                                      ? stepPriceByDelta(trade.price || Number(candidate?.nativePrice ?? 0), 0.01, 1, 2)
                                      : stepPriceByTicks(trade.price || 1, 1, 1),
                                  });
                                }}
                              >
                                +
                              </button>
                            </div>
                          </div>
                          <div className="summary-chip compact cart-chip cart-total-chip">
                            <span>예상 금액</span>
                            <div className="cart-total-actions">
                              <strong>{formatStoredTradeTotal(trade.code, trade.shares, trade.price, trade.settlementPrice)}</strong>
                              <button className="remove-row-button" onClick={() => removePendingTrade(trade.id)}>
                                제거
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : pendingCashAdjustment === 0 ? (
                      <div className="empty-strip">아직 추가된 거래내역이 없습니다. 위 검색 결과나 시가총액 상위 카드에서 매수·매도를 추가해 주세요.</div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <div className="holding-card-head">
                    <h3>현재 보유 포트폴리오</h3>
                  </div>
                  <div className="rebalance-list paired-list paired-scroll holding-readonly-list">
                    {sortedHoldings.length > 0 ? (
                      sortedHoldings.map((item) => {
                        const holdingValue = item.shares * item.price;
                        const profitAmount = holdingValue - item.purchaseTotal;
                        const profitRate = item.purchaseTotal > 0 ? (profitAmount / item.purchaseTotal) * 100 : 0;
                        return (
                          <div className="holding-row read-only paired-card" key={`readonly-${item.code}`}>
                            <div className="holding-name-cell">
                              <strong>{item.name}</strong>
                              <small>{item.code.replace("A", "")}</small>
                            </div>
                            <div className="summary-chip compact holding-metric-card">
                              <span>보유 수량</span>
                              <strong>{formatTradeQuantity(item.code, item.shares)}{item.unitLabel}</strong>
                            </div>
                            <div className="summary-chip compact holding-metric-card">
                              <span>평균 매입가</span>
                              <strong>{formatCurrency(item.avgBuyPrice)}</strong>
                            </div>
                            <div className="summary-chip compact holding-metric-card">
                              <span>현재가</span>
                              <strong>{item.price > 0 ? formatCurrency(item.price) : "-"}</strong>
                            </div>
                            <div className="holding-inline-meta">
                              <span className="holding-meta-stack">
                                <em>매입총액</em>
                                <strong>{formatCurrency(item.purchaseTotal)}</strong>
                              </span>
                              <span className={`holding-meta-stack ${profitAmount >= 0 ? "metric-positive" : "metric-negative"}`}>
                                <em>평가손익</em>
                                <strong>{formatCurrency(profitAmount)}</strong>
                              </span>
                              <span className="holding-meta-stack">
                                <em>평가총액</em>
                                <strong>{formatCurrency(holdingValue)}</strong>
                              </span>
                              <span className={`holding-meta-stack ${profitRate >= 0 ? "metric-positive" : "metric-negative"}`}>
                                <em>수익률</em>
                                <strong>{formatPercent(profitRate)}</strong>
                              </span>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="empty-strip">저장된 보유 포트폴리오가 없습니다. 내 포트 관리하기 탭에서 먼저 거래내역을 등록해 주세요.</div>
                    )}
                  </div>
                </>
              )}
            </div>

            {workspaceMode === "rebalance" ? (
            <div className="execution-panel">
              <div className="execution-head">
                <h3>실행 순서</h3>
                <p>필요한 실행만 여러 개 골라 장바구니에 담고, 아래에서 수량과 매입 단가를 조정한 뒤 한 번에 반영할 수 있습니다.</p>
              </div>
              <div className="rebalance-list prominent paired-list paired-scroll">
                {orderedExecutionRows.map((item) => (
                  <article
                    className={
                      `${selectedRebalanceTradeCodes.has(item.code)
                        ? "rebalance-card strong-card paired-card selected-execution-card"
                        : "rebalance-card strong-card paired-card"} ${item.diffShares < 0 ? "sell-execution-card" : "buy-execution-card"}`
                    }
                    key={`${item.code}-${item.action}`}
                  >
                    <div className="rebalance-header">
                      <div className="rebalance-title-block">
                        <strong>{item.name}</strong>
                        <p>{item.action}</p>
                      </div>
                      <span className={item.diffShares < 0 ? "score-badge share-badge action-callout execution-share-badge" : "score-badge share-badge action-callout execution-share-badge negative"}>
                        {item.diffShares > 0 ? "+" : ""}
                        {formatTradeQuantity(item.code, item.diffShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}
                      </span>
                      <button
                        type="button"
                        className={selectedRebalanceTradeCodes.has(item.code) ? "chip-button active-filter" : "chip-button ghost"}
                        onClick={() => toggleRebalanceTrade(item)}
                      >
                        {selectedRebalanceTradeCodes.has(item.code) ? "선택 해제" : "실행 선택"}
                      </button>
                    </div>
                    <div className="weight-shift">
                      <div>
                        <span>현재 비중</span>
                        <strong>{item.currentWeightPct.toFixed(2)}%</strong>
                      </div>
                      <span className="weight-arrow">→</span>
                      <div>
                        <span>변경 후 비중</span>
                        <strong>{item.targetWeightPct.toFixed(2)}%</strong>
                      </div>
                    </div>
                    <dl>
                      <div>
                        <dt>현재</dt>
                        <dd>
                          {formatTradeQuantity(item.code, item.currentShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"} / {formatCurrency(item.currentAmount)}
                        </dd>
                      </div>
                      <div>
                        <dt>목표</dt>
                        <dd>
                          {formatTradeQuantity(item.code, item.targetShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"} / {formatCurrency(item.targetAmount)}
                        </dd>
                      </div>
                      <div>
                        <dt>현재가</dt>
                        <dd>{item.price > 0 ? `${formatCurrency(item.price)} / ${getAssetCandidate(item.code)?.unitLabel ?? "주"}` : "현재가 없음"}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </div>
            ) : null}
          </div>
          {canManagePortfolio && workspaceMode === "rebalance" ? (
            <>
            <div className="cash-adjust-card rebalance-cash-panel">
              <div className="cash-adjust-head">
                <div>
                  <strong>추가 현금 납입</strong>
                  <p>현금을 추가하거나 빼서 리밸런싱 결과에 함께 반영합니다.</p>
                </div>
                <span className={pendingCashAdjustment >= 0 ? "active-profile-badge" : "active-profile-badge negative-badge"}>
                  {pendingCashAdjustment > 0 ? "+" : ""}
                  {formatCurrency(pendingCashAdjustment)}
                </span>
              </div>
              <div className="cash-adjust-tabs">
                {(["입금", "출금"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={cashAdjustmentType === type ? "profile-button active" : "profile-button"}
                    onClick={() => setCashAdjustmentType(type)}
                  >
                    {type === "입금" ? "현금 추가" : "현금 인출"}
                  </button>
                ))}
              </div>
              <div className="trade-amount-preset-list">
                {cashAdjustmentQuickAdds.map((amount) => (
                  <button
                    key={`cash-${amount}`}
                    type="button"
                    className="asset-quick-add"
                    onClick={() => setCashAdjustmentDraft((current) => Math.max(0, current + amount))}
                  >
                    +{amount / 10_000}만
                  </button>
                ))}
                <button type="button" className="asset-quick-add" onClick={() => setCashAdjustmentDraft(0)}>
                  초기화
                </button>
              </div>
              <div className="cash-adjust-form">
                <label className="search-input">
                  <span>{cashAdjustmentType === "입금" ? "추가할 현금" : "뺄 현금"}</span>
                  <div className="stepper-input">
                    <button
                      type="button"
                      className="stepper-button"
                      onClick={() => setCashAdjustmentDraft((current) => Math.max(0, current - 100_000))}
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min="0"
                      step="100000"
                      value={cashAdjustmentDraft > 0 ? String(cashAdjustmentDraft) : ""}
                      onChange={(event) => {
                        if (event.target.value === "") {
                          setCashAdjustmentDraft(0);
                          return;
                        }
                        const value = Number(event.target.value);
                        setCashAdjustmentDraft(Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
                      }}
                    />
                    <button
                      type="button"
                      className="stepper-button"
                      onClick={() => setCashAdjustmentDraft((current) => current + 100_000)}
                    >
                      +
                    </button>
                  </div>
                </label>
                <button type="button" className="chip-button active-filter" onClick={queueCashAdjustment}>
                  장바구니에 담기
                </button>
              </div>
            </div>
            </>
          ) : null}
          {canManagePortfolio && workspaceMode === "rebalance" ? (
            <div className="rebalance-cart-panel">
              <div className="cart-list-head rebalance-cart-head">
                <h4>리밸런싱 장바구니</h4>
                <span>{formatNumber(rebalancePendingTrades.length + (pendingCashAdjustment !== 0 ? 1 : 0))}건</span>
              </div>
              <div className="rebalance-list paired-list paired-scroll cart-list rebalance-cart-list">
                {pendingCashAdjustment !== 0 ? (
                  <div className="cart-row paired-card cash-cart-row">
                    <div className="holding-name-cell cart-name-cell">
                      <strong>현금 변동</strong>
                      <small>{pendingCashAdjustment > 0 ? "추가 현금 납입" : "현금 인출"}</small>
                    </div>
                    <div className="summary-chip compact cart-chip">
                      <span>변동 금액</span>
                      <strong>
                        {pendingCashAdjustment > 0 ? "+" : ""}
                        {formatCurrency(pendingCashAdjustment)}
                      </strong>
                    </div>
                    <div className="summary-chip compact cart-chip">
                      <span>반영 후 총 원금</span>
                      <strong>{formatCurrency(effectiveTotalAsset)}</strong>
                    </div>
                    <div className="summary-chip compact cart-chip cart-total-chip">
                      <span>조정</span>
                      <div className="cart-total-actions">
                        <strong>{pendingCashAdjustment > 0 ? "현금 추가" : "현금 인출"}</strong>
                        <button className="remove-row-button" onClick={() => setPendingCashAdjustment(0)}>
                          제거
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {rebalancePendingTrades.length > 0 ? (
                  rebalancePendingTrades.map((trade) => (
                    <div
                      className={`cart-row paired-card ${trade.side === "매수" ? "cart-row-buy" : "cart-row-sell"}`}
                      key={trade.id}
                    >
                      <div className="holding-name-cell cart-name-cell">
                        <strong>{trade.name}</strong>
                        <small className={trade.side === "매수" ? "cart-side-buy" : "cart-side-sell"}>
                          {trade.side} 실행 선택
                        </small>
                      </div>
                      <div className="summary-chip compact cart-chip">
                        <span>거래 수량</span>
                        <div className="stepper-input compact-stepper">
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() =>
                              updateRebalancePendingTrade(trade.id, {
                                shares: Math.max(0, trade.shares - (getAssetCandidate(trade.code)?.quantityStep ?? 1)),
                              })
                            }
                          >
                            -
                          </button>
                          <input
                            type="number"
                            min="0"
                            step={String(getAssetCandidate(trade.code)?.quantityStep ?? 1)}
                            value={trade.shares > 0 ? String(trade.shares) : ""}
                            onChange={(event) => {
                              if (event.target.value === "") {
                                updateRebalancePendingTrade(trade.id, { shares: 0 });
                                return;
                              }
                              const value = Number(event.target.value);
                              updateRebalancePendingTrade(trade.id, { shares: Number.isFinite(value) && value > 0 ? value : 0 });
                            }}
                          />
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() =>
                              updateRebalancePendingTrade(trade.id, {
                                shares: trade.shares + (getAssetCandidate(trade.code)?.quantityStep ?? 1),
                              })
                            }
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="summary-chip compact cart-chip">
                        <span>{trade.side === "매도" ? "매도 단가" : "매입 단가"}</span>
                        <div className="stepper-input compact-stepper">
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() => {
                              const candidate = getAssetCandidate(trade.code);
                              updateRebalancePendingTrade(trade.id, {
                                price: candidate?.priceInputMode === "usd"
                                  ? stepPriceByDelta(trade.price || Number(candidate?.nativePrice ?? 0), 0.01, -1, 2)
                                  : stepPriceByTicks(trade.price, 1, -1),
                              });
                            }}
                          >
                            -
                          </button>
                          <input
                            type="number"
                            min="0"
                            step={getPriceInputStep(trade.code)}
                            value={trade.price > 0 ? String(trade.price) : ""}
                            onChange={(event) => {
                              if (event.target.value === "") {
                                updateRebalancePendingTrade(trade.id, { price: 0 });
                                return;
                              }
                              const value = Number(event.target.value);
                              updateRebalancePendingTrade(trade.id, {
                                price: Number.isFinite(value) && value > 0 ? value : 0,
                              });
                            }}
                          />
                          <button
                            type="button"
                            className="stepper-button"
                            onClick={() => {
                              const candidate = getAssetCandidate(trade.code);
                              updateRebalancePendingTrade(trade.id, {
                                price: candidate?.priceInputMode === "usd"
                                  ? stepPriceByDelta(trade.price || Number(candidate?.nativePrice ?? 0), 0.01, 1, 2)
                                  : stepPriceByTicks(trade.price || 1, 1, 1),
                              });
                            }}
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="summary-chip compact cart-chip cart-total-chip">
                        <span>예상 금액</span>
                        <div className="cart-total-actions">
                          <strong>{formatStoredTradeTotal(trade.code, trade.shares, trade.price, trade.settlementPrice)}</strong>
                          <button className="remove-row-button" onClick={() => removeRebalancePendingTrade(trade.id)}>
                            제거
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : pendingCashAdjustment === 0 ? (
                  <div className="empty-strip">아직 선택한 실행이나 현금 변동이 없습니다. 위 실행 순서 카드와 현금 조정 영역에서 장바구니에 담아 주세요.</div>
                ) : null}
              </div>
            </div>
          ) : null}
      </section>

      {workspaceMode === "update" ? (
      <section className="panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Update Compare</p>
            <h2>포트폴리오 업데이트</h2>
          </div>
          <p className="section-note">기존 포트폴리오 대비 변경된 내역을 확인하고 새로운 포트폴리오로 업데이트합니다.</p>
        </div>
        <div className="comparison-chart-grid wide-comparison-grid update-compare-grid">
          <article className="action-chart-card comparison-card">
            <div className="comparison-body">
              <div className="comparison-block">
                <span>기존 저장 포트폴리오</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(baselinePortfolioSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(baselineProfile?.holdings.length ?? 0)}</strong>
                      <span>기존 종목</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {baselinePortfolioLegend.map((item) => (
                  <div className="legend-row" key={`baseline-${item.label}`}>
                    <span className="legend-dot" style={{ backgroundColor: item.color }} />
                    <strong>{item.label}</strong>
                    <span>{formatPercent(item.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>
          <article className="action-chart-card comparison-card">
            <div className="comparison-body">
              <div className="comparison-block">
                <span>업데이트 예정 포트폴리오</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(currentPortfolioChartSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(normalizedHoldings.length)}</strong>
                      <span>업데이트 자산</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {currentPortfolioLegend.map((item) => (
                  <div className="legend-row" key={`current-${item.label}`}>
                    <span className="legend-dot" style={{ backgroundColor: item.color }} />
                    <strong>{item.label}</strong>
                    <span>{formatPercent(item.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>
        </div>
        <div className="update-diff-list">
          {updateCashComparison ? (
            <article className="rebalance-card strong-card diff-highlight-card cash-diff-card compare-change-row" key="update-cash-diff">
              <div className="holding-name-cell compare-name-cell">
                <strong>현금 변동</strong>
                <small>{updateCashComparison.diffAmount > 0 ? "추가 납입 예정" : "현금 인출 예정"}</small>
              </div>
              <div className="summary-chip compact">
                <span>기존 총 원금</span>
                <strong>{formatCurrency(updateCashComparison.beforeTotalAsset)}</strong>
              </div>
              <div className="summary-chip compact">
                <span>변경 후 총 원금</span>
                <strong>{formatCurrency(updateCashComparison.afterTotalAsset)}</strong>
              </div>
              <div className={`summary-chip compact compare-change-value ${updateCashComparison.diffAmount > 0 ? "positive" : "negative"}`}>
                <span>현금 변화</span>
                <strong>
                  {updateCashComparison.diffAmount > 0 ? "+" : ""}
                  {formatCurrency(updateCashComparison.diffAmount)}
                </strong>
              </div>
            </article>
          ) : null}
          {updateComparisonRows.length > 0 ? (
            updateComparisonRows.map((item) => (
              <article className="rebalance-card strong-card diff-highlight-card compare-change-row" key={`diff-${item.code}`}>
                <div className="holding-name-cell compare-name-cell">
                  <strong>{item.name}</strong>
                  <small>{item.diffShares > 0 ? "보유 확대 예정" : "보유 축소 예정"}</small>
                </div>
                <div className="summary-chip compact">
                  <span>기존 수량</span>
                  <strong>{formatTradeQuantity(item.code, item.beforeShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}</strong>
                </div>
                <div className="summary-chip compact">
                  <span>변경 후 수량</span>
                  <strong>{formatTradeQuantity(item.code, item.afterShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}</strong>
                </div>
                <div className={`summary-chip compact compare-change-value ${item.diffShares > 0 ? "positive" : "negative"}`}>
                  <span>수량 변화</span>
                  <strong>{item.diffShares > 0 ? "+" : ""}{formatTradeQuantity(item.code, item.diffShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}</strong>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-strip">아직 기존 포트폴리오 대비 변경된 내용이 없습니다.</div>
          )}
        </div>
        {confirmMessage ? <div className="success-banner">{confirmMessage}</div> : null}
        <div className="confirm-update-bar">
          <button className="chip-button active-filter" onClick={confirmPortfolioUpdate}>
            이 상태를 현재 포트폴리오로 확정
          </button>
        </div>
      </section>
      ) : null}

      {canManagePortfolio && workspaceMode === "rebalance" ? (
      <section className="panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Portfolio Compare</p>
            <h2>리밸런싱 전후 포트폴리오</h2>
          </div>
          <p className="section-note">기존 포트폴리오 대비 변경된 내역을 확인하고 새로운 포트폴리오로 업데이트합니다.</p>
        </div>
        <div className="comparison-chart-grid wide-comparison-grid">
          <article className="action-chart-card comparison-card">
            <div className="comparison-body">
              <div className="comparison-block">
                <span>반영 전 포트폴리오</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(rebalanceBeforeSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(rebalanceBeforeCount)}</strong>
                      <span>보유 자산</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {rebalanceBeforeLegend.map((item) => (
                  <div className="legend-row" key={`before-${item.label}`}>
                    <span className="legend-dot" style={{ backgroundColor: item.color }} />
                    <strong>{item.label}</strong>
                    <span>{formatPercent(item.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>
          <article className="action-chart-card comparison-card">
            <div className="comparison-body">
              <div className="comparison-block">
                <span>반영 후 포트폴리오</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(rebalanceAfterSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(rebalanceAfterCount)}</strong>
                      <span>반영 결과</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {rebalanceAfterLegend.map((item) => (
                  <div className="legend-row" key={`after-${item.label}`}>
                    <span className="legend-dot" style={{ backgroundColor: item.color }} />
                    <strong>{item.label}</strong>
                    <span>{formatPercent(item.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>
        </div>
        <div className="update-diff-list">
          {rebalanceCashComparison ? (
            <article className="rebalance-card strong-card diff-highlight-card cash-diff-card compare-change-row" key="rebalance-cash-diff">
              <div className="holding-name-cell compare-name-cell">
                <strong>현금 변동</strong>
                <small>{rebalanceCashComparison.diffAmount > 0 ? "추가 납입 예정" : "현금 인출 예정"}</small>
              </div>
              <div className="summary-chip compact">
                <span>기존 총 원금</span>
                <strong>{formatCurrency(rebalanceCashComparison.beforeTotalAsset)}</strong>
              </div>
              <div className="summary-chip compact">
                <span>변경 후 총 원금</span>
                <strong>{formatCurrency(rebalanceCashComparison.afterTotalAsset)}</strong>
              </div>
              <div className={`summary-chip compact compare-change-value ${rebalanceCashComparison.diffAmount > 0 ? "positive" : "negative"}`}>
                <span>현금 변화</span>
                <strong>
                  {rebalanceCashComparison.diffAmount > 0 ? "+" : ""}
                  {formatCurrency(rebalanceCashComparison.diffAmount)}
                </strong>
              </div>
            </article>
          ) : null}
          {rebalanceComparisonRows.length > 0 ? (
            rebalanceComparisonRows.map((item) => (
              <article className="rebalance-card strong-card diff-highlight-card compare-change-row" key={`rebalance-diff-${item.code}`}>
                <div className="holding-name-cell compare-name-cell">
                  <strong>{item.name}</strong>
                  <small>{item.diffShares > 0 ? "보유 확대 예정" : "보유 축소 예정"}</small>
                </div>
                <div className="summary-chip compact">
                  <span>기존 수량</span>
                  <strong>{formatTradeQuantity(item.code, item.beforeShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}</strong>
                </div>
                <div className="summary-chip compact">
                  <span>변경 후 수량</span>
                  <strong>{formatTradeQuantity(item.code, item.afterShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}</strong>
                </div>
                <div className={`summary-chip compact compare-change-value ${item.diffShares > 0 ? "positive" : "negative"}`}>
                  <span>수량 변화</span>
                  <strong>
                    {item.diffShares > 0 ? "+" : ""}
                    {formatTradeQuantity(item.code, item.diffShares)}{getAssetCandidate(item.code)?.unitLabel ?? "주"}
                  </strong>
                </div>
              </article>
            ))
          ) : rebalanceCashComparison ? null : (
            <div className="empty-strip">아직 기존 포트폴리오 대비 변경된 내용이 없습니다.</div>
          )}
        </div>
        {confirmMessage ? <div className="success-banner">{confirmMessage}</div> : null}
        <div className="confirm-update-bar">
          <button className="chip-button active-filter" onClick={persistRebalanceChanges}>
            이 상태를 현재 포트폴리오로 확정
          </button>
        </div>
      </section>
      ) : null}

      {workspaceMode === "rebalance" ? (
      <section className="panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Excluded</p>
            <h2>자동 제외 종목</h2>
          </div>
        </div>
        <div className="excluded-group-list">
          {groupedExcluded.length > 0 ? (
            groupedExcluded.map((group) => (
              <div className="excluded-group" key={group.reason}>
                <strong>{group.reason}</strong>
                <div className="excluded-list compact-excluded">
                  {group.names.map((name) => (
                    <span key={`${group.reason}-${name}`}>{name}</span>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p>제외된 종목이 없습니다.</p>
          )}
        </div>
      </section>
      ) : null}
    </main>
  );
}
