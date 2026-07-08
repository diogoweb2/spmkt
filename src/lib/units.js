// Unit handling and price normalization.
// Weight items normalize to price per 100 g, volume to price per 100 ml,
// count items to price per unit.

export const UNITS = {
  kg: { kind: 'weight', toBase: 1000, label: 'kg' },
  g: { kind: 'weight', toBase: 1, label: 'g' },
  lb: { kind: 'weight', toBase: 453.592, label: 'lb' },
  oz: { kind: 'weight', toBase: 28.3495, label: 'oz' },
  L: { kind: 'volume', toBase: 1000, label: 'L' },
  ml: { kind: 'volume', toBase: 1, label: 'ml' },
  un: { kind: 'count', toBase: 1, label: 'unit' },
}

export const KIND_UNITS = {
  weight: ['kg', 'lb', 'g', 'oz'],
  volume: ['L', 'ml'],
  count: ['un'],
}

export const KIND_LABEL = {
  weight: '100 g',
  volume: '100 ml',
  count: 'unit',
}

export function unitKind(unit) {
  return UNITS[unit]?.kind ?? 'count'
}

// price for `qty` of `unit` -> normalized price (per 100g / 100ml / per unit)
export function normalizedPrice(price, qty, unit) {
  const u = UNITS[unit]
  if (!u || !qty || qty <= 0) return null
  const base = qty * u.toBase
  if (u.kind === 'count') return price / base
  return (price / base) * 100
}

export function fmtMoney(n) {
  if (n == null || !isFinite(n)) return '—'
  return '$' + n.toFixed(2)
}

export function fmtNorm(n, kind) {
  if (n == null || !isFinite(n)) return '—'
  const price = n < 0.1 ? n.toFixed(3) : n.toFixed(2)
  return `$${price} / ${KIND_LABEL[kind]}`
}

// Display prices the way supermarkets show them: $/lb or $/kg for weight
// (user preference), $/L for volume, $/unit for count. `n` is the internal
// normalized price (per 100 g / 100 ml / unit).
export function displayUnitLabel(kind, weightUnit = 'lb') {
  if (kind === 'weight') return weightUnit
  if (kind === 'volume') return 'L'
  return 'unit'
}

export function toDisplay(n, kind, weightUnit = 'lb') {
  if (n == null || !isFinite(n)) return null
  if (kind === 'weight') return weightUnit === 'kg' ? n * 10 : n * (UNITS.lb.toBase / 100)
  if (kind === 'volume') return n * 10
  return n
}

export function fmtDisplay(n, kind, weightUnit = 'lb') {
  const d = toDisplay(n, kind, weightUnit)
  if (d == null) return '—'
  const price = d < 0.1 ? d.toFixed(3) : d.toFixed(2)
  return `$${price} / ${displayUnitLabel(kind, weightUnit)}`
}

export function fmtQty(qty, unit) {
  const u = UNITS[unit]
  if (!u) return `${qty}`
  if (u.kind === 'count') return qty === 1 ? '1 unit' : `${qty} units`
  return `${qty} ${u.label}`
}

// Convert an annual amount in base units (g / ml / units) to a friendly string
export function fmtAnnual(baseAmount, kind) {
  if (kind === 'weight') return `${Math.round(baseAmount / 1000)} kg`
  if (kind === 'volume') return `${Math.round(baseAmount / 1000)} L`
  return `${Math.round(baseAmount)} units`
}

// Sensible yearly consumption defaults for a family of 4, in base units.
export function defaultAnnual(category, kind) {
  if (kind === 'volume') {
    if (category === 'dairy') return 250 * 1000 // 250 L (milk-ish)
    return 100 * 1000
  }
  if (kind === 'weight') {
    if (category === 'meat') return 80 * 1000 // 80 kg
    if (category === 'dairy') return 30 * 1000
    if (category === 'produce') return 100 * 1000
    return 40 * 1000
  }
  return 52 // once a week
}

export function annualSliderRange(kind) {
  if (kind === 'weight') return { min: 1000, max: 300 * 1000, step: 1000 }
  if (kind === 'volume') return { min: 1000, max: 600 * 1000, step: 1000 }
  return { min: 1, max: 365, step: 1 }
}
