// ============================================================================
// شاشات ما قبل الجلسة: دخول · تسجيل · تأكيد البريد · نسيت كلمة المرور ·
// تعيين كلمة مرور جديدة · إعادة إرسال التأكيد.
// ردود التسجيل والاستعادة موحّدة (202) عمداً — لا تكشف هل البريد مسجّل.
// كل النصوص من قاموس البوابة (../i18n)؛ نصّ الشروط العربي يُعرض عربياً.
// ============================================================================
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, MailCheck, ShieldAlert, AlertCircle } from 'lucide-react';
import { affiliateApi, httpStatus, qk, setToken, shouldRetry } from '../api';
import { formatRate, formatSar } from '../format';
import {
  CITY_MAX, EMPTY_REGISTER, buildRegisterBody, isValidEmail, registerError, type RegisterForm,
} from '../validation';
import { clearRegisterDraft, loadRegisterDraft, saveRegisterDraft } from '../draft';
import { errorText, localizedServerText, verifyErrorKind } from '../errors';
import { useAxT, type AxKey } from '../i18n';
import {
  ArabicTermsBody, AuthShell, CheckRow, ErrorBox, Field, LinkButton, Loading, PasswordInput, Spinner, ltrFieldAlign,
} from '../ui';
import { verifyOutcome, type AuthView, type VerifyOutcome } from '../nav';
import type { UserStatus } from '../types';

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
  // كل فشلٍ في الدخول (كلمة مرور خاطئة، بريد مجهول، بريد غير مؤكَّد، قفل مؤقت) يُعيد 401
  // برسالة واحدة عمداً — فلا تفريع هنا على نصّها: تُعرض (مترجمةً لغير العربية)، ورابط
  // «لم تصلك رسالة التأكيد؟» ظاهر دائماً تحت النموذج.
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
          <LinkButton onClick={() => go('resend')}>{t('login.noVerifyMail')}</LinkButton>
        </div>
        <div className="pt-3 border-t border-[#F1EBDF] text-center">
          {t('login.notAmbassador')} <LinkButton onClick={() => go('register')}>{t('login.apply')}</LinkButton>
        </div>
      </div>
    </AuthShell>
  );
}

// ─────────────────────────── التسجيل ───────────────────────────

export function RegisterScreen({ go, email, setEmail }: NavProps) {
  const { t, m, rich, lang, dir } = useAxT();
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  // المسودّة تبقى في sessionStorage عبر الرجوع والتنقّل (بلا كلمة المرور ولا الموافقة على الشروط)
  const [form, setForm] = useState<RegisterForm>(() => {
    const draft = loadRegisterDraft();
    if (draft) return draft.email.trim() || !email ? draft : { ...draft, email };
    return { ...EMPTY_REGISTER, email };
  });
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  useEffect(() => { if (doneMessage === null) saveRegisterDraft(form); }, [form, doneMessage]);
  const set = <K extends keyof RegisterForm>(k: K, v: RegisterForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const register = useMutation({
    mutationFn: (version: string) => affiliateApi.register(buildRegisterBody(form, version)),
    onSuccess: (message) => { clearRegisterDraft(); setEmail(form.email.trim()); setDoneMessage(message ?? ''); },
    onError: (err) => {
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

  if (doneMessage !== null) {
    return (
      <AuthShell title={t('reg.doneTitle')}>
        <div className="flex flex-col items-center text-center gap-3">
          <MailCheck size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{localizedServerText(lang, doneMessage, 'accepted.register')}</p>
          <p className="text-[13px] text-[#6E6557] leading-relaxed">{t('reg.doneHint')}</p>
          <div className="flex flex-col gap-2 w-full mt-2">
            <button type="button" className="btn-primary w-full justify-center py-2.5" onClick={() => go('login')}>{t('reg.goLogin')}</button>
            <button type="button" className="btn-secondary w-full justify-center py-2.5" onClick={() => go('resend')}>{t('reg.resendCta')}</button>
          </div>
        </div>
      </AuthShell>
    );
  }

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
    register.mutate(pt.version);
  };

  return (
    <AuthShell
      wide
      title={t('reg.title')}
      subtitle={rich('reg.subtitle', {
        rate: <b className="text-[#1F1A13]"><bdi dir="ltr">{formatRate(pt.rateBps)}</bdi></b>,
        days: pt.holdDays,
        min: formatSar(pt.minPayoutHalalas, lang),
      })}
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
            <input dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" inputMode="tel" placeholder="05XXXXXXXX" maxLength={16} />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={t('f.city')}>
            <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX} />
          </Field>
          <Field label={t('f.password')} required hint={t('f.passwordHint')}>
            <PasswordInput value={form.password} onChange={(v) => set('password', v)} autoComplete="new-password" />
          </Field>
        </div>
        <Field label={t('f.vatOptional')} hint={t('f.vatHint')}>
          <input dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} inputMode="numeric" maxLength={17} />
        </Field>

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

// ─────────────────────────── تأكيد البريد ───────────────────────────

/**
 * نتيجة كل رمز تأكيدٍ ناجح تُحفظ لعمر الصفحة: الرمز يُستهلك مرّةً في الخادم، والشاشة
 * قد تُركَّب ثانيةً بعودة السفير إليها بزرّ الرجوع — فتُعرض النتيجة بدل طلب كلمة المرور.
 */
const verifiedTokens = new Map<string, UserStatus>();

const VERIFY_COPY: Record<VerifyOutcome, { title: AxKey; body: AxKey }> = {
  review: { title: 'verify.review.title', body: 'verify.review.body' },
  approved: { title: 'verify.approved.title', body: 'verify.approved.body' },
  already: { title: 'verify.already.title', body: 'verify.already.body' },
};

/**
 * تأكيد البريد يطلب **كلمة المرور التي اختارها المتقدّم عند التسجيل**: البريد يُثبت ملكية
 * الصندوق، وكلمة المرور تُثبت أنّ صاحب الصندوق هو صاحب الطلب. لا إرسال تلقائي عند الفتح.
 */
export function VerifyScreen({ go, token }: NavProps & { token: string }) {
  const { t, lang } = useAxT();
  const cached = verifiedTokens.get(token);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<UserStatus | null>(cached ?? null);
  const [failure, setFailure] = useState<{ kind: 'mismatch' | 'invalid'; err: unknown } | null>(null);

  const verify = useMutation({
    mutationFn: () => affiliateApi.verifyEmail(token, password),
    onSuccess: (r) => {
      const st = (r?.status ?? 'pending_review') as UserStatus;
      verifiedTokens.set(token, st);
      setFailure(null);
      setStatus(st);
    },
    onError: (err) => {
      const kind = verifyErrorKind(err);
      if (kind === 'retry') { toast.error(errorText(err, lang, 'verify.retry')); return; }
      setFailure({ kind, err });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) { toast.error(t('verify.enterPassword')); return; }
    setFailure(null);
    verify.mutate();
  };

  if (status) {
    const copy = VERIFY_COPY[verifyOutcome(status)];
    return (
      <AuthShell title={t(copy.title)}>
        <div className="flex flex-col items-center text-center gap-3">
          <CheckCircle2 size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{t(copy.body)}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>{t('common.login')}</button>
        </div>
      </AuthShell>
    );
  }

  if (failure?.kind === 'invalid') {
    return (
      <AuthShell title={t('verify.failedTitle')}>
        <div className="flex flex-col items-center text-center gap-3">
          <ShieldAlert size={40} className="text-[#C0392B]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{errorText(failure.err, lang, 'verify.invalid', 'verify.invalid')}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('resend')}>{t('verify.sendNew')}</button>
          <button type="button" className="btn-secondary w-full justify-center py-2.5" onClick={() => go('login')}>{t('common.login')}</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('verify.title')} subtitle={t('verify.subtitle')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('f.password')}>
          <PasswordInput value={password} onChange={(v) => { setPassword(v); if (failure) setFailure(null); }} autoComplete="current-password" />
        </Field>
        {failure?.kind === 'mismatch' && (
          <div role="alert" className="rounded-xl bg-[#FAEFD8] text-[#8A5A0B] text-[13px] leading-relaxed px-3 py-2.5 space-y-2">
            <p className="flex gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" /><span>{errorText(failure.err, lang, 'verify.mismatch', 'verify.mismatch')}</span></p>
            <button type="button" className="btn-secondary w-full justify-center py-2" onClick={() => go('register')}>{t('login.apply')}</button>
          </div>
        )}
        <SubmitButton busy={verify.isPending}>{t('verify.submit')}</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('resend')}>{t('verify.sendNew')}</LinkButton></p>
    </AuthShell>
  );
}

// ─────────────────────────── بريد فقط (نسيت · إعادة إرسال) ───────────────────────────

function EmailOnlyScreen({
  go, email, setEmail, title, subtitle, action, accepted, send,
}: NavProps & { title: AxKey; subtitle: AxKey; action: AxKey; accepted: AxKey; send: (email: string) => Promise<string | null> }) {
  const { t, lang, dir } = useAxT();
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => send(email.trim().toLowerCase()),
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
      <AuthShell title={t(title)}>
        <div className="flex flex-col items-center text-center gap-3">
          <MailCheck size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{localizedServerText(lang, doneMessage, accepted)}</p>
          <p className="text-[12.5px] text-[#6E6557]">{t('mail.checkSpam')}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>{t('common.backToLogin')}</button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t(title)} subtitle={t(subtitle)}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('f.email')}>
          <input type="email" dir="ltr" className={`input ${ltrFieldAlign(dir)}`} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
        </Field>
        <SubmitButton busy={mutation.isPending}>{t(action)}</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('login')}>{t('common.backToLogin')}</LinkButton></p>
    </AuthShell>
  );
}

export function ForgotScreen(props: NavProps) {
  return (
    <EmailOnlyScreen
      {...props}
      title="forgot.title"
      subtitle="forgot.subtitle"
      action="forgot.action"
      accepted="accepted.forgot"
      send={affiliateApi.forgot}
    />
  );
}

export function ResendScreen(props: NavProps) {
  return (
    <EmailOnlyScreen
      {...props}
      title="resend.title"
      subtitle="resend.subtitle"
      action="resend.action"
      accepted="accepted.resend"
      send={affiliateApi.resendVerification}
    />
  );
}

// ─────────────────────────── تعيين كلمة مرور جديدة ───────────────────────────

/**
 * تعيين كلمة مرور جديدة. رابط البريد إثباتٌ أقوى من كلمة المرور، فالخادم يُعيد جلسةً لكل
 * حسابٍ مؤكَّد البريد ويفكّ القفل: يدخل صاحبها البوابة مباشرةً — هكذا يعود المُقفَل.
 * بلا جلسة (بريد لم يُؤكَّد بعد) ⇒ شاشة «تم التغيير» والدخول كالمعتاد.
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
