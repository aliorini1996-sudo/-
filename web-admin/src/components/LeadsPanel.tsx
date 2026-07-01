import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { leadApi } from '../api/client';
import { Lead, LeadActivity, LeadStats, LeadStage } from '../types';
import { formatDate } from '../utils/format';
import {
  X, Search, Plus, Download, Upload, Radar, Trophy, Bell, Target,
  Phone, Globe2, MapPin, Trash2, Sparkles, PhoneCall, StickyNote, ArrowRightLeft, RefreshCw, Mail, MessageCircle, Wand2,
} from 'lucide-react';
import toast from 'react-hot-toast';

const STAGES: LeadStage[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'];
const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'جديد', CONTACTED: 'تم التواصل', QUALIFIED: 'مؤهّل', PROPOSAL: 'عرض مُقدّم', WON: 'تم التحويل', LOST: 'مفقود',
};
const STAGE_CLS: Record<LeadStage, string> = {
  NEW: 'bg-slate-100 text-slate-700',
  CONTACTED: 'bg-blue-100 text-blue-700',
  QUALIFIED: 'bg-amber-100 text-amber-700',
  PROPOSAL: 'bg-purple-100 text-purple-700',
  WON: 'bg-green-100 text-green-700',
  LOST: 'bg-red-100 text-red-700',
};
const SOURCE_LABEL: Record<string, string> = {
  osm: 'خرائط OSM', geoapify: 'Geoapify', tomtom: 'TomTom', serper: 'بحث الويب', linkedin: 'LinkedIn',
  here: 'HERE Maps', google: 'Google Maps', apollo: 'Apollo', manual: 'يدوي', csv: 'استيراد', social: 'تواصل', api: 'API',
};

type Filters = {
  stage: string; source: string; q: string; dueOnly: boolean;
  hasEmail: boolean; hasPhone: boolean; hasWebsite: boolean; notEmailed: boolean; notWhatsapped: boolean;
};
const EMPTY_FILTERS: Filters = {
  stage: '', source: '', q: '', dueOnly: false, hasEmail: false, hasPhone: false, hasWebsite: false, notEmailed: false, notWhatsapped: false,
};
// يحوّل حالة الفلاتر إلى معاملات API (تُستخدم في القائمة والتصدير وعدّ البريد)
function toParams(f: Filters): Record<string, string | boolean> {
  const p: Record<string, string | boolean> = {};
  if (f.stage) p.stage = f.stage;
  if (f.source) p.source = f.source;
  if (f.q) p.q = f.q;
  if (f.dueOnly) p.dueOnly = true;
  if (f.hasEmail) p.hasEmail = true;
  if (f.hasPhone) p.hasPhone = true;
  if (f.hasWebsite) p.hasWebsite = true;
  if (f.notEmailed) p.emailed = 'false';
  if (f.notWhatsapped) p.whatsapped = 'false';
  return p;
}

export default function LeadsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showWhats, setShowWhats] = useState(false);
  const [showEnrich, setShowEnrich] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ['lead-stats'],
    queryFn: async () => (await leadApi.stats()).data.data as LeadStats,
  });

  const { data: leadsRes, isLoading } = useQuery({
    queryKey: ['leads', filters],
    queryFn: async () => {
      const res = await leadApi.list(toParams(filters));
      return res.data as { data: Lead[]; total: number };
    },
  });
  const leads = leadsRes?.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['lead-stats'] });
  };

  const exportCsv = async () => {
    const token = localStorage.getItem('sa_token');
    const qs = new URLSearchParams(
      Object.entries(toParams(filters)).map(([k, v]) => [k, String(v)]),
    ).toString();
    const endpoint = qs ? `${leadApi.exportUrl()}?${qs}` : leadApi.exportUrl();
    const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'leads.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#FAF7F0] overflow-y-auto" dir="rtl">
      {/* Header */}
      <header className="bg-[#1F1A13] text-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#E15A30] flex items-center justify-center"><Target size={20} /></div>
            <div>
              <h1 className="font-bold">العملاء المحتملون</h1>
              <p className="text-slate-400 text-xs">صيد شركات التوزيع حول العالم وتتبّع تحويلها لمشتركين</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="text-slate-300 hover:text-white p-2" title="تحديث"><RefreshCw size={18} /></button>
            <button onClick={onClose} className="text-slate-300 hover:text-white flex items-center gap-1 text-sm"><X size={18} /> إغلاق</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <Kpi icon={Target} label="إجمالي العملاء المحتملين" value={stats?.total ?? 0} color="bg-[#E15A30]" />
          <Kpi icon={Trophy} label="تم تحويلهم" value={stats?.won ?? 0} color="bg-green-600" />
          <Kpi icon={Sparkles} label="نسبة التحويل" value={`${stats?.conversion ?? 0}%`} color="bg-purple-600" />
          <Kpi icon={Bell} label="متابعات مستحقّة" value={stats?.due ?? 0} color="bg-amber-500" />
        </div>

        {/* Funnel */}
        <div className="card mb-5">
          <p className="text-sm font-bold text-gray-700 mb-3">قمع المبيعات</p>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
            {STAGES.map((s) => {
              const count = stats?.stages?.[s] ?? 0;
              const active = filters.stage === s;
              return (
                <button
                  key={s}
                  onClick={() => setFilters((f) => ({ ...f, stage: active ? '' : s }))}
                  className={`rounded-lg p-3 text-center border transition ${active ? 'border-[#E15A30] ring-1 ring-[#E15A30]' : 'border-[#E9E1D3]'} ${STAGE_CLS[s]}`}
                >
                  <div className="text-2xl font-bold">{count}</div>
                  <div className="text-xs">{STAGE_LABEL[s]}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="بحث بالاسم/المدينة/الدولة/الهاتف..."
              className="input pr-9"
            />
          </div>
          <select value={filters.source} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))} className="input w-auto">
            <option value="">كل المصادر</option>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button
            onClick={() => setFilters((f) => ({ ...f, dueOnly: !f.dueOnly }))}
            className={`px-3 py-2 rounded-lg text-sm border ${filters.dueOnly ? 'bg-amber-50 border-amber-300 text-amber-700' : 'border-[#E9E1D3] text-gray-600'}`}
          >
            <Bell size={14} className="inline ml-1" /> المستحقّة
          </button>
          <button onClick={() => setShowSearch(true)} className="btn-primary"><Radar size={16} /> بحث آلي</button>
          <button onClick={() => setShowEnrich(true)} className="px-3 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700"><Wand2 size={14} className="inline ml-1" /> إثراء البيانات</button>
          <button onClick={() => setShowEmail(true)} className="px-3 py-2 rounded-lg text-sm bg-[#1E7A52] text-white hover:bg-[#1a6a47]"><Mail size={14} className="inline ml-1" /> بريد تسويقي</button>
          <button onClick={() => setShowWhats(true)} className="px-3 py-2 rounded-lg text-sm bg-[#25D366] text-white hover:bg-[#1eb356]"><MessageCircle size={14} className="inline ml-1" /> واتساب تسويقي</button>
          <button onClick={() => setShowAdd(true)} className="px-3 py-2 rounded-lg text-sm border border-[#E9E1D3] text-gray-700 hover:bg-white"><Plus size={14} className="inline ml-1" /> إضافة</button>
          <ImportButton onDone={refresh} />
          <button onClick={exportCsv} className="px-3 py-2 rounded-lg text-sm border border-[#E9E1D3] text-gray-700 hover:bg-white"><Download size={14} className="inline ml-1" /> تصدير</button>
        </div>

        {/* Availability filter chips */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-gray-500">تصفية:</span>
          <FilterChip active={filters.hasEmail} onClick={() => setFilters((f) => ({ ...f, hasEmail: !f.hasEmail }))} label="متوفر بريد" />
          <FilterChip active={filters.hasPhone} onClick={() => setFilters((f) => ({ ...f, hasPhone: !f.hasPhone }))} label="متوفر رقم" />
          <FilterChip active={filters.hasWebsite} onClick={() => setFilters((f) => ({ ...f, hasWebsite: !f.hasWebsite }))} label="متوفر موقع" />
          <FilterChip active={filters.notEmailed} onClick={() => setFilters((f) => ({ ...f, notEmailed: !f.notEmailed }))} label="لم يُراسَل بريد" />
          <FilterChip active={filters.notWhatsapped} onClick={() => setFilters((f) => ({ ...f, notWhatsapped: !f.notWhatsapped }))} label="لم يُراسَل واتساب" />
          {(filters.hasEmail || filters.hasPhone || filters.hasWebsite || filters.notEmailed || filters.notWhatsapped || filters.dueOnly || filters.stage || filters.source || filters.q) && (
            <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-xs text-[#E15A30] hover:underline mr-1">مسح الكل</button>
          )}
        </div>

        {/* List */}
        <div className="card p-0 overflow-hidden">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>الاسم</th><th>الدولة/المدينة</th><th>النوع</th>
                  <th>الهاتف</th><th>البريد</th>
                  <th className="text-center">الملاءمة</th><th className="text-center">المصدر</th><th>المرحلة</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="text-center py-10 text-gray-400">جارٍ التحميل...</td></tr>
                ) : leads.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-10 text-gray-400">لا عملاء محتملون بعد — ابدأ بـ«بحث آلي» 🛰️</td></tr>
                ) : leads.map((l) => (
                  <tr key={l.id} className="cursor-pointer hover:bg-[#FBEBE2]/40" onClick={() => setSelected(l.id)}>
                    <td className="font-medium text-gray-800">{l.name}</td>
                    <td className="text-sm text-gray-600">
                      {l.country || '—'}{l.city ? ` · ${l.city}` : ''} {l.countryCode ? <span className="text-gray-400">({l.countryCode})</span> : ''}
                    </td>
                    <td className="text-sm text-gray-500">{l.category || '—'}</td>
                    <td className="text-sm text-gray-600">{l.phone ? <span dir="ltr" className="inline-block">{l.phone}</span> : <span className="text-gray-300">—</span>}</td>
                    <td className="text-sm">{l.email ? <a href={`mailto:${l.email}`} dir="ltr" className="inline-block max-w-[180px] truncate align-bottom text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>{l.email}</a> : <span className="text-gray-300">—</span>}</td>
                    <td className="text-center">{l.score != null ? <ScorePill score={l.score} /> : <span className="text-gray-300">—</span>}</td>
                    <td className="text-center"><span className="badge bg-slate-100 text-slate-600">{SOURCE_LABEL[l.source] || l.source}</span></td>
                    <td><span className={`badge ${STAGE_CLS[l.stage]}`}>{STAGE_LABEL[l.stage]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {leadsRes && <div className="px-4 py-2 text-xs text-gray-400 border-t border-[#E9E1D3]">إجمالي مطابق: {leadsRes.total}</div>}
        </div>
      </div>

      {selected && <LeadDrawer id={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} onDone={refresh} />}
      {showEmail && <EmailModal filters={filters} onClose={() => setShowEmail(false)} onDone={refresh} />}
      {showWhats && <WhatsAppModal filters={filters} onClose={() => setShowWhats(false)} onDone={refresh} />}
      {showEnrich && <EnrichModal filters={filters} onClose={() => setShowEnrich(false)} onDone={refresh} />}
      {showAdd && <AddLeadModal onClose={() => setShowAdd(false)} onDone={refresh} />}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, color }: { icon: typeof Target; label: string; value: string | number; color: string }) {
  return (
    <div className="card flex items-center gap-3">
      <div className={`w-11 h-11 rounded-lg ${color} text-white flex items-center justify-center`}><Icon size={22} /></div>
      <div>
        <div className="text-xl font-bold text-gray-800">{value}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs border transition ${active ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white border-[#E9E1D3] text-gray-600 hover:border-[#E15A30]'}`}
    >
      {label}
    </button>
  );
}

function ScorePill({ score }: { score: number }) {
  const cls = score >= 8 ? 'bg-green-100 text-green-700' : score >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
  return <span className={`badge ${cls}`}>{score}/10</span>;
}

// ----------------------------- بحث آلي (عدّة مصادر + عدّة أنشطة) ----------------------------- //
const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'osm', label: 'OpenStreetMap · بلا مفتاح' },
  { value: 'geoapify', label: 'Geoapify · هواتف أنظف' },
  { value: 'tomtom', label: 'TomTom · أماكن تجارية' },
  { value: 'serper', label: 'بحث الويب · مواقع الشركات' },
  { value: 'linkedin', label: 'LinkedIn · صفحات الشركات' },
];

function SearchModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [providers, setProviders] = useState<string[]>(['osm', 'geoapify']);
  const [queriesText, setQueriesText] = useState('تجارة جملة\nموزّع مواد غذائية');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [qualify, setQualify] = useState(true);
  const [enrich, setEnrich] = useState(true);
  const [enrichHunter, setEnrichHunter] = useState(false);

  // أي المصادر جاهزة (لها مفتاح)؟
  const { data: ready } = useQuery({
    queryKey: ['sources-status'],
    queryFn: async () => (await leadApi.sourcesStatus()).data.data as Record<string, boolean>,
  });
  const isReady = (v: string) => ready?.[v] ?? (v === 'osm');
  // إزالة أي مصدر مختار غير جاهز تلقائياً عند معرفة الحالة
  useEffect(() => {
    if (ready) setProviders((ps) => ps.filter((p) => isReady(p)));
  }, [ready]);

  const queries = queriesText.split(/[\n,،]/).map((s) => s.trim()).filter(Boolean);
  const combos = providers.length * queries.length;

  const toggleProvider = (v: string) => {
    if (!isReady(v)) return;
    setProviders((ps) => (ps.includes(v) ? ps.filter((p) => p !== v) : [...ps, v]));
  };

  const mutation = useMutation({
    mutationFn: () => leadApi.search({
      providers, queries, country: country || undefined, city: city || undefined, qualify, enrich, enrichHunter,
    }),
    onSuccess: (res) => {
      const { found, imported, duplicates, enrichedEmail, errors } = res.data.data as {
        found: number; imported: number; duplicates: number; enrichedEmail?: number; errors?: string[];
      };
      toast.success(`نتائج: ${found} · جديد: ${imported} · مكرّر: ${duplicates}${enrichedEmail ? ` · بريد مُثرى: ${enrichedEmail}` : ''}`);
      if (errors && errors.length) toast.error(`تعذّر بعض المصادر: ${errors.join(' | ')}`, { duration: 6000 });
      onDone();
      if (imported > 0) onClose();
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'فشل البحث'),
  });

  return (
    <Modal title="بحث آلي عن عملاء محتملين" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="label">المصادر (يمكن اختيار أكثر من واحد)</label>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDER_OPTIONS.map((o) => {
              const rdy = isReady(o.value);
              return (
                <label key={o.value} title={rdy ? '' : 'يتطلب مفتاحاً في الخادم'}
                  className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 ${!rdy ? 'opacity-50 cursor-not-allowed border-[#E9E1D3]' : providers.includes(o.value) ? 'border-[#E15A30] bg-[#FBEBE2]/40 cursor-pointer' : 'border-[#E9E1D3] cursor-pointer'}`}>
                  <input type="checkbox" checked={providers.includes(o.value)} disabled={!rdy} onChange={() => toggleProvider(o.value)} />
                  <span className="text-gray-700">{o.label}</span>
                  {!rdy && <span className="text-[10px] text-red-500 mr-auto">يتطلب مفتاحاً</span>}
                </label>
              );
            })}
          </div>
        </div>
        <div>
          <label className="label">أنواع الأنشطة (نشاط بكل سطر أو مفصولة بفاصلة)</label>
          <textarea value={queriesText} onChange={(e) => setQueriesText(e.target.value)} rows={3} className="input"
            placeholder={'تجارة جملة\nموزّع مواد غذائية\nfood distributor\nwholesale'} />
          <p className="text-xs text-gray-400 mt-1">{queries.length} نشاط × {providers.length} مصدر = <b>{combos}</b> عملية بحث.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">الدولة</label>
            <input value={country} onChange={(e) => setCountry(e.target.value)} className="input" placeholder="مصر، المغرب، UAE..." />
          </div>
          <div>
            <label className="label">المدينة (اختياري)</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} className="input" placeholder="القاهرة، دبي..." />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={qualify} onChange={(e) => setQualify(e.target.checked)} />
          تأهيل تلقائي بالذكاء الاصطناعي (تقييم الملاءمة 1-10)
        </label>
        <div className="bg-purple-50 rounded-lg p-2.5 space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-purple-800">
            <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
            🪄 إثراء تلقائي بعد البحث (زيارة مواقع الجدد لجلب البريد/الهاتف الناقص)
          </label>
          {enrich && (
            <label className="flex items-center gap-2 text-sm text-purple-700 pr-6">
              <input type="checkbox" checked={enrichHunter} onChange={(e) => setEnrichHunter(e.target.checked)} />
              + استخدام Hunter.io للبريد الاحترافي (يتطلب مفتاحاً · حصة محدودة)
            </label>
          )}
        </div>
        <p className="text-xs text-gray-400">تُدمج نتائج كل المصادر والأنشطة وتُزال التكرارات تلقائياً. كلما زادت التوليفات والإثراء طال وقت البحث.</p>
        {combos > 12 && <p className="text-xs text-amber-600 bg-amber-50 rounded p-2">⚠️ {combos} عملية قد تستغرق وقتاً طويلاً — قلّل المصادر أو الأنشطة أو حدّد مدينة.</p>}
        <div className="flex gap-2 pt-2">
          <button disabled={mutation.isPending || providers.length === 0 || queries.length === 0} onClick={() => mutation.mutate()} className="btn-primary flex-1">
            {mutation.isPending ? 'جارٍ البحث...' : <><Radar size={16} /> ابدأ البحث</>}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E9E1D3] text-gray-600">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------- بريد تسويقي جماعي ----------------------------- //
function EmailModal({
  filters, onClose, onDone,
}: { filters: Filters; onClose: () => void; onDone: () => void }) {
  const [subject, setSubject] = useState('Field Sales — نظام مبيعات المناديب والتوزيع | Field-sales & distribution platform');
  const [body, setBody] = useState(
    'مرحباً فريق {{name}}،\n\n'
    + 'Field Sales منصّة متكاملة لإدارة مبيعات المناديب الميدانيين والتوزيع: فواتير ضريبية متوافقة مع ZATCA، تحصيل وإدارة ذمم، مخزون سيارة المندوب، وتتبّع المواقع بالـGPS — في لوحة واحدة سهلة.\n\n'
    + 'يسعدنا أن نعرض عليكم النظام في جولة قصيرة، أو جرّبوه مجاناً على fieldsa.net.\n\n'
    + '— — —\n\n'
    + 'Hello {{name}} team,\n\n'
    + 'Field Sales is an all-in-one platform to run your field reps and distribution: ZATCA-compliant tax invoicing, collections & receivables, van inventory, and live GPS tracking — all in one simple dashboard.\n\n'
    + "We'd be glad to give you a short demo, or start your free trial at fieldsa.net.\n\n"
    + 'مع خالص التحية · Best regards,\nفريق Field Sales',
  );
  const [limit, setLimit] = useState(50);

  // مزوّد البريد التسويقي وحصّته
  const { data: emailStatus } = useQuery({
    queryKey: ['email-status'],
    queryFn: async () => (await leadApi.emailStatus()).data.data as { provider: string; dailyCap: number },
  });

  // عدد المستلمين (من لديهم بريد ضمن الفلاتر الحالية)
  const { data: count } = useQuery({
    queryKey: ['lead-email-count', filters],
    queryFn: async () => {
      // من لديه بريد ولم تسبق مراسلته (يطابق استهداف الخادم)
      const params: Record<string, string | number | boolean> = { hasEmail: true, emailed: 'false', pageSize: 1 };
      if (filters.stage) params.stage = filters.stage;
      if (filters.source) params.source = filters.source;
      if (filters.q) params.q = filters.q;
      const res = await leadApi.list(params);
      return (res.data as { total: number }).total;
    },
  });

  const mutation = useMutation({
    mutationFn: () => leadApi.sendEmail({
      subject, body, limit,
      stage: filters.stage || undefined,
      source: filters.source || undefined,
      q: filters.q || undefined,
    }),
    onSuccess: (res) => {
      const { targeted, sent, failed, errors } = res.data.data as { targeted: number; sent: number; failed: number; errors?: string[] };
      toast.success(`أُرسل ${sent} من ${targeted}${failed ? ` · فشل ${failed}` : ''}`);
      if (errors && errors.length) toast.error(errors.join(' | '), { duration: 8000 });
      onDone();
      if (sent > 0) onClose();
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'فشل الإرسال'),
  });

  const recipients = count ?? 0;
  const willSend = Math.min(recipients, limit);

  return (
    <Modal title="بريد تسويقي للعملاء المحتملين" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-[#FBEBE2] rounded-lg p-3 text-sm text-[#8a4a2f]">
          سيُرسَل لمن لديه <b>بريد</b> و<b>لم تسبق مراسلته</b> ضمن الفلاتر الحالية:
          <b> {recipients}</b> مستلم متاح · سيُرسل الآن لـ<b> {willSend}</b> (حسب الحد).
          <br />من يصله البريد يُنقل تلقائياً إلى <b>«تم التواصل»</b> ولا يُراسَل مجدداً.
        </div>
        <div>
          <label className="label">الموضوع</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label">نص الرسالة</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} className="input" />
          <p className="text-xs text-gray-400 mt-1">عناصر نائبة: <code>{'{{name}}'}</code> اسم الشركة · <code>{'{{city}}'}</code> المدينة · <code>{'{{country}}'}</code> الدولة.</p>
        </div>
        <div>
          <label className="label">الحد الأقصى للإرسال دفعةً (حماية من تجاوز حصة البريد)</label>
          <input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} className="input w-32" />
        </div>
        <p className="text-xs bg-slate-50 rounded p-2 text-slate-600">
          📮 المُرسل الحالي: <b>{emailStatus?.provider === 'brevo' ? 'Brevo' : 'Resend'}</b> · الحصّة اليومية ~<b>{emailStatus?.dailyCap ?? 100}</b> بريد.
          {emailStatus?.provider !== 'brevo' && <span className="text-amber-700"> — أضِف <code>BREVO_API_KEY</code> في الخادم لرفعها إلى 300/يوم وعزلها عن بريد النظام.</span>}
        </p>
        <p className="text-xs text-amber-600 bg-amber-50 rounded p-2">
          ⚠️ إرسال بريد جماعي لعناوين عامة قد يؤثّر على سمعة نطاقك. أرسل دفعات صغيرة ونصّاً مهنياً غير مزعج.
        </p>
        <div className="flex gap-2 pt-1">
          <button disabled={mutation.isPending || !subject || !body || recipients === 0} onClick={() => mutation.mutate()} className="btn-primary flex-1">
            {mutation.isPending ? 'جارٍ الإرسال...' : <><Mail size={16} /> إرسال لـ{willSend}</>}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E9E1D3] text-gray-600">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------- واتساب تسويقي آلي (Cloud API) ----------------------------- //
function WhatsAppModal({
  filters, onClose, onDone,
}: { filters: Filters; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'template' | 'text'>('template');
  const [templateName, setTemplateName] = useState('');
  const [language, setLanguage] = useState('ar');
  const [useNameParam, setUseNameParam] = useState(true);
  const [text, setText] = useState(
    'مرحباً {{name}} 👋\nنقدّم لكم Field Sales: نظام إدارة مبيعات المناديب والتوزيع. جرّبوه مجاناً: https://fieldsa.net',
  );
  const [limit, setLimit] = useState(50);

  // هل واتساب مُعدّ في الخادم؟
  const { data: status } = useQuery({
    queryKey: ['wa-status'],
    queryFn: async () => (await leadApi.whatsappStatus()).data.data as { ready: boolean },
  });

  // عدد المستهدفين: لديهم هاتف ولم يُراسَلوا واتساب (يطابق استهداف الخادم)
  const { data: count } = useQuery({
    queryKey: ['wa-count', filters],
    queryFn: async () => {
      const params: Record<string, string | number | boolean> = { hasPhone: true, whatsapped: 'false', pageSize: 1 };
      if (filters.stage) params.stage = filters.stage;
      if (filters.source) params.source = filters.source;
      if (filters.q) params.q = filters.q;
      return (await leadApi.list(params)).data as { total: number };
    },
  });

  const mutation = useMutation({
    mutationFn: () => leadApi.whatsappSend({
      mode,
      text: mode === 'text' ? text : undefined,
      templateName: mode === 'template' ? templateName : undefined,
      language, useNameParam, limit,
      stage: filters.stage || undefined,
      source: filters.source || undefined,
      q: filters.q || undefined,
    }),
    onSuccess: (res) => {
      const { targeted, sent, failed, errors } = res.data.data as { targeted: number; sent: number; failed: number; errors?: string[] };
      toast.success(`أُرسل ${sent} من ${targeted}${failed ? ` · فشل ${failed}` : ''}`);
      if (errors && errors.length) toast.error(errors.join(' | '), { duration: 7000 });
      onDone();
      if (sent > 0) onClose();
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'فشل الإرسال'),
  });

  const recipients = count?.total ?? 0;
  const willSend = Math.min(recipients, limit);
  const ready = status?.ready;

  return (
    <Modal title="واتساب تسويقي آلي" onClose={onClose}>
      <div className="space-y-3">
        {ready === false && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            واتساب غير مُعدّ في الخادم. أضِف <code>WHATSAPP_TOKEN</code> و<code>WHATSAPP_PHONE_NUMBER_ID</code> في إعدادات الخادم (Meta Cloud API).
          </div>
        )}
        <div className="bg-[#dcf8e8] rounded-lg p-3 text-sm text-[#166534]">
          يُرسَل آلياً لمن لديه <b>هاتف</b> و<b>لم يُراسَل واتساب</b> ضمن الفلاتر الحالية:
          <b> {recipients}</b> متاح · سيُرسل الآن لـ<b> {willSend}</b>.
          <br />من يصله تُنقل حالته إلى <b>«تم التواصل»</b> ولا يُراسَل مجدداً.
        </div>

        {/* الوضع */}
        <div className="flex gap-2">
          <button onClick={() => setMode('template')} className={`flex-1 py-2 rounded-lg text-sm border ${mode === 'template' ? 'bg-[#25D366] text-white border-[#25D366]' : 'border-[#E9E1D3] text-gray-600'}`}>قالب معتمد (للتسويق)</button>
          <button onClick={() => setMode('text')} className={`flex-1 py-2 rounded-lg text-sm border ${mode === 'text' ? 'bg-[#25D366] text-white border-[#25D366]' : 'border-[#E9E1D3] text-gray-600'}`}>نص مباشر (نافذة 24س)</button>
        </div>

        {mode === 'template' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">اسم القالب المعتمد</label>
                <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} className="input" placeholder="مثال: marketing_intro" />
              </div>
              <div>
                <label className="label">لغة القالب</label>
                <input value={language} onChange={(e) => setLanguage(e.target.value)} className="input" placeholder="ar / en_US" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={useNameParam} onChange={(e) => setUseNameParam(e.target.checked)} />
              إدراج اسم العميل كأول متغيّر في القالب <code className="text-xs">{'{{1}}'}</code>
            </label>
            <p className="text-xs text-gray-400">القالب يجب أن يكون <b>معتمداً في Meta</b> مسبقاً. هذا الوضع هو الصحيح للتسويق للأرقام الجديدة.</p>
          </div>
        ) : (
          <div>
            <label className="label">نص الرسالة</label>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="input" />
            <p className="text-xs text-gray-400 mt-1">عناصر نائبة: <code>{'{{name}}'}</code> · <code>{'{{city}}'}</code> · <code>{'{{country}}'}</code></p>
            <p className="text-xs text-amber-600 bg-amber-50 rounded p-2 mt-1">⚠️ النص المباشر يصل فقط لمن راسلك خلال 24 ساعة (سياسة واتساب). للأرقام الجديدة استخدم «قالب معتمد».</p>
          </div>
        )}

        <div>
          <label className="label">الحد الأقصى للإرسال دفعةً</label>
          <input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} className="input w-32" />
        </div>

        <div className="flex gap-2 pt-1">
          <button
            disabled={mutation.isPending || recipients === 0 || (mode === 'template' ? !templateName : !text) || ready === false}
            onClick={() => mutation.mutate()}
            className="flex-1 bg-[#25D366] text-white rounded-lg py-2 flex items-center justify-center gap-2 hover:bg-[#1eb356] disabled:opacity-50"
          >
            {mutation.isPending ? 'جارٍ الإرسال...' : <><MessageCircle size={16} /> إرسال آلي لـ{willSend}</>}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E9E1D3] text-gray-600">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------- إثراء البيانات ----------------------------- //
function EnrichModal({
  filters, onClose, onDone,
}: { filters: Filters; onClose: () => void; onDone: () => void }) {
  const [useWebsite, setUseWebsite] = useState(true);
  const [useHunter, setUseHunter] = useState(false);
  const [limit, setLimit] = useState(40);

  const { data: status } = useQuery({
    queryKey: ['enrich-status'],
    queryFn: async () => (await leadApi.enrichStatus()).data.data as { hunter: boolean },
  });

  // عدد المرشّحين: لديهم موقع وينقصهم بريد
  const { data: count } = useQuery({
    queryKey: ['enrich-count', filters],
    queryFn: async () => {
      const params: Record<string, string | number | boolean> = { hasWebsite: true, noEmail: 'true', pageSize: 1 };
      if (filters.stage) params.stage = filters.stage;
      if (filters.source) params.source = filters.source;
      if (filters.q) params.q = filters.q;
      return (await leadApi.list(params)).data as { total: number };
    },
  });

  const mutation = useMutation({
    mutationFn: () => {
      const providers = [useWebsite && 'website', useHunter && 'hunter'].filter(Boolean);
      return leadApi.enrich({
        providers, limit,
        stage: filters.stage || undefined,
        source: filters.source || undefined,
        q: filters.q || undefined,
      });
    },
    onSuccess: (res) => {
      const { processed, emailFilled, phoneFilled } = res.data.data as { processed: number; emailFilled: number; phoneFilled: number };
      toast.success(`فُحص ${processed} · بريد جديد ${emailFilled} · هاتف جديد ${phoneFilled}`, { duration: 6000 });
      onDone();
      onClose();
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'فشل الإثراء'),
  });

  const candidates = count?.total ?? 0;
  const willRun = Math.min(candidates, limit);

  return (
    <Modal title="إثراء بيانات العملاء المحتملين" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-purple-50 rounded-lg p-3 text-sm text-purple-800">
          يبحث عن <b>البريد/الهاتف الناقص</b> لمن لديه <b>موقع إلكتروني</b> ضمن الفلاتر الحالية:
          <b> {candidates}</b> مرشّح · سيُعالَج الآن <b> {willRun}</b>.
          <br />يملأ الناقص فقط دون المساس بالموجود.
        </div>
        <div>
          <label className="label">مصادر الإثراء</label>
          <label className="flex items-center gap-2 text-sm border rounded-lg px-3 py-2 border-[#E9E1D3] mb-2">
            <input type="checkbox" checked={useWebsite} onChange={(e) => setUseWebsite(e.target.checked)} />
            <span>زيارة الموقع الإلكتروني واستخراج التواصل <span className="text-green-600 text-xs">(مجاني)</span></span>
          </label>
          <label className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 ${status?.hunter ? 'border-[#E9E1D3]' : 'border-[#E9E1D3] opacity-60'}`}>
            <input type="checkbox" checked={useHunter} disabled={!status?.hunter} onChange={(e) => setUseHunter(e.target.checked)} />
            <span>Hunter.io (بريد احترافي) {status?.hunter ? <span className="text-green-600 text-xs">(جاهز)</span> : <span className="text-red-500 text-xs">(أضِف HUNTER_API_KEY في الخادم)</span>}</span>
          </label>
        </div>
        <div>
          <label className="label">الحد الأقصى للمعالجة دفعةً</label>
          <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="input w-32" />
        </div>
        <p className="text-xs text-gray-400">قد تستغرق العملية وقتاً (زيارة كل موقع). ابدأ بدفعة صغيرة. بيانات تواصل أعمال عامّة فقط.</p>
        <div className="flex gap-2 pt-1">
          <button disabled={mutation.isPending || candidates === 0 || (!useWebsite && !useHunter)} onClick={() => mutation.mutate()} className="flex-1 bg-purple-600 text-white rounded-lg py-2 flex items-center justify-center gap-2 hover:bg-purple-700 disabled:opacity-50">
            {mutation.isPending ? 'جارٍ الإثراء...' : <><Wand2 size={16} /> إثراء {willRun}</>}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E9E1D3] text-gray-600">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------- إضافة يدوية ----------------------------- //
function AddLeadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', website: '', city: '', country: '', category: '', notes: '' });
  const mutation = useMutation({
    mutationFn: () => leadApi.create(form),
    onSuccess: () => { toast.success('أُضيف العميل المحتمل'); onDone(); onClose(); },
    onError: () => toast.error('فشل الحفظ'),
  });
  return (
    <Modal title="إضافة عميل محتمل" onClose={onClose}>
      <div className="space-y-3">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="اسم الشركة *" />
        <div className="grid grid-cols-2 gap-3">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input" placeholder="الهاتف" />
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input" placeholder="البريد" />
          <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className="input" placeholder="الدولة" />
          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="input" placeholder="المدينة" />
          <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className="input" placeholder="الموقع الإلكتروني" />
          <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input" placeholder="نوع النشاط" />
        </div>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" rows={2} placeholder="ملاحظات" />
        <div className="flex gap-2">
          <button disabled={mutation.isPending || !form.name} onClick={() => mutation.mutate()} className="btn-primary flex-1">حفظ</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E9E1D3] text-gray-600">إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------- استيراد CSV ----------------------------- //
function ImportButton({ onDone }: { onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: (rows: Record<string, string>[]) => leadApi.import(rows),
    onSuccess: (res) => { toast.success(`استُورد ${res.data.data.imported} من ${res.data.data.total}`); onDone(); },
    onError: () => toast.error('فشل الاستيراد'),
  });
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) { toast.error('الملف فارغ أو غير صالح'); return; }
    mutation.mutate(rows);
    e.target.value = '';
  };
  return (
    <label className="px-3 py-2 rounded-lg text-sm border border-[#E9E1D3] text-gray-700 hover:bg-white cursor-pointer">
      <Upload size={14} className="inline ml-1" /> {mutation.isPending ? '...' : 'CSV'}
      <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
    </label>
  );
}

// محلّل CSV بسيط يدعم الحقول المقتبسة. الصف الأول رأس (name,phone,email,...)؛
// إن لم يُطابق أي عمود معروف يُعتبر العمود الأول هو الاسم.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const splitLine = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const known = ['name', 'phone', 'email', 'website', 'address', 'city', 'country', 'countryCode', 'category', 'notes'];
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.some((h) => known.includes(h));
  const cols = hasHeader ? header : ['name', 'phone', 'email', 'city', 'country', 'category'];
  const body = hasHeader ? lines.slice(1) : lines;
  const rows: Record<string, string>[] = [];
  for (const line of body) {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { if (known.includes(c) && cells[i]) row[c] = cells[i]; });
    if (row.name) rows.push(row);
  }
  return rows;
}

// ----------------------------- تفاصيل العميل المحتمل ----------------------------- //
function LeadDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { data: lead } = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => (await leadApi.get(id)).data.data as Lead,
  });
  const [note, setNote] = useState('');
  const [noteType, setNoteType] = useState('NOTE');

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['lead', id] });
    onChanged();
  };

  const update = useMutation({
    mutationFn: (data: Record<string, unknown>) => leadApi.update(id, data),
    onSuccess: () => { refreshAll(); toast.success('تم التحديث'); },
    onError: () => toast.error('فشل التحديث'),
  });
  const addActivity = useMutation({
    mutationFn: () => leadApi.addActivity(id, { type: noteType, content: note, markContacted: noteType === 'CALL' || noteType === 'EMAIL' || noteType === 'MEETING' }),
    onSuccess: () => { setNote(''); refreshAll(); toast.success('سُجّلت المتابعة'); },
    onError: () => toast.error('فشل التسجيل'),
  });
  const convert = useMutation({
    mutationFn: () => leadApi.convert(id),
    onSuccess: () => { refreshAll(); toast.success('تم تحويله إلى مشترك 🎉'); },
    onError: () => toast.error('فشل التحويل'),
  });
  const remove = useMutation({
    mutationFn: () => leadApi.remove(id),
    onSuccess: () => { onChanged(); onClose(); toast.success('حُذف'); },
    onError: () => toast.error('فشل الحذف'),
  });

  if (!lead) return null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-start" dir="rtl">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-md bg-white h-full overflow-y-auto shadow-2xl">
        <div className="bg-[#1F1A13] text-white p-4 sticky top-0 flex items-start justify-between">
          <div>
            <h3 className="font-bold text-lg">{lead.name}</h3>
            <p className="text-slate-400 text-xs">{lead.country || ''}{lead.city ? ` · ${lead.city}` : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-300 hover:text-white"><X size={20} /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* بيانات التواصل */}
          <div className="space-y-1.5 text-sm">
            {lead.phone && <a href={`tel:${lead.phone}`} className="flex items-center gap-2 text-gray-700"><Phone size={14} className="text-[#E15A30]" /> {lead.phone}</a>}
            {lead.website && <a href={lead.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-blue-600 truncate"><Globe2 size={14} /> {lead.website}</a>}
            {lead.address && <div className="flex items-center gap-2 text-gray-600"><MapPin size={14} className="text-gray-400" /> {lead.address}</div>}
            {lead.mapsUrl && (lead.mapsUrl.includes('linkedin.com')
              ? <a href={lead.mapsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[#0A66C2]"><Globe2 size={14} /> الملف على LinkedIn</a>
              : <a href={lead.mapsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-green-700"><MapPin size={14} /> عرض على الخريطة</a>)}
            {lead.score != null && <div className="flex items-center gap-2"><Sparkles size={14} className="text-amber-500" /> ملاءمة {lead.score}/10 {lead.scoreNote && <span className="text-gray-400">— {lead.scoreNote}</span>}</div>}
          </div>

          {/* المرحلة */}
          <div>
            <label className="label">المرحلة</label>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map((s) => (
                <button key={s} onClick={() => update.mutate({ stage: s })}
                  className={`px-2.5 py-1 rounded-md text-xs ${lead.stage === s ? STAGE_CLS[s] + ' ring-1 ring-current' : 'bg-slate-50 text-slate-500'}`}>
                  {STAGE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {/* تقييم + متابعة قادمة */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">الملاءمة (1-10)</label>
              <input type="number" min={0} max={10} defaultValue={lead.score ?? ''} className="input"
                onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== lead.score) update.mutate({ score: v }); }} />
            </div>
            <div>
              <label className="label">متابعة قادمة</label>
              <input type="date" defaultValue={lead.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 10) : ''} className="input"
                onChange={(e) => update.mutate({ nextFollowUpAt: e.target.value || null })} />
            </div>
          </div>

          {/* تسجيل متابعة */}
          <div className="bg-[#FAF7F0] rounded-lg p-3">
            <label className="label">تسجيل متابعة</label>
            <div className="flex gap-1.5 mb-2">
              {[['NOTE', 'ملاحظة', StickyNote], ['CALL', 'مكالمة', PhoneCall], ['EMAIL', 'بريد', Globe2], ['MEETING', 'اجتماع', Target]].map(([v, lbl, Icon]) => (
                <button key={v as string} onClick={() => setNoteType(v as string)}
                  className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${noteType === v ? 'bg-[#E15A30] text-white' : 'bg-white text-gray-600 border border-[#E9E1D3]'}`}>
                  {/* @ts-expect-error dynamic icon */}
                  <Icon size={12} /> {lbl}
                </button>
              ))}
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="input mb-2" placeholder="تفاصيل المتابعة..." />
            <button disabled={!note || addActivity.isPending} onClick={() => addActivity.mutate()} className="btn-primary w-full text-sm">تسجيل</button>
          </div>

          {/* أزرار */}
          <div className="flex gap-2">
            <button disabled={lead.stage === 'WON'} onClick={() => convert.mutate()} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm flex items-center justify-center gap-1 disabled:opacity-50">
              <ArrowRightLeft size={15} /> تحويل لمشترك
            </button>
            <button onClick={() => { if (confirm('حذف هذا العميل المحتمل؟')) remove.mutate(); }} className="px-3 py-2 rounded-lg border border-red-200 text-red-600"><Trash2 size={16} /></button>
          </div>

          {/* الخط الزمني */}
          <div>
            <p className="text-sm font-bold text-gray-700 mb-2">سجلّ المتابعة</p>
            <div className="space-y-2">
              {(lead.activities ?? []).map((a: LeadActivity) => (
                <div key={a.id} className="text-xs border-r-2 border-[#E9E1D3] pr-3">
                  <div className="text-gray-700">{a.content}</div>
                  <div className="text-gray-400">{a.createdBy ? `${a.createdBy} · ` : ''}{formatDate(a.createdAt)}</div>
                </div>
              ))}
              {(lead.activities ?? []).length === 0 && <p className="text-xs text-gray-400">لا متابعات بعد.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Modal مساعد ----------------------------- //
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h3 className="font-bold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
