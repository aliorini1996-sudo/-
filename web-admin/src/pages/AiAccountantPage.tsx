import { BrainCircuit } from 'lucide-react';
import { useTr } from '../i18n/strings';
import AiAccountantChat from '../components/aiAccountant/AiAccountantChat';

/**
 * «المحاسب الذكي AI» (/app/ai-accountant) — صفحة داخل حساب الشركة بمحادثة مبسّطة وقوالب طلبات جاهزة (قرار المالك).
 * ليست تحت /app/ledger: القراءة لكل شركة فعّلها لها المالك ولو بلا دفاتر، والترحيل لمن فعّلت دفاترها.
 * البوابات كلّها في الخادم (العلم والمحاسبة وصلاحية التقارير والنطاق) والمحادثة تعرض رفضه بإشعارٍ واضح؛
 * والمسار محروسٌ بـcanViewReports في App.tsx والرابط مخفيٌّ بلا العلم في القائمة الجانبية.
 */
export default function AiAccountantPage() {
  const tr = useTr();
  return (
    <div>
      <div className="page-header !mb-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-[#1F1A13] text-[#F4B49C] flex items-center justify-center shrink-0">
            <BrainCircuit size={20} />
          </span>
          <div>
            <h1 className="page-title">{tr('المحاسب الذكي')}</h1>
            <p className="text-xs text-gray-400 mt-0.5">{tr('اسأل عن أرقام شركتك واطلب التقارير وسجل المصروفات بالكلام')}</p>
          </div>
        </div>
      </div>
      <AiAccountantChat />
    </div>
  );
}
