import { AlertCircle, MailCheck } from 'lucide-react';
import { useTr } from '../i18n/strings';
import type { LoginError } from '../lib/loginErrors';

/**
 * مربّع رفض الدخول تحت النموذج (طلب المالك ٢١ نوفمبر ٢٠٢٦): رسالة الخادم الدقيقة مترجمةً، ومعها الفعل المناسب —
 * «نسيت كلمة المرور؟» · رابط تطبيق المندوب · رابط صفحة الشركة · «افحص بريدك». المنطق في lib/loginErrors.ts.
 * `fallback`: نصٌّ يُعرض حين لا رسالة من الخادم (ردٌّ بلا نصّ)، والانقطاع له رسالته.
 */
export default function LoginErrorBox({ error, fallback, onForgot }: { error: LoginError; fallback: string; onForgot?: () => void }) {
  const tr = useTr();
  const text = error.offline
    ? tr('تعذر الاتصال بالخادم — تحقق من الإنترنت ثم حاول مجددا')
    : error.message ? tr(error.message) : fallback;
  const link = 'inline-flex items-center gap-1 font-bold text-[#E15A30] hover:underline';
  return (
    <div role="alert" data-login-error={error.code ?? ''}
      className="mt-3 rounded-xl border border-[#F3C9BC] bg-[#FDF1EC] px-3 py-2.5 text-[13px] leading-relaxed text-[#8A2E14]">
      <p className="flex items-start gap-2">
        <AlertCircle size={16} className="shrink-0 mt-0.5 text-[#C0392B]" />
        <span>{text}</span>
      </p>
      {error.action === 'forgot' && onForgot && (
        <button type="button" onClick={onForgot} className={`${link} mt-1.5 ms-6`}>{tr('نسيت كلمة المرور؟')}</button>
      )}
      {error.action === 'repApp' && (
        <a href="/rep" className={`${link} mt-1.5 ms-6`}>{tr('افتح تطبيق المندوب')}</a>
      )}
      {error.action === 'adminLogin' && (
        <a href="/login" className={`${link} mt-1.5 ms-6`}>{tr('افتح صفحة دخول الشركة')}</a>
      )}
      {error.action === 'checkEmail' && (
        <p className="flex items-start gap-1.5 mt-1.5 ms-6 text-[12px] text-[#6E6557]">
          <MailCheck size={14} className="shrink-0 mt-0.5" />
          <span>{tr('ابحث في صندوق الوارد والرسائل غير المرغوبة عن رسالة «فعّل حساب شركتك»')}</span>
        </p>
      )}
    </div>
  );
}
