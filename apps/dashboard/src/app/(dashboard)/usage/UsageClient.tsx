'use client'

/**
 * Usage metrics — a chart-owned window selector plus stable by-service /
 * by-model / by-user-request tables. The chart window polls every 10s while the
 * lower tables stay on the 24h aggregate so the two controls do not disturb each other.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Select } from '@/components/ui/Select'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { capabilityHealthPresentation } from '@/lib/capabilityHealth'
import type { DashboardCapabilityHealth, MemorySurface, ModelDependencyHealth, UsageResponse, UsageRow, UsageTrendPoint, UsageWindow } from '@/lib/types'
import { buildUsageTrend, buildUsageXAxisTicks, buildUsageXDomain, recordLiveUsageSample } from '@/lib/usageTrend'
import { getUsageAction } from './actions'

const WINDOWS: { v: UsageWindow; label: string }[] = [
  { v: 'live', label: 'Live' }, { v: '24h', label: '24h' }, { v: '7d', label: '7d' }, { v: '30d', label: '30d' }, { v: '90d', label: '90d' },
]
const TABLE_WINDOW: UsageWindow = '24h'
const WINDOW_LABEL: Record<UsageWindow, string> = {
  live: 'Live · last 10 minutes, polled every 10s', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days',
}
const WINDOW_VALUES = new Set<UsageWindow>(WINDOWS.map((w) => w.v))
type UsageChartStyle =
  | 'bar'
  | 'line-linear'
  | 'line-monotone'
  | 'area-linear'
  | 'area-monotone'
  | 'composed-bar-line'
  | 'composed-area-line'
type UsageCurve = 'linear' | 'monotone'
const CHART_STYLE_OPTIONS: { value: UsageChartStyle; label: string }[] = [
  { value: 'bar', label: 'Bar graph' },
  { value: 'line-linear', label: 'Line · linear' },
  { value: 'line-monotone', label: 'Line · monotone' },
  { value: 'area-linear', label: 'Area · linear' },
  { value: 'area-monotone', label: 'Area · monotone' },
  { value: 'composed-bar-line', label: 'Composed · bar + line' },
  { value: 'composed-area-line', label: 'Composed · area + line' },
]
const CHART_STYLE_VALUES = new Set<string>(CHART_STYLE_OPTIONS.map((o) => o.value))
const CHART_CURVE: Partial<Record<UsageChartStyle, UsageCurve>> = {
  'line-linear': 'linear',
  'line-monotone': 'monotone',
  'area-linear': 'linear',
  'area-monotone': 'monotone',
}
const CHART_MARGIN = { top: 18, right: 28, bottom: 20, left: 8 }
const SERVICE_LABEL: Record<string, string> = { 'fact-extraction': 'Fact extraction', graphiti: 'Graphiti', embeddings: 'Embeddings' }
const fmtTok = (n: number): string => n.toLocaleString()
const fmtCompact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toLocaleString()
}
const fmtCost = (n: number): string => (n === 0 ? '$0' : '$' + n.toFixed(n < 1 ? 4 : 2))
const fmtRpm = (n: number): string => (n >= 1 ? n.toFixed(1) : n.toFixed(2))
const fmtTrendTime = (value: number | string | undefined): string => {
  if (value == null) return 'no data'
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
const fmtTrendDate = (value: number | string | undefined): string => {
  if (value == null) return 'no data'
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const fmtTrendDateTime = (value: number | string | undefined): string => {
  if (value == null) return 'no data'
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' })
}
const fmtTrendTick = (value: number | string, window: UsageWindow): string => {
  if (window === 'live') return fmtTrendTime(value)
  if (window === '24h') return fmtTrendDateTime(value)
  return fmtTrendDate(value)
}
const fmtTooltipTime = (value: number | string | undefined): string => {
  if (value == null) return 'no data'
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
// dc grid columns: group | Model | Tokens i/o | Req | /min | Cost
const GT_COLS = '1.1fr 1.3fr .9fr .7fr .6fr .7fr'
const USER_GT_COLS = '1.2fr 1.5fr .8fr .8fr'
type UsageView = 'service' | 'model' | 'user'

type UsageData = UsageResponse & { error?: string }

interface Group {
  key: string
  label: string
  tokensIn: number
  tokensOut: number
  requests: number
  cost: number
  estimated: boolean
  rpm: number
  children: UsageRow[]
}

function group(rows: UsageRow[], by: 'service' | 'model'): Group[] {
  const m = new Map<string, Group>()
  for (const r of rows) {
    const key = by === 'service' ? r.service : r.model
    const label = by === 'service' ? (SERVICE_LABEL[r.service] ?? r.service) : r.model
    const g = m.get(key) ?? { key, label, tokensIn: 0, tokensOut: 0, requests: 0, cost: 0, estimated: false, rpm: 0, children: [] }
    g.tokensIn += r.tokensIn
    g.tokensOut += r.tokensOut
    g.requests += r.requests
    g.cost += r.cost
    g.rpm += r.rpm
    g.estimated = g.estimated || r.estimated
    g.children.push(r)
    m.set(key, g)
  }
  return [...m.values()].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut))
}

function emptyUsage(window: UsageWindow): UsageData {
  const unknown = (capability: ModelDependencyHealth['capability'], observerScope: string): ModelDependencyHealth => ({
    capability, observerScope, state: 'unknown', provider: null, model: null,
    lastSuccessAt: null, firstFailureAt: null, lastFailureAt: null, failureCode: null,
    safeMessage: null, retryable: null, consecutiveFailures: 0, observedAt: null, updatedAt: null,
  })
  return {
    window,
    totals: { tokens: 0, requests: 0, cost: 0 },
    rows: [], trend: [], users: [],
    capabilityHealth: {
      factExtraction: unknown('fact_extraction', 'server'),
      embeddings: unknown('embeddings', 'server'),
      ollamaHost: unknown('ollama_host', 'host'),
    },
  }
}

function usageClockDefaults(now = new Date().toISOString()): Record<UsageWindow, string> {
  return { live: now, '24h': now, '7d': now, '30d': now, '90d': now }
}

function knownUsageWindow(value: string): UsageWindow | null {
  return WINDOW_VALUES.has(value as UsageWindow) ? (value as UsageWindow) : null
}

function knownChartStyle(value: string): UsageChartStyle | null {
  return CHART_STYLE_VALUES.has(value) ? (value as UsageChartStyle) : null
}

function UsageChartChrome({
  chartWindow,
  xDomain,
  xTicks,
}: {
  chartWindow: UsageWindow
  xDomain: [number, number] | undefined
  xTicks: number[]
}) {
  return (
    <>
      <CartesianGrid stroke="rgba(154, 163, 178, .16)" strokeDasharray="4 6" vertical={false} />
      <XAxis
        dataKey="ts"
        type="number"
        domain={xDomain}
        ticks={xTicks}
        tickFormatter={(value) => fmtTrendTick(value, chartWindow)}
        tick={{ fill: 'var(--dim)', fontSize: 11 }}
        tickLine={false}
        axisLine={{ stroke: 'rgba(154, 163, 178, .24)' }}
        minTickGap={24}
      />
      <YAxis
        width={58}
        tickFormatter={fmtCompact}
        tick={{ fill: 'var(--dim)', fontSize: 11 }}
        tickLine={false}
        axisLine={{ stroke: 'rgba(154, 163, 178, .24)' }}
        label={{
          value: 'Tokens',
          angle: -90,
          position: 'insideLeft',
          fill: 'var(--dim)',
          fontSize: 11,
        }}
      />
      <ChartTooltip
        cursor={{ fill: 'rgba(22, 167, 219, .08)' }}
        contentStyle={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: 'var(--body)',
        }}
        labelFormatter={(label) => fmtTooltipTime(typeof label === 'number' ? label : String(label))}
        formatter={(value) => [fmtTok(Number(value)), 'Tokens']}
      />
    </>
  )
}

function healthForService(service: string, health: DashboardCapabilityHealth): ModelDependencyHealth | null {
  if (service === 'fact-extraction') return health.factExtraction
  if (service === 'embeddings') return health.embeddings
  return null
}

function HealthErrorIndicator({ health }: { health: ModelDependencyHealth | null }) {
  if (!health || health.state === 'healthy' || health.state === 'unknown') return null
  const presentation = capabilityHealthPresentation(health)
  const label = `${presentation.message} Observed ${presentation.observedAt}. ${presentation.recovery}`
  return (
    <Tooltip label={label}>
      <span className="usage-health-error" tabIndex={0} aria-label={label}>
        <Icon name="error" size={16} />
      </span>
    </Tooltip>
  )
}

function CapabilityHealthRows({ health }: { health: DashboardCapabilityHealth }) {
  const rows = [
    ['fact-extraction', 'Fact extraction', health.factExtraction],
    ['embeddings', 'Embeddings', health.embeddings],
  ] as const
  return rows.filter(([, , item]) => item.state !== 'healthy' && item.state !== 'unknown').map(([service, label, item]) => {
    const presentation = capabilityHealthPresentation(item)
    return (
      <div key={`${service}:health`} className="gt-row usage-health-row" style={{ gridTemplateColumns: GT_COLS }}>
        <div style={{ color: 'var(--body)' }}>{label}</div>
        <div className="mono" style={{ color: 'var(--dim)' }}>capability health</div>
        <div><HealthErrorIndicator health={item} /></div>
        <div className="mono" style={{ gridColumn: '4 / -1', color: presentation.tone === 'bad' ? 'var(--coral-soft)' : 'var(--marigold)' }}>
          {presentation.message}
        </div>
      </div>
    )
  })
}

function GroupUsageTable({ groups, view, capabilityHealth }: { groups: Group[]; view: Exclude<UsageView, 'user'>; capabilityHealth: DashboardCapabilityHealth }) {
  const hasCapabilityFailure = view === 'service' && [
    capabilityHealth.factExtraction,
    capabilityHealth.embeddings,
  ].some((item) => item.state !== 'healthy' && item.state !== 'unknown')
  const healthRows = view === 'service' ? <CapabilityHealthRows health={capabilityHealth} /> : null
  if (groups.length === 0 && !hasCapabilityFailure) {
    return <div className="gt table-scroll"><div className="gt-empty">No usage recorded in the last 24 hours yet.</div></div>
  }

  return (
    <div className="gt table-scroll">
      <div className="gt-head" style={{ gridTemplateColumns: GT_COLS }}>
        <div>{view === 'service' ? 'Service' : 'Model'}</div>
        <div>Model</div>
        <div style={{ textAlign: 'right' }}>Tokens i/o</div>
        <div style={{ textAlign: 'right' }}>Req</div>
        <div style={{ textAlign: 'right' }}>/min</div>
        <div style={{ textAlign: 'right' }}>Cost</div>
      </div>
      <div className="gt-scroll-body">
        {healthRows}
        {view === 'service'
          ? groups.flatMap((g) =>
              g.children.map((r, i) => (
                <div key={`${g.key}:${r.model}`} className="gt-row" style={{ gridTemplateColumns: GT_COLS }}>
                  <div className="mono" style={{ color: i === 0 ? 'var(--body)' : 'var(--dim)' }}>{i === 0 ? g.label : ''}</div>
                  <div className="mono" style={{ color: 'var(--soft)' }}>
                    {r.model} <HealthErrorIndicator health={healthForService(r.service, capabilityHealth)} />
                  </div>
                  <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(r.tokensIn)} / {fmtTok(r.tokensOut)}</div>
                  <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(r.requests)}</div>
                  <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtRpm(r.rpm)}</div>
                  <div className="mono" style={{ textAlign: 'right' }}>
                    <span style={{ color: r.cost === 0 ? 'var(--dim)' : 'var(--soft)' }}>{fmtCost(r.cost)}</span>
                    {r.estimated ? <span className="tag-est">est</span> : null}
                  </div>
                </div>
              ))
            )
          : groups.map((g) => (
              <div key={g.key} className="gt-row" style={{ gridTemplateColumns: GT_COLS }}>
                <div className="mono" style={{ color: 'var(--body)' }}>{g.label}</div>
                <div className="mono" style={{ color: 'var(--soft)' }}>{[...new Set(g.children.map((c) => SERVICE_LABEL[c.service] ?? c.service))].join(', ')}</div>
                <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(g.tokensIn)} / {fmtTok(g.tokensOut)}</div>
                <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(g.requests)}</div>
                <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtRpm(g.rpm)}</div>
                <div className="mono" style={{ textAlign: 'right' }}>
                  <span style={{ color: g.cost === 0 ? 'var(--dim)' : 'var(--soft)' }}>{fmtCost(g.cost)}</span>
                  {g.estimated ? <span className="tag-est">est</span> : null}
                </div>
              </div>
            ))}
      </div>
    </div>
  )
}

function UserUsageTable({ data }: { data: UsageData }) {
  if (data.users.length === 0) {
    return (
      <div className="gt table-scroll">
        <div className="gt-empty">No user usage recorded in the last 24 hours yet.</div>
      </div>
    )
  }

  return (
    <div className="gt table-scroll">
      <div className="gt-head" style={{ gridTemplateColumns: USER_GT_COLS }}>
        <div>User</div>
        <div>Email</div>
        <div style={{ textAlign: 'right' }}>Total tokens</div>
        <div style={{ textAlign: 'right' }}>Requests</div>
      </div>
      <div className="gt-scroll-body">
        {data.users.map((u) => (
          <div key={u.userId ?? 'system'} className="gt-row" style={{ gridTemplateColumns: USER_GT_COLS }}>
            <div style={{ color: 'var(--body)' }}>{u.displayName}</div>
            <div className="mono" style={{ color: u.email ? 'var(--soft)' : 'var(--dim)' }}>{u.email ?? '—'}</div>
            <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(u.tokens)}</div>
            <div className="mono" style={{ textAlign: 'right', color: 'var(--soft)' }}>{fmtTok(u.requests)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function UsageClient({ initial, surface }: { initial: UsageData; surface: MemorySurface }) {
  const initialWindow = knownUsageWindow(initial.window) ?? '24h'
  const [chartWindow, setChartWindow] = useState<UsageWindow>(initialWindow)
  const [chartStyle, setChartStyle] = useState<UsageChartStyle>('bar')
  const [by, setBy] = useState<UsageView>('service')
  const [dataByWindow, setDataByWindow] = useState<Partial<Record<UsageWindow, UsageData>>>(() => ({ [initialWindow]: initial }))
  const [chartNowByWindow, setChartNowByWindow] = useState<Record<UsageWindow, string>>(() => usageClockDefaults())
  const [liveSamples, setLiveSamples] = useState<UsageTrendPoint[]>([])
  const requestSeq = useRef(0)
  const latestRequestByWindow = useRef<Partial<Record<UsageWindow, number>>>({})

  const refresh = useCallback(async (w: UsageWindow): Promise<void> => {
    const requestId = requestSeq.current + 1
    requestSeq.current = requestId
    latestRequestByWindow.current[w] = requestId
    try {
      const next = await getUsageAction(w, surface)
      if (latestRequestByWindow.current[w] !== requestId) return
      const fetchedAt = new Date()
      setDataByWindow((previous) => ({ ...previous, [w]: next }))
      setChartNowByWindow((previous) => ({ ...previous, [w]: fetchedAt.toISOString() }))
      if (w === 'live' && !next.error) {
        setLiveSamples((samples) => recordLiveUsageSample(samples, next.totals.tokens, fetchedAt))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDataByWindow((previous) => ({ ...previous, [w]: { ...emptyUsage(w), error: message } }))
      setChartNowByWindow((previous) => ({ ...previous, [w]: new Date().toISOString() }))
    }
  }, [surface])
  // Refetch when the window changes.
  useEffect(() => { void refresh(chartWindow) }, [chartWindow, refresh])
  // Poll the chart window plus the stable 24h table aggregate; torn down on change/unmount.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh(chartWindow)
      if (chartWindow !== TABLE_WINDOW) void refresh(TABLE_WINDOW)
    }, 10_000)
    return () => window.clearInterval(id)
  }, [chartWindow, refresh])

  const chartData = dataByWindow[chartWindow] ?? emptyUsage(chartWindow)
  const tableData = dataByWindow[TABLE_WINDOW] ?? emptyUsage(TABLE_WINDOW)
  const serviceGroups = group(tableData.rows, 'service')
  const modelGroups = group(tableData.rows, 'model')
  const chartNow = new Date(chartNowByWindow[chartWindow])
  const trend = buildUsageTrend(chartData.trend, chartWindow, chartData.totals.tokens, chartNow, liveSamples)
  const xDomain = buildUsageXDomain(chartWindow, trend, chartNow)
  const xTicks = buildUsageXAxisTicks(chartWindow, xDomain?.[0], xDomain?.[1])
  const chartCurve = CHART_CURVE[chartStyle] ?? 'monotone'
  const liveBarSize = chartWindow === 'live' ? 28 : undefined

  function renderChart() {
    const chrome = <UsageChartChrome chartWindow={chartWindow} xDomain={xDomain} xTicks={xTicks} />
    switch (chartStyle) {
      case 'line-linear':
      case 'line-monotone':
        return (
          <LineChart data={trend} margin={CHART_MARGIN} accessibilityLayer>
            {chrome}
            <Line
              type={chartCurve}
              dataKey="tokens"
              name="Tokens"
              stroke="var(--accent)"
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        )
      case 'area-linear':
      case 'area-monotone':
        return (
          <AreaChart data={trend} margin={CHART_MARGIN} accessibilityLayer>
            {chrome}
            <Area
              type={chartCurve}
              dataKey="tokens"
              name="Tokens"
              stroke="var(--accent)"
              strokeWidth={2}
              fill="var(--accent)"
              fillOpacity={0.18}
              isAnimationActive={false}
            />
          </AreaChart>
        )
      case 'composed-bar-line':
        return (
          <ComposedChart data={trend} margin={CHART_MARGIN} accessibilityLayer>
            {chrome}
            <Bar
              dataKey="tokens"
              name="Tokens"
              fill="var(--accent-40)"
              barSize={liveBarSize}
              maxBarSize={28}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="tokens"
              name="Tokens"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        )
      case 'composed-area-line':
        return (
          <ComposedChart data={trend} margin={CHART_MARGIN} accessibilityLayer>
            {chrome}
            <Area
              type="monotone"
              dataKey="tokens"
              name="Tokens"
              stroke="var(--accent)"
              strokeWidth={1.5}
              fill="var(--accent)"
              fillOpacity={0.14}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="tokens"
              name="Tokens"
              stroke="var(--accent-hover)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        )
      case 'bar':
      default:
        return (
          <BarChart data={trend} margin={CHART_MARGIN} accessibilityLayer>
            {chrome}
            <Bar
              dataKey="tokens"
              name="Tokens"
              fill="var(--accent)"
              barSize={liveBarSize}
              maxBarSize={28}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        )
    }
  }

  return (
    <div className="page-fill usage-page">
      {chartData.error ? <div className="notice danger">{chartData.error}</div> : null}

      <div className="usage-chart-controls">
        <div className="win-bar">
          {WINDOWS.map((w) => (
            <div
              key={w.v}
              className={`win-pill${chartWindow === w.v ? ' active' : ''}`}
              onClick={() => setChartWindow(w.v)}
            >
              {w.label}
            </div>
          ))}
        </div>
        <div className="usage-chart-style-select">
          <Select
            value={chartStyle}
            onChange={(value) => {
              const next = knownChartStyle(value)
              if (next) setChartStyle(next)
            }}
            options={CHART_STYLE_OPTIONS}
            ariaLabel="Token graph style"
          />
        </div>
      </div>

      {/* Totals card + token trend chart */}
      <div className="spark-card">
        <div className="spark-head">
          <div className="spark-stats">
            <div><div className="stat-label">Total tokens</div><div className="stat-value">{fmtTok(chartData.totals.tokens)}</div></div>
            <div><div className="stat-label">Requests</div><div className="stat-value">{fmtTok(chartData.totals.requests)}</div></div>
            <div><div className="stat-label">Est. cost</div><div className="stat-value accent">{fmtCost(chartData.totals.cost)}</div></div>
          </div>
          <div className="spark-meta">{WINDOW_LABEL[chartWindow]}</div>
        </div>
        <div className="usage-chart-row">
          <div className="usage-chart" aria-label="Token usage by time bucket">
            <ResponsiveContainer width="100%" height="100%">
              {renderChart()}
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* By service / By model / By user requests toggle */}
      <div className="win-bar usage-table-tabs">
        <div className={`win-pill${by === 'service' ? ' active' : ''}`} onClick={() => setBy('service')}>By service</div>
        <div className={`win-pill${by === 'model' ? ' active' : ''}`} onClick={() => setBy('model')}>By model</div>
        <div className={`win-pill${by === 'user' ? ' active' : ''}`} onClick={() => setBy('user')}>By user requests</div>
      </div>

      <div className="usage-table-panels">
        <div className="usage-table-panel" hidden={by !== 'service'}>
          <GroupUsageTable groups={serviceGroups} view="service" capabilityHealth={tableData.capabilityHealth} />
        </div>
        <div className="usage-table-panel" hidden={by !== 'model'}>
          <GroupUsageTable groups={modelGroups} view="model" capabilityHealth={tableData.capabilityHealth} />
        </div>
        <div className="usage-table-panel" hidden={by !== 'user'}>
          <UserUsageTable data={tableData} />
        </div>
      </div>

      <p style={{ color: 'var(--dim)', fontSize: 12, margin: '12px 2px 0' }}>
        Org-wide 24h aggregate — no team slicing. <span style={{ color: 'var(--marigold)' }}>est</span> = model not in the price map (cost reads $0, not free). Background/internal usage appears as System / background.
      </p>
    </div>
  )
}
