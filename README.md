# 红利策略助手

本地运行的股票持仓、股息估值与交易复盘工具。个人持仓、交易计划和复盘记录保存在本机 SQLite 数据库中。

## 功能

- 管理持仓、自选股、资产配置与预期股息。
- 查看个股行情、股息估值和公告。
- 记录加仓、减仓与交易复盘；已发生的交易会调整持仓数量和成本。
- 在交易计划中保存未来打算，不改变当前持仓。

## 本地启动

1. 安装 Node.js 22 或更新版本。
2. 运行 `npm ci`。
3. 复制 `.env.example` 为 `.env`，按需填写自己的 `TUSHARE_TOKEN`。
4. 运行 `npm run dev`，打开终端给出的本地地址。

数据库默认保存在 `data/local.db`，由程序在本机创建；可用 `LOCAL_DB_PATH` 指向其他本地路径。公开版本不附带个人持仓和生成的行情 CSV。首次使用时，请在页面录入自己的持仓；若要导入自己的年度股息 CSV，可放在 `data/stock_dividend.csv`，格式见测试中的临时样例。该 CSV 和数据库都被 Git 忽略。行情刷新需要使用者自己的 Tushare Token。

## 隐私

提交前运行 `git status --short` 和 `git ls-files`，确认 `.env`、`data/*.db*`、`data/stock_dividend*.csv`、个人导入脚本、账户截图和交易导出文件不在提交列表中。不要把带有个人记录的旧 Git 历史合并进本仓库。

## 验证

运行 `node --test tests/*.test.mjs` 和 `npm run build`。测试使用临时数据库与虚构样例，不读取本机持仓。

## 许可证

[MIT](LICENSE)。
