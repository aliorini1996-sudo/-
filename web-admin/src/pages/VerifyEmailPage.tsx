import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import { CheckCircle2, XCircle, ArrowLeft } from 'lucide-react';
import { useDir } from '../i18n/lang';
import { useTr } from '../i18n/strings';

type State = 'loading' | 'ok' | 'fail';

// صفحة تأكيد البريد الإلكتروني — تُستدعى من رابط البريد /verify-email?token=
export default function VerifyEmailPage() {
  const dir = useDir();
  const tr = useTr();
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setState('fail'); return; }
    authApi.verifyEmail(token).then(() => setState('ok')).catch(() => setState('fail'));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] p-6" dir={dir} style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <div className="w-full max-w-md bg-white rounded-2xl border border-[#E9E1D3] shadow-sm p-8 text-center">
        <div className="inline-flex mb-5"><BrandIcon size={64} radius={0.26} /></div>

        {state === 'loading' && (
          <>
            <div className="w-10 h-10 border-3 border-[#E15A30]/30 border-t-[#E15A30] rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[#6E6557]">{tr('جارٍ تأكيد بريدك…')}</p>
          </>
        )}

        {state === 'ok' && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4"><CheckCircle2 size={34} className="text-green-600" /></div>
            <h1 className="text-xl font-bold text-[#1F1A13]">{tr('تم تأكيد بريدك الإلكتروني')} ✅</h1>
            <p className="text-[#6E6557] text-sm mt-2">{tr('شكراً لك. حسابك مفعّل بالكامل الآن.')}</p>
            <Link to="/app" className="btn-primary mx-auto mt-6 inline-flex">{tr('الذهاب للوحة التحكم')} <ArrowLeft size={16} className={dir === 'rtl' ? '' : 'rotate-180'} /></Link>
          </>
        )}

        {state === 'fail' && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center mx-auto mb-4"><XCircle size={34} className="text-red-600" /></div>
            <h1 className="text-xl font-bold text-[#1F1A13]">{tr('رابط التأكيد غير صالح')}</h1>
            <p className="text-[#6E6557] text-sm mt-2">{tr('انتهت صلاحية الرابط أو أنه غير صحيح. سجّل الدخول واطلب إعادة إرسال رابط التأكيد.')}</p>
            <Link to="/login" className="btn-primary mx-auto mt-6 inline-flex">{tr('تسجيل الدخول')}</Link>
          </>
        )}
      </div>
    </div>
  );
}
