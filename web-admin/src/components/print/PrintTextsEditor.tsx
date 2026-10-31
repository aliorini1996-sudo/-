import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Eye, EyeOff, Info, Languages, Lock, RotateCcw, Save, X } from 'lucide-react';
import { companyApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { useDir } from '../../i18n/lang';
import {
  PRINT_SECOND_LANGS, PRINT_TEXT_CATALOG, PRINT_TEXTS_ISSUES, PRINT_TEXTS_LIMITS, SECOND_LANG_NAMES,
  canonicalPrintTexts, checkPrintTexts, emptyPrintTexts, isEmptyPrintTexts, normalizePrintTexts, phraseIn,
  printTextAltEditable, printTextEntry, printTextHideable, printTextRewordable, printTextsBytes,
  type PrintSecondLang, type PrintTextEdit, type PrintTextEntry, type PrintTextGroup, type PrintTextLock, type PrintTextsIssue,
  type PrintTextsV1,
} from '../../lib/print/printTexts';
import { COMPANY_SETTINGS_MISSING_MSG, PRINT_SAMPLE_WATERMARK } from '../../lib/print/printSettings';
import { isZatcaPhase2Live } from '../../lib/zatcaRegime';
import { PrintableInvoice, PrintableReceipt, type Company, type DocCustomer, type InvoiceDoc, type ReceiptDoc } from '../../rep/RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, SHEET_WIDTH_PX } from '../../rep/printLook';
import { PrintTextsPreviewContext } from '../../rep/printTextsContext';
import { thermalPreviewHtml } from '../../rep/thermal';
import type { PrintTextsCompany } from './PrintTextsCard';

/**
 * محرّر «نصوص المطبوعات» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — نافذةٌ كاملة ببوابة إلى document.body (البطاقة داخل نموذج الإعدادات
 * العامة: Enter هنا لا يُرسله، ولا نموذج (form) في المحرّر يصعد حدث إرساله في شجرة React إليه).
 *
 * المعاينة هي القالب الحقيقي نفسه (PrintableInvoice / PrintableReceipt) بمستندٍ نموذجيّ من المرحلة الأولى (بلا zatca فيظهر أثر
 * تعديل العنوان) وعليه مسودة الشركة — ملفوفاً بـPrintTextsPreviewContext: كل نصٍّ في القائمة قابلٌ للنقر فيُختار صفّه، والمخفيّ
 * باهتٌ مشطوب لا غائب. والحرارية (58/80 مم) وثيقة القالب الحراريّ نفسها في iframe للعرض فقط.
 *
 * مسودةٌ محلية واحدة تُحفظ بزرّ واحد (PUT /company/print-texts) بعد فحص الخادم نفسه (checkPrintTexts صارماً، النسخة الحرفية) —
 * والحفظ يُبطل ['company'] لأن جهاز المندوب والقوالب تقرأ العمود من ردّ /company. «استعادة النصوص الافتراضية» تُرسل الإعادة فوراً.
 */

type Tr = (ar: string) => string;
type DocTab = 'invoice' | 'receipt';
type Paper = 'a4' | '58' | '80';

/** المستند النموذجي — ما يحتاجه لإظهار كل نصّ (المرتجع، والقياسية، والأقساط، والأسعار الشاملة، وفواتير السند) */
interface Sample { isReturn: boolean; standard: boolean; inclusive: boolean; installments: boolean; links: 'one' | 'many' }
const SAMPLE0: Sample = { isReturn: false, standard: false, inclusive: true, installments: false, links: 'many' };

/** ما يلزم المستند النموذجي ليظهر النصّ المختار من القائمة — نصٌّ لا يظهر في المعاينة الحالية يُظهِره اختياره */
function sampleFor(key: string, s: Sample): Sample {
  let n: Partial<Sample> = {};
  switch (key) {
    case 'inv.returnTitle': case 'inv.returnInfoHeading': case 'inv.returnNumber': case 'tot.returnGrand':
      n = { isReturn: true }; break;
    case 'inv.title': case 'inv.infoHeading': case 'inv.number': case 'inv.type': case 'tot.paid': case 'tot.remaining':
      n = { isReturn: false }; break;
    case 'inst.heading': case 'inst.dueDate': case 'inst.amount': case 'inst.sum': case 'inst.note':
      n = { isReturn: false, installments: true }; break;
    case 'cust.taxNumber': n = { standard: true }; break;
    case 'item.beforeTax': n = { standard: true, inclusive: true }; break;
    case 'col.priceIncl': case 'tot.vatIncl': case 'note.pricesIncl': n = { inclusive: true }; break;
    case 'col.price': case 'tot.vat': n = { inclusive: false }; break;
    case 'rcp.forInvoice': n = { links: 'one' }; break;
    case 'rcp.forInvoices': case 'rcp.invoiceNo': case 'rcp.credit': n = { links: 'many' }; break;
    default: return s;
  }
  const next = { ...s, ...n };
  return (Object.keys(n) as (keyof Sample)[]).every((k) => next[k] === s[k]) ? s : next;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const DAY = 86_400_000;

/** البائع: بيانات الشركة المحفوظة، وما ينقص منها بقيمةٍ توضيحية (كـsampleInvoiceDoc) فيظهر كل سطرٍ في الترويسة */
function sampleCompany(company: PrintTextsCompany, tr: Tr, texts: PrintTextsV1 | null): Company {
  const c: Partial<Company> = company ?? {};
  return {
    ...c,
    name: c.name || tr('اسم الشركة'),
    taxNumber: c.taxNumber || '300000000000003',
    commercialReg: c.commercialReg || '1010000000',
    address: c.address || tr('الرياض - حي العليا'),
    phone: c.phone || '0110000000',
    email: c.email || 'info@example.com',
    printSettings: undefined,
    printTexts: texts,
  };
}

function sampleCustomer(tr: Tr, withTax: boolean): DocCustomer {
  return {
    name: tr('عميل تجريبي'), businessName: tr('مؤسسة تجريبية'), commercialReg: '4030000000', phone: '0500000000',
    address: tr('جدة - حي الروضة'), ...(withTax ? { taxNumber: '310000000000003' } : {}),
  };
}

/** فاتورة آجلة بثلاثة أصناف (أحدها بخصم) ومدفوعٍ ومتبقٍّ — أو مرتجع، أو تقسيط. المبالغ متّسقة بالشامل وغير الشامل */
function sampleInvoice(company: Company, tr: Tr, s: Sample, now: Date): InvoiceDoc {
  const unit = tr('حبة');
  const item = (n: number, qty: number, incl: number, discountPct: number) => {
    const unitPrice = s.inclusive ? incl : r2(incl / 1.15);
    return { name: `${tr('صنف تجريبي')} ${n}`, unit, qty, unitPrice, discountPct, taxPct: 15, lineTotal: r2(qty * unitPrice * (1 - discountPct / 100)) };
  };
  const base = {
    kind: 'invoice' as const, date: now.toISOString(), company, customer: sampleCustomer(tr, s.standard),
    repName: tr('مندوب تجريبي'), pricesIncludeTax: s.inclusive,
  };
  if (s.isReturn) {
    return { ...base, number: 'RET-0031', type: 'CASH', isReturn: true, items: [item(1, 1, 28.75, 0), item(2, 1, 57.5, 0)], subtotal: 75, discount: 0, tax: 11.25, total: 86.25 };
  }
  const plan = s.installments;
  return {
    ...base, number: 'INV-1024', type: 'CREDIT', deliveryDate: new Date(now.getTime() + DAY).toISOString(),
    items: [item(1, 2, 28.75, 0), item(2, 1, 57.5, 10), item(3, 3, 11.5, 0)],
    subtotal: 130, discount: 5, tax: 18.75, total: 143.75,
    paidAmt: plan ? 0 : 50, remainingAmt: plan ? 143.75 : 93.75,
    ...(plan ? {
      paymentPlan: 'INSTALLMENT' as const,
      installments: [
        { seq: 1, dueDate: new Date(now.getTime() + 30 * DAY).toISOString(), amount: 71.88 },
        { seq: 2, dueDate: new Date(now.getTime() + 60 * DAY).toISOString(), amount: 71.87 },
      ],
    } : {}),
  };
}

/** سند قبض مقابل فاتورةٍ واحدة، أو فاتورتين وفائضٍ رصيداً دائناً */
function sampleReceipt(company: Company, tr: Tr, s: Sample, now: Date): ReceiptDoc {
  const one = s.links === 'one';
  return {
    kind: 'receipt', number: 'RCP-0207', date: now.toISOString(), company, customer: sampleCustomer(tr, true),
    repName: tr('مندوب تجريبي'), amount: one ? 143.75 : 300, paymentMethod: 'CASH', notes: tr('ملاحظة تجريبية'),
    invoices: one ? [{ number: 'INV-1024', amount: 143.75 }] : [{ number: 'INV-1024', amount: 143.75 }, { number: 'INV-1019', amount: 106.25 }],
  };
}

/** عناوين المجموعات — «عنوان المستند» لا «العنوان» (هذه في القاموس «Address») */
const GROUP_TITLES: Readonly<Record<PrintTextGroup, string>> = Object.freeze({
  header: 'الترويسة', title: 'عنوان المستند', info: 'بيانات المستند', customer: 'العميل', items: 'الأصناف',
  totals: 'الإجماليات', installments: 'الأقساط', amount: 'المبلغ', footer: 'التذييل والتوقيعات',
});
const GROUP_ORDER: Readonly<Record<DocTab, readonly PrintTextGroup[]>> = Object.freeze({
  invoice: ['header', 'title', 'info', 'customer', 'items', 'totals', 'installments', 'footer'],
  receipt: ['header', 'title', 'info', 'amount', 'customer', 'footer'],
});
/** لماذا لا يُخفى النصّ */
const LOCK_REASONS: Readonly<Partial<Record<PrintTextLock, string>>> = Object.freeze({
  zatca: 'إلزامي في الفاتورة الضريبية', fixed: 'عبارة ضريبية بصياغتها', shape: 'جزء من هيكل المستند',
});
const STANDARD_HINT = 'يبقى ظاهراً على الفاتورة الضريبية القياسية';
const TITLE_WARNING = 'المنشأة المسجلة في ضريبة القيمة المضافة يلزمها نظاما عنوان «فاتورة ضريبية» — غيره أو أخفه فقط إن لم تكن منشأتك مسجلة';
const PHASE2_TITLE_NOTE = 'الفواتير المختومة من المرحلة الثانية تطبع عنوان الهيئة كما هو';
/** تسمية الصفّ — «اسم الشركة في التذييل» قيمةٌ لا تسمية فنصّه في القائمة وصفُه */
const rowLabel = (entry: PrintTextEntry, tr: Tr): string => tr(entry.ar);

/** نصوص القائمة لتبويب المستند بترتيب الورقة: مجموعاته، وفي كلٍّ نصوص المستند قبل المشتركة (التوقيعات قبل سطر الشكر) */
function groupsFor(tab: DocTab): { group: PrintTextGroup; entries: PrintTextEntry[] }[] {
  const mine = PRINT_TEXT_CATALOG.filter((e) => e.doc === tab || e.doc === 'shared');
  return GROUP_ORDER[tab]
    .map((group) => {
      const inGroup = mine.filter((e) => e.group === group);
      return { group, entries: [...inGroup.filter((e) => e.doc !== 'shared'), ...inGroup.filter((e) => e.doc === 'shared')] };
    })
    .filter((g) => g.entries.length > 0);
}

/** رسالة رفض الحفظ (عربية، تُعرض بـtr) — رسائل القائمة المغلقة وحدها، وإلا العامة */
function saveErrorMessage(err: unknown): string {
  const r = (err as { response?: { status?: number; data?: { code?: string; message?: string } } } | null)?.response;
  if (r?.data?.code === 'COMPANY_SETTINGS_MISSING') return COMPANY_SETTINGS_MISSING_MSG;
  if (r?.data?.code === 'PRINT_TEXTS_TOO_LARGE' || r?.status === 413) return PRINT_TEXTS_ISSUES.tooLarge;
  const m = r?.data?.message;
  if (typeof m === 'string' && (Object.values(PRINT_TEXTS_ISSUES) as string[]).includes(m)) return m;
  return 'حدث خطأ في الحفظ';
}

function serverIssuesOf(err: unknown): PrintTextsIssue[] {
  const issues = (err as { response?: { data?: { issues?: unknown } } } | null)?.response?.data?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((i): i is PrintTextsIssue => !!i && typeof i.path === 'string' && typeof i.message === 'string');
}

/** مفتاح النصّ من مسار السبب (edits.inv.title.text ⇒ inv.title) أو null */
function issueKey(path: string): string | null {
  return path.startsWith('edits.') ? path.slice('edits.'.length).replace(/\.(text|alt|hidden)$/, '') : null;
}

const NO_EDIT: PrintTextEdit = Object.freeze({ text: null, alt: null, hidden: false });
const isBlank = (s: string | null): boolean => s === null || s === '';

export default function PrintTextsEditor({ company, onClose }: { company: PrintTextsCompany; onClose: () => void }) {
  const tr = useTr();
  const dir = useDir();
  const qc = useQueryClient();
  const [initial, setInitial] = useState<PrintTextsV1>(() => normalizePrintTexts(company?.printTexts) ?? emptyPrintTexts());
  const [draft, setDraft] = useState<PrintTextsV1>(initial);
  const [stored, setStored] = useState(() => normalizePrintTexts(company?.printTexts) !== null);
  const [serverIssues, setServerIssues] = useState<PrintTextsIssue[]>([]);
  const [tab, setTab] = useState<DocTab>('invoice');
  const [paper, setPaper] = useState<Paper>('a4');
  const [sample, setSample] = useState<Sample>(SAMPLE0);
  const [active, setActive] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const lastLang = useRef<PrintSecondLang>(initial.secondLang ?? 'en');
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const dialogRef = useRef<HTMLDivElement>(null);
  /** المسودة التي أُرسلت — الردّ لا يمحو ما كُتب بعدها أثناء الحفظ */
  const sentRef = useRef<PrintTextsV1 | null>(null);
  const phase2Live = isZatcaPhase2Live(company);

  const dirty = useMemo(() => JSON.stringify(canonicalPrintTexts(draft)) !== JSON.stringify(canonicalPrintTexts(initial)), [draft, initial]);
  // فحص الخادم نفسه (صارماً) وحدّ الحجم — والخادم يعيد الفحص عند الحفظ
  const issues = useMemo<PrintTextsIssue[]>(() => {
    const r = checkPrintTexts(draft, true);
    const out = r.ok ? [] : [...r.issues];
    if (printTextsBytes(draft) > PRINT_TEXTS_LIMITS.maxBytes) out.push({ path: '', message: PRINT_TEXTS_ISSUES.tooLarge });
    return [...out, ...serverIssues];
  }, [draft, serverIssues]);
  const valid = issues.length === 0;
  const issuesAt = (prefix: string): PrintTextsIssue[] => issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));

  // المعاينة: المسودة بالقراءة المتسامحة (نصٌّ نصف مكتوب يُعايَن)، وnull ⇒ نصوص اليوم كما تطبعها شركةٌ بلا تعديل
  const texts = useMemo(() => normalizePrintTexts(draft), [draft]);
  const docCompany = useMemo(() => sampleCompany(company, tr, texts), [company, tr, texts]);
  const invoiceDoc = useMemo(() => sampleInvoice(docCompany, tr, sample, now), [docCompany, tr, sample, now]);
  const receiptDoc = useMemo(() => sampleReceipt(docCompany, tr, sample, now), [docCompany, tr, sample, now]);
  const groups = useMemo(() => groupsFor(tab), [tab]);
  const tabKeys = useMemo(() => new Set(groups.flatMap((g) => g.entries.map((e) => e.key))), [groups]);

  const save = useMutation({
    // null = «استعادة النصوص الافتراضية» (العمود null حرفياً)
    mutationFn: (v: PrintTextsV1 | null) => companyApi.printTexts.put(v),
    onSuccess: (res, sent) => {
      const body = res.data as { data?: unknown; stored?: boolean };
      const saved = normalizePrintTexts(body.data ?? null) ?? emptyPrintTexts();
      setInitial(saved);
      setDraft((d) => (d === sentRef.current ? saved : d));
      if (saved.secondLang) lastLang.current = saved.secondLang;
      setStored(body.stored === true);
      setServerIssues([]);
      // الصفّ المحفوظ في ذاكرة ['company'] فوراً (كما يعيده GET: null للاستعادة أو الفارغ) — فالبطاقة وفتحُ المحرّر ثانيةً قبل اكتمال
      // إعادة الجلب يقرآن ما حُفظ لا ما قبله، ولا يكتب حفظٌ تالٍ «القديم + التعديل» فوقه
      qc.setQueryData(['company'], (old: Record<string, unknown> | null | undefined) =>
        old ? { ...old, printTexts: body.stored === true ? body.data ?? null : null } : old);
      qc.invalidateQueries({ queryKey: ['company'] });
      toast.success(sent === null ? tr('تمت استعادة النصوص الافتراضية') : tr('تم حفظ نصوص المطبوعات'));
    },
    onError: (e) => {
      setServerIssues(serverIssuesOf(e));
      toast.error(tr(saveErrorMessage(e)));
    },
  });

  const update = useCallback((f: (d: PrintTextsV1) => PrintTextsV1) => {
    setServerIssues([]);
    setDraft(f);
  }, []);
  const setEdit = useCallback((key: string, patch: Partial<PrintTextEdit> | null) => update((d) => {
    const edits = { ...d.edits };
    const next = patch === null ? NO_EDIT : { ...(edits[key] ?? NO_EDIT), ...patch };
    if (isBlank(next.text) && isBlank(next.alt) && !next.hidden) delete edits[key];
    else edits[key] = { text: isBlank(next.text) ? null : next.text, alt: isBlank(next.alt) ? null : next.alt, hidden: next.hidden };
    return { ...d, edits };
  }), [update]);

  const saveDraft = () => {
    if (!dirty || !valid || save.isPending) return;
    const r = checkPrintTexts(draft, true);
    if (!r.ok) return;
    sentRef.current = draft;
    save.mutate(isEmptyPrintTexts(draft) ? null : r.value);
  };
  const resetAll = () => {
    if (!window.confirm(`${tr('استعادة النصوص الافتراضية')}؟\n${tr('تعود كل النصوص إلى صياغتها الافتراضية بالعربية وحدها وتحفظ فورا')}`)) return;
    sentRef.current = draft;
    save.mutate(null);
  };
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm(tr('لديك تعديلات غير محفوظة — إغلاق دون حفظ؟'))) return;
    onClose();
  }, [dirty, onClose, tr]);

  // Esc يغلق (بتأكيدٍ إن وُجد ما لم يُحفظ)، وTab محصورٌ في النافذة — خلفها زرّ «حفظ الإعدادات» العامّ وروابط الشريط الجانبي، وEnter
  // عليها يرسل النموذج أو يغادر الصفحة فتضيع المسودة. والصفحة خلف النافذة لا تتمرّر، ومغادرتها بتعديلٍ غير محفوظ تُسأل
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      const box = dialogRef.current;
      if (e.key !== 'Tab' || !box) return;
      const focusable = Array.from(box.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href],[tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.offsetParent !== null);
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const cur = document.activeElement;
      const outside = !box.contains(cur);
      if (e.shiftKey && (cur === first || cur === box || outside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || outside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    // الإغلاق يعيد التركيز إلى زرّ الفتح في البطاقة
    return () => { document.body.style.overflow = prev; opener?.focus?.({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  /** النقر على نصٍّ في المعاينة: يُختار صفّه في القائمة (يُمرَّر إليه وتُركَّز خانته) */
  const onPick = useCallback((key: string) => {
    setActive(key);
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(key);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const target = row.querySelector<HTMLElement>('input:not(:disabled)') ?? row.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true });
    });
  }, []);
  const preview = useMemo(() => ({ onPick, active }), [onPick, active]);
  /** اختيار صفٍّ من القائمة: يُبرَز نصّه في المعاينة ويُظهره المستند النموذجي إن لم يكن ظاهراً */
  const onActivate = useCallback((key: string) => {
    setActive(key);
    setSample((s) => sampleFor(key, s));
  }, []);

  const lang = draft.secondLang;
  const setLang = (v: PrintSecondLang | null) => {
    if (v) lastLang.current = v;
    update((d) => ({ ...d, secondLang: v }));
  };
  const nameIssue = issuesAt('companyNameAlt')[0];
  const addressIssue = issuesAt('companyAddressAlt')[0];
  // ما لا صفّ له ظاهراً هنا (الحجم، نصٌّ في تبويب المستند الآخر، اسمٌ باللغة الثانية وهي مطفأة) يُعرض أعلى القائمة باسم نصّه
  const generalIssues = issues.filter((i) => {
    if (i.path === 'companyNameAlt' || i.path === 'companyAddressAlt') return lang === null;
    const k = issueKey(i.path);
    return !(k && tabKeys.has(k));
  });

  return createPortal(
    <div ref={dialogRef} tabIndex={-1} dir={dir} role="dialog" aria-modal="true" aria-labelledby="print-texts-title"
      className="fixed inset-0 z-[1500] bg-[#FAF7F0] flex flex-col outline-none">
      {/* الرأس: الحفظ والاستعادة والإغلاق */}
      <div className="bg-white border-b border-[#E9E1D3] px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 id="print-texts-title" className="font-bold text-[#1F1A13] flex items-center gap-2"><Languages size={18} className="text-[#E15A30]" /> {tr('نصوص المطبوعات')}</h2>
          <p className="text-xs text-[#6E6557] mt-0.5">{tr('اضغط على أي نص في المعاينة لتحريره أو اختره من القائمة')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!valid && <span className="text-xs text-[#C0392B] font-semibold">{tr('صحح الأخطاء المعلمة قبل الحفظ')}</span>}
          {dirty && valid && <span className="text-xs text-[#B45309] font-semibold">{tr('تعديلات غير محفوظة')}</span>}
          <button type="button" className="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed" onClick={resetAll}
            disabled={save.isPending || (!stored && isEmptyPrintTexts(draft))}>
            <RotateCcw size={14} /> {tr('استعادة النصوص الافتراضية')}
          </button>
          <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" onClick={saveDraft}
            disabled={!dirty || !valid || save.isPending}>
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={16} />}
            {tr('حفظ النصوص')}
          </button>
          <button type="button" onClick={requestClose} className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0]" aria-label={tr('إغلاق')} title={tr('إغلاق')}>
            <X size={18} />
          </button>
        </div>
      </div>

      {/* الجسم: المعاينة فوق القائمة على الشاشة الضيّقة، وعلى العريضة المعاينة يساراً والقائمة بجانبها (كلٌّ يتمرّر وحده) */}
      <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden lg:flex lg:flex-row-reverse">
        {/* المعاينة الحيّة */}
        <div className="lg:flex-1 lg:min-w-0 lg:overflow-y-auto p-4">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Seg value={tab} onChange={(v) => { setTab(v); setActive(null); }}
              options={[['invoice', tr('الفاتورة')], ['receipt', tr('سند القبض')]]} />
            <Seg value={paper} onChange={setPaper} options={[['a4', 'A4'], ['58', tr('حراري 58 مم')], ['80', tr('حراري 80 مم')]]} />
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-3 text-xs">
            {tab === 'invoice' ? (
              <>
                <Seg small value={sample.isReturn ? 'return' : 'sale'} onChange={(v) => setSample((s) => ({ ...s, isReturn: v === 'return' }))}
                  options={[['sale', tr('فاتورة بيع')], ['return', tr('مرتجع')]]} />
                <Seg small value={sample.standard ? 'standard' : 'simplified'} onChange={(v) => setSample((s) => ({ ...s, standard: v === 'standard' }))}
                  options={[['simplified', tr('فاتورة مبسطة')], ['standard', tr('فاتورة ضريبية لعميل له رقم ضريبي')]]} />
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-[#44403a]">
                  <input type="checkbox" className="w-3.5 h-3.5 accent-[#E15A30]" checked={sample.installments && !sample.isReturn} disabled={sample.isReturn}
                    onChange={(e) => setSample((s) => ({ ...s, installments: e.target.checked }))} />
                  {tr('جدول الأقساط')}
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-[#44403a]">
                  <input type="checkbox" className="w-3.5 h-3.5 accent-[#E15A30]" checked={sample.inclusive}
                    onChange={(e) => setSample((s) => ({ ...s, inclusive: e.target.checked }))} />
                  {tr('الأسعار شاملة الضريبة')}
                </label>
              </>
            ) : (
              <Seg small value={sample.links} onChange={(v) => setSample((s) => ({ ...s, links: v }))}
                options={[['one', tr('فاتورة واحدة')], ['many', tr('عدة فواتير')]]} />
            )}
          </div>

          <p className="text-[11px] text-[#9A8F7E] mb-2">
            {tr(PRINT_SAMPLE_WATERMARK)} · {paper === 'a4' ? tr('ما ينقص من بيانات شركتك يظهر بقيمة توضيحية') : tr('المعاينة الحرارية للعرض فقط — اختر النص من القائمة')}
          </p>
          {paper === 'a4' ? (
            <SheetPreview>
              <PrintLookContext.Provider value={DEFAULT_PRINT_LOOK}>
                <PrintTextsPreviewContext.Provider value={preview}>
                  {tab === 'invoice' ? <PrintableInvoice doc={invoiceDoc} /> : <PrintableReceipt doc={receiptDoc} />}
                </PrintTextsPreviewContext.Provider>
              </PrintLookContext.Provider>
            </SheetPreview>
          ) : (
            <ThermalPreview doc={tab === 'invoice' ? invoiceDoc : receiptDoc} paperMm={paper === '58' ? 58 : 80} />
          )}
        </div>
        <div className="lg:w-[460px] lg:shrink-0 lg:overflow-y-auto bg-white border-t lg:border-t-0 lg:border-e border-[#E9E1D3] p-4">
          {generalIssues.length > 0 && (
            <div className="mb-3 rounded-xl border border-[#F2C4BC] bg-[#FBE3DF] px-3 py-2 text-xs text-[#8E2A1F]" role="alert">
              {generalIssues.map((i, n) => {
                const entry = printTextEntry(issueKey(i.path) ?? '');
                return <p key={n}>{entry ? `${rowLabel(entry, tr)}: ` : ''}{tr(i.message)}</p>;
              })}
            </div>
          )}

          {/* لغة الطباعة */}
          <section className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 mb-4">
            <p className="font-semibold text-sm text-[#1F1A13] flex items-center gap-1.5"><Languages size={15} className="text-[#E15A30]" /> {tr('لغة الطباعة')}</p>
            <label className="flex items-center gap-2 text-sm text-[#44403a] mt-2 cursor-pointer select-none">
              <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={lang !== null}
                onChange={(e) => setLang(e.target.checked ? lastLang.current : null)} />
              {tr('إظهار النصوص بلغتين')}
            </label>
            {lang !== null && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="label" htmlFor="pt-second-lang">{tr('اللغة الثانية')}</label>
                  <select id="pt-second-lang" className="input" value={lang} onChange={(e) => setLang(e.target.value as PrintSecondLang)}>
                    {PRINT_SECOND_LANGS.map((l) => <option key={l} value={l}>{SECOND_LANG_NAMES[l]}</option>)}
                  </select>
                  <p className="text-[11px] text-[#6E6557] mt-1 leading-relaxed">{tr('العربية أولا دائما والثانية بجانبها على A4 وتحتها على الورق الحراري')}</p>
                </div>
                <div>
                  <label className="label" htmlFor="pt-name-alt">{tr('اسم الشركة باللغة الثانية')}</label>
                  <input id="pt-name-alt" className="input" dir="ltr" maxLength={PRINT_TEXTS_LIMITS.companyNameAltMax}
                    value={draft.companyNameAlt ?? ''} onChange={(e) => update((d) => ({ ...d, companyNameAlt: e.target.value || null }))} />
                  {nameIssue && <p className="text-[11px] text-[#C0392B] mt-1">{tr(nameIssue.message)}</p>}
                </div>
                <div>
                  <label className="label" htmlFor="pt-address-alt">{tr('العنوان باللغة الثانية')}</label>
                  <input id="pt-address-alt" className="input" dir="ltr" maxLength={PRINT_TEXTS_LIMITS.companyAddressAltMax}
                    value={draft.companyAddressAlt ?? ''} onChange={(e) => update((d) => ({ ...d, companyAddressAlt: e.target.value || null }))} />
                  {addressIssue && <p className="text-[11px] text-[#C0392B] mt-1">{tr(addressIssue.message)}</p>}
                </div>
              </div>
            )}
            <p className="text-[11px] text-[#9A8F7E] mt-2 flex items-start gap-1.5 leading-relaxed">
              <Info size={12} className="mt-0.5 shrink-0" />{tr('بعد حفظ أي تعديل تطبع الفاتورة والسند بالعربية أولا أيا كانت لغة واجهة الجهاز')}
            </p>
          </section>

          {/* النصوص بمجموعات الورقة */}
          {groups.map(({ group, entries }) => (
            <section key={group} className="mb-4">
              <p className="text-xs font-bold text-[#9A8F7E] mb-1.5">{tr(GROUP_TITLES[group])}</p>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <TextRow key={entry.key} entry={entry} edit={draft.edits[entry.key] ?? NO_EDIT} lang={lang}
                    active={active === entry.key} issues={issuesAt(`edits.${entry.key}`)} phase2Live={phase2Live}
                    onChange={(patch) => setEdit(entry.key, patch)} onActivate={onActivate}
                    rowRef={(el) => { if (el) rowRefs.current.set(entry.key, el); else rowRefs.current.delete(entry.key); }} />
                ))}
              </div>
            </section>
          ))}
          <p className="text-[11px] text-[#9A8F7E] leading-relaxed">{tr('سطر صدرت عبر منصة Field Sales ثابت في التذييل')}</p>
        </div>

      </div>
    </div>,
    document.body,
  );
}

/** مفتاح تبديل بخيارات — أزرارٌ type="button" */
function Seg<T extends string>({ value, onChange, options, small }: {
  value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; small?: boolean;
}) {
  return (
    <div className="inline-flex rounded-xl border border-[#E9E1D3] bg-white p-0.5" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={`rounded-lg font-semibold transition-colors ${small ? 'px-2.5 py-1 text-[11.5px]' : 'px-3 py-1.5 text-xs'} ${value === v ? 'bg-[#FBEBE2] text-[#C94E28]' : 'text-[#6E6557] hover:bg-[#FAF7F0]'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** ورقة A4 (794 بكسل) مصغّرةً لتتسع لعرض الجزء — الارتفاع من الورقة نفسها مقيساً */
function SheetPreview({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [sheetH, setSheetH] = useState(1123);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const sheet = sheetRef.current;
    if (!box || !sheet) return;
    const measure = () => { setBoxW(box.clientWidth); setSheetH(sheet.offsetHeight); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(sheet);
    return () => ro.disconnect();
  }, []);
  const scale = boxW > 0 ? Math.min(1, boxW / SHEET_WIDTH_PX) : 0.5;
  return (
    <div ref={boxRef} className="w-full">
      <div className="relative mx-auto bg-white rounded-lg border border-[#E9E1D3] shadow-sm overflow-hidden"
        style={{ width: SHEET_WIDTH_PX * scale, height: sheetH * scale }}>
        <div ref={sheetRef} style={{ position: 'absolute', top: 0, left: 0, width: SHEET_WIDTH_PX, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** الورق الحراري: وثيقة القالب الحراريّ نفسها (rep/thermal.ts) في iframe بعرض الورق — للعرض فقط، بلا سكربت */
function ThermalPreview({ doc, paperMm }: { doc: InvoiceDoc | ReceiptDoc; paperMm: 58 | 80 }) {
  const tr = useTr();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    let live = true;
    // الكتابة المتتابعة لا تبني الوثيقة لكل حرف
    const t = window.setTimeout(() => {
      thermalPreviewHtml(doc, { tr, paperMm }).then(
        (h) => { if (live) { setHtml(h); setFailed(false); } },
        () => { if (live) setFailed(true); },
      );
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [doc, paperMm, tr]);
  if (failed) return <p className="text-sm text-[#8E2A1F] text-center py-10">{tr('تعذر عرض المعاينة الحرارية')}</p>;
  if (html === null) return <div className="flex justify-center py-10"><span className="w-6 h-6 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>;
  return (
    <div className="flex justify-center">
      <iframe title={tr('المعاينة الحرارية')} srcDoc={html} sandbox="allow-same-origin"
        onLoad={(e) => {
          const d = e.currentTarget.contentDocument;
          if (d) setHeight(Math.max(240, d.documentElement.scrollHeight + 4));
        }}
        className="bg-white shadow-sm border border-[#E9E1D3]"
        style={{ width: `calc(${paperMm}mm + 2px)`, height }} />
    </div>
  );
}

/** صفّ نصٍّ واحد: الإخفاء والصياغة العربية ونصّ اللغة الثانية وإعادة الافتراضي */
function TextRow({ entry, edit, lang, active, issues, phase2Live, onChange, onActivate, rowRef }: {
  entry: PrintTextEntry;
  edit: PrintTextEdit;
  lang: PrintSecondLang | null;
  active: boolean;
  issues: PrintTextsIssue[];
  phase2Live: boolean;
  onChange: (patch: Partial<PrintTextEdit> | null) => void;
  onActivate: (key: string) => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const tr = useTr();
  const hideable = printTextHideable(entry);
  const rewordable = printTextRewordable(entry);
  const altEditable = printTextAltEditable(entry);
  const lockReason = hideable ? null : LOCK_REASONS[entry.lock] ?? null;
  const hidden = hideable && edit.hidden;
  const edited = edit.text !== null || edit.alt !== null || edit.hidden;
  const isTitle = entry.key === 'inv.title' || entry.key === 'inv.returnTitle';
  // ما يُطبع باللغة الثانية إن تُركت خانتها فارغة: ترجمة الصياغة العربية الجديدة من القاموس (إن وُجدت)، وإلا ترجمة الافتراضي
  const altFallback = lang ? (edit.text !== null ? phraseIn(edit.text.trim(), lang) : phraseIn(entry.ar, lang)) : null;
  const altMissing = lang !== null && altEditable && edit.text !== null && edit.text.trim() !== '' && edit.alt === null && !altFallback;
  const textIssue = issues.find((i) => i.path.endsWith('.text'));
  const altIssue = issues.find((i) => i.path.endsWith('.alt'));
  const otherIssues = issues.filter((i) => i !== textIssue && i !== altIssue);

  return (
    <div ref={rowRef} data-pt-row={entry.key} onFocus={() => onActivate(entry.key)}
      className={`rounded-xl border px-3 py-2.5 transition-colors ${active ? 'border-[#E15A30] ring-2 ring-[#E15A30]/25 bg-[#FFFBF8]' : issues.length ? 'border-[#F2C4BC] bg-white' : 'border-[#E9E1D3] bg-white'}`}>
      <div className="flex items-center gap-2">
        {hideable ? (
          <button type="button" data-eye="" aria-pressed={hidden} onClick={() => onChange({ hidden: !edit.hidden })}
            title={hidden ? tr('إظهار النص') : entry.lock === 'standard' ? `${tr('إخفاء النص')} — ${tr(STANDARD_HINT)}` : tr('إخفاء النص')}
            aria-label={hidden ? tr('إظهار النص') : tr('إخفاء النص')}
            className={`shrink-0 w-8 h-8 rounded-lg border flex items-center justify-center ${hidden ? 'border-[#E8C9BC] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] text-[#6E6557] hover:bg-[#FAF7F0]'}`}>
            {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        ) : (
          <button type="button" disabled title={lockReason ? tr(lockReason) : undefined} aria-label={lockReason ? tr(lockReason) : undefined}
            className="shrink-0 w-8 h-8 rounded-lg border border-[#E9E1D3] bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center cursor-not-allowed">
            <Lock size={14} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-semibold text-[#1F1A13] truncate ${hidden ? 'line-through opacity-60' : ''}`}>{rowLabel(entry, tr)}</p>
          {lockReason && <p className="text-[10.5px] text-[#9A8F7E]">{tr(lockReason)}</p>}
          {hidden && entry.lock === 'standard' && <p className="text-[10.5px] text-[#B45309]">{tr(STANDARD_HINT)}</p>}
        </div>
        {hidden && <span className="badge-inactive shrink-0">{tr('مخفي')}</span>}
        {edited && (
          <button type="button" onClick={() => onChange(null)} title={tr('إعادة النص الافتراضي')} aria-label={tr('إعادة النص الافتراضي')}
            className="shrink-0 p-1.5 rounded-lg text-[#9A8F7E] hover:text-[#C94E28] hover:bg-[#FAF7F0]">
            <RotateCcw size={14} />
          </button>
        )}
      </div>

      {entry.hideOnly ? (
        <p className="text-[10.5px] text-[#9A8F7E] mt-1.5">{tr('يظهر أو يخفى فقط ولا تعاد صياغته')}</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <input className={`input py-1.5 ${rewordable ? '' : 'bg-[#F1EBDF] text-[#6E6557] cursor-not-allowed'}`} dir="rtl" lang="ar"
            maxLength={entry.max} placeholder={entry.ar} disabled={!rewordable} title={!rewordable && lockReason ? tr(lockReason) : undefined}
            aria-label={`${rowLabel(entry, tr)} — ${tr('الصياغة بالعربية')}`}
            value={edit.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />
          {textIssue && <p className="text-[11px] text-[#C0392B]">{tr(textIssue.message)}</p>}
          {lang !== null && (
            <>
              <input className={`input py-1.5 ${altEditable ? '' : 'bg-[#F1EBDF] text-[#6E6557] cursor-not-allowed'}`} dir="ltr" lang={lang}
                maxLength={entry.max} placeholder={altFallback ?? ''} disabled={!altEditable}
                aria-label={`${rowLabel(entry, tr)} — ${SECOND_LANG_NAMES[lang]}`}
                value={edit.alt ?? ''} onChange={(e) => onChange({ alt: e.target.value })} />
              {altIssue && <p className="text-[11px] text-[#C0392B]">{tr(altIssue.message)}</p>}
              {altMissing && <p className="text-[10.5px] text-[#B45309]">{tr('الصياغة الجديدة بلا ترجمة جاهزة — اكتب نصها باللغة الثانية وإلا لا يطبع سطرها')}</p>}
            </>
          )}
        </div>
      )}
      {otherIssues.map((i, k) => <p key={k} className="text-[11px] text-[#C0392B] mt-1">{tr(i.message)}</p>)}

      {isTitle && (active || edited) && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800 leading-relaxed space-y-1">
          <p className="flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{tr(TITLE_WARNING)}</p>
          {phase2Live && <p className="flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr(PHASE2_TITLE_NOTE)}</p>}
        </div>
      )}
    </div>
  );
}
