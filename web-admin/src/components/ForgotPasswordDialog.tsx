import { LifeBuoy, X, UserCog, Building2 } from 'lucide-react';

interface Props {
  role: 'admin' | 'rep'; // أدمن شركة أم مندوب
  onClose: () => void;
}

// نافذة إرشادية لاستعادة كلمة المرور — آلية هرمية (لا تعتمد على البريد بعد)
//  • المندوب  → يتواصل مع مدير شركته ليعيد تعيينها
//  • الأدمن   → يتواصل مع مزوّد الخدمة (مالك المنصّة) ليعيد تعيينها
export default function ForgotPasswordDialog({ role, onClose }: Props) {
  const isRep = role === 'rep';
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-3">
            <LifeBuoy size={28} className="text-[#E15A30]" />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13]">استعادة كلمة المرور</h2>
          <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">
            {isRep
              ? 'لأمان حسابك، إعادة تعيين كلمة المرور تتم عبر مدير شركتك.'
              : 'لأمان حسابك، إعادة تعيين كلمة المرور تتم عبر مزوّد الخدمة (مالك المنصّة).'}
          </p>
        </div>

        <div className="px-6 pb-2">
          <div className="bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl p-4 flex items-start gap-3 text-right">
            <div className="w-9 h-9 rounded-lg bg-[#FBEBE2] flex items-center justify-center shrink-0">
              {isRep ? <UserCog size={18} className="text-[#E15A30]" /> : <Building2 size={18} className="text-[#E15A30]" />}
            </div>
            <div>
              <p className="text-sm font-semibold text-[#1F1A13]">
                {isRep ? 'تواصل مع مدير شركتك' : 'تواصل مع مزوّد الخدمة'}
              </p>
              <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">
                {isRep
                  ? 'اطلب منه فتح صفحة «المناديب» ← زر المفتاح بجانب اسمك ← «إعادة تعيين كلمة المرور»، وسيسلّمك كلمة مرور جديدة.'
                  : 'اطلب منه فتح لوحة المالك ← زر المفتاح بجانب شركتك ← «إعادة تعيين كلمة المرور»، وسيسلّمك كلمة مرور جديدة.'}
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 pt-4">
          <button onClick={onClose} className="btn-primary w-full justify-center py-2.5">حسناً، فهمت</button>
        </div>
      </div>
    </div>
  );
}
