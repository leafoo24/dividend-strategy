-- 「今日大盘」主要指数：由 Edge refresh-index-daily 写入 Tushare index_daily 最新收盘
create table if not exists public.market_index_snapshots (
  ts_code text primary key,
  index_code text not null,
  index_name text not null,
  trade_date text not null,
  close double precision not null,
  pct_chg double precision not null,
  updated_at timestamptz not null default now()
);

comment on table public.market_index_snapshots is '主要指数最新收盘点位与涨跌幅（Tushare index_daily）';
comment on column public.market_index_snapshots.ts_code is 'Tushare 指数代码，如 000001.SH';
comment on column public.market_index_snapshots.index_code is '展示用 6 位代码';
comment on column public.market_index_snapshots.trade_date is '交易日 YYYYMMDD';

create index if not exists market_index_snapshots_index_code_idx on public.market_index_snapshots (index_code);

alter table public.market_index_snapshots enable row level security;

create policy "market_index_snapshots_select_anon"
  on public.market_index_snapshots for select
  to anon
  using (true);

create policy "market_index_snapshots_select_authenticated"
  on public.market_index_snapshots for select
  to authenticated
  using (true);
