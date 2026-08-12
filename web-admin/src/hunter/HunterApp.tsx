import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios, { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import {
  Eye, EyeOff, Mail, Lock, ArrowLeft, LogOut, Crosshair, Search,
  Download, X, Check, Loader2, Globe, Phone, AtSign, Users,
} from 'lucide-react';
import { BrandIcon, BrandWordmark } from '../components/BrandLogo';

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
  monthlyQuota: number;
  usedThisMonth: number;
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
        {label}{hint && <span className="font-normal text-[#9A8F7E] text-xs"> — {hint}</span>}
      </label>
      <div className="w-full min-h-[42px] flex flex-wrap gap-1.5 items-center border border-[#E0D7C6] rounded-xl px-2 py-1.5 bg-white focus-within:ring-2 focus-within:ring-[#E15A30]/40 focus-within:border-[#E15A30]">
        {values.map(v => (
          <span key={v} className="inline-flex items-center gap-1 bg-[#FBEBE2] text-[#C94E28] rounded-lg ps-2 pe-1 py-0.5 text-xs font-medium">
            {v}
            <button type="button" aria-label={`حذف ${v}`} className="opacity-60 hover:opacity-100"
              onClick={() => onChange(values.filter(x => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[90px] border-0 outline-none text-sm bg-transparent py-1 text-[#1F1A13]"
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

// ============ شاشة الدخول ============

function HunterLogin({ onLogin }: { onLogin: (token: string, user: HunterUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('أدخل البريد وكلمة المرور'); return; }
    setLoading(true);
    try {
      const res = await hunterApi.post<{ success: boolean; token: string; user: HunterUser }>('/login', { email, password });
      const { token, user } = res.data;
      localStorage.setItem(TOKEN_KEY, token);
      onLogin(token, user);
      toast.success(`أهلاً ${user.name}`);
    } catch (err: unknown) {
      toast.error(errMessage(err, 'بيانات الدخول غير صحيحة'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] p-6" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8"><BrandWordmark iconSize={50} /></div>
        <h1 className="text-2xl font-bold text-[#1F1A13] text-center">لوحة صيد العملاء</h1>
        <p className="text-[#6E6557] mt-1.5 text-sm text-center">سجّل الدخول لبدء الصيد على الطلب</p>

        <form onSubmit={submit} className="space-y-4 mt-7">
          <div>
            <label className="label">البريد الإلكتروني</label>
            <div className="relative">
              <Mail size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
              <input type="email" className="input pr-9" placeholder="you@company.com" dir="ltr"
                value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" />
            </div>
          </div>

          <div>
            <label className="label">كلمة المرور</label>
            <div className="relative">
              <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
              <input type={showPass ? 'text' : 'password'} className="input pr-9 pl-9" placeholder="••••••••" dir="ltr"
                value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
              <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E] hover:text-[#1F1A13]"
                onClick={() => setShowPass(s => !s)}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading}
            className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-2">
            {loading ? <Loader2 size={18} className="animate-spin" /> : <>دخول <ArrowLeft size={17} /></>}
          </button>
        </form>
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
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('نُزّل CSV');
  };

  // ---- العرض ----
  if (booting && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0]" dir="rtl">
        <Loader2 size={26} className="animate-spin text-[#E15A30]" />
      </div>
    );
  }

  if (!user) return <HunterLogin onLogin={(_t, u) => { setUser(u); setBooting(false); }} />;

  const remaining = Math.max(0, user.monthlyQuota - user.usedThisMonth);

  const scoreBadge = (score?: number | null) => {
    if (score == null) return <span className="inline-flex justify-center min-w-[26px] px-2 py-0.5 rounded-lg text-xs font-bold bg-[#F1EBDF] text-[#9A8F7E]">–</span>;
    const cls = score >= 8
      ? 'bg-[#FBEBE2] text-[#C94E28]'
      : score >= 5 ? 'bg-[#E4F1EA] text-[#1E7A52]' : 'bg-[#F1EBDF] text-[#6E6557]';
    return <span className={`inline-flex justify-center min-w-[26px] px-2 py-0.5 rounded-lg text-xs font-bold ${cls}`}>{score}</span>;
  };

  return (
    <div className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" dir="rtl">
      {/* ===== الترويسة ===== */}
      <header className="bg-white border-b border-[#E9E1D3] sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-3 flex-wrap">
          <BrandIcon size={34} />
          <div>
            <p className="font-bold text-[15px] leading-tight">صيد العملاء المحتملين</p>
            <p className="text-xs text-[#9A8F7E]">{user.name}</p>
          </div>
          <span className="flex-1" />
          <span className="text-xs px-3 py-1.5 rounded-full bg-[#FAF7F0] border border-[#E9E1D3] text-[#6E6557]">
            {user.isOwner ? 'حصّة غير محدودة' : <>المتبقّي هذا الشهر: <b className="text-[#1F1A13]">{remaining}</b> / {user.monthlyQuota}</>}
          </span>
          <button onClick={logout} className="btn-secondary" title="خروج"><LogOut size={15} />خروج</button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-5 py-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ===== الإعداد ===== */}
        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="text-xs font-bold tracking-widest text-[#9A8F7E] uppercase">الهدف</h2>

            <div>
              <label className="label">وصف العميل المثالي <span className="font-normal text-[#9A8F7E] text-xs">— يُغذّي التأهيل الذكي</span></label>
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
                <input className="input font-mono" inputMode="numeric" value={perQuery}
                  onChange={e => setPerQuery(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </div>
              <div>
                <label className="label">سقف النتائج</label>
                <input className="input font-mono" inputMode="numeric" value={maxLeads}
                  onChange={e => setMaxLeads(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <h2 className="text-xs font-bold tracking-widest text-[#9A8F7E] uppercase">المصادر</h2>
            {SOURCES.map(s => {
              const isReady = s.keyless || ready[s.id] === true;
              const on = sources.includes(s.id);
              return (
                <button key={s.id} type="button" onClick={() => toggleSource(s.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-right transition-colors ${
                    on ? 'border-[#E15A30] bg-[#FBEBE2]/50' : 'border-[#E9E1D3] bg-[#FAF7F0] hover:bg-white'}`}>
                  <span className={`w-2 h-2 rounded-full flex-none ${isReady ? 'bg-[#1E7A52]' : 'bg-[#C9BEAC]'}`} />
                  <span className="font-semibold text-sm font-mono">{s.id}</span>
                  <span className="text-xs text-[#6E6557]">{s.label}</span>
                  {!isReady && !s.keyless && (
                    <span className="text-[10px] text-[#B8860B] border border-[#B8860B] rounded px-1.5 py-px">مفتاح ناقص</span>
                  )}
                  <span className="flex-1" />
                  <span className={`w-[18px] h-[18px] rounded-md grid place-items-center border ${
                    on ? 'bg-[#E15A30] border-[#E15A30] text-white' : 'border-[#DED5C4]'}`}>
                    {on && <Check size={12} />}
                  </span>
                </button>
              );
            })}

            {qualifyAvailable && (
              <button type="button" onClick={() => setQualify(v => !v)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-right transition-colors ${
                  qualify ? 'border-[#E15A30] bg-[#FBEBE2]/50' : 'border-[#E9E1D3] bg-[#FAF7F0]'}`}>
                <span className="font-semibold text-sm">تأهيل ذكي</span>
                <span className="text-xs text-[#6E6557]">تقييم كل عميل ١–١٠ مقابل وصف هدفك</span>
                <span className="flex-1" />
                <span className={`w-[18px] h-[18px] rounded-md grid place-items-center border ${
                  qualify ? 'bg-[#E15A30] border-[#E15A30] text-white' : 'border-[#DED5C4]'}`}>
                  {qualify && <Check size={12} />}
                </span>
              </button>
            )}
          </div>

          <button onClick={runHunt} disabled={hunting}
            className="w-full bg-[#E15A30] hover:bg-[#C94E28] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
            {hunting ? <><Loader2 size={18} className="animate-spin" /> يصطاد…</> : <><Crosshair size={17} /> صيد على الطلب</>}
          </button>
        </div>

        {/* ===== النتائج ===== */}
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="card p-4">
              <div className="flex items-center gap-2 text-[#9A8F7E] text-xs"><Users size={13} /> إجمالي العملاء</div>
              <p className="text-2xl font-bold mt-1 font-mono">{leads.length}</p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-[#9A8F7E] text-xs"><AtSign size={13} /> ببريد إلكتروني</div>
              <p className="text-2xl font-bold mt-1 font-mono text-[#1E7A52]">{withEmail}</p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-[#9A8F7E] text-xs"><Phone size={13} /> برقم هاتف</div>
              <p className="text-2xl font-bold mt-1 font-mono text-[#1E7A52]">{withPhone}</p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-[#9A8F7E] text-xs"><Globe size={13} /> مكرّرات دُمجت</div>
              <p className="text-2xl font-bold mt-1 font-mono text-[#E15A30]">{merged}</p>
            </div>
          </div>

          <div className="card mb-4">
            <div className="flex gap-3 flex-wrap items-center">
              <div className="relative flex-1 min-w-48">
                <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input className="input pr-9" placeholder="بحث في الأسماء…" value={q} onChange={e => setQ(e.target.value)} />
              </div>
              <select className="input w-40" value={minScore} onChange={e => setMinScore(Number(e.target.value))}>
                <option value={0}>كل الدرجات</option>
                <option value={5}>درجة ≥ ٥</option>
                <option value={7}>درجة ≥ ٧</option>
                <option value={8}>درجة ≥ ٨</option>
              </select>
              <div className="inline-flex rounded-xl border border-[#E0D7C6] overflow-hidden bg-white">
                {([['email', 'بريد'], ['phone', 'هاتف'], ['website', 'موقع']] as ReadonlyArray<[ContactFilter, string]>).map(([f, lbl]) => (
                  <button key={f} type="button" onClick={() => toggleContact(f)}
                    className={`px-3 py-2 text-xs font-semibold transition-colors ${
                      contactFilters.includes(f) ? 'bg-[#FBEBE2] text-[#C94E28]' : 'text-[#6E6557] hover:bg-[#FAF7F0]'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
              <button className="btn-secondary" onClick={exportCsv}><Download size={15} />تصدير CSV</button>
            </div>
          </div>

          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>درجة</th><th>الاسم</th><th>تواصل</th><th>المدينة</th><th>الدولة</th><th>المصدر</th>
                  </tr>
                </thead>
                <tbody>
                  {hunting && !leads.length ? (
                    <tr><td colSpan={6} className="text-center py-12 text-gray-400">جاري الصيد…</td></tr>
                  ) : !shown.length ? (
                    <tr><td colSpan={6} className="text-center py-12 text-gray-400">
                      {leads.length ? 'لا نتائج تطابق الفلتر — خفّف الفلاتر أعلاه' : 'لا عملاء بعد — اضبط الهدف وابدأ الصيد'}
                    </td></tr>
                  ) : shown.map(l => (
                    <tr key={l.id}>
                      <td>{scoreBadge(l.score)}</td>
                      <td>
                        <p className="font-medium text-gray-800">{l.name || '—'}</p>
                        {l.category && <p className="text-xs text-gray-400">{l.category}</p>}
                      </td>
                      <td className="font-mono text-xs" dir="ltr">
                        {l.email
                          ? l.email
                          : l.phone
                            ? l.phone
                            : l.website
                              ? <a href={l.website} target="_blank" rel="noopener noreferrer" className="text-[#E15A30] hover:underline">{domainOf(l.website)}</a>
                              : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="text-gray-600">{l.city || '-'}</td>
                      <td className="text-gray-600">{l.country || '-'}</td>
                      <td>
                        <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-[#FAF7F0] border border-[#E9E1D3] text-[#6E6557]">
                          {l.sourcesCsv || l.source || '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-center text-xs text-[#9A8F7E] mt-5">
            أداة صيد على الطلب — بلا مراسلة. اجمع وصدّر، ثم راسِل بأدواتك مع مراعاة الأنظمة (الموافقة وإلغاء الاشتراك).
          </p>
        </div>
      </div>
    </div>
  );
}
