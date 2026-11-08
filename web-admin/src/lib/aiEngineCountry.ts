/**
 * جدول «محرّك الذكاء × الدولة» للوحة المالك — من الحقل `ai.byEngineCountry` في `/analytics/stats`.
 *
 * الخادم يرسل قائمة مسطّحة (محرّك، دولة، عدد)؛ هنا تُطوى مصفوفة: صفوف المحرّكات بترتيب
 * مجموعها، وأعمدة أعلى الدول، وعمود «دول أخرى» يجمع البقية فلا يضيع عدد. الدولة الغائبة
 * (زائر رفض القياس أو فشل تحديد الموقع) عمود باسمها «غير معروفة» لا تُسقط.
 */

export interface AiEngineCountryItem { engine: string; country: string | null; countryCode: string | null; count: number }

export interface EngineCountryMatrix {
  /** أعمدة الدول بالترتيب؛ `key` فارغ = غير معروفة، و`other` = دول أخرى */
  columns: { key: string; label: string; countryCode: string | null; total: number }[];
  rows: { engine: string; cells: number[]; total: number }[];
  total: number;
}

export const UNKNOWN_COUNTRY = 'غير معروفة';
export const OTHER_COUNTRIES = 'دول أخرى';
const OTHER_KEY = '\u0000other';

export function buildEngineCountryMatrix(items: AiEngineCountryItem[] | null | undefined, maxCountries = 6): EngineCountryMatrix {
  const list = (items || []).filter((i) => i && i.engine && i.count > 0);
  const byCountry = new Map<string, { label: string; countryCode: string | null; total: number }>();
  const byEngine = new Map<string, number>();
  for (const i of list) {
    const key = i.country || '';
    const c = byCountry.get(key) || { label: i.country || UNKNOWN_COUNTRY, countryCode: i.countryCode, total: 0 };
    c.total += i.count;
    if (!c.countryCode && i.countryCode) c.countryCode = i.countryCode;
    byCountry.set(key, c);
    byEngine.set(i.engine, (byEngine.get(i.engine) || 0) + i.count);
  }

  const ranked = [...byCountry.entries()].sort((a, b) => b[1].total - a[1].total || a[1].label.localeCompare(b[1].label));
  // عمود «دول أخرى» لا يُفتح لدولة واحدة زائدة — تُعرض باسمها بدلاً منه
  const keep = ranked.length > maxCountries + 1 ? ranked.slice(0, maxCountries) : ranked;
  const kept = new Set(keep.map(([k]) => k));
  const columns: EngineCountryMatrix['columns'] = keep.map(([key, c]) => ({ key, label: c.label, countryCode: c.countryCode, total: c.total }));
  const rest = ranked.filter(([k]) => !kept.has(k));
  if (rest.length) {
    columns.push({ key: OTHER_KEY, label: OTHER_COUNTRIES, countryCode: null, total: rest.reduce((s, [, c]) => s + c.total, 0) });
  }
  const colIndex = new Map(columns.map((c, idx) => [c.key, idx]));

  const engines = [...byEngine.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = engines.map(([engine, total]) => ({ engine, cells: columns.map(() => 0), total }));
  const rowIndex = new Map(rows.map((r, idx) => [r.engine, idx]));
  for (const i of list) {
    const key = i.country || '';
    const col = colIndex.get(kept.has(key) ? key : OTHER_KEY)!;
    rows[rowIndex.get(i.engine)!].cells[col] += i.count;
  }

  return { columns, rows, total: rows.reduce((s, r) => s + r.total, 0) };
}
