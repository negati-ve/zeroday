export interface Candle {
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface IndicatorValues {
  emaShort: number | null
  emaLong: number | null
  rsi: number | null
  vwap: number | null
  atr: number | null
  atrPct: number | null
}

export interface IndicatorConfig {
  emaShortPeriod: number
  emaLongPeriod: number
  rsiPeriod: number
  atrPeriod: number
}

const DEFAULTS: IndicatorConfig = { emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 }

export class IndicatorEngine {
  private currentCandle: Candle | null = null
  private cfg: IndicatorConfig

  // EMA
  private emaS: number | null = null
  private emaL: number | null = null
  private emaSAlpha: number
  private emaLAlpha: number

  // RSI (Wilder smoothing)
  private rsiAvgGain = 0
  private rsiAvgLoss = 0
  private rsiPrev: number | null = null
  private rsiN = 0

  // VWAP
  private cumPV = 0
  private cumVol = 0

  // ATR (Wilder smoothing)
  private atrVal: number | null = null
  private atrPrev: number | null = null
  private atrN = 0

  private lastPrice = 0

  constructor(config?: Partial<IndicatorConfig>) {
    this.cfg = { ...DEFAULTS, ...config }
    this.emaSAlpha = 2 / (this.cfg.emaShortPeriod + 1)
    this.emaLAlpha = 2 / (this.cfg.emaLongPeriod + 1)
  }

  update(ts: number, price: number, volDelta: number): IndicatorValues {
    this.lastPrice = price

    // VWAP
    const absVol = Math.abs(volDelta)
    if (absVol > 0) {
      this.cumPV += price * absVol
      this.cumVol += absVol
    }

    // 1-minute candle bucketing
    const bucket = Math.floor(ts / 60000) * 60000
    if (!this.currentCandle || this.currentCandle.ts !== bucket) {
      if (this.currentCandle) this.onCandleClose(this.currentCandle)
      this.currentCandle = { ts: bucket, open: price, high: price, low: price, close: price, volume: absVol }
    } else {
      if (price > this.currentCandle.high) this.currentCandle.high = price
      if (price < this.currentCandle.low) this.currentCandle.low = price
      this.currentCandle.close = price
      this.currentCandle.volume += absVol
    }

    return this.values()
  }

  values(): IndicatorValues {
    const rsi = this.rsiN >= this.cfg.rsiPeriod && this.rsiAvgLoss > 0
      ? 100 - 100 / (1 + this.rsiAvgGain / this.rsiAvgLoss)
      : this.rsiN >= this.cfg.rsiPeriod && this.rsiAvgLoss === 0 ? 100 : null
    return {
      emaShort: this.emaS,
      emaLong: this.emaL,
      rsi,
      vwap: this.cumVol > 0 ? this.cumPV / this.cumVol : null,
      atr: this.atrVal,
      atrPct: this.atrVal != null && this.lastPrice > 0 ? (this.atrVal / this.lastPrice) * 100 : null,
    }
  }

  private onCandleClose(c: Candle) {
    // EMA
    if (this.emaS === null) {
      this.emaS = c.close
      this.emaL = c.close
    } else {
      this.emaS = this.emaSAlpha * c.close + (1 - this.emaSAlpha) * this.emaS
      this.emaL = this.emaLAlpha * c.close + (1 - this.emaLAlpha) * (this.emaL ?? c.close)
    }

    // RSI
    if (this.rsiPrev !== null) {
      const change = c.close - this.rsiPrev
      const gain = change > 0 ? change : 0
      const loss = change < 0 ? -change : 0
      if (this.rsiN < this.cfg.rsiPeriod) {
        this.rsiAvgGain += gain
        this.rsiAvgLoss += loss
        this.rsiN++
        if (this.rsiN === this.cfg.rsiPeriod) {
          this.rsiAvgGain /= this.cfg.rsiPeriod
          this.rsiAvgLoss /= this.cfg.rsiPeriod
        }
      } else {
        this.rsiAvgGain = (this.rsiAvgGain * (this.cfg.rsiPeriod - 1) + gain) / this.cfg.rsiPeriod
        this.rsiAvgLoss = (this.rsiAvgLoss * (this.cfg.rsiPeriod - 1) + loss) / this.cfg.rsiPeriod
      }
    }
    this.rsiPrev = c.close

    // ATR (True Range)
    if (this.atrPrev !== null) {
      const tr = Math.max(c.high - c.low, Math.abs(c.high - this.atrPrev), Math.abs(c.low - this.atrPrev))
      if (this.atrN < this.cfg.atrPeriod) {
        this.atrVal = this.atrVal === null ? tr : (this.atrVal * this.atrN + tr) / (this.atrN + 1)
        this.atrN++
      } else {
        this.atrVal = (this.atrVal! * (this.cfg.atrPeriod - 1) + tr) / this.cfg.atrPeriod
      }
    }
    this.atrPrev = c.close
  }

  resetSession() {
    this.cumPV = 0
    this.cumVol = 0
  }
}
