-- 国电电力 600795：2025 为已落地年度数据，补一行 2026 作为「预期年」列（页面显示为 2026E）
insert into public.yearly_dividends (
  stock_code,
  year,
  dividend_per_share,
  payout_ratio,
  year_low_price,
  year_high_price,
  bond_yield,
  min_dividend_yield,
  max_dividend_yield,
  spread
)
select
  '600795',
  2026,
  0,
  0,
  4.00,
  6.50,
  1.72,
  null,
  null,
  null
where not exists (
  select 1 from public.yearly_dividends y
  where y.stock_code = '600795' and y.year = 2026
);
