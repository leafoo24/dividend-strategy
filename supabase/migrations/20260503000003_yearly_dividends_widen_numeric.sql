-- numeric(6,4) 整数部分最多 2 位（|值| < 100），股价、超高股息率、支付率>100% 会触发 22003 overflow。
-- 在 Supabase Dashboard → SQL Editor 粘贴执行，或通过 supabase migration 应用。

alter table public.yearly_dividends
  alter column year_high_price type numeric(18, 8) using year_high_price::numeric;

alter table public.yearly_dividends
  alter column year_low_price type numeric(18, 8) using year_low_price::numeric;

alter table public.yearly_dividends
  alter column dividend_per_share type numeric(18, 8) using dividend_per_share::numeric;

alter table public.yearly_dividends
  alter column payout_ratio type numeric(18, 8) using payout_ratio::numeric;

alter table public.yearly_dividends
  alter column max_dividend_yield type numeric(18, 8) using max_dividend_yield::numeric;

alter table public.yearly_dividends
  alter column min_dividend_yield type numeric(18, 8) using min_dividend_yield::numeric;

alter table public.yearly_dividends
  alter column spread type numeric(18, 8) using spread::numeric;

alter table public.yearly_dividends
  alter column bond_yield type numeric(18, 8) using bond_yield::numeric;
