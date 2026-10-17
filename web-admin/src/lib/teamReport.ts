/**
 * «فرق العمل» في التقارير (طلب المالك ١٧ أكتوبر ٢٠٢٦): تقسيم أوراق التصدير ورقةً لكل فريق.
 *
 * كل ورقة مستنداتٍ تحمل عمود الفريق تُقسَم بقيمته — «فريق المكسرات · المرتجعات»، «بلا فريق · المرتجعات» — فلا يفصل
 * المدير التقرير يدوياً. والورقة بلا عمود الفريق (ملخّصٌ أو تقريرٌ قائم على المندوب) أو ذات الخلايا الموحّدة (أرقام صفوفها
 * محسوبة على الورقة كاملة) تبقى كما هي. واسم الورقة منقّى وفريد ولا يتجاوز ٣١ حرفاً (حدود Excel).
 */
import type { ExcelSheet } from '../utils/excel';

const MAX_SHEET_NAME = 31;
const clean = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').trim();

export function splitSheetsByTeam(sheets: ExcelSheet[], teamCol: string): ExcelSheet[] {
  const used = new Set<string>();
  const unique = (name: string) => {
    const base = clean(name).slice(0, MAX_SHEET_NAME) || '—';
    let key = base;
    for (let i = 2; used.has(key); i++) {
      const suffix = ` (${i})`;
      key = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(key);
    return key;
  };
  const out: ExcelSheet[] = [];
  for (const sh of sheets) {
    if (sh.merges?.length || !sh.rows.length || !(teamCol in sh.rows[0])) {
      out.push({ ...sh, name: unique(sh.name) });
      continue;
    }
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of sh.rows) {
      const k = String(r[teamCol] ?? '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const [team, rows] of groups) out.push({ ...sh, name: unique(`${team} · ${sh.name}`), rows });
  }
  return out;
}
