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
} from '../services/importLedger';
import { entryTotalCost } from '../services/warehouseCost';

// ============================================================================
// استيراد بيانات الشركات من أنظمتها السابقة (Excel → صفوف JSON من الواجهة).
// كل استيراد معزول لشركة المستخدم (tenantId)، عبر منطق النظام (لا مساس مباشر بـ DB).
// المرحلة 1: العملاء + المنتجات. (الأرصدة/دفتر الأستاذ/الأسعار لاحقاً.)
// ============================================================================

const router = Router();
router.use(authenticate, requireAdmin);

const CHANNELS = ['MT', 'WHOLESALE', 'TT', 'DISCOUNTER', 'CASH_VAN', 'ECOMMERCE'];

// تطبيع اسم العميل لمطابقته (توحيد الهمزات/التاء المربوطة/الياء وإزالة التشكيل)
const normName = (s: string): string => s.trim().toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').replace(/\s+/g, ' ');

type ImportResult = { created: number; skipped: number; total: number; errors: { row: number; message: string }[]; batchId?: string | null };

// يسجّل دفعة استيراد بمعرّفات السجلات المُنشأة (لإتاحة التراجع)
async function recordBatch(
  tid: string, kind: string, ids: string[], by?: string, opts: { contentHash?: string; categories?: string[] } = {},
): Promise<string | null> {
  if (!ids.length) return null;
  const b = await prisma.importBatch.create({
    data: {
      tenantId: tid, kind, count: ids.length, recordIds: serializeBatchRecordIds(kind, ids, opts.categories ?? []), createdBy: by || null,
      ...(opts.contentHash ? { contentHash: opts.contentHash } : {}),
    },
  });
  return b.id;
}

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
 * معرّفات الدفعة الجارية تُحفظ أثناء الاستيراد (كل IMPORT_FLUSH_EVERY_ROWS قيد أو IMPORT_FLUSH_EVERY_MS، داخل معاملة الكتابة
 * نفسها) مع النبض — فانقطاع الخادم لا يترك إلا ما بعد آخر حفظ بلا دفعة، والتراجع يرى ما سُجّل. النهاية: done، أو حذف الدفعة
 * إن لم يُنشأ شيء (batchId=null كما كان).
 */
class EntryBatchProgress {
  readonly ids: string[] = [];
  private flushed = 0;
  private lastFlushAt = Date.now();
  constructor(readonly id: string, readonly kind: 'balances' | 'ledger') {}

  due(extra = 0): boolean {
    return importFlushDue({ pending: this.ids.length + extra - this.flushed, lastFlushAt: this.lastFlushAt, now: Date.now() });
  }

  /** يكتب المعرّفات (مع الجديدة غير الملتزمة بعد) والنبض؛ يعيد العدد المكتوب */
  async write(db: Prisma.TransactionClient, extra: readonly string[] = []): Promise<number> {
    const all = extra.length ? [...this.ids, ...extra] : this.ids;
    await db.importBatch.update({
      where: { id: this.id }, data: { count: all.length, recordIds: serializeBatchRecordIds(this.kind, all), heartbeatAt: new Date() },
    });
    return all.length;
  }

  /** بعد التزام المعاملة: القيود الجديدة، وعدد المحفوظ إن حُفظ داخلها */
  commit(newIds: readonly string[], flushedCount: number | null): void {
    this.ids.push(...newIds);
    if (flushedCount !== null) { this.flushed = flushedCount; this.lastFlushAt = Date.now(); }
  }

  /** نبض خارج المعاملات (صفوف متخطاة أو فاشلة) — لا يُفشل الاستيراد */
  async beat(): Promise<void> {
    if (!this.due()) return;
    try { this.commit([], await this.write(prisma)); } catch { /* النبض التالي */ }
  }

  async finish(): Promise<string | null> {
    if (!this.ids.length) {
      await prisma.importBatch.deleteMany({ where: { id: this.id } });
      return null;
    }
    await prisma.importBatch.update({
      where: { id: this.id },
      data: { count: this.ids.length, recordIds: serializeBatchRecordIds(this.kind, this.ids), heartbeatAt: new Date(), status: IMPORT_BATCH_DONE },
    });
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

router.post('/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = z.array(customerRow).max(5000).parse(req.body?.rows);
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    const createdIds: string[] = [];

    // موجودون مسبقاً (جوال/كود) لتفادي التكرار
    const existing = await prisma.customer.findMany({ where: { tenantId: tid }, select: { phone: true, code: true, name: true } });
    const phones = new Set(existing.map(e => e.phone).filter(Boolean));
    const codes = new Set(existing.map(e => e.code).filter(Boolean));
    const names = new Set(existing.map(e => normName(e.name)));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        // تخطّي المكرّر بالجوال أو الكود أو الاسم (لتفادي التكرار عند إعادة الاستيراد)
        if ((r.phone && phones.has(r.phone)) || (r.code && codes.has(r.code)) || names.has(normName(r.name))) { result.skipped++; continue; }
        const c = await prisma.customer.create({
          data: {
            tenantId: tid,
            name: r.name,
            phone: r.phone || '—',
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
        });
        createdIds.push(c.id);
        result.created++;
        if (r.phone) phones.add(r.phone);
        if (r.code) codes.add(r.code);
        names.add(normName(r.name));
      } catch (e) {
        result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ غير معروف' });
      }
    }
    result.batchId = await recordBatch(tid, 'customers', createdIds, (req.user as { name?: string } | undefined)?.name);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
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

router.post('/products', requireAccounting, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = z.array(productRow).max(5000).parse(req.body?.rows);
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    const createdIds: string[] = [];
    const createdCategories: string[] = [];

    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
    const defaultVat = company?.defaultVatPct ?? 15;

    const existing = await prisma.product.findMany({ where: { tenantId: tid }, select: { code: true } });
    const codes = new Set(existing.map(e => e.code));

    // خريطة فئات موجودة/جديدة بالاسم
    const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
    const catByName = new Map(cats.map(c => [c.name.trim(), c.id]));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if (codes.has(r.code)) { result.skipped++; continue; }
        let categoryId: string | null = null;
        if (r.category) {
          categoryId = catByName.get(r.category) ?? null;
          if (!categoryId) {
            const nc = await prisma.productCategory.create({ data: { tenantId: tid, name: r.category } });
            categoryId = nc.id; catByName.set(r.category, nc.id); createdCategories.push(nc.id);
          }
        }
        const p = await prisma.product.create({
          data: {
            tenantId: tid, code: r.code, name: r.name, unit: r.unit || 'حبة',
            basePrice: r.basePrice ?? 0, taxPct: r.taxPct ?? defaultVat,
            barcode: r.barcode || null, categoryId,
          } as never,
        });
        createdIds.push(p.id);
        result.created++;
        codes.add(r.code);
      } catch (e) {
        result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ غير معروف' });
      }
    }
    result.batchId = await recordBatch(tid, 'products', createdIds, (req.user as { name?: string } | undefined)?.name, { categories: createdCategories });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

/**
 * خرائط ربط العملاء (بالكود أو الجوال أو الاسم).
 *
 * **مُقيَّدة بنطاق المستخدم** — وهذا يغلق /balances و/ledger و/prices من مصدر
 * واحد: عميلٌ خارج النطاق لا يتحوّل إلى معرّف أصلاً، فيسقط الصفّ برسالة
 * «العميل غير موجود» — نفس ردّ العميل غير الموجود حقيقةً، فلا يصير الاستيراد
 * أوراكل يكشف وجود عملاء، ولا تُكتب أرصدة وقيود وأسعار على من لا يراه.
 */
async function customerFinder(req: AuthRequest, tid: string) {
  const custs = await prisma.customer.findMany({
    where: { tenantId: tid, ...(await customerScope(req, tid)) },
    select: { id: true, code: true, phone: true, name: true },
  });
  const byCode = new Map<string, string>(); const byPhone = new Map<string, string>(); const byName = new Map<string, string>();
  for (const c of custs) { if (c.code) byCode.set(c.code, c.id); if (c.phone) byPhone.set(c.phone, c.id); if (c.name) byName.set(normName(c.name), c.id); }
  // يربط العميل بالكود أو الجوال أو الاسم (كثير من الأنظمة تُصدّر باسم العميل فقط)
  return (name?: string, code?: string, phone?: string): string | null =>
    (code && byCode.get(code)) || (phone && byPhone.get(phone)) || (name && byName.get(normName(name))) || null;
}

// ===== استيراد الأرصدة الافتتاحية =====
// التاريخ YYYY-MM-DD بتوقيت الشركة (البند 1)، وundatedDate للصفوف بلا تاريخ (البند 2)، والبصمة والتخطي بسبب (البند 5).
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
router.post('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = balancesBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    // كل التواريخ قبل أي كتابة: غير الصالح أو (بعد التفعيل) بلا تاريخ ⇒ 400 ولا شيء يُكتب
    const ctx = await importLedgerContext(tid);
    const { dates, undatedAsToday } = resolveImportDates(rows, { timezone: ctx.timezone, undatedDate: body.undatedDate, activated: ctx.activated, now: new Date() });
    const contentHash = importContentHash('balances', rows);
    assertNotDuplicateBatch(await duplicateBatch(tid, 'balances', contentHash), body.force === true);
    const skippedWarnings: { customerName: string; reason: string }[] = [];
    const findCust = await customerFinder(req, tid);
    // مراجعة 3 و7: الدفعة محجوزة قبل أي كتابة (البصمة والاستيراد الجاري تحت قفل الشركة)
    const progress = new EntryBatchProgress(
      await reserveEntryBatch(tid, 'balances', contentHash, (req.user as { name?: string } | undefined)?.name || null, body.force === true, ctx.activated), 'balances');
    try {
      const idx = await loadImportedIndex(tid);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          const cid = findCust(r.customerName, r.customerCode, r.phone);
          if (!cid) { result.errors.push({ row: i + 2, message: 'العميل غير موجود استورد العملاء أولا' }); continue; }
          // مقرَّب لمنازل العملة قبل التخزين وحساب الرصيد (كالقيد الافتتاحي: toMilli لكل صف)
          const amount = roundImportAmount(r.balance, ctx.decimals); const date = dates[i];
          if (!amount) { result.skipped++; continue; }
          const out = await prisma.$transaction(async tx => {
            // قفل صف العميل ثم فحص الوجود داخل المعاملة: رصيد في دفعة balances غير متراجَع عنها أو قيود ledger مستوردة،
            // واحتياطاً «رصيد افتتاحي» بلا دفعة (استيراد انقطع قبل تسجيلها أو سبق نظام الدفعات)
            await tx.$queryRaw`SELECT id FROM customers WHERE id = ${cid} AND "tenantId" = ${tid} FOR UPDATE`;
            const adj = await tx.accountEntry.findMany({
              where: { customerId: cid, type: { in: [...ADJUSTMENT_TYPES] }, invoiceId: null, receiptId: null },
              select: { id: true, description: true },
            });
            const reason = balanceSkipReason(adj, idx);
            if (reason) return { reason };
            // نفس تعريف الرصيد في كل المنظومة: Σمدين − Σدائن (لا «آخر قيد بالتاريخ»)
            const prev = await currentBalance(tx, cid);
            const e = await tx.accountEntry.create({
              data: {
                tenantId: tid, customerId: cid,
                type: amount >= 0 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
                debit: amount >= 0 ? amount : 0, credit: amount >= 0 ? 0 : -amount,
                balance: clean(prev + amount), description: OPENING_BALANCE_DESCRIPTION, entryDate: date,
              },
            });
            await tx.customer.update({ where: { id: cid }, data: { balance: { increment: amount } } });
            // معرّفات الدفعة في معاملة الكتابة نفسها حين يحين الحفظ
            const flushed = progress.due(1) ? await progress.write(tx, [e.id]) : null;
            return { id: e.id, flushed };
          });
          if ('reason' in out && out.reason) {
            result.skipped++;
            skippedWarnings.push({ customerName: r.customerName || r.customerCode || r.phone || '', reason: BALANCE_SKIP_MESSAGES[out.reason] });
            continue;
          }
          const written = out as { id: string; flushed: number | null };
          idx.balances.add(written.id); // تكرار العميل في الملف نفسه يُتخطى بالسبب نفسه
          progress.commit([written.id], written.flushed);
          result.created++;
        } catch (e) {
          result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ' });
        } finally {
          await progress.beat();
        }
      }
    } finally {
      result.batchId = await progress.finish();
    }
    res.json({ success: true, data: { ...result, warnings: { undatedAsToday, skipped: skippedWarnings } } });
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
router.post('/ledger', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = ledgerBody.parse(req.body ?? {});
    const rows = body.rows;
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    const ctx = await importLedgerContext(tid);
    const { dates, undatedAsToday } = resolveImportDates(rows, { timezone: ctx.timezone, undatedDate: body.undatedDate, activated: ctx.activated, now: new Date() });
    const contentHash = importContentHash('ledger', rows);
    assertNotDuplicateBatch(await duplicateBatch(tid, 'ledger', contentHash), body.force === true);
    const findCust = await customerFinder(req, tid);
    // تجميع الحركات حسب العميل ثم ترتيبها زمنياً لحساب الرصيد المتحرّك
    const groups = new Map<string, { row: number; date: Date; description?: string; debit: number; credit: number }[]>();
    rows.forEach((r, i) => {
      const cid = findCust(r.customerName, r.customerCode, r.phone);
      if (!cid) { result.skipped++; return; } // عميل غير مطابَق — يُتخطّى بلا خطأ
      if (!groups.has(cid)) groups.set(cid, []);
      // مقرَّبة لمنازل العملة قبل التخزين وحساب الرصيد المتحرّك (كالقيد الافتتاحي: toMilli لكل صف)
      groups.get(cid)!.push({ row: i + 2, date: dates[i], description: r.description, debit: roundImportAmount(r.debit, ctx.decimals), credit: roundImportAmount(r.credit, ctx.decimals) });
    });
    // مراجعة 3 و7: الدفعة محجوزة قبل فحص التداخل وأي كتابة (لا استيراد قيود آخر يعمل معه)
    const progress = new EntryBatchProgress(
      await reserveEntryBatch(tid, 'ledger', contentHash, (req.user as { name?: string } | undefined)?.name || null, body.force === true, ctx.activated), 'ledger');
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
      for (const [cid, entries] of groups) {
        try {
          entries.sort((a, b) => a.date.getTime() - b.date.getTime());
          const groupIds: string[] = [];
          const step: { flushed: number | null } = { flushed: null };
          await prisma.$transaction(async tx => {
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
              });
              groupIds.push(ae.id);
            }
            await tx.customer.update({ where: { id: cid }, data: { balance: running } });
            // معرّفات الدفعة في معاملة الكتابة نفسها حين يحين الحفظ
            if (groupIds.length && progress.due(groupIds.length)) step.flushed = await progress.write(tx, groupIds);
          }, { timeout: 20000 });
          progress.commit(groupIds, step.flushed);
          result.created += groupIds.length;
        } catch (e) {
          result.errors.push({ row: entries[0]?.row || 0, message: (e as Error).message?.slice(0, 140) || 'خطأ' });
        } finally {
          await progress.beat();
        }
      }
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
router.post('/prices', requireAccounting, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = z.array(priceRow).max(20000).parse(req.body?.rows);
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };
    const createdIds: string[] = [];
    const findCust = await customerFinder(req, tid);
    const prods = await prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, code: true } });
    const prodByCode = new Map(prods.map(p => [p.code, p.id]));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const cid = findCust(r.customerName, r.customerCode, r.phone);
        const pid = prodByCode.get(r.productCode);
        if (!cid) { result.errors.push({ row: i + 2, message: 'العميل غير موجود استورد العملاء أولا' }); continue; }
        if (!pid) { result.errors.push({ row: i + 2, message: 'الصنف غير موجود استورد المنتجات أولا' }); continue; }
        const cp = await prisma.customerPrice.upsert({
          where: { customerId_productId: { customerId: cid, productId: pid } },
          create: { customerId: cid, productId: pid, price: r.price },
          update: { price: r.price },
        });
        createdIds.push(cp.id);
        result.created++;
      } catch (e) { result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ' }); }
    }
    result.batchId = await recordBatch(tid, 'prices', createdIds, (req.user as { name?: string } | undefined)?.name);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

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
router.post('/opening-stock', requireAccounting, async (req: AuthRequest, res: Response, next: NextFunction) => {
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
    const batches = await prisma.importBatch.findMany({
      where: { tenantId: tid, reverted: false }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, kind: true, count: true, createdBy: true, createdAt: true, status: true, heartbeatAt: true },
    });
    // status: running (قيد الاستيراد) | interrupted (انقطع — ما سُجّل منه قابل للتراجع) | done
    const now = new Date();
    res.json({ success: true, data: batches.map(({ heartbeatAt, ...b }) => ({ ...b, status: importBatchState({ ...b, heartbeatAt }, now) })) });
  } catch (err) { next(err); }
});

// التراجع عن دفعة استيراد — يزيل سجلاتها بأمان ويعيد حساب الأرصدة
// العملاء/المنتجات (البندان 6ب و10): معاملة لكل سجل، المحمي والمرتبط يبقى ويُعاد {blocked, remaining} والدفعة reverted:false.
// الأرصدة/الأستاذ (البند 6أ): قفل gl-post أولاً فلا يتقاطع التراجع مع اعتماد التفعيل.
router.post('/batches/:id/revert', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const batch = await prisma.importBatch.findFirst({ where: { id: req.params.id, tenantId: tid, reverted: false } });
    if (!batch) { res.status(404).json({ success: false, message: 'الدفعة غير موجودة أو متراجع عنها' }); return; }
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
      const del = await prisma.customerPrice.deleteMany({ where: { id: { in: ids } } });
      removed = del.count;
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
