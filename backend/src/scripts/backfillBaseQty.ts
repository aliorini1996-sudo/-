/**
 * ترحيل الوحدات المتعددة: `baseQty` عمودٌ مشتقّ تحرسه القاعدة نفسها.
 *
 * يجري في preDeploy بعد `prisma db push` وقبل أن تخدم النسخة الجديدة.
 *
 * ═══ لماذا مُطلِقٌ (trigger) لا ملءٌ مرّةً واحدة ═══
 * أثناء النشر تبقى النسخة **القديمة** تخدم دقائق بعد الترحيل، وتكتب صفوفاً لا
 * تعرف `baseQty` فتبقى فارغة — وتجميعة `_sum.baseQty` تتجاهل الفارغ فيسقط
 * مبيعها من المخزون بصمت. ومسارات التعديل (تعديل كمية فاتورة أو تحميل أو طلب)
 * تغيّر `qty` دون `baseQty` فيبقى قديماً. والمُطلِق يحسبه عند **كلّ** إدراجٍ
 * وتحديث مهما كان الكاتب: النسخة القديمة، والتعديل، وتحويل وحدة الصنف الذي
 * يضرب `unitFactor` جماعياً. فيصير مشتقّاً لا يُنسى ولا يتقادم.
 *
 * (Prisma 5 لا يدعم الأعمدة المولَّدة GENERATED في db push، والمُطلِق لا
 * يراه db push فلا يحذفه.)
 *
 * **آمنٌ للتكرار**: CREATE OR REPLACE للدالّة، والمُطلِق يُحذف ويُعاد، والملء
 * لا يلمس إلّا `WHERE "baseQty" IS NULL` على دفعات.
 *
 * والكود لا يعتمد عليه للصحّة الآنية: `baseQtyOf` يحسب من اللقطة حين يجد null.
 */
import prisma from '../config/database';

const TABLES = ['invoice_items', 'van_load_items', 'warehouse_entry_items', 'rep_stock_request_items'] as const;
const BATCH = 20000;

const FN = `
CREATE OR REPLACE FUNCTION fs_set_base_qty() RETURNS trigger AS $$
BEGIN
  NEW."baseQty" := NEW."qty" * COALESCE(NULLIF(NEW."unitFactor", 0), 1);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;

async function installTrigger(table: typeof TABLES[number]): Promise<void> {
  const trg = `fs_base_qty_${table}`;
  // الجدول من قائمةٍ ثابتة أعلاه لا من مُدخل — $executeRawUnsafe آمنٌ هنا
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trg}" ON "${table}"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER "${trg}" BEFORE INSERT OR UPDATE OF "qty", "unitFactor", "baseQty" ON "${table}"
     FOR EACH ROW EXECUTE FUNCTION fs_set_base_qty()`,
  );
}

async function backfill(table: typeof TABLES[number]): Promise<number> {
  let total = 0;
  for (;;) {
    // التحديث يُطلق المُطلِق فيحسب baseQty — والقيمة الصريحة هنا للوضوح لا للحاجة
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "baseQty" = "qty" * COALESCE(NULLIF("unitFactor", 0), 1)
       WHERE id IN (SELECT id FROM "${table}" WHERE "baseQty" IS NULL LIMIT ${BATCH})`,
    );
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(FN);
  for (const t of TABLES) {
    await installTrigger(t);
    const n = await backfill(t);
    console.log(`backfillBaseQty: ${t} — trigger ok, ${n} rows filled`);
  }
}

main()
  .catch((e) => { console.error('backfillBaseQty failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
