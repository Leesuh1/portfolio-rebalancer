"use client";

import { useMemo, useState } from "react";
import type { DashboardData } from "@/lib/get-dashboard-data";

type Props = {
  data: DashboardData;
};

type HoldingRow = {
  name: string;
  amount: number;
};

const profileLabels = ["안정형", "균형형", "공격형"] as const;

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(value);
}

function formatScore(value: number) {
  return value.toFixed(1);
}

export function DashboardApp({ data }: Props) {
  const stockUniverse = data.stockUniverse ?? [];
  const selectionPresets = data.selectionPresets ?? {};
  const defaultSelection = data.selectedGicodes ?? [];
  const [selectedCodes, setSelectedCodes] = useState<string[]>(defaultSelection);
  const [profile, setProfile] = useState(data.profile);
  const [investAmount, setInvestAmount] = useState<number>(data.investAmount);
  const [holdings, setHoldings] = useState<HoldingRow[]>([
    { name: data.topPortfolio[0]?.["종목명"] ?? "", amount: Math.round(data.investAmount * 0.3) },
    { name: data.topPortfolio[1]?.["종목명"] ?? "", amount: Math.round(data.investAmount * 0.2) }
  ]);

  const selectedNameSet = useMemo(() => {
    const selectedRows = stockUniverse.filter((item) => selectedCodes.includes(item["종목코드"]));
    return new Set(selectedRows.map((item) => item["종목명"]));
  }, [selectedCodes, stockUniverse]);

  const visibleRankings = useMemo(() => {
    const baseRows = data.allRankings.filter((item) => selectedNameSet.has(item["종목명"]));
    return (baseRows.length > 0 ? baseRows : data.allRankings).slice(0, 10);
  }, [data.allRankings, selectedNameSet]);

  const visiblePortfolio = useMemo(() => {
    const baseRows = data.topPortfolio.filter((item) => selectedNameSet.has(item["종목명"]));
    return baseRows.length > 0 ? baseRows : data.topPortfolio;
  }, [data.topPortfolio, selectedNameSet]);

  const holdingSummary = useMemo(() => {
    const currentMap = new Map(holdings.filter((item) => item.name).map((item) => [item.name, item.amount]));

    return visiblePortfolio.map((item) => {
      const currentAmount = currentMap.get(item["종목명"]) ?? 0;
      const targetAmount = Math.round((item["비중(%)"] / 100) * investAmount);
      const diff = targetAmount - currentAmount;

      let action = "유지";
      if (currentAmount === 0 && targetAmount > 0) action = "신규 편입";
      else if (currentAmount > 0 && targetAmount === 0) action = "전량 매도";
      else if (diff > 0) action = "비중 확대";
      else if (diff < 0) action = "비중 축소";

      return {
        name: item["종목명"],
        style: item["투자스타일"],
        currentAmount,
        targetAmount,
        diff,
        action
      };
    });
  }, [holdings, investAmount, visiblePortfolio]);

  const applyPreset = (presetName: string) => {
    const preset = data.selectionPresets?.[presetName];
    const safePreset = selectionPresets[presetName];
    if (safePreset) {
      setSelectedCodes(safePreset);
    }
  };

  const toggleCode = (code: string) => {
    setSelectedCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
    );
  };

  const updateHolding = (index: number, key: keyof HoldingRow, value: string | number) => {
    setHoldings((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item
      )
    );
  };

  const addHoldingRow = () => {
    setHoldings((current) => [...current, { name: "", amount: 0 }]);
  };

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Portfolio Rebalancer</p>
          <h1>한국 주식 멀티팩터 포트폴리오 앱 초안</h1>
          <p className="hero-text">
            지금은 저장된 데이터 스냅샷을 기준으로 프론트 인터랙션을 먼저 붙인 버전입니다.
            다음 단계에서는 이 입력값이 서버 계산과 직접 연결되도록 확장합니다.
          </p>
          <div className="hero-meta">
            <span>생성 시각 {new Date(data.generatedAt).toLocaleString("ko-KR")}</span>
            <span>{profile}</span>
            <span>{formatCurrency(investAmount)} 기준</span>
          </div>
        </div>
        <div className="hero-panel">
          <div className="metric-card">
            <span className="metric-label">선택 종목 수</span>
            <strong>{selectedCodes.length}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">자동 제외 종목 수</span>
            <strong>{data.summary.excludedCount}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">최고 종합점수</span>
            <strong>{formatScore(data.summary.topScore)}</strong>
          </div>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="section-head">
          <div>
            <p className="section-kicker">Controls</p>
            <h2>포트폴리오 설정</h2>
          </div>
          <p className="section-note">버튼으로 빠르게 담고, 아래에서 개별 종목을 조정할 수 있습니다.</p>
        </div>

        <div className="control-grid">
          <div className="control-card">
            <h3>빠른 종목 선택</h3>
            <div className="chip-grid">
              {Object.keys(selectionPresets).map((presetName) => (
                <button key={presetName} className="chip-button" onClick={() => applyPreset(presetName)}>
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
          </div>

          <div className="control-card">
            <h3>투자금</h3>
            <label className="money-input">
              <span>원화 기준</span>
              <input
                type="number"
                value={investAmount}
                min={1000000}
                step={1000000}
                onChange={(event) => setInvestAmount(Number(event.target.value))}
              />
            </label>
          </div>
        </div>

        <div className="stock-picker">
          {stockUniverse.map((stock) => {
            const active = selectedCodes.includes(stock["종목코드"]);
            return (
              <button
                key={stock["종목코드"]}
                className={active ? "stock-chip active" : "stock-chip"}
                onClick={() => toggleCode(stock["종목코드"])}
              >
                {stock["종목명"]}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="section-kicker">Top Portfolio</p>
            <h2>추천 포트폴리오</h2>
          </div>
        </div>
        <div className="portfolio-grid">
          {visiblePortfolio.map((item) => (
            <article key={item["종목명"]} className="allocation-card">
              <div className="allocation-top">
                <h3>{item["종목명"]}</h3>
                <span className="style-pill">{item["투자스타일"]}</span>
              </div>
              <dl className="allocation-meta">
                <div>
                  <dt>비중</dt>
                  <dd>{item["비중(%)"]}%</dd>
                </div>
                <div>
                  <dt>투자금액</dt>
                  <dd>{formatCurrency(Math.round((item["비중(%)"] / 100) * investAmount))}</dd>
                </div>
                <div>
                  <dt>종합점수</dt>
                  <dd>{formatScore(item["종합점수"] * 100)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="two-column">
        <div className="panel">
          <div className="section-head">
            <div>
              <p className="section-kicker">Rankings</p>
              <h2>상위 종목 점수</h2>
            </div>
          </div>
          <div className="ranking-list">
            {visibleRankings.map((item) => (
              <div className="ranking-row" key={item["종목명"]}>
                <div className="ranking-title">
                  <span className="rank-badge">{item["랭킹"]}</span>
                  <div>
                    <strong>{item["종목명"]}</strong>
                    <p>{item["투자스타일"]}</p>
                  </div>
                </div>
                <div className="ranking-bars">
                  <div>
                    <span>종합점수</span>
                    <div className="bar-track">
                      <div className="bar-fill score" style={{ width: `${item["종합점수_100"]}%` }} />
                    </div>
                  </div>
                  <div>
                    <span>성장점수</span>
                    <div className="bar-track">
                      <div className="bar-fill growth" style={{ width: `${item["성장점수"] * 100}%` }} />
                    </div>
                  </div>
                  <div>
                    <span>저평가점수</span>
                    <div className="bar-track">
                      <div className="bar-fill value" style={{ width: `${item["저평가점수"] * 100}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-head">
            <div>
              <p className="section-kicker">Rebalancing</p>
              <h2>현재 보유 포트폴리오</h2>
            </div>
          </div>

          <div className="holding-editor">
            {holdings.map((item, index) => (
              <div className="holding-row" key={`${item.name}-${index}`}>
                <select value={item.name} onChange={(event) => updateHolding(index, "name", event.target.value)}>
                  <option value="">종목 선택</option>
                  {stockUniverse.map((stock) => (
                    <option key={stock["종목명"]} value={stock["종목명"]}>
                      {stock["종목명"]}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  value={item.amount}
                  min={0}
                  step={100000}
                  onChange={(event) => updateHolding(index, "amount", Number(event.target.value))}
                />
              </div>
            ))}
            <button className="secondary-button" onClick={addHoldingRow}>
              보유 종목 한 줄 추가
            </button>
          </div>

          <div className="rebalance-list">
            {holdingSummary.map((item) => (
              <article className="rebalance-card" key={item.name}>
                <div className="rebalance-header">
                  <strong>{item.name}</strong>
                  <span className="style-pill">{item.action}</span>
                </div>
                <dl>
                  <div>
                    <dt>현재</dt>
                    <dd>{formatCurrency(item.currentAmount)}</dd>
                  </div>
                  <div>
                    <dt>목표</dt>
                    <dd>{formatCurrency(item.targetAmount)}</dd>
                  </div>
                  <div>
                    <dt>차이</dt>
                    <dd className={item.diff >= 0 ? "positive" : "negative"}>
                      {item.diff >= 0 ? "+" : ""}
                      {formatCurrency(item.diff)}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="section-kicker">Excluded</p>
            <h2>자동 제외 종목</h2>
          </div>
        </div>
        <div className="excluded-list">
          {data.excludedStocks.length > 0 ? (
            data.excludedStocks.map((item) => <span key={item}>{item}</span>)
          ) : (
            <p>제외된 종목이 없습니다.</p>
          )}
        </div>
      </section>
    </main>
  );
}
