// ============================================================================
// شاشات ما قبل الجلسة: دخول · تسجيل · تأكيد البريد · نسيت كلمة المرور ·
// تعيين كلمة مرور جديدة · إعادة إرسال التأكيد.
// ردود التسجيل والاستعادة موحّدة (202) عمداً — لا تكشف هل البريد مسجّل.
// ============================================================================
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, MailCheck, ShieldAlert, Megaphone, AlertCircle } from 'lucide-react';
import { affiliateApi, errMessage, httpStatus, qk, setToken, shouldRetry } from '../api';
import { formatRate, formatSar, riyadhToday } from '../format';
import {
  CITY_MAX, EMPTY_REGISTER, buildRegisterBody, isValidEmail, registerError, type RegisterForm,
} from '../validation';
import { clearRegisterDraft, loadRegisterDraft, saveRegisterDraft } from '../draft';
import { verifyErrorKind } from '../errors';
import {
  AuthShell, CheckRow, ErrorBox, Field, LinkButton, Loading, PasswordInput, Spinner, Switch,
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
  const [password, setPassword] = useState('');
  // كل فشلٍ في الدخول (كلمة مرور خاطئة، بريد مجهول، بريد غير مؤكَّد، قفل مؤقت) يُعيد 401
  // برسالة واحدة عمداً — فلا تفريع هنا على نصّها: تُعرض كما هي، ورابط «لم تصلك رسالة
  // التأكيد؟» ظاهر دائماً تحت النموذج.
  const [failure, setFailure] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => affiliateApi.login(email.trim().toLowerCase(), password),
    onSuccess: (r) => {
      setFailure(null);
      setToken(r.token);
      onLoggedIn();
    },
    onError: (err) => setFailure(errMessage(err, 'تعذّر تسجيل الدخول')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email) || !password) { toast.error('أدخل البريد وكلمة المرور'); return; }
    setFailure(null);
    login.mutate();
  };

  return (
    <AuthShell title="دخول السفراء" subtitle="تابع رابطك وترشيحاتك وعمولاتك">
      <form onSubmit={submit} className="space-y-4">
        <Field label="البريد الإلكتروني">
          <input type="email" dir="ltr" className="input text-right" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" inputMode="email" />
        </Field>
        <Field label="كلمة المرور">
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {failure && (
          <div role="alert" className="flex gap-2 rounded-xl bg-[#FAEFD8] text-[#8A5A0B] text-[13px] leading-relaxed px-3 py-2.5">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{failure}</span>
          </div>
        )}
        <SubmitButton busy={login.isPending}>دخول</SubmitButton>
      </form>
      <div className="mt-5 space-y-2 text-sm text-[#6E6557]">
        <div className="flex justify-between gap-2 flex-wrap">
          <LinkButton onClick={() => go('forgot')}>نسيت كلمة المرور؟</LinkButton>
          <LinkButton onClick={() => go('resend')}>لم تصلك رسالة التأكيد؟</LinkButton>
        </div>
        <div className="pt-3 border-t border-[#F1EBDF] text-center">
          لست سفيراً بعد؟ <LinkButton onClick={() => go('register')}>قدّم طلب انضمام</LinkButton>
        </div>
      </div>
    </AuthShell>
  );
}

// ─────────────────────────── التسجيل ───────────────────────────

const DECLARATIONS: Array<{ key: keyof RegisterForm['declarations']; text: string }> = [
  { key: 'independent', text: 'أعمل مستقلاً بنفسي، ولست موظفاً أو وكيلاً أو ممثلاً لفيلد سيلز.' },
  { key: 'noSpam', text: 'لن أرسل رسائل جماعية أو غير مرغوب فيها، ولن أتواصل مع أحد بلا معرفة سابقة أو إذن.' },
  { key: 'disclose', text: 'سأُفصح بوضوح لكل من أحيله أنني أحصل على عمولة إن اشترك.' },
];

export function RegisterScreen({ go, email, setEmail }: NavProps) {
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  // المسودّة تبقى في sessionStorage عبر الرجوع والتنقّل (بلا كلمة المرور ولا الموافقة على الشروط)
  const [form, setForm] = useState<RegisterForm>(() => {
    const draft = loadRegisterDraft();
    if (draft) return draft.email.trim() || !email ? draft : { ...draft, email };
    return { ...EMPTY_REGISTER, declarations: { ...EMPTY_REGISTER.declarations }, email };
  });
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  useEffect(() => { if (!doneMessage) saveRegisterDraft(form); }, [form, doneMessage]);
  const set = <K extends keyof RegisterForm>(k: K, v: RegisterForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setDecl = (k: keyof RegisterForm['declarations'], v: boolean) =>
    setForm((f) => ({ ...f, declarations: { ...f.declarations, [k]: v } }));
  const today = riyadhToday();

  const register = useMutation({
    mutationFn: (version: string) => affiliateApi.register(buildRegisterBody(form, version)),
    onSuccess: (message) => { clearRegisterDraft(); setEmail(form.email.trim()); setDoneMessage(message); },
    onError: (err) => {
      const s = httpStatus(err);
      if (s === 409) {
        // صدر إصدار جديد من الشروط أثناء ملء النموذج — لا موافقة على نصٍّ لم يُقرأ
        set('acceptTerms', false);
        void terms.refetch();
        toast.error('صدر إصدار جديد من الشروط — راجعه ووافق عليه ثم أعد الإرسال');
        return;
      }
      if (s === 403) void terms.refetch();
      toast.error(errMessage(err, 'تعذّر إرسال الطلب'));
    },
  });

  if (doneMessage) {
    return (
      <AuthShell title="تم استلام طلبك">
        <div className="flex flex-col items-center text-center gap-3">
          <MailCheck size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{doneMessage}</p>
          <p className="text-[13px] text-[#6E6557] leading-relaxed">
            افتح الرابط في رسالة التأكيد وأدخل كلمة المرور التي اخترتها الآن، ثم يراجع فريقنا طلبك ويصلك القرار على بريدك.
          </p>
          <div className="flex flex-col gap-2 w-full mt-2">
            <button type="button" className="btn-primary w-full justify-center py-2.5" onClick={() => go('login')}>الذهاب لتسجيل الدخول</button>
            <button type="button" className="btn-secondary w-full justify-center py-2.5" onClick={() => go('resend')}>لم تصلك الرسالة؟ أعد الإرسال</button>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (terms.isLoading) return <AuthShell title="انضم إلى سفراء فيلد سيلز"><Loading /></AuthShell>;
  if (terms.isError || !terms.data) {
    return <AuthShell title="انضم إلى سفراء فيلد سيلز"><ErrorBox err={terms.error} onRetry={() => void terms.refetch()} /></AuthShell>;
  }

  const t = terms.data;
  if (!t.intakeOpen) {
    return (
      <AuthShell title="الانضمام مغلق حالياً">
        <p className="text-sm text-[#44403a] leading-relaxed">
          لا نستقبل طلبات سفراء جدد في الوقت الحالي. إن كان لديك حساب فيمكنك الدخول كالمعتاد.
        </p>
        <button type="button" className="btn-primary w-full justify-center py-2.5 mt-5" onClick={() => go('login')}>تسجيل الدخول</button>
      </AuthShell>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = registerError(form, today);
    if (err) { toast.error(err); return; }
    register.mutate(t.version);
  };

  return (
    <AuthShell
      wide
      title="انضم إلى سفراء فيلد سيلز"
      subtitle={
        <>
          عمولتك <b className="text-[#1F1A13]">{formatRate(t.rateBps)}</b> من مبلغ الدفعة الأولى المؤكَّدة (شاملة الضريبة) لكل منشأة تشترك عبرك،
          تُعتمد بعد {t.holdDays} يوماً من الدفع، وتُحوَّل يدوياً إلى حسابك البنكي متى بلغ رصيدك {formatSar(t.minPayoutHalalas)}.
          كل طلب يُراجع قبل القبول.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="الاسم الكامل" required>
          <input className="input" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="name" maxLength={80} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="البريد الإلكتروني" required>
            <input type="email" dir="ltr" className="input text-right" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" inputMode="email" />
          </Field>
          <Field label="رقم الجوال" required hint="جوال سعودي، مثل 05XXXXXXXX">
            <input dir="ltr" className="input text-right" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" inputMode="tel" placeholder="05XXXXXXXX" maxLength={16} />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="المدينة">
            <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={CITY_MAX} />
          </Field>
          <Field label="كلمة المرور" required hint="8 أحرف على الأقل">
            <PasswordInput value={form.password} onChange={(v) => set('password', v)} autoComplete="new-password" />
          </Field>
        </div>
        <Field label="الرقم الضريبي (اختياري)" hint="إن كنت مسجّلاً في ضريبة القيمة المضافة — 15 رقماً">
          <input dir="ltr" className="input text-right" value={form.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} inputMode="numeric" maxLength={17} />
        </Field>

        <Switch
          checked={form.publicPromoter}
          onChange={(v) => set('publicPromoter', v)}
          label="سأنشر عن فيلد سيلز علناً"
          hint="في حساباتي على التواصل الاجتماعي أو أي منصة عامة"
        />
        {form.publicPromoter && (
          <div className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2]/50 p-3 space-y-3">
            <p className="flex gap-2 text-[12.5px] text-[#7A3A20] leading-relaxed">
              <Megaphone size={16} className="shrink-0 mt-0.5" />
              <span>النشر العلني يتطلب ترخيص «موثوق» ساري المفعول، ووضع وسم «إعلان» بوضوح على كل منشور عن فيلد سيلز.</span>
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="رقم ترخيص موثوق" required>
                <input dir="ltr" className="input text-right" value={form.mawthooqNo} onChange={(e) => set('mawthooqNo', e.target.value)} maxLength={40} />
              </Field>
              <Field label="تاريخ انتهاء الترخيص" required>
                <input type="date" dir="ltr" className="input text-right" min={today} value={form.mawthooqExpiry} onChange={(e) => set('mawthooqExpiry', e.target.value)} />
              </Field>
            </div>
          </div>
        )}

        <div>
          <div className="label flex items-center justify-between">
            <span>شروط البرنامج</span>
            <span className="text-[11px] text-[#8A8072]" dir="ltr">{t.version}</span>
          </div>
          <div
            className="max-h-56 overflow-y-auto rounded-xl border border-[#E0D7C6] bg-[#FAF7F0] p-3 text-[13px] leading-7 text-[#44403a]"
            style={{ whiteSpace: 'pre-wrap' }}
            tabIndex={0}
          >
            {t.body}
          </div>
          <div className="mt-2">
            <CheckRow checked={form.acceptTerms} onChange={(v) => set('acceptTerms', v)} required>
              قرأت شروط البرنامج وأوافق عليها
            </CheckRow>
          </div>
        </div>

        <div className="rounded-xl border border-[#E9E1D3] p-3">
          <p className="text-[13px] font-bold text-[#1F1A13] mb-1">إقرارات السفير</p>
          {DECLARATIONS.map((d) => (
            <CheckRow key={d.key} checked={form.declarations[d.key]} onChange={(v) => setDecl(d.key, v)} required>
              {d.text}
            </CheckRow>
          ))}
        </div>

        <CheckRow checked={form.marketingConsent} onChange={(v) => set('marketingConsent', v)}>
          أوافق على تلقي رسائل عن البرنامج وتحديثاته (اختياري)
        </CheckRow>

        <SubmitButton busy={register.isPending}>إرسال طلب الانضمام</SubmitButton>
      </form>
      <p className="text-center text-sm text-[#6E6557] mt-5">
        لديك حساب؟ <LinkButton onClick={() => go('login')}>سجّل الدخول</LinkButton>
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

const VERIFY_COPY: Record<VerifyOutcome, { title: string; body: string }> = {
  review: { title: 'تم تأكيد بريدك', body: 'طلبك الآن قيد مراجعة فريق فيلد سيلز، وسيصلك بريد بالقرار.' },
  approved: { title: 'بريدك مؤكَّد وحسابك مقبول', body: 'يمكنك الآن الدخول إلى بوابة السفراء.' },
  already: { title: 'بريدك مؤكَّد مسبقاً', body: 'لا حاجة لتأكيده مرّةً أخرى — ادخل لمتابعة حالة حسابك.' },
};

/**
 * تأكيد البريد يطلب **كلمة المرور التي اختارها المتقدّم عند التسجيل**: البريد يُثبت ملكية
 * الصندوق، وكلمة المرور تُثبت أنّ صاحب الصندوق هو صاحب الطلب. لا إرسال تلقائي عند الفتح.
 */
export function VerifyScreen({ go, token }: NavProps & { token: string }) {
  const cached = verifiedTokens.get(token);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<UserStatus | null>(cached ?? null);
  const [failure, setFailure] = useState<{ kind: 'mismatch' | 'invalid'; message: string } | null>(null);

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
      if (kind === 'retry') { toast.error(errMessage(err, 'تعذّر تأكيد البريد — أعد المحاولة')); return; }
      setFailure({ kind, message: errMessage(err, kind === 'mismatch' ? 'كلمة المرور لا تطابق طلب الانضمام' : 'رابط التأكيد غير صالح أو منتهٍ') });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) { toast.error('أدخل كلمة المرور'); return; }
    setFailure(null);
    verify.mutate();
  };

  if (status) {
    const copy = VERIFY_COPY[verifyOutcome(status)];
    return (
      <AuthShell title={copy.title}>
        <div className="flex flex-col items-center text-center gap-3">
          <CheckCircle2 size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{copy.body}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>تسجيل الدخول</button>
        </div>
      </AuthShell>
    );
  }

  if (failure?.kind === 'invalid') {
    return (
      <AuthShell title="تعذّر تأكيد البريد">
        <div className="flex flex-col items-center text-center gap-3">
          <ShieldAlert size={40} className="text-[#C0392B]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{failure.message}</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('resend')}>أرسل رابط تأكيد جديداً</button>
          <button type="button" className="btn-secondary w-full justify-center py-2.5" onClick={() => go('login')}>تسجيل الدخول</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="تأكيد البريد" subtitle="أدخل كلمة المرور التي اخترتها عند التسجيل لتأكيد بريدك">
      <form onSubmit={submit} className="space-y-4">
        <Field label="كلمة المرور">
          <PasswordInput value={password} onChange={(v) => { setPassword(v); if (failure) setFailure(null); }} autoComplete="current-password" />
        </Field>
        {failure?.kind === 'mismatch' && (
          <div role="alert" className="rounded-xl bg-[#FAEFD8] text-[#8A5A0B] text-[13px] leading-relaxed px-3 py-2.5 space-y-2">
            <p className="flex gap-2"><AlertCircle size={16} className="shrink-0 mt-0.5" /><span>{failure.message}</span></p>
            <button type="button" className="btn-secondary w-full justify-center py-2" onClick={() => go('register')}>قدّم طلب انضمام</button>
          </div>
        )}
        <SubmitButton busy={verify.isPending}>تأكيد البريد</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('resend')}>أرسل رابط تأكيد جديداً</LinkButton></p>
    </AuthShell>
  );
}

// ─────────────────────────── بريد فقط (نسيت · إعادة إرسال) ───────────────────────────

function EmailOnlyScreen({
  go, email, setEmail, title, subtitle, action, send,
}: NavProps & { title: string; subtitle: string; action: string; send: (email: string) => Promise<string> }) {
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => send(email.trim().toLowerCase()),
    onSuccess: (msg) => setDoneMessage(msg),
    onError: (err) => toast.error(errMessage(err, 'تعذّر الإرسال')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) { toast.error('البريد الإلكتروني غير صحيح'); return; }
    m.mutate();
  };

  if (doneMessage) {
    return (
      <AuthShell title={title}>
        <div className="flex flex-col items-center text-center gap-3">
          <MailCheck size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13] leading-relaxed">{doneMessage}</p>
          <p className="text-[12.5px] text-[#6E6557]">تفقّد مجلد الرسائل غير المرغوب فيها إن لم تجدها.</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>العودة لتسجيل الدخول</button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={title} subtitle={subtitle}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="البريد الإلكتروني">
          <input type="email" dir="ltr" className="input text-right" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
        </Field>
        <SubmitButton busy={m.isPending}>{action}</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('login')}>العودة لتسجيل الدخول</LinkButton></p>
    </AuthShell>
  );
}

export function ForgotScreen(props: NavProps) {
  return (
    <EmailOnlyScreen
      {...props}
      title="استعادة كلمة المرور"
      subtitle="أدخل بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة."
      action="أرسل رابط الاستعادة"
      send={affiliateApi.forgot}
    />
  );
}

export function ResendScreen(props: NavProps) {
  return (
    <EmailOnlyScreen
      {...props}
      title="إعادة إرسال رسالة التأكيد"
      subtitle="أدخل البريد الذي سجّلت به وسنرسل رابط تأكيد جديداً."
      action="أعد الإرسال"
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
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const m = useMutation({
    mutationFn: () => affiliateApi.reset(token, password),
    onSuccess: (r) => {
      if (r?.token) {
        setToken(r.token);
        toast.success('تم تعيين كلمة المرور');
        onLoggedIn();
        return;
      }
      setDone(true);
    },
    onError: (err) => toast.error(errMessage(err, 'رابط الاستعادة غير صالح أو منتهٍ')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error('كلمة المرور 8 أحرف على الأقل'); return; }
    if (password.length > 128) { toast.error('كلمة المرور طويلة جداً'); return; }
    m.mutate();
  };

  if (done) {
    return (
      <AuthShell title="تم تغيير كلمة المرور">
        <div className="flex flex-col items-center text-center gap-3">
          <CheckCircle2 size={40} className="text-[#1E7A52]" />
          <p className="text-[15px] text-[#1F1A13]">يمكنك الآن الدخول بكلمة المرور الجديدة.</p>
          <button type="button" className="btn-primary w-full justify-center py-2.5 mt-2" onClick={() => go('login')}>تسجيل الدخول</button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="كلمة مرور جديدة">
      <form onSubmit={submit} className="space-y-4">
        <Field label="كلمة المرور الجديدة" hint="8 أحرف على الأقل">
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <SubmitButton busy={m.isPending}>حفظ كلمة المرور</SubmitButton>
      </form>
      <p className="text-center text-sm mt-5"><LinkButton onClick={() => go('forgot')}>اطلب رابطاً جديداً</LinkButton></p>
    </AuthShell>
  );
}
