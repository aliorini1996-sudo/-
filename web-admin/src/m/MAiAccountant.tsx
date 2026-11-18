import { useTr } from '../i18n/strings';
import { MHeader } from './mobileUi';
import AiAccountantChat from '../components/aiAccountant/AiAccountantChat';

/**
 * «المحاسب الذكي AI» على الجوال (/m) — قسمٌ من الرئيسية بجانب «الموردون» (قرار المالك)، صفحةٌ كاملة فوق الشريطين
 * بترويستها وزرّ رجوعها كبقيّة الأقسام. المحادثة نفسها التي في الويب (`compact`: ملء الارتفاع وحشوٌ أصغر)، بالـAPI نفسه
 * وبطاقات التقرير والقيد نفسها — فلا نسخة جوّالية تنحرف عنها.
 *
 * الجسم لا يُمرَّر هنا (لا MScreen): المحادثة تمرّر رسائلها وحدها وتثبّت مدخلها أسفلها، وتمريرٌ ثانٍ حولها يُزيح المدخل
 * عن موضعه. والبوّابات كلّها في الخادم (العلم والمحاسبة وصلاحية التقارير والنطاق)؛ القوقعة لا تُظهر البلاطة إلا بها.
 */
export default function MAiAccountant({ onBack }: { onBack: () => void }) {
  const tr = useTr();
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('المحاسب الذكي')} subtitle={tr('اسأل عن أرقام شركتك واطلب التقارير وسجل المصروفات بالكلام')} onBack={onBack} />
      <div className="flex-1 min-h-0 flex flex-col">
        <AiAccountantChat compact />
      </div>
    </div>
  );
}
