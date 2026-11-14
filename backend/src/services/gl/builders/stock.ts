// «ربط الدفاتر» L6 — قيود حركات المخزون من لقطات التكلفة (GlCostSnapshot، المحرّك الوحيد services/costing).
// دوال صرفة: لقطات الحركة + BuildContext ⇒ MoveDraft أو NO_MOVE. القيمة من اللقطة وحدها (لا إعادة تقييم هنا)، والأثر على
// الحسابات من glImpactOf (services/costing/accounts.ts) نفسه الذي تقيس به المطابقة R8/R9 — فمصدر الحقيقة واحد.
//
// دفتر STK، moveType = STOCK:
//   الوارد (WH_ENTRY RECEIVE):   مدين 114001 Δ / دائن 211002 G (= Δ + فرق سدّ الرصيد السالب، والفرق مدين 511001)
//                                 الاستيراد الافتتاحي بعد البدء: الدائن 319002 بدل 211002 (D8) مع تنبيه
//   التسوية ± (WH/VAN_ADJUST):   المخزون Δ / المقابل بالسبب: COUNT|OTHER ⇒ 514002، DAMAGE|EXPIRY ⇒ 514001، SAMPLE ⇒ 611009،
//                                 SHORTAGE_REP ⇒ 113003 على المندوب (OD20)؛ والتصفير ⇒ 514002
//   التحميل والتنزيل:            مدين الهدف بما دخله / دائن المصدر بما خرج، والفرق 511001
//   مرتجع مورّد بلا قيد مورّد:  مدين 211002 / دائن 114001 بالتكلفة (عكس الاستلام غير المفوتر)
//   التبديل (RESTOCK):           المخزون Δ / 514001 بالمذكِّرة (B11)
// السطور مجمَّعة لكل (حساب، شريك) بإشارتها الصافية، والصفرية لا تُدرج. لا سطرين ⇒ NO_MOVE('ZERO_VALUE').
import { glImpactOf } from '../../costing/accounts';
import { MOVE_KINDS, repOfLocation, type CounterRole, type LocationKey, type MoveKind } from '../../costing/types';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type JournalSystemKey, type LineDraft, type LocalDate, type MappingKey,
  type MoveDraft, type MoveType, type SourceEvent, type SourceType,
} from '../types';

/** ما يلزم من صفّ لقطة التكلفة (gl_cost_snapshots) */
export interface CostSnapshotInput {
  sourceKey: string;
  kind: string;
  itemId: string;
  productId: string;
  location: string;
  toLocation: string | null;
  baseQty: number;
  valueMilli: bigint;
  varianceMilli: bigint;
  memoMilli: bigint;
}

/** هدف سطر: الحساب (المعرّف ثم الرمز ثم المفتاح) وشريكه */
export interface LineTarget {
  accountKey?: MappingKey;
  accountCode?: string;
  accountId?: string;
  salesRepId?: string | null;
  vendorId?: string | null;
  partnerName?: string | null;
}

export interface TargetWithLabel {
  target: LineTarget;
  label: string;
}

const targetKey = (t: LineTarget): string =>
  [t.accountId ?? '', t.accountCode ?? '', t.accountKey ?? '', t.salesRepId ?? '', t.vendorId ?? ''].join('|');

/** مجمِّع السطور: صافي موقَّع (مدين +) لكل (حساب، شريك) بترتيب أول ظهور */
export class LineAccumulator {
  private readonly rows = new Map<string, { target: LineTarget; label: string; milli: bigint; extra: Partial<LineDraft> }>();

  add(t: TargetWithLabel, milli: bigint, extra: Partial<LineDraft> = {}): void {
    if (milli === 0n) return;
    const k = targetKey(t.target);
    const r = this.rows.get(k);
    if (r) r.milli += milli;
    else this.rows.set(k, { target: t.target, label: t.label, milli, extra });
  }

  lines(): LineDraft[] {
    const out: LineDraft[] = [];
    for (const r of this.rows.values()) {
      if (r.milli === 0n) continue;
      const t = r.target;
      out.push({
        ...(t.accountId ? { accountId: t.accountId } : t.accountCode ? { accountCode: t.accountCode } : { accountKey: t.accountKey }),
        label: r.label,
        debitMilli: r.milli > 0n ? r.milli : 0n,
        creditMilli: r.milli < 0n ? -r.milli : 0n,
        ...(t.salesRepId ? { salesRepId: t.salesRepId } : {}),
        ...(t.vendorId ? { vendorId: t.vendorId } : {}),
        ...(t.partnerName ? { partnerName: t.partnerName } : {}),
        ...r.extra,
      });
    }
    return out;
  }

  /** Σ المدين − Σ الدائن (صفر في القيد المتوازن) */
  net(): bigint {
    let n = 0n;
    for (const r of this.rows.values()) n += r.milli;
    return n;
  }
}

export const repLabel = (names: Readonly<Record<string, string>> | null | undefined, repId: string | null): string => {
  const n = repId ? names?.[repId] : null;
  return n && n.trim() ? n.trim() : 'مندوب';
};

/** حساب مخزون الموقع: المستودع 114001، والسيارة 114002 بمندوبها (المجهولة بلا مندوب) */
export function inventoryTarget(location: string, repNames?: Readonly<Record<string, string>> | null): TargetWithLabel {
  if (location === 'WH') return { target: { accountKey: 'INVENTORY_WAREHOUSE' }, label: 'مخزون المستودع' };
  if (!location.startsWith('VAN:')) throw new RangeError(`موقع مخزون غير معروف: ${location}`);
  const rep = repOfLocation(location as LocationKey);
  const name = repLabel(repNames, rep);
  return rep
    ? { target: { accountKey: 'INVENTORY_VAN', salesRepId: rep, partnerName: name }, label: `بضاعة لدى المندوب ${name}` }
    : { target: { accountKey: 'INVENTORY_VAN' }, label: 'بضاعة لدى مندوب غير معروف' };
}

/** تكلفة المبيعات: حساب تكلفة فئة الصنف إن رُبط (B12)، وإلا 511001 */
export function cogsTarget(ctx: BuildContext, categoryId: string | null | undefined): TargetWithLabel {
  const cat = categoryId ? ctx.categoryAccounts(categoryId) : null;
  if (cat?.cogsAccountId && ctx.accounts.byId(cat.cogsAccountId)) {
    return { target: { accountId: cat.cogsAccountId }, label: 'تكلفة البضاعة المباعة (حساب الفئة)' };
  }
  return { target: { accountKey: 'COGS' }, label: 'تكلفة البضاعة المباعة' };
}

export const WRITE_OFF_TARGET: TargetWithLabel = { target: { accountKey: 'INVENTORY_WRITEOFF' }, label: 'تالف ومرتجعات لا تعود للمخزون' };
export const COUNT_DIFF_TARGET: TargetWithLabel = { target: { accountKey: 'INVENTORY_ADJUSTMENT' }, label: 'فروقات جرد المخزون' };
export const GRNI_TARGET: TargetWithLabel = { target: { accountKey: 'GRNI' }, label: 'مشتريات مستلمة لم تُفوتر' };
export const OPENING_IMPORT_TARGET: TargetWithLabel = { target: { accountKey: 'OPENING_EQUITY' }, label: 'مخزون افتتاحي مستورد (أرصدة افتتاحية)' };

/** رموز حسابات القالب بلا مفتاح ربط — يُسقط إلى فروقات الجرد إن غاب الحساب عن دليل الشركة */
export const SAMPLES_EXPENSE_CODE = '611009';
export const EMPLOYEE_RECEIVABLE_CODE = '113003';

/** أسباب التسوية (WarehouseEntry.reason / VanLoad.reason، «ربط الدفاتر» L1) */
export const ADJUST_REASONS = ['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER'] as const;

/**
 * مقابل التسوية بسببها (E1/E4، OD16، OD20). salesRepId = مندوب السيارة (العجز عليه). فقدُ حساب القالب (دليل معدَّل) ⇒ 514002
 * مع تنبيه، لا رفض.
 */
export function adjustmentTarget(
  ctx: BuildContext, reason: string | null | undefined, salesRepId: string | null, repNames?: Readonly<Record<string, string>> | null,
): TargetWithLabel & { fallback: boolean } {
  const r = (reason ?? '').toUpperCase();
  if (r === 'DAMAGE' || r === 'EXPIRY') {
    return { ...WRITE_OFF_TARGET, label: r === 'DAMAGE' ? 'تالف المخزون' : 'مخزون منتهي الصلاحية', fallback: false };
  }
  if (r === 'SAMPLE') {
    if (ctx.accounts.byCode(SAMPLES_EXPENSE_CODE)) return { target: { accountCode: SAMPLES_EXPENSE_CODE }, label: 'عينات وهدايا ترويجية بالتكلفة', fallback: false };
    return { ...COUNT_DIFF_TARGET, fallback: true };
  }
  if (r === 'SHORTAGE_REP') {
    if (salesRepId && ctx.accounts.byCode(EMPLOYEE_RECEIVABLE_CODE)) {
      const name = repLabel(repNames, salesRepId);
      return { target: { accountCode: EMPLOYEE_RECEIVABLE_CODE, salesRepId, partnerName: name }, label: `عجز بضاعة على المندوب ${name}`, fallback: false };
    }
    return { ...COUNT_DIFF_TARGET, fallback: true };
  }
  return { ...COUNT_DIFF_TARGET, fallback: false };
}

/** كيف يُحلّ المقابل (counter) لكل دور من أدوار glImpactOf */
export interface CounterResolver {
  (role: CounterRole, snap: CostSnapshotInput): TargetWithLabel | null;
}

export interface ImpactOptions {
  ctx: BuildContext;
  repNames?: Readonly<Record<string, string>> | null;
  /** InvoiceItem.id ⇒ فئة الصنف (تكلفة الفئة) */
  categories?: Readonly<Record<string, string>> | null;
  counter: CounterResolver;
}

const isMoveKind = (k: string): k is MoveKind => (MOVE_KINDS as readonly string[]).includes(k);

/** يضيف أثر لقطة على الحسابات إلى المجمِّع — Σ الأثر صفر لكل لقطة (§8) */
export function addSnapshotImpact(acc: LineAccumulator, snap: CostSnapshotInput, o: ImpactOptions): void {
  if (!isMoveKind(snap.kind)) throw new RangeError(`نوع لقطة تكلفة غير معروف: ${snap.kind}`);
  const im = glImpactOf({
    kind: snap.kind, location: snap.location as LocationKey, toLocation: (snap.toLocation as LocationKey | null) ?? null,
    valueMilli: snap.valueMilli, varianceMilli: snap.varianceMilli, memoMilli: snap.memoMilli, reason: null,
  });
  for (const inv of im.inventory) acc.add(inventoryTarget(inv.location, o.repNames), inv.milli);
  if (im.cogsMilli !== 0n) acc.add(cogsTarget(o.ctx, o.categories?.[snap.itemId] ?? null), im.cogsMilli);
  if (im.writeOffMilli !== 0n) acc.add(WRITE_OFF_TARGET, im.writeOffMilli);
  if (im.counterMilli !== 0n) {
    const c = o.counter(im.counterRole, snap);
    if (!c) throw new RangeError(`مقابل غير محدَّد لدور ${im.counterRole} في ${snap.sourceKey}`);
    acc.add(c, im.counterMilli);
  }
}

/** Σ G للوارد: القيمة الإجمالية التي دخلت (Δ + الفرق) = ما يُقيَّد دائناً على 211002 */
export function receivedValueMilli(snaps: readonly CostSnapshotInput[]): bigint {
  let g = 0n;
  for (const s of snaps) if (s.kind === 'RECEIVE') g += s.valueMilli + s.varianceMilli;
  return g;
}

/** Σ التكلفة الخارجة لمرتجع المورّد (موجبة) */
export function vendorReturnCostMilli(snaps: readonly CostSnapshotInput[]): bigint {
  let c = 0n;
  for (const s of snaps) if (s.kind === 'VENDOR_RETURN') c -= s.valueMilli;
  return c;
}

export function journalCodeOf(ctx: BuildContext, key: JournalSystemKey): string {
  return ctx.journals.bySystemKey(key)?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY[key];
}

export interface DraftHeader {
  journalSystemKey: JournalSystemKey;
  moveType: MoveType;
  date: LocalDate;
  ref?: string | null;
  narration: string;
  sourceType: SourceType;
  sourceId: string;
  sourceKey: string;
  sourceEvent: SourceEvent;
  needsAttention?: boolean;
  attentionReason?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
}

/** المسودة من سطور المجمِّع — أقل من سطرين غير صفريين ⇒ NO_MOVE */
export function draftFrom(ctx: BuildContext, h: DraftHeader, lines: LineDraft[], zeroNote: string): BuildResult {
  const nonZero = lines.filter((l) => l.debitMilli !== 0n || l.creditMilli !== 0n);
  if (nonZero.length < 2) return noMove('ZERO_VALUE', zeroNote);
  let d = 0n;
  let c = 0n;
  for (const l of lines) { d += l.debitMilli; c += l.creditMilli; }
  if (d !== c) throw new RangeError(`قيد ${h.sourceKey} غير متوازن: مدين ${d} ≠ دائن ${c}`);
  const move: MoveDraft = {
    kind: 'MOVE',
    journalCode: journalCodeOf(ctx, h.journalSystemKey),
    journalSystemKey: h.journalSystemKey,
    moveType: h.moveType,
    origin: 'AUTO',
    date: h.date,
    ref: h.ref ?? null,
    narration: h.narration,
    sourceType: h.sourceType,
    sourceId: h.sourceId,
    sourceKey: h.sourceKey,
    sourceEvent: h.sourceEvent,
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
    needsAttention: h.needsAttention === true,
    attentionReason: h.needsAttention ? (h.attentionReason ?? null) : null,
    ...(h.vendorId ? { vendorId: h.vendorId } : {}),
    ...(h.salesRepId ? { salesRepId: h.salesRepId } : {}),
    lines,
  };
  return move;
}

// ═══ حركة مخزون (WH_ENTRY / VAN_LOAD / RESTOCK) ═══

export interface StockMoveInput {
  sourceType: Extract<SourceType, 'WH_ENTRY' | 'VAN_LOAD' | 'RESTOCK'>;
  sourceId: string;
  sourceKey: string;
  sourceEvent: SourceEvent;
  date: LocalDate;
  narration: string;
  ref?: string | null;
  snapshots: readonly CostSnapshotInput[];
  /** سبب التسوية (ADJUST) */
  reason?: string | null;
  /** حركة تصفير (zeroRunId) ⇒ فروقات الجرد أياً كان السبب */
  zeroRun?: boolean;
  /** مقابل دور GRNI: 211002 (الافتراضي) أو 319002 للاستيراد الافتتاحي بعد البدء */
  grniCounter?: 'GRNI' | 'OPENING_EQUITY';
  /** مندوب السيارة (عجز التسوية على المندوب) */
  salesRepId?: string | null;
  repNames?: Readonly<Record<string, string>> | null;
  categories?: Readonly<Record<string, string>> | null;
  needsAttention?: boolean;
  attentionReason?: string | null;
}

export function buildStockMove(input: StockMoveInput, ctx: BuildContext): BuildResult {
  const acc = new LineAccumulator();
  let fallback = false;
  const counter: CounterResolver = (role) => {
    switch (role) {
      case 'GRNI': return input.grniCounter === 'OPENING_EQUITY' ? OPENING_IMPORT_TARGET : GRNI_TARGET;
      // مرتجع مورّد بلا قيد مورّد (غير مسعَّر أو بلا مورّد): يعكس الاستلام غير المفوتر
      case 'VENDOR': return { ...GRNI_TARGET, label: 'مرتجع بضاعة غير مفوترة للمورّد' };
      case 'ADJUSTMENT': {
        if (input.zeroRun) return { ...COUNT_DIFF_TARGET, label: 'تصفير المخزون' };
        const t = adjustmentTarget(ctx, input.reason, input.salesRepId ?? null, input.repNames);
        if (t.fallback) fallback = true;
        return t;
      }
      case 'NONE': return null;
    }
  };
  for (const s of input.snapshots) addSnapshotImpact(acc, s, { ctx, repNames: input.repNames, categories: input.categories, counter });
  if (acc.net() !== 0n) throw new RangeError(`أثر لقطات ${input.sourceKey} غير متوازن (${acc.net()})`);
  const attention = input.needsAttention === true || fallback || input.grniCounter === 'OPENING_EQUITY';
  const reasons = [
    input.needsAttention ? input.attentionReason : null,
    fallback ? `حساب سبب التسوية (${input.reason ?? '—'}) غير موجود في الدليل — رُحّل الفرق إلى فروقات الجرد` : null,
    input.grniCounter === 'OPENING_EQUITY' ? 'مخزون افتتاحي مستورد بعد تاريخ البدء رُحّل إلى 319002 — راجع تصنيفه' : null,
  ].filter((x): x is string => !!x);
  return draftFrom(ctx, {
    journalSystemKey: 'STOCK', moveType: 'STOCK', date: input.date, ref: input.ref ?? null, narration: input.narration,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceKey: input.sourceKey, sourceEvent: input.sourceEvent,
    needsAttention: attention, attentionReason: reasons.join('؛ ') || null,
    salesRepId: input.salesRepId ?? null,
  }, acc.lines(), 'حركة مخزون بلا قيمة');
}

/** وصف عربي لحركة المستودع أو السيارة */
export function stockNarration(kind: 'WH' | 'VAN', type: string, opts: { reason?: string | null; zeroRun?: boolean; repName?: string | null; note?: string | null; ref?: string | null }): string {
  const t = type.toUpperCase();
  const rep = opts.repName ? ` — ${opts.repName}` : '';
  let base: string;
  if (opts.zeroRun) base = kind === 'WH' ? 'تصفير مخزون المستودع' : `تصفير مخزون السيارة${rep}`;
  else if (kind === 'WH') base = t === 'RECEIVE' ? 'استلام بضاعة في المستودع' : t === 'RETURN' ? 'مرتجع بضاعة للمورّد' : 'تسوية مخزون المستودع';
  else base = t === 'LOAD' ? `تحميل سيارة${rep}` : t === 'UNLOAD' ? `تنزيل سيارة${rep}` : t === 'ADJUST' ? `تسوية مخزون السيارة${rep}` : `حركة سيارة${rep}`;
  const reason = opts.reason ? ` (${reasonLabel(opts.reason)})` : '';
  const ref = opts.ref ? ` ${opts.ref}` : '';
  const note = opts.note ? ` — ${opts.note}` : '';
  return `${base}${reason}${ref}${note}`;
}

export function reasonLabel(reason: string): string {
  switch (reason.toUpperCase()) {
    case 'COUNT': return 'جرد';
    case 'DAMAGE': return 'تالف';
    case 'EXPIRY': return 'منتهي الصلاحية';
    case 'SHORTAGE_REP': return 'عجز على المندوب';
    case 'SAMPLE': return 'عينات';
    case 'OTHER': return 'أخرى';
    default: return reason;
  }
}
