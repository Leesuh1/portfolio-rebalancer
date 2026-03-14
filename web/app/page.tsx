import { getDashboardData } from "@/lib/get-dashboard-data";

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

export default async function HomePage() {
  const data = await getDashboardData();

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Portfolio Rebalancer</p>
          <h1>한국 주식 멀티팩터 포트폴리오 초안</h1>
          <p className="hero-text">
            Python으로 계산한 추천 포트폴리오를 웹앱 형태로 보여주는 첫 번째 버전입니다.
            다음 단계에서는 종목 선택, 투자 성향, 리밸런싱 시뮬레이션을 실시간 인터랙션으로
            옮길 예정입니다.
          </p>
          <div className="hero-meta">
            <span>생성 시각 {new Date(data.generatedAt).toLocaleString("ko-KR")}</span>
            <span>{data.profile}</span>
            <span>{formatCurrency(data.investAmount)} 기준</span>
          </div>
        </div>
        <div className="hero-panel">
          <div className="metric-card">
            <span className="metric-label">선정 종목 수</span>
            <strong>{data.summary.rankedCount}</strong>
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

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="section-kicker">Top Portfolio</p>
            <h2>추천 포트폴리오</h2>
          </div>
          <p className="section-note">
            현재는 정적 스냅샷입니다. 다음 단계에서 투자금과 성향을 UI에서 조정할 수 있게
            연결합니다.
          </p>
        </div>
        <div className="portfolio-grid">
          {data.topPortfolio.map((item) => (
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
                  <dd>{formatCurrency(item["투자금액"])}</dd>
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
            {data.topRankings.map((item) => (
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
                      <div
                        className="bar-fill score"
                        style={{ width: `${item["종합점수_100"]}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <span>성장점수</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill growth"
                        style={{ width: `${item["성장점수"] * 100}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <span>저평가점수</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill value"
                        style={{ width: `${item["저평가점수"] * 100}%` }}
                      />
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
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="section-kicker">Roadmap</p>
            <h2>다음 단계</h2>
          </div>
        </div>
        <div className="roadmap">
          <article>
            <strong>1. 종목 선택 인터랙션</strong>
            <p>KOSPI/KOSDAQ 프리셋 버튼과 개별 종목 검색을 붙입니다.</p>
          </article>
          <article>
            <strong>2. 투자 성향 전환</strong>
            <p>안정형, 균형형, 공격형을 UI에서 바꾸면 점수를 즉시 다시 계산합니다.</p>
          </article>
          <article>
            <strong>3. 리밸런싱 가이드</strong>
            <p>현재 보유 포트폴리오 대비 매수/매도 액션을 시각화합니다.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
