import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios, { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import {
  Eye, EyeOff, Mail, Lock, ArrowLeft, LogOut, Search,
  Download, X, Check, Loader2, Globe, Phone, AtSign, Users,
} from 'lucide-react';

// ============ الأنواع ============

/** شكل العميل كما يعيده الخادم (عقد /api/hunter) — لا نوسّعه هنا حتى لا نكذب على الواجهة */
interface HunterLead {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  city?: string | null;
  country?: string | null;
  category?: string | null;
  score?: number | null;
  scoreNote?: string | null;
  source?: string | null;
  sourcesCsv?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

interface HunterUser {
  id: string;
  name: string;
  email: string;
  isOwner: boolean;
  quota: number;
  used: number;
  remaining: number;
}

interface HuntStats {
  found: number;
  added: number;
  merged: number;
  errors?: string[];
}

type ContactFilter = 'email' | 'phone' | 'website';

/** الهدف المحفوظ محلياً — يُعاد تحميله ليبدأ الصيد تلقائياً عند إعادة الفتح */
interface SavedTarget {
  description?: string;
  keywords?: string[];
  countries?: string[];
  cities?: string[];
  sources?: string[];
  perQuery?: number;
  maxLeads?: number;
  qualify?: boolean;
}

// ============ عميل الشبكة ============

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const TOKEN_KEY = 'hunter_token';
const TARGET_KEY = 'hunter_target_v1';

// عميل مستقلّ بمفتاح توكن خاص — لوحة الصيد أداة قائمة بذاتها ولا يجوز أن
// تتقاطع جلستها مع جلسة الأدمن أو المندوب على نفس المتصفّح.
const hunterApi = axios.create({
  baseURL: `${BASE}/hunter`,
  headers: { 'Content-Type': 'application/json' },
});

hunterApi.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** رسالة خطأ مفهومة من ردّ الخادم أو من الشبكة */
function errMessage(err: unknown, fallback: string): string {
  const ax = err as AxiosError<{ message?: string; error?: string }>;
  return ax?.response?.data?.message || ax?.response?.data?.error || fallback;
}

// ============ هوية HOOK B ============

/** خطّاف الصيد — عين + انحناءة + شوكة. اللون من currentColor. */
function HookMark({ size = 30, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <circle cx="20" cy="6.5" r="3" stroke="currentColor" strokeWidth="2.4" />
      <path d="M20 9.5 V17 A7 7 0 0 1 6 17 V14.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M6 14.5 L2.8 17.6 L7.4 18.4 Z" fill="currentColor" />
    </svg>
  );
}

/** الوردمارك الكامل: خطّاف + HOOK + شارة B */
function HookWordmark({ mark = 28, text = 22 }: { mark?: number; text?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5" dir="ltr">
      <span className="hb-mark" style={{ color: 'var(--catch)' }}><HookMark size={mark} /></span>
      <span className="inline-flex items-baseline gap-1.5">
        <span style={{ fontSize: text, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--ink)', fontFamily: 'var(--hb-sans)' }}>HOOK</span>
        <span className="hb-badge" style={{ fontSize: text * 0.62 }}>B</span>
      </span>
    </span>
  );
}

// نمط النطاق الكامل — معزول تحت .hookb حتى لا يرث ألوان فيلد سيلز ولا يؤثّر عليها.
const HOOKB_CSS = `
.hookb{
  --ink:#141A21; --ground:#EDF0F3; --card:#FFFFFF; --line:#E2E7EB; --line2:#EEF1F3;
  --muted:#6A7581; --catch:#0BA05E; --catch-ink:#067A47; --catch-soft:#E5F6EE;
  --brand:#0C1117; --hi-bg:#0BA05E; --hi-ink:#FFFFFF; --mid-bg:#EDF1F5; --mid-ink:#425263;
  --hb-sans:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",sans-serif;
  --hb-mono:ui-monospace,"Cascadia Code",Consolas,monospace;
  color:var(--ink); font-family:var(--hb-sans);
}
.hookb .hb-badge{ display:inline-grid; place-items:center; min-width:1.35em; height:1.35em; padding:0 .28em;
  background:var(--catch); color:#fff; border-radius:6px; font-weight:800; line-height:1; }
.hookb .hb-mono{ font-family:var(--hb-mono); font-variant-numeric:tabular-nums; }
.hookb .label{ display:block; font-size:12.5px; font-weight:600; margin-bottom:6px; color:var(--ink); }
.hookb .input{ width:100%; background:#fff; border:1px solid var(--line); border-radius:12px; padding:9px 12px;
  font-size:14px; color:var(--ink); outline:none; transition:border-color .15s, box-shadow .15s; }
.hookb .input:focus{ border-color:var(--catch); box-shadow:0 0 0 3px rgba(11,160,94,.14); }
.hookb select.input{ cursor:pointer; }
.hookb .card{ background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px;
  box-shadow:0 1px 2px rgba(20,26,33,.04), 0 10px 26px rgba(20,26,33,.05); }
.hookb .btn-primary{ background:var(--catch); color:#fff; font-weight:700; border:none; border-radius:12px;
  padding:12px 16px; display:inline-flex; align-items:center; justify-content:center; gap:8px; cursor:pointer;
  transition:filter .15s; font-size:14px; }
.hookb .btn-primary:hover{ filter:brightness(.94); }
.hookb .btn-primary:disabled{ opacity:.55; cursor:not-allowed; filter:none; }
.hookb .btn-ghost{ background:#fff; color:var(--ink); border:1px solid var(--line); border-radius:12px;
  padding:9px 13px; font-weight:600; font-size:13px; display:inline-flex; align-items:center; gap:7px; cursor:pointer;
  transition:border-color .15s; }
.hookb .btn-ghost:hover{ border-color:var(--catch); }
.hookb .eyebrow{ font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.hookb .chip{ display:inline-flex; align-items:center; gap:5px; background:var(--catch-soft); color:var(--catch-ink);
  border-radius:8px; padding:3px 5px 3px 9px; font-size:12.5px; font-weight:500; }
.hookb .chipbox{ width:100%; min-height:42px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;
  border:1px solid var(--line); border-radius:12px; padding:6px 8px; background:#fff; }
.hookb .chipbox:focus-within{ border-color:var(--catch); box-shadow:0 0 0 3px rgba(11,160,94,.14); }
.hookb .src{ width:100%; display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px;
  border:1px solid var(--line); background:var(--ground); text-align:right; cursor:pointer; transition:.15s; }
.hookb .src:hover{ background:#fff; }
.hookb .src.on{ border-color:var(--catch); background:var(--catch-soft); }
.hookb .src .dot{ width:8px; height:8px; border-radius:50%; flex:none; background:#C6CDD4; }
.hookb .src.ready .dot{ background:var(--catch); }
.hookb .check{ width:18px; height:18px; border-radius:6px; display:grid; place-items:center; border:1px solid var(--line); color:#fff; }
.hookb .src.on .check{ background:var(--catch); border-color:var(--catch); }
.hookb .stat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 15px;
  box-shadow:0 1px 2px rgba(20,26,33,.04); }
.hookb .stat .n{ font-family:var(--hb-mono); font-size:26px; font-weight:700; letter-spacing:-.02em; line-height:1; margin-top:6px; }
.hookb .score{ display:inline-flex; justify-content:center; min-width:26px; padding:2px 8px; border-radius:8px;
  font-family:var(--hb-mono); font-weight:700; font-size:12px; background:#F0F2F5; color:var(--muted); }
.hookb .score.hi{ background:var(--hi-bg); color:var(--hi-ink); }
.hookb .score.mid{ background:var(--mid-bg); color:var(--mid-ink); }
.hookb .seg{ display:inline-flex; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:#fff; }
.hookb .seg button{ padding:8px 13px; font-size:12.5px; font-weight:600; color:var(--muted); background:transparent; border:none; cursor:pointer; }
.hookb .seg button.on{ background:var(--catch-soft); color:var(--catch-ink); }
.hookb .srcpill{ font-family:var(--hb-mono); font-size:11px; padding:1px 6px; border-radius:6px;
  background:var(--ground); border:1px solid var(--line2); color:var(--muted); }
.hookb table{ width:100%; border-collapse:collapse; font-size:13.5px; }
.hookb thead th{ text-align:right; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
  font-weight:700; background:var(--ground); padding:10px 14px; position:sticky; top:0; white-space:nowrap; }
.hookb tbody td{ padding:11px 14px; border-top:1px solid var(--line2); white-space:nowrap; vertical-align:middle; }
.hookb tbody tr:hover td{ background:var(--ground); }
`;

// ============ المصادر ============

/** المصادر الخمسة بترتيب ثابت؛ «الجاهزيّة» تأتي من الخادم لأنّ المفاتيح لا تصل المتصفّح */
const SOURCES: ReadonlyArray<{ id: string; label: string; keyless?: boolean }> = [
  { id: 'osm', label: 'OpenStreetMap', keyless: true },
  { id: 'geoapify', label: 'Geoapify Places' },
  { id: 'tomtom', label: 'TomTom Search' },
  { id: 'serper', label: 'بحث الويب (Serper)' },
  { id: 'google', label: 'Google Places' },
];

const DEFAULT_SOURCES = ['osm', 'geoapify', 'serper'];

// ============ تخزين الهدف ============

function loadTarget(): SavedTarget | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    return raw ? (JSON.parse(raw) as SavedTarget) : null;
  } catch { return null; }
}

// ============ CSV ============

const CSV_COLS: ReadonlyArray<keyof HunterLead> = [
  'id', 'name', 'phone', 'email', 'website', 'city', 'country',
  'category', 'score', 'scoreNote', 'source', 'sourcesCsv', 'status', 'createdAt',
];

function csvCell(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(leads: HunterLead[]): string {
  const rows = leads.map(l => CSV_COLS.map(c => csvCell(l[c])).join(','));
  // الـBOM ضروري: بدونه يقرأ Excel العربية كرموز مشوّهة
  return `﻿${[CSV_COLS.join(','), ...rows].join('\r\n')}`;
}

function domainOf(website: string): string {
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

// ============ شريحة إدخال (chips) ============

interface ChipInputProps {
  label: string;
  hint?: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
}

function ChipInput({ label, hint, placeholder, values, onChange }: ChipInputProps) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const parts = draft.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) {
      const next = [...values];
      for (const p of parts) if (!next.includes(p)) next.push(p);
      onChange(next);
    }
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    // Backspace على حقل فارغ يحذف آخر شريحة — أسرع من ملاحقة زرّ الحذف الصغير
    else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
  };

  return (
    <div>
      <label className="label">
        {label}{hint && <span className="font-normal text-[color:var(--muted)] text-xs"> — {hint}</span>}
      </label>
      <div className="chipbox">
        {values.map(v => (
          <span key={v} className="chip">
            {v}
            <button type="button" aria-label={`حذف ${v}`} className="opacity-60 hover:opacity-100"
              onClick={() => onChange(values.filter(x => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[90px] border-0 outline-none text-sm bg-transparent py-1"
          style={{ color: 'var(--ink)' }}
          placeholder={placeholder}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          aria-label={label}
        />
      </div>
    </div>
  );
}

// ============ شاشة الدخول / إنشاء حساب ============

type AuthMode = 'login' | 'signup';

/** يقرأ الوضع من رابط الصفحة (?mode=signup) ليدخل مباشرةً على التسجيل من الصفحة التعريفية */
function initialMode(): AuthMode {
  try {
    const m = new URLSearchParams(window.location.search).get('mode');
    if (m === 'signup' || window.location.hash === '#signup') return 'signup';
  } catch { /* تجاهل */ }
  return 'login';
}

// خطوات إنشاء الحساب — تُعرض في اللوحة الجانبية لتوضّح المسار
const SIGNUP_STEPS = [
  { t: 'أنشئ حسابك', d: 'بريدك وكلمة مرور — بلا بطاقة' },
  { t: 'صِف عميلك المستهدف', d: 'وصف + كلمات بحث + مدن' },
  { t: 'اصطَد وصدّر', d: 'نتائج مقيّمة جاهزة بضغطة' },
];

function AuthScreen({ onLogin }: { onLogin: (token: string, user: HunterUser) => void }) {
  const [mode, setMode] = useState<AuthMode>(initialMode());
  const [loading, setLoading] = useState(false);

  // الحقول المشتركة
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);

  // حقول التسجيل
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agree, setAgree] = useState(false);

  const switchMode = (m: AuthMode) => {
    setMode(m); setStep(1); setPassword(''); setConfirm(''); setShowPass(false);
  };

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('أدخل البريد وكلمة المرور'); return; }
    setLoading(true);
    try {
      const res = await hunterApi.post<{ success: boolean; token: string; user: HunterUser }>('/login', { email, password });
      localStorage.setItem(TOKEN_KEY, res.data.token);
      onLogin(res.data.token, res.data.user);
      toast.success(`أهلاً ${res.data.user.name}`);
    } catch (err: unknown) {
      toast.error(errMessage(err, 'بيانات الدخول غير صحيحة'));
    } finally { setLoading(false); }
  };

  // الخطوة الأولى: تحقّق محلّي قبل الانتقال للثانية
  const nextStep = () => {
    if (name.trim().length < 2) { toast.error('أدخل اسمك'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim())) { toast.error('بريد إلكتروني غير صالح'); return; }
    setStep(2);
  };

  const doSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error('كلمة المرور ٨ أحرف على الأقل'); return; }
    if (password !== confirm) { toast.error('كلمتا المرور غير متطابقتين'); return; }
    if (!agree) { toast.error('يرجى الموافقة على الشروط'); return; }
    setLoading(true);
    try {
      const res = await hunterApi.post<{ success: boolean; token: string; user: HunterUser }>('/register',
        { name: name.trim(), email: email.trim(), password });
      localStorage.setItem(TOKEN_KEY, res.data.token);
      onLogin(res.data.token, res.data.user);
      toast.success(`تمّ إنشاء حسابك — أهلاً ${res.data.user.name}`);
    } catch (err: unknown) {
      toast.error(errMessage(err, 'تعذّر إنشاء الحساب'));
    } finally { setLoading(false); }
  };

  const passField = (
    <div>
      <label className="label">كلمة المرور</label>
      <div className="relative">
        <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
        <input type={showPass ? 'text' : 'password'} className="input pr-9 pl-9" placeholder="••••••••" dir="ltr"
          value={password} onChange={e => setPassword(e.target.value)}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
        <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }}
          onClick={() => setShowPass(s => !s)}>
          {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="hookb min-h-screen grid lg:grid-cols-[1.05fr_1fr]" dir="rtl">
      <style>{HOOKB_CSS}</style>

      {/* لوحة العلامة الداكنة — لحظة الهوية / خطوات التسجيل */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 overflow-hidden"
        style={{ background: 'var(--brand)', color: '#EAF0F0' }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.10, color: 'var(--catch)' }} aria-hidden="true">
          <div style={{ position: 'absolute', left: -40, bottom: -30, transform: 'rotate(-12deg)' }}><HookMark size={340} /></div>
        </div>
        <div className="relative flex items-center gap-3" style={{ color: '#fff' }}>
          <span style={{ color: 'var(--catch)' }}><HookMark size={34} /></span>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em' }} dir="ltr">
            HOOK <span className="hb-badge" style={{ fontSize: 17, verticalAlign: 'middle' }}>B</span>
          </span>
        </div>

        {mode === 'signup' ? (
          <div className="relative">
            <h2 style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.25 }}>افتح حسابك<br />في ٣ خطوات.</h2>
            <div className="mt-8 space-y-5">
              {SIGNUP_STEPS.map((s, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span style={{
                    flex: 'none', width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
                    fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13,
                    background: i + 1 <= step ? 'var(--catch)' : 'rgba(255,255,255,.08)',
                    color: i + 1 <= step ? '#fff' : '#8A97A0',
                    border: '1px solid ' + (i + 1 <= step ? 'var(--catch)' : 'rgba(255,255,255,.12)'),
                  }}>{i + 1}</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{s.t}</div>
                    <div style={{ color: '#8A97A0', fontSize: 13, marginTop: 2 }}>{s.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="relative">
            <h2 style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.25, letterSpacing: '-0.01em' }}>
              اصطَد عملاءك<br />المحتملين.
            </h2>
            <p style={{ color: '#9BA8AC', marginTop: 14, fontSize: 15, maxWidth: 380, lineHeight: 1.8 }}>
              منصّة صيد عملاء على الطلب — من عدّة مصادر، بإزالة تكرار ذكية وتقييم لكل عميل مقابل هدفك.
            </p>
          </div>
        )}

        <div className="relative flex items-center gap-2" style={{ color: '#6D7A7E', fontSize: 12.5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--catch)' }} />
          كل حساب يرى عملاءه وحده — عزل تامّ.
        </div>
      </div>

      {/* النموذج */}
      <div className="flex items-center justify-center p-6" style={{ background: 'var(--ground)' }}>
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex justify-center mb-8"><HookWordmark mark={32} text={26} /></div>

          {mode === 'login' ? (
            <>
              <p className="eyebrow">تسجيل الدخول</p>
              <h1 style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>مرحباً بعودتك</h1>
              <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>ادخل ببيانات حسابك لتكمل الصيد</p>

              <form onSubmit={doLogin} className="space-y-4 mt-7">
                <div>
                  <label className="label">البريد الإلكتروني</label>
                  <div className="relative">
                    <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                    <input type="email" className="input pr-9" placeholder="you@company.com" dir="ltr"
                      value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" />
                  </div>
                </div>
                {passField}
                <button type="submit" disabled={loading} className="btn-primary w-full py-3 mt-2">
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <>دخول <ArrowLeft size={17} /></>}
                </button>
              </form>

              <p className="text-center text-sm mt-6" style={{ color: 'var(--muted)' }}>
                ليس لديك حساب؟{' '}
                <button className="font-bold" style={{ color: 'var(--catch-ink)' }} onClick={() => switchMode('signup')}>أنشئ حساباً</button>
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="eyebrow">إنشاء حساب</p>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>الخطوة {step} من ٢</span>
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>
                {step === 1 ? 'ابدأ الآن' : 'أمّن حسابك'}
              </h1>
              <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>
                {step === 1 ? 'بياناتك الأساسية للبدء' : 'اختر كلمة مرور قويّة'}
              </p>

              {/* شريط تقدّم */}
              <div className="flex gap-2 mt-5">
                {[1, 2].map(n => (
                  <span key={n} style={{ flex: 1, height: 4, borderRadius: 4, background: n <= step ? 'var(--catch)' : 'var(--line)' }} />
                ))}
              </div>

              {step === 1 ? (
                <form onSubmit={e => { e.preventDefault(); nextStep(); }} className="space-y-4 mt-6">
                  <div>
                    <label className="label">الاسم الكامل</label>
                    <div className="relative">
                      <Users size={16} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                      <input type="text" className="input pr-9" placeholder="اسمك"
                        value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
                    </div>
                  </div>
                  <div>
                    <label className="label">البريد الإلكتروني</label>
                    <div className="relative">
                      <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                      <input type="email" className="input pr-9" placeholder="you@company.com" dir="ltr"
                        value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
                    </div>
                  </div>
                  <button type="submit" className="btn-primary w-full py-3 mt-2">التالي <ArrowLeft size={17} /></button>
                </form>
              ) : (
                <form onSubmit={doSignup} className="space-y-4 mt-6">
                  {passField}
                  <div>
                    <label className="label">تأكيد كلمة المرور</label>
                    <div className="relative">
                      <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                      <input type={showPass ? 'text' : 'password'} className="input pr-9" placeholder="••••••••" dir="ltr"
                        value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
                    <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--catch)' }} />
                    <span>أوافق على استخدام المنصّة لجمع بيانات أعمال عامّة، وأتحمّل مسؤولية أي مراسلة لاحقة وفق الأنظمة المعمول بها.</span>
                  </label>
                  <div className="flex gap-2 mt-2">
                    <button type="button" className="btn-ghost" onClick={() => setStep(1)}>رجوع</button>
                    <button type="submit" disabled={loading} className="btn-primary flex-1 py-3">
                      {loading ? <Loader2 size={18} className="animate-spin" /> : 'أنشئ حسابي'}
                    </button>
                  </div>
                </form>
              )}

              <p className="text-center text-sm mt-6" style={{ color: 'var(--muted)' }}>
                لديك حساب؟{' '}
                <button className="font-bold" style={{ color: 'var(--catch-ink)' }} onClick={() => switchMode('login')}>تسجيل الدخول</button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ اللوحة ============

export default function HunterApp() {
  const saved = useRef<SavedTarget | null>(loadTarget()).current;

  const [user, setUser] = useState<HunterUser | null>(null);
  const [booting, setBooting] = useState<boolean>(!!localStorage.getItem(TOKEN_KEY));

  // الهدف
  const [description, setDescription] = useState(saved?.description ?? '');
  const [keywords, setKeywords] = useState<string[]>(saved?.keywords ?? []);
  const [countries, setCountries] = useState<string[]>(saved?.countries ?? []);
  const [cities, setCities] = useState<string[]>(saved?.cities ?? []);
  const [sources, setSources] = useState<string[]>(saved?.sources?.length ? saved.sources : DEFAULT_SOURCES);
  const [perQuery, setPerQuery] = useState<number>(saved?.perQuery ?? 40);
  const [maxLeads, setMaxLeads] = useState<number>(saved?.maxLeads ?? 500);
  const [qualify, setQualify] = useState<boolean>(saved?.qualify ?? true);

  // جاهزية المصادر على الخادم (مفاتيح .env لا تصل المتصفّح)
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [qualifyAvailable, setQualifyAvailable] = useState(false);

  // النتائج
  const [leads, setLeads] = useState<HunterLead[]>([]);
  const [merged, setMerged] = useState(0);
  const [hunting, setHunting] = useState(false);

  // الفلاتر
  const [q, setQ] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [contactFilters, setContactFilters] = useState<ContactFilter[]>([]);

  // ---- الجلسة ----
  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setLeads([]);
    setMerged(0);
  }, []);

  const handleAuthError = useCallback((err: unknown) => {
    const status = (err as AxiosError)?.response?.status;
    if (status === 401 || status === 403) { logout(); toast.error('انتهت الجلسة — سجّل الدخول من جديد'); return true; }
    return false;
  }, [logout]);

  // استعادة الجلسة من التوكن المحفوظ
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    (async () => {
      try {
        const res = await hunterApi.get<{ success: boolean; user: HunterUser }>('/me');
        setUser(res.data.user);
      } catch {
        localStorage.removeItem(TOKEN_KEY);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // ---- الصيد ----
  const runHunt = useCallback(async () => {
    if (!keywords.length) { toast.error('أضِف كلمة بحث أولاً'); return; }
    if (!countries.length && !cities.length) { toast.error('أضِف دولة أو مدينة'); return; }
    setHunting(true);
    try {
      const res = await hunterApi.post<{ success: boolean; stats: HuntStats; leads: HunterLead[] }>('/hunt', {
        description, keywords, countries, cities, sources,
        perQuery, maxLeads, qualify: qualify && qualifyAvailable,
      });
      const { stats, leads: found } = res.data;
      setLeads(found || []);
      setMerged(stats?.merged ?? 0);
      const errCount = stats?.errors?.length ?? 0;
      toast.success(`تمّ: ${stats?.added ?? (found || []).length} عميل${errCount ? ` · ${errCount} خطأ مصدر` : ''}`);
      // الحصّة تُستهلك على الخادم — نحدّث المستخدم لنعرض المتبقّي الصحيح
      try {
        const me = await hunterApi.get<{ success: boolean; user: HunterUser }>('/me');
        setUser(me.data.user);
      } catch { /* عرض الحصّة ثانويّ — لا يستحق إفشال نتيجة صيد ناجحة */ }
    } catch (err: unknown) {
      if (!handleAuthError(err)) toast.error(errMessage(err, 'فشل الصيد'));
    } finally {
      setHunting(false);
    }
  }, [description, keywords, countries, cities, sources, perQuery, maxLeads, qualify, qualifyAvailable, handleAuthError]);

  // إعداد الخادم + العملاء المحفوظون، ثم صيد تلقائيّ إن كان هناك هدف محفوظ
  const autoHunted = useRef(false);
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const cfg = await hunterApi.get<{ success: boolean; sources: Record<string, boolean>; qualify: boolean }>('/config');
        setReady(cfg.data.sources || {});
        setQualifyAvailable(!!cfg.data.qualify);
      } catch { /* بلا إعداد نعرض المصادر كلّها بلا وسم جاهزية */ }
      try {
        const res = await hunterApi.get<{ success: boolean; leads: HunterLead[] }>('/leads');
        setLeads(res.data.leads || []);
      } catch (err: unknown) { handleAuthError(err); }

      // يبدأ تلقائياً فقط من هدفٍ **محفوظ** — لا من كلمة كتبها المستخدم للتوّ
      if (!autoHunted.current && saved?.keywords?.length && ((saved.countries?.length ?? 0) || (saved.cities?.length ?? 0))) {
        autoHunted.current = true;
        void runHunt();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // حفظ الهدف عند كل تغيير — كي تُستعاد الجلسة كما تركها المالك
  useEffect(() => {
    if (!user) return;
    try {
      const target: SavedTarget = { description, keywords, countries, cities, sources, perQuery, maxLeads, qualify };
      localStorage.setItem(TARGET_KEY, JSON.stringify(target));
    } catch { /* الحفظ رفاهية: امتلاء التخزين لا يجوز أن يعطّل اللوحة */ }
  }, [user, description, keywords, countries, cities, sources, perQuery, maxLeads, qualify]);

  // ---- الاشتقاقات ----
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads
      .filter(l => {
        if (minScore > 0 && (l.score == null || l.score < minScore)) return false;
        if (contactFilters.includes('email') && !l.email) return false;
        if (contactFilters.includes('phone') && !l.phone) return false;
        if (contactFilters.includes('website') && !l.website) return false;
        if (needle && !String(l.name || '').toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [leads, q, minScore, contactFilters]);

  const withEmail = useMemo(() => leads.filter(l => l.email).length, [leads]);
  const withPhone = useMemo(() => leads.filter(l => l.phone).length, [leads]);

  const toggleSource = (id: string) =>
    setSources(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));

  const toggleContact = (f: ContactFilter) =>
    setContactFilters(c => (c.includes(f) ? c.filter(x => x !== f) : [...c, f]));

  const exportCsv = () => {
    if (!shown.length) { toast.error('لا شيء للتصدير'); return; }
    const blob = new Blob([toCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hookb-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('نُزّل CSV');
  };

  // ---- العرض ----
  if (booting && !user) {
    return (
      <div className="hookb min-h-screen flex items-center justify-center" style={{ background: 'var(--ground)' }} dir="rtl">
        <style>{HOOKB_CSS}</style>
        <span style={{ color: 'var(--catch)' }}><Loader2 size={26} className="animate-spin" /></span>
      </div>
    );
  }

  if (!user) return <AuthScreen onLogin={(_t, u) => { setUser(u); setBooting(false); }} />;

  const remaining = user.remaining ?? Math.max(0, (user.quota || 0) - (user.used || 0));

  const scoreBadge = (score?: number | null) => {
    if (score == null) return <span className="score">–</span>;
    const cls = score >= 8 ? 'score hi' : score >= 5 ? 'score mid' : 'score';
    return <span className={cls}>{score}</span>;
  };

  return (
    <div className="hookb min-h-screen" style={{ background: 'var(--ground)' }} dir="rtl">
      <style>{HOOKB_CSS}</style>

      {/* ===== الترويسة ===== */}
      <header className="sticky top-0 z-20" style={{ background: '#fff', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-3 flex-wrap">
          <HookWordmark mark={26} text={20} />
          <span className="hidden sm:inline" style={{ color: 'var(--line)' }}>|</span>
          <span className="hidden sm:inline text-[13px]" style={{ color: 'var(--muted)' }}>{user.name}</span>
          <span className="flex-1" />
          <span className="text-xs px-3 py-1.5 rounded-full" style={{ background: 'var(--ground)', border: '1px solid var(--line)', color: 'var(--muted)' }}>
            {user.isOwner
              ? 'حصّة غير محدودة'
              : <>المتبقّي هذا الشهر: <b className="hb-mono" style={{ color: 'var(--ink)' }}>{remaining}</b> / {user.quota}</>}
          </span>
          <button onClick={logout} className="btn-ghost" title="خروج"><LogOut size={15} />خروج</button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-5 py-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ===== الإعداد ===== */}
        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="eyebrow">الهدف</h2>

            <div>
              <label className="label">وصف العميل المثالي <span className="font-normal text-xs" style={{ color: 'var(--muted)' }}>— يُغذّي التأهيل الذكي</span></label>
              <textarea className="input min-h-[72px] resize-y" value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="مثال: شركات توزيع مواد غذائية بالجملة لديها مندوبون ميدانيون" />
            </div>

            <ChipInput label="كلمات البحث" hint="Enter لإضافة كل كلمة" placeholder="أضِف كلمة…"
              values={keywords} onChange={setKeywords} />

            <div className="grid grid-cols-2 gap-3">
              <ChipInput label="الدول" placeholder="دولة…" values={countries} onChange={setCountries} />
              <ChipInput label="المدن" hint="اختياري" placeholder="مدينة…" values={cities} onChange={setCities} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">نتائج/استعلام</label>
                <input className="input hb-mono" inputMode="numeric" value={perQuery}
                  onChange={e => setPerQuery(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </div>
              <div>
                <label className="label">سقف النتائج</label>
                <input className="input hb-mono" inputMode="numeric" value={maxLeads}
                  onChange={e => setMaxLeads(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <h2 className="eyebrow">المصادر</h2>
            {SOURCES.map(s => {
              const isReady = s.keyless || ready[s.id] === true;
              const on = sources.includes(s.id);
              return (
                <button key={s.id} type="button" onClick={() => toggleSource(s.id)}
                  className={`src${on ? ' on' : ''}${isReady ? ' ready' : ''}`}>
                  <span className="dot" />
                  <span className="font-semibold text-sm hb-mono">{s.id}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{s.label}</span>
                  {!isReady && !s.keyless && (
                    <span className="text-[10px]" style={{ color: '#B8860B', border: '1px solid #B8860B', borderRadius: 4, padding: '0 6px' }}>مفتاح ناقص</span>
                  )}
                  <span className="flex-1" />
                  <span className="check">{on && <Check size={12} />}</span>
                </button>
              );
            })}

            {qualifyAvailable && (
              <button type="button" onClick={() => setQualify(v => !v)}
                className={`src${qualify ? ' on ready' : ''}`}>
                <span className="dot" />
                <span className="font-semibold text-sm">تأهيل ذكي</span>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>تقييم كل عميل ١–١٠ مقابل وصف هدفك</span>
                <span className="flex-1" />
                <span className="check">{qualify && <Check size={12} />}</span>
              </button>
            )}
          </div>

          <button onClick={runHunt} disabled={hunting} className="btn-primary w-full py-3">
            {hunting ? <><Loader2 size={18} className="animate-spin" /> يصطاد…</> : <><HookMark size={17} /> صيد على الطلب</>}
          </button>
        </div>

        {/* ===== النتائج ===== */}
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="stat">
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}><Users size={13} /> إجمالي العملاء</div>
              <p className="n">{leads.length}</p>
            </div>
            <div className="stat">
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}><AtSign size={13} /> ببريد إلكتروني</div>
              <p className="n" style={{ color: 'var(--catch-ink)' }}>{withEmail}</p>
            </div>
            <div className="stat">
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}><Phone size={13} /> برقم هاتف</div>
              <p className="n" style={{ color: 'var(--catch-ink)' }}>{withPhone}</p>
            </div>
            <div className="stat">
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}><Globe size={13} /> مكرّرات دُمجت</div>
              <p className="n">{merged}</p>
            </div>
          </div>

          <div className="card mb-4">
            <div className="flex gap-3 flex-wrap items-center">
              <div className="relative flex-1 min-w-48">
                <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
                <input className="input pr-9" placeholder="بحث في الأسماء…" value={q} onChange={e => setQ(e.target.value)} />
              </div>
              <select className="input w-40" value={minScore} onChange={e => setMinScore(Number(e.target.value))}>
                <option value={0}>كل الدرجات</option>
                <option value={5}>درجة ≥ ٥</option>
                <option value={7}>درجة ≥ ٧</option>
                <option value={8}>درجة ≥ ٨</option>
              </select>
              <div className="seg">
                {([['email', 'بريد'], ['phone', 'هاتف'], ['website', 'موقع']] as ReadonlyArray<[ContactFilter, string]>).map(([f, lbl]) => (
                  <button key={f} type="button" onClick={() => toggleContact(f)}
                    className={contactFilters.includes(f) ? 'on' : ''}>
                    {lbl}
                  </button>
                ))}
              </div>
              <button className="btn-ghost" onClick={exportCsv}><Download size={15} />تصدير CSV</button>
            </div>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>درجة</th><th>الاسم</th><th>تواصل</th><th>المدينة</th><th>الدولة</th><th>المصدر</th>
                  </tr>
                </thead>
                <tbody>
                  {hunting && !leads.length ? (
                    <tr><td colSpan={6} className="text-center py-12" style={{ color: 'var(--muted)' }}>جاري الصيد…</td></tr>
                  ) : !shown.length ? (
                    <tr><td colSpan={6} className="text-center py-12" style={{ color: 'var(--muted)' }}>
                      {leads.length ? 'لا نتائج تطابق الفلتر — خفّف الفلاتر أعلاه' : 'لا عملاء بعد — اضبط الهدف وابدأ الصيد'}
                    </td></tr>
                  ) : shown.map(l => (
                    <tr key={l.id}>
                      <td>{scoreBadge(l.score)}</td>
                      <td>
                        <p className="font-medium" style={{ color: 'var(--ink)' }}>{l.name || '—'}</p>
                        {l.category && <p className="text-xs" style={{ color: 'var(--muted)' }}>{l.category}</p>}
                      </td>
                      <td className="hb-mono text-xs" dir="ltr">
                        {l.email
                          ? l.email
                          : l.phone
                            ? l.phone
                            : l.website
                              ? <a href={l.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--catch-ink)' }} className="hover:underline">{domainOf(l.website)}</a>
                              : <span style={{ color: '#C6CDD4' }}>—</span>}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{l.city || '-'}</td>
                      <td style={{ color: 'var(--muted)' }}>{l.country || '-'}</td>
                      <td><span className="srcpill">{l.sourcesCsv || l.source || '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-center text-xs mt-5" style={{ color: 'var(--muted)' }}>
            HOOK B — صيد على الطلب بلا مراسلة. اجمع وصدّر، ثم راسِل بأدواتك مع مراعاة الأنظمة (الموافقة وإلغاء الاشتراك).
          </p>
        </div>
      </div>
    </div>
  );
}
