import type { WorkerStatus } from './types'

export type ScheduleMode = 'never' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'
export type HourlyCadence = 'minutes' | 'interval'

export interface CronDraft {
  mode: ScheduleMode
  minute: string
  minutes: string[]
  hourlyCadence: HourlyCadence
  interval: string
  hour: string
  weekdays: string[]
  dayOfMonth: string
  month: string
  customCron: string
}

export interface SchedulePreview {
  enabled: boolean
  cron: string
  text: string
  valid: boolean
  error?: string
}

export const SCHEDULE_MODES: { id: ScheduleMode; label: string }[] = [
  { id: 'never', label: 'Never' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly' },
  { id: 'custom', label: 'Custom' },
]

export const WEEKDAYS = [
  { value: '0', label: 'Sun' },
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
]

export const MONTHS = [
  { value: '1', label: 'Jan' },
  { value: '2', label: 'Feb' },
  { value: '3', label: 'Mar' },
  { value: '4', label: 'Apr' },
  { value: '5', label: 'May' },
  { value: '6', label: 'Jun' },
  { value: '7', label: 'Jul' },
  { value: '8', label: 'Aug' },
  { value: '9', label: 'Sep' },
  { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' },
  { value: '12', label: 'Dec' },
]

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max)
const pad = (n: number | string): string => String(n).padStart(2, '0')
const compactField = (v: string): string => String(Number(v))

function isCronLike(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/)
  return fields.length >= 5 && fields.length <= 6 && fields.every((f) => /^[\d*/,\-]+$/.test(f))
}

function cronFields(cron: string): string[] | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length === 6) return fields.slice(1)
  if (fields.length === 5) return fields
  return null
}

export function normalizeCronForCompare(cron: string): string {
  const fields = cronFields(cron)
  if (!fields) return cron.trim()
  const [minute, hour, dayOfMonth, month, weekday] = fields
  const normalizedMinute = minute.startsWith('*/')
    ? expandField(minute, 0, 59, '00').map(compactField).join(',')
    : minute
  return [normalizedMinute, hour, dayOfMonth, month, weekday].join(' ')
}

function numericField(field: string, fallback: number, min: number, max: number): string {
  const match = field.match(/\d+/)
  if (!match) return pad(fallback)
  return pad(clamp(Number(match[0]), min, max))
}

function expandField(field: string, min: number, max: number, fallback: string): string[] {
  const step = field.match(/^\*\/(\d+)$/)
  if (step) {
    const n = Number(step[1])
    if (Number.isFinite(n) && n > 0) {
      const out: string[] = []
      for (let i = min; i <= max; i += n) out.push(pad(i))
      return out.length ? out : [fallback]
    }
  }
  const values = field
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= min && n <= max)
  const unique = Array.from(new Set(values)).sort((a, b) => a - b)
  return unique.length ? unique.map(pad) : [fallback]
}

function minuteInterval(field: string): number | null {
  const match = field.match(/^\*\/(\d+)$/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 1 && value <= 59 ? value : null
}

function expandWeekdays(field: string): string[] {
  if (field === '*') return ['1']
  const values = field
    .split(',')
    .map((part) => Number(part.trim()) % 7)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  const unique = Array.from(new Set(values)).sort((a, b) => a - b)
  return unique.length ? unique.map(String) : ['1']
}

export function draftFromWorker(w: WorkerStatus): CronDraft {
  const fields = cronFields(w.cron)
  const fallback: CronDraft = {
    mode: w.enabled ? 'custom' : 'never',
    minute: '00',
    minutes: ['00'],
    hourlyCadence: 'minutes',
    interval: '5',
    hour: '03',
    weekdays: ['1'],
    dayOfMonth: '1',
    month: '1',
    customCron: w.cron,
  }
  if (!fields) return fallback
  const [minute, hour, dayOfMonth, month, weekday] = fields
  const minutes = expandField(minute, 0, 59, '00')
  const interval = minuteInterval(minute)
  const base: CronDraft = {
    ...fallback,
    minute: minutes[0] ?? '00',
    minutes,
    hourlyCadence: interval ? 'interval' : 'minutes',
    interval: String(interval ?? 5),
    hour: numericField(hour, 3, 0, 23),
    weekdays: expandWeekdays(weekday),
    dayOfMonth: numericField(dayOfMonth, 1, 1, 31),
    month: String(Number(numericField(month, 1, 1, 12))),
  }
  if (!w.enabled) return { ...base, mode: 'never' }
  if (hour === '*' && dayOfMonth === '*' && month === '*' && weekday === '*') return { ...base, mode: 'hourly' }
  if (dayOfMonth === '*' && month === '*' && weekday === '*') return { ...base, mode: 'daily' }
  if (dayOfMonth === '*' && month === '*' && weekday !== '*') return { ...base, mode: 'weekly' }
  if (dayOfMonth !== '*' && month === '*' && weekday === '*') return { ...base, mode: 'monthly' }
  if (dayOfMonth !== '*' && month !== '*' && weekday === '*') return { ...base, mode: 'yearly' }
  return { ...base, mode: 'custom' }
}

export function buildSchedulePreview(draft: CronDraft, currentCron: string): SchedulePreview {
  if (draft.mode === 'never') {
    return { enabled: false, cron: currentCron, text: 'Stopped. The saved cron is kept for later.', valid: true }
  }
  const minute = compactField(draft.minute)
  const hour = compactField(draft.hour)
  const day = String(clamp(Number(draft.dayOfMonth) || 1, 1, 31))
  const month = String(clamp(Number(draft.month) || 1, 1, 12))
  if (draft.mode === 'hourly') {
    if (draft.hourlyCadence === 'interval') {
      const every = clamp(Number(draft.interval) || 1, 1, 59)
      return { enabled: true, cron: `*/${every} * * * *`, text: every === 1 ? 'Every minute' : `Every ${every} minutes`, valid: true }
    }
    const minutes = draft.minutes.length ? draft.minutes.map(compactField).join(',') : '0'
    const label = draft.minutes.length === 1 ? `minute ${draft.minutes[0]}` : `minutes ${draft.minutes.join(', ')}`
    return { enabled: true, cron: `${minutes} * * * *`, text: `At ${label} of every hour`, valid: true }
  }
  if (draft.mode === 'daily') return { enabled: true, cron: `${minute} ${hour} * * *`, text: `At ${pad(hour)}:${pad(minute)} every day`, valid: true }
  if (draft.mode === 'weekly') {
    const weekdays = draft.weekdays.length ? draft.weekdays : ['1']
    const names = WEEKDAYS.filter((d) => weekdays.includes(d.value)).map((d) => d.label).join(', ')
    return { enabled: true, cron: `${minute} ${hour} * * ${weekdays.join(',')}`, text: `At ${pad(hour)}:${pad(minute)} on ${names}`, valid: true }
  }
  if (draft.mode === 'monthly') return { enabled: true, cron: `${minute} ${hour} ${day} * *`, text: `At ${pad(hour)}:${pad(minute)} on day ${day} of each month`, valid: true }
  if (draft.mode === 'yearly') {
    const monthName = MONTHS.find((m) => m.value === month)?.label ?? `month ${month}`
    return { enabled: true, cron: `${minute} ${hour} ${day} ${month} *`, text: `At ${pad(hour)}:${pad(minute)} on ${monthName} ${day}`, valid: true }
  }
  const cron = draft.customCron.trim()
  return {
    enabled: true,
    cron,
    text: cron ? `Custom cron: ${cron}` : 'Enter a cron pattern.',
    valid: isCronLike(cron),
    error: cron && !isCronLike(cron) ? 'Use five or six cron fields with numbers and */,- operators.' : undefined,
  }
}

export function cronDescription(cron: string, enabled: boolean): string {
  if (!enabled) return 'Stopped'
  const draft = draftFromWorker({ cron, enabled } as WorkerStatus)
  return buildSchedulePreview(draft, cron).text
}
