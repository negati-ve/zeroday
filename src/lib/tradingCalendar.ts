const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-15','2026-01-26','2026-03-03','2026-03-26','2026-03-31',
  '2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26',
  '2026-09-14','2026-10-02','2026-10-20','2026-11-10','2026-11-24',
  '2026-12-25',
])

const IST_OFFSET_MS = 5.5 * 3600_000

export function toISTDate(ts: number): Date {
  return new Date(ts + IST_OFFSET_MS)
}

export function getISTDateStr(ts: number): string {
  return toISTDate(ts).toISOString().slice(0, 10)
}

export function getISTHourMin(ts: number): { hour: number; minute: number } {
  const d = toISTDate(ts)
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}

function isTradingDate(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00+05:30')
  const dow = d.getDay()
  if (dow === 0 || dow === 6) return false
  return !NSE_HOLIDAYS_2026.has(dateStr)
}

export function getNextTradingDay(fromDateStr: string): string {
  const d = new Date(fromDateStr + 'T12:00:00+05:30')
  for (let i = 0; i < 10; i++) {
    d.setDate(d.getDate() + 1)
    const ds = d.toISOString().slice(0, 10)
    if (isTradingDate(ds)) return ds
  }
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}
