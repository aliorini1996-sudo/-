/**
 * «سجلّ العميل لا يمكن لاحد تغيير اي شيء فيه نهائيا» (أمر المالك ٢٦ نوفمبر ٢٠٢٦) — الحارس في القاعدة نفسها لا في الكود وحده:
 *
 *  • مُطلِقٌ لكل صفّ BEFORE UPDATE OR DELETE على customer_activities يرفض **كل تعديل** دائماً، ويرفض **كل حذف** إلا داخل
 *    معاملةٍ ضبطت `fs.activity_purge = on` محلياً (allowActivityPurge) — وهي حذف الشركة كلها (routes/tenants.ts): تعاقب
 *    حذف صفّ الشركة يمرّ بالمُطلِق فيلزمه الإذن، والإذن يموت بانتهاء المعاملة (set_config المحلي)؛ وحذف العميل (قرار المالك
 *    ٢٧ نوفمبر ٢٠٢٦: «بعد حذف العميل يحذف سجله معه» — services/ownerPurge.ts purgeInTx وroutes/import.ts): أسطره هو وحده.
 *  • ومُطلِقٌ للعبارة BEFORE TRUNCATE يرفض التفريغ دائماً (TRUNCATE لا يمرّ بمُطلِقات الصفوف).
 *
 * التثبيت آمنٌ للتكرار: CREATE OR REPLACE للدالّة، والمُطلِق يُنشأ إن غاب أو عُطّل (بلا لحظةٍ يغيب فيها الحارس — لا حذف ثم
 * إنشاء لمُطلِقٍ قائم). يجري في preDeploy بعد `prisma db push` (scripts/ensureCustomerActivityGuard.ts) وعند كل إقلاع
 * (index.ts، بلا انتظار) — وdb push لا يرى المُطلِقات فلا يحذفها. لا يرمي أبداً: الفشل يُسجَّل ويُعاد false.
 */

/** اسم إعداد الجلسة المحلي الذي يأذن بالحذف داخل معاملة حذف الشركة */
export const ACTIVITY_PURGE_SETTING = 'fs.activity_purge';

export const ACTIVITY_GUARD_FUNCTION = 'fs_customer_activity_immutable';
export const ACTIVITY_ROW_TRIGGER = 'fs_customer_activity_immutable';
export const ACTIVITY_TRUNCATE_TRIGGER = 'fs_customer_activity_no_truncate';

/** دالّة الحارس: التعديل مرفوضٌ دائماً، والحذف مرفوضٌ إلا بإذن المعاملة، والتفريغ مرفوضٌ دائماً */
export const ACTIVITY_GUARD_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION ${ACTIVITY_GUARD_FUNCTION}() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('${ACTIVITY_PURGE_SETTING}', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'customer_activities is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'سجل العميل ثابت لا يعدل ولا يحذف';
END;
$$ LANGUAGE plpgsql;`;

/**
 * المُطلِقان — يُنشأ كلٌّ منهما إن غاب، ويُعاد إن وُجد غير نافذ (tgenabled غير O/A: معطَّلٌ D أو للنسخ المتماثل وحده R).
 * الجدول الغائب (قبل db push) يُتخطّى بإشعار فلا يفشل الإقلاع، ويُثبَّت في الإقلاع أو النشر التالي.
 */
export const ACTIVITY_GUARD_TRIGGERS_SQL = `
DO $$
DECLARE
  rel regclass := to_regclass('customer_activities');
  st "char";
BEGIN
  IF rel IS NULL THEN
    RAISE NOTICE 'customer_activities missing - guard skipped';
    RETURN;
  END IF;
  st := NULL;
  SELECT tgenabled INTO st FROM pg_trigger WHERE tgrelid = rel AND tgname = '${ACTIVITY_ROW_TRIGGER}';
  IF st IS NOT NULL AND st NOT IN ('O', 'A') THEN
    EXECUTE 'DROP TRIGGER ${ACTIVITY_ROW_TRIGGER} ON customer_activities';
    st := NULL;
  END IF;
  IF st IS NULL THEN
    EXECUTE 'CREATE TRIGGER ${ACTIVITY_ROW_TRIGGER} BEFORE UPDATE OR DELETE ON customer_activities FOR EACH ROW EXECUTE FUNCTION ${ACTIVITY_GUARD_FUNCTION}()';
  END IF;
  st := NULL;
  SELECT tgenabled INTO st FROM pg_trigger WHERE tgrelid = rel AND tgname = '${ACTIVITY_TRUNCATE_TRIGGER}';
  IF st IS NOT NULL AND st NOT IN ('O', 'A') THEN
    EXECUTE 'DROP TRIGGER ${ACTIVITY_TRUNCATE_TRIGGER} ON customer_activities';
    st := NULL;
  END IF;
  IF st IS NULL THEN
    EXECUTE 'CREATE TRIGGER ${ACTIVITY_TRUNCATE_TRIGGER} BEFORE TRUNCATE ON customer_activities FOR EACH STATEMENT EXECUTE FUNCTION ${ACTIVITY_GUARD_FUNCTION}()';
  END IF;
END $$;`;

/** فحصٌ بعد التثبيت: المُطلِقان قائمان نافذان */
export const ACTIVITY_GUARD_CHECK_SQL = `
SELECT count(*)::int AS n FROM pg_trigger
WHERE tgrelid = to_regclass('customer_activities')
  AND tgname IN ('${ACTIVITY_ROW_TRIGGER}', '${ACTIVITY_TRUNCATE_TRIGGER}')
  AND tgenabled IN ('O', 'A')`;

interface GuardDb {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
}

/**
 * يثبّت حارس الثبات ويتحقّق منه — true متى كان المُطلِقان قائمَين مفعّلَين بعده. لا يرمي أبداً (الفشل يُسجَّل ويُعاد false)
 */
export async function ensureCustomerActivityGuard(db: GuardDb): Promise<boolean> {
  try {
    await db.$executeRawUnsafe(ACTIVITY_GUARD_FUNCTION_SQL);
    await db.$executeRawUnsafe(ACTIVITY_GUARD_TRIGGERS_SQL);
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(ACTIVITY_GUARD_CHECK_SQL);
    const ok = Number(rows?.[0]?.n ?? 0) === 2;
    if (!ok) console.error('[customer-activity] guard not active (table missing?) — will retry on next boot/deploy');
    return ok;
  } catch (e) {
    console.error('[customer-activity] guard install failed:', (e as Error)?.message ?? e);
    return false;
  }
}

/**
 * إذن حذف أسطر السجلّ داخل المعاملة الحالية وحدها — **لحذف الشركة كلها** (routes/tenants.ts: تعاقب حذف صفّ الشركة يحذف
 * أسطرها فيمرّ بالمُطلِق) **ولحذف العميل** (قرار المالك ٢٧ نوفمبر ٢٠٢٦: سجلّه يُحذف معه — services/ownerPurge.ts وroutes/import.ts).
 * محليٌّ للمعاملة (set_config(..., true)) فيموت بالتزامها أو تراجعها. لا يأذن بالتعديل أبداً.
 */
export async function allowActivityPurge(tx: { $queryRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> }): Promise<void> {
  // نصٌّ ثابت بلا مُدخل — والإعداد نفسه ACTIVITY_PURGE_SETTING
  await tx.$queryRaw`SELECT set_config('fs.activity_purge', 'on', true)`;
}
