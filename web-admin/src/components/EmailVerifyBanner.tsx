import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useLang } from '../i18n/lang';

// لافتة «تأكيد البريد مطلوب» — تظهر لأدمن الشركة غير المؤكَّد بريده (دخول فوري + تذكير غير مانع)
export default function EmailVerifyBanner() {
  const { user, impersonating } = useAuthStore();
  const lang = useLang((s) => s.lang);
  const [sending, setSending] = useState(false);

  const isCompanyAdmin = user && ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(user.role);
  // يظهر فقط عند تأكيد صريح بعدم التحقق، وليس أثناء تصفّح المالك لشركة
  if (impersonating || !isCompanyAdmin || user?.emailVerified !== false) return null;

  const t = {
    text: lang === 'en' ? 'Please verify your email — check your inbox for the confirmation link.' : 'يرجى تأكيد بريدك الإلكتروني — تحقّق من صندوق بريدك للرابط.',
    resend: lang === 'en' ? 'Resend' : 'إعادة الإرسال',
    sent: lang === 'en' ? 'Verification email sent' : 'تم إرسال رابط التأكيد',
    fail: lang === 'en' ? 'Could not send, try again' : 'تعذّر الإرسال، حاول مجدداً',
    already: lang === 'en' ? 'Email already verified' : 'البريد مؤكَّد بالفعل',
  };

  const resend = async () => {
    setSending(true);
    try {
      const r = await authApi.resendVerification();
      if (r.data?.data?.alreadyVerified) toast.success(t.already);
      else toast.success(t.sent);
    } catch { toast.error(t.fail); }
    setSending(false);
  };

  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-800 px-4 py-2 flex items-center justify-between gap-3 text-sm flex-shrink-0">
      <span className="flex items-center gap-2 font-medium"><MailWarning size={16} /> {t.text}</span>
      <button onClick={resend} disabled={sending}
        className="shrink-0 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white rounded-lg px-3 py-1 font-semibold flex items-center gap-1.5">
        {sending && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
        {t.resend}
      </button>
    </div>
  );
}
