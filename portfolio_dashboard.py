from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import plotly.io as pio
import requests
from bs4 import BeautifulSoup
from plotly.subplots import make_subplots

try:
    from pykrx import stock
except ImportError:
    stock = None


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
WEB_PUBLIC_DATA_DIR = BASE_DIR / "web" / "public" / "data"
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0"}
REQUEST_TIMEOUT = 20
DEFAULT_TICKERS = [
    "005930",
    "000660",
    "207940",
    "068270",
    "005380",
    "000270",
    "035420",
    "035720",
    "051910",
    "373220",
    "006400",
    "247540",
    "005490",
    "066570",
    "015760",
    "034020",
    "042660",
    "010140",
    "064400",
    "257720",
    "012450",
    "329180",
    "009540",
    "009150",
    "011070",
    "042700",
    "058470",
    "357780",
    "090430",
]
PROFILE_WEIGHTS = {
    "안정형": {
        "영업성장": 0.15,
        "순이익성장": 0.20,
        "영업PER": 0.325,
        "순이익PER": 0.325,
    },
    "균형형": {
        "영업성장": 0.25,
        "순이익성장": 0.25,
        "영업PER": 0.25,
        "순이익PER": 0.25,
    },
    "공격형": {
        "영업성장": 0.325,
        "순이익성장": 0.325,
        "영업PER": 0.175,
        "순이익PER": 0.175,
    },
}


def load_fnguide_html(gicode: str) -> BeautifulSoup:
    url = f"https://comp.fnguide.com/SVO2/ASP/SVD_main.asp?pGB=1&gicode={gicode}"
    response = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def parse_yearly_financials(html: BeautifulSoup, target_items: list[str]) -> tuple[pd.DataFrame, int]:
    tables = html.find_all("table", class_="us_table_ty1 h_fix zigbg_no")
    table_y = tables[5]

    rows = table_y.find_all("tr")
    raw_data: dict[str, list[int | None]] = {}

    for row in rows:
        th = row.find("th")
        if not th:
            continue
        item = th.get_text(strip=True)
        if item not in target_items:
            continue

        values = []
        for td in row.find_all("td"):
            text = td.get_text(strip=True).replace(",", "")
            values.append(int(text) if text else None)
        raw_data[item] = values

    this_year = int(
        html.find("tr", class_="td_gapcolor2")
        .find("span", class_="txt_acd")
        .get_text()
        .split("/")[0]
    )

    years = list(range(this_year - 5, this_year - 5 + len(raw_data["매출액"])))
    operating_profit = [
        raw_data["영업이익(발표기준)"][i] if year < this_year else raw_data["영업이익"][i]
        for i, year in enumerate(years)
    ]

    yearly_df = pd.DataFrame(
        {
            "연도": years,
            "매출액": raw_data["매출액"],
            "영업이익": operating_profit,
            "당기순이익": raw_data["당기순이익"],
        }
    )
    return yearly_df, this_year


def get_top30_gicodes() -> list[str]:
    return [f"A{ticker}" for ticker in DEFAULT_TICKERS]


def get_profile_weight_map(profile: str) -> dict[str, float]:
    return PROFILE_WEIGHTS.get(profile, PROFILE_WEIGHTS["균형형"])


def get_reference_date() -> str:
    if stock is None:
        return datetime.now().strftime("%Y%m%d")

    today = datetime.now()
    for offset in range(0, 800):
        candidate = (today - timedelta(days=offset)).strftime("%Y%m%d")
        try:
            cap_df = stock.get_market_cap_by_ticker(candidate)
            if not cap_df.empty and "시가총액" in cap_df.columns:
                return candidate
        except Exception:
            continue
    return datetime.now().strftime("%Y%m%d")


def get_market_universe(market: str) -> pd.DataFrame:
    if stock is None:
        raise RuntimeError("pykrx가 설치되지 않아 시장 전체 종목 목록을 불러올 수 없습니다.")

    reference_date = get_reference_date()
    tickers = stock.get_market_ticker_list(reference_date, market=market)
    rows = []
    for ticker in tickers:
        rows.append(
            {
                "ticker": ticker,
                "gicode": f"A{ticker}",
                "name": stock.get_market_ticker_name(ticker),
                "market": market,
            }
        )
    return pd.DataFrame(rows).sort_values(["name", "ticker"]).reset_index(drop=True)


def get_market_top_gicodes(market: str, top_n: int = 30) -> list[str]:
    if stock is None:
        raise RuntimeError("pykrx가 설치되지 않아 시가총액 기준 상위 종목을 계산할 수 없습니다.")

    reference_date = get_reference_date()
    caps = stock.get_market_cap_by_ticker(reference_date)
    universe = get_market_universe(market).set_index("ticker")
    top_df = (
        caps.join(universe, how="inner")
        .sort_values("시가총액", ascending=False)
        .head(top_n)
        .reset_index()
    )
    return [f"A{ticker}" for ticker in top_df["ticker"].tolist()]


def get_selection_presets() -> dict[str, list[str]]:
    presets = {"현재 기본 포트폴리오": get_top30_gicodes()}
    if stock is None:
        return presets

    try:
        presets["KOSPI Top 30"] = get_market_top_gicodes("KOSPI", top_n=30)
        presets["KOSDAQ Top 30"] = get_market_top_gicodes("KOSDAQ", top_n=30)
        presets["KOSPI 전체"] = get_market_universe("KOSPI")["gicode"].tolist()
        presets["KOSDAQ 전체"] = get_market_universe("KOSDAQ")["gicode"].tolist()
    except Exception:
        return presets
    return presets


def run_batch_check(gicodes: list[str] | None = None) -> tuple[pd.DataFrame, list[str]]:
    incomplete_stocks: list[str] = []
    all_results: list[pd.DataFrame] = []

    for gicode in gicodes or get_top30_gicodes():
        try:
            html = load_fnguide_html(gicode)
            stock_name = html.find("h1").get_text(strip=True)
            yearly_df, _ = parse_yearly_financials(
                html, ["매출액", "영업이익", "영업이익(발표기준)", "당기순이익"]
            )

            if yearly_df[["매출액", "영업이익", "당기순이익"]].isna().any().any():
                incomplete_stocks.append(stock_name)
            else:
                yearly_df["종목코드"] = gicode
                yearly_df["종목명"] = stock_name
                all_results.append(yearly_df)

            print(f"completed: {stock_name}")
        except Exception as exc:
            print(f"error: {gicode} -> {exc}")
            incomplete_stocks.append(gicode)

    final_df = pd.concat(all_results, ignore_index=True) if all_results else pd.DataFrame()
    return final_df, incomplete_stocks


def calc_3y_avg_growth(series: pd.Series) -> float:
    valid_values = series.dropna()
    if len(valid_values) < 4:
        return np.nan

    start = valid_values.iloc[0]
    end = valid_values.iloc[-1]

    if end < 0:
        return np.nan

    if start > 0 and end > 0:
        return (end / start) ** (1 / 3) - 1

    scale = np.mean(np.abs(valid_values))
    if scale == 0:
        return np.nan

    shift = abs(valid_values.min()) + scale
    shifted_start = start + shift
    shifted_end = end + shift

    if shifted_start <= 0:
        return np.nan

    return (shifted_end / shifted_start) ** (1 / 3) - 1


def get_market_cap(gicode: str) -> float:
    html = load_fnguide_html(gicode)
    try:
        cap_text = (
            html.find("th", string="시가총액").find_next_sibling("td").get_text(strip=True)
        )
        return float(cap_text.replace(",", ""))
    except Exception:
        return np.nan


def calc_per(market_cap: float, profit: float) -> float:
    if pd.isna(market_cap) or pd.isna(profit) or profit <= 0 or market_cap <= 0:
        return np.nan
    return market_cap / profit


def build_result_df(final_df: pd.DataFrame) -> pd.DataFrame:
    result_rows: list[dict[str, float | str]] = []

    for gicode in final_df["종목코드"].unique():
        stock_df = final_df[final_df["종목코드"] == gicode].sort_values("연도")
        recent_4y = stock_df.tail(4)

        if len(recent_4y) < 4:
            continue

        stock_name = stock_df["종목명"].iloc[0]
        future_row = recent_4y.iloc[-1]
        market_cap = get_market_cap(gicode)

        result_rows.append(
            {
                "종목코드": gicode,
                "종목명": stock_name,
                "작년 영업이익": recent_4y["영업이익"].iloc[0],
                "작년 당기순이익": recent_4y["당기순이익"].iloc[0],
                "내후년 영업이익(E)": future_row["영업이익"],
                "내후년 당기순이익(E)": future_row["당기순이익"],
                "매출액_3Y성장률": calc_3y_avg_growth(recent_4y["매출액"]),
                "영업이익_3Y성장률": calc_3y_avg_growth(recent_4y["영업이익"]),
                "순이익_3Y성장률": calc_3y_avg_growth(recent_4y["당기순이익"]),
                "시가총액": market_cap,
                "영업이익_PER": calc_per(market_cap, future_row["영업이익"]),
                "순이익_PER": calc_per(market_cap, future_row["당기순이익"]),
            }
        )
        print(f"scored: {stock_name}")

    result_df = pd.DataFrame(result_rows)
    pd.set_option("display.float_format", "{:.2f}".format)
    return result_df


def build_ranked_df(result_df: pd.DataFrame, profile: str = "균형형") -> pd.DataFrame:
    df = result_df.copy()
    weights = get_profile_weight_map(profile)
    df["P_영업성장"] = df["영업이익_3Y성장률"].rank(pct=True)
    df["P_순이익성장"] = df["순이익_3Y성장률"].rank(pct=True)
    df["P_영업PER"] = 1 - df["영업이익_PER"].rank(pct=True)
    df["P_순이익PER"] = 1 - df["순이익_PER"].rank(pct=True)

    df["기여_영업성장"] = weights["영업성장"] * df["P_영업성장"]
    df["기여_순이익성장"] = weights["순이익성장"] * df["P_순이익성장"]
    df["기여_영업PER"] = weights["영업PER"] * df["P_영업PER"]
    df["기여_순이익PER"] = weights["순이익PER"] * df["P_순이익PER"]
    df["종합점수"] = (
        df["기여_영업성장"] + df["기여_순이익성장"] + df["기여_영업PER"] + df["기여_순이익PER"]
    )
    df["종합점수_100"] = df["종합점수"] * 100
    df = df.sort_values("종합점수_100", ascending=False).reset_index(drop=True)
    df["랭킹"] = range(1, len(df) + 1)
    df["성장점수"] = (df["P_영업성장"] + df["P_순이익성장"]) / 2
    df["저평가점수"] = (df["P_영업PER"] + df["P_순이익PER"]) / 2

    def classify(row: pd.Series) -> str:
        if row["성장점수"] > 0.6 and row["저평가점수"] > 0.6:
            return "고성장 저평가"
        if row["성장점수"] > row["저평가점수"]:
            return "성장형"
        return "가치형"

    df["투자스타일"] = df.apply(classify, axis=1)
    df["투자성향"] = profile
    return df


def build_rebalancing_df(
    recommended_df: pd.DataFrame,
    current_positions: pd.DataFrame,
    total_budget: int,
) -> pd.DataFrame:
    if current_positions.empty:
        return pd.DataFrame()

    working = current_positions.copy()
    working = working.rename(columns={"종목명": "종목명", "현재평가금액": "현재평가금액"})
    working["현재평가금액"] = pd.to_numeric(working["현재평가금액"], errors="coerce").fillna(0)

    current_total = working["현재평가금액"].sum()
    if current_total > 0:
        working["현재비중(%)"] = (working["현재평가금액"] / current_total * 100).round(2)
    else:
        working["현재비중(%)"] = 0.0

    recommended = recommended_df[["종목명", "비중(%)", "투자금액"]].copy()
    recommended = recommended.rename(
        columns={"비중(%)": "추천비중(%)", "투자금액": "추천금액"}
    )

    merged = recommended.merge(working, on="종목명", how="outer").fillna(
        {"추천비중(%)": 0, "추천금액": 0, "현재평가금액": 0, "현재비중(%)": 0}
    )
    merged["변경금액"] = merged["추천금액"] - merged["현재평가금액"]
    merged["변경비중(%p)"] = (merged["추천비중(%)"] - merged["현재비중(%)"]).round(2)

    def classify_change(row: pd.Series) -> str:
        if row["현재평가금액"] == 0 and row["추천금액"] > 0:
            return "신규 편입"
        if row["현재평가금액"] > 0 and row["추천금액"] == 0:
            return "전량 매도"
        if row["변경금액"] > 0:
            return "비중 확대"
        if row["변경금액"] < 0:
            return "비중 축소"
        return "유지"

    merged["액션"] = merged.apply(classify_change, axis=1)
    return merged.sort_values(["액션", "변경금액"], ascending=[True, False]).reset_index(drop=True)


def run_portfolio_pipeline(
    gicodes: list[str] | None = None,
    profile: str = "균형형",
    invest_amount: int = 10_000_000,
    top_n: int = 10,
) -> dict[str, object]:
    final_df, incomplete_list = run_batch_check(gicodes=gicodes)
    result_df = build_result_df(final_df)
    ranked_df = build_ranked_df(result_df, profile=profile)
    portfolio_df = build_portfolio_df(ranked_df, top_n=top_n, invest_amount=invest_amount)
    return {
        "final_df": final_df,
        "result_df": result_df,
        "ranked_df": ranked_df,
        "portfolio_df": portfolio_df,
        "incomplete_list": incomplete_list,
    }


def build_bar_figure(result_df: pd.DataFrame) -> go.Figure:
    df = result_df.copy()
    df["영업이익_3Y성장률_%"] = df["영업이익_3Y성장률"] * 100
    df["순이익_3Y성장률_%"] = df["순이익_3Y성장률"] * 100

    top_op_growth = df.sort_values("영업이익_3Y성장률_%", ascending=False).head(10)
    top_net_growth = df.sort_values("순이익_3Y성장률_%", ascending=False).head(10)
    top_op_per = df.sort_values("영업이익_PER", ascending=True).head(10)
    top_net_per = df.sort_values("순이익_PER", ascending=True).head(10)

    fig = make_subplots(
        rows=2,
        cols=2,
        subplot_titles=(
            "Operating Profit 3Y Growth Top 10",
            "Net Income 3Y Growth Top 10",
            "Operating Profit PER Top 10",
            "Net Income PER Top 10",
        ),
    )

    fig.add_trace(
        go.Bar(
            x=top_op_growth["영업이익_3Y성장률_%"],
            y=top_op_growth["종목명"],
            text=top_op_growth["영업이익_3Y성장률_%"].round(1).astype(str) + "%",
            textposition="outside",
            marker_color="steelblue",
            orientation="h",
            cliponaxis=False,
        ),
        row=1,
        col=1,
    )
    fig.add_trace(
        go.Bar(
            x=top_net_growth["순이익_3Y성장률_%"],
            y=top_net_growth["종목명"],
            text=top_net_growth["순이익_3Y성장률_%"].round(1).astype(str) + "%",
            textposition="outside",
            marker_color="teal",
            orientation="h",
            cliponaxis=False,
        ),
        row=1,
        col=2,
    )
    fig.add_trace(
        go.Bar(
            x=top_op_per["영업이익_PER"],
            y=top_op_per["종목명"],
            text=top_op_per["영업이익_PER"].round(1),
            textposition="outside",
            marker_color="darkorange",
            orientation="h",
            cliponaxis=False,
        ),
        row=2,
        col=1,
    )
    fig.add_trace(
        go.Bar(
            x=top_net_per["순이익_PER"],
            y=top_net_per["종목명"],
            text=top_net_per["순이익_PER"].round(1),
            textposition="outside",
            marker_color="indianred",
            orientation="h",
            cliponaxis=False,
        ),
        row=2,
        col=2,
    )

    fig.update_layout(
        height=900,
        width=1100,
        title_text="성장률 및 PER 대시보드",
        showlegend=False,
        margin=dict(l=180, r=120, t=120, b=120),
    )
    fig.update_xaxes(automargin=True)
    fig.update_yaxes(autorange="reversed")
    return fig


def build_bubble_figure(df: pd.DataFrame) -> go.Figure:
    plot_df = df.copy()
    plot_df["버블색상점수"] = ((plot_df["저평가점수"] + plot_df["성장점수"]) / 2).round(4)
    figure = go.Figure(
        data=[
            go.Scatter(
                x=plot_df["저평가점수"].tolist(),
                y=plot_df["성장점수"].tolist(),
                text=plot_df["종목명"].tolist(),
                customdata=plot_df["종합점수_100"].round(1).tolist(),
                mode="markers+text",
                textposition="top center",
                marker=dict(
                    size=(plot_df["종합점수_100"] / 2).tolist(),
                    color=plot_df["버블색상점수"].tolist(),
                    colorscale=[
                        [0.0, "#93c5fd"],
                        [0.35, "#7dd3fc"],
                        [0.65, "#86efac"],
                        [1.0, "#4ade80"],
                    ],
                    showscale=True,
                    sizemode="diameter",
                    line=dict(color="#0f172a", width=1),
                    opacity=0.72,
                    colorbar=dict(title="성장·저평가"),
                ),
                hovertemplate=(
                    "종목명: %{text}<br>"
                    "저평가점수: %{x:.2f}<br>"
                    "성장점수: %{y:.2f}<br>"
                    "종합점수: %{customdata:.1f}<extra></extra>"
                ),
                cliponaxis=False,
            )
        ]
    )
    figure.update_layout(
        title="성장 vs Value 버블차트",
        xaxis_title="Value 점수",
        yaxis_title="성장 점수",
        height=700,
        width=1100,
        plot_bgcolor="#eef4ff",
        paper_bgcolor="white",
        margin=dict(l=110, r=140, t=110, b=100),
    )
    figure.update_xaxes(range=[-0.04, 1.08], automargin=True)
    figure.update_yaxes(range=[-0.04, 1.12], automargin=True)
    return figure


def build_heatmap_figure(df: pd.DataFrame) -> go.Figure:
    top10 = df.sort_values("종합점수", ascending=False).head(10)
    heatmap_df = top10[["종목명", "P_영업성장", "P_순이익성장", "P_영업PER", "P_순이익PER"]].set_index(
        "종목명"
    )
    z = heatmap_df.values.astype(float)
    text = np.round(z, 2).astype(str)

    white_mask = z > 0.6
    black_mask = ~white_mask

    heatmap_fig = go.Figure()
    heatmap_fig.add_trace(
        go.Heatmap(
            z=z,
            x=heatmap_df.columns.tolist(),
            y=heatmap_df.index.tolist(),
            colorscale=[[0, "#f7fbff"], [0.5, "#6baed6"], [1, "#08306b"]],
            showscale=True,
            text=text,
            texttemplate="%{text}",
            hovertemplate="stock: %{y}<br>factor: %{x}<br>score: %{z:.2f}<extra></extra>",
        )
    )
    heatmap_fig.update_layout(
        title="Top 10 Multi-Factor Heatmap",
        height=700,
        width=1100,
        yaxis=dict(autorange="reversed"),
        margin=dict(l=140, r=80, t=100, b=100),
    )
    return heatmap_fig


def build_portfolio_df(df: pd.DataFrame, top_n: int, invest_amount: int) -> pd.DataFrame:
    portfolio_df = df.sort_values("종합점수", ascending=False).head(top_n).copy()
    total_score = portfolio_df["종합점수"].sum()
    portfolio_df["비중"] = portfolio_df["종합점수"] / total_score
    portfolio_df["투자금액"] = (portfolio_df["비중"] * invest_amount).round(0)
    portfolio_df["비중(%)"] = (portfolio_df["비중"] * 100).round(2)
    return portfolio_df[["종목명", "종합점수", "비중(%)", "투자금액", "투자스타일"]]


def write_dashboard(
    ranked_df: pd.DataFrame,
    portfolio_df: pd.DataFrame,
    bar_fig: go.Figure,
    bubble_fig: go.Figure,
    heatmap_fig: go.Figure,
) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    dashboard_path = OUTPUT_DIR / "quant_dashboard.html"

    table_html = portfolio_df.to_html(index=False, classes="styled-table", border=0)
    result_html = ranked_df[
        [
            "랭킹",
            "종목명",
            "종합점수_100",
            "작년 영업이익",
            "작년 당기순이익",
            "내후년 영업이익(E)",
            "내후년 당기순이익(E)",
            "매출액_3Y성장률",
            "영업이익_3Y성장률",
            "순이익_3Y성장률",
            "시가총액",
            "영업이익_PER",
            "순이익_PER",
            "투자스타일",
        ]
    ].to_html(index=False, classes="styled-table", border=0)
    table_html = f'<div class="table-wrap">{table_html}</div>'
    result_html = f'<div class="table-wrap">{result_html}</div>'

    bar_html = pio.to_html(bar_fig, include_plotlyjs="cdn", full_html=False)
    bubble_html = pio.to_html(bubble_fig, include_plotlyjs=False, full_html=False)
    heatmap_html = pio.to_html(heatmap_fig, include_plotlyjs=False, full_html=False)

    html_template = f"""
<html>
<head>
    <meta charset="utf-8">
    <title>Quant Multi-Factor Dashboard</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            background: linear-gradient(180deg, #eef4ff 0%, #f7f9fc 100%);
            margin: 0;
            padding: 32px;
            color: #172033;
        }}
        .page {{
            max-width: 1200px;
            margin: 0 auto;
        }}
        h1 {{
            text-align: center;
            margin-bottom: 32px;
        }}
        .chart-container {{
            margin-bottom: 32px;
            padding: 24px;
            background: white;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(22, 34, 51, 0.08);
            overflow-x: auto;
        }}
        .styled-table {{
            border-collapse: collapse;
            margin: 16px 0 0;
            font-size: 14px;
            width: 100%;
            min-width: 1400px;
        }}
        .styled-table thead tr {{
            background-color: #08306b;
            color: white;
            text-align: center;
        }}
        .styled-table th, .styled-table td {{
            padding: 12px 15px;
            text-align: center;
            white-space: normal;
            word-break: keep-all;
            overflow-wrap: break-word;
        }}
        .styled-table tbody tr:nth-child(even) {{
            background-color: #f3f6fb;
        }}
        .styled-table th:last-child,
        .styled-table td:last-child {{
            min-width: 120px;
            white-space: nowrap;
        }}
        .table-wrap {{
            width: 100%;
            overflow-x: auto;
            padding-bottom: 8px;
        }}
    </style>
</head>
<body>
    <div class="page">
        <h1>Quant Multi-Factor Dashboard</h1>
        <div class="chart-container">
            <h2>성장률 및 PER 랭킹</h2>
            {bar_html}
        </div>
        <div class="chart-container">
            <h2>Multi-Factor Heatmap</h2>
            {heatmap_html}
        </div>
        <div class="chart-container">
            <h2>성장 vs Value 버블차트</h2>
            {bubble_html}
        </div>
        <div class="chart-container">
            <h2>상위 포트폴리오 비중 예시</h2>
            {table_html}
        </div>
        <div class="chart-container">
            <h2>전체 계산 결과</h2>
            {result_html}
        </div>
    </div>
</body>
</html>
"""

    dashboard_path.write_text(html_template, encoding="utf-8")
    return dashboard_path


def save_csv_outputs(final_df: pd.DataFrame, result_df: pd.DataFrame, ranked_df: pd.DataFrame) -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    final_df.to_csv(OUTPUT_DIR / "financials_raw.csv", index=False, encoding="utf-8-sig")
    result_df.to_csv(OUTPUT_DIR / "factor_scores.csv", index=False, encoding="utf-8-sig")
    ranked_df.to_csv(OUTPUT_DIR / "ranked_portfolio.csv", index=False, encoding="utf-8-sig")


def write_web_snapshot(
    ranked_df: pd.DataFrame,
    portfolio_df: pd.DataFrame,
    incomplete_list: list[str],
    invest_amount: int,
    profile: str,
    selected_count: int,
    selected_gicodes: list[str],
) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    snapshot_path = OUTPUT_DIR / "dashboard_data.json"
    WEB_PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    public_snapshot_path = WEB_PUBLIC_DATA_DIR / "dashboard_data.json"
    top10 = ranked_df.head(10).copy()

    payload = {
        "generatedAt": datetime.now().isoformat(),
        "profile": profile,
        "investAmount": invest_amount,
        "selectedStockCount": selected_count,
        "selectedGicodes": selected_gicodes,
        "excludedStocks": incomplete_list,
        "selectionPresets": {
            "현재 기본 포트폴리오": get_top30_gicodes(),
        },
        "summary": {
            "rankedCount": int(len(ranked_df)),
            "excludedCount": int(len(incomplete_list)),
            "topScore": float(top10["종합점수_100"].max()) if not top10.empty else 0,
        },
        "topPortfolio": portfolio_df.to_dict(orient="records"),
        "topRankings": top10[
            ["랭킹", "종목명", "종합점수_100", "성장점수", "저평가점수", "투자스타일"]
        ].to_dict(orient="records"),
        "allRankings": ranked_df[
            [
                "종목코드",
                "랭킹",
                "종목명",
                "종합점수_100",
                "성장점수",
                "저평가점수",
                "투자스타일",
                "작년 영업이익",
                "작년 당기순이익",
                "내후년 영업이익(E)",
                "내후년 당기순이익(E)",
                "영업이익_PER",
                "순이익_PER",
            ]
        ].to_dict(orient="records"),
        "stockUniverse": ranked_df[["종목코드", "종목명"]].to_dict(orient="records"),
    }

    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    snapshot_path.write_text(serialized, encoding="utf-8")
    public_snapshot_path.write_text(serialized, encoding="utf-8")
    return snapshot_path


def main() -> None:
    top_n = 10
    invest_amount = 10_000_000
    profile = "균형형"

    final_df, incomplete_list = run_batch_check()
    print(f"incomplete stocks: {incomplete_list}")

    result_df = build_result_df(final_df)
    ranked_df = build_ranked_df(result_df, profile=profile)
    portfolio_df = build_portfolio_df(ranked_df, top_n=top_n, invest_amount=invest_amount)

    bar_fig = build_bar_figure(result_df)
    bubble_fig = build_bubble_figure(ranked_df)
    heatmap_fig = build_heatmap_figure(ranked_df)

    save_csv_outputs(final_df, result_df, ranked_df)
    write_web_snapshot(
        ranked_df=ranked_df,
        portfolio_df=portfolio_df,
        incomplete_list=incomplete_list,
        invest_amount=invest_amount,
        profile=profile,
        selected_count=len(get_top30_gicodes()),
        selected_gicodes=get_top30_gicodes(),
    )
    dashboard_path = write_dashboard(ranked_df, portfolio_df, bar_fig, bubble_fig, heatmap_fig)

    print(f"dashboard written to: {dashboard_path}")
    print(portfolio_df.to_string(index=False))


if __name__ == "__main__":
    main()
