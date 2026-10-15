import { useEffect, useRef, useState } from 'react'
import { TrendingUp, BookOpen, LayoutDashboard, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToastProvider } from '@/components/ui/toast'
import HoldingListPage from '@/pages/HoldingListPage'
import WatchlistPage from '@/pages/WatchlistPage'
import StockDetailPage from '@/pages/StockDetailPage'
import DividendAnalysisPage from '@/pages/DividendAnalysisPage'
import StrategySelectionPage from '@/pages/StrategySelectionPage'
import { migrateBrowserStorage } from '@/services/browserMigration'

const NAV_ITEMS = [
  { key: 'strategy', label: '策略选股', icon: TrendingUp },
  { key: 'holdings', label: '\u6211\u7684\u6301\u4ed3', icon: LayoutDashboard },
  { key: 'watchlist', label: '\u81ea\u9009\u80a1', icon: Star },
  { key: 'dividend', label: '\u80a1\u606f\u4f30\u503c', icon: TrendingUp },
]

export default function App() {
  const [page, setPage] = useState('holdings')
  const [selectedStock, setSelectedStock] = useState(null)
  const [detailReturnPage, setDetailReturnPage] = useState('holdings')
  const [migration, setMigration] = useState({ status: 'loading', error: '' })
  const migrationStarted = useRef(false)
  async function runMigration() {
    setMigration({ status: 'loading', error: '' })
    try {
      await migrateBrowserStorage()
      setMigration({ status: 'ready', error: '' })
    } catch (error) {
      setMigration({ status: 'error', error: error.message || '迁移失败' })
    }
  }
  useEffect(() => {
    if (migrationStarted.current) return
    migrationStarted.current = true
    void runMigration()
  }, [])

  function handleSelectStock(stock, returnPage = 'holdings') {
    setSelectedStock(stock)
    setDetailReturnPage(returnPage)
    setPage('detail')
  }

  function handleBackToList() {
    setPage(detailReturnPage)
    setSelectedStock(null)
  }

  function isNavActive(item) {
    if (page === item.key) return true
    return page === 'detail' && detailReturnPage === item.key
  }

  if (migration.status !== 'ready') {
    return <div className="flex min-h-screen items-center justify-center bg-background p-6 text-sm">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <p className="font-medium">{migration.status === 'loading' ? '正在将旧浏览器记录迁入本地数据库…' : '旧记录迁移未完成'}</p>
        {migration.status === 'error' && <><p className="mt-2 text-xs text-destructive">{migration.error}</p><p className="mt-2 text-xs text-muted-foreground">浏览器原始记录仍保留，重试成功后才会清除。</p><button type="button" className="mt-4 rounded-md bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => void runMigration()}>重试迁移</button></>}
      </div>
    </div>
  }
  return (
    <ToastProvider>
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <aside className="w-52 border-r border-border flex flex-col shrink-0">
          <div className="px-4 py-5 border-b border-border">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold tracking-wide text-foreground">{'\u7ea2\u5229\u7b56\u7565\u52a9\u624b'}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{'\u9ad8\u80a1\u606f \u00b7 \u4f18\u8d28\u57fa\u672c\u9762'}</p>
          </div>
          <nav className="flex-1 px-3 py-3 flex flex-col gap-0.5">
            {NAV_ITEMS.map(item => (
              <button
                key={item.key}
                onClick={() => setPage(item.key)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors w-full text-left',
                  isNavActive(item)
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="px-4 py-3 border-t border-border">
            <p className="text-xs text-muted-foreground">{'\u6570\u636e\u4ec5\u4f9b\u53c2\u8003\uff0c\u4e0d\u6784\u6210\u6295\u8d44\u5efa\u8bae'}</p>
          </div>
        </aside>

        <main className="flex-1 overflow-auto">
          {page === 'strategy' && <StrategySelectionPage />}
          {page === 'holdings' && <HoldingListPage onSelectStock={stock => handleSelectStock(stock, 'holdings')} />}
          {page === 'watchlist' && <WatchlistPage onSelectStock={stock => handleSelectStock(stock, 'watchlist')} />}
          {page === 'detail' && selectedStock && (
            <StockDetailPage stock={selectedStock} onBack={handleBackToList} />
          )}
          <div className={page === 'dividend' ? '' : 'hidden'}>
            <DividendAnalysisPage pageActive={page === 'dividend'} />
          </div>
        </main>
      </div>
    </ToastProvider>
  )
}
