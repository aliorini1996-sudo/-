/**
 * «سجلّ العميل» الثابت (أمر المالك ٢٦ نوفمبر ٢٠٢٦): يثبّت مُطلِق القاعدة الذي يرفض تعديل أسطر customer_activities وحذفها
 * (services/customerActivityGuard.ts). يجري في preDeploy بعد `prisma db push` وقبل أن تخدم النسخة الجديدة — فلا تخدم نسخةٌ
 * تكتب السجلّ وحارسه غائب. آمنٌ للتكرار. فشله يُفشل النشر (exitCode 1) والنسخة القائمة تواصل الخدمة؛ والإقلاع يعيد المحاولة.
 */
import prisma from '../config/database';
import { ensureCustomerActivityGuard } from '../services/customerActivityGuard';

async function main(): Promise<void> {
  const ok = await ensureCustomerActivityGuard(prisma);
  if (!ok) {
    console.error('ensureCustomerActivityGuard: guard NOT active');
    process.exitCode = 1;
    return;
  }
  console.log('ensureCustomerActivityGuard: customer_activities is append-only (update/delete/truncate triggers active)');
}

main()
  .catch((e) => { console.error('ensureCustomerActivityGuard failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
