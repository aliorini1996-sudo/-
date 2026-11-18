// ============================================================================
// شاشات ما قبل الجلسة: دخول · تسجيل فوريّ · نسيت كلمة المرور · تعيين كلمة مرور جديدة.
//
// v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §0 و§7): التسجيل **يفتح الحساب ويُدخله فوراً**
// (201 `{token, user}`) — لا تأكيد بريد ولا «بانتظار المراجعة». شاشتا تأكيد البريد وإعادة
// إرساله حُذفتا، وروابطهما القديمة تذهب للدخول (nav.isLegacyAuthLink).
// ردّ الاستعادة يبقى موحّداً (202) عمداً — لا يكشف هل البريد مسجّل.
// كل النصوص من قاموس البوابة (../i18n)؛ نصّ الشروط العربي يُعرض عربياً.
// ============================================================================
import { useEffect, useState, type FormEvent } from 'react';
import { ARAB_DIAL, WORLD_DIAL, flagOf } from '../../i18n/dialCodes';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, MailCheck, AlertCircle, Zap } from 'lucide-react';
import { affiliateApi, httpStatus, qk, setToken, shouldRetry } from '../api';
import { daysLabel, formatRate, formatSar, SETTLEMENT_EVERY_DAYS } from '../format';
import {
  COMPANY_NAME_MAX, EMPTY_REGISTER, buildRegisterBody, isValidEmail, registerError, type RegisterForm,
} from '../validation';
import { clearRegisterDraft, loadRegisterDraft, saveRegisterDraft } from '../draft';
import { errorText, isEmailTaken, localizedServerText } from '../errors';
import { useAxT } from '../i18n';
import {
  ArabicTermsBody, AuthShell, CheckRow, ErrorBox, Field, LinkButton, Loading, PartnerTypePicker, PasswordInput, Spinner,
  ltrFieldAlign,
} from '../ui';
import type { AuthView } from '../nav';

export type { AuthView } from '../nav';

interface NavProps {
  go: (v: AuthView) => void;
  email: string;
  setEmail: (e: string) => void;
}

function SubmitButton({ busy, children }: { busy: boolean; children: string }) {
  return (
    <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-3 text-[15px] disabled:opacity-60">
      {busy ? <Spinner /> : children}
    </button>
  );
}

// ─────────────────────────── الدخول ───────────────────────────

export function LoginScreen({ go, email, setEmail, onLoggedIn }: NavProps & { onLoggedIn: () => void }) {
  const { t, lang, dir } = useAxT();
  const [password, setPassword] = useState('');
  // كل فشلٍ في الدخول (كلمة مرور خاطئة، بريد مجهول، قفل مؤقت) يُعيد 401 برسالة واحدة عمداً —
  // فلا تفريع هنا على نصّها: تُعرض (مترجمةً لغير العربية). حسابات v1 «بانتظار التأكيد أو
  // المراجعة» تُرقّى في الخادم عند أوّل دخولٍ ناجح، فلا رابط «لم تصلك رسالة التأكيد؟» بعد اليوم.
  const [failure, setFailure] = useState<unknown>(null);

  const login = useMutation({
    mutationFn: () => affiliateApi.login(email.trim().toLowerCase(), password),
    onSuccess: (r) => {
      setFailure(null);
      setToken(r.token);
      onLoggedIn();
    },
    onError: (err) => setFailure(err),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email) || !password) { toast.error(t('login.fillBoth')); return; }
    setFailure(null);
    login.mutate();
  };

  const failureText = failure
    ? errorText(failure, lang, 'login.failed', httpStatus(failure) === 401 ? 'login.invalid' : undefined)
    : null;

  return (
    <AuthShell title={t('login.title')} subtitle={t('login.subtitle')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('f.email')}>
          <input type="email" dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" inputMode="email" />
        </Field>
        <Field label={t('f.password')}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {failureText && (
          <div role="alert" className="flex gap-2 rounded-xl bg-[#FAEFD8] text-[#8A5A0B] text-[13px] leading-relaxed px-3 py-2.5">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{failureText}</span>
          </div>
        )}
        <SubmitButton busy={login.isPending}>{t('login.submit')}</SubmitButton>
      </form>
      <div className="mt-5 space-y-2 text-sm text-[#6E6557]">
        <div className="flex justify-between gap-2 flex-wrap">
          <LinkButton onClick={() => go('forgot')}>{t('login.forgot')}</LinkButton>
        </div>
        <div className="pt-3 border-t border-[#F1EBDF] text-center">
          {t('login.notAmbassador')} <LinkButton onClick={() => go('register')}>{t('login.apply')}</LinkButton>
        </div>
      </div>
    </AuthShell>
  );
}

// ─────────────────────────── التسجيل الفوريّ ───────────────────────────

/**
 * بطاقةٌ واحدة (V2_SPEC §7): الاسم والبريد والجوال وكلمة المرور ونوع السفير (واسم الشركة إن
 * كانت) والموافقة ⇒ 201 `{token, user}` فيُخزَّن التوكن ويدخل الرئيسية فوراً.
 * 409 `email_taken` ⇒ «سجّل الدخول» بالبريد نفسه؛ و409 غيره ⇒ صدرت شروطٌ أحدث أثناء الملء.
 */
export function RegisterScreen({ go, email, setEmail, onLoggedIn }: NavProps & { onLoggedIn: () => void }) {
  const { t, m, rich, lang, dir } = useAxT();
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  // المسودّة تبقى في sessionStorage عبر الرجوع والتنقّل (بلا كلمة المرور ولا الموافقة على الشروط)
  const [form, setForm] = useState<RegisterForm>(() => {
    const draft = loadRegisterDraft();
    if (draft) return draft.email.trim() || !email ? draft : { ...draft, email };
    return { ...EMPTY_REGISTER, email };
  });
  const [taken, setTaken] = useState<unknown>(null);
  useEffect(() => { saveRegisterDraft(form); }, [form]);
  const set = <K extends keyof RegisterForm>(k: K, v: RegisterForm[K]) => {
    if (k === 'email') setTaken(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const register = useMutation({
    mutationFn: (version: string) => affiliateApi.register(buildRegisterBody(form, version)),
    onSuccess: (r) => {
      clearRegisterDraft();
      setEmail(form.email.trim());
      setToken(r.token);
      toast.success(t('reg.welcome'));
      onLoggedIn();
    },
    onError: (err) => {
      if (isEmailTaken(err)) { setTaken(err); return; }
      const s = httpStatus(err);
      if (s === 409) {
        // صدر إصدار جديد من الشروط أثناء ملء النموذج — لا موافقة على نصٍّ لم يُقرأ
        set('acceptTerms', false);
        void terms.refetch();
        toast.error(t('reg.termsChanged'));
        return;
      }
      if (s === 403) void terms.refetch();
      toast.error(errorText(err, lang, 'reg.failed'));
    },
  });

  if (terms.isLoading) return <AuthShell title={t('reg.title')}><Loading /></AuthShell>;
  if (terms.isError || !terms.data) {
    return <AuthShell title={t('reg.title')}><ErrorBox err={terms.error} onRetry={() => void terms.refetch()} /></AuthShell>;
  }

  const pt = terms.data;
  if (!pt.intakeOpen) {
    return (
      <AuthShell title={t('reg.closedTitle')}>
        <p className="text-sm text-[#44403a] leading-relaxed">{t('reg.closedBody')}</p>
        <button type="button" className="btn-primary w-full justify-center py-2.5 mt-5" onClick={() => go('login')}>{t('common.login')}</button>
      </AuthShell>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = registerError(form);
    if (err) { toast.error(m(err)); return; }
    setTaken(null);
    register.mutate(pt.version);
  };

  const toLogin = () => { setEmail(form.email.trim()); go('login'); };

  return (
    <AuthShell
      wide
      title={t('reg.title')}
      subtitle={
        <>
          {rich('reg.subtitle', {
            rate: <b className="text-[#1F1A13]"><bdi dir="ltr">{formatRate(pt.rateBps)}</bdi></b>,
            days: daysLabel(pt.holdDays, lang),
            every: daysLabel(pt.settlementEveryDays ?? SETTLEMENT_EVERY_DAYS, lang),
            min: formatSar(pt.minPayoutHalalas, lang),
          })}
          <span className="mt-2 flex items-center gap-1.5 rounded-xl bg-[#E4F1EA] text-[#1E7A52] text-[12.5px] font-semibold px-3 py-2">
            <Zap size={15} className="shrink-0" /> {t('reg.instant')}
          </span>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t('f.fullName')} required>
          <input className="input" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="name" maxLength={80} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={t('f.email')} required>
            <input type="email" dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" inputMode="email" />
          </Field>
          <Field label={t('f.phone')} required hint={t('f.phoneHint')}>
            {/* مفتاح الدولة + الرقم: جوالٌ من أيّ دولة، والسعودية افتراضاً */}
            <div className="flex gap-2" dir="ltr">
              <select aria-label={t('f.phoneCountry')} className="input font-semibold text-sm"
                style={{ width: 118, flex: '0 0 auto', paddingInline: '8px' }}
                value={form.phoneCountry} onChange={(e) => set('phoneCountry', e.target.value)}>
                <optgroup label={t('f.arabCountries')}>
                  {ARAB_DIAL.map((c) => <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>)}
                </optgroup>
                <optgroup label={t('f.otherCountries')}>
                  {WORLD_DIAL.map((c) => <option key={c.code} value={c.code}>{flagOf(c.code)} {c.dial} {lang === 'ar' ? c.ar : c.en}</option>)}
                </optgroup>
              </select>
              <input dir="ltr" className="input flex-1 min-w-0 text-left" value={form.phone}
                onChange={(e) => set('phone', e.target.value)} autoComplete="tel-national" inputMode="tel"
                placeholder={form.phoneCountry === 'SA' ? '5XXXXXXXX' : ''} maxLength={16} />
            </div>
          </Field>
        </div>
        {taken !== null && (
          <div role="alert" className="rounded-xl bg-[#FAEFD8] text-[#8A5A0B] text-[13px] leading-relaxed px-3 py-2.5 space-y-2">
            <p className="flex gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" /><span>{errorText(taken, lang, 'reg.emailTaken', 'reg.emailTaken')}</span></p>
            <button type="button" className="btn-secondary w-full justify-center py-2" onClick={toLogin}>{t('common.login')}</button>
          </div>
        )}
        <Field label={t('f.password')} required hint={t('f.passwordHint')}>
          <PasswordInput value={form.password} onChange={(v) => set('password', v)} autoComplete="new-password" />
        </Field>

        <Field label={t('reg.partnerType')} required>
          <PartnerTypePicker value={form.partnerType} onChange={(v) => set('partnerType', v)} label={t('reg.partnerType')} />
        </Field>
        {form.partnerType === 'company' && (
          <Field label={t('f.companyName')} required>
            <input className="input" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} autoComplete="organization" maxLength={COMPANY_NAME_MAX} />
          </Field>
        )}

        <div>
          <div className="label flex items-center justify-between">
            <span>{t('terms.label')}</span>
            <span className="text-[11px] text-[#8A8072]" dir="ltr">{pt.version}</span>
          </div>
          <ArabicTermsBody
            body={pt.body}
            className="max-h-56 overflow-y-auto rounded-xl border border-[#E0D7C6] bg-[#FAF7F0] p-3 text-[13px] leading-7 text-[#44403a]"
          />
          <div className="mt-2">
            <CheckRow checked={form.acceptTerms} onChange={(v) => set('acceptTerms', v)} required>
              {t('reg.acceptTerms')}
            </CheckRow>
          </div>
        </div>

        <CheckRow checked={form.marketingConsent} onChange={(v) => set('marketingConsent', v)}>
          {t('reg.marketingOptional')}
        </CheckRow>

        <SubmitButton busy={register.isPending}>{t('reg.submit')}</SubmitButton>
      </form>
      <p className="text-center text-sm text-[#6E6557] mt-5">
        {t('reg.haveAccount')} <LinkButton onClick={() => go('login')}>{t('reg.signIn')}</LinkButton>
      </p>
    </AuthShell>
  );
}

// ─────────────────────────── نسيت كلمة المرور ───────────────────────────

export function ForgotScreen({ go, email, setEmail }: NavProps) {
  const { t, lang, dir } = useAxT();
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => affiliateApi.forgot(email.trim().toLowerCase()),
    onSuccess: (message) => { setDoneMessage(message); setDone(true); },
    onError: (err) => toast.error(errorText(err, lang, 'mail.sendFailed')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) { toast.error(t('val.email')); return; }
    mutation.mutate();
  };

  if (done) {
    return (
      <AuthShell title={t('forgot.title')}>
        <div className="flex flex-col items-center text-center gap-3">
          <MailCheck size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{localizedServerText(lang, doneMessage, 'accepted.forgot')}</p>
          <p className="text-[12.5px] text-[#6E6557]">{t('mail.checkSpam')}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>{t('common.backToLogin')}</button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('forgot.title')} subtitle={t('forgot.subtitle')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('f.email')}>
          <input type="email" dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
        </Field>
        <SubmitButton busy={mutation.isPending}>{t('forgot.action')}</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('login')}>{t('common.backToLogin')}</LinkButton></p>
    </AuthShell>
  );
}

// ─────────────────────────── تعيين كلمة مرور جديدة ───────────────────────────

/**
 * تعيين كلمة مرور جديدة. رابط البريد إثباتٌ أقوى من كلمة المرور، فالخادم يُعيد جلسةً ويفكّ
 * القفل: يدخل صاحبها البوابة مباشرةً — هكذا يعود المُقفَل.
 * بلا جلسة في الردّ ⇒ شاشة «تم التغيير» والدخول كالمعتاد.
 */
export function ResetScreen({ go, token, onLoggedIn }: NavProps & { token: string; onLoggedIn: () => void }) {
  const { t, lang } = useAxT();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => affiliateApi.reset(token, password),
    onSuccess: (r) => {
      if (r?.token) {
        setToken(r.token);
        toast.success(t('reset.success'));
        onLoggedIn();
        return;
      }
      setDone(true);
    },
    onError: (err) => toast.error(errorText(err, lang, 'reset.invalid', httpStatus(err) === 400 ? 'reset.invalid' : undefined)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error(t('val.passwordMin')); return; }
    if (password.length > 128) { toast.error(t('val.passwordMax')); return; }
    mutation.mutate();
  };

  if (done) {
    return (
      <AuthShell title={t('reset.doneTitle')}>
        <div className="flex flex-col items-center text-center gap-3">
          <CheckCircle2 size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13]">{t('reset.doneBody')}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>{t('common.login')}</button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('reset.title')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('reset.newPassword')} hint={t('f.passwordHint')}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <SubmitButton busy={mutation.isPending}>{t('reset.save')}</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('forgot')}>{t('reset.requestNew')}</LinkButton></p>
    </AuthShell>
  );
}
