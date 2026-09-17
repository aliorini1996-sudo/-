import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Eye, History, Info, KeyRound, Loader2, Lock, Pencil, Plug,
  RefreshCw, Rocket, Save, ShieldCheck, XCircle,
} from 'lucide-react';
import { zatcaApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { formatDate, formatDateTime } from '../../utils/format';
import ConfirmDialog from '../ConfirmDialog';
import type { ZatcaChecklistItem, ZatcaEnv, ZatcaJobOutcome, ZatcaOverview, ZatcaSellerData, ZatcaSellerField, ZatcaUnitPayload } from '../../types';
import {
  CHECKLIST_LABEL, ENV_LABEL, ENV_SHORT_LABEL, OTP_INPUT_MAX_LENGTH, RENEWAL_STAGE_LABEL, RETIRE_REASONS, RETIRE_REASON_LABEL, RetireReason,
  SELLER_FIELD_LABEL, SELLER_ID_SCHEMES, SELLER_ID_SCHEME_LABEL, SellerDraft, Tone, apiErrorOf, cardControls, cardStatusLabel, certDateLabel,
  certValidity, cleanFieldValue, creatableEnvs, csrFieldTarget, csrIssueFor, csrLocationDefaults, csrLocationHint, csrOrgNameHint, defaultRetireReason,
  draftErrors, draftOf, failureOf, isOtpComplete, isVatGroup, liveUnits, mergeSellerDraft, normalizeDigits, normalizeOtp, primaryUnit, problemBanners,
  overviewView, readinessErrors, sellerBaselineAfterSave, sellerPatch, shouldRetryUnitFetch, unitPollInterval,
} from './zatcaLogic';
import { useZatcaTr as useTr } from './zatcaPhrases';

/**
 * تبويب «الفوترة الإلكترونية — المرحلة الثانية (فاتورة)» في إعدادات الشركة (design §5.1).
 * يُعرض فقط حين يفعّل المالك zatcaPhase2Enabled والشركة سعودية — والخادم يفرض الشرطين نفسيهما على كل مسار.
 * رمز التحقق (OTP) يبقى في حالة الحقل حتى الإرسال ثم يُمسح فوراً، ولا يمرّ عبر react-query ولا يُطبع.
 * يُحمَّل كسولاً (CompanySettingsPage) مع عباراته (zatcaPhrases.ts) — لا يدخل حزمة من لا يفتحه.
 * جلسة دخول مالك المنصة تعمل كمدير الشركة تماماً (قرار المالك 17 سبتمبر 2026): كل الحقول والأزرار كما للمدير، مع لافتة معلومات
 * بأن ما يُحفظ أو يُربط يُنسب إلى مدير الشركة ويُسجَّل (الخادم يكتب سطر تدقيق لكل كتابة ويسم actorId).
 */

/** تركيز حقل (في البطاقة أو في بيانات المنشأة) بعد رسمه. */
function focusField(inputId: string): void {
  setTimeout(() => {
    const el = document.getElementById(inputId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, 0);
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-[#F1EBDF] text-[#6E6557]',
  progress: 'bg-[#FBEBE2] text-[#C94E28]',
  success: 'bg-[#E4F1EA] text-[#1E7A52]',
  warning: 'bg-[#FDF3D8] text-[#8A6100]',
  danger: 'bg-[#FBE3DF] text-[#C0392B]',
};

/**
 * زرّ معطَّل يبدو معطَّلاً داخل التبويب وحده (.btn-* بلا حالة disabled عامة): «ربط الوحدة» برمز ناقص أو «حفظ» بلا تغييرات لا
 * يبدو زرّاً يتجاهل النقر صامتاً. صفوف قائمة الخطوات (أزرار بلا .btn-*) لا تتأثّر.
 */
const TAB_DISABLED_BUTTONS = '[&_.btn-primary:disabled]:opacity-50 [&_.btn-primary:disabled]:cursor-not-allowed [&_.btn-secondary:disabled]:opacity-50 '
  + '[&_.btn-secondary:disabled]:cursor-not-allowed [&_.btn-danger:disabled]:opacity-50 [&_.btn-danger:disabled]:cursor-not-allowed';

const OVERVIEW_KEY = ['zatca', 'overview'] as const;
const unitKey = (id: string) => ['zatca', 'unit', id] as const;

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

function Banner({ tone, icon, title, children }: { tone: 'danger' | 'warning' | 'info'; icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  const cls = tone === 'danger'
    ? 'bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]'
    : tone === 'warning' ? 'bg-[#FDF3D8] border-[#F0DDA6] text-[#6B4B00]' : 'bg-[#FAF7F0] border-[#E9E1D3] text-[#44403a]';
  return (
    <div className={`flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm leading-relaxed ${cls}`}>
      <span className="mt-0.5 shrink-0">{icon ?? <AlertTriangle size={16} />}</span>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-0.5 text-[13px]">{children}</div>}
      </div>
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4 pb-3 border-b border-[#F1EBDF]">
      <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center shrink-0 text-[#E15A30]">{icon}</div>
      <div className="min-w-0">
        <p className="font-semibold text-[#1F1A13]">{title}</p>
        {subtitle && <p className="text-xs text-[#6E6557] mt-0.5 leading-relaxed">{subtitle}</p>}
      </div>
    </div>
  );
}

export default function ZatcaPhase2Tab() {
  const tr = useTr();
  const q = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: async () => (await zatcaApi.overview()).data.data as ZatcaOverview,
    // انقطاع الشبكة و5xx (نشر جديد): إعادتان قبل إعلان الفشل، وأي 4xx (403/429…) بلا إعادة
    retry: shouldRetryUnitFetch,
    refetchOnWindowFocus: false,
    // لا staleTime العامّ (30 ث): حفظ الإعدادات العامة (الرقم الضريبي، السجل، العملة) ثم فتح التبويب يجلب الجاهزية من جديد
    staleTime: 0,
  });

  const shown = overviewView(q);
  if (shown.view === 'loading') {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  // بطاقة الخطأ الكاملة للتحميل الأول الفاشل وحده — فشل تحديثٍ لاحق (بعد حفظ أو انتهاء مهمّة) لا يُزيل الجسم ومسوّداته
  if (shown.view === 'error' || !q.data) {
    const e = apiErrorOf(q.error);
    return (
      <div className="card">
        <Banner tone="danger" title={tr('تعذر تحميل بيانات ربط الفوترة الإلكترونية')}>{e.message ?? tr('حاول مجددا بعد قليل')}</Banner>
        <button type="button" className="btn-secondary mt-3" onClick={() => q.refetch()}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
      </div>
    );
  }

  return (
    <ZatcaPhase2Body ov={q.data} overviewUpdatedAt={q.dataUpdatedAt}
      refreshError={shown.refreshFailed ? { message: apiErrorOf(q.error).message, refreshing: q.isFetching, retry: () => { void q.refetch(); } } : null} />
  );
}

/** لافتة فشل تحديث النظرة العامّة فوق المحتوى القائم (البيانات المعروضة آخر ما حُمِّل، والمسوّدات باقية). */
function OverviewRefreshError({ message, refreshing, retry }: { message: string | null; refreshing: boolean; retry: () => void }) {
  const tr = useTr();
  return (
    <div className="card space-y-2" role="alert">
      <Banner tone="warning" icon={<AlertTriangle size={16} />} title={tr('تعذر تحديث بيانات ربط الفوترة الإلكترونية — المعروض آخر ما حمل وتعديلاتك غير المحفوظة باقية')}>
        {message ?? tr('حاول مجددا بعد قليل')}
      </Banner>
      <button type="button" className="btn-secondary" disabled={refreshing} onClick={retry}>
        {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {tr('إعادة المحاولة')}
      </button>
    </div>
  );
}

const fetchUnit = async (id: string) => (await zatcaApi.unit(id)).data.data as ZatcaUnitPayload;

/**
 * يشترك (دون جلب) في نسخ الاستطلاع المخزّنة لكل وحدة — البطاقات هي التي تستطلع — فيقرأ رأس الحالة وإنشاء الوحدة
 * الحالة الحيّة لا لقطة النظرة العامّة التي لا تُحدَّث إلا عند بدء المهمّة وانتهائها.
 */
function useLiveUnits(ov: ZatcaOverview, overviewUpdatedAt: number): ZatcaUnitPayload[] {
  const cached = useQueries({
    queries: ov.units.map(p => ({
      queryKey: unitKey(p.unit.id),
      queryFn: () => fetchUnit(p.unit.id),
      initialData: p,
      initialDataUpdatedAt: overviewUpdatedAt,
      staleTime: Infinity,
      enabled: false,
    })),
  });
  return liveUnits(ov.units, cached.map(c => c.data));
}

function ZatcaPhase2Body({ ov, overviewUpdatedAt, refreshError }: {
  ov: ZatcaOverview; overviewUpdatedAt: number; refreshError: { message: string | null; refreshing: boolean; retry: () => void } | null;
}) {
  const tr = useTr();
  const units = useLiveUnits(ov, overviewUpdatedAt);
  // جلسة دخول مالك المنصة: لافتة معلومات وحدها — لا وضع اطلاع (الحقول والأزرار كما لمدير الشركة)
  const ownerSession = !!useAuthStore(s => s.impersonating);
  const active = ov.units.filter(u => u.unit.status !== 'REVOKED');
  const retired = ov.units.filter(u => u.unit.status === 'REVOKED');

  return (
    <div className={`space-y-5 max-w-4xl ${TAB_DISABLED_BUTTONS}`} dir="rtl">
      {refreshError && <OverviewRefreshError {...refreshError} />}
      <StatusHeader ov={ov} units={units} ownerSession={ownerSession} />
      <SellerCard ov={ov} />
      <div className="card">
        <SectionTitle icon={<Plug size={20} />} title={tr('ربط وحدة الفوترة مع هيئة الزكاة والضريبة والجمارك')}
          subtitle={tr('وحدة واحدة لكل بيئة تُصدر شهادة الإنتاج التي تُوقَّع بها فواتير شركتك')} />
        <div className="space-y-4">
          {active.map(p => <UnitCard key={p.unit.id} initial={p} overviewUpdatedAt={overviewUpdatedAt} ov={ov} />)}
          <CreateUnit ov={ov} units={units} />
        </div>
      </div>
      <GoLiveCard ov={ov} />
      {retired.length > 0 && <RetiredUnits units={retired} />}
    </div>
  );
}

// ─── رأس الحالة ───

function StatusHeader({ ov, units, ownerSession }: { ov: ZatcaOverview; units: ZatcaUnitPayload[]; ownerSession: boolean }) {
  const tr = useTr();
  const now = new Date();
  const primary = primaryUnit(units.filter(u => u.unit.status !== 'REVOKED'));
  const unit = primary?.unit ?? null;
  const cert = unit ? certValidity(unit, now) : null;
  const certLabel = cert ? certDateLabel(cert.state) : null;
  const problems = problemBanners(units, now);
  const st = primary ? cardStatusLabel(primary) : null;

  return (
    <div className="card space-y-4">
      <SectionTitle icon={<ShieldCheck size={20} />} title={tr('الفوترة الإلكترونية — المرحلة الثانية (فاتورة)')}
        subtitle={tr('ربط شركتك بمنصة فاتورة لتوقيع الفواتير وإرسالها للهيئة')} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] px-4 py-3">
          <p className="text-xs text-[#6E6557]">{tr('نظام الفوترة الحالي')}</p>
          <p className="font-semibold text-[#1F1A13] mt-1">
            {ov.regime === 'PHASE2' ? tr('المرحلة الثانية: مفعّلة') : tr('المرحلة الأولى: رمز QR مبسّط')}
          </p>
          {ov.regime !== 'PHASE2' && <p className="text-[11px] text-[#6E6557] mt-1">{tr('فواتيرك تصدر كما هي الآن حتى اكتمال الربط والتفعيل')}</p>}
        </div>
        <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] px-4 py-3">
          <p className="text-xs text-[#6E6557]">{tr('وحدة الربط')}</p>
          {unit && st ? (
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone={st.tone}>{tr(st.label)}</Badge>
                <span className="text-xs text-[#44403a]">{tr('البيئة')}: <b>{tr(ENV_SHORT_LABEL[unit.environment] ?? unit.environment)}</b></span>
              </div>
              <p className="text-xs text-[#44403a]">
                {certLabel
                  ? <>{tr(certLabel)} <b>{formatDate(unit.certNotAfter as string)}</b></>
                  : tr('لا توجد شهادة إنتاج بعد')}
              </p>
            </div>
          ) : (
            <p className="font-semibold text-[#1F1A13] mt-1">{tr('لم تُربط أي وحدة بعد')}</p>
          )}
        </div>
      </div>

      {ownerSession && (
        <Banner tone="info" icon={<Eye size={16} />} title={tr('أنت داخل كمالك المنصة — ما تحفظه أو تربطه هنا يُنسب إلى مدير الشركة ويُسجَّل')} />
      )}
      {!ov.secretsReady && (
        <Banner tone="danger" icon={<Lock size={16} />} title={tr('الخادم غير مهيأ بعد لربط الفوترة الإلكترونية')}>
          {tr('مفتاح التشفير غير مضبوط على الخادم — تواصل مع دعم المنصة قبل البدء')}
        </Banner>
      )}
      {ov.allowedEnvs.length === 0 && (
        <Banner tone="warning" title={tr('لا توجد بيئة ربط مسموحة على الخادم حاليا')}>{tr('تواصل مع دعم المنصة')}</Banner>
      )}
      {primary && primary.unit.environment === 'simulation' && (
        <Banner tone="info" icon={<Info size={16} />} title={tr('وحدة في بيئة المحاكاة')}>
          {tr('بيئة المحاكاة للاختبار فقط ولا تصدر بها فواتير حقيقية')}
        </Banner>
      )}
      {problems.map(({ p, kind }) => {
        const env = tr(ENV_SHORT_LABEL[p.unit.environment] ?? p.unit.environment);
        if (kind === 'AUTH_FAILED' || kind === 'REVOKED_ACTIVE' || kind === 'RENEWAL_UNCONFIRMED') {
          return (
            <Banner key={p.unit.id} tone="danger" icon={<Ban size={16} />} title={`${tr('توقّف إصدار الفواتير الضريبية')} — ${env}`}>
              {kind === 'RENEWAL_UNCONFIRMED'
                ? tr('تعذر التأكد من نتيجة تجديد الشهادة فأوقف الإصدار احتياطا — أعد التجديد برمز تحقق جديد أو أوقف الوحدة واربط وحدة جديدة')
                : tr('تحقق من حالة الوحدة في بوابة فاتورة fatoora.zatca.gov.sa — ربط وحدة جديدة يبدأ وحدة وسلسلة فواتير جديدتين')}
            </Banner>
          );
        }
        if (kind === 'EXPIRED') {
          return <Banner key={p.unit.id} tone="danger" title={`${tr('شهادة الوحدة منتهية')} — ${env}`}>{tr('جدد الشهادة برمز تحقق من بوابة فاتورة')}</Banner>;
        }
        const days = certValidity(p.unit, now).daysLeft ?? 0;
        return (
          <Banner key={p.unit.id} tone="warning" icon={<History size={16} />} title={`${tr('تنتهي شهادة الوحدة قريبا')} — ${env}`}>
            {tr('الأيام المتبقية')}: <b>{days}</b> — {tr('جدد الشهادة قبل انتهائها')}
          </Banner>
        );
      })}
    </div>
  );
}

// ─── بيانات المنشأة ───

const ADDRESS_FIELDS: ZatcaSellerField[] = ['addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrDistrict', 'addrCity', 'addrPostalCode'];
const LTR_FIELDS: ReadonlySet<ZatcaSellerField> = new Set<ZatcaSellerField>(['taxNumber', 'commercialReg', 'sellerIdValue', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'vatGroupTin']);

function SellerCard({ ov }: { ov: ZatcaOverview }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SellerDraft>(() => draftOf(ov.seller));
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, string>>>({});
  const [warnings, setWarnings] = useState<Array<{ code: string; messageAr: string }>>([]);
  const [saving, setSaving] = useState(false);
  // خطّ الأساس لكل حقل: آخر بيانات طُبّقت من الخادم، أو ما أُرسل بعد حفظ ناجح
  const baselineRef = useRef<Partial<ZatcaSellerData>>(ov.seller);

  // بيانات جديدة من الخادم (بعد الحفظ، أو حفظ الرقم الضريبي والسجل من «الإعدادات العامة» والتبويبان مركّبان) تُدمج حقلاً بحقل:
  // ما لم يعدّله المدير يأخذ الجديد وما عدّله يبقى — لا علمَ «لُمس» واحداً يحجب كل الحقول فيعيد الحفظ قيمها القديمة
  useEffect(() => {
    const baseline = baselineRef.current;
    if (baseline === ov.seller) return;
    baselineRef.current = ov.seller;
    setDraft(d => mergeSellerDraft(baseline, ov.seller, d));
  }, [ov.seller]);

  const errors = useMemo(() => draftErrors(draft), [draft]);
  const patch = useMemo(() => sellerPatch(ov.seller, draft), [ov.seller, draft]);
  const dirty = Object.keys(patch).length > 0;
  const issues = ov.sellerIssues ?? [];
  const blocking = readinessErrors(issues);
  const group = isVatGroup(normalizeDigits(draft.taxNumber.trim()));

  const set = (f: ZatcaSellerField, v: string) => {
    setDraft(d => ({ ...d, [f]: v }));
    setServerErrors(e => ({ ...e, [f]: undefined }));
  };

  const save = async () => {
    if (Object.keys(errors).length) { toast.error(tr('صحح الحقول المشار إليها أولا')); return; }
    setSaving(true);
    try {
      const res = await zatcaApi.saveSeller(patch);
      const w = (res.data?.data?.warnings ?? []) as Array<{ code: string; messageAr: string }>;
      setWarnings(w);
      setServerErrors({});
      // ما أُرسل صار خطّ الأساس: عند وصول البيانات المحفوظة يأخذ كل حقل لم يُعدَّل بعد الإرسال قيمةَ الخادم (المطبَّعة)
      if (baselineRef.current === ov.seller) baselineRef.current = sellerBaselineAfterSave(ov.seller, patch);
      toast.success(tr('تم حفظ بيانات المنشأة'));
      await Promise.all([qc.invalidateQueries({ queryKey: OVERVIEW_KEY }), qc.invalidateQueries({ queryKey: ['company'] })]);
    } catch (err) {
      const e = apiErrorOf(err);
      const map: Record<string, string> = {};
      for (const fe of e.fieldErrors) map[fe.field] = fe.messageAr;
      setServerErrors(map);
      toast.error(e.message ?? tr('حدث خطأ في الحفظ'));
    } finally {
      setSaving(false);
    }
  };

  const field = (f: ZatcaSellerField, opts: { placeholder?: string; className?: string } = {}) => {
    const err = errors[f] ?? serverErrors[f];
    // قيود طلب شهادة الهيئة: تنبيه لا يمنع الحفظ — من الكتابة للاسم، ومن جاهزية الخادم لقيمة محفوظة لم تُعدَّل
    const saved = cleanFieldValue(f, draft[f]) === (ov.seller[f] ?? '');
    const serverCsr = saved ? csrIssueFor(issues, f) : null;
    const localHint = f === 'legalName' ? csrOrgNameHint(draft[f]) : null;
    const hint = err ? null : localHint ? tr(localHint) : serverCsr?.messageAr ?? null;
    // الاسم المرفوض يمنع إنشاء الوحدة (لا بديل له في الطلب) ⇒ أحمر؛ العنوان المشتقّ له بديل عند الإنشاء ⇒ تحذير
    const hintIsError = !!hint && (!!localHint || serverCsr?.severity === 'error');
    return (
      <div className={opts.className}>
        <label className="label" htmlFor={`zatca-${f}`}>{tr(SELLER_FIELD_LABEL[f])}</label>
        <input id={`zatca-${f}`} className={`input ${err || hintIsError ? 'border-[#C0392B] focus:ring-[#C0392B]/30' : hint ? 'border-[#E0B040]' : ''}`} value={draft[f]}
          dir={LTR_FIELDS.has(f) ? 'ltr' : undefined} inputMode={LTR_FIELDS.has(f) && f !== 'sellerIdValue' && f !== 'commercialReg' ? 'numeric' : undefined}
          placeholder={opts.placeholder} onChange={e => set(f, e.target.value)} aria-invalid={!!err || hintIsError} />
        {err && <p className="text-[#C0392B] text-xs mt-1">{tr(err)}</p>}
        {hint && <p className={`text-xs mt-1 leading-relaxed ${hintIsError ? 'text-[#C0392B]' : 'text-[#8A6100]'}`}>{hint}</p>}
      </div>
    );
  };

  return (
    <div className="card">
      <SectionTitle icon={<ShieldCheck size={20} />} title={tr('الخطوة 1: بيانات المنشأة للفوترة الإلكترونية')}
        subtitle={tr('تظهر في كل فاتورة وفي طلب الشهادة — تُفحص الصيغة عند إدخال القيمة فقط')} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {field('legalName', { className: 'sm:col-span-2' })}
        {field('taxNumber', { placeholder: '3XXXXXXXXXXXXX3' })}
        {field('commercialReg')}
        <div>
          <label className="label" htmlFor="zatca-sellerIdScheme">{tr(SELLER_FIELD_LABEL.sellerIdScheme)}</label>
          <select id="zatca-sellerIdScheme" className="input" value={draft.sellerIdScheme} onChange={e => set('sellerIdScheme', e.target.value)}>
            <option value="">{tr('السجل التجاري (الافتراضي)')}</option>
            {SELLER_ID_SCHEMES.map(s => <option key={s} value={s}>{tr(SELLER_ID_SCHEME_LABEL[s])}</option>)}
          </select>
          {(errors.sellerIdScheme ?? serverErrors.sellerIdScheme) && <p className="text-[#C0392B] text-xs mt-1">{tr((errors.sellerIdScheme ?? serverErrors.sellerIdScheme) as string)}</p>}
        </div>
        {field('sellerIdValue')}
        <p className="sm:col-span-2 text-xs font-semibold text-[#44403a] pt-1">{tr('العنوان الوطني للمنشأة')}</p>
        {ADDRESS_FIELDS.map(f => <div key={f}>{field(f)}</div>)}
        {(group || draft.vatGroupTin) && field('vatGroupTin', { className: 'sm:col-span-2' })}
      </div>
      {group && (
        <p className="text-[11px] text-[#6B4B00] bg-[#FDF3D8] border border-[#F0DDA6] rounded-lg px-3 py-2 mt-3 leading-relaxed">
          {tr('الخانة 11 من الرقم الضريبي هي 1 (مجموعة ضريبية): أدخل الرقم المميز للعضو بعشرة أرقام')}
        </p>
      )}
      {!ov.currency.isSar && (
        <div className="mt-3">
          <Banner tone="warning" title={tr('عملة الفوترة يجب أن تكون الريال السعودي SAR في المرحلة الثانية')}>
            {tr('غيرها من الإعدادات العامة قبل التفعيل')}
          </Banner>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 space-y-2">
          {warnings.map((w, i) => <Banner key={`${w.code}-${i}`} tone="warning" title={w.messageAr} />)}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button type="button" className="btn-primary" disabled={saving || !dirty} onClick={save}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {tr('حفظ بيانات المنشأة')}
        </button>
        {!dirty && <span className="text-xs text-[#6E6557]">{tr('لا تغييرات غير محفوظة')}</span>}
      </div>

      <div className="mt-4 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] px-4 py-3">
        <p className="text-sm font-semibold text-[#1F1A13] flex items-center gap-2">
          {blocking.length === 0 ? <CheckCircle2 size={16} className="text-[#1E7A52]" /> : <XCircle size={16} className="text-[#C0392B]" />}
          {blocking.length === 0 ? tr('بيانات المنشأة مكتملة للربط') : `${tr('نواقص تمنع الربط')}: ${blocking.length}`}
        </p>
        {issues.length > 0 && (
          <ul className="mt-2 space-y-1">
            {issues.map((i, k) => (
              <li key={`${i.rule}-${i.field}-${k}`} className={`text-xs leading-relaxed ${i.severity === 'error' ? 'text-[#8E2A1F]' : 'text-[#6B4B00]'}`}>
                • {i.messageAr}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── إنشاء وحدة ───

function CreateUnit({ ov, units }: { ov: ZatcaOverview; units: ZatcaUnitPayload[] }) {
  const tr = useTr();
  const qc = useQueryClient();
  const envs = creatableEnvs(ov.allowedEnvs, units);
  const [env, setEnv] = useState<ZatcaEnv | ''>(envs[0] ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [extra, setExtra] = useState({ branchName: '', locationAddress: '', industry: '' });
  const [pending, setPending] = useState(false);
  // رفض الإنشاء يبقى ظاهراً بجانب الزرّ (لا تنبيهاً عابراً) حتى محاولة تالية
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => { if (!env || !envs.includes(env)) setEnv(envs[0] ?? ''); }, [envs.join(','), env]); // eslint-disable-line react-hooks/exhaustive-deps

  if (envs.length === 0) return null; // كل بيئة مسموحة فيها وحدة قيد الربط أو مربوطة (تظهر أعلاه)
  const blocking = readinessErrors(ov.sellerIssues);
  const locationHint = csrLocationHint(extra.locationAddress);
  const disabled = pending || !env || !ov.secretsReady || blocking.length > 0;

  const create = async () => {
    if (!env) return;
    setPending(true);
    setCreateError(null);
    try {
      const body: { environment: string; branchName?: string; locationAddress?: string; industry?: string } = { environment: env };
      for (const k of ['branchName', 'locationAddress', 'industry'] as const) if (extra[k].trim()) body[k] = extra[k].trim();
      await zatcaApi.createUnit(body);
      toast.success(tr('أنشئت وحدة الربط — أدخل رمز التحقق لإكمال الربط'));
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    } catch (err) {
      const e = apiErrorOf(err);
      const message = e.message ?? tr('تعذر تنفيذ الطلب');
      setCreateError(message);
      if (e.issues.length || e.code === 'CSR_PARAMS_INVALID') await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      // الحقل الذي يُصلح الرفض: الاسم القانوني أو حقل العنوان الذي سمّاه الخادم في الخطوة 1 (من الجاهزية بعد تحديثها)، أو خيار متقدم هنا
      const fresh = qc.getQueryData<ZatcaOverview>(OVERVIEW_KEY) ?? ov;
      const target = e.code === 'CSR_PARAMS_INVALID'
        ? csrFieldTarget(e.field, { vatGroup: isVatGroup(fresh.seller.taxNumber), locationOverride: extra.locationAddress.trim() !== '', issues: fresh.sellerIssues })
        : null;
      if (target) {
        if (target.advanced) setAdvanced(true);
        setTimeout(() => {
          const el = document.getElementById(target.inputId);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el?.focus({ preventScroll: true });
        }, 0);
      } else {
        toast.error(message);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed border-[#D8CDB9] p-4">
      <p className="text-sm font-semibold text-[#1F1A13]">{tr('الخطوة 2: ربط وحدة جديدة')}</p>
      <div className="mt-3 grid grid-cols-1 gap-3">
        <div>
          <label className="label" htmlFor="zatca-env">{tr('بيئة الربط')}</label>
          <select id="zatca-env" className="input" value={env} onChange={e => setEnv(e.target.value as ZatcaEnv)}>
            {envs.map(e => <option key={e} value={e}>{tr(ENV_LABEL[e])}</option>)}
          </select>
          {env === 'simulation' && <p className="text-[11px] text-[#6E6557] mt-1">{tr('المحاكاة لتجربة الربط كاملا دون أثر على فواتيرك الحقيقية')}</p>}
          {env === 'production' && <p className="text-[11px] text-[#8E2A1F] mt-1">{tr('الإنتاج يربط شركتك فعليا بالهيئة ويستهلك رمز تحقق حقيقيا')}</p>}
        </div>
        <button type="button" className="text-xs text-[#C94E28] font-semibold flex items-center gap-1 w-fit" onClick={() => setAdvanced(a => !a)}>
          {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {tr('خيارات متقدمة لطلب الشهادة')}
        </button>
        {advanced && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="zatca-branch">{tr('اسم الفرع')}</label>
              <input id="zatca-branch" className="input" dir="ltr" value={extra.branchName} placeholder="Main Branch" maxLength={64}
                onChange={e => setExtra(x => ({ ...x, branchName: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="zatca-location">{tr('العنوان المختصر في الشهادة')}</label>
              {/* لا maxLength=64: المتصفّح يقصّ الملصوق صامتاً — التنبيه يشرح الحدّ والخادم يرفض ما تجاوزه */}
              <input id="zatca-location" className={`input ${locationHint ? 'border-[#C0392B]' : ''}`} value={extra.locationAddress} maxLength={200}
                placeholder={ov.csrDefaultLocation || undefined} aria-invalid={!!locationHint}
                onChange={e => setExtra(x => ({ ...x, locationAddress: e.target.value }))} />
              {locationHint && <p className="text-[#C0392B] text-xs mt-1 leading-relaxed">{tr(locationHint)}</p>}
            </div>
            <div>
              <label className="label" htmlFor="zatca-industry">{tr('نشاط المنشأة')}</label>
              <input id="zatca-industry" className="input" dir="ltr" value={extra.industry} placeholder="Wholesale Distribution" maxLength={128}
                onChange={e => setExtra(x => ({ ...x, industry: e.target.value }))} />
            </div>
          </div>
        )}
        {blocking.length > 0 && <p className="text-xs text-[#8E2A1F]">{tr('أكمل بيانات المنشأة في الخطوة 1 أولا')}</p>}
        <button type="button" className="btn-primary w-full sm:w-fit justify-center" disabled={disabled} onClick={create}>
          {pending ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
          {tr('إنشاء وحدة الربط')}
        </button>
        {createError && <Banner tone="danger" title={tr('تعذر إنشاء وحدة الربط')}>{createError}</Banner>}
      </div>
    </div>
  );
}

// ─── وحدة ───

function OtpField({ value, onChange, inputRef, id }: { value: string; onChange: (v: string) => void; inputRef?: React.RefObject<HTMLInputElement>; id: string }) {
  const tr = useTr();
  return (
    <div>
      <label className="label" htmlFor={id}>{tr('رمز التحقق OTP')}</label>
      <input id={id} ref={inputRef} className="input text-center text-lg tracking-[0.5em] font-semibold max-w-[220px]" dir="ltr"
        inputMode="numeric" autoComplete="one-time-code" maxLength={OTP_INPUT_MAX_LENGTH} placeholder="••••••" value={value}
        onChange={e => onChange(normalizeOtp(e.target.value))} />
    </div>
  );
}

function OtpInstructions({ env, renewal }: { env: string; renewal?: boolean }) {
  const tr = useTr();
  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] px-4 py-3 text-sm text-[#44403a] leading-relaxed">
      <p className="font-semibold text-[#1F1A13] mb-1.5">{tr('كيف تحصل على رمز التحقق')}</p>
      <ol className="list-decimal pr-5 space-y-1">
        <li>{tr('ادخل إلى بوابة فاتورة fatoora.zatca.gov.sa ببيانات دخول شركتك في منصة إيراد')}</li>
        <li>
          {renewal
            ? tr('اختر «تجديد شهادة قائمة» (Renewing Existing CSID) وولد رمز تحقق واحدا')
            : tr('اختر «ربط وحدة أو جهاز حل جديد» (Onboard new solution unit/device) وولد رمز تحقق واحدا')}
        </li>
        <li>{tr('الصق الرمز هنا خلال 60 دقيقة من توليده')}</li>
      </ol>
      {env === 'simulation' && <p className="text-xs text-[#6E6557] mt-2">{tr('لوحدة المحاكاة ولد الرمز من بوابة المحاكاة في فاتورة')}</p>}
      <p className="text-xs font-semibold text-[#C94E28] mt-2 flex items-start gap-1.5">
        <Lock size={13} className="mt-0.5 shrink-0" />
        {tr('رمز التحقق يولد من حساب شركتك لدى الهيئة فقط — لا تستطيع المنصة توليده نيابة عنك')}
      </p>
    </div>
  );
}

function ChecklistView({ items, renewalStage }: { items: ZatcaChecklistItem[]; renewalStage?: string | null }) {
  const tr = useTr();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      {renewalStage && (
        <p className="text-xs text-[#44403a] bg-[#FBEBE2] rounded-lg px-3 py-1.5">{tr('مرحلة التجديد')}: <b>{tr(RENEWAL_STAGE_LABEL[renewalStage] ?? renewalStage)}</b></p>
      )}
      {items.map(item => {
        const icon = item.status === 'done' ? <CheckCircle2 size={16} className="text-[#1E7A52]" />
          : item.status === 'warning' ? <CheckCircle2 size={16} className="text-[#B7791F]" />
            : item.status === 'running' ? <Loader2 size={16} className="text-[#E15A30] animate-spin" />
              : item.status === 'failed' ? <XCircle size={16} className="text-[#C0392B]" />
                : <CircleDashed size={16} className="text-[#B5AB9A]" />;
        const msgs = [...item.errors, ...item.warnings];
        const expandable = msgs.length > 0 || !!item.detail;
        return (
          <div key={item.key} className="rounded-lg border border-[#F1EBDF] bg-white">
            <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-right" disabled={!expandable}
              onClick={() => setOpen(o => (o === item.key ? null : item.key))}>
              {icon}
              <span className={`text-sm flex-1 ${item.status === 'pending' ? 'text-[#9A8F7E]' : 'text-[#1F1A13]'}`}>{tr(CHECKLIST_LABEL[item.key] ?? item.key)}</span>
              {item.status === 'warning' && <span className="text-[11px] text-[#8A6100]">{tr('نجح مع تحذيرات')}</span>}
              {expandable && (open === item.key ? <ChevronUp size={14} className="text-[#9A8F7E]" /> : <ChevronDown size={14} className="text-[#9A8F7E]" />)}
            </button>
            {open === item.key && expandable && (
              <div className="px-3 pb-2 space-y-1" dir="ltr">
                {msgs.map((m, i) => (
                  <p key={i} className={`text-[11px] font-mono break-words ${m.type === 'ERROR' ? 'text-[#8E2A1F]' : 'text-[#6B4B00]'}`}>
                    [{m.type}] {m.code ?? ''} {m.message ?? ''}
                  </p>
                ))}
                {item.detail && <p className="text-[11px] font-mono text-[#6E6557]">{item.detail}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * «العنوان المختصر في الشهادة» في نموذجَي إعادة الربط بعد رفض والتجديد (الخدمة تعيد فيهما اشتقاق العنوان من عنوان المنشأة).
 * فارغ = عنوان المنشأة؛ يُرسل csrFields.locationAddress حين يُفتح ويُملأ.
 */
function CsrLocationField({ id, open, onToggle, value, onChange, hint, placeholder, derivedRejected, warnMissing }: {
  id: string; open: boolean; onToggle: () => void; value: string; onChange: (v: string) => void; hint: string | null; placeholder?: string;
  derivedRejected: boolean; warnMissing: boolean;
}) {
  const tr = useTr();
  return (
    <div>
      <button type="button" className="text-xs text-[#C94E28] font-semibold flex items-center gap-1 w-fit" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {tr('العنوان المختصر في الشهادة')}
      </button>
      {warnMissing && (
        <p className="text-xs text-[#8A6100] mt-1 leading-relaxed">{tr('عنوان المنشأة الحالي يرفضه طلب شهادة الهيئة — أدخل عنوانا مختصرا للشهادة')}</p>
      )}
      {open && (
        <div className="mt-2 max-w-md">
          <input id={id} className={`input ${hint ? 'border-[#C0392B]' : ''}`} value={value} maxLength={200} placeholder={derivedRejected ? undefined : placeholder}
            aria-invalid={!!hint} onChange={e => onChange(e.target.value)} />
          {hint
            ? <p className="text-[#C0392B] text-xs mt-1 leading-relaxed">{tr(hint)}</p>
            : <p className="text-[11px] text-[#6E6557] mt-1">{tr('اتركه فارغا لكتابة عنوان المنشأة')}</p>}
        </div>
      )}
    </div>
  );
}

function FailurePanel({ outcome, lastError, onNewOtp, onRetire, onRetry, onFix, retrying }: {
  outcome: ZatcaJobOutcome | null; lastError: string | null; onNewOtp: (() => void) | null; onRetire: (() => void) | null; onRetry: (() => void) | null;
  onFix: (() => void) | null; retrying: boolean;
}) {
  const tr = useTr();
  const [tech, setTech] = useState(false);
  if (!outcome && !lastError) return null;
  return (
    <div className="rounded-xl border border-[#F2C4BC] bg-[#FDF1EE] px-4 py-3">
      <p className="text-sm font-semibold text-[#8E2A1F] flex items-start gap-2">
        <XCircle size={16} className="mt-0.5 shrink-0" />
        {outcome ? outcome.messageAr : tr('توقفت آخر عملية على هذه الوحدة')}
      </p>
      {outcome?.issues && outcome.issues.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {outcome.issues.map((i, k) => <li key={k} className="text-xs text-[#8E2A1F]">• {i.messageAr}</li>)}
        </ul>
      )}
      <div className="flex items-center gap-2 flex-wrap mt-3">
        {onFix && (
          <button type="button" className="btn-primary" onClick={onFix}><Pencil size={15} /> {tr('صحح الحقل المشار إليه')}</button>
        )}
        {onNewOtp && (
          <button type="button" className="btn-primary" onClick={onNewOtp}><KeyRound size={15} /> {tr('أدخل رمزاً جديداً')}</button>
        )}
        {onRetire && (
          <button type="button" className="btn-secondary" onClick={onRetire}><Ban size={15} /> {tr('أوقف الوحدة واربط وحدة جديدة')}</button>
        )}
        {onRetry && (
          <button type="button" className="btn-secondary" disabled={retrying} onClick={onRetry}>
            {retrying ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {tr('إعادة المحاولة')}
          </button>
        )}
        <button type="button" className="text-xs text-[#6E6557] underline" onClick={() => setTech(t => !t)}>
          {tech ? tr('إخفاء التفاصيل التقنية') : tr('التفاصيل التقنية')}
        </button>
      </div>
      {tech && (
        <div className="mt-2 rounded-lg bg-white border border-[#F1EBDF] px-3 py-2 space-y-1 text-[11px] font-mono text-[#44403a] break-words" dir="ltr">
          {outcome && <p>code: {outcome.code}</p>}
          {outcome?.detail && <p>detail: {outcome.detail}</p>}
          {outcome?.step && <p>step: {outcome.step}</p>}
          {outcome?.field && <p>field: {outcome.field}</p>}
          {outcome?.zatcaMessages.map((m, i) => <p key={i}>[{m.type}] {m.code ?? ''} {m.message ?? ''}</p>)}
          {!outcome && lastError && <p>lastError: {lastError}</p>}
        </div>
      )}
    </div>
  );
}

function UnitCard({ initial, overviewUpdatedAt, ov }: { initial: ZatcaUnitPayload; overviewUpdatedAt: number; ov: ZatcaOverview }) {
  const tr = useTr();
  const qc = useQueryClient();
  const id = initial.unit.id;
  const q = useQuery({
    queryKey: unitKey(id),
    queryFn: () => fetchUnit(id),
    initialData: initial,
    initialDataUpdatedAt: overviewUpdatedAt,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // خطأ الاستطلاع: إعادتان للشبكة/5xx فقط ثم توقّف (لا استطلاع أبدي عبر 403/404/429)، وأبطأ بعد الدقيقة الأولى
    retry: shouldRetryUnitFetch,
    refetchInterval: query => unitPollInterval(
      { status: query.state.status, data: query.state.data as ZatcaUnitPayload | undefined }, ov.constants.pollIntervalMs, Date.now(),
    ),
  });

  // نظرة عامّة أحدث (بعد حفظ أو إجراء) تسبق نسخة الاستطلاع المخزَّنة
  useEffect(() => {
    if (overviewUpdatedAt > q.dataUpdatedAt) qc.setQueryData(unitKey(id), initial, { updatedAt: overviewUpdatedAt });
  }, [overviewUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = q.data ?? initial;
  const u = p.unit;
  const actions = cardControls(p, ov.allowedEnvs);
  const failure = failureOf(p);
  const st = cardStatusLabel(p);
  const pollError = q.isError ? apiErrorOf(q.error) : null;
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await q.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  // انتهاء العملية: تحديث النظرة العامّة مرة واحدة وإشعار النتيجة
  const wasBusy = useRef(actions.busy);
  useEffect(() => {
    if (wasBusy.current && !actions.busy) {
      const o = p.job?.state === 'finished' ? p.job.outcome : null;
      if (o?.ok) toast.success(o.messageAr);
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    }
    wasBusy.current = actions.busy;
  }, [actions.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const [otp, setOtp] = useState('');
  const [renewOtp, setRenewOtp] = useState('');
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewAck, setRenewAck] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireText, setRetireText] = useState('');
  const [retireReason, setRetireReason] = useState<RetireReason>(defaultRetireReason(u));
  const [abortConfirm, setAbortConfirm] = useState(false);
  const [pending, setPending] = useState<null | 'onboard' | 'renew' | 'abort' | 'retire'>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const renewRef = useRef<HTMLInputElement>(null);
  const [showChecklist, setShowChecklist] = useState(u.status !== 'ACTIVE');

  // العنوان المختصر في الشهادة (نموذج الرمز بعد رفض، ونافذة التجديد): يُفتح بعنوان الوحدة حين يرفض الطلبُ عنوانَ المنشأة
  const locDefaults = csrLocationDefaults(u, ov.sellerIssues);
  const [loc, setLoc] = useState(locDefaults.value);
  const [locOpen, setLocOpen] = useState(locDefaults.open);
  const [locTouched, setLocTouched] = useState(false);
  useEffect(() => {
    if (locTouched) return;
    setLoc(locDefaults.value);
    if (locDefaults.open) setLocOpen(true);
  }, [locDefaults.value, locDefaults.open, locTouched]);
  // مهمّة انتهت برفض العنوان: الخانة مفتوحة عند فتح النموذج التالي
  const failedField = failure?.code === 'CSR_PARAMS_INVALID' ? failure.field : null;
  useEffect(() => { if (failedField === 'locationAddress') setLocOpen(true); }, [failedField, p.job?.id]);
  const locOverride = locOpen ? loc.trim() : '';
  const locHint = locOverride ? csrLocationHint(locOverride) : null;
  const csrFields = locOverride ? { locationAddress: locOverride } : null;
  const derivedRejected = locDefaults.open;
  // رمز مع عنوان سيرفضه طلب الشهادة لا يُرسل (لا يُستهلك حدّ محاولات الرمز على رفض معروف مسبقاً)
  const locBlocked = locHint !== null || (derivedRejected && locOverride === '');
  const locationField = (formId: string) => (
    <CsrLocationField id={formId} open={locOpen} onToggle={() => setLocOpen(o => !o)} value={loc} hint={locHint}
      placeholder={ov.csrDefaultLocation || undefined} derivedRejected={derivedRejected} warnMissing={derivedRejected && locOverride === ''}
      onChange={v => { setLocTouched(true); setLoc(v); }} />
  );

  const confirmText = ov.constants.retireConfirmationText || 'إيقاف';
  const onAfterAction = (data: ZatcaUnitPayload | undefined) => {
    if (data) qc.setQueryData(unitKey(id), data);
    qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
  };
  const fail = (err: unknown) => {
    const e = apiErrorOf(err);
    toast.error(e.message ?? tr('تعذر تنفيذ الطلب'));
    if (e.needsNewOtp) setOtp('');
    qc.invalidateQueries({ queryKey: unitKey(id) });
  };

  const startOnboard = async (withOtp: boolean) => {
    const value = withOtp ? otp : '';
    if (withOtp) setOtp(''); // لا يبقى الرمز في الذاكرة بعد الإرسال
    setPending('onboard');
    try {
      // العنوان المختصر يُرسل مع الرمز بعد رفض (إعادة البناء تعيد اشتقاق العنوان) — لا في المتابعة بلا رمز
      const res = await zatcaApi.onboard(id, withOtp ? { otp: value, ...(actions.showOtpLocation && csrFields ? { csrFields } : {}) } : {});
      setShowChecklist(true);
      onAfterAction(res.data?.data);
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
    }
  };

  const startRenew = async () => {
    const value = renewOtp;
    setRenewOtp('');
    setPending('renew');
    try {
      const res = await zatcaApi.renew(id, { otp: value, ...(csrFields ? { csrFields } : {}) });
      setRenewOpen(false);
      setRenewAck(false);
      setShowChecklist(true);
      onAfterAction(res.data?.data);
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
    }
  };

  const abort = async () => {
    setPending('abort');
    try {
      const res = await zatcaApi.abortRenewal(id);
      toast.success(tr('أُلغي التجديد المتوقف وعادت الوحدة لحالتها'));
      onAfterAction(res.data?.data);
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
      setAbortConfirm(false);
    }
  };

  const retire = async () => {
    setPending('retire');
    try {
      const res = await zatcaApi.retire(id, { confirmation: retireText, reason: retireReason });
      toast.success(tr('أوقفت الوحدة نهائيا'));
      setRetireOpen(false);
      setRetireText('');
      onAfterAction(res.data?.data);
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
    }
  };

  const onNewOtp = actions.newOtpAction === 'focus-otp'
    ? () => otpRef.current?.focus()
    : actions.newOtpAction === 'open-renew'
      ? () => { setRenewOpen(true); setTimeout(() => renewRef.current?.focus(), 0); }
      : null;
  // AUTH_FAILED بعد رفض شهادة التجديد: لا مسار رمز في هذه الحالة — العلاج إيقاف الوحدة وربط وحدة جديدة
  const onRetire = actions.newOtpAction === 'open-retire' ? () => { setRetireOpen(true); setTimeout(() => document.getElementById(`zatca-confirm-${id}`)?.focus(), 0); } : null;
  const onRetry = actions.showRetry ? () => startOnboard(false) : null;
  // CSR_PARAMS_INVALID: خانة العنوان المختصر في نموذج الرمز أو نافذة التجديد، أو حقل بيانات المنشأة
  const fix = actions.csrFix;
  const onFix = !fix ? null : fix.kind === 'seller-field'
    ? () => focusField(fix.inputId)
    : () => {
      setLocOpen(true);
      if (actions.showOtpLocation) { focusField(`zatca-otp-location-${id}`); return; }
      setRenewOpen(true);
      focusField(`zatca-renew-location-${id}`);
    };
  const cert = certValidity(u, new Date());
  const certLabel = certDateLabel(cert.state);
  const renewalStage = u.complianceProgress?.renewal && u.status === 'RENEWING' ? u.complianceProgress.renewal.stage : null;

  return (
    <div className="rounded-xl border border-[#E9E1D3] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={st.tone}>{actions.busy && <Loader2 size={12} className="animate-spin" />}{tr(st.label)}</Badge>
            <span className="text-xs text-[#44403a]">{tr(ENV_LABEL[u.environment] ?? u.environment)}</span>
          </div>
          <p className="text-[11px] text-[#9A8F7E] mt-1 break-all" dir="ltr">{u.commonName}</p>
        </div>
        <div className="text-xs text-[#6E6557] text-left">
          {certLabel && <p>{tr(certLabel)} <b>{formatDate(u.certNotAfter as string)}</b></p>}
          {u.activatedAt && <p>{tr('ربطت في')} {formatDateTime(u.activatedAt)}</p>}
        </div>
      </div>

      {pollError ? (
        <div className="space-y-2">
          <Banner tone="warning" icon={<AlertTriangle size={16} />} title={tr('تعذر تحديث حالة الوحدة')}>
            {pollError.message ?? tr('توقف التحديث التلقائي — حدّث يدويا بعد قليل')}
          </Banner>
          <button type="button" className="btn-secondary" disabled={refreshing} onClick={refreshNow}>
            {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {tr('تحديث الحالة')}
          </button>
        </div>
      ) : actions.busy && (
        <Banner tone="info" icon={<Loader2 size={16} className="animate-spin" />} title={tr('تجري العملية على الخادم')}>
          {tr('تتحدث القائمة تلقائيا — يمكنك مغادرة الصفحة والعودة لاحقا')}
        </Banner>
      )}

      {!actions.envAllowed && u.status !== 'REVOKED' && (
        <Banner tone="warning" icon={<Lock size={16} />} title={tr('بيئة هذه الوحدة غير مسموحة على الخادم حاليا')}>
          {tr('الربط والتجديد متوقفان لهذه الوحدة — تواصل مع دعم المنصة')}
        </Banner>
      )}

      {(failure || (!actions.busy && !p.job && u.lastError && u.status !== 'ACTIVE' && u.status !== 'REVOKED')) && (
        <FailurePanel outcome={failure} lastError={failure ? null : u.lastError} onNewOtp={onNewOtp} onRetire={onRetire} onRetry={onRetry} onFix={onFix}
          retrying={pending === 'onboard'} />
      )}

      {actions.showOtpForm && (
        <div className="space-y-3">
          <OtpInstructions env={u.environment} />
          {actions.showOtpLocation && locationField(`zatca-otp-location-${id}`)}
          <div className="flex items-end gap-3 flex-wrap">
            <OtpField id={`zatca-otp-${id}`} value={otp} onChange={setOtp} inputRef={otpRef} />
            <button type="button" className="btn-primary" onClick={() => startOnboard(true)}
              disabled={!isOtpComplete(otp) || pending !== null || !ov.secretsReady || (actions.showOtpLocation && locBlocked)}>
              {pending === 'onboard' ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
              {tr('ربط الوحدة')}
            </button>
          </div>
        </div>
      )}

      {actions.showResume && (
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-xs text-[#6E6557]">
            {failure ? tr('بعد معالجة سبب التوقف أعلاه تابع الربط دون رمز تحقق جديد') : tr('توقف الربط قبل اكتماله — تابع دون رمز تحقق جديد')}
          </p>
          <button type="button" className="btn-secondary" disabled={pending !== null || !ov.secretsReady} onClick={() => startOnboard(false)}>
            {pending === 'onboard' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {tr('متابعة الربط')}
          </button>
        </div>
      )}

      <div>
        <button type="button" className="text-xs text-[#C94E28] font-semibold flex items-center gap-1" onClick={() => setShowChecklist(s => !s)}>
          {showChecklist ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {tr('خطوات الربط وفحوص الامتثال')} ({p.checklist.checksPassed}/{p.checklist.checksTotal})
        </button>
        {showChecklist && <div className="mt-2"><ChecklistView items={p.checklist.items} renewalStage={renewalStage} /></div>}
      </div>

      {(actions.showRenew || actions.canAbort || actions.canRetire) && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-[#F1EBDF]">
          {actions.showRenew && (
            <button type="button" className="btn-secondary mt-2" onClick={() => setRenewOpen(o => !o)}>
              <RefreshCw size={15} /> {tr('تجديد الشهادة')}
            </button>
          )}
          {actions.canAbort && (
            <button type="button" className="btn-secondary mt-2" disabled={pending !== null} onClick={() => setAbortConfirm(true)}>
              <Ban size={15} /> {tr('إلغاء التجديد المتوقف')}
            </button>
          )}
          {actions.canRetire && (
            <button type="button" className="mt-2 text-xs text-[#C0392B] font-semibold px-2 py-2" onClick={() => setRetireOpen(o => !o)}>
              {tr('إيقاف الوحدة نهائيا')}
            </button>
          )}
        </div>
      )}

      {renewOpen && actions.showRenew && (
        <div className="space-y-3 rounded-xl border border-[#E8C9BC] bg-[#FFFBF8] p-3">
          <p className="text-sm font-semibold text-[#1F1A13]">{tr('تجديد شهادة الوحدة')}</p>
          <OtpInstructions env={u.environment} renewal />
          <Banner tone="warning" title={tr('يتوقف إصدار الفواتير على هذه الوحدة بضع دقائق أثناء التجديد')} />
          <label className="flex items-center gap-2 text-sm text-[#44403a] cursor-pointer select-none">
            <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={renewAck} onChange={e => setRenewAck(e.target.checked)} />
            {tr('فهمت أن الإصدار يتوقف مؤقتا أثناء التجديد')}
          </label>
          {locationField(`zatca-renew-location-${id}`)}
          <div className="flex items-end gap-3 flex-wrap">
            <OtpField id={`zatca-renew-otp-${id}`} value={renewOtp} onChange={setRenewOtp} inputRef={renewRef} />
            <button type="button" className="btn-primary" onClick={startRenew}
              disabled={!renewAck || !isOtpComplete(renewOtp) || pending !== null || !ov.secretsReady || locBlocked}>
              {pending === 'renew' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {tr('تجديد')}
            </button>
          </div>
        </div>
      )}

      {retireOpen && actions.canRetire && (
        <div className="space-y-3 rounded-xl border border-[#F2C4BC] bg-[#FDF1EE] p-3">
          <p className="text-sm font-semibold text-[#8E2A1F]">{tr('إيقاف الوحدة نهائيا')}</p>
          <p className="text-xs text-[#8E2A1F] leading-relaxed">{tr('لا تصدر بهذه الوحدة فواتير بعد الإيقاف ولا يمكن التراجع — الربط من جديد يبدأ وحدة جديدة برمز تحقق جديد')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`zatca-reason-${id}`}>{tr('سبب الإيقاف')}</label>
              <select id={`zatca-reason-${id}`} className="input" value={retireReason} onChange={e => setRetireReason(e.target.value as RetireReason)}>
                {RETIRE_REASONS.map(r => <option key={r} value={r}>{tr(RETIRE_REASON_LABEL[r])}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`zatca-confirm-${id}`}>{tr('اكتب كلمة التأكيد')} «{confirmText}»</label>
              <input id={`zatca-confirm-${id}`} className="input" value={retireText} onChange={e => setRetireText(e.target.value)} />
            </div>
          </div>
          <button type="button" className="btn-danger" disabled={retireText.trim() !== confirmText || pending !== null} onClick={retire}>
            {pending === 'retire' ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />}
            {tr('إيقاف الوحدة')}
          </button>
        </div>
      )}

      {abortConfirm && (
        <ConfirmDialog
          title={tr('إلغاء التجديد المتوقف')}
          message={tr('تعود الوحدة إلى حالتها قبل التجديد إن لم يرسل للهيئة طلب قد يصدر شهادة جديدة — وإلا يلزم تجديد برمز تحقق')}
          confirmLabel={tr('إلغاء التجديد')}
          loading={pending === 'abort'}
          onConfirm={abort}
          onClose={() => setAbortConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── التفعيل ───

function GoLiveCard({ ov }: { ov: ZatcaOverview }) {
  const tr = useTr();
  return (
    <div className="card">
      <SectionTitle icon={<Rocket size={20} />} title={tr('الخطوة 3: تفعيل المرحلة الثانية')}
        subtitle={tr('بعد التفعيل توقع كل فاتورة وترسل للهيئة ولا عودة للمرحلة الأولى')} />
      <button type="button" className="btn-primary opacity-50 cursor-not-allowed" disabled aria-disabled="true">
        <Lock size={16} /> {tr('تفعيل المرحلة الثانية')}
      </button>
      <p className="text-xs text-[#6E6557] mt-2 flex items-start gap-1.5">
        <Info size={13} className="mt-0.5 shrink-0" />
        {ov.goLiveAvailable ? null : tr('غير متاح قبل اكتمال ربط إصدار الفواتير')}
      </p>
    </div>
  );
}

// ─── الوحدات الموقوفة ───

function RetiredUnits({ units }: { units: ZatcaUnitPayload[] }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button type="button" className="w-full flex items-center justify-between text-sm font-semibold text-[#44403a]" onClick={() => setOpen(o => !o)}>
        <span className="flex items-center gap-2"><History size={16} /> {tr('وحدات موقوفة')} ({units.length})</span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <ul className="mt-3 space-y-2">
          {units.map(p => (
            <li key={p.unit.id} className="flex items-center justify-between gap-2 flex-wrap text-xs text-[#6E6557] border-b border-[#F1EBDF] pb-2">
              <span>{tr(ENV_SHORT_LABEL[p.unit.environment] ?? p.unit.environment)} — <span dir="ltr">{p.unit.commonName}</span></span>
              <span>{p.unit.revokedAt ? `${tr('أوقفت في')} ${formatDate(p.unit.revokedAt)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
