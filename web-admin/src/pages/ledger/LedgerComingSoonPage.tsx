import { Landmark } from 'lucide-react';
import { useTr } from '../../i18n/strings';

/** صفحة الدفاتر في M0 — «قيد الإعداد» فقط؛ الهيكل والصلاحيات قائمة والوحدات تصل تباعاً. */
export default function LedgerComingSoonPage() {
  const tr = useTr();
  return (
    <div className="card max-w-xl mx-auto text-center py-10">
      <div className="w-12 h-12 rounded-2xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center mx-auto mb-3">
        <Landmark size={22} />
      </div>
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('النظام المحاسبي المتكامل')}</h1>
      <p className="text-sm text-gray-500 mt-1.5">{tr('قيد الإعداد')}</p>
      <p className="text-xs text-[#9A8F7E] mt-2 leading-relaxed max-w-md mx-auto">
        {tr('شجرة الحسابات والقيود اليومية والقوائم المالية تصل قريبا لشركتك')}
      </p>
    </div>
  );
}
