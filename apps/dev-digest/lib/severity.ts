// 深刻度。SEVERITIES は低い順
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

export const parseSeverity = (text: string): Severity | null => {
  const lower = text.trim().toLowerCase()
  return SEVERITIES.find((severity) => severity === lower) ?? null
}

const rank = (value: Severity): number => SEVERITIES.indexOf(value)

// 深刻度が不明（null）の項目は low として扱う
export const atLeast = (value: Severity | null, threshold: Severity): boolean => rank(value ?? 'low') >= rank(threshold)

export const maxSeverity = (values: Severity[]): Severity | null =>
  values.reduce<Severity | null>((max, value) => (max === null || rank(value) > rank(max) ? value : max), null)
