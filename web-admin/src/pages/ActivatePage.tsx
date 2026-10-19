// ============================================================================
// تفعيل حساب شركةٍ فتحه «سفير فيلد سيلز» — /activate#t=TOKEN
//
// · الرمز في **وسم** الرابط (`#t=`) لا في استعلامه: لا يصل الخادم ولا سجلّات Render ولا ترويسة
//   Referer. يُقرأ مرّةً ويُمحى من الشريط **فوراً** (history.replaceState) قبل أي طلب، ثم يبقى
//   في الذاكرة (ref) وحدها — لا localStorage ولا sessionStorage، فلا يبقى في المتصفّح بعد الإغلاق.
// · صفحة الشركة لا البوابة: لا روابط إلى بوابة السفراء ولا استيراد منها (عزل الجلستين).
// · مسؤول الشركة يرى بريد دخوله كما سيكتبه (الدخول بالبريد حرفياً)، ويختار كلمة مروره بنفسه —
//   السفير لا يعرفها ولا يدخل الحساب — ويكتب جوال الشركة **كاملاً** (لا «إبقاء» صامت لرقمٍ مُقنَّع كتبه
//   السفير: الرقم يصير هوية الشركة في واتساب)، ثم يدخل لوحته.
// · بلا trackSignup: لا وسم إعلانيّ على هذه الصفحة (lib/adsRoutes.ts)، والحساب فتحه سفير لا حملة.
// ============================================================================
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Building2, CheckCircle2, Eye, EyeOff, Lock, Mail, MailWarning, Phone, ShieldCheck, User as UserIcon, XCircle,
} from 'lucide-react';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';
import { useDir, useLang } from '../i18n/lang';
import { ALL_DIAL, ARAB_DIAL, WORLD_DIAL, dialOf, flagOf } from '../i18n/dialCodes';
import type { User } from '../types';

/** ما يعرضه الخادم قبل التفعيل (POST /auth/activation/preview بحالة ready) */
interface ActivationInfo {
  companyName: string;
  adminName: string;
  /** بريد الدخول كما خُزّن (أحرفٌ صغيرة) — الدخول بالبريد حرفياً */
  email: string;
  phoneMasked: string | null;
  countryCode: string | null;
  /** اسم السفير الذي فتح الحساب — null لحسابٍ لم يفتحه سفير */
  openedBy: string | null;
}

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; info: ActivationInfo }
  /** لا رمز في العنوان — غالباً إعادة تحميلٍ بعد المحو، والرابط في البريد ما زال صالحاً */
  | { kind: 'noToken' }
  | { kind: 'invalid' }
  /** أوقفه الخادم بعد تكرار «الرقم مربوطٌ بحسابٍ آخر» — لا رابطٌ أحدث أُرسل */
  | { kind: 'locked' }
  | { kind: 'superseded' }
  | { kind: 'active' }
  | { kind: 'error' };

/** الرمز من وسم الرابط `#t=` — والاستعلام `?t=` احتياطاً لعميل بريدٍ يُسقط الوسم */
function readLinkToken(): string {
  try {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t');
    if (fromHash) return fromHash;
    return new URLSearchParams(window.location.search).get('t') || '';
  } catch {
    return '';
  }
}

/** الأرقام العربية-الهندية والفارسية (لوحة مفاتيح عربية) إلى لاتينية */
function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/** أرقامٌ و«+» أوّلاً فقط — فرقمٌ دوليٌّ مُلصق يبقى دولياً ولا يُسبق بمفتاح الدولة المختارة */
function keepPhoneChars(s: string): string {
  const v = s.replace(/[^\d+]/g, '');
  return v.startsWith('+') ? `+${v.slice(1).replace(/\+/g, '')}` : v.replace(/\+/g, '');
}

/** يفكّ الغلاف `{ success, data }` ويتسامح مع ردٍّ بلا غلاف */
function payload<T>(res: { data?: unknown }): T {
  const body = res?.data as { data?: unknown } | undefined;
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

interface ErrInfo { status?: number; code?: string; message?: string; state?: string; fields: string[] }
function errInfo(err: unknown): ErrInfo {
  const r = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
  const d = r?.data ?? {};
  const inner = (d.data && typeof d.data === 'object' ? d.data : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const errors = d.errors && typeof d.errors === 'object' ? Object.keys(d.errors as object) : [];
  return { status: r?.status, code: str(d.code), message: str(d.message), state: str(d.state) ?? str(inner.state), fields: errors };
}

/** حالة الرابط من ردّ خطأ: صار مفعّلاً، أو أُرسل أحدث منه، أو غير صالح — أو null (عطلٌ يُعاد) */
function linkStateOf(e: ErrInfo): 'active' | 'superseded' | 'invalid' | 'locked' | null {
  if (e.code === 'already_active' || e.state === 'already_active') return 'active';
  if (e.code === 'superseded' || e.state === 'superseded') return 'superseded';
  // تكرّر «الرقم مربوطٌ بحسابٍ آخر» فأوقف الخادم الرابط — يُطلب غيره، ولا يُقال «افتح آخر رسالة»
  if (e.code === 'link_locked' || e.state === 'locked') return 'locked';
  // رمزٌ مشوَّه (zod على حقل token) = رابطٌ غير صالح، لا عطلٌ يُعاد
  if (e.status === 400 && e.fields.includes('token')) return 'invalid';
  // 400 بحقولٍ من zod، أو `invalid_phone` من الخادم، خطأ إدخال لا رابط — يُعرض ويبقى النموذج
  if (e.status === 400 && (e.fields.length > 0 || e.code === 'invalid_phone')) return null;
  if (e.status === 400 || e.status === 404 || e.code === 'invalid' || e.state === 'invalid') return 'invalid';
  return null;
}

function infoOf(raw: Record<string, unknown>): ActivationInfo {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const n = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    companyName: s(raw.companyName), adminName: s(raw.adminName), email: s(raw.email),
    phoneMasked: n(raw.phoneMasked), countryCode: n(raw.countryCode), openedBy: n(raw.openedBy),
  };
}

export default function ActivatePage() {
  const t = useT();
  const dir = useDir();
  const lang = useLang((s) => s.lang);
  const login = useAuthStore((s) => s.login);

  // الرمز في الذاكرة وحدها — يُقرأ مرّةً عند أول تشغيلٍ للأثر (StrictMode يعيده فلا يُقرأ ثانيةً بعد المحو)
  const tokenRef = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [agree, setAgree] = useState(false);
  const [phoneCountry, setPhoneCountry] = useState('SA');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = readLinkToken();
      // يُمحى الرمز من الشريط والسجلّ قبل أي طلب — يبقى في tokenRef وحده
      window.history.replaceState(window.history.state, '', '/activate');
    }
    const token = tokenRef.current;
    // بلا رمز ليس «رابطاً منتهياً»: الأرجح إعادة تحميلٍ بعد المحو — الرابط في البريد ما زال صالحاً،
    // وطلب إعادة الإرسال يستهلك سقفها ويُسقط هذا الرابط
    if (!token) { setView({ kind: 'noToken' }); return; }
    let cancelled = false;
    setView({ kind: 'loading' });
    authApi.activationPreview(token).then((res) => {
      if (cancelled) return;
      const d = payload<Record<string, unknown>>(res) ?? {};
      if (d.state === 'ready') {
        const info = infoOf(d);
        setView({ kind: 'ready', info });
        if (info.countryCode && ALL_DIAL.some((c) => c.code === info.countryCode)) setPhoneCountry(info.countryCode);
      } else if (d.state === 'already_active') setView({ kind: 'active' });
      else if (d.state === 'superseded') setView({ kind: 'superseded' });
      else if (d.state === 'locked') setView({ kind: 'locked' });
      else setView({ kind: 'invalid' });
    }).catch((err: unknown) => {
      if (cancelled) return;
      setView({ kind: linkStateOf(errInfo(err)) ?? 'error' });
    });
    return () => { cancelled = true; };
  }, [attempt]);

  // رابطٌ أحدث يُلصق في اللسان نفسه يغيّر الوسم وحده فلا يُعاد تحميل الصفحة — يُلتقط ويُمحى ويُعاد الفحص
  useEffect(() => {
    const onHash = () => {
      const fresh = readLinkToken();
      if (!fresh) return;
      window.history.replaceState(window.history.state, '', '/activate');
      if (fresh === tokenRef.current) return;
      tokenRef.current = fresh;
      setPassword(''); setConfirm(''); setAgree(false); setPhone('');
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
    if (password.length < 8) { toast.error(t('activate.short')); return; }
    if (password.length > 128) { toast.error(t('activate.tooLong')); return; }
    if (password !== confirm) { toast.error(t('activate.mismatch')); return; }
    // الجوال مطلوبٌ كاملاً — لا إبقاء صامت لما كتبه السفير. رقمٌ دوليّ مُلصق (+… أو 00…) يُرسل كما هو أيّاً كانت
    // الدولة المختارة؛ وإلا فمحلّيٌّ يُسبق بمفتاح الدولة. ومفتاحٌ مكرَّر (966…) يُنزع لمفاتيح الثلاثة أرقام وحدها:
    // أقصرها (‎+91 ‎+39 ‎+7) تبدأ به أرقامٌ محلية صحيحة فيُقصّ أوّلها خطأً
    const dial = dialOf(phoneCountry) || '+966';
    const dialDigits = dial.replace(/\D/g, '');
    const typed = phone.trim();
    let companyPhone: string;
    if (typed.startsWith('+') || typed.startsWith('00')) {
      companyPhone = `+${typed.replace(/\D/g, '').replace(/^00/, '')}`;
    } else {
      let local = typed.replace(/\D/g, '');
      if (dialDigits.length >= 3 && local.startsWith(dialDigits) && local.length > dialDigits.length + 6) local = local.slice(dialDigits.length);
      local = local.replace(/^0+/, '');
      companyPhone = local ? `${dial}${local}` : '';
    }
    if (companyPhone.replace(/\D/g, '').length < 8) { toast.error(t('activate.phoneInvalid')); return; }
    if (!agree) { toast.error(t('signup.errAgree')); return; }

    setBusy(true);
    let redirecting = false;
    try {
      const res = await authApi.activate({ token, password, acceptTerms: true, phone: companyPhone });
      // رابطٌ أحدث لُصق في أثناء الإرسال: نتيجة القديم لا تمسّ الصفحة
      if (tokenRef.current !== token) return;
      const session = payload<{ token?: string; user?: User }>(res);
      if (!session?.token || !session.user) throw new Error('activate: missing session');
      tokenRef.current = '';
      login(session.token, session.user);
      toast.success(t('activate.success'));
      redirecting = true;
      window.location.replace('/app');
    } catch (err: unknown) {
      if (tokenRef.current !== token) return;
      const info = errInfo(err);
      const state = linkStateOf(info);
      if (state) { setView({ kind: state }); return; }
      let text: string;
      if (info.status === 400 && info.fields.includes('password')) text = t('activate.short');
      else if (info.status === 400 && (info.fields.includes('phone') || info.code === 'invalid_phone')) text = t('activate.phoneInvalid');
      else if (info.status === 400 && info.fields.includes('acceptTerms')) text = t('signup.errAgree');
      else if (lang === 'ar' && info.message) text = info.message;
      else if (info.code === 'phone_taken') text = t('activate.phoneTaken');
      else if (info.status === 403) text = t('activate.suspended');
      else if (info.status === 429) text = t('activate.tooMany');
      else text = t('activate.failed');
      toast.error(text);
    } finally {
      if (!redirecting) setBusy(false);
    }
  };

  const dialOption = (c: { code: string; dial: string; ar: string; en: string }) => (
    <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>
  );
  const side = dir === 'rtl'
    ? { start: 'right-3', end: 'left-3', pad: 'pr-9', align: 'text-right' }
    : { start: 'left-3', end: 'right-3', pad: 'pl-9', align: 'text-left' };

  return (
    <div className="min-h-screen bg-[#FAF7F0] px-4 py-6 flex justify-center" dir={dir}>
      <div className="w-full max-w-md">
        <div className="flex justify-end mb-3"><LanguageToggle /></div>
        <div className="bg-white rounded-2xl border border-[#E9E1D3] shadow-sm p-6 sm:p-8">
          <div className="flex justify-center mb-5"><BrandIcon size={64} radius={0.26} /></div>

          {view.kind === 'loading' && (
            <div className="text-center">
              <div className="w-10 h-10 border-3 border-[#E15A30]/30 border-t-[#E15A30] rounded-full animate-spin mx-auto mb-4" />
              <p className="text-[#6E6557]">{t('activate.loading')}</p>
            </div>
          )}

          {view.kind === 'noToken' && (
            <StateCard tone="amber" icon={<MailWarning size={34} className="text-[#8A5A0B]" />} title={t('activate.noTokenTitle')} body={t('activate.noTokenBody')} />
          )}

          {view.kind === 'invalid' && (
            <StateCard tone="red" icon={<XCircle size={34} className="text-red-600" />} title={t('activate.invalidTitle')} body={t('activate.invalidBody')} />
          )}

          {view.kind === 'locked' && (
            <StateCard tone="red" icon={<XCircle size={34} className="text-red-600" />} title={t('activate.lockedTitle')} body={t('activate.lockedBody')} />
          )}

          {view.kind === 'superseded' && (
            <StateCard tone="amber" icon={<MailWarning size={34} className="text-[#8A5A0B]" />} title={t('activate.supersededTitle')} body={t('activate.supersededBody')} />
          )}

          {view.kind === 'active' && (
            <StateCard tone="green" icon={<CheckCircle2 size={34} className="text-green-600" />} title={t('activate.activeTitle')} body={t('activate.activeBody')}>
              <Link to="/login" className="btn-primary mx-auto mt-6 inline-flex">{t('activate.goLogin')}</Link>
            </StateCard>
          )}

          {view.kind === 'error' && (
            <StateCard tone="red" icon={<AlertTriangle size={34} className="text-red-600" />} title={t('activate.loadFailed')} body={t('activate.loadFailedBody')}>
              <button type="button" onClick={retry} className="btn-primary mx-auto mt-6 inline-flex">{t('activate.retry')}</button>
            </StateCard>
          )}

          {view.kind === 'ready' && (
            <>
              <h1 className="text-xl font-bold text-[#1F1A13] text-center">{t('activate.title')}</h1>
              <p className="text-[#6E6557] text-sm mt-1.5 text-center leading-relaxed">{t('activate.subtitle')}</p>

              <div className="mt-5 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] divide-y divide-[#E9E1D3]">
                <InfoRow icon={<Building2 size={14} />} label={t('activate.company')}>{view.info.companyName}</InfoRow>
                <InfoRow icon={<UserIcon size={14} />} label={t('activate.manager')}>{view.info.adminName}</InfoRow>
                <InfoRow icon={<Mail size={14} />} label={t('activate.loginEmail')} hint={t('activate.loginEmailHint')}>
                  <span dir="ltr" className={`block break-all ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{view.info.email}</span>
                </InfoRow>
              </div>

              {view.info.openedBy && (
                <div className="mt-3 flex gap-2.5 rounded-xl border border-[#F3D3C4] bg-[#FBEBE2]/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#44403a]">
                  <ShieldCheck size={16} className="shrink-0 mt-0.5 text-[#1E7A52]" />
                  <div>
                    <p>{t('activate.openedByLabel')}: <b className="text-[#1F1A13]"><bdi>{view.info.openedBy}</bdi></b></p>
                    <p className="text-[#6E6557] mt-0.5">{t('activate.ambassadorNote')}</p>
                  </div>
                </div>
              )}

              <form onSubmit={submit} className="space-y-3.5 mt-5" noValidate>
                <div>
                  <label className="label">{t('activate.phone')} *</label>
                  <div className="flex gap-2" dir="ltr">
                    <select
                      aria-label={t('activate.phoneCountry')} className="input font-semibold text-sm"
                      style={{ width: 118, flex: '0 0 auto', paddingInline: '8px' }}
                      value={phoneCountry} onChange={(e) => setPhoneCountry(e.target.value)}
                    >
                      <optgroup label={t('activate.arabCountries')}>{ARAB_DIAL.map(dialOption)}</optgroup>
                      <optgroup label={t('activate.otherCountries')}>{WORLD_DIAL.map(dialOption)}</optgroup>
                    </select>
                    <input
                      dir="ltr" className="input flex-1 min-w-0 text-left" value={phone} inputMode="tel" autoComplete="tel-national"
                      onChange={(e) => setPhone(keepPhoneChars(latinDigits(e.target.value)))} placeholder="5XXXXXXXX" maxLength={18}
                    />
                  </div>
                  {view.info.phoneMasked && (
                    <p className="inline-flex items-center gap-1.5 text-[11.5px] text-[#6E6557] mt-1.5">
                      <Phone size={13} className="text-[#9A8F7E]" /> {t('activate.phoneTypedBy')}: <bdi dir="ltr">{view.info.phoneMasked}</bdi>
                    </p>
                  )}
                  <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{t('activate.phoneHint')}</p>
                </div>

                {/* الحقلان LTR دائماً، فالأيقونات بمواضع فعلية حسب اتجاه الصفحة لا منطقية (dir على الحقل يقلبها) */}
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label">{t('activate.password')} *</label>
                    <div className="relative">
                      <Lock size={16} className={`absolute ${side.start} top-1/2 -translate-y-1/2 text-[#9A8F7E]`} />
                      <input
                        type={showPass ? 'text' : 'password'} dir="ltr" className={`input pl-9 pr-9 ${side.align}`} value={password}
                        onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128}
                      />
                      <button
                        type="button" className={`absolute ${side.end} top-1/2 -translate-y-1/2 text-[#9A8F7E]`}
                        onClick={() => setShowPass((s) => !s)} aria-label={showPass ? t('activate.hidePassword') : t('activate.showPassword')}
                      >
                        {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="label">{t('activate.confirm')} *</label>
                    <div className="relative">
                      <Lock size={16} className={`absolute ${side.start} top-1/2 -translate-y-1/2 text-[#9A8F7E]`} />
                      <input
                        type={showPass ? 'text' : 'password'} dir="ltr" className={`input ${side.pad} ${side.align}`} value={confirm}
                        onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128}
                      />
                    </div>
                  </div>
                </div>
                {/* اسم الدخول المخفيّ لمدير كلمات المرور: يحفظ كلمة المرور الجديدة مقرونةً ببريد الدخول */}
                <input type="email" name="username" autoComplete="username" value={view.info.email} readOnly hidden />

                {/* الشروط تُفتح في لسانٍ جديد: الرمز في الذاكرة وحدها، والتنقّل هنا يُضيّعه */}
                <label className="flex items-start gap-2 text-xs text-[#6E6557] cursor-pointer pt-1">
                  <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30] shrink-0" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>
                    {t('signup.agreePre')}{' '}
                    <a href="/terms/" target="_blank" rel="noopener noreferrer" className="text-[#E15A30] hover:underline">{t('signup.terms')}</a>{' '}
                    {t('signup.and')}{' '}
                    <a href="/privacy/" target="_blank" rel="noopener noreferrer" className="text-[#E15A30] hover:underline">{t('signup.privacy')}</a>.
                  </span>
                </label>

                <button
                  type="submit" disabled={busy}
                  className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2"
                >
                  {busy ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : t('activate.submit')}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
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

function InfoRow({ icon, label, hint, children }: { icon: ReactNode; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] text-[#6E6557]">{icon} {label}</div>
      <div className="font-bold text-[14px] text-[#1F1A13] mt-0.5 break-words">{children}</div>
      {hint && <p className="text-[11px] text-[#9A8F7E] mt-0.5 leading-relaxed">{hint}</p>}
    </div>
  );
}
