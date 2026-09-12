import { DocumentResult, statementDocFromData, Company } from '../rep/RepDocuments';
import { AccountEntry, Customer } from '../types';

/**
 * كشف حساب العميل مستنداً — غلاف كسول حول عارض المستندات، كـ`MSettlementDoc`.
 *
 * **الكسل مقصود لا تجميل:** `RepDocuments` تستورد `jspdf` و`html2canvas`
 * و`qrcode` استيراداً ثابتاً. ولولا عزلها في حزمة مستقلّة لدخلت كلّها في حزمة
 * تبويب العملاء، فيدفع ثمنها من فتح قائمة العملاء ولم يُصدّر كشفاً قطّ.
 *
 * والمستند يُبنى من الصفوف التي في اليد لا بطلبٍ جديد: شاشة الكشف جلبتها
 * بمدّتها، وطلبُ الخادم ثانيةً يعطي **مدّةً أخرى** — كشفاً مطبوعاً يخالف ما
 * على الشاشة. وهو نفس ما تفعله اللوحة (`CustomersPage.tsx`) بالدالّة نفسها.
 */
export default function MStatementDoc({ customer, entries, repName, company, range, onClose }: {
  customer: Customer;
  entries: AccountEntry[];
  /** اسم من أصدر الكشف — يظهر في ترويسة المستند */
  repName: string;
  /** إعدادات الشركة للترويسة — `null` يعطي مستنداً بلا اسمٍ ولا رقمٍ ضريبيّ */
  company: unknown;
  /**
   * المدّة المعروضة على الشاشة **وطرفا رصيدها**، كما حسبهما الخادم.
   *
   * الثلاثة تُمرَّر معاً لا المدّة وحدها: ورقةٌ تحمل حدود المدّة وتحسب رصيدها
   * من لقطةٍ لكلّ الزمن تكذب بأصدق عنوان. وبها تطابق الورقةُ الشاشةَ رقماً
   * برقم — وهي تُسلَّم للعميل.
   */
  range?: { from?: string; to?: string; openingBalance?: number; closingBalance?: number };
  onClose: () => void;
}) {
  return (
    <DocumentResult
      doc={statementDocFromData(customer, entries, repName, (company as Company | null) ?? null, range)}
      onClose={onClose}
    />
  );
}
