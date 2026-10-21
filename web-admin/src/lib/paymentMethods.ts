/**
 * صفحة «طرق الدفع» — منطقٌ صرف معزولٌ عن React ليُختبر وحده: أنواع ردّ الخادم، وقائمة المناديب بطرق الدفع، وأوراق التصدير.
 *
 * القائمة (طلب المالك ٢١ أكتوبر ٢٠٢٦، بدل جدولٍ لكل طريقة): **كلّ مناديب النطاق**، والمندوب يتكرّر مع كلّ طريقة دفع —
 * «محمد نقدي / محمد شبكة / محمد تحويل…» ولو بلا تحصيل (صفر) — ثم إجماليُّه. الحساب نفسه في الخادم
 * (backend/src/services/paymentMethodsReport.ts): النقدي سندات قبضٍ نقدية **و**فواتير بيعٍ نقدي، والتحصيل بلا مندوب خارج
 * القائمة (`noRep`). والبحث يقصّ المناديب ويعيد إجماليَّ المعروض (lib/reportSearch.ts، القاعدة ٢)، والتصدير يتبع الشاشة.
 */
import { filterFlat } from './reportSearch';
import { roundHalfUp } from './money';
import { paymentMethodLabels } from '../utils/format';
import { num, type ExcelSheet } from '../utils/excel';

/** ترتيب الجداول — ترتيب الخادم نفسه (الأكثر استعمالاً في الميدان أولاً). */
export const PAYMENT_METHOD_KEYS = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'] as const;

export interface PmCollected {
  amount: number; count: number;
  /** شقّا النقدي: من سندات القبض ومن فواتير البيع النقدي (صفرٌ في غير النقدي) */
  receiptsAmount: number; receiptsCount: number;
  invoicesAmount: number; invoicesCount: number;
}
export interface PmRow extends PmCollected { salesRepId: string; repName: string; repActive: boolean }
export interface PmBlock { method: string; rows: PmRow[]; total: PmCollected; noRep: { amount: number; count: number } }
export interface PmRosterRep { salesRepId: string; repName: string; repActive: boolean }
export interface PaymentMethodsData {
  range: { from: string; to: string; timezone: string };
  methods: PmBlock[];
  total: { amount: number; count: number };
  noRep: { amount: number; count: number };
  repsCount: number;
  /** كلّ مناديب النطاق (النشطون ومن حصّل) مرتَّبين بالاسم — غيابه من ردٍّ قديم: من حصّل وحدهم */
  roster?: PmRosterRep[];
}

/** سطرٌ في القائمة: مندوبٌ × طريقة دفع */
export interface PmLine extends PmCollected { method: string }
/** مندوبٌ بسطوره (طريقةٌ لكلّ سطر، كلّ الطرق ولو صفراً) وإجماليّه */
export interface PmRepGroup extends PmRosterRep { lines: PmLine[]; total: PmCollected }

type Tr = (ar: string) => string;

/** اسم الطريقة للعرض — خريطة utils/format نفسها التي تعرض بها شاشة السندات الطرقَ الخمس؛ قيمةٌ غريبة تُعرض كما هي. */
export function methodLabel(method: string, tr: Tr): string {
  const ar = paymentMethodLabels[method];
  return ar ? tr(ar) : method;
}

/** اسم المندوب للعرض: الموقوف موسومٌ (تحصيله باقٍ في الفترة)، والاسم الغائب شرطة. */
export function repLabel(r: Pick<PmRow, 'repName' | 'repActive'>, tr: Tr): string {
  const name = r.repName || '—';
  return r.repActive ? name : `${name} (${tr('موقوف')})`;
}

/** «اليوم» بتقويم المتصفّح المحلي — لا toISOString (UTC) التي تعطي الأمس في الرياض قبل الثالثة فجراً. */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const money = (v: number) => roundHalfUp(Number.isFinite(v) ? v : 0, 3);

/** مجموع صفوفٍ معروضة — بالتقريب الموحّد كي يساوي الإجماليُّ مجموعَ ما يُقرأ فوقه. */
export function sumRows(rows: PmCollected[]): PmCollected {
  const t = rows.reduce<PmCollected>((s, r) => ({
    amount: s.amount + (Number(r.amount) || 0), count: s.count + (Number(r.count) || 0),
    receiptsAmount: s.receiptsAmount + (Number(r.receiptsAmount) || 0), receiptsCount: s.receiptsCount + (Number(r.receiptsCount) || 0),
    invoicesAmount: s.invoicesAmount + (Number(r.invoicesAmount) || 0), invoicesCount: s.invoicesCount + (Number(r.invoicesCount) || 0),
  }), { amount: 0, count: 0, receiptsAmount: 0, receiptsCount: 0, invoicesAmount: 0, invoicesCount: 0 });
  return { ...t, amount: money(t.amount), receiptsAmount: money(t.receiptsAmount), invoicesAmount: money(t.invoicesAmount) };
}

const MAX_SHEET_NAME = 31;
/** اسم ورقة Excel: بلا : \ / ? * [ ] (تركية «تحويل بنكي» Havale/EFT تُسقط المصنّف كلّه) وفريدٌ ولا يتجاوز ٣١ حرفاً. */
export function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = n.replace(/[\\/?*[\]:]/g, '·').trim().slice(0, MAX_SHEET_NAME) || '—';
    let key = base;
    for (let i = 2; used.has(key); i++) {
      const suffix = ` (${i})`;
      key = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(key);
    return key;
  });
}

const ZERO: PmCollected = { amount: 0, count: 0, receiptsAmount: 0, receiptsCount: 0, invoicesAmount: 0, invoicesCount: 0 };
const collectedOf = (r: PmCollected | undefined): PmCollected => (r ? {
  amount: r.amount, count: r.count,
  receiptsAmount: r.receiptsAmount, receiptsCount: r.receiptsCount,
  invoicesAmount: r.invoicesAmount, invoicesCount: r.invoicesCount,
} : { ...ZERO });

/**
 * القائمة: كلّ مندوبٍ في النطاق بطرق الدفع كلّها بترتيب الخادم (الخمس ثم ما زاد من سجلٍّ قديم)، صفرٌ حيث لا تحصيل،
 * وإجماليُّه. والمندوب الذي حصّل ولم يرد في القائمة (ردٌّ قديم بلا roster) يُلحق بعدها فلا يسقط تحصيله. والبحث باسم
 * المندوب يقصّ المناديب وحدهم — سطور المندوب المطابق كاملة.
 */
export function repMethodList(data: PaymentMethodsData, query = ''): PmRepGroup[] {
  const methods = data.methods.map((b) => b.method);
  const byRep = new Map<string, Map<string, PmRow>>();
  const seen = new Map<string, PmRosterRep>();
  for (const b of data.methods) {
    for (const r of b.rows) {
      let m = byRep.get(r.salesRepId);
      if (!m) { m = new Map(); byRep.set(r.salesRepId, m); }
      m.set(b.method, r);
      if (!seen.has(r.salesRepId)) seen.set(r.salesRepId, { salesRepId: r.salesRepId, repName: r.repName, repActive: r.repActive });
    }
  }
  const roster: PmRosterRep[] = [...(data.roster ?? [])];
  const listed = new Set(roster.map((r) => r.salesRepId));
  for (const [id, r] of seen) if (!listed.has(id)) roster.push(r);

  const groups: PmRepGroup[] = roster.map((rep) => {
    const lines: PmLine[] = methods.map((method) => ({ method, ...collectedOf(byRep.get(rep.salesRepId)?.get(method)) }));
    return { ...rep, lines, total: sumRows(lines) };
  });
  return filterFlat(groups, query, (g) => [g.repName]);
}

/** إجماليُّ المعروض: مجموع المناديب المعروضين بكلّ الطرق */
export function listTotal(groups: PmRepGroup[]): PmCollected {
  return sumRows(groups.map((g) => g.total));
}

/**
 * أوراق التصدير من القائمة **المعروضة**: ورقة القائمة — سطرٌ لكلّ مندوبٍ وطريقة (اسمه مكرَّر كما على الشاشة) ثم سطر
 * إجماليّه، وسطر الإجمالي العامّ آخرها؛ والنقدي بشقّيه (من السندات ومن الفواتير النقدية). ثم ورقة الإجمالي: طريقةٌ لكلّ
 * صفّ بمجموع المعروض، ومعها تحصيلها بلا مندوب خارج القائمة (من الخادم، لا يمسّه البحث).
 */
export function repListSheets(groups: PmRepGroup[], data: PaymentMethodsData, tr: Tr): ExcelSheet[] {
  const cRep = tr('المندوب'), cMethod = tr('طريقة الدفع'), cAmount = tr('المبلغ'), cCount = tr('عدد العمليات');
  const cFromRc = tr('من سندات القبض'), cFromInv = tr('من الفواتير النقدية');
  const totalLabel = tr('الإجمالي');
  const line = (rep: string, method: string, c: PmCollected, cashParts: boolean): Record<string, unknown> => ({
    [cRep]: rep,
    [cMethod]: method,
    [cAmount]: num(c.amount),
    [cCount]: c.count,
    [cFromRc]: cashParts ? num(c.receiptsAmount) : '',
    [cFromInv]: cashParts ? num(c.invoicesAmount) : '',
  });
  const rows: Record<string, unknown>[] = [];
  for (const g of groups) {
    const name = repLabel(g, tr);
    for (const l of g.lines) rows.push(line(name, methodLabel(l.method, tr), l, l.method === 'CASH'));
    rows.push(line(name, totalLabel, g.total, true));
  }
  rows.push(line(totalLabel, '', listTotal(groups), true));

  const methods = data.methods.map((b) => b.method);
  const summary = methods.map((m) => {
    const t = sumRows(groups.map((g) => g.lines.find((l) => l.method === m) ?? ZERO));
    const noRep = data.methods.find((b) => b.method === m)?.noRep ?? { amount: 0, count: 0 };
    return {
      [cMethod]: methodLabel(m, tr),
      [cAmount]: num(t.amount),
      [cCount]: t.count,
      [tr('تحصيل بلا مندوب')]: num(noRep.amount),
    };
  });
  const names = uniqueSheetNames([tr('قائمة المناديب'), totalLabel]);
  return [
    { name: names[0], rows, colWidths: [26, 18, 16, 14, 18, 20] },
    { name: names[1], rows: summary, colWidths: [20, 16, 14, 18] },
  ];
}
