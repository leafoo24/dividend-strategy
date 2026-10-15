-- 股息估值页持久化：离开页面时写入 dividend_records
alter table public.dividend_records
  add column if not exists expected_payout_ratio double precision,
  add column if not exists valuation_targets jsonb;

comment on column public.dividend_records.expected_payout_ratio is '用户输入的预期分红率(%)';
comment on column public.dividend_records.valuation_targets is '估值区间 JSON 数组，元素含 yield(%) 与 label';
