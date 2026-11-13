/**
 * «الحذف النهائي» لمالك المنصة وحده (أمر المالك ٥ نوفمبر ٢٠٢٦): «صلاحية حذف اي فاتورة او اي مستند مهما كان السبب بدون اي استثناء
 * ابدا فقط مالك المنصة… حتى اللوكيشن وكل شي بلا استثناء»، وقراره: حذفٌ نهائي من القاعدة (لا إلغاء)، وسند القبض المرتبط بفاتورةٍ
 * محذوفة يُحذف معها.
 *
 * محرّكٌ عامّ على نموذج Prisma نفسه (Prisma.dmmf) فيشمل كل جدولٍ فيه `tenantId` — الفاتورة والسند والتحميل والوارد واللوكيشن
 * والعميل والصنف والمندوب وغيرها — بلا قائمة يدوية تتقادم:
 * - كل صفٍّ يشير إلى المحذوف بمفتاحٍ **إلزامي** يُحذف معه (تتابعياً)؛ وبمفتاحٍ **اختياري** يُفرَّغ مفتاحه (null) ويبقى الصف —
 *   فحذف لوكيشن لا يمحو فواتيرها، بل يرفع وسمها. والاستثناء قيود كشف الحساب (AccountEntry) فتُحذف مع فاتورتها/سندها.
 * - الفاتورة المحذوفة تسحب معها كل سند قبضٍ خُصّص لها (قرار المالك)، والسند المحذوف (القائم) يعيد مبالغ تخصيصه لفواتيرٍ باقية.
 * - الأرصدة المخزَّنة تُصحَّح بعد الحذف: رصيد العميل من مجموع قيوده الباقية (currentBalance)، و«إجمالي المبيعات/التحصيل» بأثر
 *   المستندات القائمة المحذوفة (الملغاة عُكس أثرها يوم إلغائها). ورصيد السيارة والمستودع واللوط مشتقّةٌ من الصفوف فتتبعها وحدها.
 * - المعاينة (dry run) تعدّ ما سيُحذف وما يُفرَّغ قبل التنفيذ، والتنفيذ معاملةٌ واحدة: كله أو لا شيء.
 * - «ربط الدفاتر» (قرار المالك OD1، ١٣ نوفمبر ٢٠٢٦): جداول الدفاتر (Gl*) وكشف المورّد وتخصيصاته وسجلّ «إعادة المرتجع للمخزون»
 *   لا تُستهدف أبداً لأي شركة. والشركة **المربوطة** لا يُحذف فيها مستندٌ مرحَّل المصدر ولا يُفرَّغ مفتاحٌ فيه (409
 *   BOOKS_LINKED_NO_DELETE — الإلغاء أو الإشعار الدائن بدل الحذف). والشركة اليدوية كما كانت تماماً، ومعها توابع المورّد
 *   الجديدة: حذف وارد المستودع يحذف قيود مورّده وتخصيصات الدفعات عليه وسنده الآلي (النقدي) ومرتجعاته، وحذف سند الصرف يحذف
 *   قيوده وتخصيصاته — فلا ينفجر مفتاحٌ بلا تعاقب (NoAction) ولا يبقى في كشف المورّد أثرُ مستندٍ محذوف.
 *   وفاتورة المورّد تُحذف مستهدفةً بذاتها وحدها: حذفٌ يبتر أسطرها أو يُفرغها بحذف غيرها (الصنف) يُرفض لكل شركة (409
 *   SUPPLIER_BILLS_NO_DELETE — assertPurgeKeepsSupplierBills)، فلا تُمحى بقيودها بالتعاقب ولا يبقى إجماليها على قيمةٍ قديمة.
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { clean, currentBalance } from './accounting';
import { restoreAllocations } from './docCancel';
import { LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE, tenantBooksLinked, type BookModeDb } from './booksMode';

type Tx = Prisma.TransactionClient;
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS: readonly DmmfModel[] = Prisma.dmmf.datamodel.models;
const byName = new Map(MODELS.map((m) => [m.name, m]));

/**
 * مفاتيح اختيارية تُحذف صفوفها مع المحذوف بدل تفريغها: قيود كشف الحساب أثرُ الفاتورة/السند نفسه، وقيود كشف المورّد أثرُ
 * وارد المستودع/سند الصرف نفسه (قيدٌ بلا مستنده يُبقي في رصيد المورّد مبلغاً لا مصدر له)
 */
const DELETE_ON_OPTIONAL = new Set([
  'AccountEntry.invoiceId', 'AccountEntry.receiptId',
  'SupplierLedgerEntry.warehouseEntryId', 'SupplierLedgerEntry.supplierPaymentId',
]);

/** جداول الدفاتر: كل نموذجٍ يبدأ اسمه بـGl (مشتقٌّ من نموذج Prisma وقت التشغيل — لا قائمة يدوية تتقادم) */
export const isLedgerModel = (name: string): boolean => /^Gl[A-Z]/.test(name);

/**
 * لا يُستهدف مباشرة لأي شركة: الشركة نفسها (لها مسارها في لوحة المالك)، وجداول الدفاتر كلها (Gl* — ومنها سجلّ الموردين
 * وله مساره routes/suppliers.ts)، وسجلّات المورّد الإلحاقية (كشفه وتخصيصات دفعاته) وسجلّ «إعادة المرتجع للمخزون»: تُحذف
 * تابعةً لمستندها وحده لا منفردة. وجداول المنصة بلا شركة لا تدخل أصلاً (hasTenantId)
 */
const NOT_TARGETABLE: ReadonlySet<string> = new Set([
  'Tenant',
  ...MODELS.filter((m) => isLedgerModel(m.name)).map((m) => m.name),
  'SupplierLedgerEntry', 'SupplierPaymentAllocation', 'InvoiceRestockLog',
]);

/**
 * مستندات المصدر المرحَّلة (وبنودها وتوابعها التي تحدّد مبالغها) — في الشركة المربوطة لا تُحذف ولا يُفرَّغ فيها مفتاح
 * (عميل/مندوب/لوكيشن/صنف…: تغيير بُعدٍ في مستندٍ رُحّل قيده يفصل التشغيل عن الدفاتر). يطابق مصادر المُطابِق
 * (services/gl/sync: الفاتورة والسند وقيود العميل والاستلام والتسوية والمستودع والتحميل والمرتجع) وكشف المورّد (L1)
 */
export const LINKED_POSTED_SOURCES: ReadonlySet<string> = new Set([
  'Invoice', 'InvoiceItem', 'Receipt', 'ReceiptInvoice', 'AccountEntry',
  'RepSettlement', 'UserSettlement', 'SettlementEntry', 'Payout',
  'WarehouseEntry', 'WarehouseEntryItem', 'VanLoad', 'VanLoadItem',
  'SupplierLedgerEntry', 'SupplierPayment', 'SupplierPaymentAllocation', 'InvoiceRestockLog',
]);

export const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/** مفاتيح الصف الأساسية: @id أو @@id */
function pkFields(m: DmmfModel): string[] {
  const single = m.fields.filter((f) => f.isId).map((f) => f.name);
  if (single.length) return single;
  return m.primaryKey?.fields ? [...m.primaryKey.fields] : [];
}

/** كل علاقةٍ واردة إلى `target`: نموذجٌ آخر يحمل مفتاحاً أجنبياً (حقلاً واحداً) يشير إليه */
/** required: المفتاح إلزامي؛ cascade: onDelete: Cascade في المخطط (مثل قاعدة قائمة أسعارٍ لصنفٍ بعينه — اختيارية لكنها تُحذف معه) */
interface Inbound { child: DmmfModel; fk: string; ref: string; required: boolean; cascade: boolean }
const inboundCache = new Map<string, Inbound[]>();
export function inboundOf(target: string): Inbound[] {
  const hit = inboundCache.get(target);
  if (hit) return hit;
  const out: Inbound[] = [];
  for (const m of MODELS) {
    for (const f of m.fields as DmmfField[]) {
      if (f.kind !== 'object' || f.type !== target) continue;
      const from = f.relationFromFields ?? [];
      const to = f.relationToFields ?? [];
      if (from.length !== 1 || to.length !== 1) continue; // المفاتيح المركّبة غير مستعملة لمستندات الشركة
      const fkField = m.fields.find((x) => x.name === from[0]);
      out.push({ child: m, fk: from[0], ref: to[0], required: !!fkField?.isRequired, cascade: (f as { relationOnDelete?: string }).relationOnDelete === 'Cascade' });
    }
  }
  inboundCache.set(target, out);
  return out;
}

/** يُحذف الصفّ الابن مع المحذوف: مفتاحه إلزامي، أو المخطط يسلسل حذفه (Cascade)، أو هو من DELETE_ON_OPTIONAL — وإلا يُفرَّغ مفتاحه */
const deletesWith = (r: Inbound): boolean => r.required || r.cascade || DELETE_ON_OPTIONAL.has(`${r.child.name}.${r.fk}`);

export const hasTenantId = (m: DmmfModel | undefined): boolean => !!m?.fields.some((f) => f.name === 'tenantId' && f.kind === 'scalar');

/** النماذج القابلة للاستهداف: كل نموذجٍ فيه tenantId عدا NOT_TARGETABLE */
export function targetableModels(): string[] {
  return MODELS.filter((m) => hasTenantId(m) && !NOT_TARGETABLE.has(m.name)).map((m) => m.name).sort();
}

/** الحقول التي تصلح وصفاً/بحثاً للصف */
const LABEL_FIELDS = ['number', 'name', 'title', 'code', 'username', 'phone', 'email', 'label', 'type', 'status'];
export function labelFieldsOf(model: string): string[] {
  const m = byName.get(model);
  if (!m) return [];
  return LABEL_FIELDS.filter((n) => m.fields.some((f) => f.name === n && f.kind === 'scalar' && f.type === 'String'));
}

export interface PurgePlan {
  model: string;
  /** دفعات الحذف بترتيب الاكتشاف (الأب قبل ابنه) — التنفيذ بالعكس */
  batches: Array<{ model: string; keys: Array<Record<string, unknown>> }>;
  nullify: Array<{ model: string; fk: string; values: unknown[]; count: number }>;
  counts: Record<string, number>;
  nullCounts: Record<string, number>;
  invoiceIds: string[];
  receiptIds: string[];
}

const keyOf = (pk: string[], row: Record<string, unknown>) => JSON.stringify(pk.map((k) => row[k]));

/**
 * يبني خطة الحذف لصفٍّ واحد (أو أكثر) من `model` داخل الشركة `tenantId`. يقرأ فقط.
 * يرمي PurgeRefused إن لم يوجد الصف في هذه الشركة.
 */
export class PurgeRefused extends Error {
  /** حالة HTTP المقترحة: 404 (غير موجود/غير معروف — كما كان) أو 409 (دفاتر الشركة مربوطة) */
  readonly status: number;
  /** رمز الرفض للواجهة (BOOKS_LINKED_NO_DELETE) — null للرفض القديم */
  readonly code: string | null;
  /** النماذج المرحَّلة التي كانت الخطة ستمسّها (رفض الشركة المربوطة) */
  readonly models: string[];
  constructor(message: string, opts: { status?: number; code?: string; models?: readonly string[] } = {}) {
    super(message);
    this.name = 'PurgeRefused';
    this.status = opts.status ?? 404;
    this.code = opts.code ?? null;
    this.models = [...(opts.models ?? [])];
  }
}

/** للنموذج حقلٌ عددي (scalar) بهذا الاسم في نموذج Prisma الحالي — عميلٌ قديم لم يُولَّد بعد ترحيلٍ لا يرى الحقول الجديدة */
const hasScalar = (model: string, field: string): boolean =>
  !!byName.get(model)?.fields.some((f) => f.name === field && f.kind === 'scalar');

export async function buildPurgePlan(db: Tx | typeof prisma, tenantId: string, model: string, idOrIds: string | readonly string[]): Promise<PurgePlan> {
  // صفٌّ واحد أو عدّة صفوف من النوع نفسه (التحديد الجماعي في القوائم) — كلها من هذه الشركة وإلا رُفض الطلب كله
  const ids = [...new Set(typeof idOrIds === 'string' ? [idOrIds] : idOrIds)];
  if (!ids.length || ids.length > 500) throw new PurgeRefused('حدد من ١ إلى ٥٠٠ سجل');
  const root = byName.get(model);
  if (!root || !hasTenantId(root) || NOT_TARGETABLE.has(model)) throw new PurgeRefused('نوع غير معروف');
  const pk = pkFields(root);
  if (pk.length !== 1) throw new PurgeRefused('نوع غير مدعوم');
  const d = (db as unknown as Record<string, { findMany(a: unknown): Promise<Array<Record<string, unknown>>>; count(a: unknown): Promise<number> }>);
  const first = await d[delegateOf(model)].findMany({ where: { [pk[0]]: { in: ids }, tenantId }, select: { [pk[0]]: true } });
  if (first.length !== ids.length) throw new PurgeRefused(ids.length === 1 ? 'السجل غير موجود في هذه الشركة' : 'بعض السجلات المحددة غير موجودة في هذه الشركة');

  const plan: PurgePlan = { model, batches: [], nullify: [], counts: {}, nullCounts: {}, invoiceIds: [], receiptIds: [] };
  const seen = new Map<string, Set<string>>();
  const seenOf = (m: string) => { let s = seen.get(m); if (!s) { s = new Set(); seen.set(m, s); } return s; };

  // طابور: (نموذج، شرط) — كل دفعةٍ تُقرأ بمفاتيحها الأساسية والحقول المُشار إليها
  const queue: Array<{ model: string; where: Record<string, unknown> }> = [{ model, where: { [pk[0]]: { in: ids }, tenantId } }];
  let guard = 0;
  while (queue.length) {
    if (++guard > 5000) throw new PurgeRefused('سلسلة الحذف أطول من المسموح');
    const { model: mName, where } = queue.shift()!;
    const m = byName.get(mName)!;
    const mpk = pkFields(m);
    if (!mpk.length) continue;
    const inbound = inboundOf(mName);
    const refs = [...new Set(inbound.map((r) => r.ref))];
    const select: Record<string, true> = {};
    for (const f of [...mpk, ...refs]) select[f] = true;
    const rows = await d[delegateOf(mName)].findMany({ where, select });
    const s = seenOf(mName);
    const fresh = rows.filter((r) => { const k = keyOf(mpk, r); if (s.has(k)) return false; s.add(k); return true; });
    if (!fresh.length) continue;
    plan.batches.push({ model: mName, keys: fresh.map((r) => Object.fromEntries(mpk.map((k) => [k, r[k]]))) });
    plan.counts[mName] = (plan.counts[mName] ?? 0) + fresh.length;
    if (mName === 'Invoice') plan.invoiceIds.push(...fresh.map((r) => String(r.id)));
    if (mName === 'Receipt') plan.receiptIds.push(...fresh.map((r) => String(r.id)));

    for (const r of inbound) {
      const values = [...new Set(fresh.map((x) => x[r.ref]).filter((v) => v !== null && v !== undefined))];
      if (!values.length) continue;
      const cw = { [r.fk]: { in: values } };
      if (deletesWith(r)) {
        queue.push({ model: r.child.name, where: cw });
      } else {
        const count = await d[delegateOf(r.child.name)].count({ where: cw });
        if (count) {
          plan.nullify.push({ model: r.child.name, fk: r.fk, values, count });
          plan.nullCounts[r.child.name] = (plan.nullCounts[r.child.name] ?? 0) + count;
        }
      }
    }
    // قرار المالك: الفاتورة المحذوفة تسحب معها سندات القبض المخصَّصة لها
    if (mName === 'Invoice') {
      const ids = fresh.map((x) => x.id);
      const links = await (db as typeof prisma).receiptInvoice.findMany({ where: { invoiceId: { in: ids as string[] } }, select: { receiptId: true } });
      const rids = [...new Set(links.map((l) => l.receiptId))];
      if (rids.length) queue.push({ model: 'Receipt', where: { id: { in: rids } } });
    }
    // «ربط الدفاتر» L1: وارد المستودع المحذوف يسحب معه ما لا معنى له بدونه ويشير إليه بمعرّفٍ لا بعلاقة (فلا يكتشفه المحرّك):
    //  - سنده الآلي (الاستلام النقدي: سند صرفٍ مخصَّص بالكامل لهذه الحركة — autoForEntryId) — فتُحذف معه قيوده وتخصيصه
    //    (DELETE_ON_OPTIONAL والتعاقب). أما سندات الصرف العادية المخصَّصة له فتبقى: يُحذف تخصيصها عليه وحده فتصير دفعةً مقدّمة.
    //  - مرتجعاته للمورّد (حركات RETURN بـreturnOfEntryId): خروجٌ من مخزونٍ لم يعد له دخول، وقيد RETURN يُنقص رصيد مورّدٍ
    //    لا فاتورة له — فتُحذف معه كما تُحذف بنوده. وقيود المورّد للحركة نفسها (BILL وعكسها) بـDELETE_ON_OPTIONAL أعلاه.
    if (mName === 'WarehouseEntry') {
      const eids = fresh.map((x) => x.id);
      if (hasScalar('SupplierPayment', 'autoForEntryId')) queue.push({ model: 'SupplierPayment', where: { autoForEntryId: { in: eids }, tenantId } });
      if (hasScalar('WarehouseEntry', 'returnOfEntryId')) queue.push({ model: 'WarehouseEntry', where: { returnOfEntryId: { in: eids }, tenantId } });
    }
  }
  return plan;
}

/** رفض الحذف لأنه يمسّ فواتير موردين دون الفاتورة نفسها (assertPurgeKeepsSupplierBills) — لكل شركة، مربوطةً أو لا */
export const SUPPLIER_BILLS_NO_DELETE_CODE = 'SUPPLIER_BILLS_NO_DELETE';
export const SUPPLIER_BILLS_NO_DELETE_MESSAGE =
  'هذا الحذف يمسّ أسطراً في فواتير موردين (شراء نقدي أو آجل أو مرتجع للمورّد) دون الفاتورة نفسها: تُمحى الفاتورة بقيودها من كشف المورّد أو يبقى إجماليها على قيمته القديمة — احذف حركة المستودع (فاتورة المورّد) نفسها أولاً';

/**
 * «ربط الدفاتر» L1 — فاتورة المورّد لا تُمسّ إلا مستهدفةً بذاتها: الخطة تحذف أسطر حركات مستودع (WarehouseEntryItem — بحذف الصنف،
 * ومفتاحه إلزامي) ولا تحذف الحركة نفسها، والحركة لها أثرٌ في كشف المورّد (مصنَّفة نقداً أو آجلاً، أو عليها قيود مورّد أو تخصيصات
 * سندات صرف) ⇒ PurgeRefused 409 SUPPLIER_BILLS_NO_DELETE قبل أي كتابة، لكل شركة (لا المربوطة وحدها).
 * لأن الحذف يومها يُفسد الكشف بلا رجعة:
 *   - الحركة التي تفرغ من أسطرها يُحذف رأسها بعد الحذف (emptiedHeaderCandidates) ومعه قيود BILL/RETURN (DELETE_ON_OPTIONAL)
 *     وتخصيصات السندات والسند الآلي ومرتجعاتها — فيبقى سند الصرف اليدوي «دفعةً مقدّمة» عن دينٍ سُدّد فعلاً، ويُمحى مرتجعٌ أُرجعت بضاعته.
 *   - والتي يبقى فيها صنفٌ آخر يبقى إجماليها وقيد BILL على قيمتها القديمة، فيأخذ مرتجعُ ما بقي (أو الإلغاء) المتبقّيَ كاملاً ويقيّد
 *     للمورّد مرتجعاً مضخَّماً.
 * الحركة المستهدفة بذاتها (أو مرتجعاتها التابعة لها) تُحذف كما كانت. والحركة بلا أثر مورّد (غير مصنَّفة، تسوية) كما كانت.
 * قراءةٌ فقط؛ ولا استعلام حين لا تمسّ الخطة أسطر حركات. عميلٌ قديم لم يُولَّد بعد الترحيل (بلا paymentMode) ⇒ لا فحص.
 */
export async function assertPurgeKeepsSupplierBills(db: unknown, tenantId: string, plan: Pick<PurgePlan, 'batches'>): Promise<void> {
  if (!hasScalar('WarehouseEntry', 'paymentMode')) return;
  const keys = mergedKeys(plan as PurgePlan);
  const itemIds = (keys.get('WarehouseEntryItem') ?? []).map((k) => k.id).filter((x): x is string => typeof x === 'string');
  if (!itemIds.length) return;
  const gone = new Set((keys.get('WarehouseEntry') ?? []).map((k) => String(k.id)));
  const d = db as typeof prisma;
  const entryIds = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 1000) {
    for (const r of await d.warehouseEntryItem.findMany({ where: { id: { in: itemIds.slice(i, i + 1000) } }, select: { entryId: true } })) {
      if (!gone.has(r.entryId)) entryIds.add(r.entryId);
    }
  }
  if (!entryIds.size) return;
  const ids = [...entryIds];
  const hit = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    const classified = await d.warehouseEntry.findMany({ where: { tenantId, id: { in: part }, paymentMode: { not: null } }, select: { id: true } });
    for (const e of classified) hit.add(e.id);
    const ledger = await d.supplierLedgerEntry.findMany({ where: { tenantId, warehouseEntryId: { in: part } }, select: { warehouseEntryId: true } });
    for (const l of ledger) if (l.warehouseEntryId) hit.add(l.warehouseEntryId);
    const allocs = await d.supplierPaymentAllocation.findMany({ where: { tenantId, warehouseEntryId: { in: part } }, select: { warehouseEntryId: true } });
    for (const a of allocs) hit.add(a.warehouseEntryId);
  }
  if (!hit.size) return;
  throw new PurgeRefused(SUPPLIER_BILLS_NO_DELETE_MESSAGE, { status: 409, code: SUPPLIER_BILLS_NO_DELETE_CODE, models: ['WarehouseEntry'] });
}

/**
 * نماذج تمسّها الخطة (حذفاً أو تفريغ مفتاح) وهي مستندٌ مرحَّل المصدر أو من جداول الدفاتر — ما يُرفض للشركة المربوطة.
 * نقيّ بلا قاعدة: مرتّبٌ أبجدياً، وفارغٌ = لا يمسّ شيئاً مرحَّلاً
 */
export function linkedPurgeConflicts(plan: Pick<PurgePlan, 'counts' | 'nullCounts'>): string[] {
  const hit = new Set<string>();
  for (const m of [...Object.keys(plan.counts), ...Object.keys(plan.nullCounts)]) {
    if (LINKED_POSTED_SOURCES.has(m) || isLedgerModel(m)) hit.add(m);
  }
  return [...hit].sort();
}

/**
 * حارس «لا حذف للمرحَّل» (قرار المالك OD1): الشركة المربوطة ⇒ PurgeRefused 409 BOOKS_LINKED_NO_DELETE إن مسّت الخطة مستنداً
 * مرحَّلاً. الشركة اليدوية (وكل شركة غير مربوطة) كما كانت تماماً. وخطةٌ لا تمسّ شيئاً مرحَّلاً لا تقرأ وضع الدفاتر أصلاً.
 * مصدَّر لمعاينة الحذف (routes/ownerPurge.ts) فتُظهر الرفض قبل التنفيذ
 */
export async function assertPurgeAllowedForBooks(db: unknown, tenantId: string, plan: Pick<PurgePlan, 'counts' | 'nullCounts'>): Promise<void> {
  const hit = linkedPurgeConflicts(plan);
  if (!hit.length) return;
  if (!(await tenantBooksLinked(db as BookModeDb, tenantId))) return;
  throw new PurgeRefused(LINKED_NO_DELETE_MESSAGE, { status: 409, code: LINKED_NO_DELETE_CODE, models: hit });
}

/** أثر المستندات القائمة المحذوفة على «إجمالي المبيعات/التحصيل» لكل عميل — يُقرأ قبل الحذف */
async function totalsDelta(tx: Tx, plan: PurgePlan): Promise<Map<string, { sales: number; collected: number }>> {
  const out = new Map<string, { sales: number; collected: number }>();
  const add = (cid: string, sales: number, collected: number) => {
    const cur = out.get(cid) ?? { sales: 0, collected: 0 };
    cur.sales = clean(cur.sales + sales); cur.collected = clean(cur.collected + collected);
    out.set(cid, cur);
  };
  if (plan.invoiceIds.length) {
    const invs = await tx.invoice.findMany({ where: { id: { in: plan.invoiceIds }, status: 'CONFIRMED' }, select: { customerId: true, type: true, total: true } });
    for (const i of invs) {
      const t = Number(i.total);
      if (i.type === 'RETURN') add(i.customerId, t, 0);
      else if (i.type === 'CASH') add(i.customerId, -t, -t);
      else add(i.customerId, -t, 0);
    }
  }
  if (plan.receiptIds.length) {
    const recs = await tx.receipt.findMany({ where: { id: { in: plan.receiptIds }, status: 'ACTIVE' }, select: { customerId: true, amount: true } });
    for (const r of recs) add(r.customerId, 0, -Number(r.amount));
  }
  return out;
}

/** عملاء تمسّهم الخطة (أصحاب الفواتير والسندات وقيود الحساب المحذوفة) */
async function touchedCustomers(tx: Tx, plan: PurgePlan): Promise<Set<string>> {
  const ids = new Set<string>();
  if (plan.invoiceIds.length) for (const i of await tx.invoice.findMany({ where: { id: { in: plan.invoiceIds } }, select: { customerId: true } })) ids.add(i.customerId);
  if (plan.receiptIds.length) for (const r of await tx.receipt.findMany({ where: { id: { in: plan.receiptIds } }, select: { customerId: true } })) ids.add(r.customerId);
  const ae = plan.batches.filter((b) => b.model === 'AccountEntry').flatMap((b) => b.keys.map((k) => String(k.id)));
  if (ae.length) for (const a of await tx.accountEntry.findMany({ where: { id: { in: ae } }, select: { customerId: true } })) ids.add(a.customerId);
  return ids;
}

export interface PurgeResult { counts: Record<string, number>; nullCounts: Record<string, number> }

/** بندٌ يُحذف ← رأسه (حقل الربط ونموذج الرأس): الرأس الذي لم يُحذف هو نفسه وقد يفرغ */
const LINE_HEADERS: ReadonlyArray<[line: string, fk: string, header: string]> = [
  ['VanLoadItem', 'vanLoadId', 'VanLoad'],
  ['WarehouseEntryItem', 'entryId', 'WarehouseEntry'],
  ['RepStockRequestItem', 'requestId', 'RepStockRequest'],
];

/** رؤوس البنود المحذوفة التي لا يحذفها الحذف نفسه — مرشّحة للحذف إن فرغت بعده */
async function emptiedHeaderCandidates(tx: Tx, keysOf: Map<string, Array<Record<string, unknown>>>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const db = tx as unknown as Record<string, { findMany(a: unknown): Promise<Array<Record<string, unknown>>> }>;
  for (const [line, fk, header] of LINE_HEADERS) {
    const ids = (keysOf.get(line) ?? []).map((k) => k.id).filter(Boolean);
    if (!ids.length) continue;
    const gone = new Set((keysOf.get(header) ?? []).map((k) => String(k.id)));
    const rows = await db[delegateOf(line)].findMany({ where: { id: { in: ids } }, select: { [fk]: true } });
    const hs = [...new Set(rows.map((r) => String(r[fk])))].filter((h) => !gone.has(h));
    if (hs.length) out.set(header, hs);
  }
  return out;
}

/** مفاتيح كل نموذجٍ في الخطة مجموعةً من دفعاته */
function mergedKeys(plan: PurgePlan): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const b of plan.batches) out.set(b.model, [...(out.get(b.model) ?? []), ...b.keys]);
  return out;
}

/**
 * ترتيب الحذف على مستوى النماذج: كل نموذجٍ يُحذف قبل كل نموذجٍ يشير إليه بمفتاحٍ يُحذف به (إلزامي أو DELETE_ON_OPTIONAL) —
 * الأبناء قبل الآباء أياً كان ترتيب اكتشافهم (صفٌّ يصله أبوان يُكتشف تحت أولهما). والعلاقة الذاتية الاختيارية فُرّغت قبله.
 * ودورةٌ بين نماذج (نادرة) تُكمَل بترتيب الاكتشاف المعكوس.
 */
export function deletionOrder(plan: PurgePlan): string[] {
  const models = [...new Set(plan.batches.map((b) => b.model))];
  const inPlan = new Set(models);
  // must[P] = أبناء P في الخطة (يُحذفون قبله)
  const must = new Map<string, Set<string>>(models.map((m) => [m, new Set<string>()]));
  for (const p of models) {
    for (const r of inboundOf(p)) {
      if (r.child.name === p || !inPlan.has(r.child.name)) continue;
      if (deletesWith(r)) must.get(p)!.add(r.child.name);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  const discovery = [...models].reverse();
  while (out.length < models.length) {
    const ready = discovery.find((m) => !done.has(m) && [...must.get(m)!].every((c) => done.has(c)));
    const next = ready ?? discovery.find((m) => !done.has(m))!;
    out.push(next); done.add(next);
  }
  return out;
}

/** ينفّذ الخطة في معاملة واحدة: إعادة مبالغ تخصيص السندات القائمة، ثم التفريغ، ثم الحذف من الأبناء إلى الآباء، ثم تصحيح الأرصدة */
export async function executePurge(tenantId: string, model: string, id: string | readonly string[]): Promise<PurgeResult> {
  return prisma.$transaction((tx) => purgeInTx(tx, tenantId, model, id), { timeout: 120_000, maxWait: 15_000 });
}

/**
 * الحذف داخل معاملةٍ قائمة — يستعمله الحذف النهائي للمالك، وحذف الصنف العادي (حذفٌ حقيقي بلا أرشفة، أمر المالك ٥ نوفمبر):
 * الخطة ثم إعادة مبالغ التخصيص ثم التفريغ ثم الحذف من الأبناء إلى الآباء ثم تصحيح الأرصدة
 */
export async function purgeInTx(tx: Tx, tenantId: string, model: string, id: string | readonly string[]): Promise<PurgeResult> {
  {
    const plan = await buildPurgePlan(tx, tenantId, model, id);
    // الشركة المربوطة: لا حذف لمستندٍ مرحَّل ولا تفريغ مفتاحٍ فيه — قبل أي كتابة (قرار المالك OD1)
    await assertPurgeAllowedForBooks(tx, tenantId, plan);
    // وكل شركة: فاتورة المورّد لا تُحذف ولا تُبتر أسطرها بحذف غيرها (الصنف) — قبل أي كتابة
    await assertPurgeKeepsSupplierBills(tx, tenantId, plan);
    const deltas = await totalsDelta(tx, plan);
    const customers = await touchedCustomers(tx, plan);

    // السند القائم المحذوف: مبالغ تخصيصه لفواتير **باقية** تعود إليها (المحذوفة لا يعنيها)
    if (plan.receiptIds.length) {
      const goneInv = new Set(plan.invoiceIds);
      const allocs = await tx.receiptInvoice.findMany({
        where: { receiptId: { in: plan.receiptIds }, receipt: { status: 'ACTIVE' } },
        select: { invoiceId: true, amount: true },
      });
      await restoreAllocations(tx as never, tenantId, allocs.filter((a) => !goneInv.has(a.invoiceId)));
    }

    const keysOf = mergedKeys(plan);
    // الصنف المحذوف (من أي مسار: حذف الصنف العادي، أو حذف المالك النهائي أو الجماعي): اسمه ووحدته في بنود فواتيره الباقية قبل
    // فكّ ربطها — فتُعرض باسمه (services/deletedProduct.ts) ولا تنكسر شاشةٌ تقرأ product.name. المعامل يبقى فلا تتغيّر كمية
    const goneProducts = (keysOf.get('Product') ?? []).map((k) => String(k.id));
    if (goneProducts.length) {
      for (const p of await tx.product.findMany({ where: { id: { in: goneProducts } }, select: { id: true, name: true, unit: true } })) {
        await tx.invoiceItem.updateMany({ where: { productId: p.id, itemName: null }, data: { itemName: p.name } });
        if (p.unit) await tx.invoiceItem.updateMany({ where: { productId: p.id, unitName: null }, data: { unitName: p.unit } });
      }
    }
    // رؤوس الحركات التي قد تفرغ من بنودها بحذف بنودها (تحميل سيارة، وارد مستودع، طلب بضاعة) — تُحذف بعدها إن فرغت
    const headersOf = await emptiedHeaderCandidates(tx, keysOf);

    const d = tx as unknown as Record<string, { updateMany(a: unknown): Promise<unknown>; deleteMany(a: unknown): Promise<{ count: number }> }>;
    for (const n of plan.nullify) {
      await d[delegateOf(n.model)].updateMany({ where: { [n.fk]: { in: n.values } }, data: { [n.fk]: null } });
    }
    for (const m of deletionOrder(plan)) {
      const rows = keysOf.get(m) ?? [];
      const keys = Object.keys(rows[0] ?? {});
      if (keys.length === 1) {
        const k = keys[0];
        for (let i = 0; i < rows.length; i += 1000) {
          await d[delegateOf(m)].deleteMany({ where: { [k]: { in: rows.slice(i, i + 1000).map((x) => x[k]) } } });
        }
      } else {
        for (const key of rows) await d[delegateOf(m)].deleteMany({ where: key });
      }
    }

    // رأس حركةٍ لم يبقَ له بند: مستندٌ فارغ لا يقبله النظام إنشاءً — يُحذف هو أيضاً (بالمحرّك نفسه)
    for (const [header, ids] of headersOf) {
      if (!ids.length) continue;
      const empty = await (tx as unknown as Record<string, { findMany(a: unknown): Promise<Array<{ id: string }>> }>)[delegateOf(header)]
        .findMany({ where: { id: { in: ids }, tenantId, items: { none: {} } }, select: { id: true } });
      if (empty.length) {
        const sub = await purgeInTx(tx, tenantId, header, empty.map((e) => e.id));
        for (const [m, n] of Object.entries(sub.counts)) plan.counts[m] = (plan.counts[m] ?? 0) + n;
      }
    }

    // الأرصدة المخزَّنة للعملاء الباقين
    for (const cid of customers) {
      const exists = await tx.customer.findUnique({ where: { id: cid }, select: { id: true } });
      if (!exists) continue;
      const dl = deltas.get(cid) ?? { sales: 0, collected: 0 };
      await tx.customer.update({
        where: { id: cid },
        data: {
          balance: await currentBalance(tx as never, cid),
          ...(dl.sales && { totalSales: { increment: dl.sales } }),
          ...(dl.collected && { totalCollected: { increment: dl.collected } }),
        },
      });
    }
    return { counts: plan.counts, nullCounts: plan.nullCounts };
  }
}
