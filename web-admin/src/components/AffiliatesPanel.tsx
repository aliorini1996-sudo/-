import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import toast from 'react-hot-toast';
import {
  X, Handshake, LayoutDashboard, Users, FileSearch, Link2, BadgePercent, Landmark, Scale, Settings,
  Search, Eye, EyeOff, Copy, AlertTriangle, CheckCircle2, XCircle, PauseCircle, PlayCircle, Ban,
  Building2, Plus, Wallet, ShieldAlert, RefreshCw, History, Info, Lock, RotateCcw, Shuffle, CalendarClock,
} from 'lucide-react';
import api from '../api/client';
import { backdropClose } from '../lib/backdropClose';
import { formatDate, formatDateTime, formatDayOnly } from '../utils/format';
import * as L from './affiliatesPanelLogic';

/**
 * «سفراء فيلد سيلز» — نافذة المالك لبرنامج التسويق بالعمولة.
 *
 * المواصفة الحاكمة: `docs/affiliate/API.md` §2 و`CONTRACT.md`. قرارات المالك:
 * عمولة واحدة لكل شركة على **أول دفعة مؤكَّدة** بكامل مبلغها شاملاً الضريبة،
 * والصرف **يدوي من المالك** — المنصّة لا تحرّك مالاً: تُنشئ الدفعة هنا لتجميد
 * العمولات، ويحوّل المالك من بنكه، ثم يسجّل المرجع.
 *
 * كل المبالغ هللات صحيحة؛ التحويل من نصّ الريال في `affiliatesPanelLogic.ts`.
 */

// ─── الواجهة الخلفية (API.md §2) ───────────────────────────────────────────

const A = '/affiliate-admin';
const unwrap = async <T,>(p: Promise<AxiosResponse>): Promise<T> => (await p).data.data as T;

const affApi = {
  overview: () => unwrap<L.Overview>(api.get(`${A}/overview`)),
  settings: () => unwrap<L.AffiliateSettings>(api.get(`${A}/settings`)),
  /** يقبل `intakeOpen` و`disclosureText` فقط — القواعد الست تتغيّر بنشر شروط (publishTerms) */
  saveSettings: (body: L.SettingsBody) => unwrap<L.AffiliateSettings>(api.put(`${A}/settings`, body)),
  terms: () => unwrap<L.TermsVersion[]>(api.get(`${A}/terms`)),
  /** ينشر إصداراً ويطبّق قواعده (المتغيّرة فقط) ذرّياً */
  publishTerms: (body: { version: string; body: string; rules?: Partial<L.TermsRules> }) => unwrap<L.TermsVersion>(api.post(`${A}/terms`, body)),
  affiliates: (status: string, q: string) =>
    unwrap<L.AffiliateRow[]>(api.get(`${A}/affiliates`, { params: L.cleanParams({ status, q }) })),
  affiliate: async (id: string) => L.normalizeDetail(await unwrap<L.AffiliateDetail>(api.get(`${A}/affiliates/${id}`))),
  affiliateAction: (id: string, action: L.UserAction, reason?: string) =>
    unwrap<{ status: L.UserStatus }>(api.post(`${A}/affiliates/${id}/${action}`, reason !== undefined ? { reason } : {})),
  revealIban: (id: string) => unwrap<L.RevealedIban>(api.post(`${A}/affiliates/${id}/reveal-iban`, {})),
  claims: async (status: string) =>
    L.normalizeClaims(await unwrap<L.ClaimRow[]>(api.get(`${A}/claims`, { params: L.cleanParams({ status }) }))),
  approveClaim: (id: string) => unwrap<{ status: 'approved'; lockedUntil: string }>(api.post(`${A}/claims/${id}/approve`, {})),
  rejectClaim: (id: string, reasonCode: L.ClaimReason) => unwrap<{ status: 'rejected' }>(api.post(`${A}/claims/${id}/reject`, { reasonCode })),
  linkClaim: (id: string, tenantId: string) =>
    unwrap<L.ClaimLinkResult>(api.post(`${A}/claims/${id}/link-tenant`, { tenantId })),
  attributions: async (status: string) =>
    L.normalizeAttributions(await unwrap<L.AttributionRow[]>(api.get(`${A}/attributions`, { params: L.cleanParams({ status }) }))),
  /** 409 إن كان للشركة أيّ إسناد (ولو مُبطَلاً) — والنقل يكون بـ«إعادة إسناد» */
  createAttribution: (body: { tenantId: string; affiliateId: string; reason: string; effectiveFrom?: string }) =>
    unwrap<{ attribution: L.AttributionRow; commission: unknown | null } & L.AccrualResult>(api.post(`${A}/attributions`, body)),
  attributionAction: (id: string, action: 'void' | 'activate', reason: string) =>
    unwrap<{ attribution: L.AttributionRow; commission: unknown | null } & L.AccrualResult>(api.post(`${A}/attributions/${id}/${action}`, { reason })),
  /** للمتنازع عليه والمُبطل فقط — ينقل الشركة لسفير آخر ويعيد احتساب عمولتها غير المصروفة */
  reassignAttribution: (id: string, body: L.ReassignBody) =>
    unwrap<L.AttributionChangeResult>(api.post(`${A}/attributions/${id}/reassign`, body)),
  /** لإسنادٍ بلا عمولة فقط — يغيّر بداية نافذته */
  setAttributionWindow: (id: string, body: { effectiveFrom: string; reason: string }) =>
    unwrap<L.AttributionChangeResult>(api.post(`${A}/attributions/${id}/window`, body)),
  commissions: (status: string) => unwrap<L.CommissionRow[]>(api.get(`${A}/commissions`, { params: L.cleanParams({ status }) })),
  commissionAction: (id: string, action: L.CommissionAction, reason?: string) =>
    unwrap<{ status: L.CommissionStatus }>(api.post(`${A}/commissions/${id}/${action}`, reason !== undefined ? { reason } : {})),
  candidates: () => unwrap<L.PayoutCandidate[]>(api.get(`${A}/payouts/candidates`)),
  createPayout: (affiliateId: string) => unwrap<L.PayoutRow>(api.post(`${A}/payouts`, { affiliateId })),
  payouts: (status: string) => unwrap<L.PayoutRow[]>(api.get(`${A}/payouts`, { params: L.cleanParams({ status }) })),
  recordPayout: (id: string, body: { bankReference: string; transferredAt: string }) =>
    unwrap<L.PayoutRow>(api.post(`${A}/payouts/${id}/record`, body)),
  voidPayout: (id: string, reason: string) => unwrap<L.PayoutRow>(api.post(`${A}/payouts/${id}/void`, { reason })),
  createAdjustment: (body: { affiliateId: string; amountHalalas: number; note: string }) =>
    unwrap<unknown>(api.post(`${A}/adjustments`, body)),
  searchTenants: (q: string) => unwrap<L.TenantHit[]>(api.get(`${A}/tenants/search`, { params: { q } })),
  linkPaymentTenant: (paymentId: string, tenantId: string) =>
    unwrap<L.PaymentLinkResult>(api.post(`/payments/${paymentId}/link-tenant`, { tenantId })),
};

const KEY = 'aff-admin';

// ─── عناصر مشتركة ──────────────────────────────────────────────────────────

const TONE: Record<L.Tone, string> = {
  gray: 'bg-gray-100 text-gray-600',
  amber: 'bg-[#FBF0D8] text-[#9A6B1E]',
  green: 'bg-green-50 text-green-700',
  red: 'bg-red-50 text-red-700',
  blue: 'bg-blue-50 text-blue-700',
  orange: 'bg-[#FBEBE2] text-[#B8431F]',
};

function Chip({ tone = 'gray', children, title }: { tone?: L.Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function StatusChip({ map, value }: { map: Record<string, L.Label>; value: string | null | undefined }) {
  return <Chip tone={L.toneOf(map, value)}>{L.labelOf(map, value)}</Chip>;
}

function StatusFilter({ values, map, value, onChange }: {
  values: readonly string[]; map: Record<string, L.Label>; value: string; onChange: (v: string) => void;
}) {
  const pill = (v: string, label: string) => (
    <button
      key={v || 'all'} onClick={() => onChange(v)}
      className={`px-3 py-1 rounded-full text-[12px] font-semibold whitespace-nowrap transition-colors ${
        value === v ? 'bg-[#1F1A13] text-white' : 'bg-white border border-[#E7DECD] text-[#6E6557] hover:bg-[#F1EADD]'
      }`}
    >{label}</button>
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {pill('', 'الكل')}
      {values.map((v) => pill(v, L.labelOf(map, v)))}
    </div>
  );
}

function Loading() { return <p className="text-center text-sm text-gray-400 py-10">جارٍ التحميل…</p>; }
function Failed({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="text-center py-10">
      <p className="text-sm text-red-600">تعذّر جلب البيانات</p>
      {onRetry && <button onClick={onRetry} className="mt-2 text-xs text-[#E15A30] underline">إعادة المحاولة</button>}
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) { return <p className="text-center text-sm text-gray-400 py-10">{children}</p>; }

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'money'; children: ReactNode }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 border-amber-200 text-amber-900'
    : tone === 'money' ? 'bg-[#FBEBE2] border-[#F3C9B6] text-[#7A2E14]' : 'bg-white border-[#E7DECD] text-[#6E6557]';
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'money' ? Landmark : Info;
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed flex items-start gap-2 ${cls}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

function ActionBtn({ onClick, disabled, title, tone = 'ink', icon: Icon, children }: {
  onClick: () => void; disabled?: boolean; title?: string; tone?: 'ink' | 'good' | 'bad' | 'brand';
  icon?: React.ElementType; children: ReactNode;
}) {
  const cls = {
    ink: 'text-[#1F1A13] border-[#DED5C4] hover:bg-[#F1EADD]',
    good: 'text-green-700 border-green-200 hover:bg-green-50',
    bad: 'text-red-700 border-red-200 hover:bg-red-50',
    brand: 'text-[#E15A30] border-[#F3C9B6] hover:bg-[#FBEBE2]',
  }[tone];
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border bg-white text-[11.5px] font-semibold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${cls}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}{children}
    </button>
  );
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`text-right font-medium px-3 py-2 whitespace-nowrap ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-top ${className}`}>{children}</td>;
}
function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#E7DECD] bg-white">
      <table className="w-full text-[12.5px]">
        <thead className="text-[#9A8F7E] text-[11px] bg-[#FAF7F0]"><tr>{head}</tr></thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-[#F1EBDF]">{children}</tbody>
      </table>
    </div>
  );
}

function AffCell({ a }: { a: { fullName: string; code: string } | null | undefined }) {
  if (!a) return <span className="text-gray-400">—</span>;
  return (
    <div>
      <p className="font-semibold text-[#1F1A13] whitespace-nowrap">{a.fullName}</p>
      <p className="text-[10.5px] text-[#9A8F7E] font-mono" dir="ltr">{a.code}</p>
    </div>
  );
}

const day = (s: string | null | undefined) => (s ? formatDate(s) : '—');
/**
 * حقول اليوم الخالص (`mawthooqExpiry`، `transferredAt`) تصل 'YYYY-MM-DD' بيوم الرياض —
 * و`dayKeyOf` يحوّل أي لحظة ISO كاملة ليوم الرياض بدل قصّ أول عشرة أحرف منها.
 */
const dayOnly = (s: string | null | undefined) => {
  const key = L.dayKeyOf(s);
  return key ? formatDayOnly(key) : '—';
};

type SuccessMsg = string | L.OutcomeMessage;

/** نجاحٌ عادي، أو تنبيهٌ حين تحتاج نتيجة الاحتساب انتباه المالك (لم تُنشأ عمولة، تنازع) */
function toastOutcome(msg: SuccessMsg) {
  if (typeof msg === 'string') { toast.success(msg); return; }
  if (msg.warn) toast(msg.text, { duration: 10000, icon: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" /> });
  else toast.success(msg.text, { duration: 6000 });
}

function copyText(text: string, done = 'نُسخ') {
  if (!navigator.clipboard) { toast.error('تعذّر النسخ — انسخه يدوياً'); return; }
  navigator.clipboard.writeText(text).then(() => toast.success(done)).catch(() => toast.error('تعذّر النسخ — انسخه يدوياً'));
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ─── نافذة السبب + منفّذ الإجراءات ──────────────────────────────────────────

type DialogMode = 'text' | 'claimReason' | 'none';

interface AskReq {
  key: string;
  title: string;
  hint?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  mode: DialogMode;
  action: (value: string) => Promise<unknown>;
  success: SuccessMsg | ((result: unknown) => SuccessMsg);
}

function ReasonDialog({ req, busy, onConfirm, onClose }: {
  req: AskReq; busy: boolean; onConfirm: (value: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [code, setCode] = useState<L.ClaimReason>('existing_customer');
  const [touched, setTouched] = useState(false);
  const err = req.mode === 'text' ? L.validateReason(text) : null;
  const submit = () => {
    setTouched(true);
    if (err) return;
    onConfirm(req.mode === 'claimReason' ? code : text.trim());
  };
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-base font-bold text-[#1F1A13]">{req.title}</h3>
          {req.hint && <div className="text-[12px] text-[#6E6557] mt-1.5 leading-relaxed">{req.hint}</div>}
        </div>
        <div className="px-5 pb-2">
          {req.mode === 'text' && (
            <>
              <textarea
                autoFocus rows={3} maxLength={500} className="input w-full resize-none" value={text}
                onChange={(e) => setText(e.target.value)} placeholder="السبب — يُحفظ في سجل الأحداث"
              />
              {touched && err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
            </>
          )}
          {req.mode === 'claimReason' && (
            <select autoFocus className="input w-full" value={code} onChange={(e) => setCode(e.target.value as L.ClaimReason)}>
              {L.CLAIM_REASONS.map((r) => <option key={r} value={r}>{L.CLAIM_REASON_LABEL[r]}</option>)}
            </select>
          )}
        </div>
        <div className="flex gap-2 p-5 pt-3">
          <button
            onClick={submit} disabled={busy}
            className={`flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-60 ${
              req.danger ? 'bg-[#C0392B] hover:bg-[#a8311f]' : 'bg-[#E15A30] hover:bg-[#C94E28]'
            }`}
          >
            {busy && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {req.confirmLabel}
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/**
 * منفّذ الإجراءات: يعرض رسالة الخادم العربية كما هي عند الفشل (409 انتقال غير
 * مسموح، فترة حجز لم تنتهِ، رابط لم يعد مدفوعاً…)، ويُحدّث كل استعلامات
 * البرنامج **في النجاح والفشل** — لأن 409 الاعتماد قد يعكس العمولة في الخادم.
 */
function useActions() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [req, setReq] = useState<AskReq | null>(null);

  async function run<T>(key: string, fn: () => Promise<T>, success: SuccessMsg | ((r: T) => SuccessMsg)): Promise<boolean> {
    setBusy(key);
    try {
      const r = await fn();
      toastOutcome(typeof success === 'function' ? success(r) : success);
      return true;
    } catch (e) {
      toast.error(L.apiErrorMessage(e, 'تعذّر تنفيذ الإجراء'), { duration: 7000 });
      return false;
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: [KEY] });
    }
  }

  const dialog = req ? (
    <ReasonDialog
      req={req} busy={busy === req.key}
      onClose={() => setReq(null)}
      onConfirm={async (v) => { if (await run(req.key, () => req.action(v), req.success)) setReq(null); }}
    />
  ) : null;

  return { run, busy, ask: setReq, dialog };
}
type Actions = ReturnType<typeof useActions>;

// ─── بحث الشركات (مُصدَّر لنافذة روابط الدفع) ──────────────────────────────

export function TenantSearchBox({ selected, onSelect, warnAttributed = false }: {
  selected: L.TenantHit | null; onSelect: (t: L.TenantHit | null) => void; warnAttributed?: boolean;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const { data, isFetching, isError } = useQuery({
    queryKey: [KEY, 'tenant-search', dq],
    queryFn: () => affApi.searchTenants(dq),
    enabled: dq.length >= 2 && !selected,
    placeholderData: (prev) => prev,
  });

  if (selected) {
    return (
      <div className="rounded-xl border border-[#E7DECD] bg-[#FAF7F0] px-3 py-2 flex items-center gap-2">
        <Building2 className="w-4 h-4 text-[#E15A30] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-[#1F1A13] truncate">{selected.name}</p>
          <p className="text-[10.5px] text-[#9A8F7E]">
            {selected.commercialReg ? <>سجل تجاري <span dir="ltr">{selected.commercialReg}</span> · </> : null}
            أُنشئت {day(selected.createdAt)}
          </p>
        </div>
        {selected.attributed && <Chip tone={warnAttributed ? 'red' : 'amber'}>مُسندة لسفير</Chip>}
        <button onClick={() => onSelect(null)} className="p-1 rounded hover:bg-black/5" title="تغيير الشركة"><X className="w-4 h-4 text-gray-500" /></button>
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute top-1/2 -translate-y-1/2 right-3" />
        <input
          className="input w-full pr-9" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث باسم الشركة أو السجل التجاري (حرفان على الأقل)"
        />
      </div>
      {dq.length >= 2 && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-[#E7DECD] bg-white divide-y divide-[#F1EBDF]">
          {isError ? <p className="text-[12px] text-red-600 p-3">تعذّر البحث</p>
            : !data ? <p className="text-[12px] text-gray-400 p-3">{isFetching ? 'يبحث…' : ''}</p>
              : data.length === 0 ? <p className="text-[12px] text-gray-400 p-3">لا شركات مطابقة</p>
                : data.map((t) => (
                  <button key={t.id} onClick={() => onSelect(t)} className="w-full text-right px-3 py-2 hover:bg-[#FAF7F0] flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[#1F1A13] truncate">{t.name}</p>
                      <p className="text-[10.5px] text-[#9A8F7E]">
                        {t.commercialReg ? <>سجل <span dir="ltr">{t.commercialReg}</span> · </> : null}{day(t.createdAt)}
                      </p>
                    </div>
                    {t.attributed && <Chip tone="amber">مُسندة لسفير</Chip>}
                  </button>
                ))}
        </div>
      )}
    </div>
  );
}

/** ربط دفعة ميسر مدفوعة بلا شركة — `POST /api/payments/:id/link-tenant` */
export function LinkPaymentTenantDialog({ payment, onClose, onLinked }: {
  payment: { id: string; description: string; amountHalalas: number };
  onClose: () => void;
  onLinked: () => void;
}) {
  const qc = useQueryClient();
  const [tenant, setTenant] = useState<L.TenantHit | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!tenant) return;
    setBusy(true);
    try {
      const r = await affApi.linkPaymentTenant(payment.id, tenant.id);
      // «أُنشئت عمولة» فقط حين commissionCreated — ووجود commission في الردّ لا يعني أنها جديدة
      toastOutcome(L.withAccrual(`رُبطت الدفعة بـ${tenant.name}`, { commissionCreated: r?.commissionCreated, accrualReason: r?.accrualReason }, { quietNoAttribution: true }));
      qc.invalidateQueries({ queryKey: [KEY] });
      onLinked();
    } catch (e) {
      toast.error(L.apiErrorMessage(e, 'تعذّر ربط الدفعة'), { duration: 7000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5">
          <div>
            <h3 className="text-base font-bold text-[#1F1A13]">ربط الدفعة بشركة</h3>
            <p className="text-[12px] text-[#6E6557] mt-1">{payment.description} · <b className="tabular-nums">{L.formatHalalas(payment.amountHalalas)}</b></p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Note>
            هذه دفعة مؤكَّدة بلا شركة مرتبطة. ربطها بالشركة الصحيحة يجعلها تُحتسب <b>دفعتها الأولى</b>،
            فإن كانت الشركة مُسندة لسفير والدفعة داخل نافذة إسناده أُنشئت عمولته تلقائياً — وإلا يظهر لك سبب عدم إنشائها.
            اختر الشركة بعناية — الربط يُسجَّل حدثاً.
          </Note>
          <TenantSearchBox selected={tenant} onSelect={setTenant} />
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <button
            onClick={submit} disabled={!tenant || busy}
            className="flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-50"
          >
            {busy && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            <Link2 className="w-4 h-4" /> ربط
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/** كشف الآيبان الكامل — يُسجَّل حدثاً في الخادم، ويبقى معروضاً في مكانه فقط */
function RevealIban({ affiliateId }: { affiliateId: string }) {
  const [data, setData] = useState<L.RevealedIban | null>(null);
  const [loading, setLoading] = useState(false);
  const reveal = async () => {
    setLoading(true);
    try { setData(await affApi.revealIban(affiliateId)); } catch (e) { toast.error(L.apiErrorMessage(e, 'تعذّر إظهار الآيبان')); } finally { setLoading(false); }
  };
  if (!data) {
    return (
      <button
        onClick={reveal} disabled={loading}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-[11.5px] font-semibold disabled:opacity-50"
        title="يُسجَّل كل كشف في سجل أحداث السفير"
      >
        <Eye className="w-3.5 h-3.5" /> {loading ? 'يكشف…' : 'إظهار الآيبان'}
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="font-mono text-[14px] font-bold text-[#1F1A13] tracking-wide flex-1" dir="ltr">{L.groupIban(data.iban)}</p>
        <button onClick={() => copyText(data.iban.replace(/\s+/g, ''), 'نُسخ الآيبان')} className="p-1 rounded hover:bg-black/5" title="نسخ"><Copy className="w-4 h-4 text-amber-900" /></button>
        <button onClick={() => setData(null)} className="p-1 rounded hover:bg-black/5" title="إخفاء"><EyeOff className="w-4 h-4 text-amber-900" /></button>
      </div>
      <p className="text-[12px] text-[#1F1A13]">صاحب الحساب: <b>{data.holderName}</b>{data.bankName ? ` · ${data.bankName}` : ''}</p>
      <p className="text-[11px] text-amber-900 flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> سُجّل هذا الكشف في سجل أحداث السفير. لا تحفظ الآيبان خارج تطبيق البنك.</p>
    </div>
  );
}

// ─── التبويبات ─────────────────────────────────────────────────────────────

type TabKey = 'overview' | 'affiliates' | 'claims' | 'attributions' | 'commissions' | 'payouts' | 'adjustments' | 'settings';
type FilterTab = 'affiliates' | 'claims' | 'attributions' | 'commissions' | 'payouts';

const TABS: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'overview', label: 'نظرة عامة', icon: LayoutDashboard },
  { key: 'affiliates', label: 'المسوّقون', icon: Users },
  { key: 'claims', label: 'الترشيحات', icon: FileSearch },
  { key: 'attributions', label: 'الإسناد', icon: Link2 },
  { key: 'commissions', label: 'العمولات', icon: BadgePercent },
  { key: 'payouts', label: 'الصرف', icon: Landmark },
  { key: 'adjustments', label: 'التصحيحات', icon: Scale },
  { key: 'settings', label: 'الإعدادات والشروط', icon: Settings },
];

export default function AffiliatesPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('overview');
  const [filters, setFilters] = useState<Record<FilterTab, string>>({
    affiliates: '', claims: '', attributions: '', commissions: '', payouts: '',
  });
  const setFilter = (t: FilterTab) => (v: string) => setFilters((p) => ({ ...p, [t]: v }));
  const go = (t: TabKey, filter?: string) => {
    setTab(t);
    if (filter !== undefined && t in filters) setFilters((p) => ({ ...p, [t as FilterTab]: filter }));
  };

  const { data: overview } = useQuery({ queryKey: [KEY, 'overview'], queryFn: affApi.overview });
  const badge: Partial<Record<TabKey, number>> = overview ? {
    affiliates: overview.affiliates.pending_review,
    claims: overview.claimsUnderReview,
    attributions: overview.attributions.disputed,
    commissions: overview.commissions.readyToApprove,
    payouts: overview.payoutCandidates,
  } : {};

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-[#FAF7F0] rounded-2xl w-full max-w-6xl shadow-xl my-4 flex flex-col min-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7DECD] sticky top-0 bg-[#FAF7F0] rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Handshake className="w-5 h-5 text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">سفراء فيلد سيلز</h2>
              <p className="text-[11.5px] text-[#6E6557]">عمولة على أول دفعة مؤكَّدة لكل شركة · الصرف يدوي منك — المنصّة لا تحوّل أي مال</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5" aria-label="إغلاق"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="px-3 sm:px-5 pt-3 border-b border-[#E7DECD] overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            {TABS.map(({ key, label, icon: Icon }) => {
              const n = badge[key] ?? 0;
              return (
                <button
                  key={key} onClick={() => setTab(key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold rounded-t-lg border-b-2 -mb-px transition-colors ${
                    tab === key ? 'border-[#E15A30] text-[#E15A30] bg-white' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'
                  }`}
                >
                  <Icon className="w-4 h-4" /> {label}
                  {n > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#E15A30] text-white text-[10px] leading-[18px] tabular-nums">{n}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-4 sm:p-5 flex-1">
          {tab === 'overview' && <OverviewTab go={go} />}
          {tab === 'affiliates' && <AffiliatesTab status={filters.affiliates} setStatus={setFilter('affiliates')} />}
          {tab === 'claims' && <ClaimsTab status={filters.claims} setStatus={setFilter('claims')} />}
          {tab === 'attributions' && <AttributionsTab status={filters.attributions} setStatus={setFilter('attributions')} />}
          {tab === 'commissions' && <CommissionsTab status={filters.commissions} setStatus={setFilter('commissions')} />}
          {tab === 'payouts' && <PayoutsTab status={filters.payouts} setStatus={setFilter('payouts')} />}
          {tab === 'adjustments' && <AdjustmentsTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </div>
    </div>
  );
}

// ─── ١) نظرة عامة ──────────────────────────────────────────────────────────

function OverviewTab({ go }: { go: (t: TabKey, filter?: string) => void }) {
  const { data: o, isLoading, isError, refetch } = useQuery({ queryKey: [KEY, 'overview'], queryFn: affApi.overview });
  if (isLoading) return <Loading />;
  if (isError || !o) return <Failed onRetry={() => refetch()} />;

  const cards: Array<{ label: string; value: string; hint: string; icon: React.ElementType; hot: boolean; onClick: () => void }> = [
    { label: 'طلبات انضمام بانتظار المراجعة', value: String(o.affiliates.pending_review), hint: 'اعتماد أو رفض كل طلب', icon: Users, hot: o.affiliates.pending_review > 0, onClick: () => go('affiliates', 'pending_review') },
    { label: 'ترشيحات قيد المراجعة', value: String(o.claimsUnderReview), hint: 'الأسبق بالسجل التجاري يفوز', icon: FileSearch, hot: o.claimsUnderReview > 0, onClick: () => go('claims', 'under_review') },
    { label: 'إسنادات متنازع عليها', value: String(o.attributions.disputed), hint: 'إشارات إحالة ذاتية أو تعارض', icon: AlertTriangle, hot: o.attributions.disputed > 0, onClick: () => go('attributions', 'disputed') },
    { label: 'عمولات جاهزة للاعتماد', value: String(o.commissions.readyToApprove), hint: 'انتهت فترة حجزها', icon: BadgePercent, hot: o.commissions.readyToApprove > 0, onClick: () => go('commissions', 'pending') },
    { label: 'معتمدة لم تُصرف', value: L.formatHalalas(o.commissions.approvedUnpaidHalalas), hint: 'بانتظار دفعة وتحويل يدوي', icon: Wallet, hot: o.commissions.approvedUnpaidHalalas > 0, onClick: () => go('commissions', 'approved') },
    { label: 'مرشّحون للصرف', value: String(o.payoutCandidates), hint: 'أنشئ دفعة ثم حوّل من بنكك', icon: Landmark, hot: o.payoutCandidates > 0, onClick: () => go('payouts') },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <button
            key={c.label} onClick={c.onClick}
            className={`text-right rounded-xl border bg-white p-4 hover:shadow-sm transition ${c.hot ? 'border-[#F3C9B6]' : 'border-[#E7DECD]'}`}
          >
            <div className="flex items-center gap-2 text-[11.5px] font-semibold text-gray-500">
              <c.icon className={`w-4 h-4 ${c.hot ? 'text-[#E15A30]' : ''}`} /> {c.label}
            </div>
            <div className={`mt-1.5 text-2xl font-bold tabular-nums ${c.hot ? 'text-[#E15A30]' : 'text-[#1F1A13]'}`} dir="ltr">{c.value}</div>
            <div className="mt-0.5 text-[11px] text-gray-400">{c.hint}</div>
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <section className="rounded-xl border border-[#E7DECD] bg-white p-4 text-[12.5px] space-y-1.5">
          <h3 className="text-sm font-bold text-[#1F1A13] mb-1">السفراء والإسناد</h3>
          <Row k="السفراء المعتمدون" v={String(o.affiliates.approved)} />
          <Row k="الموقوفون" v={String(o.affiliates.suspended)} />
          <Row k="كل الحسابات" v={String(o.affiliates.total)} />
          <Row k="إسنادات فعّالة" v={String(o.attributions.active)} />
        </section>
        <section className="rounded-xl border border-[#E7DECD] bg-white p-4 text-[12.5px] space-y-1.5">
          <h3 className="text-sm font-bold text-[#1F1A13] mb-1">العمولات</h3>
          <Row k="في فترة الحجز" v={L.formatHalalas(o.commissions.pendingHalalas)} />
          <Row k="موقوفة" v={L.formatHalalas(o.commissions.onHoldHalalas)} />
          <Row k="معتمدة لم تُصرف" v={L.formatHalalas(o.commissions.approvedUnpaidHalalas)} />
          <Row k="مدفوعة (مسجَّلة)" v={L.formatHalalas(o.commissions.paidHalalas)} />
        </section>
      </div>

      <Note tone="money">
        قواعد البرنامج: <b>عمولة واحدة لكل شركة</b> على <b>أول دفعة مؤكَّدة</b> بكامل مبلغها شاملاً الضريبة (ولو غطّت سنة).
        لا تُعتمد قبل انتهاء فترة الحجز، ويُعاد فحص حالة رابط الدفع عند الاعتماد. <b>الصرف يدوي</b>: تحوّل أنت من البنك وتسجّل المرجع هنا.
      </Note>
    </div>
  );
}

function Row({ k, v, danger }: { k: string; v: ReactNode; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[#6E6557]">{k}</span>
      <span className={`font-semibold tabular-nums ${danger ? 'text-red-600' : 'text-[#1F1A13]'}`}>{v}</span>
    </div>
  );
}

// ─── ٢) المسوّقون ──────────────────────────────────────────────────────────

function AffiliateActions({ a, actions }: { a: { id: string; fullName: string; status: L.UserStatus }; actions: Actions }) {
  const list = L.USER_ACTIONS[a.status] ?? [];
  if (list.length === 0) return <span className="text-[11px] text-gray-400">—</span>;
  const k = (x: string) => `aff:${x}:${a.id}`;
  return (
    <div className="flex flex-wrap gap-1">
      {list.includes('approve') && (
        <ActionBtn tone="good" icon={CheckCircle2} disabled={actions.busy === k('approve')}
          onClick={() => actions.run(k('approve'), () => affApi.affiliateAction(a.id, 'approve'), `اعتُمد ${a.fullName} وأُبلغ بالبريد`)}>
          اعتماد
        </ActionBtn>
      )}
      {list.includes('reject') && (
        <ActionBtn tone="bad" icon={XCircle}
          onClick={() => actions.ask({
            key: k('reject'), title: `رفض طلب ${a.fullName}`, confirmLabel: 'رفض الطلب', danger: true, mode: 'text',
            hint: 'يصل السبب للمتقدّم في بريد الرفض.',
            action: (reason) => affApi.affiliateAction(a.id, 'reject', reason), success: 'رُفض الطلب',
          })}>
          رفض
        </ActionBtn>
      )}
      {list.includes('suspend') && (
        <ActionBtn tone="bad" icon={PauseCircle}
          onClick={() => actions.ask({
            key: k('suspend'), title: `إيقاف ${a.fullName}`, confirmLabel: 'إيقاف', danger: true, mode: 'text',
            hint: 'الموقوف يدخل البوابة ولا يرى أرباحه ولا يرشّح. العمولات القائمة لا تُمسّ تلقائياً — راجعها من تبويب العمولات.',
            action: (reason) => affApi.affiliateAction(a.id, 'suspend', reason), success: 'أُوقف السفير',
          })}>
          إيقاف
        </ActionBtn>
      )}
      {list.includes('reactivate') && (() => {
        const copy = L.reactivateCopy(a.status);
        return (
          <ActionBtn tone="good" icon={a.status === 'rejected' ? RotateCcw : PlayCircle} disabled={actions.busy === k('reactivate')}
            title={a.status === 'rejected' ? 'يعيد الطلب «بانتظار المراجعة» — لا يعتمده' : undefined}
            onClick={() => actions.run(k('reactivate'), () => affApi.affiliateAction(a.id, 'reactivate'), copy.success)}>
            {copy.label}
          </ActionBtn>
        );
      })()}
    </div>
  );
}

function MawthooqCell({ a }: { a: { publicPromoter: boolean; mawthooqNo: string | null; mawthooqExpiry: string | null } }) {
  if (!a.publicPromoter && !a.mawthooqNo) return <span className="text-[11px] text-gray-400">لا ينشر علناً</span>;
  const expired = L.isDayExpired(a.mawthooqExpiry);
  const missing = a.publicPromoter && (!a.mawthooqNo || !a.mawthooqExpiry);
  return (
    <div className="text-[11.5px]">
      {a.publicPromoter && <p className="text-[#6E6557]">ينشر علناً</p>}
      {a.mawthooqNo && <p className="font-mono" dir="ltr">{a.mawthooqNo}</p>}
      {a.mawthooqExpiry && (
        <p className={expired ? 'text-red-600 font-bold' : 'text-[#9A8F7E]'}>
          {expired ? 'منتهٍ ' : 'ينتهي '}{dayOnly(a.mawthooqExpiry)}
        </p>
      )}
      {missing && <p className="text-red-600 font-bold">بيانات موثوق ناقصة</p>}
    </div>
  );
}

function AffiliatesTab({ status, setStatus }: { status: string; setStatus: (v: string) => void }) {
  const actions = useActions();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 350);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: [KEY, 'affiliates', status, dq],
    queryFn: () => affApi.affiliates(status, dq),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <StatusFilter values={L.USER_STATUSES} map={L.USER_STATUS_LABEL} value={status} onChange={setStatus} />
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-gray-400 absolute top-1/2 -translate-y-1/2 right-3" />
          <input className="input w-full pr-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="اسم، بريد، جوال، رمز" />
        </div>
      </div>

      {isLoading ? <Loading /> : isError ? <Failed onRetry={() => refetch()} /> : !data || data.length === 0 ? (
        <Empty>{status || dq ? 'لا نتائج مطابقة' : 'لا طلبات انضمام بعد — شارك رابط البوابة من تبويب الإعدادات'}</Empty>
      ) : (
        <div className={isFetching ? 'opacity-70 transition-opacity' : ''}>
          <Table head={<>
            <Th>السفير</Th><Th>التواصل</Th><Th>الحالة</Th><Th>موثوق</Th><Th>النشاط</Th><Th>الأرباح</Th><Th>التسجيل</Th><Th>إجراءات</Th>
          </>}>
            {data.map((a) => (
              <tr key={a.id} className="hover:bg-[#FBEBE2]/30">
                <Td>
                  <button onClick={() => setOpenId(a.id)} className="text-right hover:underline">
                    <p className="font-semibold text-[#1F1A13] whitespace-nowrap">{a.fullName}</p>
                  </button>
                  <p className="text-[10.5px] text-[#9A8F7E] font-mono" dir="ltr">{a.code}</p>
                  {a.city && <p className="text-[10.5px] text-[#9A8F7E]">{a.city}</p>}
                </Td>
                <Td>
                  <p className="text-[11.5px] font-mono" dir="ltr">{a.email}</p>
                  {a.phone && <p className="text-[11.5px] font-mono text-[#6E6557]" dir="ltr">{a.phone}</p>}
                </Td>
                <Td>
                  <StatusChip map={L.USER_STATUS_LABEL} value={a.status} />
                  {a.statusReason && <p className="text-[10.5px] text-[#9A8F7E] mt-1 max-w-[160px]">{a.statusReason}</p>}
                </Td>
                <Td><MawthooqCell a={a} /></Td>
                <Td className="text-[11.5px] text-[#6E6557] whitespace-nowrap">
                  <p>ترشيحات {a.counts.claims}</p>
                  <p>شركات {a.counts.attributions}</p>
                  <p>عمولات {a.counts.commissions}</p>
                </Td>
                <Td className="text-[11.5px] whitespace-nowrap">
                  <p className="font-semibold tabular-nums">{L.formatHalalas(a.earnedHalalas)}</p>
                  <p className="text-[#9A8F7E]">مدفوع {L.formatHalalas(a.paidHalalas)}</p>
                  {a.hasPayout ? <p className="text-green-700">آيبان مُدخل</p> : <p className="text-gray-400">بلا آيبان</p>}
                </Td>
                <Td className="text-[11px] text-[#9A8F7E] whitespace-nowrap">
                  <p>{day(a.createdAt)}</p>
                  <p>دخول: {a.lastLoginAt ? day(a.lastLoginAt) : 'لم يدخل'}</p>
                </Td>
                <Td>
                  <div className="space-y-1">
                    <AffiliateActions a={a} actions={actions} />
                    <button onClick={() => setOpenId(a.id)} className="text-[11px] text-[#E15A30] hover:underline">التفاصيل</button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {openId && <AffiliateDrawer id={openId} actions={actions} onClose={() => setOpenId(null)} />}
      {actions.dialog}
    </div>
  );
}

function DrawerSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[#E7DECD] bg-white p-3.5">
      <h4 className="text-[13px] font-bold text-[#1F1A13] mb-2">
        {title}{count !== undefined && <span className="text-[#9A8F7E] font-medium"> ({count})</span>}
      </h4>
      {children}
    </section>
  );
}

function MiniList({ empty, children }: { empty: boolean; children: ReactNode }) {
  if (empty) return <p className="text-[12px] text-gray-400">لا شيء</p>;
  return <ul className="divide-y divide-[#F1EBDF] text-[12px]">{children}</ul>;
}

function AffiliateDrawer({ id, actions, onClose }: { id: string; actions: Actions; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: [KEY, 'affiliate', id], queryFn: () => affApi.affiliate(id) });
  const a = data?.affiliate;

  return (
    <div className="fixed inset-0 z-[65] bg-black/30" dir="rtl" {...backdropClose(onClose)}>
      <aside className="absolute inset-y-0 left-0 w-full max-w-2xl bg-[#FAF7F0] shadow-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-[#FAF7F0] border-b border-[#E7DECD] px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-[#1F1A13] truncate">{a?.fullName ?? 'تفاصيل السفير'}</h3>
            {a && <p className="text-[11px] text-[#9A8F7E]"><span className="font-mono" dir="ltr">{a.code}</span> · {L.labelOf(L.USER_STATUS_LABEL, a.status)}</p>}
          </div>
          {a && <AffiliateActions a={a} actions={actions} />}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="p-4 space-y-3">
          {isLoading ? <Loading /> : isError || !data || !a ? <Failed onRetry={() => refetch()} /> : (
            <>
              <DrawerSection title="الملف">
                <div className="grid sm:grid-cols-2 gap-x-5 gap-y-1.5 text-[12.5px]">
                  <Row k="البريد" v={<span className="font-mono text-[11.5px]" dir="ltr">{a.email}</span>} />
                  <Row k="الجوال" v={a.phone ? <span className="font-mono text-[11.5px]" dir="ltr">{a.phone}</span> : '—'} />
                  <Row k="المدينة" v={a.city || '—'} />
                  <Row k="الحالة" v={<StatusChip map={L.USER_STATUS_LABEL} value={a.status} />} />
                  <Row k="سجّل" v={day(a.createdAt)} />
                  <Row k="آخر دخول" v={a.lastLoginAt ? formatDateTime(a.lastLoginAt) : 'لم يدخل'} />
                  <Row k="إصدار الشروط" v={<span className="font-mono text-[11.5px]" dir="ltr">{a.termsVersion || '—'}</span>} />
                  <Row k="قبِلها" v={day(a.termsAcceptedAt)} />
                  <Row k="الرقم الضريبي" v={a.vatNumber ? <span className="font-mono text-[11.5px]" dir="ltr">{a.vatNumber}</span> : '—'} />
                  <Row k="موافقة تسويقية" v={a.marketingConsent ? 'نعم' : 'لا'} />
                </div>
                {a.statusReason && <p className="mt-2 text-[12px] text-[#6E6557]">سبب الحالة: {a.statusReason}</p>}
              </DrawerSection>

              <DrawerSection title="موثوق (النشر العلني)">
                {(() => {
                  const expired = L.isDayExpired(a.mawthooqExpiry);
                  const missing = a.publicPromoter && (!a.mawthooqNo || !a.mawthooqExpiry);
                  return (
                    <div className="grid sm:grid-cols-2 gap-x-5 gap-y-1.5 text-[12.5px]">
                      <Row k="ينشر علناً" v={a.publicPromoter ? 'نعم' : 'لا'} />
                      <Row k="رقم الترخيص" v={a.mawthooqNo ? <span className="font-mono" dir="ltr">{a.mawthooqNo}</span> : '—'} />
                      <Row k="تاريخ الانتهاء" v={a.mawthooqExpiry ? `${dayOnly(a.mawthooqExpiry)}${expired ? ' — منتهٍ' : ''}` : '—'} danger={expired} />
                      {missing && <p className="sm:col-span-2 text-[12px] text-red-600 font-bold">يعلن أنه ينشر علناً بلا ترخيص موثوق كامل.</p>}
                      {expired && <p className="sm:col-span-2 text-[12px] text-red-600 font-bold">انتهى ترخيص موثوق — النشر العلني دون ترخيص ساري مخالفة.</p>}
                    </div>
                  );
                })()}
              </DrawerSection>

              <DrawerSection title="بيانات الاستلام">
                {a.payout ? (
                  <div className="space-y-2">
                    <div className="grid sm:grid-cols-2 gap-x-5 gap-y-1.5 text-[12.5px]">
                      <Row k="صاحب الحساب" v={a.payout.holderName} />
                      <Row k="البنك" v={a.payout.bankName || '—'} />
                      <Row k="الآيبان" v={<span className="font-mono" dir="ltr">•••• {a.payout.ibanLast4}</span>} />
                      <Row k="حُدّث" v={day(a.payout.updatedAt)} />
                    </div>
                    <RevealIban affiliateId={a.id} />
                  </div>
                ) : <p className="text-[12px] text-gray-400">لم يُدخل آيبان — يُطلب منه بعد أول عمولة معتمدة.</p>}
              </DrawerSection>

              <DrawerSection title="الترشيحات" count={data.claims.length}>
                <MiniList empty={data.claims.length === 0}>
                  {data.claims.map((c) => (
                    <li key={c.id} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{c.companyName ?? '—'}</span>
                      {c.crNumber && <span className="font-mono text-[11px] text-[#9A8F7E]" dir="ltr">{c.crNumber}</span>}
                      <StatusChip map={L.CLAIM_STATUS_LABEL} value={c.status} />
                      {c.reasonCode && <Chip>{L.labelOf(L.CLAIM_REASON_LABEL, c.reasonCode)}</Chip>}
                      <span className="text-[11px] text-[#9A8F7E] mr-auto">{day(c.submittedAt)}</span>
                    </li>
                  ))}
                </MiniList>
              </DrawerSection>

              <DrawerSection title="الشركات المُسندة" count={data.attributions.length}>
                <MiniList empty={data.attributions.length === 0}>
                  {data.attributions.map((t) => (
                    <li key={t.id} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{t.tenantName ?? t.tenantNameSnapshot ?? '—'}</span>
                      {t.source && <span className="text-[11px] text-[#9A8F7E]">{L.labelOf(L.SOURCE_LABEL, t.source)}</span>}
                      <StatusChip map={L.ATTRIBUTION_STATUS_LABEL} value={t.status} />
                      {(t.flags ?? []).map((f) => <Chip key={f} tone="red">{L.labelOf(L.FLAG_LABEL, f)}</Chip>)}
                      <span className="text-[11px] text-[#9A8F7E] mr-auto">{day(t.effectiveFrom ?? t.createdAt)}</span>
                    </li>
                  ))}
                </MiniList>
              </DrawerSection>

              <DrawerSection title="العمولات" count={data.commissions.length}>
                <MiniList empty={data.commissions.length === 0}>
                  {data.commissions.map((c) => (
                    <li key={c.id} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{c.tenantName ?? c.tenantNameSnapshot ?? '—'}</span>
                      <span className="tabular-nums font-bold">{L.formatHalalas(c.commissionHalalas)}</span>
                      {c.paymentAmountHalalas != null && <span className="text-[11px] text-[#9A8F7E]">من {L.formatHalalas(c.paymentAmountHalalas)}</span>}
                      <StatusChip map={L.COMMISSION_STATUS_LABEL} value={c.status} />
                      {c.reasonNote && <span className="text-[11px] text-[#6E6557]">{c.reasonNote}</span>}
                      <span className="text-[11px] text-[#9A8F7E] mr-auto">تستحق {day(c.eligibleAt)}</span>
                    </li>
                  ))}
                </MiniList>
              </DrawerSection>

              <DrawerSection title="التصحيحات" count={data.adjustments.length}>
                <MiniList empty={data.adjustments.length === 0}>
                  {data.adjustments.map((j) => (
                    <li key={j.id} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className={`tabular-nums font-bold ${(j.amountHalalas ?? 0) < 0 ? 'text-red-600' : 'text-green-700'}`} dir="ltr">{L.formatHalalas(j.amountHalalas)}</span>
                      <Chip>{L.labelOf(L.ADJUSTMENT_KIND_LABEL, j.kind)}</Chip>
                      {(() => { const st = L.adjustmentState(j); return <Chip tone={st.tone}>{st.label}</Chip>; })()}
                      {j.note && <span className="text-[11px] text-[#6E6557]">{j.note}</span>}
                      <span className="text-[11px] text-[#9A8F7E] mr-auto">{day(j.createdAt)}</span>
                    </li>
                  ))}
                </MiniList>
              </DrawerSection>

              <DrawerSection title="الدفعات" count={data.payouts.length}>
                <MiniList empty={data.payouts.length === 0}>
                  {data.payouts.map((p) => (
                    <li key={p.id} className="py-1.5 flex flex-wrap items-center gap-2">
                      <span className="tabular-nums font-bold">{L.formatHalalas(p.netHalalas)}</span>
                      <StatusChip map={L.PAYOUT_STATUS_LABEL} value={p.status} />
                      {p.bankReference && <span className="font-mono text-[11px]" dir="ltr">{p.bankReference}</span>}
                      {p.transferredAt && <span className="text-[11px] text-[#6E6557]">حُوّلت {dayOnly(p.transferredAt)}</span>}
                      {p.voidReason && <span className="text-[11px] text-[#9A8F7E]">ألغيت: {p.voidReason}</span>}
                      <span className="text-[11px] text-[#9A8F7E] mr-auto">{day(p.createdAt)}</span>
                    </li>
                  ))}
                </MiniList>
              </DrawerSection>

              <DrawerSection title="سجل الأحداث" count={data.events.length}>
                {data.events.length === 0 ? <p className="text-[12px] text-gray-400">لا أحداث</p> : (
                  <ol className="relative border-r-2 border-[#E7DECD] pr-3 space-y-2">
                    {data.events.map((ev) => (
                      <li key={ev.id} className="text-[12px]">
                        <span className="absolute -right-[5px] mt-1.5 w-2 h-2 rounded-full bg-[#E15A30]" />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <History className="w-3.5 h-3.5 text-[#9A8F7E]" />
                          <span className="font-semibold font-mono text-[11.5px]" dir="ltr">{ev.entity}.{ev.action}</span>
                          {(ev.fromState || ev.toState) && (
                            <span className="font-mono text-[11px] text-[#6E6557]" dir="ltr">{ev.fromState ?? '∅'} → {ev.toState ?? '∅'}</span>
                          )}
                          <span className="text-[11px] text-[#9A8F7E]">{L.labelOf(L.ACTOR_LABEL, ev.actorType)}</span>
                          <span className="text-[11px] text-[#9A8F7E] mr-auto">{formatDateTime(ev.createdAt)}</span>
                        </div>
                        {ev.reason && <p className="text-[11.5px] text-[#6E6557] mt-0.5">{ev.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </DrawerSection>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── ٣) الترشيحات ──────────────────────────────────────────────────────────

function ClaimsTab({ status, setStatus }: { status: string; setStatus: (v: string) => void }) {
  const actions = useActions();
  const [linkFor, setLinkFor] = useState<L.ClaimRow | null>(null);
  const [tenant, setTenant] = useState<L.TenantHit | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [KEY, 'claims', status],
    queryFn: () => affApi.claims(status),
  });

  const linkMsg = (claim: L.ClaimRow, tenantName: string) => (result: unknown) =>
    L.claimLinkMessage(claim.companyName, tenantName, result as L.ClaimLinkResult);
  // من نافذة البحث — النافذة نفسها هي التأكيد
  const link = async (claim: L.ClaimRow, tenantId: string, tenantName: string) => {
    const ok = await actions.run(`claim:link:${claim.id}`, () => affApi.linkClaim(claim.id, tenantId), linkMsg(claim, tenantName));
    if (ok) { setLinkFor(null); setTenant(null); }
  };
  // من الاقتراحات — نقرة واحدة قد تُنشئ إسناداً وعمولة، فتُؤكَّد أولاً
  const confirmLink = (claim: L.ClaimRow, s: L.ClaimRow['suggestions'][number]) => actions.ask({
    key: `claim:link:${claim.id}`, title: `ربط «${claim.companyName}» بـ${s.tenantName}`, confirmLabel: 'ربط', mode: 'none',
    hint: <>{s.match === 'cr' ? 'السجل التجاري مطابق.' : 'تطابق بالاسم فقط — تحقّق أنها المنشأة نفسها.'} يُنشئ إسناداً للسفير <b>{claim.affiliate.fullName}</b>، أو يجعل إسناداً قائماً لسفير آخر متنازعاً عليه.</>,
    action: () => affApi.linkClaim(claim.id, s.tenantId), success: linkMsg(claim, s.tenantName),
  });

  return (
    <div className="space-y-3">
      <StatusFilter values={L.CLAIM_STATUSES} map={L.CLAIM_STATUS_LABEL} value={status} onChange={setStatus} />
      <Note>
        الترشيح لا يحمل بيانات أشخاص: اسم منشأة وسجل تجاري ومدينة فقط. <b>الأسبق يفوز</b> — لا يُعتمد ترشيحان ساريان بالسجل نفسه.
        بعد اعتماد الترشيح اربطه بالشركة حين تسجّل (من الاقتراحات أو البحث) — والمنتهي يُربط أيضاً إن سجّلت الشركة داخل مدّة قفله (وإلا يرفض الخادم).
      </Note>

      {isLoading ? <Loading /> : isError ? <Failed onRetry={() => refetch()} /> : !data || data.length === 0 ? (
        <Empty>لا ترشيحات{status ? ` بحالة «${L.labelOf(L.CLAIM_STATUS_LABEL, status)}»` : ''}</Empty>
      ) : (
        <div className="space-y-2.5">
          {data.map((c) => {
            const can = L.claimActions(c);
            const canLink = can.link;
            return (
              <article key={c.id} className="rounded-xl border border-[#E7DECD] bg-white p-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-[14px] font-bold text-[#1F1A13]">{c.companyName}</h4>
                      <StatusChip map={L.CLAIM_STATUS_LABEL} value={c.status} />
                      {c.reasonCode && <Chip tone="red">{L.labelOf(L.CLAIM_REASON_LABEL, c.reasonCode)}</Chip>}
                    </div>
                    <p className="text-[12px] text-[#6E6557] mt-0.5">
                      سجل تجاري <span className="font-mono" dir="ltr">{c.crNumber}</span>
                      {c.city ? ` · ${c.city}` : ''} · {L.labelOf(L.CLAIM_HOW_LABEL, c.how)}
                    </p>
                    {c.note && <p className="text-[12px] text-[#1F1A13] mt-1 bg-[#FAF7F0] rounded-lg px-2 py-1">«{c.note}»</p>}
                    <p className="text-[11px] text-[#9A8F7E] mt-1">
                      من <b className="text-[#1F1A13]">{c.affiliate.fullName}</b> <span className="font-mono" dir="ltr">{c.affiliate.code}</span>
                      {' '}· قُدّم {day(c.submittedAt)}
                      {c.reviewedAt ? ` · رُوجع ${day(c.reviewedAt)}` : ''}
                      {c.lockedUntil ? ` · مقفل له حتى ${day(c.lockedUntil)}` : ''}
                    </p>
                    {c.tenantId && (
                      <p className="text-[12px] text-green-700 mt-1 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> مرتبط بـ {c.tenantName ?? c.tenantId}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {can.approve && (
                      <ActionBtn tone="good" icon={CheckCircle2} disabled={actions.busy === `claim:approve:${c.id}`}
                        onClick={() => actions.run(`claim:approve:${c.id}`, () => affApi.approveClaim(c.id),
                          (r) => `اعتُمد الترشيح — مقفل للسفير حتى ${day(r.lockedUntil)}`)}>
                        اعتماد
                      </ActionBtn>
                    )}
                    {can.reject && (
                      <ActionBtn tone="bad" icon={XCircle}
                        onClick={() => actions.ask({
                          key: `claim:reject:${c.id}`, title: `رفض ترشيح «${c.companyName}»`, confirmLabel: 'رفض الترشيح', danger: true,
                          mode: 'claimReason',
                          hint: c.status === 'approved'
                            ? 'الترشيح معتمد — رفضه يفكّ قفله عن السجل التجاري. السفير يرى الحالة فقط.'
                            : 'السفير يرى الحالة فقط — لا يُكشف له أن الشركة عميل قائم.',
                          action: (code) => affApi.rejectClaim(c.id, code as L.ClaimReason), success: 'رُفض الترشيح',
                        })}>
                        رفض
                      </ActionBtn>
                    )}
                    {canLink && (
                      <ActionBtn tone="brand" icon={Link2} onClick={() => { setTenant(null); setLinkFor(c); }}>ربط بشركة</ActionBtn>
                    )}
                  </div>
                </div>

                {(c.conflicts.length > 0 || c.suggestions.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-2 mt-2.5">
                    {c.conflicts.length > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                        <p className="text-[11.5px] font-bold text-amber-900 mb-1 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> ترشيحات أخرى بالسجل نفسه</p>
                        <ul className="space-y-1">
                          {c.conflicts.map((x) => (
                            <li key={x.claimId} className="flex items-center gap-2 text-[12px]">
                              <span className="text-[#1F1A13]">{x.affiliateName}</span>
                              <StatusChip map={L.CLAIM_STATUS_LABEL} value={x.status} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.suggestions.length > 0 && (
                      <div className="rounded-lg border border-[#E7DECD] bg-[#FAF7F0] p-2.5">
                        <p className="text-[11.5px] font-bold text-[#1F1A13] mb-1 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> شركات مسجّلة مطابقة</p>
                        <ul className="space-y-1">
                          {c.suggestions.map((s) => (
                            <li key={s.tenantId} className="flex flex-wrap items-center gap-2 text-[12px]">
                              <span className="text-[#1F1A13] font-semibold">{s.tenantName}</span>
                              <Chip tone={s.match === 'cr' ? 'green' : 'amber'}>{s.match === 'cr' ? 'السجل التجاري مطابق' : 'الاسم مشابه'}</Chip>
                              <span className="text-[10.5px] text-[#9A8F7E]">{day(s.createdAt)}</span>
                              {canLink && (
                                <button
                                  onClick={() => confirmLink(c, s)} disabled={actions.busy === `claim:link:${c.id}`}
                                  className="mr-auto text-[11px] font-bold text-[#E15A30] hover:underline disabled:opacity-50"
                                >ربط</button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {linkFor && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(() => setLinkFor(null))}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5">
              <h3 className="text-base font-bold text-[#1F1A13]">ربط ترشيح «{linkFor.companyName}» بشركة</h3>
              <p className="text-[12px] text-[#6E6557] mt-1">
                سجل الترشيح <span className="font-mono" dir="ltr">{linkFor.crNumber}</span> · السفير {linkFor.affiliate.fullName}.
                يُنشئ إسناداً من نوع «ترشيح»، أو يجعل الإسناد القائم لسفير آخر «متنازعاً عليه».
              </p>
            </div>
            <div className="px-5 py-4"><TenantSearchBox selected={tenant} onSelect={setTenant} /></div>
            <div className="flex gap-2 p-5 pt-0">
              <button
                onClick={() => tenant && link(linkFor, tenant.id, tenant.name)}
                disabled={!tenant || actions.busy === `claim:link:${linkFor.id}`}
                className="flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-50"
              ><Link2 className="w-4 h-4" /> ربط</button>
              <button onClick={() => setLinkFor(null)} className="btn-secondary">إلغاء</button>
            </div>
          </div>
        </div>
      )}
      {actions.dialog}
    </div>
  );
}

// ─── ٤) الإسناد ────────────────────────────────────────────────────────────

function useAffiliateOptions() {
  return useQuery({
    queryKey: [KEY, 'affiliates', '', ''],
    queryFn: () => affApi.affiliates('', ''),
    select: (list) => L.sortAffiliatesForSelect(list),
  });
}

function AffiliateSelect({ value, onChange, approvedOnly = false, currentId }: {
  value: string; onChange: (id: string) => void; approvedOnly?: boolean; currentId?: string;
}) {
  const { data, isLoading } = useAffiliateOptions();
  const list = (data ?? []).filter((a) => !approvedOnly || a.status === 'approved');
  return (
    <select className="input w-full" value={value} onChange={(e) => onChange(e.target.value)} disabled={isLoading}>
      <option value="">{isLoading ? 'جارٍ التحميل…' : 'اختر السفير'}</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.fullName} — {a.code}{a.status !== 'approved' ? ` (${L.labelOf(L.USER_STATUS_LABEL, a.status)})` : ''}{a.id === currentId ? ' (الحالي)' : ''}
        </option>
      ))}
    </select>
  );
}

function ManualAttributionForm({ actions, onDone }: { actions: Actions; onDone: () => void }) {
  const [tenant, setTenant] = useState<L.TenantHit | null>(null);
  const [affiliateId, setAffiliateId] = useState('');
  const [reason, setReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const err = !tenant ? 'اختر الشركة' : !affiliateId ? 'اختر السفير'
      : L.validateReason(reason) ?? (effectiveFrom && !L.isIsoDay(effectiveFrom) ? 'تاريخ البدء غير صالح' : null);
    setError(err);
    if (err || !tenant) return;
    const ok = await actions.run('attr:create', () => affApi.createAttribution({
      tenantId: tenant.id, affiliateId, reason: reason.trim(), ...(effectiveFrom ? { effectiveFrom } : {}),
    }), (r) => L.withAccrual(
      `أُسندت ${tenant.name} — ${L.labelOf(L.ATTRIBUTION_STATUS_LABEL, r?.attribution?.status)}`,
      r?.commissionCreated === undefined ? { commissionCreated: !!r?.commission } : r,
    ));
    if (ok) onDone();
  };

  return (
    <section className="rounded-xl border border-[#F3C9B6] bg-white p-4 space-y-3">
      <h4 className="text-sm font-bold text-[#1F1A13]">إسناد يدوي</h4>
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">الشركة *</label>
          <TenantSearchBox selected={tenant} onSelect={setTenant} warnAttributed />
          {tenant?.attributed && (
            <p className="text-[11px] text-red-600 mt-1">
              لهذه الشركة إسنادٌ مسبق — يُرفض إسنادٌ ثانٍ ولو كان القائم مُبطَلاً. لنقلها لسفير آخر استعمل «إعادة إسناد» على صفّها في الجدول (متاحة للمتنازع عليه والمُبطَل).
            </p>
          )}
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السفير *</label>
            <AffiliateSelect value={affiliateId} onChange={setAffiliateId} />
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">يسري من (اختياري)</label>
            <input type="date" className="input w-full" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            <p className="text-[10.5px] text-[#9A8F7E] mt-0.5">فارغ = من اليوم. لا تُحتسب إلا أول دفعة مؤكَّدة بعد هذا التاريخ.</p>
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السبب *</label>
          <textarea rows={2} maxLength={500} className="input w-full resize-none" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: أحالها السفير بمكالمة موثّقة ولم يُستخدم الرمز عند التسجيل" />
        </div>
      </div>
      {error && <p className="text-[12px] text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="btn-secondary">إغلاق</button>
        <button onClick={submit} disabled={actions.busy === 'attr:create'} className="btn-primary disabled:opacity-50">
          <Link2 className="w-4 h-4" /> {actions.busy === 'attr:create' ? 'يُسند…' : 'إسناد'}
        </button>
      </div>
    </section>
  );
}

/** إعادة إسناد متنازعٍ عليه أو مُبطَل — `POST /attributions/:id/reassign` */
function ReassignDialog({ row, actions, onClose }: { row: L.AttributionRow; actions: Actions; onClose: () => void }) {
  const [form, setForm] = useState<L.ReassignForm>({ affiliateId: '', reason: '', effectiveFrom: '', claimId: '' });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof L.ReassignForm>(k: K, v: L.ReassignForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const approved = useQuery({ queryKey: [KEY, 'claims', 'approved'], queryFn: () => affApi.claims('approved') });
  const expired = useQuery({ queryKey: [KEY, 'claims', 'expired'], queryFn: () => affApi.claims('expired') });
  const claimOptions = L.reassignClaimOptions([...(approved.data ?? []), ...(expired.data ?? [])], form.affiliateId);
  const claimsLoading = approved.isLoading || expired.isLoading;
  const key = `attr:reassign:${row.id}`;

  const submit = async () => {
    const err = L.validateReassign(form);
    setError(err);
    if (err) return;
    await actions.run(key, () => affApi.reassignAttribution(row.id, L.buildReassignBody(form)),
      (r) => L.reassignMessage(row.tenantName, r));
    // النجاح يُحدِّث الجدول، والرفض (409 «ألغِ مسودّة الدفعة أولاً…» مثلاً) يُعرض نصّه — وفي الحالتين تُغلق
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5">
          <div>
            <h3 className="text-base font-bold text-[#1F1A13]">إعادة إسناد {row.tenantName}</h3>
            <p className="text-[12px] text-[#6E6557] mt-1">
              الحالي: <b>{row.affiliate.fullName}</b> <span className="font-mono" dir="ltr">{row.affiliate.code}</span> · {L.labelOf(L.ATTRIBUTION_STATUS_LABEL, row.status)}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5"><X className="w-4 h-4 text-gray-500" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Note tone="money">تنقل الشركة لهذا السفير وتُعيد احتساب عمولتها غير المصروفة (والمرفوضة) بنسبة شروطه، ويبقى إيقاف المالك اليدوي. العمولة المصروفة يُقيَّد عكسها على السفير السابق ولصالح الجديد تلقائياً</Note>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السفير الجديد * (المعتمدون فقط)</label>
            <AffiliateSelect approvedOnly currentId={row.affiliate.id} value={form.affiliateId} onChange={(id) => setForm((f) => ({ ...f, affiliateId: id, claimId: '' }))} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">يسري من (اختياري)</label>
              <input type="date" className="input w-full" dir="ltr" value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">ترشيح مرتبط (اختياري)</label>
              <select className="input w-full" value={form.claimId} onChange={(e) => set('claimId', e.target.value)} disabled={!form.affiliateId || claimsLoading}>
                <option value="">
                  {!form.affiliateId ? 'اختر السفير أولاً' : claimsLoading ? 'جارٍ التحميل…' : claimOptions.length === 0 ? 'لا ترشيحات معتمدة أو منتهية' : 'بلا ترشيح'}
                </option>
                {claimOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName} — {c.crNumber} ({L.labelOf(L.CLAIM_STATUS_LABEL, c.status)})</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السبب *</label>
            <textarea rows={2} maxLength={500} className="input w-full resize-none" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="يُحفظ في سجل الأحداث" />
          </div>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <button onClick={submit} disabled={actions.busy === key}
            className="flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-50">
            <Shuffle className="w-4 h-4" /> {actions.busy === key ? 'يُعيد الإسناد…' : 'إعادة إسناد'}
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/** تعديل بداية إسنادٍ بلا عمولة — `POST /attributions/:id/window` */
function WindowDialog({ row, actions, onClose }: { row: L.AttributionRow; actions: Actions; onClose: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState(L.dayKeyOf(row.effectiveFrom) ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = `attr:window:${row.id}`;

  const submit = async () => {
    const err = L.validateWindow(effectiveFrom, reason);
    setError(err);
    if (err) return;
    await actions.run(key, () => affApi.setAttributionWindow(row.id, { effectiveFrom, reason: reason.trim() }),
      (r) => L.withAccrual(`عُدّلت بداية إسناد ${row.tenantName} إلى ${formatDayOnly(effectiveFrom)}`, r));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5">
          <h3 className="text-base font-bold text-[#1F1A13]">تعديل بداية الإسناد</h3>
          <p className="text-[12px] text-[#6E6557] mt-1">
            {row.tenantName} · <b>{row.affiliate.fullName}</b> · يسري حالياً من {day(row.effectiveFrom)}
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Note>لاحتساب دفعةٍ تمّت قبل بداية الإسناد الحالية، كدفعة رابط تسجيل واتساب قبل إنشاء الحساب.</Note>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">بداية الإسناد *</label>
            <input type="date" className="input w-full" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السبب *</label>
            <textarea rows={2} maxLength={500} className="input w-full resize-none" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="يُحفظ في سجل الأحداث" />
          </div>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <button onClick={submit} disabled={actions.busy === key}
            className="flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-50">
            <CalendarClock className="w-4 h-4" /> {actions.busy === key ? 'يحفظ…' : 'حفظ البداية'}
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function AttributionsTab({ status, setStatus }: { status: string; setStatus: (v: string) => void }) {
  const actions = useActions();
  const [showForm, setShowForm] = useState(false);
  const [reassignFor, setReassignFor] = useState<L.AttributionRow | null>(null);
  const [windowFor, setWindowFor] = useState<L.AttributionRow | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [KEY, 'attributions', status],
    queryFn: () => affApi.attributions(status),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <StatusFilter values={L.ATTRIBUTION_STATUSES} map={L.ATTRIBUTION_STATUS_LABEL} value={status} onChange={setStatus} />
        {!showForm && <button onClick={() => setShowForm(true)} className="btn-primary"><Plus className="w-4 h-4" /> إسناد يدوي</button>}
      </div>
      {showForm && <ManualAttributionForm actions={actions} onDone={() => setShowForm(false)} />}

      {isLoading ? <Loading /> : isError ? <Failed onRetry={() => refetch()} /> : !data || data.length === 0 ? (
        <Empty>لا إسنادات{status ? ` بحالة «${L.labelOf(L.ATTRIBUTION_STATUS_LABEL, status)}»` : ''}</Empty>
      ) : (
        <Table head={<>
          <Th>الشركة</Th><Th>السفير</Th><Th>المصدر</Th><Th>الحالة والإشارات</Th><Th>المدّة</Th><Th>العمولة</Th><Th>إجراءات</Th>
        </>}>
          {data.map((t) => {
            const list = L.attributionActions(t);
            return (
              <tr key={t.id}>
                <Td>
                  <p className="font-semibold text-[#1F1A13]">{t.tenantName}</p>
                  <p className="text-[10.5px] text-[#9A8F7E]">أُنشئ {day(t.createdAt)}</p>
                </Td>
                <Td><AffCell a={t.affiliate} /></Td>
                <Td className="text-[11.5px]">
                  <p>{L.labelOf(L.SOURCE_LABEL, t.source)}</p>
                  {t.codeUsed && <p className="font-mono text-[#9A8F7E]" dir="ltr">{t.codeUsed}</p>}
                  {t.refVia && <p className="text-[#9A8F7E]">{L.labelOf(L.REF_VIA_LABEL, t.refVia)}</p>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1 max-w-[220px]">
                    <StatusChip map={L.ATTRIBUTION_STATUS_LABEL} value={t.status} />
                    {t.flags.map((f) => <Chip key={f} tone="red">{L.labelOf(L.FLAG_LABEL, f)}</Chip>)}
                  </div>
                  {t.reasonNote && <p className="text-[10.5px] text-[#6E6557] mt-1 max-w-[220px]">{t.reasonNote}</p>}
                </Td>
                <Td className="text-[11px] text-[#6E6557] whitespace-nowrap">
                  <p>من {day(t.effectiveFrom)}</p>
                  <p>آخر موعد للدفعة الأولى {day(t.firstPaymentDeadline)}</p>
                  <p>النسبة {L.bpsToPercent(t.rateBps)}%</p>
                </Td>
                <Td className="whitespace-nowrap">
                  {t.commission ? (
                    <>
                      <p className="font-bold tabular-nums">{L.formatHalalas(t.commission.commissionHalalas)}</p>
                      <StatusChip map={L.COMMISSION_STATUS_LABEL} value={t.commission.status} />
                    </>
                  ) : <span className="text-[11px] text-gray-400">لم تدفع بعد</span>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {list.includes('activate') && (
                      <ActionBtn tone="good" icon={PlayCircle}
                        onClick={() => actions.ask({
                          key: `attr:activate:${t.id}`, title: `تفعيل إسناد ${t.tenantName}`, confirmLabel: 'تفعيل', mode: 'text',
                          hint: <>يُسند الشركة لـ<b>{t.affiliate.fullName}</b>. إن كان رابط دفعتها الأولى ما زال مدفوعاً أُعيدت العمولة.</>,
                          action: (reason) => affApi.attributionAction(t.id, 'activate', reason),
                          success: (res) => L.withAccrual(`فُعّل إسناد ${t.tenantName}`, res as L.AccrualResult),
                        })}>
                        تفعيل
                      </ActionBtn>
                    )}
                    {list.includes('void') && (
                      <ActionBtn tone="bad" icon={Ban}
                        onClick={() => actions.ask({
                          key: `attr:void:${t.id}`, title: `إبطال إسناد ${t.tenantName}`, confirmLabel: 'إبطال', danger: true, mode: 'text',
                          hint: 'تُوقف عمولتها غير المصروفة (إلا ما أوقفته يدوياً فيبقى بسببه)؛ لنقلها لسفيرٍ آخر استعمل «إعادة إسناد» — لا ترفضها، فالرفض يُعاد احتسابه عند النقل',
                          action: (reason) => affApi.attributionAction(t.id, 'void', reason), success: 'أُبطل الإسناد',
                        })}>
                        إبطال
                      </ActionBtn>
                    )}
                    {list.includes('reassign') && (
                      <ActionBtn tone="brand" icon={Shuffle} onClick={() => setReassignFor(t)}>إعادة إسناد</ActionBtn>
                    )}
                    {list.includes('window') && (
                      <ActionBtn icon={CalendarClock} onClick={() => setWindowFor(t)} title="متاح لإسنادٍ بلا عمولة">تعديل بداية الإسناد</ActionBtn>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
      {reassignFor && <ReassignDialog row={reassignFor} actions={actions} onClose={() => setReassignFor(null)} />}
      {windowFor && <WindowDialog row={windowFor} actions={actions} onClose={() => setWindowFor(null)} />}
      {actions.dialog}
    </div>
  );
}

// ─── ٥) العمولات ───────────────────────────────────────────────────────────

function CommissionsTab({ status, setStatus }: { status: string; setStatus: (v: string) => void }) {
  const actions = useActions();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [KEY, 'commissions', status],
    queryFn: () => affApi.commissions(status),
  });

  return (
    <div className="space-y-3">
      <StatusFilter values={L.COMMISSION_STATUSES} map={L.COMMISSION_STATUS_LABEL} value={status} onChange={setStatus} />
      <Note>
        الأساس <b>كامل مبلغ الدفعة الأولى شاملاً الضريبة</b>. العمولة لا تُعتمد قبل انتهاء فترة الحجز، وعند الاعتماد
        يُعاد فحص رابط الدفع — إن لم يعد «مدفوعاً» تُعكس العمولة ويظهر السبب.
      </Note>

      {isLoading ? <Loading /> : isError ? <Failed onRetry={() => refetch()} /> : !data || data.length === 0 ? (
        <Empty>لا عمولات{status ? ` بحالة «${L.labelOf(L.COMMISSION_STATUS_LABEL, status)}»` : ''}</Empty>
      ) : (
        <Table head={<>
          <Th>الشركة</Th><Th>السفير</Th><Th>الدفعة (شامل الضريبة)</Th><Th>النسبة</Th><Th>العمولة</Th><Th>التواريخ</Th><Th>الحالة</Th><Th>رابط الدفع</Th><Th>إجراءات</Th>
        </>}>
          {data.map((c) => {
            const list = L.COMMISSION_ACTIONS[c.status] ?? [];
            const linkOk = c.linkStatus === 'paid';
            const k = (x: string) => `com:${x}:${c.id}`;
            return (
              <tr key={c.id} className={!linkOk && !['reversed', 'declined'].includes(c.status) ? 'bg-red-50/40' : ''}>
                <Td><p className="font-semibold text-[#1F1A13]">{c.tenantName}</p></Td>
                <Td><AffCell a={c.affiliate} /></Td>
                <Td className="whitespace-nowrap">
                  <p className="tabular-nums font-semibold">{L.formatHalalas(c.paymentAmountHalalas)}</p>
                  {(c.refundedHalalas ?? 0) > 0 && <p className="text-[10.5px] text-[#C0392B]">مستردّ {L.formatHalalas(c.refundedHalalas ?? 0)} — العمولة على الباقي</p>}
                  {c.coveredMonths > 0 && <p className="text-[10.5px] text-[#9A8F7E]">تغطي {c.coveredMonths} شهر</p>}
                </Td>
                <Td className="tabular-nums whitespace-nowrap">{L.bpsToPercent(c.rateBps)}%</Td>
                <Td className="whitespace-nowrap"><p className="tabular-nums font-bold text-[#1F1A13]">{L.formatHalalas(c.commissionHalalas)}</p></Td>
                <Td className="text-[11px] text-[#6E6557] whitespace-nowrap">
                  <p>دُفعت {day(c.paymentPaidAt)}</p>
                  <p>تستحق {day(c.eligibleAt)}</p>
                  {c.approvedAt && <p>اعتُمدت {day(c.approvedAt)}</p>}
                </Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <StatusChip map={L.COMMISSION_STATUS_LABEL} value={c.status} />
                    {c.status === 'pending' && c.readyToApprove && <Chip tone="green">جاهزة للاعتماد</Chip>}
                    {c.payoutId && <Chip tone="blue">في دفعة</Chip>}
                  </div>
                  {c.reasonNote && <p className="text-[10.5px] text-[#6E6557] mt-1 max-w-[180px]">{c.reasonNote}</p>}
                </Td>
                <Td className="whitespace-nowrap">
                  {linkOk ? <Chip tone="green">{L.labelOf(L.LINK_STATUS_LABEL, c.linkStatus)}</Chip> : (
                    <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-red-600" title="رابط الدفع لم يعد مدفوعاً — لا تُعتمد هذه العمولة">
                      <AlertTriangle className="w-3.5 h-3.5" /> {L.labelOf(L.LINK_STATUS_LABEL, c.linkStatus)}
                    </span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {list.includes('approve') && (
                      <ActionBtn tone="good" icon={CheckCircle2}
                        disabled={!c.readyToApprove || actions.busy === k('approve')}
                        title={c.readyToApprove ? 'اعتماد العمولة' : `في فترة الحجز حتى ${day(c.eligibleAt)}`}
                        onClick={() => actions.run(k('approve'), () => affApi.commissionAction(c.id, 'approve'), 'اعتُمدت العمولة — تدخل أول دفعة تُنشئها')}>
                        اعتماد
                      </ActionBtn>
                    )}
                    {list.includes('hold') && (
                      <ActionBtn icon={PauseCircle}
                        onClick={() => actions.ask({
                          key: k('hold'), title: `إيقاف عمولة ${c.tenantName}`, confirmLabel: 'إيقاف مؤقت', mode: 'text',
                          hint: 'تبقى موقوفة حتى تحرّرها. السبب يظهر للسفير.',
                          action: (reason) => affApi.commissionAction(c.id, 'hold', reason), success: 'أُوقفت العمولة',
                        })}>
                        إيقاف
                      </ActionBtn>
                    )}
                    {list.includes('release') && (
                      <ActionBtn tone="good" icon={PlayCircle} disabled={actions.busy === k('release')}
                        onClick={() => actions.run(k('release'), () => affApi.commissionAction(c.id, 'release'), 'حُرّرت العمولة وعادت لفترة الحجز')}>
                        تحرير
                      </ActionBtn>
                    )}
                    {list.includes('decline') && (
                      <ActionBtn tone="bad" icon={XCircle}
                        onClick={() => actions.ask({
                          key: k('decline'), title: `رفض عمولة ${c.tenantName}`, confirmLabel: 'رفض نهائي', danger: true, mode: 'text',
                          hint: 'الرفض نهائي ولا يُتراجع عنه. السبب يظهر للسفير.',
                          action: (reason) => affApi.commissionAction(c.id, 'decline', reason), success: 'رُفضت العمولة',
                        })}>
                        رفض
                      </ActionBtn>
                    )}
                    {list.length === 0 && <span className="text-[11px] text-gray-400">—</span>}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
      {actions.dialog}
    </div>
  );
}

// ─── ٦) الصرف ──────────────────────────────────────────────────────────────

function RecordPayoutDialog({ payout, actions, onClose }: { payout: L.PayoutRow; actions: Actions; onClose: () => void }) {
  const today = L.riyadhDayKey();
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const key = `pay:record:${payout.id}`;
  const submit = async () => {
    const err = L.validatePayoutRecord(ref, date, today);
    setError(err);
    if (err) return;
    // المبلغ من الدفعة **المُعادة** لا من لقطة الصفّ. وأي رفضٍ من الخادم يُعرض نصّه وتُغلق
    // النافذة (الاستعلامات تُحدَّث في الحالتين) — لا تبقى مفتوحة على بيانات قديمة.
    await actions.run(key, () => affApi.recordPayout(payout.id, { bankReference: ref.trim(), transferredAt: date }),
      (p) => `سُجّل التحويل — ${L.formatHalalas(p?.netHalalas)} لـ${payout.affiliate.fullName}`);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5">
          <h3 className="text-base font-bold text-[#1F1A13]">تسجيل التحويل البنكي</h3>
          <p className="text-[12.5px] text-[#6E6557] mt-1">
            {payout.affiliate.fullName} · <b className="tabular-nums text-[#1F1A13]">{L.formatHalalas(payout.netHalalas)}</b> ·
            {' '}{payout.holderName} <span className="font-mono" dir="ltr">•••• {payout.ibanLast4}</span>
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Note tone="money">
            سجّل <b>بعد</b> أن تحوّل المبلغ بنفسك من حسابك البنكي. المنصّة لا تحوّل شيئاً — التسجيل يجعل العمولات «مدفوعة» ويُظهر المرجع للسفير.
          </Note>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">مرجع التحويل البنكي *</label>
            <input autoFocus className="input w-full" dir="ltr" maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="رقم العملية من كشف البنك" />
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">تاريخ التحويل *</label>
            <input type="date" className="input w-full" dir="ltr" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 p-5 pt-0">
          <button onClick={submit} disabled={actions.busy === key}
            className="flex-1 justify-center py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 bg-[#1E7A52] hover:bg-[#186444] disabled:opacity-50">
            <CheckCircle2 className="w-4 h-4" /> {actions.busy === key ? 'يسجّل…' : 'حوّلت المبلغ — سجّل'}
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

function PayoutsTab({ status, setStatus }: { status: string; setStatus: (v: string) => void }) {
  const actions = useActions();
  const [recordFor, setRecordFor] = useState<L.PayoutRow | null>(null);
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const { data: settings } = useQuery({ queryKey: [KEY, 'settings'], queryFn: affApi.settings });
  const cand = useQuery({ queryKey: [KEY, 'payout-candidates'], queryFn: affApi.candidates });
  const pays = useQuery({ queryKey: [KEY, 'payouts', status], queryFn: () => affApi.payouts(status) });

  return (
    <div className="space-y-4">
      <Note tone="money">
        <b>الصرف يدوي بالكامل — المنصّة لا تحرّك أي مال.</b> الخطوات: (١) «إنشاء دفعة» يجمّد العمولات المعتمدة والتصحيحات في مسودّة
        <b> صافيها ثابت لا يتغيّر</b> — أي استرداد يصل بعدها يصير قيد تصحيح سالباً في الدفعة التالية.
        (٢) تحوّل أنت الصافي من حسابك البنكي إلى آيبان السفير. (٣) تسجّل مرجع التحويل وتاريخه هنا فتصير العمولات «مدفوعة».
        {settings && <> الحدّ الأدنى للصرف {L.formatHalalas(settings.minPayoutHalalas)}، ولا تُنشأ دفعة بصافٍ صفر أو سالب.</>}
      </Note>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#1F1A13]">المرشّحون للصرف</h3>
          <button onClick={() => cand.refetch()} className="p-1.5 rounded-lg hover:bg-black/5" title="تحديث"><RefreshCw className={`w-4 h-4 text-gray-500 ${cand.isFetching ? 'animate-spin' : ''}`} /></button>
        </div>
        {cand.isLoading ? <Loading /> : cand.isError ? <Failed onRetry={() => cand.refetch()} /> : !cand.data || cand.data.length === 0 ? (
          <Empty>لا مستحقّات معتمدة غير مصروفة</Empty>
        ) : (
          <Table head={<>
            <Th>السفير</Th><Th>العمولات</Th><Th>التصحيحات</Th><Th>الصافي</Th><Th>الآيبان</Th><Th>الأهلية</Th><Th></Th>
          </>}>
            {cand.data.map((c) => {
              const blocker = L.candidateBlocker(c, settings?.minPayoutHalalas);
              const can = L.canCreatePayout(c); // ولو بلا عمولات: تصحيحٌ موجب وحده يكفي
              const key = `pay:create:${c.affiliate.id}`;
              return (
                <tr key={c.affiliate.id}>
                  <Td>
                    <AffCell a={c.affiliate} />
                    <p className="text-[10.5px] text-[#9A8F7E] font-mono" dir="ltr">{c.affiliate.email}</p>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {L.formatHalalas(c.commissionsHalalas)}
                    <p className="text-[10.5px] text-[#9A8F7E]">{c.commissionCount > 0 ? `${c.commissionCount} عمولة` : 'بلا عمولات — تصحيحات فقط'}</p>
                  </Td>
                  <Td className={`whitespace-nowrap tabular-nums ${c.adjustmentsHalalas < 0 ? 'text-red-600' : ''}`}>{L.formatHalalas(c.adjustmentsHalalas)}</Td>
                  <Td className="whitespace-nowrap tabular-nums font-bold text-[#1F1A13]">{L.formatHalalas(c.netHalalas)}</Td>
                  <Td className="text-[11.5px] whitespace-nowrap">
                    {c.hasPayout ? <>{c.holderName} <span className="font-mono" dir="ltr">•••• {c.ibanLast4}</span></> : <span className="text-red-600">بلا آيبان</span>}
                  </Td>
                  <Td>{can ? <Chip tone="green">مؤهّل</Chip> : <Chip tone="amber">{blocker ?? 'غير مؤهّل'}</Chip>}</Td>
                  <Td>
                    <ActionBtn tone="brand" icon={Plus} disabled={!can || actions.busy === key}
                      onClick={() => actions.run(key, () => affApi.createPayout(c.affiliate.id),
                        (p) => `أُنشئت مسودّة دفعة ${L.formatHalalas(p.netHalalas)} — حوّلها من بنكك ثم سجّل المرجع`)}>
                      إنشاء دفعة
                    </ActionBtn>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <h3 className="text-sm font-bold text-[#1F1A13]">الدفعات</h3>
          <StatusFilter values={L.PAYOUT_STATUSES} map={L.PAYOUT_STATUS_LABEL} value={status} onChange={setStatus} />
        </div>
        {pays.isLoading ? <Loading /> : pays.isError ? <Failed onRetry={() => pays.refetch()} /> : !pays.data || pays.data.length === 0 ? (
          <Empty>لا دفعات{status ? ` بحالة «${L.labelOf(L.PAYOUT_STATUS_LABEL, status)}»` : ''}</Empty>
        ) : (
          <Table head={<>
            <Th>السفير</Th><Th>المكوّنات</Th><Th>الصافي</Th><Th>المستفيد</Th><Th>الحالة</Th><Th>التحويل</Th><Th>إجراءات</Th>
          </>}>
            {pays.data.map((p) => (
              <tr key={p.id}>
                <Td><AffCell a={p.affiliate} /><p className="text-[10.5px] text-[#9A8F7E]">أُنشئت {day(p.createdAt)}</p></Td>
                <Td className="text-[11.5px] whitespace-nowrap tabular-nums">
                  <p>{p.commissionCount} عمولة · {L.formatHalalas(p.commissionsHalalas)}</p>
                  <p className={p.adjustmentsHalalas < 0 ? 'text-red-600' : 'text-[#9A8F7E]'}>تصحيحات {L.formatHalalas(p.adjustmentsHalalas)}</p>
                </Td>
                <Td className="whitespace-nowrap tabular-nums font-bold text-[#1F1A13]">{L.formatHalalas(p.netHalalas)}</Td>
                <Td className="text-[11.5px]">
                  <p>{p.holderName}</p>
                  <p className="font-mono" dir="ltr">•••• {p.ibanLast4}</p>
                  {p.status === 'draft' && (
                    <div className="mt-1">
                      {revealFor === p.id ? <RevealIban affiliateId={p.affiliate.id} /> : (
                        <button onClick={() => setRevealFor(p.id)} className="text-[11px] text-amber-800 hover:underline inline-flex items-center gap-1"><Lock className="w-3 h-3" /> الآيبان الكامل للتحويل</button>
                      )}
                    </div>
                  )}
                </Td>
                <Td>
                  <StatusChip map={L.PAYOUT_STATUS_LABEL} value={p.status} />
                  {p.voidReason && <p className="text-[10.5px] text-[#9A8F7E] mt-1 max-w-[160px]">{p.voidReason}</p>}
                </Td>
                <Td className="text-[11.5px] whitespace-nowrap">
                  {p.bankReference ? <p className="font-mono" dir="ltr">{p.bankReference}</p> : <p className="text-gray-400">—</p>}
                  {p.transferredAt && <p className="text-[#9A8F7E]">{dayOnly(p.transferredAt)}</p>}
                </Td>
                <Td>
                  {p.status === 'draft' ? (
                    <div className="flex flex-wrap gap-1">
                      <ActionBtn tone="good" icon={CheckCircle2} onClick={() => setRecordFor(p)}>تسجيل التحويل</ActionBtn>
                      <ActionBtn tone="bad" icon={Ban}
                        onClick={() => actions.ask({
                          key: `pay:void:${p.id}`, title: `إلغاء دفعة ${p.affiliate.fullName}`, confirmLabel: 'إلغاء الدفعة', danger: true, mode: 'text',
                          hint: 'تُفكّ العمولات والتصحيحات وتعود «معتمدة» للدورة القادمة. لا تلغِ دفعة حوّلت مبلغها فعلاً.',
                          action: (reason) => affApi.voidPayout(p.id, reason), success: 'أُلغيت الدفعة',
                        })}>
                        إلغاء
                      </ActionBtn>
                    </div>
                  ) : <span className="text-[11px] text-gray-400">—</span>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {recordFor && <RecordPayoutDialog payout={recordFor} actions={actions} onClose={() => setRecordFor(null)} />}
      {actions.dialog}
    </div>
  );
}

// ─── ٧) التصحيحات ──────────────────────────────────────────────────────────

function AdjustmentsTab() {
  const actions = useActions();
  const [affiliateId, setAffiliateId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const preview = amount.trim() ? L.parseSarToHalalas(amount, { allowNegative: true }) : null;

  const submit = () => {
    const r = L.validateAdjustment(affiliateId, amount, note);
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    const halalas = r.value;
    actions.ask({
      key: 'adj:create', title: 'تأكيد قيد التصحيح', confirmLabel: 'تسجيل القيد', mode: 'none', danger: halalas < 0,
      hint: <>سيُسجَّل <b dir="ltr" className="tabular-nums">{L.formatHalalas(halalas)}</b> {halalas < 0 ? 'خصماً من' : 'إضافةً إلى'} دفعة السفير القادمة. القيد لا يُحذف — يُصحَّح بقيد معاكس.</>,
      action: async () => {
        await affApi.createAdjustment({ affiliateId, amountHalalas: halalas, note: note.trim() });
        setAmount(''); setNote('');
      },
      success: 'سُجّل القيد',
    });
  };

  return (
    <div className="space-y-3 max-w-2xl">
      <Note>
        قيد يدوي على حساب السفير يدخل أول دفعة تُنشئها: <b>موجب</b> يُضاف (مكافأة أو تسوية لصالحه)، و<b>سالب</b> يُخصم (استرداد بعد الصرف).
        الصافي لا يكون سالباً أبداً — إن زاد الخصم تبقى القيود للدورة التالية. تجد قيود كل سفير في تفاصيله.
      </Note>
      <section className="rounded-xl border border-[#E7DECD] bg-white p-4 space-y-3">
        <div>
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">السفير *</label>
          <AffiliateSelect value={affiliateId} onChange={setAffiliateId} />
        </div>
        <div>
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">المبلغ بالريال * (سالب للخصم)</label>
          <input type="text" inputMode="decimal" dir="ltr" className="input w-full" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-150.00 أو 75.5" />
          {preview && (preview.ok
            ? <p className={`text-[11.5px] mt-1 font-semibold ${preview.value < 0 ? 'text-red-600' : 'text-green-700'}`}>
                {preview.value < 0 ? 'خصم' : 'إضافة'} <span dir="ltr" className="tabular-nums">{L.formatHalalas(preview.value)}</span>
              </p>
            : <p className="text-[11.5px] mt-1 text-red-600">{preview.error}</p>)}
        </div>
        <div>
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">الملاحظة * (تظهر للسفير)</label>
          <textarea rows={2} maxLength={300} className="input w-full resize-none" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: استرداد اشتراك شركة النور بعد الصرف" />
        </div>
        {error && <p className="text-[12px] text-red-600">{error}</p>}
        <div className="flex justify-end">
          <button onClick={submit} className="btn-primary"><Scale className="w-4 h-4" /> تسجيل القيد</button>
        </div>
      </section>
      {actions.dialog}
    </div>
  );
}

// ─── ٨) الإعدادات والشروط ──────────────────────────────────────────────────

function SettingsForm({ s, actions }: { s: L.AffiliateSettings; actions: Actions }) {
  // مسودّة ما يقبله PUT /settings وحده. إعادة جلب الإعدادات (بعد نشر شروط مثلاً) لا تُعيد
  // تركيب النموذج: النظيف يتبنّى القيم الجديدة، والمعدَّل يبقى وتظهر «لديك تعديلات غير محفوظة».
  const server = L.settingsDraftOf(s);
  const [draft, setDraft] = useState<L.SettingsDraft>(server);
  const [base, setBase] = useState<L.SettingsDraft>(server);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (L.sameDraft(server, base)) return;
    setDraft((d) => L.syncSettingsDraft(d, base, server));
    setBase(server);
    // نراقب قيم الخادم لا مرجع الكائن
  }, [server.intakeOpen, server.disclosureText]);

  const diff = L.settingsDiff(draft, s);
  const dirty = Object.keys(diff).length > 0;

  const save = async () => {
    const err = L.validateDisclosure(draft.disclosureText);
    setError(err);
    if (err) return;
    if (!dirty) { toast('لا تغييرات للحفظ'); return; }
    await actions.run('settings:save', () => affApi.saveSettings(diff), 'حُفظت الإعدادات');
  };

  const rules = L.rulesOf(s);

  return (
    <section className="rounded-xl border border-[#E7DECD] bg-white p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-[#1F1A13]">إعدادات البرنامج</h3>
        {s.updatedAt && <span className="text-[11px] text-[#9A8F7E]">آخر تعديل {formatDateTime(s.updatedAt)}</span>}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg bg-[#FAF7F0] px-3 py-2.5 cursor-pointer">
        <div>
          <p className="text-[13px] font-bold text-[#1F1A13]">استقبال طلبات انضمام جديدة</p>
          <p className="text-[11px] text-[#6E6557]">عند الإغلاق يرفض التسجيل في البوابة، ويبقى السفراء الحاليون كما هم.</p>
        </div>
        <button
          type="button" role="switch" aria-checked={draft.intakeOpen} onClick={() => setDraft((d) => ({ ...d, intakeOpen: !d.intakeOpen }))}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${draft.intakeOpen ? 'bg-[#1E7A52]' : 'bg-gray-300'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${draft.intakeOpen ? 'right-0.5' : 'right-[22px]'}`} />
        </button>
      </label>

      <div>
        <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">نصّ الإفصاح (يلتزم به السفير في النشر)</label>
        <textarea
          rows={2} maxLength={L.DISCLOSURE_MAX} className="input w-full resize-none" value={draft.disclosureText}
          onChange={(e) => setDraft((d) => ({ ...d, disclosureText: e.target.value }))}
        />
        <p className="text-[10.5px] text-[#9A8F7E] mt-0.5 tabular-nums">{draft.disclosureText.trim().length} حرفاً (من {L.DISCLOSURE_MIN} إلى {L.DISCLOSURE_MAX})</p>
      </div>

      <div className="rounded-lg border border-[#E7DECD] bg-[#FAF7F0] p-3">
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#1F1A13] mb-2">
          <Lock className="w-3.5 h-3.5 text-[#9A8F7E]" /> قواعد البرنامج
        </div>
        <dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5 text-[12.5px]">
          {L.TERMS_RULE_KEYS.map((k) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <dt className="text-[#6E6557]">{L.RULE_LABEL[k]}</dt>
              <dd className="font-semibold tabular-nums text-[#1F1A13]" dir="ltr">{L.formatRule(k, rules[k])}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-[#6E6557] mt-2">هذه القيم جزء من الشروط — تتغيّر بنشر إصدار جديد</p>
      </div>

      {dirty && <p className="text-[12px] text-amber-800 font-semibold">لديك تعديلات غير محفوظة</p>}
      {error && <p className="text-[12px] text-red-600">{error}</p>}
      <div className="flex justify-end">
        <button onClick={save} disabled={actions.busy === 'settings:save'} className="btn-primary disabled:opacity-50">
          <CheckCircle2 className="w-4 h-4" /> {actions.busy === 'settings:save' ? 'يحفظ…' : 'حفظ الإعدادات'}
        </button>
      </div>
    </section>
  );
}

/** حقول قواعد الإصدار الجديد — مُعبّأة بالقيم الحالية، وتُرسل المتغيّرة فقط */
function RuleInputsGrid({ inputs, onChange }: { inputs: L.RuleInputs; onChange: (k: L.TermsRuleKey, v: string) => void }) {
  const meta: Record<L.TermsRuleKey, { suffix: string; hint: string }> = {
    rateBps: { suffix: '%', hint: 'من أول دفعة شاملة الضريبة (0–100)' },
    holdDays: { suffix: 'يوماً', hint: 'قبل جواز الاعتماد (0–365)' },
    minPayoutHalalas: { suffix: 'ر.س', hint: 'صافي الدفعة الأدنى (0–1,000,000)' },
    refWindowDays: { suffix: 'يوماً', hint: 'من آخر نقرة (1–365)' },
    claimLockDays: { suffix: 'يوماً', hint: 'حجز الترشيح المعتمد (1–365)' },
    firstPaymentWithinDays: { suffix: 'يوماً', hint: 'بعدها لا تُحتسب عمولة (1–730)' },
  };
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {L.TERMS_RULE_KEYS.map((k) => (
        <div key={k}>
          <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">{L.RULE_LABEL[k]}</label>
          <div className="flex items-center gap-2">
            <input type="text" inputMode="decimal" dir="ltr" className="input w-full" value={inputs[k]} onChange={(e) => onChange(k, e.target.value)} />
            <span className="text-[12px] text-[#6E6557] whitespace-nowrap">{meta[k].suffix}</span>
          </div>
          <p className="text-[10.5px] text-[#9A8F7E] mt-0.5">{meta[k].hint}</p>
        </div>
      ))}
    </div>
  );
}

function TermsSection({ settings, actions }: { settings?: L.AffiliateSettings; actions: Actions }) {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: [KEY, 'terms'], queryFn: affApi.terms });
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  // حقول القواعد: تتبع قيم الخادم ما دام المالك لم يعدّلها
  const current = settings ? L.rulesOf(settings) : null;
  const currentInputs = current ? L.rulesToInputs(current) : null;
  const currentKey = currentInputs ? JSON.stringify(currentInputs) : '';
  const [ruleInputs, setRuleInputs] = useState<L.RuleInputs | null>(currentInputs);
  const [ruleBase, setRuleBase] = useState<string>(currentKey);
  useEffect(() => {
    if (!currentInputs || currentKey === ruleBase) return;
    setRuleInputs((cur) => (!cur || JSON.stringify(cur) === ruleBase ? currentInputs : cur));
    setRuleBase(currentKey);
  }, [currentKey]);

  const publish = () => {
    const err = L.validateTermsForm(version, body);
    setError(err);
    if (err) return;
    if (!current || !ruleInputs) { setError('انتظر تحميل الإعدادات الحالية'); return; }
    const parsed = L.parseRuleChanges(ruleInputs, current);
    if (!parsed.ok) { setError(parsed.error); return; }
    const rules = parsed.value;
    const changes = L.describeRuleChanges(rules, current);
    const v = version.trim();
    actions.ask({
      key: 'terms:publish', title: `نشر الشروط ${v}`, confirmLabel: 'نشر وجعله الإصدار الحالي', mode: 'none',
      hint: (
        <>
          <p>يصبح هذا الإصدار الحالي فوراً، ويُطلب من كل سفير قبوله عند دخوله البوابة. الإصدارات لا تُعدَّل بعد نشرها.</p>
          {changes.length > 0 ? (
            <ul className="mt-2 list-disc pr-4 space-y-0.5 text-[#1F1A13]">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
          ) : <p className="mt-2">قواعد البرنامج تبقى كما هي.</p>}
        </>
      ),
      action: async () => {
        await affApi.publishTerms({ version: v, body, ...(Object.keys(rules).length > 0 ? { rules } : {}) });
        setVersion(''); setBody('');
        // الحقول تصير القيم المنشورة، وتعود لتتبع الخادم بعد إعادة الجلب
        const published = L.rulesToInputs({ ...current, ...rules });
        setRuleInputs(published);
        setRuleBase(JSON.stringify(published));
      },
      success: `نُشر الإصدار ${v}`,
    });
  };

  return (
    <section className="rounded-xl border border-[#E7DECD] bg-white p-4 space-y-3">
      <h3 className="text-sm font-bold text-[#1F1A13]">شروط البرنامج</h3>
      {isLoading ? <Loading /> : isError ? <Failed onRetry={() => refetch()} /> : !data || data.length === 0 ? (
        <p className="text-[12px] text-amber-800">لم يُنشر أي إصدار بعد — انشر الإصدار الأول قبل فتح البوابة.</p>
      ) : (
        <ul className="divide-y divide-[#F1EBDF]">
          {data.map((t) => (
            <li key={t.version} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12.5px] font-bold" dir="ltr">{t.version}</span>
                {t.version === settings?.currentTermsVersion && <Chip tone="green">الحالي</Chip>}
                <span className="text-[11px] text-[#9A8F7E]">نُشر {formatDateTime(t.publishedAt)}</span>
                <button onClick={() => setOpen(open === t.version ? null : t.version)} className="mr-auto text-[11.5px] text-[#E15A30] hover:underline">
                  {open === t.version ? 'إخفاء النص' : 'عرض النص'}
                </button>
              </div>
              {t.rules && (
                <p className="text-[11px] text-[#6E6557] mt-1">
                  {L.TERMS_RULE_KEYS.map((k) => `${L.RULE_LABEL[k]} ${L.formatRule(k, t.rules?.[k])}`).join(' · ')}
                </p>
              )}
              {open === t.version && (
                <div className="mt-2 rounded-lg bg-[#FAF7F0] p-3 text-[12.5px] text-[#1F1A13] max-h-72 overflow-y-auto" style={{ whiteSpace: 'pre-wrap' }}>{t.body}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-dashed border-[#DED5C4] p-3 space-y-2">
        <p className="text-[12.5px] font-bold text-[#1F1A13]">نشر إصدار جديد</p>
        <input className="input w-full" dir="ltr" maxLength={40} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2026-10-v2" />
        <textarea rows={8} className="input w-full" value={body} onChange={(e) => setBody(e.target.value)} placeholder="نصّ الشروط كاملاً — نصّ عادي، الأسطر تُحفظ كما هي" />
        <div className="pt-1">
          <p className="text-[12px] font-bold text-[#1F1A13] mb-1.5">قواعد هذا الإصدار</p>
          {ruleInputs ? (
            <RuleInputsGrid inputs={ruleInputs} onChange={(k, v) => setRuleInputs((cur) => (cur ? { ...cur, [k]: v } : cur))} />
          ) : <p className="text-[12px] text-gray-400">جارٍ تحميل القيم الحالية…</p>}
          <p className="text-[10.5px] text-[#9A8F7E] mt-1.5">مُعبّأة بالقيم الحالية — يُرسل ما غيّرته فقط، ويُطبَّق مع نشر الإصدار دفعةً واحدة.</p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[11px] tabular-nums ${body.trim().length < L.TERMS_BODY_MIN ? 'text-[#9A8F7E]' : 'text-green-700'}`}>
            {body.trim().length} حرفاً (الحدّ الأدنى {L.TERMS_BODY_MIN})
          </span>
          <button onClick={publish} className="btn-primary"><FileSearch className="w-4 h-4" /> نشر</button>
        </div>
        {error && <p className="text-[12px] text-red-600">{error}</p>}
      </div>
    </section>
  );
}

function SettingsTab() {
  const actions = useActions();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: [KEY, 'settings'], queryFn: affApi.settings });

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[#F3C9B6] bg-white p-4">
        <h3 className="text-sm font-bold text-[#1F1A13] mb-2">رابط بوابة السفراء</h3>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-[#FAF7F0] border border-[#E7DECD] px-3 py-2 text-[13px] font-mono" dir="ltr">{L.PORTAL_URL}</code>
          <button onClick={() => copyText(L.PORTAL_URL, 'نُسخ رابط البوابة')} className="btn-secondary"><Copy className="w-4 h-4" /> نسخ</button>
        </div>
        <p className="text-[11.5px] text-[#6E6557] mt-2 flex items-start gap-1.5">
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          رابط <b>غير مُدرج</b>: لا يظهر في محركات البحث ولا توجد روابط إليه من الموقع. أرسله لمن تدعوه فقط — وكل طلب انضمام ينتظر موافقتك.
        </p>
      </section>

      {isLoading ? <Loading /> : isError || !data ? <Failed onRetry={() => refetch()} /> : (
        // بلا key: إعادة الجلب لا تُعيد تركيب النموذج فتمحو تعديلاً غير محفوظ
        <SettingsForm s={data} actions={actions} />
      )}
      <TermsSection settings={data} actions={actions} />
      {actions.dialog}
    </div>
  );
}
