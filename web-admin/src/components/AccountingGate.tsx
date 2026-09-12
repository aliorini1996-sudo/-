import { useQuery } from '@tanstack/react-query';
import { companyApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { Lock } from 'lucide-react';

/**
 * بوّابة «النظام المحاسبي» للوحة الويب — مصدر حقيقة واحد لدلالة العَلَم.
 *
 * `accountingEnabled` **مفعّل افتراضياً**، فالشرط `!== false` لا `=== true`:
 * غيابه من ردٍّ قديم أو من كاشٍ محفوظ يعني «مفعّل». وقلبُ الشرط يُخفي المال عن
 * كل شركةٍ تعذّرت قراءة إعداداتها — وهو أسوأ من التسريب.
 *
 * `ready` تفصل «لم نقرأ الإعداد بعد» عن «قرأناه». تُستعمل لتأجيل **إطلاق**
 * الاستعلامات المالية وحدها: فلا يُرسَل طلبٌ سيردّه الخادم ٤٠٣ ثم تظهر لافتة
 * «تعذر التحميل» — واللافتة نفسها تسريبٌ للمعنى (تُخبر المستخدم أنّ ثمّة أرقاماً
 * حُجبت عنه). وهي تعتمد `isLoading` لا `isPending`: عند انقطاع الشبكة يوقف
 * React Query المحاولة (fetchStatus='paused') فيبقى `isPending` صادقاً للأبد،
 * ولو انتظرناه لتجمّدت الصفحات المالية عند كل الشركات.
 */
export function useAccountingOn(): { on: boolean; ready: boolean } {
  const q = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { accountingEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  return { on: q.data?.accountingEnabled !== false, ready: !q.isLoading };
}

/**
 * ما يراه من بلغ صفحةً مالية بالمسار المباشر بعد إخفائها من القائمة:
 * رسالةٌ صريحة لا جدولٌ فارغ ولا لافتة خطأ.
 */
export function AccountingOffNotice() {
  const tr = useTr();
  return (
    <div className="card max-w-xl mx-auto text-center py-10">
      <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
        <Lock size={22} />
      </div>
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('البيانات المالية غير متاحة')}</h1>
      <p className="text-sm text-gray-500 mt-1.5">{tr('النظام المحاسبي غير مفعل لشركتك')}</p>
      <p className="text-xs text-[#9A8F7E] mt-2 leading-relaxed max-w-md mx-auto">
        {tr('النظام المحاسبي يشمل المنتجات ومخزون السيارات ومخزون الشركة والفواتير وسندات القبض')}
      </p>
    </div>
  );
}
