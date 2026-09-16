import { useQuery } from '@tanstack/react-query';
import { companyApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { Landmark } from 'lucide-react';

/**
 * بوّابة «النظام المحاسبي المتكامل» (الدفاتر) — مصدر حقيقة واحد لدلالة العَلَم.
 *
 * `accountingSuiteEnabled` **مطفأ افتراضياً** ⇒ `=== true`؛ ومعه `accountingEnabled !== false`
 * لأن ذاك مفعّل افتراضياً. اسم المتغير في الصفحات `ledgerOn` — **لا اسم متغير المحاسبة القائم**
 * لأن اختبارات العدّ في `accounting-gate.test.ts` تحرسه.
 *
 * `ready` على `isLoading` لا `isPending` (انظر AccountingGate): انقطاع الشبكة يُبقي
 * `isPending` صادقاً فتتجمّد الصفحة.
 */
export function useLedgerOn(): { on: boolean; ready: boolean } {
  const q = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { accountingSuiteEnabled?: boolean; accountingEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  const company = q.data;
  return { on: company?.accountingSuiteEnabled === true && company?.accountingEnabled !== false, ready: !q.isLoading };
}

/** ما يراه من بلغ صفحة دفاتر بالمسار المباشر والميزة مطفأة: رسالة صريحة لا جدول فارغ. */
export function LedgerOffNotice() {
  const tr = useTr();
  return (
    <div className="card max-w-xl mx-auto text-center py-10">
      <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
        <Landmark size={22} />
      </div>
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('الدفاتر غير متاحة')}</h1>
      <p className="text-sm text-gray-500 mt-1.5">{tr('النظام المحاسبي المتكامل غير مفعل لشركتك')}</p>
    </div>
  );
}
