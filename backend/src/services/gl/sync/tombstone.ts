/**
 * خطافات الحذف (tombstones) وحارس حذف المندوب (M3، DESIGN.md §5.3).
 *
 * المكان الوحيد الذي يُكتب فيه داخل مسارات قائمة (salesReps.ts وimport.ts)، وكلها عمليات ويب للأدمن.
 * - الكتابة مشروطة بـGlSettings.activatedAt ≠ null **بغض النظر عن العَلَم** (لا فجوة أثناء الإطفاء)، وحين يكون
 *   فارغاً (كل الشركات اليوم) لا يُكتب شيء ولا يتغير أي سلوك: قراءة واحدة لـgl_settings فقط.
 * - الـtombstone يكتب الحدثين PENDING بلقطة كاملة (الصف يُحذف)، و**لا يضبط SKIPPED أبداً**: المُرحِّل وحده
 *   يقرر تحت قفل gl-post (§5.4).
 * - المسارات تستدعي glSourceEvent.createMany صراحةً بالصفوف التي تعيدها الدوال هنا، داخل معاملة الحذف نفسها
 *   (الحارس الثابت gl-hooks-static يتحقق من الموضع).
 * - assertRepDeletable: حارس لا أحداث — لا تُكتب أحداث عكس للاستلامات عند حذف المندوب.
 */
import { LedgerError } from '../types';
import {
  arEntryPayload, settlementPayload, sourceEventCreateRow,
  type AccountEntrySourceRow, type RepSettlementSourceRow, type SourceEventCreateRow,
} from './desired';
import { arEntryKey, settlementKey } from './keys';
import type { DesiredEvent } from './types';

// ═══ قراءة التفعيل ═══

/** أدنى شكل للعميل (PrismaClient وPrisma.TransactionClient والمزيّف) */
export interface TombstoneSettingsDb {
  glSettings: {
    findUnique(args: { where: { tenantId: string }; select: { activatedAt: true; currencyDecimals: true } }):
      Promise<{ activatedAt: Date | null; currencyDecimals: number } | null>;
  };
}

export interface TombstoneSettings {
  activatedAt: Date;
  currencyDecimals: number;
}

/** null ⇒ الميزة لم تُفعَّل يوماً لهذه الشركة: لا شيء يُكتب */
export async function ledgerTombstoneSettings(db: TombstoneSettingsDb, tenantId: string): Promise<TombstoneSettings | null> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true, currencyDecimals: true } });
  if (!s || !s.activatedAt) return null;
  return { activatedAt: s.activatedAt, currencyDecimals: s.currencyDecimals };
}

// ═══ AR_ENTRY (تراجع الاستيراد) ═══

/** صف account_entries المحذوف كما يُقرأ قبل الحذف، ومعه لقطة اسم العميل (الالتزام 7) */
export type ArEntryTombstoneRow = Pick<AccountEntrySourceRow, 'id' | 'customerId' | 'debit' | 'credit' | 'description' | 'entryDate' | 'createdAt'> & {
  customer?: { name: string | null } | null;
  customerName?: string | null;
};

export interface TombstoneOptions {
  /** لحظة الحذف = effectAt لحدث REVERSE (الافتراضي الآن) */
  deletedAt?: Date;
  batchId?: string | null;
}

/** صرفة: AR_ENTRY:<id>:POST وAR_ENTRY:<id>:REVERSE لكل صف، PENDING بالحمولة نفسها */
export function arEntryTombstoneEvents(rows: readonly ArEntryTombstoneRow[], decimals: number, opts: TombstoneOptions = {}): DesiredEvent[] {
  const deletedAt = opts.deletedAt ?? new Date();
  const out: DesiredEvent[] = [];
  for (const row of rows) {
    const name = row.customerName ?? row.customer?.name ?? null;
    const payload = arEntryPayload(row, name, decimals, { batchId: opts.batchId ?? null });
    out.push(
      { sourceKey: arEntryKey(row.id, 'POST'), sourceType: 'AR_ENTRY', sourceId: row.id, event: 'POST', effectAt: row.entryDate, payload, status: 'PENDING' },
      { sourceKey: arEntryKey(row.id, 'REVERSE'), sourceType: 'AR_ENTRY', sourceId: row.id, event: 'REVERSE', effectAt: deletedAt, payload, status: 'PENDING' },
    );
  }
  return out;
}

/** صفوف createMany جاهزة (بعد قراءة الإعدادات خارج المصفوفة، لمسار تراجع العميل) */
export function arEntryTombstoneRows(
  tenantId: string, rows: readonly ArEntryTombstoneRow[], settings: TombstoneSettings, opts: TombstoneOptions = {},
): SourceEventCreateRow[] {
  return arEntryTombstoneEvents(rows, settings.currencyDecimals, opts).map((e) => sourceEventCreateRow(tenantId, e));
}

export interface LedgerTombstonesDb extends TombstoneSettingsDb {
  customer: {
    findMany(args: { where: { tenantId: string; id: { in: string[] } }; select: { id: true; name: true } }): Promise<{ id: string; name: string }[]>;
  };
}

/**
 * المساعد المشترك (§5.3): يقرأ activatedAt أولاً ويعيد [] إن لم تُفعَّل الميزة يوماً (فلا قراءة أخرى)، وإلا
 * يحمّل لقطة أسماء العملاء (الالتزام 7) ويعيد صفوف glSourceEvent.createMany({data, skipDuplicates: true})
 * التي يكتبها المسار داخل معاملة الحذف قبل accountEntry.deleteMany.
 */
export async function ledgerTombstones(
  tx: LedgerTombstonesDb, tenantId: string, rows: readonly ArEntryTombstoneRow[], opts: TombstoneOptions = {},
): Promise<SourceEventCreateRow[]> {
  const s = await ledgerTombstoneSettings(tx, tenantId);
  if (!s || rows.length === 0) return [];
  const missing = [...new Set(rows.filter((r) => !r.customerName && !r.customer?.name).map((r) => r.customerId))];
  const names = new Map<string, string>();
  if (missing.length > 0) {
    for (const c of await tx.customer.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, name: true } })) names.set(c.id, c.name);
  }
  const named = rows.map((r) => (r.customerName || r.customer?.name ? r : { ...r, customerName: names.get(r.customerId) ?? null }));
  return arEntryTombstoneRows(tenantId, named, s, opts);
}

// ═══ SETTLEMENT (حذف استلام واحد) ═══

export type SettlementTombstoneRow = Pick<RepSettlementSourceRow, 'id' | 'salesRepId' | 'amount' | 'method' | 'note' | 'settledAt' | 'createdAt'>;

/** صرفة: SETTLEMENT:<id>:POST (effectAt=settledAt) وSETTLEMENT:<id>:REVERSE (effectAt=لحظة الحذف) معاً، PENDING */
export function settlementTombstoneEvents(
  row: SettlementTombstoneRow, decimals: number, opts: TombstoneOptions & { salesRepName?: string | null } = {},
): DesiredEvent[] {
  const deletedAt = opts.deletedAt ?? new Date();
  const payload = settlementPayload({ ...row, note: row.note ?? null }, opts.salesRepName ?? null, decimals);
  return [
    { sourceKey: settlementKey(row.id, 'POST'), sourceType: 'SETTLEMENT', sourceId: row.id, event: 'POST', effectAt: row.settledAt, payload, status: 'PENDING' },
    { sourceKey: settlementKey(row.id, 'REVERSE'), sourceType: 'SETTLEMENT', sourceId: row.id, event: 'REVERSE', effectAt: deletedAt, payload, status: 'PENDING' },
  ];
}

export async function settlementTombstones(
  tx: TombstoneSettingsDb, tenantId: string, row: SettlementTombstoneRow, opts: TombstoneOptions & { salesRepName?: string | null } = {},
): Promise<SourceEventCreateRow[]> {
  const s = await ledgerTombstoneSettings(tx, tenantId);
  if (!s) return [];
  return settlementTombstoneEvents(row, s.currencyDecimals, opts).map((e) => sourceEventCreateRow(tenantId, e));
}

// ═══ حارس حذف المندوب (LEDGER_HISTORY_LOCKED) ═══

export const REP_HISTORY_LOCKED_MESSAGE = 'للمندوب حركات في الدفاتر — عطّل المندوب بدل حذفه (التعطيل يحفظ عهدته وتاريخه)';

type CountArgs = { where: { tenantId: string; salesRepId: string } };
type Counter = { count(args: CountArgs): Promise<number> };

/** أدنى شكل للمعاملة (Prisma.TransactionClient يستوفيه) */
export interface RepDeletableDb {
  glSettings: { findUnique(args: { where: { tenantId: string }; select: { activatedAt: true } }): Promise<{ activatedAt: Date | null } | null> };
  repSettlement: Counter;
  invoice: Counter;
  receipt: Counter;
  vanLoad: Counter;
  glMoveLine: Counter;
  /**
   * قفل صف المندوب FOR UPDATE قبل العدّ (Prisma.TransactionClient يستوفيه). إدراج سند أو فاتورة يشير إلى المندوب يأخذ
   * FOR KEY SHARE على صفه فيتعارض معه: إدراج جارٍ يُنتظر التزامه ثم يُعدّ، وإدراج لاحق ينتظر نهاية الحذف فيفشل مفتاحه.
   * اختياري للمخازن المزيّفة.
   */
  $queryRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

export interface RepFootprint {
  settlements: number;
  invoices: number;
  receipts: number;
  vanLoads: number;
  moveLines: number;
}

export function hasFinancialFootprint(f: RepFootprint): boolean {
  return f.settlements > 0 || f.invoices > 0 || f.receipts > 0 || f.vanLoads > 0 || f.moveLines > 0;
}

/**
 * أول ما في معاملة حذف المندوب (§5.3). يقرأ activatedAt أولاً ويخرج مبكراً إن كان فارغاً (السلوك كما اليوم)،
 * وأياً كانت طريقة الجرد (inventoryMode) وحالة العَلَم. للمندوب أثر مالي ⇒ LedgerError('LEDGER_HISTORY_LOCKED') ⇒ 409.
 * لا يكتب أي حدث.
 *
 * موضعه في salesReps.ts (router.delete('/:id')): معاملة تفاعلية بالترتيب القائم نفسه — تفريغ مرجع المندوب من
 * الفواتير/السندات/التقارير اليومية (حفظ السجلّ)، ثم حذف بياناته التشغيلية (إشعارات/تحميلات/مواقع/زيارات/تسويات)
 * وأخيراً المندوب — وهذا الحارس أولها: حين لم تُفعَّل الدفاتر (activatedAt فارغ) يبقى الحذف كما كان، وإلا يرفض
 * حذف مندوب له أثر مالي قبل أي استدعاء هدّام. يقفل صف المندوب FOR UPDATE قبل العدّ، فيُحجب أي إدراج متزامن يشير
 * إلى المندوب (سند/فاتورة مرفوعة) حتى نهاية المعاملة، فلا يتسلل بين الفحص والحذف. لا تُكتب أحداث دفاتر في المسار.
 */
export async function assertRepDeletable(db: RepDeletableDb, tenantId: string, salesRepId: string): Promise<void> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true } });
  if (!s || !s.activatedAt) return;
  // قفل صف المندوب قبل أي عدّ: العدّ وحده بـREAD COMMITTED لا يمنع سنداً يلتزم بين الفحص والحذف (onDelete: SetNull
  // كان سيفرّغ مندوبه بصمت ويُخرج عهدته من P7/C4). الفحص الفعلي للتزامن خطوة يدوية على قاعدة حقيقية.
  if (db.$queryRaw) await db.$queryRaw`SELECT id FROM sales_reps WHERE id = ${salesRepId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const where = { tenantId, salesRepId };
  const footprint: RepFootprint = {
    settlements: await db.repSettlement.count({ where }),
    invoices: await db.invoice.count({ where }),
    receipts: await db.receipt.count({ where }),
    vanLoads: await db.vanLoad.count({ where }),
    moveLines: await db.glMoveLine.count({ where }),
  };
  if (hasFinancialFootprint(footprint)) {
    throw new LedgerError('LEDGER_HISTORY_LOCKED', { salesRepId, footprint: { ...footprint } }, REP_HISTORY_LOCKED_MESSAGE);
  }
}
