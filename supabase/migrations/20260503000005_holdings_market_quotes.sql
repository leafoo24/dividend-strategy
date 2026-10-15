-- 刷新行情时由 Edge Function 写入 Tushare 最新价、涨跌幅及浮动盈亏
alter table public.holdings
  add column if not exists last_close_price double precision,
  add column if not exists last_change_pct double precision,
  add column if not exists floating_pnl double precision,
  add column if not exists floating_pnl_pct double precision,
  add column if not exists market_quotes_at timestamptz;

comment on column public.holdings.last_close_price is '最近交易日收盘价（元）';
comment on column public.holdings.last_change_pct is '最近交易日涨跌幅（%）';
comment on column public.holdings.floating_pnl is '浮动盈亏（元）= (收盘价-成本价)*数量';
comment on column public.holdings.floating_pnl_pct is '浮动盈亏比例（%）= (收盘价-成本价)/成本价*100';
comment on column public.holdings.market_quotes_at is '行情写入时间';
