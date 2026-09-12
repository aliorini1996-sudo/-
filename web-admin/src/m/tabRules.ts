import { PermKey } from './perms';

/**
 * قاعدة مقاعد الشريط السفليّ في تطبيق الإدارة — دالّة نقيّة تُختبَر وحدها.
 *
 * لماذا خرجت من المكوّن: الشريط **خمسة مقاعد** وستّة مرشَّحين، فالقاعدة تختار
 * لا تعرض. وكانت مدفونةً داخل `useMemo` لا يبلغها اختبار، فحارسها الوحيد كان
 * يعدّ سطور التعريف في المصفوفة — أي أنّه يحرس نصّاً لا سلوكاً، ويمرّ على أيّ
 * خطأ في الشرط نفسه. وهي هنا تُشغَّل على كلّ تباديل الصلاحيات والمفتاحين.
 *
 * والخاصّية التي تحرسها الاختبارات ليست العدد وحده، بل: **كلّ صلاحيةٍ ممنوحة
 * لها طريق**. صلاحيةٌ يمنحها المالك ولا يبلغها صاحبه عيبٌ صامت: لا رسالة ولا
 * خطأ، فقط رجلٌ يقول «لا أجدها» ومالكٌ يقول «قد منحتُك إيّاها».
 */

export type TabId = 'home' | 'invoices' | 'receipts' | 'dailyReports' | 'customers' | 'tracking';

/** سقف الشريط على عرض ٣٦٠px — سادسٌ يُلاصق الأيقونات حتى تتداخل */
export const MAX_SEATS = 5;

export interface TabFlags {
  /** «النظام المحاسبي» — مفعّل افتراضياً */
  accountingOn: boolean;
  /** «التقرير اليومي» — ميزة اشتراك مطفأة افتراضياً */
  dailyReportOn: boolean;
}

/**
 * يختار مقاعد الشريط لهذا المستخدم.
 *
 * `allowed` تُمرَّر دالّةً لا كائنَ مستخدم: القاعدة لا تعنيها هيئة المستخدم،
 * واختبارُها بمجموعةٍ من المفاتيح أصدق من بناء كائنٍ بعشرين حقلاً.
 */
export function visibleTabs<T extends { id: TabId; perm: PermKey }>(
  tabs: readonly T[],
  allowed: (perm: PermKey) => boolean,
  flags: TabFlags,
): T[] {
  const { accountingOn, dailyReportOn } = flags;

  /* مقعد الفواتير شرطٌ في قاعدة التحصيل أدناه، فيُحسب أوّلاً بالقاعدتين
   * اللتين تحكمانه وحدهما: صلاحيته، والنظام المحاسبيّ. */
  const invoicesSeat = allowed('canManageInvoices') && accountingOn;

  return tabs.filter(t => {
    if (!allowed(t.perm)) return false;

    // التقارير اليومية ميزة اشتراك: تظهر بالمفتاح وتغيب بغيابه
    if (t.id === 'dailyReports') return dailyReportOn;

    /* والتقارير اليومية تأخذ مقعد «التحصيل» — **بشرط أن يبقى للتحصيل طريق**،
     * وطريقه زرُّ التحويل في أعلى شاشة الفواتير. فمن لا مقعد لفواتيره لا بديل
     * عنده: يبقى مقعد تحصيله، وإلّا صارت صلاحيةٌ ممنوحةٌ لا تُبلغ من أيّ باب.
     *
     * والعدد لا يتجاوز الخمسة في الحالين: إن بقي التحصيل فمقعد الفواتير شاغر،
     * وإن سقط فمقعد التقارير يملؤه. (يُثبته الاختبار على كل التباديل.) */
    if (t.id === 'receipts' && dailyReportOn && invoicesSeat) return false;

    // المستندات كلّها مالٌ صراح: تسقط مع النظام المحاسبي
    if (!accountingOn && (t.id === 'invoices' || t.id === 'receipts')) return false;

    return true;
  });
}

/**
 * هل تُبلَغ شاشة السندات؟ وبأيّ طريق؟
 *
 * تُستعمل في الاختبار حارساً على الخاصّية، وفي المكوّن لا تُستعمل — هناك
 * يكفي `!tabs.some(...)`. وهي هنا لأنّ اسمها يقول ما يجب أن يبقى صحيحاً.
 */
export function receiptsRoute<T extends { id: TabId; perm: PermKey }>(
  tabs: readonly T[],
  allowed: (perm: PermKey) => boolean,
  flags: TabFlags,
): 'seat' | 'switch' | 'none' {
  const shown = visibleTabs(tabs, allowed, flags).map(t => t.id);
  if (shown.includes('receipts')) return 'seat';
  // الزرّ يسكن شاشة الفواتير، فلا يوجد إلّا بوجود مقعدها
  if (shown.includes('invoices') && allowed('canManageReceipts') && flags.accountingOn) return 'switch';
  return 'none';
}
