from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from io import StringIO
import json
from pathlib import Path
import re
import time

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
REQUEST_RETRIES = 4
ETF_NAME_KEYWORDS = (
    "ETF",
    "ETN",
    "KODEX",
    "TIGER",
    "KOSEF",
    "KBSTAR",
    "ARIRANG",
    "HANARO",
    "ACE",
    "RISE",
    "SOL",
    "TIMEFOLIO",
    "PLUS",
    "TREX",
    "WOORI",
    "FOCUS",
)
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
    "105560",
    "055550",
    "086790",
    "032830",
    "006800",
    "071050",
    "316140",
    "138040",
    "017670",
    "030200",
    "003490",
]
PROFILE_WEIGHTS = {
    "안정형": {
        "성장": 0.20,
        "가치": 0.30,
        "ROE": 0.20,
        "순현금": 0.30,
    },
    "균형형": {
        "성장": 0.25,
        "가치": 0.25,
        "ROE": 0.25,
        "순현금": 0.25,
    },
    "공격형": {
        "성장": 0.35,
        "가치": 0.20,
        "ROE": 0.30,
        "순현금": 0.15,
    },
}

US_TOP_ASSETS = [
    {"code": "ALT:US:MSFT", "ticker": "msft.us", "name": "Microsoft"},
    {"code": "ALT:US:AAPL", "ticker": "aapl.us", "name": "Apple"},
    {"code": "ALT:US:NVDA", "ticker": "nvda.us", "name": "NVIDIA"},
    {"code": "ALT:US:AMZN", "ticker": "amzn.us", "name": "Amazon"},
    {"code": "ALT:US:GOOGL", "ticker": "googl.us", "name": "Alphabet"},
    {"code": "ALT:US:META", "ticker": "meta.us", "name": "Meta"},
    {"code": "ALT:US:BRKB", "ticker": "brk-b.us", "name": "Berkshire Hathaway B"},
    {"code": "ALT:US:AVGO", "ticker": "avgo.us", "name": "Broadcom"},
    {"code": "ALT:US:TSLA", "ticker": "tsla.us", "name": "Tesla"},
    {"code": "ALT:US:JPM", "ticker": "jpm.us", "name": "JPMorgan Chase"},
]


def build_external_date_label(raw_label: str | None) -> str | None:
    if not raw_label:
        return None

    iso_match = re.match(r"^(\d{4}-\d{2}-\d{2})", raw_label)
    if iso_match:
        return iso_match.group(1)

    month_day_match = re.search(r"(\d{2})\.(\d{2})\.", raw_label)
    if month_day_match:
        now = datetime.now()
        return f"{now.year}-{month_day_match.group(1)}-{month_day_match.group(2)}"

    return raw_label.strip()


def build_external_datetime_label(raw_label: str | None) -> str | None:
    if not raw_label:
        return None

    iso_match = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})", raw_label)
    if iso_match:
        return f"{iso_match.group(1)} {iso_match.group(2)}"

    month_day_match = re.search(r"(\d{2})\.(\d{2})\.\s+(\d{2}:\d{2})", raw_label)
    if month_day_match:
        now = datetime.now()
        return f"{now.year}-{month_day_match.group(1)}-{month_day_match.group(2)} {month_day_match.group(3)}"

    return raw_label.strip()

def request_with_retry(url: str, method: str = "get", timeout: int = REQUEST_TIMEOUT) -> requests.Response | None:
    for attempt in range(REQUEST_RETRIES):
        try:
            response = requests.request(method, url, headers=REQUEST_HEADERS, timeout=timeout)
            response.raise_for_status()
            return response
        except requests.RequestException:
            if attempt == REQUEST_RETRIES - 1:
                return None
            time.sleep(1.5 ** attempt)
    return None


def extract_fnguide_stock_name(html: BeautifulSoup, fallback_code: str) -> str:
    title_node = html.find("h1")
    if title_node is not None:
        title_text = title_node.get_text(strip=True)
        if title_text:
            return title_text

    title_tag = html.find("title")
    if title_tag is not None:
        title_text = title_tag.get_text(strip=True)
        if title_text:
            return title_text.split("-")[0].strip()

    return fallback_code


def fetch_text(url: str) -> str | None:
    try:
        response = request_with_retry(url)
        if response is None:
            return None
        return response.text
    except Exception:
        return None


def fetch_stooq_metrics(ticker: str) -> tuple[float, str | None, float | None] | None:
    latest_csv = fetch_text(f"https://stooq.com/q/l/?s={ticker}&i=d")
    history_csv = fetch_text(f"https://stooq.com/q/d/l/?s={ticker}&i=d")
    if not latest_csv:
        return None

    parts = latest_csv.strip().split(",")
    if len(parts) < 7:
        return None

    _, date, _time, _open, _high, _low, close = parts[:7]
    price = float(close) if close not in {"", "N/D"} else None
    if price is None:
        return None

    change_pct = None
    if history_csv:
        lines = [line for line in history_csv.strip().splitlines()[1:] if line]
        if len(lines) >= 2:
            previous_row = lines[-2].split(",")
            if len(previous_row) >= 5 and previous_row[4] not in {"", "N/D"}:
                previous_close = float(previous_row[4])
                if previous_close > 0:
                    change_pct = ((price - previous_close) / previous_close) * 100

    return price, build_external_date_label(date), change_pct


def get_external_asset_snapshot() -> tuple[dict[str, object], list[dict[str, object]]]:
    exchange_rate = {
        "value": 1400,
        "asOf": None,
        "updatedAt": None,
        "changePct": None,
        "source": "네이버 증권 fallback",
        "fallback": True,
    }

    exchange_html = fetch_text("https://m.stock.naver.com/marketindex/exchange/FX_USDKRW")
    if exchange_html:
        price_match = re.search(r'"closePrice":"([\d,]+\.\d+)"', exchange_html)
        date_match = re.search(r'"localTradedAt":"([^"]+)"', exchange_html)
        ratio_match = re.search(r'"fluctuationsRatio":"?(-?[\d.]+)"?', exchange_html)
        visible_time_match = re.search(r"<time>(\d{2}\.\d{2}\.\s+\d{2}:\d{2})</time><span[^>]*>실시간</span>", exchange_html)
        if price_match:
            exchange_rate = {
                "value": float(price_match.group(1).replace(",", "")),
                "asOf": build_external_date_label(date_match.group(1) if date_match else None),
                "updatedAt": build_external_datetime_label(visible_time_match.group(1) if visible_time_match else (date_match.group(1) if date_match else None)),
                "changePct": float(ratio_match.group(1)) if ratio_match else None,
                "source": "네이버 증권",
                "fallback": False,
            }

    exchange_value = float(exchange_rate["value"])
    assets: list[dict[str, object]] = [
        {
            "code": "ALT:USD",
            "name": "달러",
            "market": "달러",
            "category": "usd_cash",
            "currentPrice": exchange_value,
            "nativePrice": 1,
            "nativeCurrency": "USD",
            "tradedAt": exchange_rate["asOf"],
            "changePct": exchange_rate.get("changePct"),
            "quantityStep": 0.01,
            "quantityPrecision": 2,
            "unitLabel": "USD",
            "priceInputMode": "krw",
        }
    ]

    gld_result = fetch_stooq_metrics("gld.us")
    if gld_result:
        native_price, traded_at, change_pct = gld_result
        assets.append(
            {
                "code": "ALT:GLD",
                "name": "금 (GLD)",
                "market": "금",
                "category": "gold",
                "currentPrice": native_price * exchange_value,
                "nativePrice": native_price,
                "nativeCurrency": "USD",
                "tradedAt": traded_at,
                "changePct": change_pct,
                "quantityStep": 1,
                "quantityPrecision": 0,
                "unitLabel": "주",
                "priceInputMode": "usd",
            }
        )

    for code, name, url, unit in [
        ("ALT:BTC", "비트코인", "https://m.stock.naver.com/crypto/UPBIT/BTC", "BTC"),
        ("ALT:ETH", "이더리움", "https://m.stock.naver.com/crypto/UPBIT/ETH", "ETH"),
    ]:
        html = fetch_text(url)
        if not html:
            continue
        price_match = re.search(r'"tradePrice":([\d.]+)', html)
        traded_at_match = re.search(r'"koreaTradedAt":"([^"]+)"', html)
        ratio_match = re.search(r'"fluctuationsRatio":(-?[\d.]+)', html) or re.search(r'"changeRate":(-?[\d.]+)', html)
        if not price_match:
            continue
        price = float(price_match.group(1))
        assets.append(
            {
                "code": code,
                "name": name,
                "market": "가상자산",
                "category": "crypto",
                "currentPrice": price,
                "nativePrice": price,
                "nativeCurrency": "KRW",
                "tradedAt": build_external_date_label(traded_at_match.group(1) if traded_at_match else None),
                "changePct": float(ratio_match.group(1)) if ratio_match else None,
                "quantityStep": 0.000001,
                "quantityPrecision": 6,
                "unitLabel": unit,
                "priceInputMode": "krw",
            }
        )

    for item in US_TOP_ASSETS:
        result = fetch_stooq_metrics(item["ticker"])
        if not result:
            continue
        native_price, traded_at, change_pct = result
        assets.append(
            {
                "code": item["code"],
                "name": item["name"],
                "market": "미국주식",
                "category": "us_stock",
                "currentPrice": native_price * exchange_value,
                "nativePrice": native_price,
                "nativeCurrency": "USD",
                "tradedAt": traded_at,
                "changePct": change_pct,
                "quantityStep": 1,
                "quantityPrecision": 0,
                "unitLabel": "주",
                "priceInputMode": "usd",
            }
        )

    return exchange_rate, assets


def load_existing_snapshot_payload() -> dict[str, object]:
    snapshot_path = WEB_PUBLIC_DATA_DIR / "dashboard_data.json"
    if not snapshot_path.exists():
        return {}

    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def get_external_asset_snapshot_with_fallback(
    existing_payload: dict[str, object] | None = None,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    existing_payload = existing_payload or {}
    snapshot_exchange_rate = existing_payload.get("exchangeRate")
    snapshot_assets = existing_payload.get("extraAssetUniverse")

    snapshot_exchange_by_code: dict[str, dict[str, object]] = {}
    if isinstance(snapshot_assets, list):
        for row in snapshot_assets:
            if not isinstance(row, dict):
                continue
            code = row.get("code")
            if isinstance(code, str):
                snapshot_exchange_by_code[code] = row

    exchange_rate, extra_assets = get_external_asset_snapshot()
    if exchange_rate.get("fallback") and isinstance(snapshot_exchange_rate, dict):
        exchange_rate = snapshot_exchange_rate

    merged_assets: list[dict[str, object]] = []
    for asset in extra_assets:
        code = asset.get("code")
        if not isinstance(code, str):
            continue
        snapshot_asset = snapshot_exchange_by_code.get(code)
        current_price = asset.get("currentPrice")
        if current_price is None and snapshot_asset is not None:
            merged_assets.append(snapshot_asset)
            continue
        merged_assets.append(asset)

    seen_codes = {
        asset.get("code")
        for asset in merged_assets
        if isinstance(asset, dict) and isinstance(asset.get("code"), str)
    }
    for code, snapshot_asset in snapshot_exchange_by_code.items():
        if code not in seen_codes:
            merged_assets.append(snapshot_asset)

    return exchange_rate, merged_assets


def load_fnguide_html(gicode: str) -> BeautifulSoup:
    url = f"https://comp.fnguide.com/SVO2/ASP/SVD_main.asp?pGB=1&gicode={gicode}"
    response = request_with_retry(url)
    if response is None:
        raise ConnectionError(f"FnGuide 요청 실패: {gicode}")
    return BeautifulSoup(response.text, "html.parser")


def parse_numeric_text(text: str) -> float | None:
    cleaned = text.replace(",", "").strip()
    if cleaned in {"", "-", "N/A"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def normalize_financial_item(item: str) -> str:
    revenue_aliases = {"매출액", "영업수익", "이자수익", "순영업수익"}
    if item in revenue_aliases:
        return "매출액"
    if item == "영업이익(발표기준)":
        return "영업이익(발표기준)"
    if item == "당기순이익":
        return "당기순이익"
    if item == "영업이익":
        return "영업이익"
    if item == "ROE" or item.startswith("ROE(") or item.startswith("ROE(%"):
        return "ROE"
    return item


def parse_yearly_financials(html: BeautifulSoup, target_items: list[str]) -> tuple[pd.DataFrame, int]:
    tables = html.find_all("table", class_="us_table_ty1 h_fix zigbg_no")
    table_y = tables[5]

    header_rows = table_y.find_all("tr")[:2]
    year_labels: list[int] = []
    if len(header_rows) >= 2:
        for cell in header_rows[1].find_all(["th", "td"]):
            text = cell.get_text(strip=True)
            match = re.search(r"(\d{4})/\d{2}", text)
            if match:
                year_labels.append(int(match.group(1)))

    rows = table_y.find_all("tr")
    raw_data: dict[str, list[float | None]] = {}

    for row in rows:
        th = row.find("th")
        if not th:
            continue
        item = th.get_text(strip=True)
        normalized_item = normalize_financial_item(item)
        if normalized_item not in target_items:
            continue

        values = []
        for td in row.find_all("td"):
            text = td.get_text(strip=True)
            values.append(parse_numeric_text(text))
        raw_data[normalized_item] = values

    this_year = int(
        html.find("tr", class_="td_gapcolor2")
        .find("span", class_="txt_acd")
        .get_text()
        .split("/")[0]
    )

    year_anchor_key = next((key for key in ["매출액", "영업이익", "당기순이익"] if key in raw_data), None)
    if year_anchor_key is None:
        raise KeyError("연간 재무 핵심 항목 없음")

    years = year_labels[: len(raw_data[year_anchor_key])]
    if not years:
        years = list(range(this_year - 5, this_year - 5 + len(raw_data[year_anchor_key])))
    operating_profit = [
        raw_data["영업이익(발표기준)"][i] if year < this_year else raw_data["영업이익"][i]
        for i, year in enumerate(years)
    ]

    yearly_data: dict[str, list[float | None] | list[int]] = {
        "연도": years,
        "매출액": raw_data["매출액"],
        "영업이익": operating_profit,
        "당기순이익": raw_data["당기순이익"],
    }
    if "ROE" in raw_data:
        yearly_data["ROE"] = raw_data["ROE"][: len(years)]

    yearly_df = pd.DataFrame(yearly_data)
    return yearly_df, this_year


def get_top30_gicodes() -> list[str]:
    return [f"A{ticker}" for ticker in DEFAULT_TICKERS]


def get_profile_weight_map(profile: str) -> dict[str, float]:
    return PROFILE_WEIGHTS.get(profile, PROFILE_WEIGHTS["균형형"])


def get_reference_date() -> str:
    if stock is None:
        return datetime.now().strftime("%Y%m%d")

    today = datetime.now()
    try:
        response = request_with_retry("https://www.google.com", method="head", timeout=5)
        if response is not None:
            header_date = response.headers.get("Date")
            if header_date:
                today = parsedate_to_datetime(header_date).astimezone().replace(tzinfo=None)
    except Exception:
        pass

    coarse_hit = None
    for offset in range(0, 420, 7):
        candidate = (today - timedelta(days=offset)).strftime("%Y%m%d")
        try:
            cap_df = stock.get_market_cap_by_ticker(candidate)
            if not cap_df.empty and "시가총액" in cap_df.columns:
                coarse_hit = today - timedelta(days=offset)
                break
        except Exception:
            continue

    if coarse_hit is not None:
        for offset in range(0, 7):
            candidate_dt = coarse_hit + timedelta(days=offset)
            candidate = candidate_dt.strftime("%Y%m%d")
            try:
                cap_df = stock.get_market_cap_by_ticker(candidate)
                if not cap_df.empty and "시가총액" in cap_df.columns:
                    return candidate
            except Exception:
                continue

    return datetime.now().strftime("%Y%m%d")


def get_market_universe(market: str) -> pd.DataFrame:
    market_type_map = {
        "KOSPI": "stockMkt",
        "KOSDAQ": "kosdaqMkt",
    }
    market_type = market_type_map.get(market)
    if market_type is None:
        raise ValueError(f"지원하지 않는 시장입니다: {market}")

    url = f"https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType={market_type}"
    response = request_with_retry(url)
    if response is None:
        raise ConnectionError(f"KRX 종목 목록 요청 실패: {market}")
    response.encoding = "euc-kr"
    df = pd.read_html(StringIO(response.text), flavor="lxml")[0]
    df["종목코드"] = df["종목코드"].astype(str).str.zfill(6)
    universe = pd.DataFrame(
        {
            "ticker": df["종목코드"],
            "gicode": "A" + df["종목코드"],
            "name": df["회사명"],
            "market": market,
        }
    )
    return universe.sort_values(["name", "ticker"]).reset_index(drop=True)


def get_market_gicodes(market: str) -> list[str]:
    return get_market_ranked_snapshot(market)["gicode"].tolist()


def get_market_ranked_snapshot(market: str) -> pd.DataFrame:
    sosok_map = {
        "KOSPI": "0",
        "KOSDAQ": "1",
    }
    sosok = sosok_map.get(market)
    if sosok is None:
        raise ValueError(f"지원하지 않는 시장입니다: {market}")

    rows: list[dict[str, object]] = []
    page = 1
    rank = 1

    while True:
        url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page={page}"
        response = request_with_retry(url)
        if response is None:
            raise ConnectionError(f"네이버 시총 페이지 요청 실패: {market} page={page}")
        soup = BeautifulSoup(response.text, "html.parser")
        table_rows = soup.select("table.type_2 tr")

        page_added = 0
        for row in table_rows:
            link = row.select_one("a.tltle")
            cells = [cell.get_text(" ", strip=True) for cell in row.find_all("td")]
            if link is None or len(cells) < 7:
                continue

            href = link.get("href", "")
            if "code=" not in href:
                continue

            code = href.split("code=")[-1][:6]
            name = link.get_text(strip=True)
            if any(keyword in name.upper() for keyword in ETF_NAME_KEYWORDS):
                continue
            market_cap_text = cells[6].replace(",", "")
            try:
                market_cap = float(market_cap_text)
            except ValueError:
                market_cap = np.nan

            rows.append(
                {
                    "ticker": code,
                    "gicode": f"A{code}",
                    "name": name,
                    "market": market,
                    "market_cap": market_cap,
                    "market_rank": rank,
                }
            )
            rank += 1
            page_added += 1

        if page_added == 0:
            break
        page += 1

    return pd.DataFrame(rows)


def get_market_top_gicodes(market: str, top_n: int | None = 30) -> list[str]:
    ranked = get_market_ranked_snapshot(market)
    gicodes = ranked["gicode"].tolist()
    return gicodes[:top_n] if top_n is not None else gicodes


def get_selection_presets() -> dict[str, list[str]]:
    presets = {"기본 관심 종목": get_top30_gicodes()}
    try:
        presets["코스피 대표 30개"] = get_market_top_gicodes("KOSPI", top_n=30)
    except Exception:
        pass
    try:
        presets["코스닥 대표 20개"] = get_market_top_gicodes("KOSDAQ", top_n=20)
    except Exception:
        pass
    try:
        presets["코스피 전체"] = get_market_gicodes("KOSPI")
    except Exception:
        pass
    try:
        presets["코스닥 전체"] = get_market_gicodes("KOSDAQ")
    except Exception:
        pass
    kospi_all = presets.get("코스피 전체", [])
    kosdaq_all = presets.get("코스닥 전체", [])
    if kospi_all or kosdaq_all:
        presets["코스피+코스닥 전체"] = [*kospi_all, *[code for code in kosdaq_all if code not in set(kospi_all)]]
    return presets


def build_stock_universe(
    selection_presets: dict[str, list[str]],
    ranked_df: pd.DataFrame,
    existing_quote_map: dict[str, dict[str, float]] | None = None,
) -> pd.DataFrame:
    ranked_frames = [get_market_ranked_snapshot("KOSPI"), get_market_ranked_snapshot("KOSDAQ")]
    combined_ranked = pd.concat(ranked_frames, ignore_index=True)
    combined_ranked["통합시총순위"] = combined_ranked["market_cap"].rank(
        method="first", ascending=False
    )

    market_ranked = combined_ranked.rename(
        columns={
            "gicode": "종목코드",
            "name": "종목명",
            "market": "시장",
            "market_rank": "시장시총순위",
            "market_cap": "시가총액",
        }
    )
    combined = market_ranked[["종목코드", "종목명", "시장", "시장시총순위", "통합시총순위", "시가총액"]].copy()

    ranked_subset = pd.DataFrame(columns=["종목코드", "현재가", "전일종가", "전일종가대비등락률"])
    if not ranked_df.empty:
        ranked_subset = ranked_df[["종목코드", "현재가", "전일종가", "전일종가대비등락률"]].drop_duplicates("종목코드")

    combined = combined.merge(ranked_subset, on="종목코드", how="left")
    if existing_quote_map:
        existing_quote_df = (
            pd.DataFrame(
                [
                    {"종목코드": code, **quote}
                    for code, quote in existing_quote_map.items()
                    if isinstance(code, str) and quote.get("현재가") is not None
                ]
            )
            .drop_duplicates("종목코드")
        )
        if not existing_quote_df.empty:
            existing_quote_df = existing_quote_df.rename(
                columns={
                    "현재가": "기존 현재가",
                    "전일종가": "기존 전일종가",
                    "전일종가대비등락률": "기존 전일종가대비등락률",
                }
            )
            combined = combined.merge(existing_quote_df, on="종목코드", how="left")
            combined["가격 fallback 사용"] = combined["현재가"].isna() & combined["기존 현재가"].notna()
            combined["현재가"] = combined["현재가"].where(combined["현재가"].notna(), combined["기존 현재가"])
            combined["전일종가"] = combined["전일종가"].where(combined["전일종가"].notna(), combined["기존 전일종가"])
            combined["전일종가대비등락률"] = combined["전일종가대비등락률"].where(
                combined["전일종가대비등락률"].notna(), combined["기존 전일종가대비등락률"]
            )
            combined = combined.drop(columns=["기존 현재가", "기존 전일종가", "기존 전일종가대비등락률"])
        else:
            combined["가격 fallback 사용"] = False
    else:
        combined["가격 fallback 사용"] = False

    preset_codes = {code for codes in selection_presets.values() for code in codes}
    filtered = combined[combined["종목코드"].isin(preset_codes)].copy()
    filtered = filtered.drop_duplicates("종목코드")
    return filtered.sort_values(["통합시총순위", "시장시총순위", "종목명"]).reset_index(drop=True)


def get_snapshot_batch_gicodes() -> list[str]:
    selection_presets = get_selection_presets()
    codes: list[str] = []
    for preset_name in ["기본 관심 종목", "코스피 대표 30개", "코스닥 대표 20개"]:
        for code in selection_presets.get(preset_name, []):
            if code not in codes:
                codes.append(code)
    return codes


def get_market_code_name_map() -> dict[str, str]:
    code_name_map: dict[str, str] = {}
    for market in ["KOSPI", "KOSDAQ"]:
        ranked_snapshot = get_market_ranked_snapshot(market)
        for row in ranked_snapshot[["gicode", "name"]].to_dict(orient="records"):
            code_name_map[row["gicode"]] = row["name"]
    return code_name_map


def pick_forecast_value(stock_df: pd.DataFrame, column: str, base_year: int) -> tuple[float | None, int | None]:
    forecast_candidates = stock_df[stock_df["연도"] >= base_year + 1].sort_values("연도")
    if forecast_candidates.empty:
        return None, None

    preferred_years = [base_year + 2, base_year + 1]
    for target_year in preferred_years:
        matched = forecast_candidates[forecast_candidates["연도"] == target_year]
        if matched.empty:
            continue
        value = matched.iloc[0][column]
        if pd.notna(value):
            return float(value), int(target_year)

    return None, None


def pick_roe_value(stock_df: pd.DataFrame, calendar_year: int) -> tuple[float | None, int | None, str | None]:
    if "ROE" not in stock_df.columns:
        return None, None, None

    current_year = stock_df[stock_df["연도"] == calendar_year]
    if not current_year.empty:
        value = current_year.iloc[0]["ROE"]
        if pd.notna(value):
            return float(value), int(calendar_year), "FnGuide 메인 재무테이블 올해 전망"

    confirmed_year = stock_df[stock_df["연도"] == calendar_year - 1]
    if not confirmed_year.empty:
        value = confirmed_year.iloc[0]["ROE"]
        if pd.notna(value):
            return float(value), int(calendar_year - 1), "FnGuide 메인 재무테이블 작년 확정"

    return None, None, None


def run_batch_check(gicodes: list[str] | None = None) -> tuple[pd.DataFrame, list[str], dict[str, str]]:
    incomplete_stocks: list[str] = []
    incomplete_reasons: dict[str, str] = {}
    all_results: list[pd.DataFrame] = []
    calendar_year = datetime.now().year

    for gicode in gicodes or get_top30_gicodes():
        try:
            html = load_fnguide_html(gicode)
            stock_name = extract_fnguide_stock_name(html, gicode)
            yearly_df, this_year = parse_yearly_financials(
                html, ["매출액", "영업이익", "영업이익(발표기준)", "당기순이익", "ROE"]
            )

            operating_forecast, operating_year = pick_forecast_value(yearly_df, "영업이익", calendar_year)
            net_forecast, net_year = pick_forecast_value(yearly_df, "당기순이익", calendar_year)
            roe_value, roe_year, roe_source = pick_roe_value(yearly_df, calendar_year)

            if operating_forecast is None or net_forecast is None or roe_value is None:
                incomplete_stocks.append(stock_name)
                missing_items: list[str] = []
                if operating_forecast is None:
                    missing_items.append("영업이익")
                if net_forecast is None:
                    missing_items.append("당기순이익")
                if roe_value is None:
                    missing_items.append("ROE")
                incomplete_reasons[stock_name] = f"{'·'.join(missing_items)} 데이터 없음"
            else:
                yearly_df["기준연도"] = this_year
                yearly_df["적용 영업이익(E)"] = operating_forecast
                yearly_df["적용 영업이익 기준연도"] = operating_year
                yearly_df["적용 당기순이익(E)"] = net_forecast
                yearly_df["적용 당기순이익 기준연도"] = net_year
                yearly_df["적용 ROE(E)"] = roe_value
                yearly_df["적용 ROE 기준연도"] = roe_year
                yearly_df["적용 ROE 소스"] = roe_source
                yearly_df["종목코드"] = gicode
                yearly_df["종목명"] = stock_name
                all_results.append(yearly_df)

            print(f"completed: {stock_name}")
        except Exception as exc:
            print(f"error: {gicode} -> {exc}")
            incomplete_stocks.append(gicode)
            incomplete_reasons[gicode] = "데이터 파싱 오류"

    final_df = pd.concat(all_results, ignore_index=True) if all_results else pd.DataFrame()
    return final_df, incomplete_stocks, incomplete_reasons


def calc_avg_growth(start: float, end: float, years: int) -> float:
    if pd.isna(start) or pd.isna(end) or years <= 0:
        return np.nan

    if end < 0:
        return np.nan

    if start > 0 and end > 0:
        return (end / start) ** (1 / years) - 1

    scale = np.mean(np.abs([start, end]))
    if scale == 0:
        return np.nan

    shift = abs(min(start, end)) + scale
    shifted_start = start + shift
    shifted_end = end + shift

    if shifted_start <= 0:
        return np.nan

    return (shifted_end / shifted_start) ** (1 / years) - 1


def get_market_cap(gicode: str) -> float:
    html = load_fnguide_html(gicode)
    try:
        cap_label = html.find("th", string="시가총액")
        cap_cell = cap_label.find_next_sibling("td") if cap_label is not None else None
        if cap_cell is None:
            return np.nan
        cap_text = cap_cell.get_text(strip=True)
        return float(cap_text.replace(",", ""))
    except Exception:
        return np.nan


def get_current_quote(gicode: str) -> dict[str, float]:
    ticker = gicode.replace("A", "")
    url = f"https://finance.naver.com/item/main.naver?code={ticker}"
    try:
        response = request_with_retry(url)
        if response is None:
            return {"현재가": np.nan, "전일종가": np.nan, "전일종가대비등락률": np.nan}
        soup = BeautifulSoup(response.text, "html.parser")
        blind = soup.select_one("p.no_today span.blind")
        if blind is None:
            return {"현재가": np.nan, "전일종가": np.nan, "전일종가대비등락률": np.nan}
        current_price = float(blind.get_text(strip=True).replace(",", ""))
        exday_node = soup.select_one("p.no_exday")
        blind_values = [node.get_text(strip=True).replace(",", "") for node in soup.select("p.no_exday em span.blind")]
        change_amount = float(blind_values[0]) if len(blind_values) >= 1 else np.nan
        daily_change_pct = float(blind_values[1]) if len(blind_values) >= 2 else np.nan

        previous_close = np.nan
        exday_text = exday_node.get_text(" ", strip=True) if exday_node else ""
        if pd.notna(change_amount):
            if "상승" in exday_text:
                previous_close = current_price - change_amount
            elif "하락" in exday_text:
                previous_close = current_price + change_amount
            else:
                previous_close = current_price
        if pd.notna(daily_change_pct):
            if "하락" in exday_text:
                daily_change_pct = -abs(daily_change_pct)
            elif "상승" in exday_text:
                daily_change_pct = abs(daily_change_pct)

        return {
            "현재가": current_price,
            "전일종가": previous_close,
            "전일종가대비등락률": daily_change_pct,
        }
    except Exception:
        return {"현재가": np.nan, "전일종가": np.nan, "전일종가대비등락률": np.nan}


def load_existing_quote_snapshot() -> dict[str, dict[str, float]]:
    snapshot_path = WEB_PUBLIC_DATA_DIR / "dashboard_data.json"
    if not snapshot_path.exists():
        return {}

    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    quote_map: dict[str, dict[str, float]] = {}
    for collection_name in ["allRankings", "stockUniverse"]:
        for row in payload.get(collection_name, []) or []:
            code = row.get("종목코드")
            if not isinstance(code, str):
                continue
            current_price = row.get("현재가")
            previous_close = row.get("전일종가")
            daily_change_pct = row.get("전일종가대비등락률")
            if current_price is None:
                continue
            quote_map[code] = {
                "현재가": current_price,
                "전일종가": previous_close,
                "전일종가대비등락률": daily_change_pct,
            }
    return quote_map


def get_finance_ratio_table(gicode: str) -> pd.DataFrame:
    url = f"https://comp.fnguide.com/SVO2/ASP/SVD_FinanceRatio.asp?pGB=1&gicode={gicode}"
    response = request_with_retry(url)
    if response is None:
        raise ConnectionError(f"재무비율 요청 실패: {gicode}")
    tables = pd.read_html(StringIO(response.text))
    if not tables:
        raise ValueError("재무비율 테이블 없음")
    return tables[0]


def extract_latest_metric(table: pd.DataFrame, keywords: list[str]) -> float:
    labels = table.iloc[:, 0].astype(str)
    row = table[labels.apply(lambda label: any(keyword in label for keyword in keywords))]
    if row.empty:
        return np.nan
    values = pd.to_numeric(row.iloc[0, 1:], errors="coerce").dropna()
    if values.empty:
        return np.nan
    return float(values.iloc[-1])


def get_quality_metrics(gicode: str) -> dict[str, float | str]:
    try:
        ratio_table = get_finance_ratio_table(gicode)
    except Exception:
        return {
            "ROE": np.nan,
            "순차입금비율": np.nan,
            "부채비율": np.nan,
            "자기자본비율": np.nan,
            "순현금지표 소스": "없음",
        }

    net_debt_ratio = extract_latest_metric(ratio_table, ["순차입금비율"])
    debt_ratio = extract_latest_metric(ratio_table, ["부채비율"])
    equity_ratio = extract_latest_metric(ratio_table, ["자기자본비율"])
    roe = extract_latest_metric(ratio_table, ["ROE"])

    if pd.notna(net_debt_ratio):
        source = "순차입금비율"
    elif pd.notna(debt_ratio):
        source = "부채비율"
    elif pd.notna(equity_ratio):
        source = "자기자본비율"
    else:
        source = "없음"

    return {
        "ROE": roe,
        "순차입금비율": net_debt_ratio,
        "부채비율": debt_ratio,
        "자기자본비율": equity_ratio,
        "순현금지표 소스": source,
    }


def calc_per(market_cap: float, profit: float) -> float:
    if pd.isna(market_cap) or pd.isna(profit) or profit <= 0 or market_cap <= 0:
        return np.nan
    return market_cap / profit


def build_result_df(final_df: pd.DataFrame, existing_quote_map: dict[str, dict[str, float]] | None = None) -> pd.DataFrame:
    result_rows: list[dict[str, float | str]] = []
    calendar_year = datetime.now().year
    existing_quote_map = existing_quote_map or {}

    for gicode in final_df["종목코드"].unique():
        stock_df = final_df[final_df["종목코드"] == gicode].sort_values("연도")
        confirmed_row = stock_df[stock_df["연도"] == calendar_year - 1]

        if confirmed_row.empty:
            continue

        stock_name = stock_df["종목명"].iloc[0]
        confirmed = confirmed_row.iloc[0]
        operating_forecast = stock_df["적용 영업이익(E)"].dropna().iloc[0] if "적용 영업이익(E)" in stock_df.columns else np.nan
        net_forecast = stock_df["적용 당기순이익(E)"].dropna().iloc[0] if "적용 당기순이익(E)" in stock_df.columns else np.nan
        forecast_roe = stock_df["적용 ROE(E)"].dropna().iloc[0] if "적용 ROE(E)" in stock_df.columns and stock_df["적용 ROE(E)"].notna().any() else np.nan
        operating_target_year = int(stock_df["적용 영업이익 기준연도"].dropna().iloc[0]) if "적용 영업이익 기준연도" in stock_df.columns else calendar_year + 2
        net_target_year = int(stock_df["적용 당기순이익 기준연도"].dropna().iloc[0]) if "적용 당기순이익 기준연도" in stock_df.columns else calendar_year + 2
        roe_target_year = int(stock_df["적용 ROE 기준연도"].dropna().iloc[0]) if "적용 ROE 기준연도" in stock_df.columns and stock_df["적용 ROE 기준연도"].notna().any() else calendar_year - 1
        operating_growth_years = max(1, operating_target_year - (calendar_year - 1))
        net_growth_years = max(1, net_target_year - (calendar_year - 1))
        market_cap = get_market_cap(gicode)
        live_quote = get_current_quote(gicode)
        fallback_quote = existing_quote_map.get(gicode)
        use_fallback_quote = pd.isna(live_quote["현재가"]) and fallback_quote is not None
        quote = fallback_quote if use_fallback_quote else live_quote
        quality_metrics = get_quality_metrics(gicode)
        roe_source = stock_df["적용 ROE 소스"].dropna().iloc[0] if "적용 ROE 소스" in stock_df.columns and stock_df["적용 ROE 소스"].notna().any() else "없음"

        result_rows.append(
            {
                "종목코드": gicode,
                "종목명": stock_name,
                "현재가": quote["현재가"],
                "전일종가": quote["전일종가"],
                "전일종가대비등락률": quote["전일종가대비등락률"],
                "가격 fallback 사용": use_fallback_quote,
                "작년 영업이익": confirmed["영업이익"],
                "작년 당기순이익": confirmed["당기순이익"],
                "내후년 영업이익(E)": operating_forecast,
                "내후년 당기순이익(E)": net_forecast,
                "영업이익 성장 기준연수": operating_growth_years,
                "순이익 성장 기준연수": net_growth_years,
                "영업이익_3Y성장률": calc_avg_growth(confirmed["영업이익"], operating_forecast, operating_growth_years),
                "순이익_3Y성장률": calc_avg_growth(confirmed["당기순이익"], net_forecast, net_growth_years),
                "시가총액": market_cap,
                "영업이익_PER": calc_per(market_cap, operating_forecast),
                "순이익_PER": calc_per(market_cap, net_forecast),
                "ROE": forecast_roe,
                "ROE 기준연도": roe_target_year,
                "ROE 소스": roe_source,
                "순차입금비율": quality_metrics["순차입금비율"],
                "부채비율": quality_metrics["부채비율"],
                "자기자본비율": quality_metrics["자기자본비율"],
                "순현금지표 소스": quality_metrics["순현금지표 소스"],
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
    df["P_ROE"] = df["ROE"].rank(pct=True)
    df["P_순차입금비율"] = 1 - df["순차입금비율"].rank(pct=True)
    df["P_부채비율"] = 1 - df["부채비율"].rank(pct=True)
    df["P_자기자본비율"] = df["자기자본비율"].rank(pct=True)

    df["성장점수"] = (df["P_영업성장"] + df["P_순이익성장"]) / 2
    df["저평가점수"] = (df["P_영업PER"] + df["P_순이익PER"]) / 2

    df["순현금점수"] = np.where(
        df["순차입금비율"].notna(),
        df["P_순차입금비율"],
        np.where(
            df["부채비율"].notna(),
            df["P_부채비율"],
            np.where(df["자기자본비율"].notna(), df["P_자기자본비율"], 0.5),
        ),
    )
    df["ROE점수"] = df["P_ROE"].fillna(0.5)

    df["기여_성장"] = weights["성장"] * df["성장점수"]
    df["기여_가치"] = weights["가치"] * df["저평가점수"]
    df["기여_ROE"] = weights["ROE"] * df["ROE점수"]
    df["기여_순현금"] = weights["순현금"] * df["순현금점수"]
    df["종합점수"] = df["기여_성장"] + df["기여_가치"] + df["기여_ROE"] + df["기여_순현금"]
    df["종합점수_100"] = df["종합점수"] * 100
    df = df.sort_values("종합점수_100", ascending=False).reset_index(drop=True)
    df["랭킹"] = range(1, len(df) + 1)

    def classify(row: pd.Series) -> str:
        if row["성장점수"] >= 0.6 and row["저평가점수"] >= 0.6:
            return "고성장 저평가"
        if row["성장점수"] >= 0.6:
            return "성장형"
        if row["저평가점수"] >= 0.6:
            return "가치형"
        return "균형 관찰형"

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
    invest_amount: int = 20_000_000,
    top_n: int = 10,
) -> dict[str, object]:
    final_df, incomplete_list, incomplete_reasons = run_batch_check(gicodes=gicodes)
    result_df = build_result_df(final_df)
    ranked_df = build_ranked_df(result_df, profile=profile)
    portfolio_df = build_portfolio_df(ranked_df, top_n=top_n, invest_amount=invest_amount)
    return {
        "final_df": final_df,
        "result_df": result_df,
        "ranked_df": ranked_df,
        "portfolio_df": portfolio_df,
        "incomplete_list": incomplete_list,
        "incomplete_reasons": incomplete_reasons,
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
    bubble_sizes = (plot_df["종합점수_100"].fillna(0) / 2).replace([np.inf, -np.inf], 0)
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
                    size=bubble_sizes.tolist(),
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
    heatmap_df = (
        top10[["종목명", "성장점수", "저평가점수", "ROE점수", "순현금점수"]]
        .rename(columns={"성장점수": "성장", "저평가점수": "가치(PER)", "ROE점수": "ROE", "순현금점수": "순현금"})
        .set_index("종목명")
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
    total_score = (portfolio_df["종합점수"] ** 2).sum()
    portfolio_df["비중"] = (portfolio_df["종합점수"] ** 2) / total_score
    portfolio_df["투자금액"] = (portfolio_df["비중"] * invest_amount).round(0)
    portfolio_df["비중(%)"] = (portfolio_df["비중"] * 100).round(2)
    return portfolio_df[
        ["종목코드", "종목명", "현재가", "종합점수", "비중(%)", "투자금액", "투자스타일", "ROE", "순현금점수"]
    ]


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
            "성장점수",
            "저평가점수",
            "ROE점수",
            "순현금점수",
            "작년 영업이익",
            "작년 당기순이익",
            "내후년 영업이익(E)",
            "내후년 당기순이익(E)",
            "영업이익_3Y성장률",
            "순이익_3Y성장률",
            "시가총액",
            "영업이익_PER",
            "순이익_PER",
            "ROE",
            "순차입금비율",
            "부채비율",
            "자기자본비율",
            "순현금지표 소스",
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


def load_existing_final_df() -> pd.DataFrame | None:
    source_path = OUTPUT_DIR / "financials_raw.csv"
    if not source_path.exists():
        return None
    try:
        return pd.read_csv(source_path, encoding="utf-8-sig")
    except Exception:
        return None


def load_existing_snapshot_meta() -> dict[str, str | None]:
    payload = load_existing_snapshot_payload()
    if not payload:
        return {
            "priceUpdatedAt": None,
            "forecastUpdatedAt": None,
        }
    meta = payload.get("domesticDataMeta", {})
    if not isinstance(meta, dict):
        return {
            "priceUpdatedAt": None,
            "forecastUpdatedAt": None,
            "priceFallbackCount": None,
        }
    return {
        "priceUpdatedAt": meta.get("priceUpdatedAt"),
        "forecastUpdatedAt": meta.get("forecastUpdatedAt"),
        "priceFallbackCount": meta.get("priceFallbackCount"),
    }


def write_snapshot_payload(payload: dict[str, object]) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    snapshot_path = OUTPUT_DIR / "dashboard_data.json"
    WEB_PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    public_snapshot_path = WEB_PUBLIC_DATA_DIR / "dashboard_data.json"
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    snapshot_path.write_text(serialized, encoding="utf-8")
    public_snapshot_path.write_text(serialized, encoding="utf-8")
    return snapshot_path


def collect_snapshot_domestic_codes(payload: dict[str, object]) -> list[str]:
    codes: list[str] = []
    seen: set[str] = set()

    for collection_name in ["allRankings", "topRankings", "topPortfolio", "stockUniverse"]:
        rows = payload.get(collection_name)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = row.get("종목코드")
            if not isinstance(code, str) or not code.startswith("A") or code in seen:
                continue
            seen.add(code)
            codes.append(code)

    return codes


def apply_snapshot_domestic_price_update(
    payload: dict[str, object],
    price_updated_at: str,
) -> tuple[dict[str, object], int]:
    updated_payload = json.loads(json.dumps(payload, ensure_ascii=False))
    quote_map = load_existing_quote_snapshot()
    fallback_codes: set[str] = set()

    live_quote_map: dict[str, dict[str, float]] = {}
    for code in collect_snapshot_domestic_codes(updated_payload):
        live_quote = get_current_quote(code)
        fallback_quote = quote_map.get(code)
        use_fallback_quote = pd.isna(live_quote["현재가"]) and fallback_quote is not None
        quote = fallback_quote if use_fallback_quote else live_quote
        if use_fallback_quote:
            fallback_codes.add(code)
        live_quote_map[code] = {
            "현재가": None if pd.isna(quote["현재가"]) else quote["현재가"],
            "전일종가": None if pd.isna(quote["전일종가"]) else quote["전일종가"],
            "전일종가대비등락률": None if pd.isna(quote["전일종가대비등락률"]) else quote["전일종가대비등락률"],
        }

    for collection_name in ["allRankings", "topRankings", "topPortfolio", "stockUniverse"]:
        rows = updated_payload.get(collection_name)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = row.get("종목코드")
            if not isinstance(code, str):
                continue
            quote = live_quote_map.get(code)
            if quote is None:
                continue
            row["현재가"] = quote["현재가"]
            if "전일종가" in row:
                row["전일종가"] = quote["전일종가"]
            if "전일종가대비등락률" in row:
                row["전일종가대비등락률"] = quote["전일종가대비등락률"]

    updated_payload["generatedAt"] = datetime.now().isoformat()
    domestic_meta = updated_payload.get("domesticDataMeta")
    if not isinstance(domestic_meta, dict):
        domestic_meta = {}
        updated_payload["domesticDataMeta"] = domestic_meta
    domestic_meta["priceUpdatedAt"] = price_updated_at
    domestic_meta["priceFallbackCount"] = len(fallback_codes)

    return updated_payload, len(fallback_codes)


def write_web_snapshot(
    ranked_df: pd.DataFrame,
    portfolio_df: pd.DataFrame,
    stock_universe: pd.DataFrame,
    incomplete_list: list[str],
    incomplete_reasons: dict[str, str],
    invest_amount: int,
    profile: str,
    selected_count: int,
    selected_gicodes: list[str],
    price_updated_at: str,
    forecast_updated_at: str | None,
    price_fallback_count: int = 0,
    existing_payload: dict[str, object] | None = None,
    refresh_external_assets: bool = True,
) -> Path:
    existing_payload = existing_payload or {}
    top10 = ranked_df.head(10).copy()
    selection_presets = get_selection_presets()
    market_code_name_map = get_market_code_name_map()
    code_name_map = {
        row["종목코드"]: row["종목명"]
        for row in stock_universe[["종목코드", "종목명"]].drop_duplicates("종목코드").to_dict(orient="records")
    }
    normalized_excluded = [
        market_code_name_map.get(item, code_name_map.get(item, item))
        if isinstance(item, str) and item.startswith("A")
        else item
        for item in incomplete_list
    ]
    excluded_details = [
        {
            "종목명": normalized_name,
            "사유": incomplete_reasons.get(raw_name, "데이터 확인 필요"),
        }
        for raw_name, normalized_name in zip(incomplete_list, normalized_excluded)
    ]

    def sanitize_records(df: pd.DataFrame, columns: list[str]) -> list[dict[str, object]]:
        cleaned = df[columns].replace([np.inf, -np.inf], np.nan).astype(object)
        cleaned = cleaned.where(pd.notna(cleaned), None)
        return cleaned.to_dict(orient="records")

    if refresh_external_assets:
        exchange_rate, extra_asset_universe = get_external_asset_snapshot_with_fallback(existing_payload)
    else:
        exchange_rate = existing_payload.get("exchangeRate")
        extra_asset_universe = existing_payload.get("extraAssetUniverse")
        if not isinstance(exchange_rate, dict):
            exchange_rate, _ = get_external_asset_snapshot_with_fallback(existing_payload)
        if not isinstance(extra_asset_universe, list):
            _, extra_asset_universe = get_external_asset_snapshot_with_fallback(existing_payload)

    payload = {
        "generatedAt": datetime.now().isoformat(),
        "domesticDataMeta": {
            "priceUpdatedAt": price_updated_at,
            "forecastUpdatedAt": forecast_updated_at,
            "priceFallbackCount": price_fallback_count,
        },
        "exchangeRate": exchange_rate,
        "extraAssetUniverse": extra_asset_universe,
        "profile": profile,
        "investAmount": invest_amount,
        "selectedStockCount": selected_count,
        "selectedGicodes": selected_gicodes,
        "excludedStocks": normalized_excluded,
        "excludedDetails": excluded_details,
        "selectionPresets": selection_presets,
        "summary": {
            "rankedCount": int(len(ranked_df)),
            "excludedCount": int(len(incomplete_list)),
            "topScore": float(top10["종합점수_100"].max()) if not top10.empty else 0,
        },
        "topPortfolio": sanitize_records(
            portfolio_df,
            ["종목코드", "종목명", "현재가", "종합점수", "비중(%)", "투자금액", "투자스타일", "ROE", "순현금점수"],
        ),
        "topRankings": sanitize_records(
            top10,
            ["종목코드", "랭킹", "종목명", "현재가", "전일종가", "전일종가대비등락률", "종합점수_100", "성장점수", "저평가점수", "ROE점수", "순현금점수", "투자스타일"],
        ),
        "allRankings": sanitize_records(
            ranked_df,
            [
                "종목코드",
                "랭킹",
                "종목명",
                "현재가",
                "전일종가",
                "전일종가대비등락률",
                "종합점수_100",
                "성장점수",
                "저평가점수",
                "ROE점수",
                "순현금점수",
                "투자스타일",
                "작년 영업이익",
                "작년 당기순이익",
                "내후년 영업이익(E)",
                "내후년 당기순이익(E)",
                "영업이익_3Y성장률",
                "순이익_3Y성장률",
                "영업이익_PER",
                "순이익_PER",
                "ROE",
                "순차입금비율",
                "부채비율",
                "자기자본비율",
                "순현금지표 소스",
            ],
        ),
        "stockUniverse": sanitize_records(
            stock_universe,
            ["종목코드", "종목명", "시장", "시장시총순위", "통합시총순위", "시가총액", "현재가", "전일종가", "전일종가대비등락률"],
        ),
    }
    return write_snapshot_payload(payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--price-only", action="store_true", help="Reuse the latest forecast snapshot and refresh current prices only.")
    parser.add_argument("--domestic-price-only", action="store_true", help="Refresh domestic stock prices only and keep the latest external asset snapshot.")
    parser.add_argument("--external-price-only", action="store_true", help="Refresh external asset prices only and keep the latest domestic snapshot.")
    args = parser.parse_args()
    domestic_price_only = args.price_only or args.domestic_price_only

    if domestic_price_only and args.external_price_only:
        raise ValueError("--external-price-only cannot be combined with domestic price refresh options.")

    top_n = 10
    invest_amount = 20_000_000
    profile = "균형형"
    now_iso = datetime.now().isoformat()
    existing_payload = load_existing_snapshot_payload()

    if args.external_price_only:
        if not existing_payload:
            raise FileNotFoundError("기존 dashboard_data.json이 없어 외부자산만 갱신할 수 없습니다.")

        existing_payload["generatedAt"] = now_iso
        exchange_rate, extra_asset_universe = get_external_asset_snapshot_with_fallback(existing_payload)
        existing_payload["exchangeRate"] = exchange_rate
        existing_payload["extraAssetUniverse"] = extra_asset_universe
        snapshot_path = write_snapshot_payload(existing_payload)
        print(f"external asset snapshot written to: {snapshot_path}")
        return

    if domestic_price_only:
        if not existing_payload:
            raise FileNotFoundError("기존 dashboard_data.json이 없어 국내 가격만 갱신할 수 없습니다.")
        updated_payload, price_fallback_count = apply_snapshot_domestic_price_update(existing_payload, now_iso)
        snapshot_path = write_snapshot_payload(updated_payload)
        print(f"domestic price snapshot written to: {snapshot_path}")
        print(f"price fallback count: {price_fallback_count}")
        return

    final_df, incomplete_list, incomplete_reasons = run_batch_check(gicodes=get_snapshot_batch_gicodes())
    forecast_updated_at = now_iso

    print(f"incomplete stocks: {incomplete_list}")

    existing_quote_map = load_existing_quote_snapshot()
    result_df = build_result_df(final_df, existing_quote_map=existing_quote_map)
    ranked_df = build_ranked_df(result_df, profile=profile)
    portfolio_df = build_portfolio_df(ranked_df, top_n=top_n, invest_amount=invest_amount)
    selection_presets = get_selection_presets()
    stock_universe = build_stock_universe(selection_presets, ranked_df, existing_quote_map=existing_quote_map)
    price_fallback_codes = set()
    if "가격 fallback 사용" in result_df.columns:
        price_fallback_codes.update(
            result_df.loc[result_df["가격 fallback 사용"].fillna(False).astype(bool), "종목코드"].astype(str).tolist()
        )
    if "가격 fallback 사용" in stock_universe.columns:
        price_fallback_codes.update(
            stock_universe.loc[stock_universe["가격 fallback 사용"].fillna(False).astype(bool), "종목코드"].astype(str).tolist()
        )
    price_fallback_count = len(price_fallback_codes)

    bar_fig = build_bar_figure(result_df)
    bubble_fig = build_bubble_figure(ranked_df)
    heatmap_fig = build_heatmap_figure(ranked_df)

    save_csv_outputs(final_df, result_df, ranked_df)
    write_web_snapshot(
        ranked_df=ranked_df,
        portfolio_df=portfolio_df,
        stock_universe=stock_universe,
        incomplete_list=incomplete_list,
        incomplete_reasons=incomplete_reasons,
        invest_amount=invest_amount,
        profile=profile,
        selected_count=len(get_top30_gicodes()),
        selected_gicodes=get_top30_gicodes(),
        price_updated_at=now_iso,
        forecast_updated_at=forecast_updated_at,
        price_fallback_count=price_fallback_count,
        existing_payload=existing_payload,
        refresh_external_assets=not domestic_price_only,
    )
    dashboard_path = write_dashboard(ranked_df, portfolio_df, bar_fig, bubble_fig, heatmap_fig)

    print(f"dashboard written to: {dashboard_path}")
    print(portfolio_df.to_string(index=False))


if __name__ == "__main__":
    main()
