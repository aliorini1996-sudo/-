import { useState, type FormEvent, type ReactNode } from 'react';
import { LifeBuoy, X, UserCog, Mail, Phone, CheckCircle2, MessageCircle, ArrowRight } from 'lucide-react';
import { authApi } from '../api/client';
import { backdropClose } from '../lib/backdropClose';
import { useTr } from '../i18n/strings';
import { useDir } from '../i18n/lang';
import { looksLikeEmail, looksLikePhone } from '../lib/loginErrors';
import { supportWhatsappUrl } from '../lib/supportContact';

interface Props {
  role: 'admin' | 'rep'; // أدمن شركة أم مندوب
  onClose: () => void;
  /** بريدٌ كتبه المستخدم في نموذج الدخول — يُملأ به حقل الاستعادة */
  initialEmail?: string;
}

/**
 * استعادة الحساب (طلب المالك ٢١ نوفمبر ٢٠٢٦):
 *  • مستخدم الشركة (مدير/مشرف/محاسب) → بريد الدخول ⇒ رابط تعيين كلمة مرور جديدة إلى بريده (POST /auth/forgot-password).
 *    و«لا أتذكر بريدي» → رقم جوال الشركة ⇒ يصل الرابط بريد مديرها، ويُعرض البريد مُقنَّعاً (POST /auth/recover-email).
 *    والردّ واحدٌ وُجد الحساب أم لا — لا تُكشف البُرُد المسجّلة. ومن فقد بريده نفسه: واتساب الدعم.
 *  • المندوب → بلا بريد: يعيد مدير شركته تعيينها (كما كان).
 */
type Mode =
  | { kind: 'email' }
  | { kind: 'phone' }
  | { kind: 'sentEmail'; message: string }
  | { kind: 'sentPhone'; message: string; emails: string[] };

type ApiErr = { response?: { status?: number; data?: { message?: unknown } } };

export default function ForgotPasswordDialog({ role, onClose, initialEmail = '' }: Props) {
  const tr = useTr();
  const dir = useDir();
  const isRep = role === 'rep';
  const [mode, setMode] = useState<Mode>({ kind: 'email' });
  const [email, setEmail] = useState(initialEmail.trim());
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const support = supportWhatsappUrl(tr('مرحبا، أحتاج مساعدة في استعادة حساب شركتي على فيلد سيلز'));
  const serverMsg = (e: unknown): string | null => {
    const m = (e as ApiErr)?.response?.data?.message;
    return typeof m === 'string' && m.trim() ? m : null;
  };
  const failText = (e: unknown) => {
    const res = (e as { response?: { status?: number; data?: { errors?: Record<string, unknown> } } })?.response;
    // تحقّق الخادم (400): رسالة الحقل نفسها («اكتب بريداً إلكترونياً صحيحاً») لا «بيانات غير صحيحة email»
    const field = res?.status === 400 && res.data?.errors ? Object.values(res.data.errors).flat().find((x) => typeof x === 'string') : undefined;
    if (typeof field === 'string' && field.trim()) return tr(field);
    const m = res && res.status !== 400 && (res.status ?? 0) < 500 ? serverMsg(e) : null;
    if (m) return tr(m);
    return (e as ApiErr)?.response ? tr('تعذر الإرسال — حاول مجددا') : tr('تعذر الاتصال بالخادم — تحقق من الإنترنت ثم حاول مجددا');
  };

  const sendEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (!looksLikeEmail(email)) { setError(tr('اكتب بريداً إلكترونياً صحيحاً')); return; }
    setBusy(true); setError('');
    try {
      const res = await authApi.forgotPassword(email.trim());
      const m = serverMsg({ response: { data: res.data } });
      setMode({ kind: 'sentEmail', message: m ?? 'إن كان البريد مسجلاً لدينا فسيصلك رابط إعادة تعيين كلمة المرور خلال دقائق — افحص صندوق الوارد والرسائل غير المرغوبة' });
    } catch (err) {
      setError(failText(err));
    } finally { setBusy(false); }
  };

  const sendPhone = async (e: FormEvent) => {
    e.preventDefault();
    if (!looksLikePhone(phone)) { setError(tr('اكتب رقم جوال الشركة')); return; }
    setBusy(true); setError('');
    try {
      // يُرسل كما كُتب (بأرقامٍ عربية أو لاتينية، وبمفتاح الدولة أو بدونه) — الخادم يطبّعه ويطابقه
      const res = await authApi.recoverEmail(phone.trim());
      const body = res.data as { message?: unknown; data?: { emails?: unknown } };
      const emails = Array.isArray(body?.data?.emails) ? body.data.emails.filter((x): x is string => typeof x === 'string') : [];
      const m = serverMsg({ response: { data: body } });
      setMode({
        kind: 'sentPhone', emails,
        message: m ?? (emails.length
          ? 'أرسلنا رابط الاستعادة إلى بريد مدير الشركة'
          : 'إن كان الرقم مسجلاً لشركة فسيصل رابط الاستعادة إلى بريد مديرها — وإن لم يصلك شيء فتواصل مع الدعم'),
      });
    } catch (err) {
      setError(failText(err));
    } finally { setBusy(false); }
  };

  const switchTo = (kind: 'email' | 'phone') => { setMode({ kind }); setError(''); };

  const supportBtn = (
    <a href={support} target="_blank" rel="noopener noreferrer"
      className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-[#1E7A52]/30 bg-[#EAF4EE] text-[#1E7A52] font-bold py-2.5 text-sm hover:bg-[#DCEDE3]">
      <MessageCircle size={16} /> {tr('تواصل مع الدعم')}
    </a>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir={dir} {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm relative" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label={tr('إغلاق')}
          className="absolute top-3 p-1.5 rounded-lg text-[#9A8F7E] hover:bg-[#FAF7F0]" style={{ insetInlineEnd: '12px' }}>
          <X size={18} />
        </button>
        <div className="p-6 pb-3 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-3">
            {mode.kind === 'sentEmail' || mode.kind === 'sentPhone'
              ? <CheckCircle2 size={28} className="text-[#1E7A52]" />
              : <LifeBuoy size={28} className="text-[#E15A30]" />}
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13]">{tr('استعادة كلمة المرور')}</h2>
        </div>

        {isRep ? (
          <RepHelp onClose={onClose} />
        ) : mode.kind === 'email' ? (
          <form onSubmit={sendEmail} className="px-6 pb-6" noValidate>
            <p className="text-sm text-[#6E6557] text-center leading-relaxed mb-4">
              {tr('اكتب بريد الدخول وسنرسل إليه رابطا لتعيين كلمة مرور جديدة')}
            </p>
            <Field icon={<Mail size={16} />}>
              <input type="email" dir="ltr" className="input pr-9 pl-9" placeholder="admin@company.com" value={email}
                onChange={e => { setEmail(e.target.value); setError(''); }} autoComplete="email" inputMode="email" autoFocus />
            </Field>
            {error && <p className="text-[#C0392B] text-xs mt-2" role="alert">{error}</p>}
            <SubmitButton busy={busy}>{tr('أرسل رابط الاستعادة')}</SubmitButton>
            <button type="button" onClick={() => switchTo('phone')}
              className="w-full text-center text-sm text-[#6E6557] hover:text-[#E15A30] mt-3 transition-colors">
              {tr('لا أتذكر بريدي')}
            </button>
          </form>
        ) : mode.kind === 'phone' ? (
          <form onSubmit={sendPhone} className="px-6 pb-6" noValidate>
            <p className="text-sm text-[#6E6557] text-center leading-relaxed mb-4">
              {tr('اكتب رقم جوال الشركة المسجل في إعداداتها وسنرسل رابط الاستعادة إلى بريد مديرها')}
            </p>
            <Field icon={<Phone size={16} />}>
              <input type="tel" dir="ltr" className="input pr-9 pl-9" placeholder="05XXXXXXXX" value={phone}
                onChange={e => { setPhone(e.target.value); setError(''); }} autoComplete="tel" inputMode="tel" autoFocus maxLength={24} />
            </Field>
            {error && <p className="text-[#C0392B] text-xs mt-2" role="alert">{error}</p>}
            <SubmitButton busy={busy}>{tr('أرسل رابط الاستعادة')}</SubmitButton>
            <div className="mt-3">{supportBtn}</div>
            <button type="button" onClick={() => switchTo('email')}
              className="w-full inline-flex items-center justify-center gap-1 text-sm text-[#6E6557] hover:text-[#E15A30] mt-3 transition-colors">
              <ArrowRight size={14} className={dir === 'rtl' ? '' : 'rotate-180'} /> {tr('الاستعادة بالبريد')}
            </button>
          </form>
        ) : (
          <div className="px-6 pb-6">
            <p className="text-sm text-[#1F1A13] text-center leading-relaxed">{tr(mode.message)}</p>
            {mode.kind === 'sentPhone' && mode.emails.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {mode.emails.map((m) => (
                  <li key={m} dir="ltr" className="text-center text-sm font-bold text-[#1F1A13] bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg py-1.5">{m}</li>
                ))}
              </ul>
            )}
            <p className="text-[11.5px] text-[#9A8F7E] text-center mt-3 leading-relaxed">{tr('الرابط صالح ساعة واحدة ويعمل مرة واحدة')}</p>
            {mode.kind === 'sentPhone' && <div className="mt-4">{supportBtn}</div>}
            <button onClick={onClose} className="btn-primary w-full justify-center py-2.5 mt-4">{tr('حسنا فهمت')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="absolute top-1/2 -translate-y-1/2 text-[#9A8F7E]" style={{ insetInlineStart: '12px' }}>{icon}</span>
      {children}
    </div>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy}
      className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-4">
      {busy ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : children}
    </button>
  );
}

/** المندوب بلا بريد: كلمة مروره يعيد تعيينها مدير شركته (كما كان) */
function RepHelp({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  return (
    <>
      <p className="text-sm text-[#6E6557] text-center leading-relaxed px-6">{tr('لأمان حسابك إعادة تعيين كلمة المرور تتم عبر مدير شركتك')}</p>
      <div className="px-6 pt-4 pb-2">
        <div className="bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl p-4 flex items-start gap-3 text-start">
          <div className="w-9 h-9 rounded-lg bg-[#FBEBE2] flex items-center justify-center shrink-0">
            <UserCog size={18} className="text-[#E15A30]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#1F1A13]">{tr('تواصل مع مدير شركتك')}</p>
            <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">
              {tr('اطلب منه فتح صفحة المناديب ← زر المفتاح بجانب اسمك ← إعادة تعيين كلمة المرور وسيسلمك كلمة مرور جديدة')}
            </p>
          </div>
        </div>
      </div>
      <div className="p-6 pt-4">
        <button onClick={onClose} className="btn-primary w-full justify-center py-2.5">{tr('حسنا فهمت')}</button>
      </div>
    </>
  );
}
