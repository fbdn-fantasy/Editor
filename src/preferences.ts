export interface Preferences {
  theme: 'system' | 'light' | 'dark'
  scale: number
  fontSize: number
  lineSpacing: number
  highContrast: boolean
  autosave: 'immediate' | 'interval'
  interval: number
  indentWidth: number
  useTabs: boolean
  wrapText: boolean
  wrapCode: boolean
  assistance: boolean
  suggestions: boolean
  closeBrackets: boolean
  closeQuotes: boolean
  matchBrackets: boolean
  smartIndent: boolean
}

export const defaults: Preferences = {
  theme: 'system', scale: 100, fontSize: 14, lineSpacing: 1.5, highContrast: false,
  autosave: 'immediate', interval: 1, indentWidth: 4, useTabs: false,
  wrapText: true, wrapCode: false, assistance: true, suggestions: true,
  closeBrackets: true, closeQuotes: true, matchBrackets: true, smartIndent: true,
}

export function readPreferences(raw: unknown): Preferences {
  const value = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const p = { ...defaults }
  const number = (key: keyof Preferences, min: number, max: number, integer = false) => {
    const n = value[key]
    return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))
      ? n : defaults[key] as number
  }
  if (value.theme === 'dark' || value.theme === 'light') p.theme = value.theme
  if (value.autosave === 'interval') p.autosave = 'interval'
  p.interval = number('interval', Number.MIN_VALUE, Number.MAX_VALUE)
  p.scale = number('scale', 75, 200, true)
  p.fontSize = number('fontSize', 9, 40, true)
  p.lineSpacing = number('lineSpacing', 1, 2.5)
  p.indentWidth = number('indentWidth', 1, 16, true)
  for (const key of ['highContrast', 'useTabs', 'wrapText', 'wrapCode', 'assistance', 'suggestions', 'closeBrackets', 'closeQuotes', 'matchBrackets', 'smartIndent'] as const) {
    if (typeof value[key] === 'boolean') p[key] = value[key]
  }
  return p
}
