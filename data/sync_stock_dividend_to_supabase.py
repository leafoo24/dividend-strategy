"""
将 get_model.py 生成的 stock_dividend.csv 同步到 Supabase yearly_dividends。

环境变量（必填）:
  SUPABASE_URL                 例如 https://xxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    服务角色密钥（可绕过 RLS；勿提交到仓库）

若 yearly_dividends 缺少 CSV 中的列，请先在 Supabase 执行:
  prototype/supabase/migrations/20260503000001_yearly_dividends_csv_columns.sql

yearly_dividends 需存在 UNIQUE(stock_code, year)（或等价唯一索引），on_conflict 才能生效。
若库中对 yearly_dividends.stock_code 建了指向 dividend_records 的外键，本脚本会在 upsert 前自动补全缺失的 holdings / dividend_records 行。

CSV 列 → yearly_dividends（核心字段，与 stock_dividend.csv 表头一致）:
  year                  → year
  股票代码              → stock_code（会去掉 .SH/.SZ/.BJ 后缀以与持仓代码一致）
  年内最高(前复权)      → year_high_price
  年内最低(前复权)      → year_low_price
  每股分红_总计         → dividend_per_share
  股利支付率_计算(%)    → payout_ratio
另有: 股票名称→stock_name, 基本EPS→basic_eps, 稀释EPS→diluted_eps（需库表有对应列）
并据分红与高低价计算 max_dividend_yield / min_dividend_yield / spread；bond_yield 有历史行则保留，否则写 0（满足库 NOT NULL）。

用法（在 prototype 目录下）:
  python data/sync_stock_dividend_to_supabase.py
  python data/sync_stock_dividend_to_supabase.py path/to/stock_dividend.csv
  python data/sync_stock_dividend_to_supabase.py --only 600900
"""
from __future__ import annotations

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote


def _load_prototype_dotenv() -> None:
    """读取 prototype/.env，便于与前端共用 VITE_SUPABASE_URL；不覆盖已存在的环境变量。"""
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
    vite_url = (os.environ.get("VITE_SUPABASE_URL") or "").strip().rstrip("/")
    if vite_url and not (os.environ.get("SUPABASE_URL") or "").strip():
        os.environ["SUPABASE_URL"] = vite_url


def _log(msg: str) -> None:
    """Windows / 重定向管道下避免 stdout 缓冲导致「看起来没输出」。"""
    print(msg, flush=True)


# stock_dividend.csv 表头中的列名（与 get_model.py 输出一致）
REQUIRED_CSV_COLUMNS = (
    "year",
    "股票代码",
    "年内最高(前复权)",
    "年内最低(前复权)",
    "每股分红_总计",
    "股利支付率_计算(%)",
)


def normalize_stock_code(ts_code: str) -> str:
    ts_code = (ts_code or "").strip()
    u = ts_code.upper()
    for suf in (".SH", ".SZ", ".BJ"):
        if u.endswith(suf):
            return ts_code[: -len(suf)]
    return ts_code


def fnum(x) -> float | None:
    if x is None or str(x).strip() == "":
        return None
    try:
        return float(x)
    except ValueError:
        return None


def fetch_existing_rows(base_url: str, service_key: str, codes: list[str]) -> dict[tuple[str, int], dict]:
    """GET 已有行，用于保留 bond_yield 等 CSV 未提供的字段。"""
    out: dict[tuple[str, int], dict] = {}
    # PostgREST: or=(stock_code.eq.x,stock_code.eq.y) 避免 in 列表对文本/前导零的歧义
    chunk = 15
    for i in range(0, len(codes), chunk):
        part = codes[i : i + chunk]
        ors = ",".join(f"stock_code.eq.{c}" for c in part)
        or_param = quote(f"({ors})", safe="")
        url = f"{base_url}/rest/v1/yearly_dividends?or={or_param}&select=*"
        req = urllib.request.Request(
            url,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Accept": "application/json",
            },
        )
        _log(f"  请求 Supabase 已有行: 股票批次 {i // chunk + 1}（{len(part)} 只）…")
        with urllib.request.urlopen(req, timeout=120) as resp:
            rows = json.loads(resp.read().decode())
        for r in rows:
            key = (r["stock_code"], int(r["year"]))
            out[key] = r
    return out


def post_upsert(base_url: str, service_key: str, payload: list[dict]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    url = f"{base_url}/rest/v1/yearly_dividends?on_conflict=stock_code,year"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal,resolution=merge-duplicates",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f"HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Upsert 失败 HTTP {e.code}: {err}") from e


def stock_names_from_payloads(payloads: list[dict]) -> dict[str, str | None]:
    """每只股票取一个非空的 stock_name（供补 dividend_records）。"""
    out: dict[str, str | None] = {}
    for p in payloads:
        c = p.get("stock_code")
        if not c:
            continue
        n = p.get("stock_name")
        if c not in out:
            out[c] = n
        elif (out[c] is None or str(out[c]).strip() == "") and n and str(n).strip():
            out[c] = n
    return out


def ensure_holdings_and_dividend_records(
    base_url: str,
    service_key: str,
    codes: list[str],
    stock_names: dict[str, str | None],
) -> None:
    """与 vite 新增个股一致：无行则插入，满足 yearly_dividends → dividend_records 外键。"""
    base = base_url.rstrip("/")
    hdr = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    prefer = {"Prefer": "return=minimal"}
    for code in codes:
        nm = stock_names.get(code)
        if nm is not None:
            s = str(nm).strip()
            nm = s if s else None
        q = quote(code, safe="")
        url = f"{base}/rest/v1/holdings?stock_code=eq.{q}&select=id"
        req = urllib.request.Request(url, headers=hdr)
        with urllib.request.urlopen(req, timeout=120) as resp:
            hrows = json.loads(resp.read().decode())
        if not (isinstance(hrows, list) and len(hrows) > 0):
            body = json.dumps(
                {
                    "stock_code": code,
                    "stock_name": nm,
                    "cost_price": 0,
                    "quantity": 0,
                    "status": "active",
                },
                ensure_ascii=False,
            ).encode("utf-8")
            ireq = urllib.request.Request(
                f"{base}/rest/v1/holdings",
                data=body,
                method="POST",
                headers={**hdr, **prefer},
            )
            try:
                with urllib.request.urlopen(ireq, timeout=120):
                    pass
            except urllib.error.HTTPError as e:
                err = e.read().decode("utf-8", errors="replace")
                if e.code not in (200, 201, 204, 409):
                    raise RuntimeError(f"插入 holdings 失败 HTTP {e.code}: {err}") from e
        url = f"{base}/rest/v1/dividend_records?stock_code=eq.{q}&select=id"
        req = urllib.request.Request(url, headers=hdr)
        with urllib.request.urlopen(req, timeout=120) as resp:
            drows = json.loads(resp.read().decode())
        if not (isinstance(drows, list) and len(drows) > 0):
            body = json.dumps({"stock_code": code, "stock_name": nm}, ensure_ascii=False).encode("utf-8")
            ireq = urllib.request.Request(
                f"{base}/rest/v1/dividend_records",
                data=body,
                method="POST",
                headers={**hdr, **prefer},
            )
            try:
                with urllib.request.urlopen(ireq, timeout=120):
                    pass
            except urllib.error.HTTPError as e:
                err = e.read().decode("utf-8", errors="replace")
                if e.code not in (200, 201, 204, 409):
                    raise RuntimeError(f"插入 dividend_records 失败 HTTP {e.code}: {err}") from e


def csv_rows_to_payloads(
    csv_path: Path,
    existing: dict[tuple[str, int], dict],
) -> list[dict]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise RuntimeError("CSV 无表头")
        header_set = {h.strip() for h in reader.fieldnames if h and str(h).strip()}
        missing = [c for c in REQUIRED_CSV_COLUMNS if c not in header_set]
        if missing:
            raise RuntimeError(f"CSV 缺少必需列: {missing}，当前表头: {sorted(header_set)}")

        payloads: list[dict] = []
        for row in reader:
            raw_code = row.get("股票代码") or row.get("ts_code") or ""
            code = normalize_stock_code(raw_code)
            if not code:
                continue

            # 用户指定映射（yearly_dividends）
            year = int(float(row["year"]))
            year_high_price = fnum(row.get("年内最高(前复权)"))
            year_low_price = fnum(row.get("年内最低(前复权)"))
            dividend_per_share = fnum(row.get("每股分红_总计"))
            if dividend_per_share is None:
                dividend_per_share = 0.0
            payout_ratio = fnum(row.get("股利支付率_计算(%)"))
            if payout_ratio is None:
                payout_ratio = 0.0

            basic = fnum(row.get("基本EPS"))
            diluted = fnum(row.get("稀释EPS"))
            if basic is None:
                basic = 0.0
            if diluted is None:
                diluted = 0.0
            name = (row.get("股票名称") or "").strip() or None

            max_y = (dividend_per_share / year_low_price * 100.0) if year_low_price and year_low_price > 0 else None
            min_y = (dividend_per_share / year_high_price * 100.0) if year_high_price and year_high_price > 0 else None
            spread = None
            if max_y is not None and min_y is not None:
                spread = round(max_y - min_y, 4)
            ex = existing.get((code, year), {})
            bond = fnum(ex.get("bond_yield"))
            if bond is None:
                bond = 0.0
            if spread is None and ex.get("spread") is not None:
                spread = ex.get("spread")

            rec = {
                "stock_code": code,
                "year": year,
                "stock_name": name,
                "dividend_per_share": round(dividend_per_share, 6),
                "payout_ratio": round(payout_ratio, 4),
                "year_high_price": round(year_high_price, 6) if year_high_price is not None else None,
                "year_low_price": round(year_low_price, 6) if year_low_price is not None else None,
                "max_dividend_yield": round(max_y, 4) if max_y is not None else None,
                "min_dividend_yield": round(min_y, 4) if min_y is not None else None,
                "spread": spread,
                "bond_yield": bond,
                "basic_eps": basic,
                "diluted_eps": diluted,
            }
            payloads.append(rec)
    return payloads


def main() -> None:
    _load_prototype_dotenv()
    _log("[sync] stock_dividend -> yearly_dividends 开始")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not base_url or not key:
        print(
            "错误: 需要 SUPABASE_SERVICE_ROLE_KEY，以及 SUPABASE_URL（可在 prototype/.env 写 VITE_SUPABASE_URL 自动映射）。"
            " 请到 Supabase 控制台 Project Settings → API 复制 service_role 密钥。",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    default_csv = Path(__file__).resolve().parent / "stock_dividend.csv"
    argv_rest = list(sys.argv[1:])
    only_code: str | None = None
    if "--only" in argv_rest:
        i = argv_rest.index("--only")
        if i + 1 < len(argv_rest):
            only_code = normalize_stock_code(argv_rest[i + 1])
        argv_rest = argv_rest[:i] + argv_rest[i + 2 :]
    csv_path = Path(argv_rest[0]).resolve() if argv_rest else default_csv
    _log(f"[sync] CSV 路径: {csv_path}" + (f" | 仅同步: {only_code}" if only_code else ""))
    if not csv_path.is_file():
        print(f"错误: 找不到 CSV: {csv_path}", file=sys.stderr, flush=True)
        sys.exit(1)

    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        codes = sorted(
            {
                normalize_stock_code(r.get("股票代码") or "")
                for r in reader
                if (r.get("股票代码") or "").strip()
            }
        )
    if only_code:
        codes = [only_code] if only_code in codes else []
        if not codes:
            print(f"错误: CSV 中无股票代码 {only_code}", file=sys.stderr, flush=True)
            sys.exit(1)
    if not codes:
        print("错误: CSV 中无有效股票代码", file=sys.stderr, flush=True)
        sys.exit(1)

    _log(f"读取已有 yearly_dividends（{len(codes)} 只股票）…")
    existing = fetch_existing_rows(base_url, key, codes)
    _log(f"已缓存 {len(existing)} 条历史行（用于保留 bond_yield）")

    payloads = csv_rows_to_payloads(csv_path, existing)
    if only_code:
        payloads = [p for p in payloads if p["stock_code"] == only_code]
    if not payloads:
        _log("警告: 没有可写入的行，退出。")
        sys.exit(0)
    sync_codes = sorted({str(p["stock_code"]) for p in payloads if p.get("stock_code")})
    _log(f"  检查并补充 holdings / dividend_records（{len(sync_codes)} 只股票）…")
    ensure_holdings_and_dividend_records(
        base_url,
        key,
        sync_codes,
        stock_names_from_payloads(payloads),
    )
    _log(f"准备写入 {len(payloads)} 行…")

    batch = 200
    for i in range(0, len(payloads), batch):
        _log(f"  提交 upsert 批次 {i // batch + 1}…")
        post_upsert(base_url, key, payloads[i : i + batch])
        _log(f"  已提交 {min(i + batch, len(payloads))}/{len(payloads)}")

    _log("[sync] 同步完成。")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr, flush=True)
        sys.exit(130)
    except Exception as e:
        print(f"[sync] 异常: {e}", file=sys.stderr, flush=True)
        raise
