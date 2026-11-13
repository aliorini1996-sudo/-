/**
 * «ربط الدفاتر» L1 (١٣ نوفمبر ٢٠٢٦): ملء `WarehouseEntry.source` للحركات السابقة للعمود.
 *
 * `db push` يضيف العمود بافتراض 'MANUAL' لكل صفٍّ قائم، وحركتان منها ليستا يدويتين:
 *  - **OPENING_IMPORT**: وارد «استيراد المخزون الافتتاحي» — معرّفه في `ImportBatch.recordIds` لدفعات kind = 'opening_stock'
 *    (مصفوفة معرّفات الحركات؛ services/importLedger.ts). كان يُعرف بنصّ ملاحظته وحده، والدفاتر المربوطة تُدخله القيد الافتتاحي
 *    لا قيد شراء (P5 في فحص ما قبل الربط).
 *  - **STOCK_ZERO**: تسوية «تصفير المخزون» — `zeroRunId` غير فارغ.
 *
 * **آمنٌ للإعادة**: لا يلمس إلا صفاً ما زال 'MANUAL' (فلا يغيّر ما كتبه الكود الجديد ولا ما ملأه تشغيلٌ سابق)، ومعرّف الدفعة
 * يُطابَق بشركتها ونوع الوارد (RECEIVE) وحدهما — ودفعةٌ تُرُوجع عنها حُذفت حركتها فلا يطابقها شيء.
 * **تجريبي افتراضياً**: يعدّ ما سيتغيّر ولا يكتب؛ الكتابة بالعلَم --apply. لا يُشغَّل آلياً في النشر — يشغّله المالك بإذنه.
 *
 *   npx tsx scripts/backfillWarehouseEntrySource.ts            # معاينة: الأعداد فقط
 *   npx tsx scripts/backfillWarehouseEntrySource.ts --apply    # الكتابة
 *
 * ملاحظة: الكتابة بـupdateMany فيتحرّك `updatedAt` لهذه الحركات (طابع المزامنة) — صحيح: حقل source تغيّر فعلاً ويعود للمتكامل.
 */
import { OPENING_STOCK_ENTRY_TYPE, OPENING_STOCK_KIND, parseBatchRecordIds } from '../src/services/importLedger';
import type { WarehouseEntrySource } from '../src/services/suppliers/core';

/** حجم دفعة المعرّفات في كل استعلام (كتقطيع import.ts) */
export const ID_CHUNK = 1000;

const MANUAL: WarehouseEntrySource = 'MANUAL';
const OPENING_IMPORT: WarehouseEntrySource = 'OPENING_IMPORT';
const STOCK_ZERO: WarehouseEntrySource = 'STOCK_ZERO';

type Where = Record<string, unknown>;

/** أدنى شكل للعميل: PrismaClient والمزيّف في الاختبار */
export interface BackfillSourceDb {
  importBatch: { findMany(a: { where: { kind: string }; select: { tenantId: true; recordIds: true } }): Promise<Array<{ tenantId: string; recordIds: string }>> };
  warehouseEntry: {
    count(a: { where: Where }): Promise<number>;
    updateMany(a: { where: Where; data: { source: string } }): Promise<{ count: number }>;
  };
}

/** معرّفات حركات المخزون الافتتاحي لكل شركة من دفعاتها (بلا تكرار، والشكل التالف يُتجاهل كما يتجاهله parseBatchRecordIds) */
export function openingEntryIdsByTenant(batches: ReadonlyArray<{ tenantId: string; recordIds: string | null }>): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const b of batches) {
    const ids = parseBatchRecordIds(b.recordIds).records;
    if (!ids.length) continue;
    let s = out.get(b.tenantId);
    if (!s) { s = new Set(); out.set(b.tenantId, s); }
    for (const id of ids) s.add(id);
  }
  return new Map([...out].map(([t, s]) => [t, [...s]]));
}

/** شرط حركات الافتتاحي لدفعة معرّفات واحدة: من الشركة نفسها، وارد، وما زال يدوياً */
export const openingWhere = (tenantId: string, ids: readonly string[]): Where =>
  ({ tenantId, id: { in: [...ids] }, type: OPENING_STOCK_ENTRY_TYPE, source: MANUAL });

/** شرط تسويات التصفير: zeroRunId غير فارغ وما زالت يدوية */
export const stockZeroWhere = (): Where => ({ zeroRunId: { not: null }, source: MANUAL });

export interface BackfillSourceResult {
  apply: boolean;
  /** الحركات المطابقة (في المعاينة: ما سيتغيّر؛ وفي الكتابة: ما تغيّر فعلاً) */
  openingImport: number;
  stockZero: number;
  tenants: number;
}

export async function backfillWarehouseEntrySource(db: BackfillSourceDb, opts: { apply: boolean }): Promise<BackfillSourceResult> {
  const batches = await db.importBatch.findMany({ where: { kind: OPENING_STOCK_KIND }, select: { tenantId: true, recordIds: true } });
  const byTenant = openingEntryIdsByTenant(batches);
  let openingImport = 0;
  for (const [tenantId, ids] of byTenant) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const where = openingWhere(tenantId, ids.slice(i, i + ID_CHUNK));
      openingImport += opts.apply
        ? (await db.warehouseEntry.updateMany({ where, data: { source: OPENING_IMPORT } })).count
        : await db.warehouseEntry.count({ where });
    }
  }
  const zw = stockZeroWhere();
  const stockZero = opts.apply
    ? (await db.warehouseEntry.updateMany({ where: zw, data: { source: STOCK_ZERO } })).count
    : await db.warehouseEntry.count({ where: zw });
  return { apply: opts.apply, openingImport, stockZero, tenants: byTenant.size };
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  // الاتصال بالقاعدة عند التشغيل وحده — الاختبار يستورد الدوال أعلاه بلا عميل
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prisma = (require('../src/config/database') as { default: import('@prisma/client').PrismaClient }).default;
  try {
    const r = await backfillWarehouseEntrySource(prisma as unknown as BackfillSourceDb, { apply });
    const verb = apply ? 'updated' : 'would update (dry-run; pass --apply to write)';
    console.log(`backfillWarehouseEntrySource: OPENING_IMPORT ${verb}: ${r.openingImport} (tenants with opening batches: ${r.tenants})`);
    console.log(`backfillWarehouseEntrySource: STOCK_ZERO ${verb}: ${r.stockZero}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('backfillWarehouseEntrySource failed:', e); process.exitCode = 1; });
}
