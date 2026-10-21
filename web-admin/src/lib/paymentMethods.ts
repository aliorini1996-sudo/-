/**
 * صفحة «طرق الدفع» — منطقٌ صرف معزولٌ عن React ليُختبر وحده: أنواع ردّ الخادم، وتصفية الجداول بالبحث مع إعادة حساب
 * إجمالياتها، وأوراق التصدير.
 *
 * الحساب نفسه في الخادم (backend/src/services/paymentMethodsReport.ts) — النقدي سندات قبضٍ نقدية **و**فواتير بيعٍ نقدي،
 * والتحصيل بلا مندوب خارج الجداول (`noRep`). هنا لا يُعاد إلا ما يمسّه البحث: صفوفٌ مخفيّة ⇒ إجماليٌّ لما بقي معروضاً،
 * وإلا قرأ المدير إجماليَّ عشرين مندوباً تحت جدولٍ يعرض واحداً (lib/reportSearch.ts، القاعدة ٢). والتصدير يتبع الشاشة.
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
export interface PaymentMethodsData {
  range: { from: string; to: string; timezone: string };
  methods: PmBlock[];
  total: { amount: number; count: number };
  noRep: { amount: number; count: number };
  repsCount: number;
}

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

/** الجداول بعد البحث باسم المندوب: بلا بحث كما جاءت، ومع بحثٍ صفوفٌ مطابقة وإجماليٌّ لها وحدها. */
export function filterBlocks(blocks: PmBlock[], query: string): PmBlock[] {
  return blocks.map((b) => {
    const rows = filterFlat(b.rows, query, (r) => [r.repName]);
    return rows === b.rows ? b : { ...b, rows, total: sumRows(rows) };
  });
}

/** نسبة الصفّ من إجمالي جدوله المعروض (تجمع ١٠٠٪ مع البحث أيضاً). */
export function sharePct(amount: number, total: number): number {
  return total > 0 ? Math.round((amount / total) * 100) : 0;
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

/**
 * أوراق التصدير من الجداول **المعروضة**: ورقة الإجمالي (طريقةٌ لكل صفّ، ومعها تحصيلها بلا مندوب خارج الجداول)، ثم ورقةٌ
 * لكل طريقةٍ فيها تحصيل — صفّ لكل مندوب وصفّ «الإجمالي» آخرها. والنقدي بشقّيه: من السندات ومن الفواتير النقدية.
 */
export function paymentMethodsSheets(blocks: PmBlock[], tr: Tr): ExcelSheet[] {
  const cRep = tr('المندوب'), cAmount = tr('المبلغ'), cCount = tr('عدد العمليات');
  const cFromRc = tr('من سندات القبض'), cRcCount = tr('عدد السندات');
  const cFromInv = tr('من الفواتير النقدية'), cInvCount = tr('عدد الفواتير');
  const withParts = (method: string) => method === 'CASH';
  const line = (method: string, name: string, c: PmCollected): Record<string, unknown> => ({
    [cRep]: name,
    [cAmount]: num(c.amount),
    [cCount]: c.count,
    ...(withParts(method) && {
      [cFromRc]: num(c.receiptsAmount), [cRcCount]: c.receiptsCount,
      [cFromInv]: num(c.invoicesAmount), [cInvCount]: c.invoicesCount,
    }),
  });

  const filled = blocks.filter((b) => b.rows.length > 0);
  const names = uniqueSheetNames([tr('الإجمالي'), ...filled.map((b) => methodLabel(b.method, tr))]);
  const summary: ExcelSheet = {
    name: names[0],
    rows: blocks.map((b) => ({
      [tr('طريقة الدفع')]: methodLabel(b.method, tr),
      [cAmount]: num(b.total.amount),
      [cCount]: b.total.count,
      [tr('تحصيل بلا مندوب')]: num(b.noRep.amount),
    })),
    colWidths: [20, 16, 14, 18],
  };
  const perMethod: ExcelSheet[] = filled.map((b, i) => ({
    name: names[i + 1],
    rows: [...b.rows.map((r) => line(b.method, repLabel(r, tr), r)), line(b.method, tr('الإجمالي'), b.total)],
    colWidths: withParts(b.method) ? [26, 16, 14, 18, 14, 20, 14] : [26, 16, 14],
  }));
  return [summary, ...perMethod];
}
