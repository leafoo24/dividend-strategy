-- CSV(get_model.py) 相对 yearly_dividends 多出的字段：在 Supabase SQL Editor 执行一次即可
alter table public.yearly_dividends
  add column if not exists basic_eps double precision,
  add column if not exists diluted_eps double precision,
  add column if not exists stock_name text;

comment on column public.yearly_dividends.basic_eps is '基本EPS';
comment on column public.yearly_dividends.diluted_eps is '稀释EPS';
comment on column public.yearly_dividends.stock_name is '股票名称';
