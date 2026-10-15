-- 中谷物流（SH）正确代码为 603565；历史数据中误写为 603871 时在此统一纠正。
-- 若库内已同时存在 603565 与 603871，先去掉会与迁移后冲突的 603565 行，再改码。

-- yearly_dividends：唯一键通常为 (stock_code, year)
delete from public.yearly_dividends y
where y.stock_code = '603565'
  and exists (
    select 1 from public.yearly_dividends w
    where w.stock_code = '603871' and w.year = y.year
  );

update public.yearly_dividends
set stock_code = '603565'
where stock_code = '603871';

-- dividend_records：主键/唯一一般为 stock_code
delete from public.dividend_records
where stock_code = '603565'
  and exists (select 1 from public.dividend_records where stock_code = '603871');

update public.dividend_records
set stock_code = '603565'
where stock_code = '603871';

-- market_data：onConflict stock_code
delete from public.market_data
where stock_code = '603565'
  and exists (select 1 from public.market_data where stock_code = '603871');

update public.market_data
set stock_code = '603565'
where stock_code = '603871';

-- holdings：避免改码后与已有 603565 持仓重复
delete from public.holdings h
where h.stock_code = '603565'
  and exists (select 1 from public.holdings w where w.stock_code = '603871');

update public.holdings
set stock_code = '603565'
where stock_code = '603871';
