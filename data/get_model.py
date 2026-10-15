import json
import os
import re
import sys
import time
from pathlib import Path

import pandas as pd
import tushare as ts


def _load_prototype_dotenv() -> None:
    """读取 prototype/.env（与 sync 脚本一致）；不覆盖已在环境里的键。"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if not key:
            continue
        os.environ.setdefault(key, val)


# 1. 环境准备：禁用代理
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
os.environ['all_proxy'] = ''

_load_prototype_dotenv()

_token = os.environ.get("TUSHARE_TOKEN", "").strip()
if not _token:
    raise RuntimeError(
        "未设置环境变量 TUSHARE_TOKEN。请在 prototype/.env 中取消注释并填写 TUSHARE_TOKEN=你的token，"
        "或在系统/用户环境变量中配置后再运行。"
    )
ts.set_token(_token)
pro = ts.pro_api()


def normalize_stock_code(csv_code: str) -> str:
    s = str(csv_code).strip().upper()
    for suf in ('.SH', '.SZ', '.BJ'):
        if s.endswith(suf):
            return s[:-len(suf)]
    return s


def get_refined_dividend_metrics(ts_code, stock_name):
    print(f"正在处理: {stock_name}({ts_code}) ...", file=sys.stderr, flush=True)

    # 获取上市日期
    try:
        basic_info = pro.stock_basic(ts_code=ts_code, fields='list_date')
        list_date = basic_info['list_date'].iloc[0] if not basic_info.empty else '20160101'
    except Exception:
        list_date = '20160101'

    # 1. 获取行情 (前复权)
    try:
        df_price = ts.pro_bar(ts_code=ts_code, adj='qfq', start_date=list_date)
        if df_price is None or df_price.empty:
            return pd.DataFrame()
        df_price['year'] = pd.to_datetime(df_price['trade_date']).dt.year
        annual_price = df_price.groupby('year').agg({'high': 'max', 'low': 'min'}).rename(
            columns={'high': '年内最高(前复权)', 'low': '年内最低(前复权)'})
    except Exception:
        annual_price = pd.DataFrame()

    # 2. 获取分红数据并执行“报告期去重+年内加总”逻辑
    try:
        df_div = pro.dividend(ts_code=ts_code)
        if not df_div.empty:
            proc_map = {'实施': 1, '股东大会通过': 2, '预案': 3}
            df_div['proc_priority'] = df_div['div_proc'].map(proc_map).fillna(4)
            df_div = df_div.sort_values(['end_date', 'proc_priority', 'ann_date'], ascending=[True, True, False])
            df_unique_periods = df_div.drop_duplicates(subset=['end_date'], keep='first')
            df_unique_periods['year'] = pd.to_datetime(df_unique_periods['end_date']).dt.year
            annual_div = df_unique_periods.groupby('year')['cash_div_tax'].sum().to_frame('每股分红_总计')
        else:
            annual_div = pd.DataFrame(columns=['每股分红_总计'])
    except Exception as e:
        print(f"分红数据处理失败: {e}", file=sys.stderr, flush=True)
        annual_div = pd.DataFrame(columns=['每股分红_总计'])

    # 3. 获取年度EPS (利润表)
    try:
        df_income = pro.income(ts_code=ts_code, report_type='1', fields='end_date,basic_eps,diluted_eps')
        df_income = df_income[df_income['end_date'].str.endswith('1231')]
        df_income['year'] = pd.to_datetime(df_income['end_date']).dt.year
        annual_eps = df_income.sort_values('end_date').groupby('year').last()[['basic_eps', 'diluted_eps']]
        annual_eps.columns = ['基本EPS', '稀释EPS']
    except Exception:
        annual_eps = pd.DataFrame(columns=['基本EPS', '稀释EPS'])

    result = annual_price.join([annual_div, annual_eps], how='left').fillna(0)
    result['股利支付率_计算(%)'] = result.apply(
        lambda x: round((x['每股分红_总计'] / x['基本EPS'] * 100), 2) if x['基本EPS'] > 0 else 0, axis=1
    )
    result.insert(0, '股票名称', stock_name)
    result.insert(0, '股票代码', ts_code)
    return result


def resolve_ts_code_and_name(query: str) -> tuple[str, str]:
    q = (query or "").strip()
    if not q:
        raise ValueError("请输入股票代码或简称")
    qu = q.upper().replace("ＳＨ", ".SH").replace("ＳＺ", ".SZ").replace("ＢＪ", ".BJ")
    if re.match(r"^\d{6}\.(SH|SZ|BJ)$", qu):
        df = pro.stock_basic(ts_code=qu, fields="ts_code,name")
        if df.empty:
            raise ValueError(f"未找到股票: {qu}")
        return str(df.iloc[0]["ts_code"]), str(df.iloc[0]["name"])
    m = re.match(r"^(\d{6})$", q)
    if m:
        digits = m.group(1)
        for ex in ("SH", "SZ", "BJ"):
            ts = f"{digits}.{ex}"
            df = pro.stock_basic(ts_code=ts, fields="ts_code,name")
            if not df.empty:
                return str(df.iloc[0]["ts_code"]), str(df.iloc[0]["name"])
        raise ValueError(f"未找到 A 股代码 {digits}（已尝试 .SH/.SZ/.BJ）")
    # 按名称/简称：使用 stock_basic 的 name 参数，由 Tushare 服务端筛选，无需拉全市场
    df = pro.stock_basic(list_status="L", fields="ts_code,name", name=q)
    if df is None or df.empty:
        raise ValueError(
            f"未找到名称「{q}」。请使用行情里的完整股票简称（如 中国银行），或输入 6 位代码。"
        )
    if len(df) > 1:
        hint = "、".join(f"{row['name']}({row['ts_code']})" for _, row in df.head(8).iterrows())
        raise ValueError(f"「{q}」匹配到多只股票，请改用 6 位代码：{hint}")
    r = df.iloc[0]
    return str(r["ts_code"]), str(r["name"])


def merge_stock_into_csv(csv_path: str, ts_code: str, new_df: pd.DataFrame) -> None:
    new_df = new_df.reset_index()
    t_norm = normalize_stock_code(ts_code)
    if os.path.isfile(csv_path):
        old = pd.read_csv(csv_path, encoding="utf-8-sig")
        mask = old["股票代码"].map(lambda x: normalize_stock_code(x)) != t_norm
        old = old.loc[mask]
        combined = pd.concat([old, new_df], ignore_index=True)
    else:
        combined = new_df
    combined.to_csv(csv_path, encoding="utf_8_sig", index=False)


def run_add_single(query: str) -> None:
    ts_code, stock_name = resolve_ts_code_and_name(query)
    time.sleep(0.35)
    df = get_refined_dividend_metrics(ts_code, stock_name)
    if df.empty:
        print("ADD_STOCK_JSON:" + json.dumps({"ok": False, "error": "未取到行情或数据为空"}, ensure_ascii=False), flush=True)
        sys.exit(2)
    _dir = os.path.dirname(os.path.abspath(__file__))
    out_csv = os.path.join(_dir, "stock_dividend.csv")
    merge_stock_into_csv(out_csv, ts_code, df)
    short = normalize_stock_code(ts_code)
    print(
        "ADD_STOCK_JSON:"
        + json.dumps(
            {"ok": True, "stock_code": short, "stock_name": stock_name, "ts_code": ts_code, "rows": int(len(df))},
            ensure_ascii=False,
        ),
        flush=True,
    )


def run_default_batch() -> None:
    stock_list = {
        "600036.SH": "招商银行", "600900.SH": "长江电力", "601088.SH": "中国神华",
        "000651.SZ": "格力电器", "002714.SZ": "牧原股份", "300498.SZ": "温氏股份",
        "601985.SH": "中国核电", "000999.SZ": "华润三九", "600332.SH": "白云山",
        "002004.SZ": "华邦健康", "603551.SH": "奥普科技", "600983.SH": "惠而浦",
        "600066.SH": "宇通客车", "605337.SH": "李子园",
    }
    all_dfs = []
    for code, name in stock_list.items():
        try:
            d = get_refined_dividend_metrics(code, name)
            all_dfs.append(d)
            time.sleep(1.2)
        except Exception as e:
            print(f"[{name}] 处理异常: {e}", file=sys.stderr, flush=True)
    if all_dfs:
        final_report = pd.concat(all_dfs)
        _out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stock_dividend.csv")
        final_report.to_csv(_out, encoding="utf_8_sig")
        print("\n--- 任务完成：已按报告期去重并加总年内分红 ---", file=sys.stderr, flush=True)


def _add_query_from_argv() -> str:
    """优先环境变量（避免 Windows 下中文进 argv 乱码），否则用 --add 的第三个参数。"""
    env_q = os.environ.get("ADD_STOCK_QUERY", "").strip()
    if env_q:
        return env_q
    if len(sys.argv) >= 3 and sys.argv[1] == "--add":
        return (sys.argv[2] or "").strip()
    return ""


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] in ("--add", "--add-from-env"):
        q = _add_query_from_argv()
        if not q:
            print("ADD_STOCK_JSON:" + json.dumps({"ok": False, "error": "缺少股票代码或简称（请设置 ADD_STOCK_QUERY 或传入参数）"}, ensure_ascii=False), flush=True)
            sys.exit(2)
        try:
            run_add_single(q)
        except Exception as e:
            print("ADD_STOCK_JSON:" + json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False), flush=True)
            sys.exit(1)
    else:
        run_default_batch()
