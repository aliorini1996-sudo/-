import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle, BookOpenCheck, CalendarClock, CircleAlert, Eye, FileText, Info, Loader2, Package, Pencil, QrCode, Trash2, Undo2,
} from 'lucide-react';
import { aiAccountantApi } from '../../../api/client';
import { useTr } from '../../../i18n/strings';
import { currencyDecimals } from '../../../i18n/countries';
import {
  PREPAID_MAX_MONTHS, amortizationOf, docApiErrorInfo, docCheckText, docConfirmMessage, docFormProblemText, docRefusalText,
  normalizeDocResponse,
  type AcctAssetClass, type AcctDocConfirm, type AcctDocPatch, type AcctDocType, type AcctDocView, type DocRefusal,
} from '../../../lib/aiAccountantDocs';
import { formatCurrency, formatDayOnly } from '../../../utils/format';
import {
  ASSET_CLASS_ORDER, DOC_CATEGORY_CHIPS, accountsFor, assetClassLabel, assetClassPatch, blockerText, categoryChipLabel,
  categoryChipOf, categoryChipPatch, chipSelected, choiceFromConfirm, choiceIsSuggestion, chosenVatMode, confirmBlocker,
  confirmChoiceOf, defaultChoice, docReferral, docState, docStateLabel, docStateTone, docTypeChips, docTypeLabelFor, duplicateText,
  factsSourceLabel, formOf, monthsInputShown, monthsPatch, patchOf, payOptionLabel, payValue, reconcileChoice, sumMismatch,
  thresholdOf, treatmentLabel, treatmentReasonText, treatmentStates, vatModeText, vendorVatOdd, visibleChecks, visiblePayOptions,
  withRefusalDuplicate, withTreatment,
  type DocCategoryChip, type DocChoice, type FactsField, type FactsForm,
} from './docCardLogic';

/** مهلة حفظ الأشهر بعد آخر حرف (PATCH فيعيد الخادم الفحص والاقتراح) */
const MONTHS_PATCH_DELAY_MS = 600;
import type { ViewerDoc } from './DocViewer';

/** ما تمرّره المحادثة لكل بطاقات المستندات */
export interface DocCardEnv {
  /** الشركة «بلا ضريبة» (isTaxOff) — لا صفوف ضريبة ولا رقم ضريبي ولا رمز QR */
  taxOff: boolean;
  /** حدّ الرسملة بوحدة العملة الكبرى (status.docs.assetThreshold) */
  assetThreshold: number;
  currency: string;
  /** اليوم بتقويم الشركة — «سجّل بتاريخ اليوم» بعد رفض الفترة المقفلة */
  todayLocal: string;
  /** المحادثة تنتظر ردّاً — لا ضغطة ثانية */
  busy: boolean;
  /** المستند الذي يُرحَّل الآن (confirmingDocId) */
  confirmingId: string | null;
  /** آخر docConfirm أُرسل لكل مستند (lastConfirms) — البطاقة المنتقلة إلى ردٍّ أحدث تستعيد منه الاختيار */
  lastConfirms: Readonly<Record<string, AcctDocConfirm>>;
  /** بطاقةٌ تغيّرت (PATCH) ⇒ تُستبدل في كل فقاعة (replaceDocView) */
  onPatched: (v: AcctDocView) => void;
  onDeleted: (id: string) => void;
  /** «سجّل القيد»: النصّ المرئي (الإجمالي والحساب وحساب الدفع حرفياً) مع docIds وdocConfirm — رسالةٌ جديدة في المحادثة */
  onConfirm: (msg: { text: string; docIds: string[]; docConfirm: AcctDocConfirm }) => void;
  onOpen: (d: ViewerDoc) => void;
}

/**
 * بطاقة المستند في ردّ «المحاسب الذكي» (قرار المالك D1 — مراجعة إلزامية قبل أي ترحيل):
 *
 * - الحقائق: النوع (شرائح يختارها المستخدم ⇒ PATCH فيعيد الخادم الاقتراح)، والتصنيف (مصروف أو خدمة / أصل ثابت وفئته /
 *   بضاعة للبيع ⇒ PATCH categoryHint وassetClassHint: البضاعة لمشتريات المستودع والأرض والمبنى للمحاسب البشري — D3)، المورد
 *   ورقمه الضريبي ورقم الفاتورة وتاريخها الميلادي، وقبل الضريبة والضريبة والإجمالي. بلا رمز QR (manualEntry) تفتح البطاقة في
 *   وضع الإدخال، و«تعديل» يفتحه دائماً ⇒ PATCH بالحقول المتغيّرة وحدها ثم يعيد الخادم الفحص.
 * - المعالجة: مصروف / مقدّم يُوزَّع على أشهر (1..24 — تُحفظ بـPATCH فيعيد الخادم فحصها، ومصروف إطفائه الشهري ظاهر) / أصل (ما
 *   بلغ حدّ الرسملة وحده، «يحتاج إهلاكاً يسجّله المحاسب»)، والحساب من خيارات الخادم (دليل الشركة)، و«مدفوع من» إلزامي (نقد،
 *   نثريات، بنك، «آجل — على الحساب» — لا آجل لعقد الإيجار: العقد ليس فاتورة مستحقة). ملاحظة الضريبة لحكم الحساب المختار.
 * - الفحوص: الكهرماني تنبيه يُسمح معه، والأحمر يعطّل «سجّل القيد».
 * - «سجّل القيد» ⇒ رسالةٌ بنصٍّ مركّب (docConfirmMessage) يذكر الإجمالي والحساب وحساب الدفع حرفياً مع docConfirm — الخادم
 *   يرحّل بلا نموذج ذكاء من الحقائق المخزّنة (لا رقم من البطاقة). التكرار يُتجاوز بـ«ليست مكررة — سجّلها»، والفترة المقفلة
 *   بـ«سجّل بتاريخ اليوم».
 * - «حذف» للمستند الذي لم يُرحَّل قط (يحرّر حصة المرفقات).
 * الشركة «بلا ضريبة» (isTaxOff): لا صفوف ضريبة ولا رقم ضريبي ولا ذكر لرمز QR. النصّ يُعرض نصّاً (React يهرّبه) والاسم في bdi.
 */
export default function DocCard({ view, env, refusal, compact = false }: {
  view: AcctDocView;
  env: DocCardEnv;
  /** آخر رفضٍ لترحيله (refusalsByDoc) */
  refusal?: DocRefusal | null;
  compact?: boolean;
}) {
  const tr = useTr();
  const uid = useId();
  const decimals = currencyDecimals(env.currency);
  const opts = { assetThreshold: thresholdOf(env.assetThreshold), decimals, taxOff: env.taxOff };

  const state = docState(view);
  const live = state === 'posted';
  const [editing, setEditing] = useState(() => view.manualEntry === true && !live && !view.factsSource);
  const [form, setForm] = useState<FactsForm>(() => formOf(view));
  const [fieldErr, setFieldErr] = useState<{ field: FactsField; text: string } | null>(null);
  const [choice, setChoice] = useState<DocChoice>(() => {
    const prev = env.lastConfirms[view.id];
    return prev ? choiceFromConfirm(view, prev, opts) : defaultChoice(view, opts);
  });
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // عرضٌ جديد (بعد PATCH أو ردّ المحادثة): يُواءم الاختيار؛ واقتراحٌ تغيّر (نوعٌ أو تصنيفٌ آخر) يُعيد المعالجة والحساب إليه —
  // إلا تغيّراً سببه حفظ الأشهر التي كتبها المستخدم تحت معالجته (keepChoice): لا تُقلب معالجته لأنه كتب عدداً
  const sugKey = view.suggestion ? `${view.suggestion.treatment}|${view.suggestion.accountCode}` : '';
  const lastSug = useRef(sugKey);
  const keepChoice = useRef(false);
  useEffect(() => {
    const o = { assetThreshold: thresholdOf(env.assetThreshold), taxOff: env.taxOff };
    const changed = lastSug.current !== sugKey;
    lastSug.current = sugKey;
    const keep = keepChoice.current;
    keepChoice.current = false;
    setChoice((c) => {
      if (!changed || keep) return reconcileChoice(view, c, o);
      const d = defaultChoice(view, o);
      return reconcileChoice(view, { ...d, pay: c.pay, months: c.months ?? d.months, date: c.date }, o);
    });
  }, [view, sugKey, env.assetThreshold, env.taxOff]);

  const patch = useMutation({
    mutationFn: async (body: AcctDocPatch) => {
      const res = await aiAccountantApi.documents.patch(view.id, body);
      const doc = normalizeDocResponse(res.data?.data).document;
      if (!doc) throw new Error('BAD_RESPONSE');
      return doc;
    },
    onSuccess: (doc) => { setErr(null); env.onPatched(doc); },
    onError: (e) => setErr(docApiErrorInfo(e, 'patch', tr).message),
  });

  const del = useMutation({
    mutationFn: async () => { await aiAccountantApi.documents.remove(view.id); },
    onSuccess: () => { setArmed(false); env.onDeleted(view.id); },
    onError: (e) => { setArmed(false); setErr(docApiErrorInfo(e, 'remove', tr).message); },
  });

  const saving = patch.isPending;
  const locked = live || env.busy || saving || del.isPending;
  const confirming = env.busy && env.confirmingId === view.id;

  const pickType = (t: AcctDocType) => {
    if (locked || chipSelected(t, view.facts?.docType ?? null, env.taxOff)) return;
    patch.mutate({ docType: t });
  };
  /** التصنيف وفئة الأصل (D3) — PATCH فيعيد الخادم الاقتراح والفحص (البضاعة والأرض لا تُرحَّل من هنا) */
  const pickHint = (body: AcctDocPatch | null) => {
    if (locked || !body) return;
    patch.mutate(body);
  };

  // الأشهر التي يكتبها المستخدم تُحفظ (PATCH months) بعد مهلةٍ قصيرة فيعيد الخادم الفحص — وإلا بقيت «عدد أشهر الإطفاء…»
  // الحمراء تعطّل «سجّل القيد» بعد عددٍ صحيح. فشلٌ لا يُعاد للعدد نفسه في حلقة (lastTried)، وعددٌ آخر يُحاول من جديد.
  const lastTried = useRef<number | null>(null);
  const monthsShown = !live && monthsInputShown(view, choice);
  useEffect(() => {
    if (!monthsShown || env.busy || patch.isPending) return;
    const body = monthsPatch(view, choice.months);
    if (!body || body.months === lastTried.current) return;
    const t = window.setTimeout(() => {
      lastTried.current = body.months ?? null;
      keepChoice.current = true;
      patch.mutate(body, { onError: () => { keepChoice.current = false; } });
    }, MONTHS_PATCH_DELAY_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patch.mutate ثابتٌ وظيفياً؛ الحالة المعتبرة في الاعتماديات
  }, [monthsShown, choice.months, view, env.busy, patch.isPending]);

  const startEdit = () => { setForm(formOf(view)); setFieldErr(null); setEditing(true); setErr(null); };
  const cancelEdit = () => { setForm(formOf(view)); setFieldErr(null); setEditing(false); };
  const saveEdit = () => {
    const r = patchOf(form, view, { decimals, taxOff: env.taxOff });
    if (!r.ok) { setFieldErr({ field: r.field, text: docFormProblemText(r.problem, tr) }); return; }
    setFieldErr(null);
    if (!Object.keys(r.patch).length) { setEditing(false); return; }
    patch.mutate(r.patch, { onSuccess: () => setEditing(false) });
  };

  // العرض الذي تُحسب عليه الضغطة: رفض «يشبه مستنداً مسجلاً» يَسِمه بالتكرار فيُتاح «ليست مكررة — سجّلها»
  const eff = withRefusalDuplicate(view, refusal);
  const send = (over: Partial<DocChoice> = {}, notDuplicate = false) => {
    if (env.busy) return;
    const c = { ...choice, ...over };
    if (confirmBlocker(eff, c, { ...opts, editing, notDuplicate })) return;
    const cc = confirmChoiceOf(eff, c, notDuplicate);
    const msg = cc && docConfirmMessage(eff, cc, tr, { taxOff: env.taxOff, decimals });
    if (msg) env.onConfirm(msg);
  };

  const blocker = confirmBlocker(eff, choice, { ...opts, editing });
  // التكرار وحده يمنع ⇒ زرّ «ليست مكررة — سجّلها» بدل «سجّل القيد»، وما يمنعه هو بعد التجاوز
  const duplicate = blocker === 'DUPLICATE';
  const shownBlocker = duplicate ? confirmBlocker(eff, choice, { ...opts, editing, notDuplicate: true }) : blocker;
  // منبّهات الاقتراح (ضريبة الضيافة) وملاحظة الضريبة لحكم الحساب المختار — لا لاقتراحٍ عدل عنه المستخدم
  const checks = visibleChecks(view.checks, env.taxOff, { suggestionChosen: choiceIsSuggestion(view, choice) });
  const states = treatmentStates(view, opts);
  const accounts = accountsFor(view, choice.treatment);
  const payOptions = visiblePayOptions(view);
  const source = factsSourceLabel(view.factsSource, env.taxOff, tr);
  const dup = duplicateText(eff.duplicateOf, tr);
  const vatNote = vatModeText(chosenVatMode(view, choice), env.taxOff, tr);
  const amort = choice.treatment === 'PREPAID' ? amortizationOf(view, choice) : null;
  const category: DocCategoryChip = categoryChipOf(view.facts);
  const referral = docReferral(view.facts);
  const money = (s: string | null | undefined) => (s && Number.isFinite(Number(s)) ? formatCurrency(Number(s), env.currency) : null);
  const thresholdText = formatCurrency(opts.assetThreshold, env.currency);
  const assetState = states.find(s => s.treatment === 'ASSET');
  const f = view.facts;
  const pad = compact ? 'px-3' : 'px-4';
  const label = 'block text-[11px] font-medium text-[#6E6557] mb-0.5';
  const inputCls = 'input !py-1.5 text-base sm:text-sm';

  const field = (k: FactsField, name: string, input: ReactNode, hint?: ReactNode) => (
    <div className="min-w-0">
      <label htmlFor={`${uid}-${k}`} className={label}>{name}</label>
      {input}
      {fieldErr?.field === k ? <p className="text-[11px] text-[#C0392B] mt-0.5">{fieldErr.text}</p> : hint}
    </div>
  );
  const input = (k: FactsField, extra: InputHTMLAttributes<HTMLInputElement>) => (
    <input
      id={`${uid}-${k}`}
      value={form[k]}
      disabled={saving}
      autoComplete="off"
      onChange={(e) => { const v = e.target.value; setForm(s => ({ ...s, [k]: v })); if (fieldErr?.field === k) setFieldErr(null); }}
      className={inputCls}
      {...extra}
    />
  );
  const amountInput = (k: FactsField) => input(k, { type: 'text', dir: 'ltr', inputMode: 'decimal' });
  /** شريحةٌ في مجموعة اختيارٍ واحد (النوع، التصنيف، فئة الأصل) — المضيئة لا تُعطَّل */
  const chip = (key: string, on: boolean, text: string, onPick: () => void) => (
    <button key={key} type="button" role="radio" aria-checked={on} onClick={onPick} disabled={locked && !on}
      className={`shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${on ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E0D7C6] hover:border-[#E15A30] hover:text-[#E15A30]'} disabled:opacity-50`}>
      {text}
    </button>
  );
  const chipRow = `flex gap-1.5 ${compact ? 'overflow-x-auto pb-0.5' : 'flex-wrap'}`;

  return (
    <section data-doc-id={view.id} aria-label={`${tr('المستند')} ${view.fileName}`}
      className="rounded-2xl border border-[#E9E1D3] bg-white overflow-hidden shadow-sm">
      {/* الرأس: الاسم والحالة والمصدر، وعرض المستند وتعديله */}
      <div className={`${pad} py-2.5 bg-[#FAF7F0] border-b border-[#F1EBDF] flex items-start gap-2`}>
        <FileText size={18} className="text-[#E15A30] mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-[#1F1A13] truncate" dir="auto"><bdi>{view.fileName || tr('المستند')}</bdi></p>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${docStateTone(state)}`}>{docStateLabel(state, tr)}</span>
            {source && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-white border border-[#E9E1D3] text-[#6E6557]">
                {view.qrVerified && !env.taxOff && <QrCode size={10} />} {source}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => env.onOpen(view)} disabled={state === 'gone'}
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg text-[#6E6557] hover:bg-[#F1EBDF] hover:text-[#E15A30] disabled:opacity-40">
            <Eye size={13} /> {tr('عرض')}
          </button>
          {!live && !editing && state !== 'gone' && (
            <button type="button" onClick={startEdit} disabled={locked}
              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg text-[#6E6557] hover:bg-[#F1EBDF] hover:text-[#E15A30] disabled:opacity-40">
              <Pencil size={12} /> {tr('تعديل')}
            </button>
          )}
        </div>
      </div>

      <div className={`${pad} py-3 space-y-3`}>
        {/* مرحَّل أو معكوس */}
        {view.posted && (
          <p className={`flex items-start gap-1.5 text-xs rounded-lg px-2.5 py-1.5 border ${live ? 'bg-[#E4F1EA] text-[#1E7A52] border-[#C6E3D2]' : 'bg-[#F1EBDF] text-[#6E6557] border-[#E0D7C6]'}`}>
            {live ? <BookOpenCheck size={13} className="shrink-0 mt-0.5" /> : <Undo2 size={13} className="shrink-0 mt-0.5" />}
            <span>
              {live
                ? tr('سُجّل في القيد {n}').replace('{n}', view.posted.moveNumber ?? '—')
                : tr('عُكس القيد {n} — يمكن تسجيل المستند من جديد').replace('{n}', view.posted.moveNumber ?? '—')}
            </span>
          </p>
        )}

        {/* نوع المستند — يختاره المستخدم، والخادم يعيد الاقتراح */}
        <div>
          <p className={label}>{tr('نوع المستند')}</p>
          <div className={chipRow} role="radiogroup" aria-label={tr('نوع المستند')}>
            {docTypeChips(env.taxOff).map((t) =>
              chip(t, chipSelected(t, f?.docType ?? null, env.taxOff), docTypeLabelFor(t, env.taxOff, tr), () => pickType(t)))}
          </div>
        </div>

        {/* التصنيف (D3): مصروف أو خدمة / أصل ثابت وفئته / بضاعة للبيع — البضاعة لمشتريات المستودع، والأرض والمبنى للمحاسب البشري */}
        <div>
          <p className={label}>{tr('تصنيف المستند')}</p>
          <div className={chipRow} role="radiogroup" aria-label={tr('تصنيف المستند')}>
            {DOC_CATEGORY_CHIPS.map((c) => chip(c, category === c, categoryChipLabel(c, tr), () => pickHint(categoryChipPatch(c, f))))}
          </div>
          {category === 'FIXED_ASSET' && (
            <div className="mt-2">
              <p className={label}>{tr('نوع الأصل')}</p>
              <div className={chipRow} role="radiogroup" aria-label={tr('نوع الأصل')}>
                {ASSET_CLASS_ORDER.map((a: AcctAssetClass) =>
                  chip(a, f?.assetClassHint === a, assetClassLabel(a, tr), () => pickHint(assetClassPatch(a, f))))}
              </div>
            </div>
          )}
          {referral && !live && (
            <p role="status" className="mt-2 flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border bg-[#FDF1EE] text-[#8E2B1F] border-[#F3C9BF]">
              <CircleAlert size={12} className="shrink-0 mt-0.5" /> <span>{blockerText(referral, tr)}</span>
            </p>
          )}
        </div>

        {/* الحقائق: عرضٌ أو إدخال */}
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} noValidate className="space-y-2.5">
            {view.manualEntry && !view.factsSource && (
              <p className="flex items-start gap-1.5 text-[11px] text-[#6E6557] bg-[#FAF7F0] border border-[#F1EBDF] rounded-lg px-2.5 py-1.5">
                <Info size={13} className="shrink-0 mt-0.5" />
                <span>{env.taxOff ? tr('اكتب بيانات المستند كما هي فيه') : tr('لم يُقرأ رمز QR — اكتب بيانات المستند كما هي فيه')}</span>
              </p>
            )}
            <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {field('vendorName', tr('المورد'), input('vendorName', { type: 'text', dir: 'auto', maxLength: 120 }))}
              {!env.taxOff && field('vendorVat', tr('الرقم الضريبي للمورد'),
                input('vendorVat', { type: 'text', dir: 'ltr', inputMode: 'numeric', maxLength: 20 }),
                vendorVatOdd(form.vendorVat) ? <p className="text-[11px] text-[#8A6A12] mt-0.5">{tr('رقم ضريبي غير صحيح — لن تخصم الضريبة')}</p> : undefined)}
              {field('invoiceNo', tr('رقم الفاتورة'), input('invoiceNo', { type: 'text', dir: 'auto', maxLength: 60 }))}
              {field('issueDate', tr('تاريخ المستند'), input('issueDate', { type: 'date', max: env.todayLocal || undefined }))}
              {(f?.docType === 'LEASE_CONTRACT' || choice.treatment === 'PREPAID' || form.periodFrom || form.periodTo) && (
                <>
                  {field('periodFrom', tr('الفترة من'), input('periodFrom', { type: 'date' }))}
                  {field('periodTo', tr('الفترة إلى'), input('periodTo', { type: 'date', min: form.periodFrom || undefined }))}
                </>
              )}
              {!env.taxOff && field('subtotal', tr('المبلغ قبل الضريبة'), amountInput('subtotal'))}
              {!env.taxOff && field('vatAmount', tr('الضريبة'), amountInput('vatAmount'))}
              {field('total', tr('الإجمالي'), amountInput('total'))}
            </div>
            {!env.taxOff && sumMismatch(form, decimals) && (
              <p className="text-[11px] text-[#8A6A12] flex items-start gap-1"><AlertTriangle size={12} className="shrink-0 mt-0.5" />{docCheckText('SUM_MISMATCH', tr)}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="submit" disabled={saving} className="btn-primary !px-3 !py-1.5 !text-xs disabled:opacity-50">
                {saving && <Loader2 size={13} className="animate-spin" />} {tr('حفظ')}
              </button>
              {view.factsSource && (
                <button type="button" onClick={cancelEdit} disabled={saving} className="btn-secondary !px-3 !py-1.5 !text-xs disabled:opacity-50">{tr('إلغاء')}</button>
              )}
            </div>
          </form>
        ) : (
          <dl className={`grid gap-x-3 gap-y-1.5 text-[12px] ${compact ? 'grid-cols-[auto,1fr]' : 'grid-cols-[auto,1fr,auto,1fr]'}`}>
            <Fact k={tr('المورد')} v={f?.vendorName} />
            {!env.taxOff && <Fact k={tr('الرقم الضريبي')} v={f?.vendorVat} ltr />}
            <Fact k={tr('رقم الفاتورة')} v={f?.invoiceNo} ltr />
            <Fact k={tr('التاريخ')} v={f?.issueDate ? formatDayOnly(f.issueDate) : null} />
            {(f?.periodFrom || f?.periodTo) && (
              <Fact k={tr('الفترة')} v={`${f?.periodFrom ? formatDayOnly(f.periodFrom) : '—'} – ${f?.periodTo ? formatDayOnly(f.periodTo) : '—'}`} />
            )}
            {!env.taxOff && <Fact k={tr('المبلغ قبل الضريبة')} v={money(f?.subtotal)} num />}
            {!env.taxOff && <Fact k={tr('الضريبة')} v={money(f?.vatAmount)} num />}
            <Fact k={tr('الإجمالي')} v={money(f?.total)} num strong />
          </dl>
        )}

        {/* الفحوص: الأحمر يمنع، والكهرماني ينبّه */}
        {(checks.length > 0 || dup) && (
          <ul className="space-y-1">
            {checks.map((c) => (
              <li key={c.code} className={`flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border ${c.severity === 'block' ? 'bg-[#FDF1EE] text-[#8E2B1F] border-[#F3C9BF]' : 'bg-[#FAEFD8] text-[#8A6A12] border-[#F0DDB0]'}`}>
                {c.severity === 'block' ? <CircleAlert size={12} className="shrink-0 mt-0.5" /> : <AlertTriangle size={12} className="shrink-0 mt-0.5" />}
                <span>{docCheckText(c.code, tr, c.details)}</span>
              </li>
            ))}
            {dup && (
              <li className="flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border bg-[#FAEFD8] text-[#8A6A12] border-[#F0DDB0]">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" /> <span>{dup}</span>
              </li>
            )}
          </ul>
        )}

        {/* المعالجة والحساب و«مدفوع من» — لغير المرحَّل الحيّ */}
        {!live && state !== 'gone' && (
          <div className="space-y-2.5 pt-2 border-t border-[#F6F1E7]">
            <div>
              <p className={label}>{tr('المعالجة')}</p>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={tr('المعالجة')}>
                {states.map((s) => {
                  const on = choice.treatment === s.treatment;
                  return (
                    <button key={s.treatment} type="button" role="radio" aria-checked={on} disabled={!s.allowed || env.busy}
                      title={treatmentReasonText(s.reason, thresholdText, tr) ?? undefined}
                      onClick={() => setChoice(c => withTreatment(view, c, s.treatment))}
                      className={`text-[11px] font-semibold px-1.5 py-1.5 rounded-lg border leading-tight transition-colors ${on ? 'bg-[#FDECE6] text-[#B8461F] border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E0D7C6] hover:border-[#E15A30]'} disabled:opacity-40 disabled:hover:border-[#E0D7C6]`}>
                      {treatmentLabel(s.treatment, tr)}
                    </button>
                  );
                })}
              </div>
              {assetState?.reason === 'BELOW_THRESHOLD' && (
                <p className="text-[10px] text-[#9A8F7E] mt-1">{treatmentReasonText(assetState.reason, thresholdText, tr)}</p>
              )}
            </div>

            {monthsShown && (
              <div>
                <label htmlFor={`${uid}-months`} className={label}>{tr('عدد الأشهر')}</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input id={`${uid}-months`} type="number" inputMode="numeric" min={1} max={PREPAID_MAX_MONTHS} step={1} dir="ltr"
                    value={choice.months ?? ''} disabled={env.busy}
                    onChange={(e) => {
                      const n = e.target.value === '' ? null : Math.trunc(Number(e.target.value));
                      setChoice(c => ({ ...c, months: n !== null && Number.isFinite(n) ? n : null }));
                    }}
                    className={`${inputCls} !w-24`} />
                  {saving && <Loader2 size={13} className="animate-spin text-[#9A8F7E]" />}
                  {choice.treatment === 'PREPAID' && (
                    <span className="text-[11px] text-[#6E6557] flex items-center gap-1"><CalendarClock size={12} /> {tr('يطفأ آخر كل شهر بقسط ثابت')}</span>
                  )}
                </div>
                {amort && (
                  <p className="text-[11px] text-[#6E6557] mt-1">
                    {tr('يُطفأ شهرياً على حساب {account}').replace('{account}', `${amort.code} ${amort.name}`.trim())}
                  </p>
                )}
              </div>
            )}

            {choice.treatment === 'ASSET' && (
              <p className="flex items-start gap-1.5 text-[11px] text-[#8A6A12] bg-[#FAEFD8] border border-[#F0DDB0] rounded-lg px-2.5 py-1.5">
                <Package size={12} className="shrink-0 mt-0.5" /> <span>{tr('يحتاج إهلاكاً يسجّله المحاسب')}</span>
              </p>
            )}

            <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div className="min-w-0">
                <label htmlFor={`${uid}-acct`} className={label}>{tr('الحساب')}</label>
                <select id={`${uid}-acct`} value={choice.accountCode} disabled={env.busy || !accounts.length}
                  onChange={(e) => { const v = e.target.value; setChoice(c => ({ ...c, accountCode: v })); }} className={inputCls}>
                  {!accounts.length && <option value="">{tr('اختر')}</option>}
                  {accounts.map(a => <option key={a.code} value={a.code}>{`${a.code} ${a.name}`.trim()}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor={`${uid}-pay`} className={label}>{tr('مدفوع من')} <span className="text-[#C0392B]" aria-hidden>*</span></label>
                <select id={`${uid}-pay`} value={choice.pay} required aria-required disabled={env.busy}
                  onChange={(e) => { const v = e.target.value; setChoice(c => ({ ...c, pay: v })); }}
                  className={`${inputCls} ${choice.pay ? '' : 'text-[#9A8F7E]'}`}>
                  <option value="">{tr('اختر')}</option>
                  {payOptions.map(o => <option key={payValue(o)} value={payValue(o)}>{payOptionLabel(o, tr)}</option>)}
                </select>
              </div>
            </div>
            {vatNote && <p className="text-[10px] text-[#9A8F7E]">{vatNote}</p>}
          </div>
        )}

        {/* رفض الترحيل الأخير */}
        {refusal && !live && (
          <div role="alert" className="rounded-lg border border-[#F3C9BF] bg-[#FDF1EE] text-[#8E2B1F] text-xs px-2.5 py-2 space-y-1.5">
            <p className="flex items-start gap-1.5"><CircleAlert size={13} className="shrink-0 mt-0.5" /> <span dir="auto">{docRefusalText(refusal, tr)}</span></p>
            {refusal.code === 'LEDGER_PERIOD_LOCKED' && env.todayLocal && (
              <button type="button" onClick={() => send({ date: env.todayLocal })}
                disabled={env.busy || !!confirmBlocker(eff, { ...choice, date: env.todayLocal }, { ...opts, editing })}
                className="ms-5 inline-flex items-center gap-1 font-semibold text-[#C94E28] hover:text-[#E15A30] disabled:opacity-50">
                <BookOpenCheck size={12} /> {tr('سجّل بتاريخ اليوم')}
              </button>
            )}
          </div>
        )}
        {err && <p role="alert" className="text-[11px] text-[#C0392B]">{err}</p>}

        {/* الأزرار: «سجّل القيد» (أو «ليست مكررة — سجّلها») و«حذف» */}
        {!live && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {state !== 'gone' && (duplicate ? (
              <button type="button" onClick={() => send({}, true)} disabled={env.busy || shownBlocker !== null}
                className="btn-primary !px-3.5 !py-1.5 !text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                {confirming ? <Loader2 size={13} className="animate-spin" /> : <BookOpenCheck size={13} />} {tr('ليست مكررة — سجّلها')}
              </button>
            ) : (
              <button type="button" onClick={() => send()} disabled={env.busy || blocker !== null}
                className="btn-primary !px-3.5 !py-1.5 !text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                {confirming ? <Loader2 size={13} className="animate-spin" /> : <BookOpenCheck size={13} />} {tr('سجّل القيد')}
              </button>
            ))}
            {!view.posted && (
              <button type="button" disabled={del.isPending || env.busy}
                onClick={() => (armed ? del.mutate() : setArmed(true))}
                onBlur={() => setArmed(false)}
                className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg disabled:opacity-50 ${armed ? 'bg-[#C0392B] text-white' : 'text-[#C0392B] hover:bg-[#FDF2F0]'}`}>
                {del.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} {armed ? tr('تأكيد الحذف') : tr('حذف')}
              </button>
            )}
            {/* سبب التعطيل — والتصنيف الذي لا يُرحَّل من هنا مقولٌ تحت شرائحه بالأحمر */}
            {shownBlocker && !editing && shownBlocker !== referral && (
              <span className="text-[11px] text-[#9A8F7E] ms-auto">{blockerText(shownBlocker, tr)}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** صفّ حقيقة: الاسم ثم القيمة (الغائبة «—») */
function Fact({ k, v, ltr = false, num = false, strong = false }: { k: string; v: string | null | undefined; ltr?: boolean; num?: boolean; strong?: boolean }) {
  return (
    <>
      <dt className="text-[#9A8F7E] whitespace-nowrap">{k}</dt>
      <dd className={`min-w-0 break-words ${strong ? 'font-bold text-[#1F1A13]' : 'text-[#1F1A13]'} ${num ? 'tabular-nums' : ''}`}>
        {v ? (ltr ? <bdi dir="ltr">{v}</bdi> : <bdi>{v}</bdi>) : <span className="text-[#C9BFAE]">—</span>}
      </dd>
    </>
  );
}

/**
 * المستند في فقاعةٍ ليست صاحبة بطاقته (ظهر بعدها في ردٍّ أحدث، أو ردّ «رُحّل»): سطرٌ مختصر بحالته يفتح المستند — البطاقة
 * الحيّة في مكانها الواحد (cardOwners).
 */
export function DocCardStub({ view, onOpen }: { view: AcctDocView; onOpen: (d: ViewerDoc) => void }) {
  const tr = useTr();
  const state = docState(view);
  return (
    <button type="button" onClick={() => onOpen(view)}
      className="w-full flex items-center gap-2 rounded-xl border border-[#E9E1D3] bg-white px-3 py-2 text-start hover:bg-[#FAF7F0]">
      <FileText size={15} className="text-[#E15A30] shrink-0" />
      <span className="min-w-0 flex-1 text-xs text-[#1F1A13] truncate" dir="auto"><bdi>{view.fileName || tr('المستند')}</bdi></span>
      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${docStateTone(state)}`}>{docStateLabel(state, tr)}</span>
    </button>
  );
}

/** مستندٌ حُذف من هذه المحادثة */
export function DocCardDeleted({ fileName }: { fileName: string }) {
  const tr = useTr();
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-[#E0D7C6] px-3 py-2 text-xs text-[#9A8F7E]">
      <Trash2 size={13} className="shrink-0" />
      <span className="min-w-0 truncate" dir="auto"><bdi>{fileName}</bdi></span>
      <span className="shrink-0">— {tr('حُذف المستند')}</span>
    </p>
  );
}
