from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from portfolio_dashboard import (
    build_bar_figure,
    build_bubble_figure,
    build_heatmap_figure,
    build_rebalancing_df,
    get_market_universe,
    get_profile_weight_map,
    get_selection_presets,
    run_portfolio_pipeline,
    stock,
)


DEFAULT_INVEST_AMOUNT = 10_000_000
DEFAULT_TOP_N = 10


@st.cache_data(ttl=60 * 60)
def load_selection_presets() -> dict[str, list[str]]:
    return get_selection_presets()


@st.cache_data(ttl=60 * 60)
def load_market_universe() -> pd.DataFrame:
    frames = []
    if stock is None:
        return pd.DataFrame(columns=["ticker", "gicode", "name", "market"])

    for market in ["KOSPI", "KOSDAQ"]:
        try:
            frames.append(get_market_universe(market))
        except Exception:
            continue

    if not frames:
        return pd.DataFrame(columns=["ticker", "gicode", "name", "market"])
    return pd.concat(frames, ignore_index=True)


@st.cache_data(show_spinner=False)
def run_cached_pipeline(
    gicodes: tuple[str, ...],
    profile: str,
    invest_amount: int,
    top_n: int,
) -> dict[str, object]:
    return run_portfolio_pipeline(
        gicodes=list(gicodes),
        profile=profile,
        invest_amount=invest_amount,
        top_n=top_n,
    )


def build_rebalancing_chart(rebalancing_df: pd.DataFrame) -> go.Figure:
    chart_df = rebalancing_df.copy()
    chart_df = chart_df.sort_values("변경금액")
    colors = ["#16a34a" if value >= 0 else "#dc2626" for value in chart_df["변경금액"]]

    fig = go.Figure(
        data=[
            go.Bar(
                x=chart_df["변경금액"].tolist(),
                y=chart_df["종목명"].tolist(),
                orientation="h",
                marker_color=colors,
                text=[f"{value:,.0f}원" for value in chart_df["변경금액"]],
                textposition="outside",
                cliponaxis=False,
            )
        ]
    )
    fig.update_layout(
        title="기존 포트폴리오 대비 매수/매도 필요 금액",
        height=520,
        margin=dict(l=140, r=100, t=70, b=40),
    )
    fig.update_yaxes(autorange="reversed")
    return fig


def sync_selection(preset_values: list[str]) -> None:
    st.session_state["selected_gicodes"] = preset_values


def main() -> None:
    st.set_page_config(page_title="포트폴리오 추천 앱", layout="wide")
    st.title("투자 포트폴리오 추천 초안")
    st.caption("종목 선택, 투자 성향, 투자금, 기존 보유 포트폴리오를 바탕으로 추천안을 계산합니다.")

    presets = load_selection_presets()
    market_universe = load_market_universe()
    gicode_to_label = {}
    for _, row in market_universe.iterrows():
        gicode_to_label[row["gicode"]] = f'{row["name"]} ({row["ticker"]}, {row["market"]})'

    for preset_name, gicodes in presets.items():
        for gicode in gicodes:
            gicode_to_label.setdefault(gicode, gicode)

    default_selection = presets.get("현재 기본 포트폴리오", [])
    if "selected_gicodes" not in st.session_state:
        st.session_state["selected_gicodes"] = default_selection

    with st.sidebar:
        st.header("설정")
        st.subheader("빠른 종목 선택")
        preset_columns = st.columns(2)
        preset_names = [
            "현재 기본 포트폴리오",
            "KOSPI Top 30",
            "KOSDAQ Top 30",
            "KOSPI 전체",
            "KOSDAQ 전체",
        ]
        for index, preset_name in enumerate(preset_names):
            if preset_name not in presets:
                continue
            with preset_columns[index % 2]:
                if st.button(preset_name, use_container_width=True):
                    sync_selection(presets[preset_name])
        if st.button("전체 해제", use_container_width=True):
            sync_selection([])

        selected_gicodes = st.multiselect(
            "개별 종목 미세 조정",
            options=sorted(gicode_to_label.keys(), key=lambda code: gicode_to_label[code]),
            default=st.session_state["selected_gicodes"],
            format_func=lambda code: gicode_to_label[code],
            key="selected_gicodes",
        )

        profile = st.radio("투자 성향", options=["안정형", "균형형", "공격형"], index=1)
        weight_map = get_profile_weight_map(profile)
        st.caption(
            "성장 가중치 "
            f"{int((weight_map['영업성장'] + weight_map['순이익성장']) * 100)} / "
            "저평가 가중치 "
            f"{int((weight_map['영업PER'] + weight_map['순이익PER']) * 100)}"
        )

        invest_amount = int(
            st.number_input(
                "투자금",
                min_value=1_000_000,
                value=DEFAULT_INVEST_AMOUNT,
                step=1_000_000,
                format="%d",
            )
        )
        top_n = st.slider("상위 종목 수", min_value=5, max_value=20, value=DEFAULT_TOP_N)

    if not selected_gicodes:
        st.warning("최소 1개 이상의 종목을 선택해 주세요.")
        return

    with st.spinner("포트폴리오를 계산하고 있습니다..."):
        result = run_cached_pipeline(tuple(selected_gicodes), profile, invest_amount, top_n)

    final_df = result["final_df"]
    result_df = result["result_df"]
    ranked_df = result["ranked_df"]
    portfolio_df = result["portfolio_df"]
    incomplete_list = result["incomplete_list"]

    summary_cols = st.columns(4)
    summary_cols[0].metric("선택 종목 수", len(selected_gicodes))
    summary_cols[1].metric("계산 성공 종목 수", len(ranked_df))
    summary_cols[2].metric("자동 제외 종목 수", len(incomplete_list))
    summary_cols[3].metric("투자금", f"{invest_amount:,.0f}원")

    if incomplete_list:
        st.info("실적 전망치 결측 등으로 자동 제외된 종목: " + ", ".join(incomplete_list))

    chart_col1, chart_col2 = st.columns(2)
    with chart_col1:
        st.plotly_chart(build_bar_figure(result_df), use_container_width=True)
    with chart_col2:
        st.plotly_chart(build_bubble_figure(ranked_df), use_container_width=True)

    st.plotly_chart(build_heatmap_figure(ranked_df), use_container_width=True)

    st.subheader("추천 포트폴리오")
    st.dataframe(portfolio_df, use_container_width=True, hide_index=True)

    st.subheader("기존 포트폴리오 입력")
    if "current_positions" not in st.session_state:
        st.session_state["current_positions"] = pd.DataFrame(
            [
                {"종목명": portfolio_df.iloc[0]["종목명"], "현재평가금액": invest_amount * 0.3},
                {"종목명": portfolio_df.iloc[1]["종목명"], "현재평가금액": invest_amount * 0.2},
            ]
        )

    editable_positions = st.data_editor(
        st.session_state["current_positions"],
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "종목명": st.column_config.SelectboxColumn(
                "종목명",
                options=ranked_df["종목명"].tolist(),
            ),
            "현재평가금액": st.column_config.NumberColumn(
                "현재평가금액",
                min_value=0,
                step=100_000,
                format="%d",
            ),
        },
        key="positions_editor",
    )
    st.session_state["current_positions"] = editable_positions

    rebalancing_df = build_rebalancing_df(portfolio_df, editable_positions, invest_amount)
    if not rebalancing_df.empty:
        st.subheader("리밸런싱 제안")
        rebalancing_cols = st.columns(2)
        with rebalancing_cols[0]:
            st.plotly_chart(build_rebalancing_chart(rebalancing_df), use_container_width=True)
        with rebalancing_cols[1]:
            st.dataframe(
                rebalancing_df[
                    [
                        "종목명",
                        "현재평가금액",
                        "추천금액",
                        "변경금액",
                        "액션",
                    ]
                ],
                use_container_width=True,
                hide_index=True,
            )

    st.subheader("전체 계산 결과")
    st.dataframe(
        ranked_df[
            [
                "랭킹",
                "종목명",
                "종합점수_100",
                "성장점수",
                "저평가점수",
                "투자스타일",
            ]
        ],
        use_container_width=True,
        hide_index=True,
    )

    with st.expander("원시 데이터 보기"):
        st.dataframe(final_df, use_container_width=True, hide_index=True)


if __name__ == "__main__":
    main()
