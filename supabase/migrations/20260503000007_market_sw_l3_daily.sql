-- 今日大盘：申万 2021 版三级行业日线快照（index_classify L3 + 逐指数 index_daily，兼容低积分）
create table if not exists public.market_sw_l3_daily (
  ts_code text primary key,
  name text not null,
  trade_date text not null,
  close double precision,
  pct_chg double precision not null,
  updated_at timestamptz not null default now()
);

comment on table public.market_sw_l3_daily is '申万三级行业涨跌幅（index_daily 最新一根 K 线；来源 index_classify L3）';
comment on column public.market_sw_l3_daily.ts_code is '行业指数代码，如 850111.SI';
comment on column public.market_sw_l3_daily.pct_chg is '涨跌幅 %，对应 Tushare pct_change';

create index if not exists market_sw_l3_daily_trade_date_idx on public.market_sw_l3_daily (trade_date);

alter table public.market_sw_l3_daily enable row level security;

create policy "market_sw_l3_daily_select_anon"
  on public.market_sw_l3_daily for select
  to anon
  using (true);

create policy "market_sw_l3_daily_select_authenticated"
  on public.market_sw_l3_daily for select
  to authenticated
  using (true);
