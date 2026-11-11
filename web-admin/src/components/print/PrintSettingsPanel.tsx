import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, FileText, Info, LayoutTemplate, Pencil, PenTool, Plus, Printer, Receipt, RefreshCw, RotateCcw, Save, Scissors, Trash2, X,
} from 'lucide-react';
import { companyApi, productApi } from '../../api/client';
import { hasBigUnit } from '../../lib/adminUnits';
import { primaryUnitOf, type UnitDef } from '../../lib/units';
import { useTr } from '../../i18n/strings';
import {
  COMPANY_SETTINGS_MISSING_MSG, DOC_KINDS, DOC_KIND_LABELS, DOC_KIND_SHORT, DPIS_BY_PRINTER, FEEDS_BY_PRINTER, FEED_LABELS, FONT_SCALES,
  PAPER_PRESETS, PRESET_LABELS, PRINTER_HINTS, PRINTER_LABELS, PRINTER_SHORT, PRINTER_TYPES, PRINT_ISSUES, PRINT_LIMITS, PRINT_NOTES,
  PRINT_COPIES, QR_PANEL_NOTE, QR_REMOVED_BADGE, STAMPED_QR_CELLS, TEMPLATE_HINTS, TEMPLATE_LABELS,
  checkPrintSettings, isQrRemoved, layoutOf, duplicateProfile, isLegacyPrintSettings, isLegacyProfileId, legacyPrintSettings, maxPrintableDots, newProfile, normalizePrintSettings,
  printSaveErrorMessage, printableMm, profileDisplayName, profileUsage, profileWarnings, qrPlan, routingAllowsProfile, templatesFor,
  uniqueProfileName, withDpi, withPaper, withPreset, withPrinter, withProfile, withoutProfile,
  DESIGN_HINTS, DESIGN_LABELS, formDesignBlock, isFormProfile,
  type PaperFeed, type PrintIssue, type PrintOptions, type PrintProfile, type PrintSettingsResponse, type PrintSettingsV1, type PrinterDpi,
  type PrinterType, type TemplateId,
} from '../../lib/print/printSettings';
import PrintPreview, { FormThumb, GridThumb, LayoutFields, applyDesignCard, designCardId, designCardSelected, designCards } from './PrintPreview';
import { formOf, formWarnings } from '../../lib/print/formModel';
import PrintDeviceTools from './PrintDeviceTools';
import PrintDesignTools, { CLASSIC_COPY_NAME, classicCopyFor, isClassicRoll } from './PrintDesignTools';
import { PrintableInvoice, type Company } from '../../rep/RepDocuments';
import { currentPrintIdentity, usePrintDeviceChoice } from '../../rep/printDevice';
import { isTaxOff } from '../../lib/taxMode';
import { TaxOffPrintContext, taxOffProfileWarnings, templateHintFor, useTaxOffPrint } from './taxOffPrint';

/**
 * تبويب «إعدادات الطباعة» في إعدادات الشركة (طلب المالك ٢٣ أكتوبر ٢٠٢٦، التصميم §5.1) — الإعداد هنا، والطباعة به في شاشة
 * المستند (DocumentResult): نظام الطباعة في الجهاز بالقوالب الجديدة (M2، rep/thermal.ts وrep/printPage.ts)، والبلوتوث المباشر
 * والمعايرة والطباعة التجريبية في M3.
 *
 * A توجيه المستندات (قالب الطباعة المباشرة لكل نوع، وقالب الـPDF، وإذن اختيار الجهاز) · B قائمة القوالب (الافتراضيان يُنسخان
 * ولا يُعدّلان) · C محرّر بأربع خطوات (الطابعة ⇐ الورق ⇐ التصميم ⇐ التفاصيل) · D معاينة بالمقاس الفعلي · E (M3) الطباعة على
 * هذا الجهاز: طريقة الاتصال وربط الطابعة وصفحة المعايرة والطباعة التجريبية — للقالب المفتوح قبل حفظه، فتُعاير القيم ثم تُحفظ.
 *
 * مسودة محلية واحدة تُحفظ بزرّ واحد (PUT /company/print-settings) — لا keepLocalEdits النموذج العام: أول تحميل وحده يملأ
 * المسودة، فإعادة الجلب بعد حفظ تبويب آخر (يُبطل ['company'] ومعه هذا المفتاح) لا تمحو ما لم يُحفظ هنا. والحفظ يُبطل
 * ['company'] لأن جهاز المندوب يقرأ العمود من ردّ /company.
 *
 * «استعادة الافتراضي» تعلّم المسودة (pendingClear)، والحفظ بعدها — والمسودة ما زالت الافتراضي حرفياً — يرسل الإعادة (null ⇒
 * { reset: true }) فيصير العمود null: سلوك اليوم بلا «مخصّص» ولا اختيار جهاز ولا سطر «تغيير» لدى المندوب. حفظُ نسخةٍ من الافتراضي
 * كائناً كان يُبقي الشركة «مخصّصة» فيرى المندوب خيار الطابعة ويقدر على التحويل إلى A4. ومن عدّل بعد الإعادة يحفظ مسودته.
 */
interface EditorState { index: number | null; profile: PrintProfile; step: 1 | 2 | 3 | 4; nameTouched: boolean }

const PRINTER_ICON: Record<PrinterType, typeof Printer> = { thermal: Receipt, impact: Printer, page: FileText };
const STEPS = ['نوع الطابعة', 'مقاس الورق', 'التصميم', 'التفاصيل'] as const;
/** «المصمم الحر» كسولاً: لا يدخل حزمة اللوحة، ويُحمَّل عند أول فتح (pd_spec C.(iv) — التركيب) */
const loadDesigner = () => import('./designer/PrintDesigner');
/** «تصميم النموذج» («نموذج الشركة المطبوع مسبقاً») كسولاً مثله — بدل المصمّم الحرّ لقالبٍ بهذا التصميم */
const loadFormDesigner = () => import('./form/FormDesigner');
/** مسار قاعدةٍ من قواعد مواضع النموذج — تُصلَح داخل مصمّم النموذج فلا تمنع فتحه */
const FORM_ISSUE_PATH = /\.options\.layout\.form(\.|\[|$)/;

export default function PrintSettingsPanel({ phase2 }: { phase2: boolean }) {
  const tr = useTr();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['company', 'print'],
    queryFn: async () => (await companyApi.printSettings.get()).data as PrintSettingsResponse,
  });
  const server = useMemo(() => normalizePrintSettings(q.data?.data ?? null), [q.data]);
  const [draft, setDraft] = useState<PrintSettingsV1 | null>(null);
  const [base, setBase] = useState('');
  useEffect(() => {
    if (q.data && draft === null) { setDraft(server); setBase(JSON.stringify(server)); }
  }, [q.data, server, draft]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  /** «استعادة الافتراضي» بانتظار الحفظ — يُرسل إعادةً (العمود null) ما دامت المسودة الافتراضيَّ حرفياً */
  const [pendingClear, setPendingClear] = useState(false);

  // اسم الشركة ولونها للمعاينة، وبياناتها كاملةً للطباعة التجريبية — من ردّ /company الذي حمّلته الصفحة
  const company = qc.getQueryData<Company | null>(['company']);
  const companyName = company?.name || tr('اسم الشركة');
  const brandColor = company?.primaryColor || '#1e3a8a';
  // «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): الشركة بلا ضريبة (taxDisabled في ردّ /company) — التبويب كله بلا تنبيهات الهيئة والرمز
  // والفاتورة الضريبية، ومعايناته مستنداتٌ بلا ضريبة (TaxOffPrintContext لمكوّناته). الغائب أو false: التبويب كما كان حرفاً
  const taxOff = isTaxOff(company);

  const s = draft ?? server;
  const hasCompany = q.data?.hasCompany !== false;
  // الإعادة على إعدادٍ محفوظ تغييرٌ ولو طابقت المسودة ما عُرض (كائنٌ يساوي الافتراضي محفوظٌ من قبل)
  const dirty = draft !== null && (JSON.stringify(draft) !== base || (pendingClear && q.data?.stored === true));
  const check = useMemo(() => checkPrintSettings(s, true), [s]);
  const issues: PrintIssue[] = check.ok ? [] : check.issues;
  const issueAt = (path: string) => issues.find((i) => i.path === path);

  const save = useMutation({
    // null = إعادة (العمود null حرفياً) — لا نسخةٌ من الافتراضي كائناً
    mutationFn: (v: PrintSettingsV1 | null) => companyApi.printSettings.put(v),
    onSuccess: (res) => {
      const saved = normalizePrintSettings((res.data as PrintSettingsResponse).data ?? null);
      setDraft(saved);
      setBase(JSON.stringify(saved));
      setPendingClear(false);
      qc.setQueryData(['company', 'print'], res.data);
      qc.invalidateQueries({ queryKey: ['company'] });
      toast.success(tr('تم حفظ إعدادات الطباعة'));
    },
    onError: (e) => toast.error(tr(printSaveErrorMessage(e))),
  });

  if (q.isLoading) return <div className="card text-center text-gray-400 text-sm py-10">{tr('جار التحميل')}</div>;
  // فشل إعادة جلبٍ بعد تحميلٍ ناجح (انقطاع) لا يمحو المحرّر ومسودته — الخطأ يُعرض بلا بيانات وحده
  if (q.isError && !q.data) return (
    <div className="card" role="alert">
      <p className="text-sm text-[#8E2A1F] font-semibold">{tr('تعذر تحميل إعدادات الطباعة')}</p>
      <button type="button" className="btn-secondary mt-3" onClick={() => q.refetch()}>{tr('إعادة المحاولة')}</button>
    </div>
  );

  const setRouting = (kind: (typeof DOC_KINDS)[number], id: string) => setDraft({ ...s, routing: { ...s.routing, [kind]: id || null } });
  const open = (index: number | null, profile: PrintProfile, nameTouched: boolean) => setEditor({ index, profile, step: index === null ? 1 : 4, nameTouched });
  const addProfile = () => {
    const p = newProfile('thermal', '', s.profiles);
    open(null, { ...p, name: autoName(p, s.profiles, tr) }, false);
  };
  const duplicate = (p: PrintProfile) => open(null, duplicateProfile(p, profileDisplayName(p, tr), s.profiles), true);
  /**
   * «تحرير الشريط الكلاسيكي» (B.3): نسخةٌ roll_compact على 58 مم يُوجَّه إليها ما كان يطبع بالكلاسيكي، وتُفتح في الأدوات — والكلاسيكي
   * نفسه لا يُمسّ (التراجع: إعادة التوجيه). index: موضع القالب المفتوح (null = قالبٌ جديد لم يُضف بعد).
   */
  const editClassic = (p: PrintProfile, index: number | null) => {
    const r = classicCopyFor(s, p, index, tr(CLASSIC_COPY_NAME));
    if (!r) { toast.error(tr('الحد 12 قالبا')); return; }
    setDraft(r.settings);
    open(r.index, r.profile, true);
  };
  const remove = (p: PrintProfile) => {
    const next = withoutProfile(s, p.id);
    if (!next) { toast.error(tr('القالب مستعمل في توجيه المستندات أو ملف PDF — غير التوجيه أولا')); return; }
    if (window.confirm(`${tr('حذف القالب')} «${profileDisplayName(p, tr)}»؟`)) setDraft(next);
  };
  const resetDefault = () => {
    if (!window.confirm(`${tr('استعادة الإعدادات الافتراضية — شريط 58 مم وملف PDF كما كانت')}؟`)) return;
    setDraft(legacyPrintSettings());
    setPendingClear(true);
  };
  /** الحفظ: إعادةٌ (null) إن استُعيد الافتراضي ولم يُعدَّل بعدها، وإلا المسودة */
  const saveDraft = () => {
    if (!draft) return;
    save.mutate(pendingClear && isLegacyPrintSettings(draft) ? null : draft);
  };
  const full = s.profiles.length >= PRINT_LIMITS.maxProfiles;

  return (
    <TaxOffPrintContext.Provider value={taxOff}>
    <div className="space-y-5">
      <div className="card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Printer size={18} className="text-[#E15A30]" /> {tr('إعدادات الطباعة')}</h2>
            <p className="text-sm text-[#6E6557] mt-1 leading-relaxed">
              {tr('اختر نوع الطابعة ومقاس الورق والتصميم لكل قالب ثم وجه كل مستند إلى قالبه — الحرارية والنقطية مثل Tally Dascom MIP480 والعادية وPDF')}
            </p>
            <p className="text-xs text-[#9A8F7E] mt-1.5 flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr(PRINT_NOTES.staleness)}</p>
          </div>
          <span className={`shrink-0 text-xs font-bold rounded-full px-3 py-1 border ${q.data?.stored ? 'bg-[#FBEBE2] text-[#C94E28] border-[#E8C9BC]' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
            {q.data?.stored ? tr('إعدادات مخصصة') : tr('الإعداد الافتراضي')}
          </span>
        </div>
        {!hasCompany && (
          <div className="mt-3 flex items-start gap-2 border rounded-xl px-3 py-2 text-sm bg-amber-50 border-amber-200 text-amber-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{tr(COMPANY_SETTINGS_MISSING_MSG)} — {tr('لا يحفظ هذا التبويب قبل حفظ اسم الشركة في الإعدادات العامة')}</span>
          </div>
        )}
      </div>

      {editor ? (
        <ProfileEditor
          editor={editor} setEditor={setEditor} settings={s} phase2={phase2} companyName={companyName} brandColor={brandColor} company={company}
          onApply={(p) => { setDraft(withProfile(s, p, editor.index)); setEditor(null); }}
          onEditClassic={(p) => editClassic(p, editor.index)} classicBlocked={s.profiles.length + (editor.index === null ? 1 : 0) >= PRINT_LIMITS.maxProfiles}
        />
      ) : (
        <>
          {/* A — توجيه المستندات */}
          <div className="card space-y-4">
            <div>
              <h3 className="font-bold text-[#1F1A13]">{tr('توجيه المستندات')}</h3>
              <p className="text-xs text-[#6E6557] mt-0.5">{tr('اختر قالب الطباعة المباشرة لكل مستند — ملف PDF متاح دائما')}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {DOC_KINDS.map((kind) => {
                const err = issueAt(`routing.${kind}`);
                return (
                  <label key={kind} className="block">
                    <span className="label">{tr(DOC_KIND_LABELS[kind])}</span>
                    <select className="input" value={s.routing[kind] ?? ''} onChange={(e) => setRouting(kind, e.target.value)}>
                      <option value="">{tr('لا طباعة مباشرة')}</option>
                      {/* «نموذج الشركة المطبوع مسبقاً» للفواتير وحدها (routingAllowsProfile) */}
                      {s.profiles.filter((p) => routingAllowsProfile(kind, p) || p.id === s.routing[kind]).map((p) => (
                        <option key={p.id} value={p.id}>{profileDisplayName(p, tr)} — {tr(PRINTER_SHORT[p.printer])}</option>
                      ))}
                    </select>
                    {err && <span className="block text-xs text-red-600 mt-1">{tr(err.message)}</span>}
                  </label>
                );
              })}
              <label className="block">
                <span className="label">{tr('قالب ملف PDF')}</span>
                <select className="input" value={s.pdfProfileId} onChange={(e) => setDraft({ ...s, pdfProfileId: e.target.value })}>
                  {/* «نموذج الشركة المطبوع مسبقاً» لا يكون قالب PDF: ملفٌّ بالبيانات وحدها بلا ورق الشركة */}
                  {s.profiles.filter((p) => (p.printer === 'page' && !isFormProfile(p)) || p.id === s.pdfProfileId).map((p) => (
                    <option key={p.id} value={p.id}>{profileDisplayName(p, tr)}</option>
                  ))}
                </select>
                <span className="block text-[11px] text-[#9A8F7E] mt-1">{tr('يستعمل في مشاركة وحفظ PDF لكل المستندات')}</span>
                {issueAt('pdfProfileId') && <span className="block text-xs text-red-600 mt-1">{tr(issueAt('pdfProfileId')!.message)}</span>}
              </label>
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={s.repMayChoose} onChange={(e) => setDraft({ ...s, repMayChoose: e.target.checked })} />
              <span>
                <span className="block text-sm font-semibold text-[#1F1A13]">{tr('السماح للمندوب باختيار الطابعة على جهازه')}</span>
                <span className="block text-xs text-[#6E6557]">{tr('مثل سيارة برول 80 مم وأخرى بطابعة نقطية — يختار كل جهاز قالبه ويحفظ اتصال طابعته عنده')}</span>
              </span>
            </label>
          </div>

          {/* B — القوالب */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-bold text-[#1F1A13]">{tr('قوالب الطباعة')} <span className="text-xs font-normal text-[#9A8F7E]" dir="ltr">{s.profiles.length}/{PRINT_LIMITS.maxProfiles}</span></h3>
              <button type="button" className="btn-primary disabled:opacity-60" disabled={full} onClick={addProfile} title={full ? tr('الحد 12 قالبا') : undefined}>
                <Plus size={16} /> {tr('إضافة قالب')}
              </button>
            </div>
            <div className="divide-y divide-[#F1EBDF] border border-[#F1EBDF] rounded-xl">
              {s.profiles.map((p, i) => {
                const Icon = PRINTER_ICON[p.printer];
                const legacy = isLegacyProfileId(p.id);
                const usage = profileUsage(s, p.id);
                const w = profileWarnings(p, { phase2 }).warnings;
                // «إزالة الضريبة»: بلا تنبيهات الرمز والفاتورة الضريبية لشركةٍ بلا ضريبة
                const shownWarnings = taxOffProfileWarnings({ warnings: w, notes: [] }, taxOff).warnings;
                const mm = printableMm(p);
                return (
                  <div key={p.id} className="p-3.5 flex items-center gap-3 flex-wrap">
                    <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center shrink-0"><Icon size={19} className="text-[#E15A30]" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#1F1A13] flex items-center gap-2 flex-wrap">
                        {profileDisplayName(p, tr)}
                        {legacy && <span className="text-[10px] text-[#1E7A52] bg-green-50 rounded-full px-2 py-0.5">{tr('الافتراضي الحالي')}</span>}
                        {usage.map((u) => <span key={u} className="text-[10px] text-[#C94E28] bg-[#FBEBE2] rounded-full px-2 py-0.5">{tr(DOC_KIND_SHORT[u])}</span>)}
                        {/* «إزالة الضريبة» (E6): لا شارة «بلا رمز QR» لشركةٍ بلا ضريبة — لا رمز على مستنداتها أصلاً */}
                        {isQrRemoved(layoutOf(p)) && !taxOff && <span data-qr-removed="" className="text-[10px] font-bold text-white bg-[#B42318] rounded-full px-2 py-0.5">{tr(QR_REMOVED_BADGE)}</span>}
                        {shownWarnings.length > 0 && <span title={shownWarnings.map((x) => tr(x)).join(' · ')}><AlertTriangle size={14} className="text-amber-600" /></span>}
                      </p>
                      <p className="text-xs text-[#6E6557] mt-0.5">
                        {tr(PRINTER_SHORT[p.printer])} · {tr(PRESET_LABELS[p.paper.preset])} · {tr(TEMPLATE_LABELS[p.template])}
                        {mm !== null && <> · {tr('عرض الطباعة')} <span dir="ltr">{mm}</span> {tr('مم')}</>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!legacy && <button type="button" onClick={() => open(i, p, true)} className="btn-secondary !py-1.5 !px-3 text-xs"><Pencil size={13} /> {tr('تعديل')}</button>}
                      {isClassicRoll(p) && (
                        <button type="button" disabled={full} onClick={() => editClassic(p, i)} className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40"
                          title={tr('ينشئ نسخة قابلة للتحرير ويوجه إليها مستنداته — الكلاسيكي يبقى كما هو')}>
                          <Scissors size={13} /> {tr('تحرير الشريط الكلاسيكي')}
                        </button>
                      )}
                      <button type="button" disabled={full} onClick={() => duplicate(p)} className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-40" title={tr('نسخ')}><Copy size={15} /></button>
                      <button type="button" onClick={() => remove(p)} className="p-2 rounded-lg text-red-500 hover:bg-red-50" title={tr('حذف')}><Trash2 size={15} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-[#9A8F7E]">{tr('الافتراضي الحالي هو طباعة اليوم بلا تغيير — انسخه لتعديل نسخة منه')}</p>
          </div>
        </>
      )}

      {/* الحفظ */}
      <div className="card flex items-center gap-3 flex-wrap">
        <button type="button" className="btn-primary px-6 disabled:opacity-60" disabled={!dirty || issues.length > 0 || !hasCompany || save.isPending || editor !== null}
          onClick={saveDraft}>
          {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={16} />}
          {tr('حفظ إعدادات الطباعة')}
        </button>
        <button type="button" className="btn-secondary" disabled={editor !== null} onClick={resetDefault}><RotateCcw size={14} /> {tr('استعادة الافتراضي')}</button>
        {editor !== null && <span className="text-xs text-[#9A8F7E]">{tr('احفظ القالب المفتوح أو ألغه أولا')}</span>}
        {editor === null && dirty && <span className="text-xs text-amber-700">{tr('تغييرات لم تحفظ')}</span>}
        {editor === null && issues.length > 0 && <span className="text-xs text-red-600">{tr(issues[0].message)}</span>}
      </div>
    </div>
    </TaxOffPrintContext.Provider>
  );
}

/** الاسم التلقائي ما لم يكتبه المدير: «حرارية رول 80 مم»، «نقطية A4 ورق متصل» */
function autoName(p: PrintProfile, existing: readonly PrintProfile[], tr: (s: string) => string): string {
  return uniqueProfileName(`${tr(PRINTER_SHORT[p.printer])} ${tr(PRESET_LABELS[p.paper.preset])}`, existing, p.id);
}

function ProfileEditor({ editor, setEditor, settings, phase2, companyName, brandColor, company, onApply, onEditClassic, classicBlocked }: {
  editor: EditorState; setEditor: (e: EditorState | null) => void; settings: PrintSettingsV1; phase2: boolean;
  companyName: string; brandColor: string; company: Company | null | undefined; onApply: (p: PrintProfile) => void;
  onEditClassic: (p: PrintProfile) => void; classicBlocked: boolean;
}) {
  const tr = useTr();
  // «المصمم الحر»: يُحمَّل عند أول فتح، و«إعادة المحاولة» بعد فشل تحميله مكوّنٌ كسولٌ جديد (React.lazy يحفظ الوعد المرفوض)
  const [designerOpen, setDesignerOpen] = useState(false);
  const [designerAttempt, setDesignerAttempt] = useState(0);
  const Designer = useMemo(() => lazy(loadDesigner), [designerAttempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // «تصميم النموذج» لقالب «نموذج الشركة المطبوع مسبقاً» — كسولٌ مثله وبالحاجز نفسه
  const [formOpen, setFormOpen] = useState(false);
  const FormDesigner = useMemo(() => lazy(loadFormDesigner), [designerAttempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // اختيار هذا الجهاز (الطريقة والرابط البطيء) — المفتاح نفسه الذي تقرؤه شاشة المستند
  const ident = useMemo(() => currentPrintIdentity(), []);
  const [deviceChoice, setDeviceChoice] = usePrintDeviceChoice(ident);
  const p = editor.profile;
  const others = settings.profiles.filter((_, i) => i !== editor.index);
  /** تعديل القالب — والاسم يتبع النوع والمقاس ما لم يكتبه المدير */
  const update = (next: PrintProfile) => setEditor({ ...editor, profile: editor.nameTouched ? next : { ...next, name: autoName(next, others, tr) } });
  const setOpt = <K extends keyof PrintOptions>(k: K, v: PrintOptions[K]) => update({ ...p, options: { ...p.options, [k]: v } });
  const index = editor.index ?? settings.profiles.length;
  const check = checkPrintSettings(withProfile(settings, p, editor.index), true);
  const issues = check.ok ? [] : check.issues.filter((i) => i.path.startsWith(`profiles[${index}]`));
  // «إزالة الضريبة»: الشركة بلا ضريبة (سياق اللوحة) — بلا تنبيهات الرمز والفاتورة الضريبية، ولا قسم «رمز QR»، ووصف القوالب بلا ضريبة
  const taxOff = useTaxOffPrint();
  const { warnings, notes } = taxOffProfileWarnings(profileWarnings(p, { phase2 }), taxOff);
  const raster = p.printer !== 'page';
  const detailedMinDots = p.paper.dpi !== null && p.printer === 'thermal' ? maxPrintableDots('thermal', PRINT_LIMITS.detailedMinMm, p.paper.dpi) : 0;
  const plan = qrPlan(p, STAMPED_QR_CELLS.typical);
  const mm = printableMm(p);
  // «نموذج الشركة المطبوع مسبقاً»: مواضعه (null لغيره) — قواعدها تُصلَح داخل مصمّمه، وتنبيهاته بلا ما عرضته profileWarnings
  const form = formOf(p);
  const formBlocked = issues.some((i) => !FORM_ISSUE_PATH.test(i.path));
  const formW: { warnings: string[]; notes: string[] } = form ? formWarnings(p, { taxFree: taxOff }) : { warnings: [], notes: [] };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <h3 className="font-bold text-[#1F1A13]">{editor.index === null ? tr('قالب جديد') : tr('تعديل القالب')}</h3>
        <button type="button" onClick={() => setEditor(null)} className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0]" title={tr('إلغاء')}><X size={16} /></button>
      </div>

      <label className="block mb-4 max-w-md">
        <span className="label">{tr('اسم القالب')}</span>
        <input className="input" value={p.name} maxLength={PRINT_LIMITS.nameMax}
          onChange={(e) => setEditor({ ...editor, nameTouched: true, profile: { ...p, name: e.target.value } })} />
      </label>

      {/* الخطوات */}
      <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1" role="tablist">
        {STEPS.map((label, i) => {
          const n = (i + 1) as EditorState['step'];
          return (
            <button key={label} type="button" role="tab" aria-selected={editor.step === n} onClick={() => setEditor({ ...editor, step: n })}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${editor.step === n ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a] hover:border-[#D8CDB9]'}`}>
              <span dir="ltr">{n}</span> · {tr(label)}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="space-y-4 min-w-0">
          {editor.step === 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {PRINTER_TYPES.map((t) => {
                const Icon = PRINTER_ICON[t];
                return (
                  <button key={t} type="button" onClick={() => update(withPrinter(p, t))}
                    className={`text-right rounded-2xl border-2 p-4 transition-colors ${p.printer === t ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white hover:border-[#D8CDB9]'}`}>
                    <Icon size={26} className="text-[#E15A30]" />
                    <span className="block font-bold text-[#1F1A13] mt-2">{tr(PRINTER_LABELS[t])}</span>
                    <span className="block text-xs text-[#6E6557] mt-1 leading-relaxed">{tr(PRINTER_HINTS[t])}</span>
                  </button>
                );
              })}
            </div>
          )}

          {editor.step === 2 && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[...PAPER_PRESETS.filter((x) => x.printer === p.printer).map((x) => x.id), 'custom' as const].map((id) => {
                  const pp = PAPER_PRESETS.find((x) => x.id === id)?.paper;
                  return (
                    <button key={id} type="button" onClick={() => update(withPreset(p, id))}
                      className={`text-right rounded-xl border-2 px-3 py-2 transition-colors ${p.paper.preset === id ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white hover:border-[#D8CDB9]'}`}>
                      <span className="block text-[12.5px] font-bold text-[#1F1A13]">{tr(PRESET_LABELS[id])}</span>
                      <span className="block text-[11px] text-[#9A8F7E]" dir="ltr">
                        {pp ? `${pp.widthMm}${pp.lengthMm !== null ? ` × ${pp.lengthMm}` : ''} mm` : `${p.paper.widthMm}${p.paper.lengthMm !== null ? ` × ${p.paper.lengthMm}` : ''} mm`}
                      </span>
                    </button>
                  );
                })}
              </div>
              {mm !== null && (
                <p className="text-xs text-[#6E6557]">
                  {tr('عرض الطباعة')} <b dir="ltr">{mm}</b> {tr('مم')} · <span dir="ltr">{p.paper.printableDots} dots · {p.paper.dpi} dpi</span>
                </p>
              )}
              <details className="rounded-xl border border-[#E9E1D3] px-3 py-2" open={p.paper.preset === 'custom'}>
                <summary className="text-sm font-semibold text-[#44403a] cursor-pointer">{tr('إعدادات متقدمة')}</summary>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <NumField label={tr('عرض الورق')} suffix="mm" value={p.paper.widthMm} step={0.5} onChange={(v) => update(withPaper(p, { widthMm: v }))} />
                  <label className="block">
                    <span className="label">{tr('تغذية الورق')}</span>
                    <select className="input" value={p.paper.feed} onChange={(e) => update(withPaper(p, { feed: e.target.value as PaperFeed }))}>
                      {FEEDS_BY_PRINTER[p.printer].map((f) => <option key={f} value={f}>{tr(FEED_LABELS[f])}</option>)}
                    </select>
                  </label>
                  {p.paper.feed !== 'roll' && p.paper.lengthMm !== null && (
                    <NumField label={tr('طول الصفحة')} suffix="mm" value={p.paper.lengthMm} step={0.5} onChange={(v) => update(withPaper(p, { lengthMm: v }))} />
                  )}
                  {raster && (
                    <label className="block">
                      <span className="label">{tr('دقة الطابعة')}</span>
                      <select className="input" dir="ltr" value={p.paper.dpi ?? ''} onChange={(e) => update(withDpi(p, Number(e.target.value) as PrinterDpi))}>
                        {DPIS_BY_PRINTER[p.printer].map((d) => <option key={d} value={d}>{d} dpi</option>)}
                      </select>
                    </label>
                  )}
                  {raster && p.paper.printableDots !== null && (
                    <NumField label={tr('عرض الطباعة بالنقاط')} suffix="dots" value={p.paper.printableDots} step={p.printer === 'thermal' ? 8 : 1}
                      onChange={(v) => update(withPaper(p, { printableDots: Math.round(v) }))} />
                  )}
                </div>
              </details>
            </>
          )}

          {editor.step === 3 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {designCards(p).map((c) => {
                const t = c.kind === 'template' ? c.t : null;
                // «نموذج الشركة المطبوع مسبقاً» (بطاقةٌ من designCards للطابعة العادية): يلزمه ورقٌ بطول صفحة
                const isForm = c.kind === 'preprinted';
                const detailBlocked = t === 'roll_detailed' && (p.paper.printableDots ?? 0) < detailedMinDots;
                const noLength = isForm && p.paper.lengthMm === null;
                // وما تمنعه قواعد الإعداد (قالب PDF، أو موجَّهٌ لغير الفواتير، أو 4 نماذج) — رسالة النواة نفسها التي يُرفض بها الحفظ
                const formBlock = isForm && !noLength ? formDesignBlock(withProfile(settings, p, editor.index), p.id) : null;
                const blocked = detailBlocked || noLength || formBlock !== null;
                const label = isForm ? DESIGN_LABELS.preprinted : t ? TEMPLATE_LABELS[t] : DESIGN_LABELS.grid_bilingual;
                const hint = templateHintFor(t, t ? TEMPLATE_HINTS[t] : DESIGN_HINTS.grid_bilingual ?? '', taxOff);
                const cardKey = designCardId(c);
                return (
                  <button key={cardKey} type="button" disabled={blocked} onClick={() => update(applyDesignCard(p, c))}
                    data-design-card={cardKey}
                    className={`text-right rounded-2xl border-2 p-3 flex gap-3 transition-colors disabled:opacity-50 ${designCardSelected(p, c) ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white hover:border-[#D8CDB9]'}`}>
                    {isForm ? <FormThumb taxOff={taxOff} /> : <>{t ? <TemplateThumb t={t} taxOff={taxOff} /> : <GridThumb taxOff={taxOff} />}</>}
                    <span className="min-w-0">
                      <span className="block font-bold text-[#1F1A13]">{tr(label)}</span>
                      <span className="block text-xs text-[#6E6557] mt-1 leading-relaxed">{tr(isForm ? DESIGN_HINTS.preprinted ?? '' : hint)}</span>
                      {detailBlocked && <span className="block text-xs text-red-600 mt-1">{tr(PRINT_ISSUES.detailedWidth)}</span>}
                      {noLength && <span className="block text-xs text-red-600 mt-1">{tr('اختر ورقا بطول صفحة مثل A4 أولا')}</span>}
                      {formBlock && <span className="block text-xs text-red-600 mt-1">{tr(formBlock)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {editor.step === 4 && (
            <div className="space-y-3">
              {/* «نموذج الشركة المطبوع مسبقاً»: البيانات وحدها في مواضعها — لا محتوى ولا تخطيط ولا أدوات تصميمٍ حرّ ولا خط؛ مصمّم النموذج مكانها */}
              {form && (
                <Section title={tr('نموذج الشركة المطبوع مسبقاً')} open>
                  <div data-form-status="" className="text-xs text-[#44403a] leading-relaxed">
                    {form.image ? tr('صورة النموذج مرفوعة') : tr('لم ترفع صورة النموذج بعد')}
                    {' · '}{tr('الحقول')} <b dir="ltr">{form.fields.length}</b>
                    {' · '}{tr('أعمدة الجدول')} <b dir="ltr">{form.table?.columns.length ?? 0}</b>
                    {form.table && <>{' · '}{tr('صفوف كل ورقة')} <b dir="ltr">{form.table.rows}</b></>}
                    {(form.dxMm !== 0 || form.dyMm !== 0) && <>{' · '}{tr('المعايرة')} <span dir="ltr">{form.dxMm} / {form.dyMm} mm</span></>}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" className="btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40" disabled={formBlocked} onClick={() => setFormOpen(true)}>
                      <LayoutTemplate size={13} /> {tr('تصميم النموذج')}
                    </button>
                    <span className="text-[11px] text-[#9A8F7E]">{tr('ارفع صورة نموذجك الفارغ وضع الحقول على فراغاته ثم عاير الطابعة')}</span>
                    {formBlocked && <span className="text-[11px] text-red-600">{tr('أصلح أخطاء القالب أولا')}</span>}
                  </div>
                  {(formW.warnings.some((w) => !warnings.includes(w)) || formW.notes.some((n) => !notes.includes(n))) && (
                    <div className="space-y-1" data-form-warnings="">
                      {formW.warnings.filter((w) => !warnings.includes(w)).map((w) => (
                        <p key={w} className="text-[11px] flex items-start gap-1.5 text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{tr(w)}</p>
                      ))}
                      {formW.notes.filter((n) => !notes.includes(n)).map((n) => (
                        <p key={n} className="text-[11px] flex items-start gap-1.5 text-[#6E6557]"><Info size={12} className="mt-0.5 shrink-0" />{tr(n)}</p>
                      ))}
                    </div>
                  )}
                </Section>
              )}

              {!form && (<Section title={tr('المحتوى')} open>
                <Toggle label={tr('شعار الشركة')} checked={p.options.showLogo} onChange={(v) => setOpt('showLogo', v)} disabled={p.template === 'impact_preprinted'} />
                <Toggle label={tr('العنوان والهاتف')} checked={p.options.showContact} onChange={(v) => setOpt('showContact', v)} />
                <Toggle label={tr('اسم المندوب')} checked={p.options.showRepName} onChange={(v) => setOpt('showRepName', v)} />
                <Toggle label={tr('التوقيعات')} hint={tr('تبقى مشروطة بتفعيل التوقيعات للشركة')} checked={p.options.showSignatures} onChange={(v) => setOpt('showSignatures', v)} />
                <Toggle label={tr('وحدة الصنف')} checked={p.options.showItemUnit} onChange={(v) => setOpt('showItemUnit', v)} />
                {!p.options.showItemUnit && <ItemUnitWarning />}
                <label className="block">
                  <span className="label">{tr('نص التذييل')}</span>
                  <input className="input" maxLength={PRINT_LIMITS.footerMax} placeholder={tr('شكرا لتعاملكم معنا')} value={p.options.footerText ?? ''}
                    onChange={(e) => setOpt('footerText', e.target.value ? e.target.value : null)} />
                </label>
                {!taxOff && <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr(QR_PANEL_NOTE)}</p>}
              </Section>)}

              {!form && <Section title={tr('التخطيط')} open><LayoutFields p={p} update={update} /></Section>}

              {!form && (<Section title={tr('أدوات التصميم')} open>
                <PrintDesignTools p={p} update={update} phase2={phase2} />
                <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[#F1EBDF]">
                  {isClassicRoll(p) ? (
                    <button type="button" className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40" disabled={classicBlocked} onClick={() => onEditClassic(p)}>
                      <Scissors size={13} /> {tr('تحرير الشريط الكلاسيكي')}
                    </button>
                  ) : (
                    <button type="button" className="btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40" disabled={issues.length > 0} onClick={() => setDesignerOpen(true)}>
                      <PenTool size={13} /> {tr('المصمم الحر')}
                    </button>
                  )}
                  <span className="text-[11px] text-[#9A8F7E]">
                    {isClassicRoll(p)
                      ? tr('ينشئ نسخة قابلة للتحرير ويوجه إليها مستنداته — الكلاسيكي يبقى كما هو')
                      : p.printer === 'thermal'
                        ? tr('اسحب كتل الشريط للترتيب والمحاذاة وكبر الشعار من مقبضه')
                        : tr('اسحب الشعار وكل مربع إلى أي مكان في رأس الورقة وتذييلها وغير حجمه بالسحب')}
                  </span>
                  {issues.length > 0 && !isClassicRoll(p) && <span className="text-[11px] text-red-600">{tr('أصلح أخطاء القالب أولا')}</span>}
                </div>
              </Section>)}

              {!form && (<Section title={tr('الخط')}>
                {/* الصفحة والنقطية: حجم الخط في «التخطيط» — لا يُطبَّق عليهما إلا مع تخطيط (بلاه مطبوعة اليوم حرفياً) */}
                {p.printer === 'thermal' && (
                  <div>
                    <span className="label">{tr('حجم الخط')}</span>
                    <div className="flex gap-1.5 flex-wrap">
                      {FONT_SCALES.map((f) => (
                        <button key={f} type="button" onClick={() => setOpt('fontScale', f)} dir="ltr"
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${p.options.fontScale === f ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white'}`}>{Math.round(f * 100)}%</button>
                      ))}
                    </div>
                  </div>
                )}
                <Toggle label={tr('خط عريض للنص')} checked={p.options.boldBody} onChange={(v) => setOpt('boldBody', v)} />
              </Section>)}

              {/* «إزالة الضريبة»: لا رمز QR في أيّ مستندٍ لشركةٍ بلا ضريبة — فلا قسم لمقاسه */}
              {!taxOff && (<Section title={tr('رمز QR')}>
                {raster ? (
                  <>
                    <div className="flex gap-1.5">
                      {(['auto', 'large'] as const).map((z) => (
                        <button key={z} type="button" onClick={() => setOpt('qrSize', z)}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${p.options.qrSize === z ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white'}`}>{z === 'auto' ? tr('تلقائي') : tr('كبير')}</button>
                      ))}
                    </div>
                    {plan && (
                      <p className="text-xs text-[#44403a]">
                        {tr('للرمز المعتمد في المرحلة الثانية')}: <b dir="ltr">≈ {Math.round(plan.sizeMm)} mm</b> · <span dir="ltr">{plan.dotsPerCell}</span> {tr('نقاط للخلية')}
                      </p>
                    )}
                    <p className="text-[11px] text-[#9A8F7E]">{tr('لا يصغر الرمز عن الحد الأدنى لدقة الطابعة')}</p>
                  </>
                ) : form ? <p className="text-xs text-[#6E6557]">{tr('مقاس الرمز بمقاس حقله في مصمم النموذج')}</p>
                  : <p className="text-xs text-[#6E6557]">{tr('مقاس الرمز في الصفحة كما هو اليوم')}</p>}
              </Section>)}

              <Section title={tr('النسخ')}>
                <div>
                  <span className="label">{tr('عدد النسخ')}</span>
                  <div className="flex gap-1.5">
                    {PRINT_COPIES.map((c) => (
                      <button key={c} type="button" onClick={() => setOpt('copies', c)} dir="ltr"
                        className={`rounded-lg border px-3.5 py-1 text-xs font-semibold ${p.options.copies === c ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white'}`}>{c}</button>
                    ))}
                  </div>
                </div>
                <Toggle label={tr('وسم الأصل والنسخة')} checked={p.options.copyLabels} onChange={(v) => setOpt('copyLabels', v)} />
              </Section>

              <Section title={tr('الورق والمحاذاة')}>
                <div className="grid grid-cols-2 gap-3">
                  {raster && <NumField label={tr('إزاحة أفقية')} suffix="mm" value={p.paper.offsetXmm} step={0.5} onChange={(v) => update(withPaper(p, { offsetXmm: v }))} />}
                  {!form && <NumField label={tr('الهامش العلوي')} suffix="mm" value={p.paper.marginTopMm} step={0.5} onChange={(v) => update(withPaper(p, { marginTopMm: v }))} />}
                  {p.paper.feed !== 'roll' && !form && <NumField label={tr('الهامش السفلي')} suffix="mm" value={p.paper.marginBottomMm} step={0.5} onChange={(v) => update(withPaper(p, { marginBottomMm: v }))} />}
                  {p.printer === 'thermal' && <NumField label={tr('تغذية بعد الطباعة')} suffix="mm" value={p.options.feedAfterMm} step={1} onChange={(v) => setOpt('feedAfterMm', v)} />}
                </div>
                {p.printer === 'thermal' && <Toggle label={tr('قص الورق بعد الطباعة')} checked={p.options.cutAfter} onChange={(v) => setOpt('cutAfter', v)} />}
                {form && <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr('مواضع النموذج من حافة الورقة بلا هوامش — اضبط إزاحة الطابعة من «المعايرة» في مصمم النموذج')}</p>}
                {p.printer === 'impact' && (
                  <div>
                    <span className="label">{tr('جودة الرسم')}</span>
                    <div className="flex gap-1.5">
                      {(['quality', 'draft'] as const).map((g) => (
                        <button key={g} type="button" onClick={() => setOpt('graphicsQuality', g)}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold ${p.options.graphicsQuality === g ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white'}`}>{g === 'quality' ? tr('جودة عالية') : tr('مسودة أسرع')}</button>
                      ))}
                    </div>
                  </div>
                )}
              </Section>
            </div>
          )}

          {(warnings.length > 0 || notes.length > 0) && (
            <div className="space-y-1.5">
              {warnings.map((w) => (
                <p key={w} className="text-xs flex items-start gap-1.5 text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{tr(w)}</p>
              ))}
              {notes.map((n) => (
                <p key={n} className="text-[11px] flex items-start gap-1.5 text-[#6E6557]"><Info size={12} className="mt-0.5 shrink-0" />{tr(n)}</p>
              ))}
            </div>
          )}
          {issues.length > 0 && (
            <div className="space-y-1">
              {[...new Set(issues.map((i) => i.message))].map((m) => <p key={m} className="text-xs text-red-600">{tr(m)}</p>)}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[#F1EBDF]">
            <button type="button" className="btn-secondary" disabled={editor.step === 1} onClick={() => setEditor({ ...editor, step: (editor.step - 1) as EditorState['step'] })}>
              <ChevronRight size={15} /> {tr('السابق')}
            </button>
            {editor.step < 4 && (
              <button type="button" className="btn-secondary" onClick={() => setEditor({ ...editor, step: (editor.step + 1) as EditorState['step'] })}>
                {tr('التالي')} <ChevronLeft size={15} />
              </button>
            )}
            <button type="button" className="btn-primary disabled:opacity-60" disabled={issues.length > 0} onClick={() => onApply(p)}><Check size={15} /> {tr('تم')}</button>
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>{tr('إلغاء')}</button>
          </div>
        </div>

        {/* D — المعاينة */}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-500 mb-2">{tr('المعاينة')}</p>
          <div className="rounded-2xl bg-[#FAF7F0] border border-[#E9E1D3] p-3">
            <PrintPreview profile={p} companyName={companyName} brandColor={brandColor} company={company} />
          </div>
          {/* E — الطباعة على هذا الجهاز: المعايرة والتجربة بالقيم المفتوحة (قبل الحفظ) */}
          <p className="text-sm font-semibold text-gray-500 mt-4 mb-2">{tr('الطباعة على هذا الجهاز')}</p>
          {issues.length > 0 ? (
            <p className="text-xs text-[#9A8F7E]">{tr('أصلح أخطاء القالب أولا ثم اطبع صفحة المعايرة')}</p>
          ) : (
            <PrintDeviceTools profile={p} name={p.name.trim() || tr(PRINTER_SHORT[p.printer])} company={company}
              renderSheet={(d, ref) => <PrintableInvoice ref={ref} doc={d} />} choice={deviceChoice} onChoice={setDeviceChoice} />
          )}
        </div>
      </div>

      {designerOpen && (
        <DesignerBoundary onRetry={() => setDesignerAttempt((n) => n + 1)} onClose={() => setDesignerOpen(false)}>
          <Suspense fallback={(
            <div className="fixed inset-0 z-[1500] bg-[#FAF7F0]/80 flex items-center justify-center" role="status">
              <span className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
            </div>
          )}>
            <Designer profile={p} phase2={phase2} company={company} companyName={companyName} brandColor={brandColor}
              onApply={update} onClose={() => setDesignerOpen(false)} />
          </Suspense>
        </DesignerBoundary>
      )}
      {formOpen && form && (
        <DesignerBoundary form onRetry={() => setDesignerAttempt((n) => n + 1)} onClose={() => setFormOpen(false)}>
          <Suspense fallback={(
            <div className="fixed inset-0 z-[1500] bg-[#FAF7F0]/80 flex items-center justify-center" role="status">
              <span className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
            </div>
          )}>
            <FormDesigner profile={p} phase2={phase2} company={company} companyName={companyName} brandColor={brandColor}
              onApply={update} onClose={() => setFormOpen(false)} />
          </Suspense>
        </DesignerBoundary>
      )}
    </div>
  );
}

/** حاجز «المصمم الحر»: فشل تحميل حزمته (نُشر تحديثٌ والصفحة مفتوحة، أو انقطاع) لا يُسقط المحرّر ومسودته — لافتةٌ وإعادة محاولة */
class DesignerBoundary extends Component<{ children: ReactNode; onRetry: () => void; onClose: () => void; form?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  retry = () => { this.setState({ failed: false }); this.props.onRetry(); };
  render(): ReactNode {
    return this.state.failed ? <DesignerLoadError onRetry={this.retry} onClose={this.props.onClose} form={this.props.form} /> : this.props.children;
  }
}

function DesignerLoadError({ onRetry, onClose, form }: { onRetry: () => void; onClose: () => void; form?: boolean }) {
  const tr = useTr();
  return (
    <div className="fixed inset-0 z-[1500] bg-[#FAF7F0]/90 flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
      <div className="card max-w-sm w-full">
        <p className="text-sm font-semibold text-[#8E2A1F] flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{form ? tr('تعذر تحميل مصمم النموذج') : tr('تعذر تحميل المصمم الحر')}</p>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button type="button" className="btn-secondary" onClick={onRetry}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
          <button type="button" className="btn-secondary" onClick={onClose}><X size={14} /> {tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-[#E9E1D3] px-3 py-2" open={open}>
      <summary className="text-sm font-semibold text-[#44403a] cursor-pointer">{title}</summary>
      <div className="space-y-3 mt-3">{children}</div>
    </details>
  );
}

/**
 * تنبيه R11 («الوحدة الرئيسية»): إطفاء «وحدة الصنف» والشركة لها صنفٌ بأكثر من وحدة (أو بوحدةٍ رئيسية) يطبع «×5» بلا وحدة،
 * فلا يُعرف أكراتين أم حبّات. تنبيهٌ وحده — الطباعة لا تتغيّر (فرض الوحدة رغم الإعداد قرارٌ مفتوح للمالك §10-7).
 * كتالوج الأصناف المختصر (المفتاح المشترك ['products-min']) يُطلب حين تُطفأ الخانة وحدها. تعذّره (صلاحيةٌ أو محاسبةٌ مطفأة) لا
 * يُخفي التنبيه — لا نعرف أنّ الشركة بلا أصنافٍ متعدّدة الوحدات، والنصّ مشروطٌ بها أصلاً؛ وما دام يُحمَّل لا يظهر شيء
 */
function ItemUnitWarning() {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; units?: UnitDef[] | null; primaryUnitId?: string | null }[],
    staleTime: 60_000,
  });
  const multi = q.isError || (q.data ?? []).some((x) => primaryUnitOf(x) !== null || hasBigUnit(x?.units));
  if (!multi) return null;
  return (
    <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed flex items-start gap-1.5" data-item-unit-warning="">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />{tr('إطفاؤه مع أصناف بأكثر من وحدة يطبع «×5» بلا وحدة، فلا يُعرف أكراتين أم حبّات')}
    </p>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={checked && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm text-[#1F1A13]">{label}</span>
        {hint && <span className="block text-[11px] text-[#9A8F7E]">{hint}</span>}
      </span>
    </label>
  );
}

/** حقل رقمي بنصّ محلي: الكتابة الجزئية («8.») لا تقفز، والقيمة تُرسل حين تصير رقماً */
function NumField({ label, value, onChange, step, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; suffix?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((prev) => (prev.trim() !== '' && Number(prev) === value ? prev : String(value))); }, [value]);
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="flex items-center gap-1.5">
        <input className="input" type="number" dir="ltr" inputMode="decimal" step={step} value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
          }} />
        {suffix && <span className="text-xs text-[#9A8F7E] shrink-0" dir="ltr">{suffix}</span>}
      </span>
    </label>
  );
}

/** صورة مصغّرة لكل تصميم — مخطّط لا معاينة؛ وبلا مربع الرمز لشركةٍ بلا ضريبة (E6) */
function TemplateThumb({ t, taxOff = false }: { t: TemplateId; taxOff?: boolean }) {
  const line = (w: string, bold = false) => <span className="block rounded-sm" style={{ height: bold ? 3 : 2, width: w, background: '#1F1A13', margin: '3px auto 0' }} />;
  const roll = t.startsWith('roll_');
  return (
    <span aria-hidden="true" className="shrink-0 block bg-white border border-[#D8CDB9] rounded-md overflow-hidden" style={{ width: roll ? 38 : 56, height: 72, padding: 5 }}>
      {t === 'page_branded' && <span className="block rounded-sm" style={{ height: 10, background: '#1e3a8a', marginBottom: 3 }} />}
      {t === 'impact_preprinted' && <span className="block" style={{ height: 12 }} />}
      {(t === 'impact_plain' || t === 'page_plain') && <span className="block" style={{ height: 3, background: '#000', marginBottom: 2 }} />}
      {line('70%', true)}
      {line('50%')}
      {t === 'roll_detailed' || !roll ? (
        <span className="grid grid-cols-3 gap-[2px] mt-1.5">
          {Array.from({ length: 9 }, (_, i) => <span key={i} className="block" style={{ height: 3, background: i < 3 ? '#1F1A13' : '#9A8F7E' }} />)}
        </span>
      ) : (<>{line('85%')}{line('60%')}{line('85%')}</>)}
      {!taxOff && <span className="block mx-auto mt-1.5" style={{ width: 14, height: 14, background: 'repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / 4px 4px' }} />}
    </span>
  );
}
