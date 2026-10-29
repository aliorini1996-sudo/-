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
 *
 * ومعه ملء حدود الشرائح بالأساس (`PriceTier.baseMinQty/baseMaxQty`) من حدودها القديمة — `backfillPriceTiers` أدناه.
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

/**
 * حدود الشرائح بالأساس (القاعدة ٥): `db push` يضيف `baseMinQty` بافتراض ٠ و`baseMaxQty` فارغاً، والشريحة القائمة
 * حدودها بوحدة الصنف — وهي الأساس قبل أيّ تحويل، فتُنسخ كما هي.
 *
 * **آمنٌ للتكرار**: لا يلمس إلّا ما لم يُملأ. `baseMinQty = 0` مع `minQty ≠ 0` لا يقع لشريحةٍ كُتبت بعد الميزة (تكتب
 * العمودين) ولا لشريحةٍ حُوّل صنفها (التحويل يضرب الحدّ بـF من القديم إن وجده فارغاً)؛ والشريحة التي تبدأ من صفر
 * صفرُها صحيح. و`baseMaxQty` الفارغ مع `maxQty` قائم لم يُملأ قطّ — والفارغان معاً شريحةٌ بلا سقف تبقى كذلك.
 * (النسخة القديمة أثناء النشر قد تكتب شرائح بالعمودين القديمين وحدهما: يملؤها النشر التالي، والحارس السعري
 * في الإصدار لا يقرأ الحدود.)
 */
async function backfillPriceTiers(): Promise<{ min: number; max: number }> {
  const min = await prisma.$executeRawUnsafe(
    `UPDATE "price_tiers" SET "baseMinQty" = "minQty" WHERE "baseMinQty" = 0 AND "minQty" <> 0`,
  );
  const max = await prisma.$executeRawUnsafe(
    `UPDATE "price_tiers" SET "baseMaxQty" = "maxQty" WHERE "baseMaxQty" IS NULL AND "maxQty" IS NOT NULL`,
  );
  return { min, max };
}

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(FN);
  for (const t of TABLES) {
    await installTrigger(t);
    const n = await backfill(t);
    console.log(`backfillBaseQty: ${t} — trigger ok, ${n} rows filled`);
  }
  const tiers = await backfillPriceTiers();
  console.log(`backfillBaseQty: price_tiers — ${tiers.min} min / ${tiers.max} max bounds filled`);
}

main()
  .catch((e) => { console.error('backfillBaseQty failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
