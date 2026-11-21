// ============================================================================
// إعادة تعيين كلمة مرور مستخدم الشركة — /reset-password#t=TOKEN (طلب المالك ٢١ نوفمبر ٢٠٢٦)
//
// · يصلها المستخدم من رابط بريد «نسيت كلمة المرور» (أو «لا أتذكر بريدي» برقم جوال الشركة).
// · الرمز في **وسم** الرابط (`#t=`) وحده لا في استعلامه: لا يصل الخادم ولا سجلّات Render ولا ترويسة Referer.
//   يُقرأ مرّةً ويُمحى من الشريط **فوراً** (history.replaceState) قبل أي طلب، ثم يبقى في الذاكرة (ref) وحدها.
// · الرابط صالح ساعة ولمرّةٍ واحدة (الخادم يربطه ببصمة كلمة المرور الحالية): بعد التعيين يبطل تلقائياً.
// · بعد التعيين يدخل لوحة شركته مباشرةً بجلسةٍ كالدخول — وإن كان اشتراك الشركة موقوفاً تُعرض رسالته.
// · كـ/activate: لا وسم إعلانيّ، ولا زيارة تُسجَّل، ولا زرّ واتساب عائم، ومستثناة من الفهرسة (robots).
// ============================================================================
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, Building2, Eye, EyeOff, KeyRound, Lock, Mail, MailWarning, User as UserIcon, XCircle } from 'lucide-react';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import { useTr } from '../i18n/strings';
import { useDir } from '../i18n/lang';
import { readResetToken } from '../lib/loginErrors';
import type { User } from '../types';

interface ResetInfo { name: string; email: string; companyName: string }

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; info: ResetInfo }
  /** لا رمز في العنوان — فُتحت الصفحة مباشرةً أو أُعيد تحميلها بعد المحو */
  | { kind: 'noToken' }
  | { kind: 'invalid' }
  /** عُيّنت كلمة المرور لكن اشتراك الشركة موقوف أو منتهٍ — رسالة الخادم كما هي */
  | { kind: 'blocked'; message: string }
  /** تعذّر التحقّق — برسالة الخادم إن كانت (كثرة المحاولات 429)، وإلا انقطاع */
  | { kind: 'error'; message?: string };

const RESET_PATH = '/reset-password';

/** يفكّ الغلاف `{ success, data }` */
function payload<T>(res: { data?: unknown }): T {
  const body = res?.data as { data?: unknown } | undefined;
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

interface ErrInfo { status?: number; code?: string; message?: string; fields: string[] }
function errInfo(err: unknown): ErrInfo {
  const r = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
  const d = r?.data ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const errors = d.errors && typeof d.errors === 'object' ? Object.keys(d.errors as object) : [];
  return { status: r?.status, code: str(d.code), message: str(d.message), fields: errors };
}

/** رابطٌ غير صالح أو منتهٍ أو مستعمَل: رمز `invalid`، أو 400 ليس خطأَ حقل كلمة المرور */
function isInvalidLink(e: ErrInfo): boolean {
  if (e.code === 'invalid') return true;
  if (e.status === 400 && e.fields.includes('token')) return true;
  return e.status === 400 && !e.fields.includes('password') && !/كلمة المرور/.test(e.message ?? '');
}

export default function ResetPasswordPage() {
  const tr = useTr();
  const dir = useDir();
  const login = useAuthStore((s) => s.login);

  // الرمز في الذاكرة وحدها — يُقرأ مرّةً (StrictMode يعيد الأثر فلا يُقرأ ثانيةً بعد المحو)
  const tokenRef = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = readResetToken(window.location.hash);
      // يُمحى الرمز من الشريط والسجلّ قبل أي طلب — يبقى في tokenRef وحده
      window.history.replaceState(window.history.state, '', RESET_PATH);
    }
    const token = tokenRef.current;
    if (!token) { setView({ kind: 'noToken' }); return; }
    let cancelled = false;
    setView({ kind: 'loading' });
    authApi.resetPreview(token).then((res) => {
      if (cancelled) return;
      const d = payload<Record<string, unknown>>(res) ?? {};
      const s = (v: unknown) => (typeof v === 'string' ? v : '');
      setView({ kind: 'ready', info: { name: s(d.name), email: s(d.email), companyName: s(d.companyName) } });
    }).catch((err: unknown) => {
      if (cancelled) return;
      const info = errInfo(err);
      if (isInvalidLink(info) || info.status === 404) { setView({ kind: 'invalid' }); return; }
      setView({ kind: 'error', message: info.status === 429 && info.message ? info.message : undefined });
    });
    return () => { cancelled = true; };
  }, [attempt]);

  // رابطٌ أحدث يُلصق في اللسان نفسه يغيّر الوسم وحده — يُلتقط ويُمحى ويُعاد الفحص
  useEffect(() => {
    const onHash = () => {
      const fresh = readResetToken(window.location.hash);
      if (!fresh) return;
      window.history.replaceState(window.history.state, '', RESET_PATH);
      if (fresh === tokenRef.current) return;
      tokenRef.current = fresh;
      setPassword(''); setConfirm('');
      setAttempt((a) => a + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = tokenRef.current;
    if (!token || view.kind !== 'ready') return;
    if (password.length < 8) { toast.error(tr('كلمة المرور 8 أحرف على الأقل')); return; }
    if (password.length > 128) { toast.error(tr('كلمة المرور طويلة جدا')); return; }
    if (password !== confirm) { toast.error(tr('كلمتا المرور غير متطابقتين')); return; }
    setBusy(true);
    let redirecting = false;
    try {
      const res = await authApi.resetPassword({ token, password });
      if (tokenRef.current !== token) return;
      const session = payload<{ token?: string; user?: User }>(res);
      if (!session?.token || !session.user) throw new Error('reset: missing session');
      tokenRef.current = '';
      login(session.token, session.user);
      toast.success(tr('تم تعيين كلمة المرور الجديدة'));
      redirecting = true;
      window.location.replace('/app');
    } catch (err: unknown) {
      if (tokenRef.current !== token) return;
      const info = errInfo(err);
      if (info.code === 'TENANT_BLOCKED' || info.status === 403) {
        // كلمة المرور عُيّنت فعلاً — الدخول وحده محجوب برسالة الخادم (اشتراكٌ موقوف أو منتهٍ)
        tokenRef.current = '';
        setView({ kind: 'blocked', message: info.message ?? 'تم تعيين كلمة المرور الجديدة' });
        return;
      }
      if (isInvalidLink(info)) { setView({ kind: 'invalid' }); return; }
      if (info.message) toast.error(tr(info.message));
      else if (!(err as { response?: unknown })?.response) toast.error(tr('تعذر الاتصال بالخادم — تحقق من الإنترنت ثم حاول مجددا'));
      else toast.error(tr('تعذر تعيين كلمة المرور — حاول مجددا'));
    } finally {
      if (!redirecting) setBusy(false);
    }
  };

  const side = dir === 'rtl'
    ? { start: 'right-3', end: 'left-3', align: 'text-right' }
    : { start: 'left-3', end: 'right-3', align: 'text-left' };
  const requestNew = (
    <div className="mt-6 flex flex-col items-center gap-3">
      <button type="button" onClick={() => setShowForgot(true)} className="btn-primary inline-flex">{tr('اطلب رابطا جديدا')}</button>
      <Link to="/login" className="text-sm text-[#6E6557] hover:text-[#E15A30]">{tr('العودة إلى تسجيل الدخول')}</Link>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FAF7F0] px-4 py-6 flex justify-center" dir={dir}>
      <div className="w-full max-w-md">
        <div className="flex justify-end mb-3"><LanguageToggle /></div>
        <div className="bg-white rounded-2xl border border-[#E9E1D3] shadow-sm p-6 sm:p-8">
          <div className="flex justify-center mb-5"><BrandIcon size={64} radius={0.26} /></div>

          {view.kind === 'loading' && (
            <div className="text-center">
              <div className="w-10 h-10 border-3 border-[#E15A30]/30 border-t-[#E15A30] rounded-full animate-spin mx-auto mb-4" />
              <p className="text-[#6E6557]">{tr('جار التحقق من الرابط')}</p>
            </div>
          )}

          {view.kind === 'noToken' && (
            <StateCard tone="amber" icon={<MailWarning size={34} className="text-[#8A5A0B]" />}
              title={tr('افتح الرابط من رسالة البريد')} body={tr('رابط إعادة تعيين كلمة المرور يصلك على بريدك بعد طلبه من صفحة الدخول')}>
              {requestNew}
            </StateCard>
          )}

          {view.kind === 'invalid' && (
            <StateCard tone="red" icon={<XCircle size={34} className="text-red-600" />}
              title={tr('رابط إعادة التعيين غير صالح أو منتهي الصلاحية')} body={tr('الرابط صالح ساعة واحدة ويعمل مرة واحدة — اطلب رابطا جديدا')}>
              {requestNew}
            </StateCard>
          )}

          {view.kind === 'blocked' && (
            <StateCard tone="amber" icon={<AlertTriangle size={34} className="text-[#8A5A0B]" />}
              title={tr('تم تعيين كلمة المرور الجديدة')} body={tr(view.message)}>
              <Link to="/login" className="btn-primary mx-auto mt-6 inline-flex">{tr('العودة إلى تسجيل الدخول')}</Link>
            </StateCard>
          )}

          {view.kind === 'error' && (
            <StateCard tone="red" icon={<AlertTriangle size={34} className="text-red-600" />}
              title={tr('تعذر التحقق من الرابط')} body={view.message ? tr(view.message) : tr('تحقق من اتصالك بالإنترنت ثم أعد المحاولة')}>
              <button type="button" onClick={retry} className="btn-primary mx-auto mt-6 inline-flex">{tr('إعادة المحاولة')}</button>
            </StateCard>
          )}

          {view.kind === 'ready' && (
            <>
              <h1 className="text-xl font-bold text-[#1F1A13] text-center">{tr('تعيين كلمة مرور جديدة')}</h1>
              <p className="text-[#6E6557] text-sm mt-1.5 text-center leading-relaxed">{tr('اختر كلمة مرور جديدة لحسابك ثم ادخل لوحة شركتك مباشرة')}</p>

              <div className="mt-5 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] divide-y divide-[#E9E1D3]">
                {view.info.companyName && <InfoRow icon={<Building2 size={14} />} label={tr('الشركة')}>{view.info.companyName}</InfoRow>}
                {view.info.name && <InfoRow icon={<UserIcon size={14} />} label={tr('المستخدم')}>{view.info.name}</InfoRow>}
                <InfoRow icon={<Mail size={14} />} label={tr('بريد الدخول')}>
                  <span dir="ltr" className={`block break-all ${side.align}`}>{view.info.email}</span>
                </InfoRow>
              </div>

              <form onSubmit={submit} className="space-y-3.5 mt-5" noValidate>
                <div>
                  <label className="label">{tr('كلمة المرور الجديدة')} *</label>
                  <div className="relative">
                    <Lock size={16} className={`absolute ${side.start} top-1/2 -translate-y-1/2 text-[#9A8F7E]`} />
                    <input type={showPass ? 'text' : 'password'} dir="ltr" className={`input pl-9 pr-9 ${side.align}`} value={password}
                      onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} autoFocus />
                    <button type="button" className={`absolute ${side.end} top-1/2 -translate-y-1/2 text-[#9A8F7E]`}
                      onClick={() => setShowPass((s) => !s)} aria-label={showPass ? tr('إخفاء كلمة المرور') : tr('إظهار كلمة المرور')}>
                      {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('8 أحرف على الأقل')}</p>
                </div>
                <div>
                  <label className="label">{tr('تأكيد كلمة المرور')} *</label>
                  <div className="relative">
                    <KeyRound size={16} className={`absolute ${side.start} top-1/2 -translate-y-1/2 text-[#9A8F7E]`} />
                    <input type={showPass ? 'text' : 'password'} dir="ltr" className={`input pl-9 pr-9 ${side.align}`} value={confirm}
                      onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
                  </div>
                </div>
                {/* اسم الدخول المخفيّ لمدير كلمات المرور: يحفظ كلمة المرور الجديدة مقرونةً ببريد الدخول */}
                <input type="email" name="username" autoComplete="username" value={view.info.email} readOnly hidden />

                <button type="submit" disabled={busy}
                  className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
                  {busy ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : tr('حفظ كلمة المرور والدخول')}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      {showForgot && <ForgotPasswordDialog role="admin" onClose={() => setShowForgot(false)} />}
    </div>
  );
}

const STATE_TONE = { red: 'bg-red-100', amber: 'bg-[#FAEFD8]', green: 'bg-green-100' } as const;

function StateCard({ tone, icon, title, body, children }: {
  tone: keyof typeof STATE_TONE; icon: ReactNode; title: string; body: string; children?: ReactNode;
}) {
  return (
    <div className="text-center">
      <div className={`w-16 h-16 rounded-2xl ${STATE_TONE[tone]} flex items-center justify-center mx-auto mb-4`}>{icon}</div>
      <h1 className="text-xl font-bold text-[#1F1A13]">{title}</h1>
      <p className="text-[#6E6557] text-sm mt-2 leading-relaxed">{body}</p>
      {children}
    </div>
  );
}

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] text-[#6E6557]">{icon} {label}</div>
      <div className="font-bold text-[14px] text-[#1F1A13] mt-0.5 break-words">{children}</div>
    </div>
  );
}
