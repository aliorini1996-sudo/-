import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { arEntryTombstoneRows, ledgerTombstones, ledgerTombstoneSettings } from '../services/gl/sync/tombstone';
import { acquirePostLock } from '../services/gl/post';
import { currentBalance, clean } from '../services/accounting';
import { authenticate, requireAdmin, requireAccounting, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { customerScope } from '../services/customerScope';
import { currencyDecimalsOf } from '../config/countries';
import {
  ADJUSTMENT_TYPES, BALANCE_SKIP_MESSAGES, FK_BLOCK_REASON, IMPORT_BATCH_DONE, ImportHttpError, assertImportLedgerStateUnchanged, IMPORT_BATCH_RUNNING, IMPORT_ENTRY_KINDS, LEDGER_BUSY_MESSAGE,
  OPENING_BALANCE_DESCRIPTION, YMD_RE,
  assertBatchRevertible, assertNoRunningImport, assertNotDuplicateBatch, assertOverlapConfirmed, balanceSkipReason, categoryDeletable,
  customerBlockReason, detectLedgerOverlap, importBatchState, importContentHash, importErrorBody, importFlushDue, importTimezone,
  importedEntryIndex, isFkBlockError, isImportHttpError, isLockBusyError, parseBatchRecordIds, productBlockReason, resolveImportDates,
  revertOutcome, revertResponse, roundImportAmount, serializeBatchRecordIds, type RevertBlocked,
  OPENING_STOCK_ENTRY_TYPE, OPENING_STOCK_KIND, OPENING_STOCK_NOTE, assertOpeningStockAllowed, assertOpeningStockRevertAllowed,
  openingStockContentHash, openingStockProductFinder, openingStockRevertBlockReason, resolveOpeningStockRows,
  assertMasterBatchReservable, customerMatchError, groupLedgerRows, importRowError, importWriteFailure, mergeBalanceRows, normImportName,
  priceRowIssue, pricesRevertPlan, taxPctIssue, type BalanceSkipReason, type ImportMasterKind, type ImportRowError, type ResolvedBalanceRow,
} from '../services/importLedger';
import { entryTotalCost } from '../services/warehouseCost';
import {
  ACCOUNTING_NOT_ALLOWED_MESSAGE, importAccessBody, importAccessDecision, importKindsAllowed, isImportAccountingKind, loadImportActor, requireImportAccess,
} from '../services/importAccess';
import { buildCustomerMatcher, customerImportPlanner, type CustomerImportDecision, type CustomerSkipReason } from '../services/importMatch';
import {
  importChunkTarget, mergeImportDeltas, planImportChunks, runImportChunks, type ImportProgressDelta, type ImportProgressState,
} from '../services/importChunks';

// ============================================================================
// استيراد بيانات الشركات من أنظمتها السابقة (Excel → صفوف JSON من الواجهة).
// كل استيراد معزول لشركة المستخدم (tenantId)، عبر منطق النظام (لا مساس مباشر بـ DB).
// الصلاحيات (البندان 5 و21): requireImportAccess(kind) لكل مسار كتابة — المقيّد النطاق ممنوع، وصلاحية النوع، ثم requireAccounting.
// ============================================================================

const router = Router();
router.use(authenticate, requireAdmin);

const CHANNELS = ['MT', 'WHOLESALE', 'TT', 'DISCOUNTER', 'CASH_VAN', 'ECOMMERCE'];

type ImportResult = {
  created: number; skipped: number; total: number; errors: ImportRowError[]; batchId?: string | null;
  /** العملاء: أكواد رُبطت بعملاء قائمين بكود تلقائي (تعديل لا إنشاء) */
  attached?: number;
};

/** مهلة معاملات كتابة الشرائح (البند 6) */
const IMPORT_WRITE_TX = { maxWait: 10_000, timeout: 60_000 };

const importedBy = (req: AuthRequest): string | null => (req.user as { name?: string } | undefined)?.name || null;

/** رد أخطاء الاستيراد ذات الرمز، وإلا errorHandler العام */
function sendImportError(err: unknown, res: Response, next: NextFunction): void {
  if (isImportHttpError(err)) { res.status(err.status).json(importErrorBody(err)); return; }
  next(err);
}

/** حالة الدفاتر وتوقيت الشركة ومنازل العملة (منازل الدفاتر إن وُجدت، وإلا عملة الشركة) */
async function importLedgerContext(tid: string): Promise<{ activated: boolean; timezone: string; decimals: number }> {
  const s = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true, currencyDecimals: true } });
  let decimals = s?.currencyDecimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 3) {
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currency: true } });
    decimals = currencyDecimalsOf(company?.currency);
  }
  return { activated: !!s?.activatedAt, timezone: importTimezone(s), decimals };
}

const IMPORT_ENTRIES_LOCK_PREFIX = 'import-entries:';
/** البند 20: قفل حجز دفعات العملاء/المنتجات/الأسعار لكل نوع وشركة */
const IMPORT_MASTER_LOCK_PREFIX = 'import-master:';

/**
 * مراجعة 3 و7: يحجز دفعة «جارية» قبل أي كتابة، تحت قفل استشاري للمعاملة لكل شركة — البصمة (ومنها دفعة جارية لم تنتهِ:
 * تحديث الصفحة أو انقطاع الشبكة ثم إعادة الرفع ⇒ 409 IMPORT_DUPLICATE_BATCH)، ثم استيراد أرصدة/كشوف جارٍ (حتى مع force ⇒
 * 409 IMPORT_IN_PROGRESS)، ثم الإنشاء. فلا يعمل استيرادان للقيود معاً، وفهرس المستورد في الطلب لا يتقادم.
 */
async function reserveEntryBatch(
  tid: string, kind: 'balances' | 'ledger', contentHash: string, by: string | null, force: boolean, expectActivated: boolean,
): Promise<string> {
  try {
    return await prisma.$transaction(async tx => {
      // اعتماد الدفاتر يمسك القفل نفسه حتى 60 ثانية: الانتظار محدود ⇒ 409 IMPORT_LEDGER_BUSY لا 500
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${IMPORT_ENTRIES_LOCK_PREFIX + tid}::text))`;
      // التواريخ حُسبت بحالة الدفاتر قبل القفل: فُعّلت بينهما ⇒ 409 IMPORT_LEDGER_STATE_CHANGED قبل أي حجز
      const gs = await tx.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true } });
      assertImportLedgerStateUnchanged(gs?.activatedAt, expectActivated);
      const now = new Date();
      const dup = await tx.importBatch.findFirst({
        where: { tenantId: tid, kind, reverted: false, contentHash }, orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, status: true, heartbeatAt: true },
      });
      assertNotDuplicateBatch(dup, force, now);
      const running = await tx.importBatch.findMany({
        where: { tenantId: tid, reverted: false, kind: { in: [...IMPORT_ENTRY_KINDS] }, status: IMPORT_BATCH_RUNNING },
        select: { id: true, kind: true, createdAt: true, status: true, heartbeatAt: true },
      });
      assertNoRunningImport(running.find(b => importBatchState(b, now) === 'running'));
      const b = await tx.importBatch.create({
        data: {
          tenantId: tid, kind, count: 0, recordIds: serializeBatchRecordIds(kind, []), createdBy: by, contentHash,
          status: IMPORT_BATCH_RUNNING, heartbeatAt: now,
        },
      });
      return b.id;
    }, { maxWait: 10_000, timeout: 15_000 });
  } catch (e) {
    if (!isImportHttpError(e) && isLockBusyError(e)) throw new ImportHttpError(409, 'IMPORT_LEDGER_BUSY', LEDGER_BUSY_MESSAGE);
    throw e;
  }
}

/**
 * البند 20: حجز دفعة عملاء/منتجات/أسعار «جارية» قبل أي كتابة، تحت قفل النوع للشركة: البصمة (ما لم يُرسل force) ثم دفعة جارية
 * من النوع نفسه (حتى مع force) ⇒ 409، ثم الإنشاء. انقطاع الخادم بعدها يترك دفعة منقطعة قابلة للتراجع بما سُجّل فيها.
 */
async function reserveMasterBatch(tid: string, kind: ImportMasterKind, contentHash: string, by: string | null, force: boolean): Promise<string> {
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${IMPORT_MASTER_LOCK_PREFIX + kind + ':' + tid}::text))`;
      const now = new Date();
      const dup = await tx.importBatch.findFirst({
        where: { tenantId: tid, kind, reverted: false, contentHash }, orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, status: true, heartbeatAt: true },
      });
      const running = await tx.importBatch.findMany({
        where: { tenantId: tid, reverted: false, kind, status: IMPORT_BATCH_RUNNING },
        select: { id: true, kind: true, createdAt: true, status: true, heartbeatAt: true },
      });
      assertMasterBatchReservable(kind, dup, running, force, now);
      const b = await tx.importBatch.create({
        data: {
          tenantId: tid, kind, count: 0, recordIds: serializeBatchRecordIds(kind, []), createdBy: by, contentHash,
          status: IMPORT_BATCH_RUNNING, heartbeatAt: now,
        },
      });
      return b.id;
    }, { maxWait: 10_000, timeout: 15_000 });
  } catch (e) {
    if (!isImportHttpError(e) && isLockBusyError(e)) throw new ImportHttpError(409, 'IMPORT_LEDGER_BUSY', LEDGER_BUSY_MESSAGE);
    throw e;
  }
}

/**
 * تقدّم الدفعة الجارية (البند 6): المعرّفات (والفئات والأسعار السابقة) تُكتب في آخر كل معاملة شريحة دون شرط، فما التُزم مسجَّل
 * في دفعته تماماً. النبض خارج المعاملات. النهاية: done، أو حذف الدفعة إن لم يُكتب شيء (batchId=null).
 */
class ImportBatchProgress {
  private state: ImportProgressState = { records: [], categories: [], previous: {} };
  private lastWriteAt = Date.now();
  constructor(readonly id: string, readonly kind: string) {}

  private data(s: ImportProgressState) {
    return { count: s.records.length, recordIds: serializeBatchRecordIds(this.kind, s.records, s.categories, s.previous), heartbeatAt: new Date() };
  }

  /** داخل معاملة الكتابة: الملتزم سابقاً + دلتا هذه المعاملة */
  async write(tx: Prisma.TransactionClient, deltas: readonly ImportProgressDelta[]): Promise<void> {
    await tx.importBatch.update({ where: { id: this.id }, data: this.data(mergeImportDeltas(this.state, deltas)) });
  }

  /** بعد التزام المعاملة */
  commit(deltas: readonly ImportProgressDelta[]): void {
    this.state = mergeImportDeltas(this.state, deltas);
    this.lastWriteAt = Date.now();
  }

  /** نبض خارج المعاملات — لا يُفشل الاستيراد */
  async beat(): Promise<void> {
    if (!importFlushDue({ pending: 0, lastFlushAt: this.lastWriteAt, now: Date.now() })) return;
    try {
      await prisma.importBatch.update({ where: { id: this.id }, data: { heartbeatAt: new Date() } });
      this.lastWriteAt = Date.now();
    } catch { /* النبض التالي */ }
  }

  async finish(): Promise<string | null> {
    if (!this.state.records.length && !this.state.categories.length) {
      await prisma.importBatch.deleteMany({ where: { id: this.id } });
      return null;
    }
    await prisma.importBatch.update({ where: { id: this.id }, data: { ...this.data(this.state), status: IMPORT_BATCH_DONE } });
    return this.id;
  }
}

/** معرّفات قيود دفعات balances/ledger غير المتراجَع عنها */
async function loadImportedIndex(tid: string) {
  const batches = await prisma.importBatch.findMany({
    where: { tenantId: tid, reverted: false, kind: { in: [...IMPORT_ENTRY_KINDS] } },
    select: { kind: true, recordIds: true },
  });
  return importedEntryIndex(batches);
}

async function duplicateBatch(tid: string, kind: string, contentHash: string) {
  return prisma.importBatch.findFirst({
    where: { tenantId: tid, kind, reverted: false, contentHash }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, status: true, heartbeatAt: true },
  });
}

/**
 * مطابق العملاء (البندان 3 و4): الكود وحده إن أُعطي، وإلا الجوال المطبَّع ثم الاسم الفريد؛ الغموض خطأ صف لا عميل عشوائي.
 * مُقيَّد بنطاق المستخدم (المقيّد ممنوع من الاستيراد أصلاً، والقيد لا يضر).
 */
async function customerMatcher(req: AuthRequest, tid: string) {
  const custs = await prisma.customer.findMany({
    where: { tenantId: tid, ...(await customerScope(req, tid)) },
    select: { id: true, code: true, phone: true, name: true },
  });
  return buildCustomerMatcher(custs);
}

/** تاريخ الصف: YYYY-MM-DD فقط (الفارغ = بلا تاريخ) */
const importDate = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().regex(YMD_RE, 'التاريخ بصيغة YYYY-MM-DD').optional());
const undatedDateField = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().regex(YMD_RE, 'التاريخ بصيغة YYYY-MM-DD').optional());

// ===== استيراد العملاء =====
const customerRow = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional().default(''),
  email: z.string().trim().optional(),
  code: z.string().trim().optional(),            // كود العميل في النظام السابق (لربط الأرصدة لاحقاً)
  businessName: z.string().trim().optional(),
  commercialReg: z.string().trim().optional(),
  taxNumber: z.string().trim().optional(),
  city: z.string().trim().optional(),
  district: z.string().trim().optional(),
  address: z.string().trim().optional(),
  channel: z.string().trim().optional(),
  creditLimit: z.number().nonnegative().optional(),
  paymentDays: z.number().int().nonnegative().optional(),
});
const customersBody = z.object({
  rows: z.array(customerRow).max(5000),
  force: z.boolean().optional(),
});

router.post('/customers', requireImportAccess('customers'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = customersBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    const skippedRows: { row: number; reason: CustomerSkipReason }[] = [];
    const similar: { row: number; code: string; matchedBy: 'phone' | 'name' }[] = [];
    const attachedRows: { row: number; code: string; matchedBy: 'phone' | 'name' }[] = [];
    // البند 20: الدفعة محجوزة قبل أي كتابة (البصمة والاستيراد الجاري تحت قفل النوع)
    const progress = new ImportBatchProgress(
      await reserveMasterBatch(tid, 'customers', importContentHash('customers', rows), importedBy(req), body.force === true), 'customers');
    try {
      // البند 3: الكود وحده للصف ذي الكود (فروع السلاسل تُنشأ مع تنبيه)، والجوال الصالح ثم الاسم للصف بلا كود
      const existing = await prisma.customer.findMany({ where: { tenantId: tid }, select: { id: true, phone: true, code: true, name: true } });
      const planner = customerImportPlanner(existing);
      const creates: { row: number; phone: string; r: z.infer<typeof customerRow> }[] = [];
      const attaches: Extract<CustomerImportDecision, { action: 'attach' }>[] = [];
      rows.forEach((r, i) => {
        const d = planner.decide(r, i);
        if (d.action === 'skip') {
          result.skipped++;
          if (skippedRows.length < 500) skippedRows.push({ row: d.row, reason: d.reason });
          return;
        }
        if (d.action === 'attach') { planner.commitAttach(d); attaches.push(d); return; }
        planner.commit(r);
        if (d.similar && r.code && similar.length < 500) similar.push({ row: d.row, code: r.code, matchedBy: d.similar });
        creates.push({ row: d.row, phone: d.phone, r });
      });
      await runImportChunks({
        chunks: planImportChunks(creates, () => 1, importChunkTarget(creates.length)),
        runTx: <X>(fn: (tx: Prisma.TransactionClient) => Promise<X>) => prisma.$transaction(async tx => fn(tx), IMPORT_WRITE_TX),
        writeItem: async (tx: Prisma.TransactionClient, { r, phone }) => {
          const c = await tx.customer.create({
            data: {
              tenantId: tid,
              name: r.name,
              phone,
              email: r.email || null,
              businessName: r.businessName || null,
              commercialReg: r.commercialReg || null,
              taxNumber: r.taxNumber || null,
              city: r.city || null,
              district: r.district || null,
              address: r.address || null,
              channel: r.channel && CHANNELS.includes(r.channel) ? r.channel : null,
              creditLimit: r.creditLimit ?? 0,
              paymentDays: r.paymentDays ?? 30,
              ...(r.code ? { code: r.code } : {}),
            } as never,
            select: { id: true },
          });
          return c.id;
        },
        // المعرّفات في آخر معاملة الشريحة نفسها (البند 6)
        flush: (tx, written) => progress.write(tx, written.map(w => ({ records: [w.result] }))),
        onCommitted: written => {
          progress.commit(written.map(w => ({ records: [w.result] })));
          result.created += written.length;
        },
        onItemError: (c, e) => { result.errors.push(importWriteFailure(c.row, e)); },
        isFatal: isImportHttpError,
        afterChunk: () => progress.beat(),
      });
      // الكود الجديد لعميل قائم بكود تلقائي (مستورد سابقاً بلا كود): يُكتب فيه بشرط أن كوده لم يتغير، فتطابقه ملفات
      // الأرصدة والكشوف والأسعار. تعديل عميل قائم لا إنشاء: لا يدخل سجلات الدفعة (التراجع لا يحذف العميل ولا يعيد كوده)
      for (let k = 0; k < attaches.length; k++) {
        const a = attaches[k];
        try {
          const upd = await prisma.customer.updateMany({
            where: { id: a.customerId, tenantId: tid, ...(a.fromCode !== null ? { code: a.fromCode } : {}) },
            data: { code: a.code },
          });
          if (upd.count === 1) {
            if (attachedRows.length < 500) attachedRows.push({ row: a.row, code: a.code, matchedBy: a.matchedBy });
            result.attached = (result.attached ?? 0) + 1;
          } else {
            result.skipped++;
            if (skippedRows.length < 500) skippedRows.push({ row: a.row, reason: 'CODE_ATTACHABLE' });
          }
        } catch (e) {
          if (isImportHttpError(e)) throw e;
          result.errors.push(importWriteFailure(a.row, e));
        }
        if (k % 200 === 199) await progress.beat();
      }
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: { ...result, skippedRows, attachedRows, warnings: { similar } } });
  } catch (err) { sendImportError(err, res, next); }
});

// ===== استيراد المنتجات =====
const productRow = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unit: z.string().trim().optional().default('حبة'),
  basePrice: z.number().nonnegative().optional().default(0),
  taxPct: z.number().min(0).max(100).optional(),
  barcode: z.string().trim().optional(),
  category: z.string().trim().optional(),         // اسم الفئة — تُنشأ إن لزم
});
const productsBody = z.object({
  rows: z.array(productRow).max(5000),
  force: z.boolean().optional(),
});

router.post('/products', requireImportAccess('products'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = productsBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };

    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
    const defaultVat = company?.defaultVatPct ?? 15;

    // البند 20: الدفعة محجوزة قبل أي كتابة (والفئات تُطابَق تحت قفل النوع فلا تتكرر)
    const progress = new ImportBatchProgress(
      await reserveMasterBatch(tid, 'products', importContentHash('products', rows), importedBy(req), body.force === true), 'products');
    try {
      const existing = await prisma.product.findMany({ where: { tenantId: tid }, select: { code: true } });
      const codes = new Set(existing.map(e => e.code));

      // خريطة الفئات بالاسم المطبَّع (مؤسسة/مؤسسه، المسافات)
      const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
      const catByName = new Map<string, string>();
      for (const c of cats) { const key = normImportName(c.name); if (key && !catByName.has(key)) catByName.set(key, c.id); }
      // فئات أُنشئت داخل معاملة لم تلتزم بعد (تُلغى معها إن فشلت)
      const txCategories = new WeakMap<object, Map<string, string>>();

      const creates: { row: number; r: z.infer<typeof productRow> }[] = [];
      rows.forEach((r, i) => {
        if (codes.has(r.code)) { result.skipped++; return; }
        // البند 14: خلية ضريبة منسّقة ٪ في Excel ⇒ 0.15
        const taxIssue = taxPctIssue(r.taxPct);
        if (taxIssue) { result.errors.push(importRowError(i + 2, taxIssue)); return; }
        codes.add(r.code);
        creates.push({ row: i + 2, r });
      });
      await runImportChunks({
        chunks: planImportChunks(creates, () => 1, importChunkTarget(creates.length)),
        runTx: <X>(fn: (tx: Prisma.TransactionClient) => Promise<X>) => prisma.$transaction(async tx => fn(tx), IMPORT_WRITE_TX),
        writeItem: async (tx: Prisma.TransactionClient, { r }) => {
          let categoryId: string | null = null;
          let newCategory: { key: string; id: string } | null = null;
          const catName = r.category?.trim();
          if (catName) {
            const key = normImportName(catName);
            categoryId = catByName.get(key) ?? txCategories.get(tx)?.get(key) ?? null;
            if (!categoryId) {
              const nc = await tx.productCategory.create({ data: { tenantId: tid, name: catName }, select: { id: true } });
              categoryId = nc.id;
              newCategory = { key, id: nc.id };
              const local = txCategories.get(tx) ?? new Map<string, string>();
              local.set(key, nc.id);
              txCategories.set(tx, local);
            }
          }
          const p = await tx.product.create({
            data: {
              tenantId: tid, code: r.code, name: r.name, unit: r.unit || 'حبة',
              basePrice: r.basePrice ?? 0, taxPct: r.taxPct ?? defaultVat,
              barcode: r.barcode || null, categoryId,
            } as never,
            select: { id: true },
          });
          return { id: p.id, newCategory };
        },
        flush: (tx, written) => progress.write(tx, written.map(w => productDelta(w.result))),
        onCommitted: written => {
          progress.commit(written.map(w => productDelta(w.result)));
          for (const w of written) if (w.result.newCategory) catByName.set(w.result.newCategory.key, w.result.newCategory.id);
          result.created += written.length;
        },
        onItemError: (c, e) => { result.errors.push(importWriteFailure(c.row, e)); },
        isFatal: isImportHttpError,
        afterChunk: () => progress.beat(),
      });
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: result });
  } catch (err) { sendImportError(err, res, next); }
});

function productDelta(w: { id: string; newCategory: { id: string } | null }): ImportProgressDelta {
  return { records: [w.id], categories: w.newCategory ? [w.newCategory.id] : [] };
}

// ===== استيراد الأرصدة الافتتاحية =====
// التاريخ YYYY-MM-DD بتوقيت الشركة (البند 1)، وundatedDate للصفوف بلا تاريخ (البند 2)، والبصمة والتخطي بسبب (البند 5).
// صفوف العميل الواحد تُدمج في قيد واحد (البند 10 من مراجعة 2026-09-17).
const balanceRow = z.object({
  customerName: z.string().trim().optional(),
  customerCode: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  balance: z.number(),
  date: importDate,
});
const balancesBody = z.object({
  rows: z.array(balanceRow).max(10000),
  undatedDate: undatedDateField,
  force: z.boolean().optional(),
});
router.post('/balances', requireImportAccess('balances'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = balancesBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult & { zero: number } = { created: 0, skipped: 0, zero: 0, total: rows.length, errors: [] };
    // كل التواريخ قبل أي كتابة: غير الصالح أو (بعد التفعيل) بلا تاريخ ⇒ 400 ولا شيء يُكتب
    const ctx = await importLedgerContext(tid);
    const { dates, undatedAsToday } = resolveImportDates(rows, { timezone: ctx.timezone, undatedDate: body.undatedDate, activated: ctx.activated, now: new Date() });
    const contentHash = importContentHash('balances', rows);
    assertNotDuplicateBatch(await duplicateBatch(tid, 'balances', contentHash), body.force === true);
    const skippedWarnings: { customerName: string; reason: string }[] = [];
    const matcher = await customerMatcher(req, tid);
    const resolved: ResolvedBalanceRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const m = matcher(r);
      if (!('id' in m)) { result.errors.push(customerMatchError(i + 2, m)!); continue; }
      // مقرَّب لمنازل العملة قبل التخزين وحساب الرصيد (كالقيد الافتتاحي: toMilli لكل صف)
      const amount = roundImportAmount(r.balance, ctx.decimals);
      resolved.push({ row: i + 2, customerId: m.id, customerName: r.customerName || r.customerCode || r.phone || '', amount, date: dates[i] });
    }
    // البند 10: صفوف العميل الواحد (تقرير أعمار الديون) قيد واحد بمجموعها وأحدث تاريخ؛ الصفر بعد الدمج لا يُكتب
    const { items, merged, zero } = mergeBalanceRows(resolved, ctx.decimals);
    result.zero = zero;
    // مراجعة 3 و7: الدفعة محجوزة قبل أي كتابة (البصمة والاستيراد الجاري تحت قفل الشركة)
    const progress = new ImportBatchProgress(
      await reserveEntryBatch(tid, 'balances', contentHash, importedBy(req), body.force === true, ctx.activated), 'balances');
    try {
      // الدفعات السابقة وحدها (لا إضافة من هذا الطلب: العميل قيد واحد بعد الدمج)
      const idx = await loadImportedIndex(tid);
      await runImportChunks({
        chunks: planImportChunks(items, () => 1, importChunkTarget(items.length)),
        runTx: <X>(fn: (tx: Prisma.TransactionClient) => Promise<X>) => prisma.$transaction(async tx => fn(tx), IMPORT_WRITE_TX),
        writeItem: async (tx: Prisma.TransactionClient, item): Promise<{ reason: BalanceSkipReason } | { id: string }> => {
          const cid = item.customerId;
          // قفل صف العميل ثم فحص الوجود داخل المعاملة: رصيد في دفعة balances غير متراجَع عنها أو قيود ledger مستوردة،
          // واحتياطاً «رصيد افتتاحي» بلا دفعة (BALANCE_UNBATCHED)
          await tx.$queryRaw`SELECT id FROM customers WHERE id = ${cid} AND "tenantId" = ${tid} FOR UPDATE`;
          const adj = await tx.accountEntry.findMany({
            where: { customerId: cid, type: { in: [...ADJUSTMENT_TYPES] }, invoiceId: null, receiptId: null },
            select: { id: true, description: true },
          });
          const reason = balanceSkipReason(adj, idx);
          if (reason) return { reason };
          // نفس تعريف الرصيد في كل المنظومة: Σمدين − Σدائن (لا «آخر قيد بالتاريخ»)
          const prev = await currentBalance(tx, cid);
          const amount = item.amount;
          const e = await tx.accountEntry.create({
            data: {
              tenantId: tid, customerId: cid,
              type: amount >= 0 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
              debit: amount >= 0 ? amount : 0, credit: amount >= 0 ? 0 : -amount,
              balance: clean(prev + amount), description: OPENING_BALANCE_DESCRIPTION, entryDate: item.date,
            },
          });
          await tx.customer.update({ where: { id: cid }, data: { balance: { increment: amount } } });
          return { id: e.id };
        },
        // معرّفات الشريحة في آخر معاملة كتابتها نفسها، دون شرط (البند 6)
        flush: (tx, written) => progress.write(tx, written.map(w => ('id' in w.result ? { records: [w.result.id] } : {}))),
        onCommitted: written => {
          progress.commit(written.map(w => ('id' in w.result ? { records: [w.result.id] } : {})));
          for (const { item, result: out } of written) {
            if ('reason' in out) {
              result.skipped++;
              skippedWarnings.push({ customerName: item.customerName, reason: BALANCE_SKIP_MESSAGES[out.reason] });
              continue;
            }
            result.created++;
          }
        },
        // فشل العميل ⇒ خطأ لكل صف من صفوفه
        onItemError: (item, e) => { for (const row of item.rows) result.errors.push(importWriteFailure(row, e)); },
        isFatal: isImportHttpError,
        afterChunk: () => progress.beat(),
      });
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: { ...result, warnings: { undatedAsToday, skipped: skippedWarnings, merged: merged.slice(0, 500) } } });
  } catch (err) { sendImportError(err, res, next); }
});

// ===== استيراد كشوف الحسابات / دفتر الأستاذ =====
const ledgerRow = z.object({
  customerName: z.string().trim().optional(),
  customerCode: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  date: importDate,
  description: z.string().trim().optional(),
  debit: z.number().optional(),
  credit: z.number().optional(),
});
const ledgerBody = z.object({
  rows: z.array(ledgerRow).max(20000),
  undatedDate: undatedDateField,
  force: z.boolean().optional(),
  confirmOverlap: z.boolean().optional(),
});
router.post('/ledger', requireImportAccess('ledger'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = ledgerBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult & { zero: number } = { created: 0, skipped: 0, zero: 0, total: rows.length, errors: [] };
    const ctx = await importLedgerContext(tid);
    const { dates, undatedAsToday } = resolveImportDates(rows, { timezone: ctx.timezone, undatedDate: body.undatedDate, activated: ctx.activated, now: new Date() });
    const contentHash = importContentHash('ledger', rows);
    assertNotDuplicateBatch(await duplicateBatch(tid, 'ledger', contentHash), body.force === true);
    // البند 8: غير المطابَق والملتبس خطأ صف لكل صف (لا «مكرر تخطي»)؛ المبالغ مقرَّبة لمنازل العملة (groupLedgerRows)
    const grouped = groupLedgerRows(rows, await customerMatcher(req, tid), dates, ctx.decimals);
    const groups = grouped.groups;
    for (const e of grouped.errors) result.errors.push(e);
    result.zero = grouped.zero;
    // مراجعة 3 و7: الدفعة محجوزة قبل فحص التداخل وأي كتابة (لا استيراد قيود آخر يعمل معه)
    const progress = new ImportBatchProgress(
      await reserveEntryBatch(tid, 'ledger', contentHash, importedBy(req), body.force === true, ctx.activated), 'ledger');
    let overlap: ReturnType<typeof detectLedgerOverlap> = [];
    try {
      // التداخل مع رصيد مستورد أو كشف سابق ⇒ 409 IMPORT_OVERLAP_CONFIRM قبل أي كتابة، ما لم يُرسل confirmOverlap (والحجز يُحذف)
      const idx = await loadImportedIndex(tid);
      if ((idx.balances.size > 0 || idx.ledger.size > 0) && groups.size > 0) {
        const cids = [...groups.keys()];
        const existing: { id: string; customerId: string; debit: number; credit: number }[] = [];
        for (let i = 0; i < cids.length; i += 1000) {
          existing.push(...await prisma.accountEntry.findMany({
            where: { customerId: { in: cids.slice(i, i + 1000) }, type: { in: [...ADJUSTMENT_TYPES] }, invoiceId: null, receiptId: null },
            select: { id: true, customerId: true, debit: true, credit: true },
          }));
        }
        overlap = detectLedgerOverlap(groups, existing, idx, new Map());
        if (overlap.length) {
          const names = await prisma.customer.findMany({ where: { tenantId: tid, id: { in: overlap.map(o => o.customerId) } }, select: { id: true, name: true } });
          const byId = new Map(names.map(c => [c.id, c.name]));
          overlap = overlap.map(o => ({ ...o, customerName: byId.get(o.customerId) ?? '' }));
        }
        assertOverlapConfirmed(overlap, body.confirmOverlap === true);
      }
      // تجميع الحركات حسب العميل ثم ترتيبها زمنياً لحساب الرصيد المتحرّك؛ الشريحة مجموعات عملاء بهدف عدد القيود (البند 6)
      const groupItems = [...groups].map(([cid, entries]) => ({ cid, entries: [...entries].sort((a, b) => a.date.getTime() - b.date.getTime()) }));
      const totalEntries = groupItems.reduce((s, g) => s + g.entries.length, 0);
      await runImportChunks({
        chunks: planImportChunks(groupItems, g => g.entries.length, importChunkTarget(totalEntries)),
        runTx: <X>(fn: (tx: Prisma.TransactionClient) => Promise<X>) => prisma.$transaction(async tx => fn(tx), IMPORT_WRITE_TX),
        writeItem: async (tx: Prisma.TransactionClient, { cid, entries }) => {
          const groupIds: string[] = [];
          let running = await currentBalance(tx, cid);
          for (const e of entries) {
            running = clean(running + e.debit - e.credit);
            const ae = await tx.accountEntry.create({
              data: {
                tenantId: tid, customerId: cid,
                type: e.debit >= e.credit ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
                debit: e.debit, credit: e.credit, balance: running,
                description: e.description || 'قيد مستورد', entryDate: e.date,
              },
              select: { id: true },
            });
            groupIds.push(ae.id);
          }
          await tx.customer.update({ where: { id: cid }, data: { balance: running } });
          return groupIds;
        },
        // معرّفات الشريحة في آخر معاملة كتابتها نفسها، دون شرط (البند 6)
        flush: (tx, written) => progress.write(tx, written.map(w => ({ records: w.result }))),
        onCommitted: written => {
          progress.commit(written.map(w => ({ records: w.result })));
          for (const w of written) result.created += w.result.length;
        },
        // فشل مجموعة العميل ⇒ خطأ لكل صف من صفوفها
        onItemError: (g, e) => { for (const en of g.entries) result.errors.push(importWriteFailure(en.row, e)); },
        isFatal: isImportHttpError,
        afterChunk: () => progress.beat(),
      });
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: { ...result, warnings: { undatedAsToday, overlap } } });
  } catch (err) { sendImportError(err, res, next); }
});

// ===== استيراد قوائم الأسعار (أسعار خاصة لكل عميل) =====
const priceRow = z.object({
  customerName: z.string().trim().optional(),
  customerCode: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  productCode: z.string().trim().min(1),
  price: z.number().nonnegative(),
});
const pricesBody = z.object({
  rows: z.array(priceRow).max(20000),
  force: z.boolean().optional(),
  /** البند 1: السعر الخاص الصفري بإقرار المالك في المعاينة وحده (لا يدخل البصمة) */
  allowZeroPrice: z.boolean().optional(),
});
router.post('/prices', requireImportAccess('prices'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = pricesBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    // البند 20: الدفعة محجوزة قبل أي كتابة
    const progress = new ImportBatchProgress(
      await reserveMasterBatch(tid, 'prices', importContentHash('prices', rows), importedBy(req), body.force === true), 'prices');
    try {
      const matcher = await customerMatcher(req, tid);
      const prods = await prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, code: true } });
      const prodByCode = new Map(prods.map(p => [p.code, p.id]));
      const writes: { row: number; customerId: string; productId: string; price: number }[] = [];
      rows.forEach((r, i) => {
        const row = i + 2;
        const m = matcher(r);
        if (!('id' in m)) { result.errors.push(customerMatchError(row, m)!); return; }
        const pid = prodByCode.get(r.productCode);
        if (!pid) { result.errors.push(importRowError(row, 'PRODUCT_NOT_FOUND')); return; }
        const zeroIssue = priceRowIssue(r.price, body.allowZeroPrice === true);
        if (zeroIssue) { result.errors.push(importRowError(row, zeroIssue)); return; }
        writes.push({ row, customerId: m.id, productId: pid, price: r.price });
      });
      await runImportChunks({
        chunks: planImportChunks(writes, () => 1, importChunkTarget(writes.length)),
        runTx: <X>(fn: (tx: Prisma.TransactionClient) => Promise<X>) => prisma.$transaction(async tx => fn(tx), IMPORT_WRITE_TX),
        writeItem: async (tx: Prisma.TransactionClient, w) => {
          const key = { customerId_productId: { customerId: w.customerId, productId: w.productId } };
          // السعر السابق قبل الكتابة (null = يُنشأ جديداً) ليستعيده التراجع
          const before = await tx.customerPrice.findUnique({ where: key, select: { price: true } });
          const cp = await tx.customerPrice.upsert({
            where: key,
            create: { customerId: w.customerId, productId: w.productId, price: w.price },
            update: { price: w.price },
            select: { id: true },
          });
          return { id: cp.id, previous: before ? before.price : null };
        },
        flush: (tx, written) => progress.write(tx, written.map(x => priceDelta(x.result))),
        onCommitted: written => {
          progress.commit(written.map(x => priceDelta(x.result)));
          result.created += written.length;
        },
        onItemError: (w, e) => { result.errors.push(importWriteFailure(w.row, e)); },
        isFatal: isImportHttpError,
        afterChunk: () => progress.beat(),
      });
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: result });
  } catch (err) { sendImportError(err, res, next); }
});

function priceDelta(w: { id: string; previous: number | null }): ImportProgressDelta {
  return { records: [w.id], previous: [[w.id, w.previous]] };
}


// ===== استيراد المخزون الافتتاحي (البند 9) =====
// حركة وارد واحدة (RECEIVE) ببنودها وتكلفة صافية بـnetUnitCost كمسار الوارد اليدوي، فتدخل قيمة المستودع في القيد
// الافتتاحي عبر opening.ts القائم. قبل التفعيل وحده، وقبل تاريخ بدء المسودة؛ والكتابة تحت قفل gl-post فلا تتقاطع مع الاعتماد.
const optText = z.preprocess((v) => (typeof v === 'number' ? String(v) : v === null ? undefined : v), z.string().trim().max(200).optional());
const optNumber = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.number().optional());
const openingStockRow = z.object({
  productCode: optText,
  barcode: optText,
  productName: optText,
  qty: optNumber,
  unitCost: optNumber,
});
const openingStockBody = z.object({
  rows: z.array(openingStockRow).min(1).max(5000),
  pricesIncludeTax: z.boolean().optional().default(false),
  force: z.boolean().optional(),
  /** إقرار: تاريخ البدء المحفوظ ≤ اليوم فيلزم تعديله لاحقاً إلى ما بعد يوم الاستيراد (وإلا 409 OPENING_STOCK_AFTER_CUTOVER) */
  acknowledgeCutoverChange: z.boolean().optional(),
});
// صلاحية المستودع ثم requireAccounting صريحاً بعدها (accounting:false فلا يُفحص مرتين)
router.post('/opening-stock', requireImportAccess('opening_stock', { accounting: false }), requireAccounting, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = openingStockBody.parse(req.body ?? {});
    const rows = body.rows;
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true } });
    if (!tenant?.warehouseEnabled) {
      res.status(403).json({ success: false, code: 'WAREHOUSE_NOT_ENABLED', message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' });
      return;
    }
    const settingsOf = (db: Prisma.TransactionClient | typeof prisma) =>
      db.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true } });
    const guard = (s: Awaited<ReturnType<typeof settingsOf>>, now: Date) =>
      assertOpeningStockAllowed({
        activatedAt: s?.activatedAt, setupDraft: s?.setupDraft, timezone: importTimezone(s), now, acknowledgeCutoverChange: body.acknowledgeCutoverChange === true,
      });
    // فحص سريع قبل القراءة الكبيرة، ويُعاد تحت القفل
    guard(await settingsOf(prisma), new Date());
    const contentHash = openingStockContentHash(rows, body.pricesIncludeTax);
    assertNotDuplicateBatch(await duplicateBatch(tid, OPENING_STOCK_KIND, contentHash), body.force === true);

    const products = await prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, code: true, barcode: true, name: true, taxPct: true } });
    const { lines, errors } = resolveOpeningStockRows(rows, openingStockProductFinder(products), body.pricesIncludeTax);
    const result = { created: 0, skipped: 0, total: rows.length, errors, batchId: null as string | null, entryId: null as string | null, totalCost: 0 };
    if (!lines.length) { res.json({ success: true, data: result }); return; }

    const by = (req.user as { name?: string } | undefined)?.name || null;
    let out: { batchId: string; entryId: string };
    try {
      out = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        // قفل gl-post: اعتماد التفعيل يمسكه، فلا حركة افتتاحية تُكتب بين لقطة الافتتاح وضبط activatedAt
        await acquirePostLock(tx, tid);
        // ساعة القاعدة للحارس ولـcreatedAt: الاعتماد يقارن الحركة بـT0 وبداية تاريخ البدء من ساعة القاعدة نفسها
        const dbNowRows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
        const dbNow = dbNowRows[0]?.now instanceof Date ? dbNowRows[0].now : new Date();
        guard(await settingsOf(tx), dbNow);
        assertNotDuplicateBatch(await tx.importBatch.findFirst({
          where: { tenantId: tid, kind: OPENING_STOCK_KIND, reverted: false, contentHash }, orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true, status: true, heartbeatAt: true },
        }), body.force === true);
        const entry = await tx.warehouseEntry.create({
          data: {
            tenantId: tid, type: OPENING_STOCK_ENTRY_TYPE, note: OPENING_STOCK_NOTE, createdBy: by, createdAt: dbNow,
            items: { create: lines.map(l => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost })) },
          },
          select: { id: true },
        });
        const b = await tx.importBatch.create({
          data: {
            tenantId: tid, kind: OPENING_STOCK_KIND, count: lines.length, recordIds: serializeBatchRecordIds(OPENING_STOCK_KIND, [entry.id]),
            createdBy: by, contentHash, status: IMPORT_BATCH_DONE, heartbeatAt: dbNow, createdAt: dbNow,
          },
          select: { id: true },
        });
        return { batchId: b.id, entryId: entry.id };
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (e) {
      if (!isImportHttpError(e) && isLockBusyError(e)) {
        res.status(409).json({ success: false, code: 'OPENING_STOCK_LEDGER_BUSY', message: LEDGER_BUSY_MESSAGE });
        return;
      }
      throw e;
    }
    res.json({
      success: true,
      data: { ...result, created: lines.length, batchId: out.batchId, entryId: out.entryId, totalCost: entryTotalCost(lines) },
    });
  } catch (err) { sendImportError(err, res, next); }
});

// ===== سجلّ الدفعات + التراجع =====
// قائمة الدفعات غير المتراجَع عنها
router.get('/batches', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // البندان 5 و21: المقيّد النطاق لا يرى دفعات الشركة، وغيره يرى أنواع صلاحياته وحدها
    const actor = await loadImportActor(req);
    if (actor?.scopeEnabled === true) { res.json({ success: true, data: [], scoped: true }); return; }
    const batches = await prisma.importBatch.findMany({
      where: { tenantId: tid, reverted: false, kind: { in: importKindsAllowed(actor) } }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, kind: true, count: true, createdBy: true, createdAt: true, status: true, heartbeatAt: true },
    });
    // status: running (قيد الاستيراد) | interrupted (انقطع — ما سُجّل منه قابل للتراجع) | done
    const now = new Date();
    res.json({ success: true, data: batches.map(({ heartbeatAt, ...b }) => ({ ...b, status: importBatchState({ ...b, heartbeatAt }, now) })), scoped: false });
  } catch (err) { next(err); }
});

// التراجع عن دفعة استيراد — يزيل سجلاتها بأمان ويعيد حساب الأرصدة
// العملاء/المنتجات (البندان 6ب و10): معاملة لكل سجل، المحمي والمرتبط يبقى ويُعاد {blocked, remaining} والدفعة reverted:false.
// الأرصدة/الأستاذ (البند 6أ): قفل gl-post أولاً فلا يتقاطع التراجع مع اعتماد التفعيل.
router.post('/batches/:id/revert', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // البندان 5 و21: المقيّد النطاق ⇒ 403 قبل البحث عن الدفعة
    const actor = await loadImportActor(req);
    const scopeAccess = importAccessDecision(actor, null);
    if (!scopeAccess.ok) { res.status(scopeAccess.status).json(importAccessBody(scopeAccess)); return; }
    const batch = await prisma.importBatch.findFirst({ where: { id: req.params.id, tenantId: tid, reverted: false } });
    if (!batch) { res.status(404).json({ success: false, message: 'الدفعة غير موجودة أو متراجع عنها' }); return; }
    // صلاحية نوع الدفعة، ثم النظام المحاسبي للأنواع المحاسبية (نص requireAccounting نفسه)
    const kindAccess = importAccessDecision(actor, batch.kind);
    if (!kindAccess.ok) { res.status(kindAccess.status).json(importAccessBody(kindAccess)); return; }
    if (isImportAccountingKind(batch.kind)) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } });
      if (tenant?.accountingEnabled === false) {
        res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: ACCOUNTING_NOT_ALLOWED_MESSAGE });
        return;
      }
    }
    // مراجعة 7: دفعة ما زالت تُكتب ⇒ 409 IMPORT_BATCH_RUNNING (التراجع عنها يترك قيوداً تُكتب بعده)
    assertBatchRevertible(batch, new Date());
    const parsed = parseBatchRecordIds(batch.recordIds);
    const ids = parsed.records;
    let removed = 0;
    const blocked: RevertBlocked[] = [];
    const done = new Set<string>();

    if (batch.kind === 'customers') {
      let ledgerBusy = false;
      const names = new Map((await prisma.customer.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, name: true } })).map(c => [c.id, c.name]));
      for (const cid of ids) {
        try {
          const out = await prisma.$transaction(async tx => {
            // انتظار قفل gl-post (اعتماد التفعيل يمسكه حتى 60 ثانية) محدود بـ5 ثوانٍ لا بمهلة المعاملة
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await acquirePostLock(tx, tid);
            // قفل صف العميل: فاتورة/سند/قيد يُدرج متزامناً ينتظر نهاية الحذف
            const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM customers WHERE id = ${cid} AND "tenantId" = ${tid} FOR UPDATE`;
            if (locked.length === 0) return { status: 'gone' as const };
            // الدفاتر (§5.3): null حين لم تُفعَّل يوماً — فلا كتابة إضافية
            const glSettings = await ledgerTombstoneSettings(tx, tid);
            // حماية: لا نحذف عميلاً له فواتير/سندات/روابط دفع/زيارات حقيقية
            const reason = customerBlockReason({
              invoices: await tx.invoice.count({ where: { customerId: cid } }),
              receipts: await tx.receipt.count({ where: { customerId: cid } }),
              paymentLinks: await tx.customerPaymentLink.count({ where: { customerId: cid } }),
              visits: await tx.repVisit.count({ where: { customerId: cid } }),
            });
            if (reason) return { status: 'blocked' as const, reason };
            const rows = await tx.accountEntry.findMany({
              where: { customerId: cid },
              select: { id: true, customerId: true, debit: true, credit: true, entryDate: true, description: true, createdAt: true, customer: { select: { name: true } } },
            });
            if (glSettings) {
              const glTombstones = arEntryTombstoneRows(tid, rows, glSettings, { batchId: batch.id });
              if (glTombstones.length > 0) {
                await tx.glSourceEvent.createMany({ data: glTombstones as Prisma.GlSourceEventCreateManyInput[], skipDuplicates: true });
              }
            }
            await tx.accountEntry.deleteMany({ where: { id: { in: rows.map(e => e.id) } } });
            await tx.customerPrice.deleteMany({ where: { customerId: cid } });
            await tx.notification.deleteMany({ where: { customerId: cid } });
            await tx.customer.deleteMany({ where: { id: cid, tenantId: tid } });
            return { status: 'removed' as const };
          }, { maxWait: 10_000, timeout: 30_000 });
          if (out.status === 'blocked') { blocked.push({ id: cid, name: names.get(cid) ?? '', reason: out.reason }); continue; }
          if (out.status === 'removed') removed++;
          done.add(cid);
        } catch (e) {
          // الفشل يلغي المعاملة كلها ومعها أحداث الدفاتر ذرياً
          const busy = !isFkBlockError(e) && isLockBusyError(e);
          const reason = isFkBlockError(e) ? FK_BLOCK_REASON : busy ? LEDGER_BUSY_MESSAGE : `تعذّر الحذف: ${(e as Error).message?.slice(0, 100) || 'خطأ'}`;
          blocked.push({ id: cid, name: names.get(cid) ?? '', reason });
          // القفل مشغول ⇒ لا انتظار لكل عميل تالٍ: البقية تبقى في الدفعة (remaining)
          if (busy) { ledgerBusy = true; break; }
        }
      }
      if (ledgerBusy && removed === 0) {
        res.status(409).json({ success: false, code: 'IMPORT_REVERT_LEDGER_BUSY', message: LEDGER_BUSY_MESSAGE });
        return;
      }
    } else if (batch.kind === 'products') {
      const names = new Map((await prisma.product.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, name: true } })).map(p => [p.id, p.name]));
      for (const pid of ids) {
        try {
          const out = await prisma.$transaction(async tx => {
            const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${pid} AND "tenantId" = ${tid} FOR UPDATE`;
            if (locked.length === 0) return { status: 'gone' as const };
            const reason = productBlockReason({
              invoiceItems: await tx.invoiceItem.count({ where: { productId: pid } }),
              vanLoadItems: await tx.vanLoadItem.count({ where: { productId: pid } }),
              warehouseEntryItems: await tx.warehouseEntryItem.count({ where: { productId: pid } }),
            });
            if (reason) return { status: 'blocked' as const, reason };
            await tx.priceTier.deleteMany({ where: { productId: pid } });
            await tx.customerPrice.deleteMany({ where: { productId: pid } });
            await tx.product.deleteMany({ where: { id: pid, tenantId: tid } });
            return { status: 'removed' as const };
          }, { maxWait: 10_000, timeout: 30_000 });
          if (out.status === 'blocked') { blocked.push({ id: pid, name: names.get(pid) ?? '', reason: out.reason }); continue; }
          if (out.status === 'removed') removed++;
          done.add(pid);
        } catch (e) {
          const reason = isFkBlockError(e) ? FK_BLOCK_REASON : `تعذّر الحذف: ${(e as Error).message?.slice(0, 100) || 'خطأ'}`;
          blocked.push({ id: pid, name: names.get(pid) ?? '', reason });
        }
      }
    } else if (batch.kind === 'balances' || batch.kind === 'ledger') {
      // احذف القيود المستوردة ثم أعد حساب أرصدة العملاء المتأثّرين (وأرصدتهم المتحرّكة)
      // معاملة تفاعلية واحدة (§5.3): قفل gl-post، ثم القراءة ثم أحداث الدفاتر (لا شيء حين لم تُفعَّل يوماً) ثم الحذف.
      // إعادة كتابة الأرصدة صفاً صفاً تبقى خارجها كما كانت.
      let affected: string[];
      try {
        affected = await prisma.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          await acquirePostLock(tx, tid);
          const entries = await tx.accountEntry.findMany({
            where: { id: { in: ids }, tenantId: tid },
            select: { id: true, customerId: true, debit: true, credit: true, entryDate: true, description: true, createdAt: true },
          });
          const glTombstones = await ledgerTombstones(tx, tid, entries, { batchId: batch.id });
          if (glTombstones.length > 0) {
            await tx.glSourceEvent.createMany({ data: glTombstones as Prisma.GlSourceEventCreateManyInput[], skipDuplicates: true });
          }
          const del = await tx.accountEntry.deleteMany({ where: { id: { in: ids }, tenantId: tid } });
          removed = del.count;
          return [...new Set(entries.map(e => e.customerId))];
        }, { maxWait: 10_000, timeout: 60_000 });
      } catch (e) {
        if (isLockBusyError(e)) { res.status(409).json({ success: false, code: 'IMPORT_REVERT_LEDGER_BUSY', message: LEDGER_BUSY_MESSAGE }); return; }
        throw e;
      }
      for (const cid of affected) {
        const remaining = await prisma.accountEntry.findMany({ where: { customerId: cid }, orderBy: { entryDate: 'asc' } });
        let running = 0;
        for (const e of remaining) {
          running = clean(running + Number(e.debit) - Number(e.credit));
          await prisma.accountEntry.update({ where: { id: e.id }, data: { balance: running } });
        }
        await prisma.customer.update({ where: { id: cid }, data: { balance: running } });
      }
    } else if (batch.kind === 'prices') {
      // البند 20: السعر السابق يُستعاد (إن بقي الصف)، والمُنشأ في الدفعة (أو الشكل القديم) يُحذف — بمستأجر الشركة
      const plan = pricesRevertPlan(parsed);
      for (let i = 0; i < plan.restore.length; i += 500) {
        const part = plan.restore.slice(i, i + 500);
        removed += await prisma.$transaction(async tx => {
          let n = 0;
          for (const p of part) {
            n += (await tx.customerPrice.updateMany({ where: { id: p.id, customer: { tenantId: tid } }, data: { price: p.price } })).count;
          }
          return n;
        }, IMPORT_WRITE_TX);
      }
      if (plan.remove.length) {
        const del = await prisma.customerPrice.deleteMany({ where: { id: { in: plan.remove }, customer: { tenantId: tid } } });
        removed += del.count;
      }
    } else if (batch.kind === OPENING_STOCK_KIND) {
      // البند 9: قبل التفعيل وحده (بعده 409 OPENING_STOCK_REVERT_LEDGER_ACTIVE)، تحت قفل gl-post فلا يتقاطع مع الاعتماد؛
      // والحركة تُحذف ببنودها ما لم تُستهلك أصنافها بعدها (تحميل سيارات أو فواتير أو تسوية بالنقص) ⇒ blocked
      assertOpeningStockRevertAllowed((await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true } }))?.activatedAt);
      for (const eid of ids) {
        try {
          const out = await prisma.$transaction(async tx => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await acquirePostLock(tx, tid);
            assertOpeningStockRevertAllowed((await tx.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true } }))?.activatedAt);
            const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM warehouse_entries WHERE id = ${eid} AND "tenantId" = ${tid} FOR UPDATE`;
            if (locked.length === 0) return { status: 'gone' as const };
            const entry = await tx.warehouseEntry.findUniqueOrThrow({ where: { id: eid }, select: { createdAt: true, items: { select: { productId: true } } } });
            const productIds = [...new Set(entry.items.map(i => i.productId))];
            const since = { gte: entry.createdAt };
            const reason = productIds.length ? openingStockRevertBlockReason({
              vanLoads: await tx.vanLoadItem.count({ where: { productId: { in: productIds }, vanLoad: { tenantId: tid, type: 'LOAD', createdAt: since } } }),
              invoiceItems: await tx.invoiceItem.count({ where: { productId: { in: productIds }, invoice: { tenantId: tid, createdAt: since } } }),
              warehouseOut: await tx.warehouseEntryItem.count({
                where: { productId: { in: productIds }, qty: { lt: 0 }, entryId: { not: eid }, entry: { tenantId: tid, createdAt: since } },
              }),
            }) : null;
            if (reason) return { status: 'blocked' as const, reason };
            await tx.warehouseEntryItem.deleteMany({ where: { entryId: eid } });
            await tx.warehouseEntry.deleteMany({ where: { id: eid, tenantId: tid } });
            return { status: 'removed' as const };
          }, { maxWait: 10_000, timeout: 30_000 });
          if (out.status === 'blocked') { blocked.push({ id: eid, name: OPENING_STOCK_NOTE, reason: out.reason }); continue; }
          if (out.status === 'removed') removed++;
          done.add(eid);
        } catch (e) {
          if (isImportHttpError(e)) throw e;
          if (!isFkBlockError(e) && isLockBusyError(e)) {
            res.status(409).json({ success: false, code: 'IMPORT_REVERT_LEDGER_BUSY', message: LEDGER_BUSY_MESSAGE });
            return;
          }
          const reason = isFkBlockError(e) ? FK_BLOCK_REASON : `تعذّر الحذف: ${(e as Error).message?.slice(0, 100) || 'خطأ'}`;
          blocked.push({ id: eid, name: OPENING_STOCK_NOTE, reason });
        }
      }
    }

    if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND) {
      // الفئات المُنشأة في الدفعة: تُحذف فقط إن لم يبقَ لها منتج ولا ربط حساب
      const keptCategories: string[] = [];
      if (batch.kind === 'products') {
        for (const catId of parsed.categories) {
          const deletable = categoryDeletable({
            products: await prisma.product.count({ where: { tenantId: tid, categoryId: catId } }),
            accountRows: await prisma.glProductCategoryAccount.count({ where: { tenantId: tid, categoryId: catId } }),
          });
          if (!deletable) { keptCategories.push(catId); continue; }
          try { await prisma.productCategory.deleteMany({ where: { id: catId, tenantId: tid } }); }
          catch (e) { if (isFkBlockError(e)) keptCategories.push(catId); else throw e; }
        }
      }
      const { reverted, remainingIds } = revertOutcome(ids, done);
      if (reverted) {
        await prisma.importBatch.update({ where: { id: batch.id }, data: { reverted: true } });
      } else {
        await prisma.importBatch.update({
          where: { id: batch.id },
          data: { recordIds: serializeBatchRecordIds(batch.kind, remainingIds, keptCategories), count: remainingIds.length },
        });
      }
      res.json({ success: true, data: revertResponse(batch.kind, removed, blocked, remainingIds.length, batch.kind === 'products' ? { keptCategories: keptCategories.length } : {}) });
      return;
    }

    await prisma.importBatch.update({ where: { id: batch.id }, data: { reverted: true } });
    res.json({ success: true, data: revertResponse(batch.kind, removed, [], 0) });
  } catch (err) { sendImportError(err, res, next); }
});

export default router;
