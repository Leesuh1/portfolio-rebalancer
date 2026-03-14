"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardData } from "@/lib/get-dashboard-data";

type Props = {
  data: DashboardData;
};

type HoldingRow = {
  code: string;
  shares: number;
  avgBuyPrice: number;
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

const profileLabels = ["안정형", "균형형", "공격형"] as const;
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
  균형형: { growth: 0.4, value: 0.4, roe: 0.2 },
  공격형: { growth: 0.6, value: 0.3, roe: 0.1 }
} as const;
const topN = 10;
const totalAssetMin = 10_000_000;
const totalAssetMax = 1_000_000_000;
const totalAssetStep = 5_000_000;
const visiblePickerLimit = 100;

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatScore(value: number) {
  return value.toFixed(1);
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function clampAsset(value: number) {
  return Math.min(totalAssetMax, Math.max(totalAssetMin, value));
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

function buildInitialHoldings(data: DashboardData): HoldingRow[] {
  const baseCodes = new Set(data.selectedGicodes ?? []);

  return data.allRankings
    .filter((item) => baseCodes.has(item["종목코드"]))
    .slice(0, 10)
    .map((item) => {
      const price = Number(item["현재가"] ?? 0);
      return {
        code: item["종목코드"],
        shares: 1,
        avgBuyPrice: price
      };
    });
}

function buildHoldingRowsFromCodes(data: DashboardData, codes: string[]): HoldingRow[] {
  const codeSet = new Set(codes);
  return data.allRankings
    .filter((item) => codeSet.has(item["종목코드"]))
    .slice(0, 10)
    .map((item) => ({
      code: item["종목코드"],
      shares: 1,
      avgBuyPrice: Number(item["현재가"] ?? 0),
    }));
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

export function DashboardApp({ data }: Props) {
  const stockUniverse = data.stockUniverse ?? [];
  const selectionPresets = data.selectionPresets ?? {};
  const defaultSelection = data.selectionPresets?.["기본 관심 종목"]?.length
    ? data.selectionPresets["기본 관심 종목"]
    : (data.selectedGicodes ?? []);
  const [selectedCodes, setSelectedCodes] = useState<string[]>(defaultSelection);
  const [profile, setProfile] = useState(data.profile);
  const [totalAsset, setTotalAsset] = useState<number>(data.investAmount || 20_000_000);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [holdings, setHoldings] = useState<HoldingRow[]>(() => buildInitialHoldings(data));
  const [holdingSearchTerm, setHoldingSearchTerm] = useState("");
  const portfolioPieRef = useRef<HTMLElement | null>(null);
  const factorMapRef = useRef<HTMLElement | null>(null);
  const [portfolioListHeight, setPortfolioListHeight] = useState<number | null>(null);
  const [factorPanelHeight, setFactorPanelHeight] = useState<number | null>(null);
  const activeWeights = profileWeights[profile as keyof typeof profileWeights] ?? profileWeights.균형형;

  const stockMap = useMemo(
    () => new Map(stockUniverse.map((item) => [item["종목코드"], item])),
    [stockUniverse]
  );

  const rankedMap = useMemo(
    () => new Map(data.allRankings.map((item) => [item["종목코드"], item])),
    [data.allRankings]
  );

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

        let style = "균형 관찰형";
        if (item["성장점수"] >= 0.6 && item["저평가점수"] >= 0.6) {
          style = "고성장 저평가";
        } else if (item["성장점수"] >= 0.6) {
          style = "성장형";
        } else if (item["저평가점수"] >= 0.6) {
          style = "가치형";
        }

        return {
          ...item,
          "종합점수_100": Number((combinedScore * 100).toFixed(2)),
          "투자스타일": style
        };
      })
      .sort((a, b) => b["종합점수_100"] - a["종합점수_100"])
      .map((item, index) => ({
        ...item,
        "랭킹": index + 1
      }));
  }, [activeWeights.growth, activeWeights.value, data.allRankings, selectedCodes]);

  const visiblePortfolio = useMemo<VisiblePortfolioRow[]>(() => {
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
        targetAmount: Math.round(weight * totalAsset),
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
  }, [recalculatedRankings, stockMap, totalAsset]);

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

  const normalizedHoldings = useMemo(
    () =>
      holdings
        .filter((item) => item.code)
        .map((item) => {
          const stock = stockMap.get(item.code);
          const fallbackPrice = Number(stock?.["현재가"] ?? rankedMap.get(item.code)?.["현재가"] ?? 0);
          return {
            code: item.code,
            name: stock?.["종목명"] ?? rankedMap.get(item.code)?.["종목명"] ?? item.code,
            shares: Math.max(0, Math.round(Number(item.shares) || 0)),
            price: fallbackPrice,
            avgBuyPrice: Math.max(0, Number(item.avgBuyPrice) || 0)
          };
        }),
    [holdings, rankedMap, stockMap]
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
    () => normalizedHoldings.reduce((sum, item) => sum + item.shares * item.avgBuyPrice, 0),
    [normalizedHoldings]
  );

  const derivedCash = Math.max(0, totalAsset - holdingsPurchaseTotal);
  const rebalanceBudget = holdingsValue + derivedCash;
  const assetGap = totalAsset - holdingsPurchaseTotal;

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
    const currentMap = new Map(
      normalizedHoldings.map((item) => [
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

    normalizedHoldings.forEach((item) => {
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

  const rebalanceSummary = useMemo(() => {
    const buyAmount = holdingSummary
      .filter((item) => item.diffAmount > 0)
      .reduce((sum, item) => sum + item.diffAmount, 0);
    const sellAmount = holdingSummary
      .filter((item) => item.diffAmount < 0)
      .reduce((sum, item) => sum + Math.abs(item.diffAmount), 0);
    const actionCount = holdingSummary.filter((item) => item.action !== "유지").length;
    const finalCash = derivedCash + sellAmount - buyAmount;

    return {
      currentAssetValue: holdingsValue,
      purchaseTotal: holdingsPurchaseTotal,
      rebalanceBudget,
      buyAmount,
      sellAmount,
      actionCount,
      finalCash
    };
  }, [derivedCash, holdingSummary, holdingsPurchaseTotal, holdingsValue, rebalanceBudget]);

  const portfolioChartSegments = useMemo(
    () =>
      visiblePortfolio.map((item, index) => ({
        label: item.name,
        value: item.weightPct,
        color: ["#3182f6", "#4f95f8", "#69a6fb", "#84b6fc", "#9dc5fd", "#b4d3fe", "#c7defe", "#d8e8ff", "#e6f1ff", "#f0f7ff"][index]
      })),
    [visiblePortfolio]
  );

  const currentPortfolioChartSegments = useMemo(() => {
    const segments = normalizedHoldings
      .filter((item) => item.price > 0 && item.shares > 0)
      .map((item, index) => ({
        label: item.name,
        value: item.shares * item.price,
        color: ["#3182f6", "#4f95f8", "#69a6fb", "#84b6fc", "#9dc5fd", "#b4d3fe", "#c7defe", "#d8e8ff", "#e6f1ff", "#f0f7ff"][index % 10]
      }));

    if (derivedCash > 0) {
      segments.push({ label: "현금", value: derivedCash, color: "#dce8f8" });
    }
    return segments;
  }, [derivedCash, normalizedHoldings]);

  const targetPortfolioChartSegments = useMemo(() => {
    const segments = visiblePortfolio.map((item, index) => ({
      label: item.name,
      value: item.targetAmount,
      color: ["#3182f6", "#4f95f8", "#69a6fb", "#84b6fc", "#9dc5fd", "#b4d3fe", "#c7defe", "#d8e8ff", "#e6f1ff", "#f0f7ff"][index % 10]
    }));

    if (targetShareMap.leftoverCash > 0) {
      segments.push({ label: "잔여 현금", value: targetShareMap.leftoverCash, color: "#dce8f8" });
    }
    return segments;
  }, [targetShareMap.leftoverCash, visiblePortfolio]);

  const currentPortfolioLegend = useMemo(() => {
    const total = currentPortfolioChartSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    return currentPortfolioChartSegments.map((item) => ({
      ...item,
      pct: (item.value / total) * 100,
    }));
  }, [currentPortfolioChartSegments]);

  const targetPortfolioLegend = useMemo(() => {
    const total = targetPortfolioChartSegments.reduce((sum, item) => sum + item.value, 0) || 1;
    return targetPortfolioChartSegments.map((item) => ({
      ...item,
      pct: (item.value / total) * 100,
    }));
  }, [targetPortfolioChartSegments]);

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

  const holdingSearchResults = useMemo(() => {
    const normalized = holdingSearchTerm.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    return stockUniverse
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
      .slice(0, 8);
  }, [holdingSearchTerm, stockUniverse]);

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
    const syncHeights = () => {
      setPortfolioListHeight(portfolioPieRef.current?.offsetHeight ?? null);
      setFactorPanelHeight(factorMapRef.current?.offsetHeight ?? null);
    };

    syncHeights();
    const observer = new ResizeObserver(() => syncHeights());
    if (portfolioPieRef.current) {
      observer.observe(portfolioPieRef.current);
    }
    if (factorMapRef.current) {
      observer.observe(factorMapRef.current);
    }
    window.addEventListener("resize", syncHeights);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncHeights);
    };
  }, [selectedCodes.length, visiblePortfolio.length, selectedFactorRows.length, selectedChipCollapsed]);

  const applyPreset = (presetName: string) => {
    const safePreset = selectionPresets[presetName];
    if (safePreset) {
      setSelectedCodes(safePreset);
      setHoldings(buildHoldingRowsFromCodes(data, safePreset));
      setSearchTerm("");
      setSelectedOnly(false);
    }
  };

  const toggleCode = (code: string) => {
    setSelectedCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
    );
  };

  const updateHoldingShares = (index: number, shares: number) => {
    setHoldings((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, shares } : item))
    );
  };

  const addHoldingByCode = (code: string) => {
    setHoldings((current) => {
      if (current.some((item) => item.code === code)) {
        return current;
      }
      const price = Number(stockMap.get(code)?.["현재가"] ?? rankedMap.get(code)?.["현재가"] ?? 0);
      return [...current, { code, shares: 0, avgBuyPrice: price }];
    });
    setHoldingSearchTerm("");
  };

  const removeHoldingRow = (index: number) => {
    setHoldings((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <main className="page-shell">
      <section className="hero simple-hero">
        <div className="hero-copy compact">
          <p className="eyebrow">Portfolio Rebalancer</p>
          <h1>한국 주식 포트폴리오 리밸런서</h1>
          <p className="hero-text">
            시장 빠른 선택과 종목 선택으로 후보군을 좁히고, 투자 가능 금액을 기준으로 추천 포트폴리오와 주수 단위
            리밸런싱을 확인합니다.
          </p>
        </div>
        <div className="hero-inline-metrics">
          <div className="inline-metric">
            <span>최근 업데이트</span>
            <strong>{new Date(data.generatedAt).toLocaleDateString("ko-KR")}</strong>
          </div>
          <div className="inline-metric">
            <span>선택 종목</span>
            <strong>{formatNumber(selectedCodes.length)}개</strong>
          </div>
          <div className="inline-metric">
            <span>점수 계산 가능</span>
            <strong>
              {formatNumber(presetCoverage.scored)} / {formatNumber(presetCoverage.selected)}
            </strong>
          </div>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Controls</p>
            <h2>포트폴리오 설정</h2>
          </div>
          <p className="section-note">선택 후보는 시가총액 순으로 정렬해서 보여줍니다.</p>
        </div>

        <div className="control-grid refined">
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

        <div className="control-card money-slider-card">
          <div className="slider-head">
            <div>
              <h3>투자 가능 금액</h3>
              <p>1,000만원부터 500만원 단위로 10억원까지 조절할 수 있습니다.</p>
            </div>
            <strong>{formatCurrency(totalAsset)}</strong>
          </div>
          <input
            className="money-slider"
            type="range"
            min={totalAssetMin}
            max={totalAssetMax}
            step={totalAssetStep}
            value={totalAsset}
            onChange={(event) => setTotalAsset(clampAsset(Number(event.target.value)))}
          />
          <div className="slider-scale">
            <span>{formatCurrency(totalAssetMin)}</span>
            <span>{formatCurrency(totalAssetMax)}</span>
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
      </section>

      <section className="panel portfolio-panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Target Portfolio</p>
            <h2>추천 포트폴리오</h2>
          </div>
          <p className="section-note">투자 가능 금액을 기준으로 산출한 추천 포트폴리오입니다.</p>
        </div>

        <div className="portfolio-layout">
          <article className="portfolio-pie-card" ref={portfolioPieRef}>
            <div className="donut-wrap">
              <div className="donut-ring large" style={buildDonutStyle(portfolioChartSegments)}>
                <div className="donut-center">
                  <strong>TOP {visiblePortfolio.length}</strong>
                  <span>{formatCurrency(totalAsset)}</span>
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
                          <span className="factor-chip growth-chip">성장률 {formatScore(avgGrowth)}%</span>
                          <span className="factor-chip value-chip">PER {avgPer ? avgPer.toFixed(2) : "-"}</span>
                          <span className="factor-chip roe-chip">ROE {item.roe ? `${item.roe.toFixed(1)}%` : "-"}</span>
                          <span className="factor-chip neutral-chip">총 점수 {formatScore(item.score100)}</span>
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

      <section className="panel rebalance-panel">
          <div className="section-head compact-head">
            <div>
              <p className="section-kicker">Rebalancing</p>
              <h2>실행해야 할 리밸런싱</h2>
            </div>
            <p className="section-note">보유 현금은 투자 가능 금액에서 보유 종목 매입총액을 뺀 값으로 계산합니다.</p>
          </div>

          <div className="rebalance-top">
            <div className="rebalance-summary-grid">
              <div className="summary-chip">
                <span>현재 주식 평가액</span>
                <strong>{formatCurrency(rebalanceSummary.currentAssetValue)}</strong>
              </div>
              <div className="summary-chip">
                <span>매입총액</span>
                <strong>{formatCurrency(rebalanceSummary.purchaseTotal)}</strong>
              </div>
              <div className="summary-chip">
                <span>보유 현금 (총 자산 - 매입총액)</span>
                <strong>{formatCurrency(derivedCash)}</strong>
              </div>
              <div className="summary-chip">
                <span>리밸런싱 총 재원</span>
                <strong>{formatCurrency(rebalanceSummary.rebalanceBudget)}</strong>
              </div>
              <div className="summary-chip">
                <span>예상 잔여 현금</span>
                <strong>{formatCurrency(rebalanceSummary.finalCash)}</strong>
              </div>
            </div>
          </div>

          {assetGap < 0 ? (
            <div className="warning-banner">
              입력한 투자 가능 금액보다 매입총액이 더 큽니다. 투자 가능 금액을 늘리거나 보유 주수·매입단가를 다시 확인해 주세요.
            </div>
          ) : null}

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

          <div className="rebalance-columns">
            <div className="holding-card">
              <div className="holding-card-head">
                <h3>현재 보유 현황 입력</h3>
                <p>현재 선택한 시장/종목군 기준 상위 10종목은 1주씩 보유한 상태로 시작합니다. 아래 순서는 매도 우선, 이후 매수 순서입니다.</p>
              </div>

              <div className="holding-search-box">
                <label className="search-input">
                  <span>보유 종목 추가</span>
                  <input
                    type="text"
                    placeholder="종목명 또는 코드로 검색"
                    value={holdingSearchTerm}
                    onChange={(event) => setHoldingSearchTerm(event.target.value)}
                  />
                </label>
                {holdingSearchResults.length > 0 ? (
                  <div className="holding-search-results">
                    {holdingSearchResults.map((stock) => (
                      <button
                        key={stock["종목코드"]}
                        className="stock-chip"
                        onClick={() => addHoldingByCode(stock["종목코드"])}
                      >
                        <span>{stock["종목명"]}</span>
                        <small>
                          {stock["시장"]} · {stock["시장시총순위"] ? `${stock["시장시총순위"]}위` : "순위 없음"}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="rebalance-list paired-list paired-scroll">
                {orderedExecutionRows.map((item) => {
                  const holdingIndex = holdings.findIndex((holding) => holding.code === item.code);
                  const holdingInfo = holdingInputMap.get(item.code);

                  return (
                    <div className="holding-row read-only paired-card" key={`holding-${item.code}`}>
                      <div className="holding-name-cell">
                        <strong>{item.name}</strong>
                        <small>{item.code.replace("A", "")}</small>
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={holdingIndex >= 0 && holdings[holdingIndex]?.shares ? String(holdings[holdingIndex]?.shares) : ""}
                        onChange={(event) => {
                          if (holdingIndex < 0) return;
                          const value = Number(event.target.value);
                          updateHoldingShares(holdingIndex, Number.isFinite(value) && value > 0 ? value : 0);
                        }}
                      />
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={holdingIndex >= 0 && holdings[holdingIndex]?.avgBuyPrice ? String(holdings[holdingIndex]?.avgBuyPrice) : ""}
                        onChange={(event) => {
                          if (holdingIndex < 0) return;
                          const value = Number(event.target.value);
                          setHoldings((current) =>
                            current.map((holding, itemIndex) =>
                              itemIndex === holdingIndex
                                ? { ...holding, avgBuyPrice: Number.isFinite(value) && value > 0 ? value : 0 }
                                : holding
                            )
                          );
                        }}
                      />
                      <button className="remove-row-button" onClick={() => holdingIndex >= 0 && removeHoldingRow(holdingIndex)}>
                        삭제
                      </button>
                      {holdingInfo ? (
                        <div className="holding-inline-meta">
                          <span>현재가 {holdingInfo.price > 0 ? formatCurrency(holdingInfo.price) : "-"}</span>
                          <span>평가액 {formatCurrency(item.currentAmount)}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="execution-panel">
              <div className="execution-head">
                <h3>실행 순서</h3>
                <p>전량 매도와 비중 축소를 먼저 정리한 뒤, 신규 편입과 비중 확대를 진행하는 순서입니다.</p>
              </div>
              <div className="rebalance-list prominent paired-list paired-scroll">
                {orderedExecutionRows.map((item) => (
                  <article className="rebalance-card strong-card paired-card" key={`${item.code}-${item.action}`}>
                    <div className="rebalance-header">
                      <div>
                        <strong>{item.name}</strong>
                        <p>{item.action}</p>
                      </div>
                      <span className="score-badge share-badge action-callout">
                        {item.diffShares > 0 ? "+" : ""}
                        {formatNumber(item.diffShares)}주
                      </span>
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
                          {formatNumber(item.currentShares)}주 / {formatCurrency(item.currentAmount)}
                        </dd>
                      </div>
                      <div>
                        <dt>목표</dt>
                        <dd>
                          {formatNumber(item.targetShares)}주 / {formatCurrency(item.targetAmount)}
                        </dd>
                      </div>
                      <div>
                        <dt>현재가</dt>
                        <dd>{item.price > 0 ? `${formatCurrency(item.price)} / 주` : "현재가 없음"}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          </div>
      </section>

      <section className="panel">
        <div className="section-head compact-head">
          <div>
            <p className="section-kicker">Portfolio Compare</p>
            <h2>리밸런싱 전후 포트폴리오</h2>
          </div>
          <p className="section-note">현재 보유 구조와 목표 포트폴리오 구성을 한눈에 비교합니다.</p>
        </div>
        <div className="comparison-chart-grid wide-comparison-grid">
          <article className="action-chart-card comparison-card">
            <div className="comparison-body">
              <div className="comparison-block">
                <span>기존 보유 종목</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(currentPortfolioChartSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(normalizedHoldings.length)}</strong>
                      <span>보유 종목</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {currentPortfolioLegend.map((item) => (
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
                <span>리밸런싱 후 종목</span>
                <div className="donut-wrap">
                  <div className="donut-ring" style={buildDonutStyle(targetPortfolioChartSegments)}>
                    <div className="donut-center">
                      <strong>{formatNumber(visiblePortfolio.length)}</strong>
                      <span>목표 종목</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comparison-legend">
                {targetPortfolioLegend.map((item) => (
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
      </section>

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
    </main>
  );
}
