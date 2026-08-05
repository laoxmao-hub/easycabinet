/**
 * Formats project code for display.
 * Example: MED026_BLDG1_2240 -> MED026_BLDG1
 * It removes the ID suffix (the part after the last underscore when there are 3 or more parts).
 */
export function formatProjectCode(code: string | undefined | null): string {
 if (!code) return '';
 const parts = code.split('_');
 if (parts.length >= 3) {
 return parts.slice(0, 2).join('_');
 }
 return code;
}

/**
 * Formats project name for display.
 * Example: ELM026_ELMB1_4445 -> ELM026_ELMB1
 * It removes the ID suffix if it has 3 or more parts separated by underscores.
 */
export function formatProjectName(name: string | undefined | null): string {
 if (!name) return '';
 const parts = name.split('_');
 if (parts.length >= 3) {
 return parts.slice(0, 2).join('_');
 }
 return name;
}

// Color palette for project groups
const GROUP_COLORS = [
 { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200', dot: 'bg-indigo-500' },
 { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-500' },
 { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
 { bg: 'bg-rose-100', text: 'text-rose-700', border: 'border-rose-200', dot: 'bg-rose-500' },
 { bg: 'bg-cyan-100', text: 'text-cyan-700', border: 'border-cyan-200', dot: 'bg-cyan-500' },
 { bg: 'bg-violet-100', text: 'text-violet-700', border: 'border-violet-200', dot: 'bg-violet-500' },
 { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500' },
 { bg: 'bg-pink-100', text: 'text-pink-700', border: 'border-pink-200', dot: 'bg-pink-500' },
 { bg: 'bg-teal-100', text: 'text-teal-700', border: 'border-teal-200', dot: 'bg-teal-500' },
 { bg: 'bg-sky-100', text: 'text-sky-700', border: 'border-sky-200', dot: 'bg-sky-500' },
];

export type DisplayUnit = 'mm' | 'inch';

/**
 * Convert mm to inch (1 inch = 25.4 mm)
 */
export function mmToInch(mm: number): number {
  return mm / 25.4;
}

/**
 * Format a single dimension value based on the display unit.
 * If unit is 'inch', converts from mm to inch and rounds to 2 decimal places.
 */
export function formatDim(mmValue: number | undefined | null, unit: DisplayUnit): string {
  const v = mmValue || 0;
  if (unit === 'inch') {
    return mmToInch(v).toFixed(1);
  }
  return String(v);
}

/**
 * Format dimensions string (W x D x H) with unit support.
 */
export function formatDimensions(
  w: number | undefined | null,
  d: number | undefined | null,
  h: number | undefined | null,
  unit: DisplayUnit,
  separator: string = 'x',
): string {
  return `${formatDim(w, unit)}${separator}${formatDim(d, unit)}${separator}${formatDim(h, unit)}`;
}

const groupColorCache: Record<string, typeof GROUP_COLORS[0]> = {};

export function getProjectGroupColor(groupCode: string): typeof GROUP_COLORS[0] {
 if (!groupCode) return { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', dot: 'bg-slate-400' };
 if (groupColorCache[groupCode]) return groupColorCache[groupCode];
 let hash = 0;
 for (let i = 0; i < groupCode.length; i++) {
   hash = ((hash << 5) - hash + groupCode.charCodeAt(i)) | 0;
 }
 const color = GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
 groupColorCache[groupCode] = color;
 return color;
}

