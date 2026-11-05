/**
 * إلغاء المرتجع أو إطفاء «يعود للمخزون» أو سحب إشعارٍ دائن قياسي يجعل رصيد السيارة سالباً (مراجعة المخزون #8/#16، قرار المالك D10:
 * يُمنع) — الخادم يردّ 409 RETURN_CANCEL_STOCK_SHORT بأسطره، ولا شيء يتغيّر. هنا قراءته ونصّه بلغة الواجهة (نقيٌّ، يُختبر وحده).
 * الصنف المتتبَّع باللوط حارسه القائم (LOT_STOCK_INSUFFICIENT) كما هو.
 */
import type { UnitDef } from './units';

/** سطر الردّ: الصنف ومتاحه في السيارة وما يلزم سحبه بالأساس، والرصيد الذي يُسحب منه */
export interface ReturnCancelShortLine { productId: string; availableBase: number; requiredBase: number; bucket: string }

/** أسماء الأرصدة — مفاتيح القاموس؛ ورصيدٌ غير معروف بلا وسم */
export const RETURN_CANCEL_BUCKET_LABELS: Record<string, string> = {
  SELLABLE: 'المتاح للبيع',
  DAMAGED: 'المرتجع التالف',
  EXPIRED: 'منتهي الصلاحية',
};

/** النصوص — مفاتيح القاموس */
export const RETURN_CANCEL_TEXT = {
  lead: 'لا يمكن لأن رصيد السيارة سيصير سالبا',
  hint: 'بيعت بضاعة المرتجع من السيارة — سجل تحميلها أو تسوية قبل الإلغاء',
  fix: 'سجل تحميلا أو تسوية للسيارة أولا',
  available: 'المتاح',
  required: 'المطلوب سحبه',
} as const;

type ErrBody = { response?: { status?: number; data?: Record<string, unknown> | null } } | null | undefined;

/** ردّ 409 RETURN_CANCEL_STOCK_SHORT ⇒ رسالته وأسطره (الصنف والرصيد مرةً واحدة)، وغيره null */
export function returnCancelShortOf(e: unknown): { message: string; lines: ReturnCancelShortLine[] } | null {
  const d = (e as ErrBody)?.response?.data;
  if (!d || d.code !== 'RETURN_CANCEL_STOCK_SHORT') return null;
  const seen = new Set<string>();
  const lines: ReturnCancelShortLine[] = [];
  for (const raw of Array.isArray(d.lines) ? d.lines : []) {
    const x = raw as Partial<ReturnCancelShortLine> | null;
    if (!x || typeof x.productId !== 'string') continue;
    // الخادم يرسل الدلو بحروفٍ صغيرة (sellable|expired|damaged) — يُوحَّد كبيراً، والغائب «المتاح»
    const bucket = typeof x.bucket === 'string' && x.bucket ? x.bucket.toUpperCase() : 'SELLABLE';
    const k = `${x.productId}|${bucket}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push({ productId: x.productId, availableBase: Number(x.availableBase) || 0, requiredBase: Number(x.requiredBase) || 0, bucket });
  }
  return { message: typeof d.message === 'string' ? d.message : '', lines };
}

/** صنفٌ كما في قوائم الأصناف المخزّنة — اسمه ووحداته لعرض الكمية بالأساس مفكَّكةً («2 كرتون و3 حبة») */
export interface CachedProduct { id: string; name: string; unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null }

/** الصنف من قوائم الأصناف المخزّنة في الصفحة (نافذة الفاتورة ونافذة التحميل) — لا طلب شبكة لرسالة خطأ؛ غائبٌ ⇒ null */
export function cachedProduct(get: (key: readonly unknown[]) => unknown, productId: string): CachedProduct | null {
  for (const key of [['products-all'], ['products-min']] as const) {
    const list = get(key);
    if (!Array.isArray(list)) continue;
    const p = (list as { id?: unknown; name?: unknown }[]).find(x => x?.id === productId);
    if (p && typeof p.name === 'string' && p.name) return p as CachedProduct;
  }
  return null;
}

/** اسم الصنف من القوائم المخزّنة؛ غائبٌ ⇒ null */
export const cachedProductName = (get: (key: readonly unknown[]) => unknown, productId: string): string | null =>
  cachedProduct(get, productId)?.name ?? null;

/**
 * نصّ الرفض: الجملة بلغة الواجهة ثم كل صنفٍ بمتاحه وما يلزم سحبه (ورصيده حين ليس المتاح للبيع). صنفٌ لا يُعرف اسمه في الشاشة ⇒
 * رسالة الخادم بعد الجملة (فيها الأسماء)، وبلا أسطرٍ ولا رسالة ⇒ الجملة وتلميحها.
 */
export function returnCancelShortText(
  s: { message: string; lines: ReturnCancelShortLine[] },
  tr: (ar: string) => string,
  nameOf: (productId: string) => string | null | undefined,
  qtyOf: (productId: string, base: number) => string = (_id, n) => String(Number(n.toFixed(4))),
): string {
  const lead = tr(RETURN_CANCEL_TEXT.lead);
  const named = s.lines.length > 0 && s.lines.every(l => !!nameOf(l.productId));
  if (named) {
    const parts = s.lines.map(l => {
      const b = l.bucket !== 'SELLABLE' && RETURN_CANCEL_BUCKET_LABELS[l.bucket] ? ` (${tr(RETURN_CANCEL_BUCKET_LABELS[l.bucket])})` : '';
      return `${nameOf(l.productId)}${b}: ${tr(RETURN_CANCEL_TEXT.available)} ${qtyOf(l.productId, l.availableBase)} · ${tr(RETURN_CANCEL_TEXT.required)} ${qtyOf(l.productId, l.requiredBase)}`;
    });
    // والعلاج بعد الأسطر (المراجعة UX9) — وإلا عرف المدير السبب ولم يعرف ما يفعل
    return `${lead} — ${parts.join('، ')} — ${tr(RETURN_CANCEL_TEXT.fix)}`;
  }
  return s.message ? `${lead} — ${s.message}` : `${lead} — ${tr(RETURN_CANCEL_TEXT.hint)}`;
}
