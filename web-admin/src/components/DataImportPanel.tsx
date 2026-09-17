import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api, { companyApi, importApi } from '../api/client';
import {
  parseImportFile, ImportFileError, IMPORT_TYPES, ImportKind, LEDGER_IMPORT_KINDS, classifyImportRowsByCutover, classifyImportFailure,
  openingStockGate, openingStockAckState, fileRowOf, localizedServerMessage, listSeparator,
  type InvalidDateRow, type OpeningStockBlock, type OpeningStockServerBlock, type ImportNotice,
} from '../lib/importData';
import { useTr } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import { useAuthStore } from '../store/authStore';
import { importAccess, importAccessNote, revertAllowed, visibleImportKinds, batchesView, IMPORT_SCOPED_NOTE } from '../lib/importAccess';
import { ledgerKeys } from '../api/ledgerConfig';
import { ledgerSetupKeys } from '../api/ledgerSetup';
import { formatCurrency, formatDate, formatDateTime, formatDayOnly, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import ConfirmDialog from './ConfirmDialog';
import ImportLedgerNotice, {
  useLedgerImportContext, UndatedDateChooser, CutoverSplitNotice, OpeningStockNote, OpeningStockAckPanel, type LedgerImportCtx,
} from './ImportLedgerNotice';
import {
  groupRevertBlocked, batchStatusView, hasRunningBatch, classifyRevertFailure, revertFailureKey,
  NETWORK_LOST_MESSAGE, REVERT_LEDGER_BUSY, OPENING_STOCK_REVERT_ACTIVE, REVERT_BATCH_RUNNING,
  accessFailureKey, importResultView, importRowErrorKey, importRowErrorValue, customerSkipReasonKey, productSkipReasonKey, similarWarningKey, attachedCodeKey,
  revertConfirmKey, openingStockRevertHint, OPENING_STOCK_REVERT_HINT,
  duplicateConsequenceKey, IMPORT_IN_PROGRESS_TEXT, zeroPriceGate, buildImportBody, importButtonBlocked, ZERO_PRICE_ACK_KEY,
  REVERT_PERMISSION_DENIED, importFieldLabel, previewCellValue, OPENING_STOCK_PREVIOUS_BATCH_DATE, type ImportResultRowError,
  importRowErrorFieldKey, revertSummaryLines, type RevertExtras,
} from '../lib/importRevert';
import { Users, Package, Wallet, BookOpen, Tags, Boxes, Upload, X, Check, AlertTriangle, Loader2, FileUp, RotateCcw, Clock, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { backdropClose } from '../lib/backdropClose';

type Rows = Record<string, unknown>[];
/** سياق أدنى حين يرفض الخادم الصفوف بلا تاريخ والسياق غير متاح: الدفاتر مفعّلة، بلا تاريخ بدء ولا اقتراح */
const MIN_ACTIVATED_CTX: LedgerImportCtx = { activated: true, cutoverDate: null, timezone: 'Asia/Riyadh', suggestedUndatedDate: null, method: null };
const OPENING_STOCK: ImportKind = 'opening_stock';
interface OverlapRow { customerId?: string; customerName?: string | null; existingBalance?: number | string; statementNet?: number | string }
type Conflict =
  /** running: دفعة الملف نفسه ما زالت تُكتب ⇒ لا «استيراد رغم التكرار» */
  | { type: 'duplicate'; batchId?: string; createdAt?: string; running: boolean }
  | { type: 'overlap'; overlap: OverlapRow[] }
  | { type: 'inProgress'; kind?: string; createdAt?: string }
  | { type: 'invalidDate'; rows: InvalidDateRow[] }
  /** رفض نهائي للمخزون الافتتاحي: بعد التفعيل أو في طريقة التاريخ الكامل (تاريخ البدء ≤ اليوم يُعالج بالإقرار لا بتعارض) */
  | { type: 'openingStock'; reason: OpeningStockBlock; cutoverDate?: string | null };
interface Preview {
  kind: ImportKind;
  fileName: string;
  /** صفوف الملف الخام — التحويل يُعاد مع «تاريخ الصفوف بلا تاريخ» المعتمد */
  raw: Rows;
  /** تنبيهات قراءة الملف (الترميز، العناوين المكررة…) — البندان 12 و27 */
  fileNotices: ImportNotice[];
  /** إقرارات المالك بعد 409: الاستيراد رغم التكرار / رغم التداخل */
  flags: { force?: boolean; confirmOverlap?: boolean };
  conflict: Conflict | null;
}
interface ImportResult {
  created: number; skipped: number; total: number; errors: ImportResultRowError[];
  /** الأسعار: أزواج (عميل/صنف) كان لها سعر خاص فاستُبدل (البند 7) */
  updated?: number;
  /** الأرصدة والكشوف: صفوف صفرية لم تُكتب */
  zero?: number;
  warnings?: {
    undatedAsToday?: number;
    skipped?: { customerName?: string | null; reason?: string }[];
    /** الأرصدة: أسطر عميل واحد دُمجت في قيد واحد (البند 10) */
    merged?: { customerName?: string | null; rows?: number[]; total?: number }[];
    /** العملاء: أُنشئ بكود جديد مع تطابق الاسم أو الجوال (البند 3) */
    similar?: { row: number; code?: string; matchedBy?: 'phone' | 'name' }[];
  };
  /** العملاء (البند 3) والمنتجات (البند 30): الصفوف المتخطاة بسببها */
  skippedRows?: { row: number; reason?: string; code?: string }[];
  /** العملاء: أكواد رُبطت بعملاء قائمين بلا كود (الدفعة 2، الانحدار 3) */
  attached?: number;
  attachedRows?: { row: number; code?: string; matchedBy?: 'phone' | 'name' }[];
  /** المخزون الافتتاحي: إجمالي التكلفة الصافية للبنود */
  totalCost?: number;
}
interface Batch { id: string; kind: string; count: number; createdBy?: string | null; createdAt: string; status?: 'running' | 'interrupted' | 'done' | null }
type RevertBlocked = number | { id?: string; name?: string | null; reason?: string }[];

const kindLabel = (k: string | undefined) => (k ? IMPORT_TYPES[k as ImportKind]?.label || k : '');

/** قيمة محوّلة في جدول المعاينة: الأرقام والتواريخ من اليسار */
const cellText = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** تنبيه ملف/تحويل: المفتاح مترجماً ثم العدد ثم القيم معزولة الاتجاه */
function NoticeLine({ n, tr }: { n: ImportNotice; tr: (s: string) => string }) {
  const values = (n.values ?? []).slice(0, 8);
  return (
    <p className="text-[11px] text-amber-800 flex items-start gap-1">
      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
      <span>
        {tr(n.key)}
        {typeof n.count === 'number' ? <> (<bdi className="tabular-nums">{n.count}</bdi>)</> : null}
        {values.length > 0 && <>: {values.map((v, i) => <span key={i}>{i > 0 ? ' · ' : ''}<bdi className="font-mono">{v}</bdi></span>)}{(n.values?.length ?? 0) > values.length ? ' …' : ''}</>}
      </span>
    </p>
  );
}

/**
 * البند K: قيمة خطأ الصف بعد رسالته — كود الصنف أو المبلغ بخط ثابت كما في ملف المالك،
 * وتاريخ دفعة المخزون الافتتاحي السابقة بعبارة تدلّه على الدفعة التي يتراجع عنها بتنسيق تاريخ الواجهة.
 * والبند L: وسم خانة القيمة قبلها («كود الصنف: C1») ليعرف المالك أيّ عمود يراجع في ملفه.
 */
function RowErrorValue({ er, tr }: { er: { code?: string; message?: string; value?: string; field?: string }; tr: (s: string) => string }) {
  const v = importRowErrorValue(er);
  if (!v) return null;
  if (v.kind === 'previousBatchDate') return <> — {tr(OPENING_STOCK_PREVIOUS_BATCH_DATE).replace('{date}', formatDayOnly(v.date))}</>;
  // البند L: خانة القيمة حين تفيد («كود الصنف: C1») — والرسالة التي تذكرها سلفاً لا تُكرَّر
  const field = importRowErrorFieldKey(er);
  return <>{field ? <> — {tr(field)}</> : null}: <bdi className="font-mono">{v.value}</bdi></>;
}

// قسم استيراد بيانات الشركة السابقة — أيقونة رفع لكل نوع بيانات (في إعدادات الشركة)
export default function DataImportPanel() {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const qc = useQueryClient();
  const ledger = useLedgerImportContext();
  const [busy, setBusy] = useState<ImportKind | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{ kind: ImportKind; res: ImportResult; fileRows: number[] } | null>(null);
  const [revertId, setRevertId] = useState<string | null>(null);
  // «تاريخ الصفوف بلا تاريخ»: المُدخَل (مقترح cutover−1) والمعتمد صراحةً
  const [undatedInput, setUndatedInput] = useState('');
  const [undatedDate, setUndatedDate] = useState<string | null>(null);
  const [excludeAfter, setExcludeAfter] = useState(false);
  // الخادم رفض الصفوف بلا تاريخ (UNDATED_ROWS_LEDGER_ACTIVE) والسياق null (الميزة مطفأة أو بلا صلاحية دفاتر):
  // نُظهر اختيار التاريخ بسياق أدنى، ونعدّ الدفاتر مفعّلة لنص التراجع
  const [forceUndated, setForceUndated] = useState(false);
  const [serverActivated, setServerActivated] = useState(false);
  const ledgerActivated = !!ledger?.activated || serverActivated;
  // المخزون الافتتاحي: «التكلفة شاملة الضريبة»، ورفض الخادم الأخير (بعد التفعيل / التاريخ الكامل / تاريخ بدء ≤ اليوم)،
  // والإقرار الصريح بتعديل تاريخ البدء في يوم لاحق (acknowledgeCutoverChange)
  const [stockInclTax, setStockInclTax] = useState(false);
  const [stockServerBlock, setStockServerBlock] = useState<OpeningStockServerBlock | null>(null);
  const [stockAck, setStockAck] = useState(false);
  // قوائم الأسعار: إقرار المالك بأن السعر الخاص الصفري مقصود (يُصفَّر مع كل ملف جديد) — البند 1
  const [zeroPriceAck, setZeroPriceAck] = useState(false);
  // الصلاحيات والنطاق (البندان 5 و21): الخادم يفرضها، والواجهة تخفي ما سيُرفض وتشرح
  const user = useAuthStore((s) => s.user);
  const access = useMemo(() => importAccess(user), [user]);
  const accessNote = importAccessNote(access);

  const { data: companyCfg } = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { warehouseEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  const stockGate = openingStockGate({
    warehouseEnabled: companyCfg?.warehouseEnabled === true,
    ctx: ledger,
    serverBlock: stockServerBlock,
    now: new Date(),
  });
  const stockActiveBlock = stockGate.state === 'blocked' && stockGate.reason === 'active';
  const stockAckInfo = openingStockAckState(stockGate, stockAck);

  const invalidateBatches = () => qc.invalidateQueries({ queryKey: ['import-batches'] });
  const { data: batchesBody } = useQuery({
    queryKey: ['import-batches'],
    queryFn: async () => (await importApi.batches()).data as { data?: Batch[]; scoped?: boolean },
    // المقيّد النطاق لا يرى دفعات الشركة ⇒ لا طلب
    enabled: !access.scoped,
    // دفعة جارية ⇒ متابعة حالتها حتى تنتهي أو تنقطع
    refetchInterval: (q) => (hasRunningBatch((q.state.data as { data?: Batch[] } | undefined)?.data) ? 5000 : false),
  });
  const batchesState = batchesView(access, batchesBody);
  const batches: Batch[] | undefined = batchesBody || access.scoped ? batchesState.list : undefined;
  const revertMut = useMutation({
    mutationFn: (id: string) => importApi.revert(id),
    onSuccess: (res) => {
      const d = res.data.data as { removed: number; blocked: RevertBlocked; remaining?: number; kind?: string } & RevertExtras;
      const blockedList = Array.isArray(d.blocked) ? d.blocked : [];
      const blockedCount = Array.isArray(d.blocked) ? d.blocked.length : (d.blocked || 0);
      const remaining = typeof d.remaining === 'number' ? d.remaining : 0;
      // اسم حركة المخزون الافتتاحي نص ثابت لا اسم سجل ⇒ لا يُعدَّد
      const showNames = d.kind !== OPENING_STOCK;
      let msg = `${tr('تمت الإزالة')}: ${d.removed}`;
      if (remaining > 0) {
        const groups = groupRevertBlocked(blockedList);
        const protectedCount = groups.filter((g) => !g.retry).reduce((a, g) => a + g.count, 0);
        const retryCount = Math.max(0, remaining - protectedCount);
        for (const g of groups) {
          const names = showNames ? g.names.slice(0, 3) : [];
          msg += ` · ${tr(g.key)}: ${g.count}${names.length ? ` (${names.join(listSeparator(lang))}${g.names.length > names.length || g.count > names.length ? '…' : ''})` : ''}`;
        }
        if (!groups.length) msg += ` · ${tr('بقي')} ${remaining}`;
        if (retryCount > 0) msg += ` · ${tr('أعد المحاولة لاحقاً للمتبقي')}: ${retryCount}`;
      } else if (blockedCount) {
        msg += ` · ${tr('محمي له معاملات')}: ${blockedCount}`;
      }
      // حقائق الرد التي لا شاشة لها غيره: ما سبق التراجع عنه (الأسعار) وكل تابع حُذف مع العملاء — لا حذف صامت
      const summary = revertSummaryLines(d);
      for (const l of summary) msg += ` · ${tr(l.key)}: ${l.count}`;
      if (remaining > 0) toast(msg, { duration: 8000 });
      // ملخّص فيه حذف تابع: مهلة أطول ليقرأه المالك قبل أن يختفي
      else toast.success(msg, summary.length ? { duration: 8000 } : undefined);
      invalidateBatches();
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      if (d.kind === OPENING_STOCK) {
        qc.invalidateQueries({ queryKey: ['warehouse-stock'] });
        qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      }
      setRevertId(null);
    },
    onError: (e) => {
      const f = classifyRevertFailure(e);
      const key = revertFailureKey(f);
      toast.error(key ? tr(key) : (f.type === 'other' && localizedServerMessage(f.message, lang, tr)) || tr('تعذر التراجع'), { duration: f.type === 'network' ? 10_000 : 6000 });
      if (f.type === 'openingStockActive') setStockServerBlock({ reason: 'active' });
      // الانقطاع أو دفعة جارية أو متراجع عنها أو تغيّرت الصلاحية: السجل المعروض قديم
      // البند 19: ودفعة قيود أخرى جارية تمنع التراجع ⇒ السجل المعروض قديم كذلك
      if (f.type === 'network' || f.type === 'running' || f.type === 'gone' || f.type === 'inProgress' || f.type === 'scopedAdmin' || f.type === 'permissionDenied') invalidateBatches();
      setRevertId(null);
    },
  });

  const onFile = async (kind: ImportKind, file?: File) => {
    if (!file) return;
    setBusy(kind); setResult(null);
    try {
      const parsed = await parseImportFile(file);
      const rows = parsed.rows;
      if (!rows.length) { toast.error(tr('الملف فارغ أو بلا صفوف بيانات')); setBusy(null); return; }
      setUndatedInput(ledger?.suggestedUndatedDate ?? '');
      setUndatedDate(null);
      setForceUndated(false);
      setExcludeAfter(false);
      setStockInclTax(false);
      setStockAck(false);
      setZeroPriceAck(false);
      setPreview({ kind, fileName: file.name, raw: rows, fileNotices: parsed.notices ?? [], flags: {}, conflict: null });
    } catch (e) {
      // ترميز لا يُفك (البند 27) برسالته، وغيره الرسالة العامة
      toast.error(e instanceof ImportFileError ? tr(e.key) : tr('تعذر قراءة الملف تأكد أنه Excel/CSV صالح'), { duration: 8000 });
    }
    setBusy(null);
  };

  const companyDecimals = currencyDecimals(getActiveCurrency());
  // المعاينة: التحويل بالتاريخ المعتمد، والتصنيف حول تاريخ البدء (للأرصدة والكشوف حين الدفاتر متاحة فقط)
  const view = useMemo(() => {
    if (!preview) return null;
    const ledgerKind = LEDGER_IMPORT_KINDS.includes(preview.kind);
    // منازل عملة الشركة: الدينار بثلاث منازل يحسم «12.500» عشرياً في عمود بلا دليل آخر (الدفعة 2، الانحدار 6)
    const tf = IMPORT_TYPES[preview.kind].transform(preview.raw, { ...(ledgerKind && undatedDate ? { undatedDate } : {}), currencyDecimals: companyDecimals });
    const aware = !!ledger && ledgerKind;
    const split = aware && ledger?.cutoverDate ? classifyImportRowsByCutover(tf.valid, ledger.cutoverDate, ledger.timezone) : null;
    const keep = (_: unknown, i: number) => !(split && excludeAfter) || split.classes[i] !== 'onOrAfter';
    const rows = tf.valid.filter(keep);
    // رقم صف الملف لكل صف مرسل: الخادم يرقّم أخطاءه بموضع الصف المرسل
    const sentFileRows = tf.fileRows.filter(keep);
    const undated = tf.undated ?? 0;
    // سياق الاختيار: سياق الدفاتر، أو سياق أدنى بعد رفض الخادم (بلا تاريخ بدء ولا اقتراح) — التصنيف يبقى على ledger وحده
    const chooserCtx: LedgerImportCtx | null = ledger ?? (forceUndated || serverActivated ? MIN_ACTIVATED_CTX : null);
    const needChooser = ledgerKind && !!chooserCtx;
    // تنبيهات الملف ثم التحويل، وعوائقه، وخريطة الأعمدة (البنود 9 و11 و12 و13)
    const notices: ImportNotice[] = [...preview.fileNotices, ...(tf.notices ?? [])];
    // قوائم الأسعار: السعر الخاص الصفري يمنع الاستيراد حتى إقرار المالك (البند 1)
    const zeroPrice = zeroPriceGate(preview.kind, tf.zeroPriceRows, zeroPriceAck);
    return {
      ...tf, ledgerKind, aware, split, rows, sentFileRows, undated, chooserCtx, notices, zeroPrice,
      blockers: tf.blockers ?? [], columns: tf.columns ?? [],
      needUndatedChoice: needChooser && undated > 0 && !undatedDate,
    };
  }, [preview, ledger, undatedDate, excludeAfter, forceUndated, serverActivated, zeroPriceAck, companyDecimals]);

  const doImport = async (extra?: Preview['flags']) => {
    if (!preview || !view) return;
    const kind = preview.kind;
    const flags = { ...preview.flags, ...extra };
    const body = buildImportBody({
      kind, rows: view.rows, ledgerKind: view.ledgerKind, undatedDate,
      stockInclTax, stockAckBody: stockAckInfo.body, flags,
      zeroPriceRows: view.zeroPriceRows, zeroPriceAck,
    });
    const withConflict = (conflict: Conflict | null) => setPreview({ ...preview, flags, conflict });
    setBusy(kind);
    try {
      const res = await api.post(IMPORT_TYPES[kind].endpoint, body);
      setResult({ kind, res: res.data.data as ImportResult, fileRows: view.sentFileRows });
      setPreview(null);
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      if (kind === OPENING_STOCK) {
        qc.invalidateQueries({ queryKey: ['warehouse-stock'] });
        qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      }
      invalidateBatches();
    } catch (e) {
      const f = classifyImportFailure(e);
      switch (f.type) {
        case 'scopedAdmin':
        case 'permissionDenied':
        case 'accountingDisabled':
          // رفض الوصول (النطاق/الصلاحية/الدفاتر): لا فائدة من إبقاء المعاينة — البندان 5 و21
          setPreview(null);
          invalidateBatches();
          toast.error(tr(accessFailureKey(f, 'import')!), { duration: 8000 });
          break;
        case 'network':
          // لا رد: قد يكون الخادم أتم الاستيراد أو ما زال يكتبه ⇒ إغلاق المعاينة فلا يُعاد الرفع قبل مراجعة السجل
          setPreview(null);
          invalidateBatches();
          toast.error(tr(NETWORK_LOST_MESSAGE), { duration: 12_000 });
          break;
        case 'duplicate':
          withConflict({ type: 'duplicate', batchId: f.batchId, createdAt: f.createdAt, running: f.running });
          if (f.running) invalidateBatches();
          break;
        case 'overlap':
          withConflict({ type: 'overlap', overlap: f.overlap as OverlapRow[] });
          break;
        case 'inProgress':
          withConflict({ type: 'inProgress', kind: f.kind, createdAt: f.createdAt });
          invalidateBatches();
          break;
        case 'undated':
          setUndatedDate(null);
          setForceUndated(true);
          setServerActivated(true);
          withConflict(null);
          toast.error(tr('الدفاتر مفعلة: الصفوف بلا تاريخ تُرفض. اختر لها تاريخا أدناه'));
          break;
        case 'invalidDate':
          if (!f.rows.length) {
            // تاريخ «الصفوف بلا تاريخ» نفسه مرفوض ⇒ إعادة الاختيار
            setUndatedDate(null);
            withConflict(null);
            toast.error(tr('تاريخ الصفوف بلا تاريخ غير صالح. اختر تاريخا آخر'));
          } else {
            withConflict({ type: 'invalidDate', rows: f.rows.map((r) => ({ ...r, row: fileRowOf(view.sentFileRows, r.row) })) });
          }
          break;
        case 'openingStockActive':
          setStockServerBlock({ reason: 'active' });
          withConflict({ type: 'openingStock', reason: 'active' });
          break;
        case 'openingStockAfterCutover':
          // تاريخ البدء المحفوظ ≤ اليوم: لوحة الإقرار بأقرب تاريخ بدء من الخادم، ثم إعادة الإرسال بـacknowledgeCutoverChange
          setStockServerBlock({ reason: 'afterCutover', cutoverDate: f.cutoverDate ?? null, minCutoverDate: f.minCutoverDate ?? null });
          setStockAck(false);
          withConflict(null);
          toast.error(tr('أقرّ بتعديل تاريخ البدء في يوم لاحق ثم أعد الاستيراد'));
          qc.invalidateQueries({ queryKey: ledgerSetupKeys.setup });
          break;
        case 'openingStockFullHistory':
          setStockServerBlock({ reason: 'fullHistory' });
          withConflict({ type: 'openingStock', reason: 'fullHistory' });
          break;
        case 'ledgerBusy':
          toast.error(tr(REVERT_LEDGER_BUSY));
          break;
        case 'ledgerStateChanged':
          // فُعّلت الدفاتر أثناء التجهيز: لا شيء كُتب ⇒ تحديث سياق الدفاتر والمعاينة ثم الإعادة
          setServerActivated(true);
          qc.invalidateQueries({ queryKey: ledgerKeys.status });
          withConflict(null);
          toast.error(tr('فُعّلت الدفاتر أثناء تجهيز الاستيراد ولم يُكتب شيء. راجع المعاينة ثم أعد الاستيراد'), { duration: 8000 });
          break;
        case 'batchRunning':
          invalidateBatches();
          toast.error(tr(REVERT_BATCH_RUNNING));
          break;
        case 'warehouseDisabled':
          setPreview(null);
          toast.error(tr('ميزة مخزون الشركة غير مفعلة لهذه الشركة'));
          qc.invalidateQueries({ queryKey: ['company'] });
          break;
        default:
          // رسالة الخادم عربية: تُعرض كما هي بالعربية أو مترجمةً إن وُجدت، وإلا نص عام بحسب الحالة
          toast.error(localizedServerMessage(f.message, lang, tr) ?? (f.status === 400 ? tr('بيانات غير صالحة') : tr('تعذر الاستيراد')));
      }
    }
    setBusy(null);
  };

  const allCards: { kind: ImportKind; icon: React.ElementType }[] = [
    { kind: 'customers', icon: Users },
    { kind: 'products', icon: Package },
    { kind: 'balances', icon: Wallet },
    { kind: 'ledger', icon: BookOpen },
    { kind: 'prices', icon: Tags },
    ...(stockGate.state !== 'hidden' ? [{ kind: OPENING_STOCK, icon: Boxes }] : []),
  ];
  // بطاقات الأنواع غير المسموحة مخفية (البندان 5 و21)
  const visibleKinds = visibleImportKinds(access, allCards.map((c) => c.kind));
  const active = allCards.filter((c) => visibleKinds.includes(c.kind));

  const revertKind = revertId ? batches?.find((b) => b.id === revertId)?.kind : undefined;
  // البندان 7 و17: نص صادق بحسب النوع — لا وعد بـ«إعادة الأرصدة» في الأسعار والمنتجات، وذكر ما يبقى من العملاء
  const revertMessage = tr(revertConfirmKey(revertKind, ledgerActivated));

  const retryConflictButton = (label: string) => (
    <button type="button" onClick={() => doImport()} disabled={busy !== null}
      className="mt-2 text-xs font-semibold text-[#6E6557] border border-[#E8E0D2] bg-white rounded-lg px-3 py-1.5 hover:bg-[#FBF7F0] disabled:opacity-50 inline-flex items-center gap-1">
      <RefreshCw size={12} /> {tr(label)}
    </button>
  );

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center"><FileUp size={20} className="text-[#E15A30]" /></div>
        <div>
          <h3 className="font-bold text-gray-800">{tr('استيراد البيانات من نظامك السابق')}</h3>
          <p className="text-xs text-gray-500">{tr('ارفع ملف Excel مصدرا من نظامك السابق بأي تنسيق يفهم النظام الأعمدة تلقائيا ويضيف البيانات مباشرة بلا قالب ولا إدخال يدوي')}</p>
        </div>
      </div>
      <p className="text-[11px] text-amber-700 bg-amber-50/70 border border-amber-100 rounded-lg px-3 py-2 mt-3">
        {tr('الترتيب الموصى به العملاء والمنتجات أولا ثم الأرصدة الافتتاحية أو دفتر الأستاذ ثم قوائم الأسعار لأنها تربط بالعملاء والأصناف بالكود أو الجوال')}
      </p>
      <ImportLedgerNotice ctx={ledger} />
      {accessNote && (
        <p className="text-[11px] text-[#6E6557] bg-[#FBF7F0] border border-[#E8E0D2] rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5" role="note">
          <AlertTriangle size={12} className="shrink-0 mt-0.5 text-amber-600" /> {tr(accessNote)}
        </p>
      )}

      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        {active.map(({ kind, icon: Icon }) => {
          const isStock = kind === OPENING_STOCK;
          const blocked = isStock && stockGate.state === 'blocked';
          const disabled = busy === kind || blocked;
          return (
            <div key={kind} className={`border border-[#E9E1D3] rounded-xl p-4 ${blocked ? 'bg-[#FBF7F0]' : ''}`}>
              <div className="flex items-center gap-2 mb-3">
                <Icon size={18} className={blocked ? 'text-gray-400' : 'text-[#E15A30]'} />
                <span className={`font-semibold ${blocked ? 'text-gray-500' : 'text-gray-800'}`}>{tr(IMPORT_TYPES[kind].label)}</span>
              </div>
              {isStock && (
                <OpeningStockNote gate={stockGate} />
              )}
              <label aria-disabled={disabled}
                className={`btn-primary w-full justify-center text-xs py-2 ${disabled ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
                {busy === kind ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {tr('رفع الملف')}
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={disabled}
                  onChange={(e) => { onFile(kind, e.target.files?.[0]); e.currentTarget.value = ''; }} />
              </label>
            </div>
          );
        })}
      </div>

      {/* سجلّ الاستيرادات — يظهر دائماً؛ يمكن التراجع عن أيّ دفعة منتهية أو منقطعة */}
      <div className="mt-5 border-t border-[#E9E1D3] pt-4">
        <h4 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2"><Clock size={15} className="text-[#E15A30]" /> {tr('سجل الاستيرادات يمكن التراجع عن أي دفعة')}</h4>
        {batchesState.scoped ? (
          <p className="text-xs text-gray-500 py-2">{tr(IMPORT_SCOPED_NOTE)}</p>
        ) : batches && batches.length > 0 ? (
          <>
            <div className="space-y-2">
              {batches.map((b) => {
                const sv = batchStatusView(b);
                const unit = b.kind === OPENING_STOCK ? tr('بند') : tr('سجل');
                const stockLocked = b.kind === OPENING_STOCK && stockActiveBlock;
                const permitted = revertAllowed(access, b.kind);
                const canRevert = sv.revertable && !stockLocked && permitted;
                const countText = sv.status === 'running'
                  ? (b.count > 0 ? `${tr('حتى الآن')} ${b.count} ${unit}` : null)
                  : sv.status === 'interrupted'
                    ? `${tr('سجل منها قبل الانقطاع')} ${b.count} ${unit}`
                    : `${b.count} ${unit}`;
                return (
                  <div key={b.id} className="flex items-center justify-between gap-2 bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2">
                    <div className="text-sm min-w-0">
                      <span className="font-semibold text-gray-800">{tr(kindLabel(b.kind))}</span>
                      {sv.status === 'running' && (
                        <span className="ms-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-800 bg-amber-100 rounded-full px-2 py-0.5">
                          <Loader2 size={10} className="animate-spin" /> {tr(sv.label!)}
                        </span>
                      )}
                      {sv.status === 'interrupted' && (
                        <span className="ms-2 inline-flex items-center gap-1 text-[10px] font-semibold text-[#8E2A1F] bg-red-100 rounded-full px-2 py-0.5">
                          <AlertTriangle size={10} /> {tr(sv.label!)}
                        </span>
                      )}
                      <span className="text-gray-500 text-xs mr-2">{countText ? `· ${countText} ` : ''}· {formatDate(b.createdAt)}{b.createdBy ? ` · ${b.createdBy}` : ''}</span>
                    </div>
                    <button onClick={() => setRevertId(b.id)} disabled={revertMut.isPending || !canRevert}
                      title={!permitted ? tr(REVERT_PERMISSION_DENIED) : sv.status === 'running' ? tr('الدفعة ما زالت قيد الاستيراد — انتظر انتهاءها ثم تراجع عنها') : stockLocked ? tr(OPENING_STOCK_REVERT_ACTIVE) : undefined}
                      className="text-red-600 hover:bg-red-50 rounded-lg px-2.5 py-1 text-xs flex items-center gap-1 shrink-0 disabled:opacity-40 disabled:hover:bg-transparent">
                      <RotateCcw size={13} /> {tr('تراجع / إزالة')}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">{tr('التراجع يزيل ما أضيف في تلك الدفعة ويعيد حساب الأرصدة ولا يحذف العملاء الذين لديهم فواتير أو سندات حقيقية')}</p>
            {ledgerActivated && (
              <p className="text-[11px] text-amber-700 mt-1">{tr('يُزال من كشوف العملاء وتُكتب في الدفاتر قيود عكسية؛ لا يُحذف قيد مرحّل')}</p>
            )}
            {hasRunningBatch(batches) && (
              <p className="text-[11px] text-amber-700 mt-1">{tr('دفعة قيد الاستيراد: انتظر انتهاءها قبل رفع الملف نفسه أو التراجع عنها')}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-400 py-2">{tr('لا توجد دفعات استيراد بعد أي ملف تستورده من الآن سيظهر هنا كدفعة يمكن التراجع عنها بضغطة')}</p>
        )}
      </div>

      {revertId && (
        <ConfirmDialog
          danger
          title={tr('التراجع عن الاستيراد')}
          message={revertMessage}
          confirmLabel={tr('نعم أزل')}
          loading={revertMut.isPending}
          onConfirm={() => revertMut.mutate(revertId)}
          onClose={() => setRevertId(null)}
        />
      )}

      {/* معاينة قبل الاستيراد */}
      {preview && view && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(() => { if (!busy) setPreview(null); })}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
              <h3 className="font-bold text-gray-800">{tr('معاينة الاستيراد')} — {tr(IMPORT_TYPES[preview.kind].label)}</h3>
              <button onClick={() => setPreview(null)} disabled={busy !== null} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">{tr('الملف')}: <span className="font-mono">{preview.fileName}</span></p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-green-700">{view.rows.length}</p>
                  <p className="text-xs text-green-600">{tr('صف صالح للاستيراد')}</p>
                </div>
                <div className={`rounded-xl p-3 text-center ${view.errors.length ? 'bg-amber-50' : 'bg-gray-50'}`}>
                  <p className={`text-2xl font-bold ${view.errors.length ? 'text-amber-700' : 'text-gray-400'}`}>{view.errors.length}</p>
                  <p className="text-xs text-gray-500">{tr('صف به خطأ يتجاهل')}</p>
                </div>
              </div>
              {preview.kind === OPENING_STOCK && (
                <div className="rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] p-3 text-[11px] text-[#6E6557] space-y-2">
                  <p className="flex items-center justify-between gap-2">
                    <span>{tr('إجمالي تكلفة الملف')}{stockInclTax ? ` (${tr('شاملة الضريبة')})` : ''}</span>
                    <bdi className="tabular-nums font-bold text-gray-800">{formatCurrency(view.totalCost ?? 0)}</bdi>
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={stockInclTax} disabled={busy !== null}
                      onChange={(e) => { setStockInclTax(e.target.checked); setPreview({ ...preview, flags: {}, conflict: null }); }} />
                    <span className="font-semibold">{tr('التكلفة شاملة الضريبة')}</span>
                  </label>
                  <p>{tr('تخصم ضريبة كل صنف من التكلفة قبل التسجيل، فيدخل المخزون بتكلفته الصافية. الأصناف تطابق بالكود ثم الباركود ثم الاسم')}</p>
                </div>
              )}
              {view.blockers.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[11px] text-[#8E2A1F]" role="alert">
                  <p className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle size={13} /> {tr('لا يمكن استيراد هذا الملف قبل تصحيحه')}</p>
                  {view.blockers.map((b, i) => <p key={i}>{tr(b)}</p>)}
                </div>
              )}
              {((view.warnings?.length ?? 0) > 0 || view.notices.length > 0) && (
                <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 space-y-0.5">
                  {view.notices.map((n, i) => <NoticeLine key={`n${i}`} n={n} tr={tr} />)}
                  {(view.warnings ?? []).map((w, i) => (
                    <p key={`w${i}`} className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {tr(w)}</p>
                  ))}
                </div>
              )}
              {view.columns.length > 0 && (
                <div className="border border-[#E9E1D3] rounded-xl p-3">
                  <p className="text-xs font-semibold text-gray-700 mb-2">{tr('عمود الملف ← الحقل')}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-[#6E6557]">
                        <th className="text-start font-medium pe-2 whitespace-nowrap">{tr('الحقل')}</th>
                        <th className="text-start font-medium pe-2 whitespace-nowrap">{tr('عمود الملف')}</th>
                        {view.rows.slice(0, 3).map((_, i) => (
                          <th key={i} className="text-start font-medium pe-2 whitespace-nowrap">{tr('صف')} <bdi>{view.sentFileRows[i] ?? i + 2}</bdi></th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {view.columns.map((c) => (
                          <tr key={c.field} className="border-t border-[#F1EBE0]">
                            <td className="pe-2 py-0.5 text-gray-700 whitespace-nowrap">{tr(importFieldLabel(c.field))}</td>
                            <td className={`pe-2 py-0.5 whitespace-nowrap ${c.header ? 'text-gray-800' : 'text-gray-400'}`}><bdi>{c.header || '—'}</bdi></td>
                            {view.rows.slice(0, 3).map((r, i) => {
                              const v = previewCellValue(r, c.field);
                              return <td key={i} className="pe-2 py-0.5 text-gray-600 max-w-[8rem] truncate" dir={typeof v === 'number' || v instanceof Date ? 'ltr' : undefined}><bdi className={typeof v === 'number' ? 'tabular-nums' : ''}>{cellText(v)}</bdi></td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {view.zeroPrice.required && (
                <label className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-[#8E2A1F] cursor-pointer select-none">
                  <input type="checkbox" className="mt-0.5" checked={zeroPriceAck} disabled={busy !== null}
                    onChange={(e) => { setZeroPriceAck(e.target.checked); setPreview({ ...preview, conflict: null }); }} />
                  <span>
                    <span className="font-semibold">{tr(ZERO_PRICE_ACK_KEY).replace('N', String(view.zeroPriceRows ?? 0))}</span>
                    <span className="block mt-0.5 text-[#6E6557]">{tr('وإلا فاحذف هذه الصفوف من الملف أو صحّح أسعارها ثم أعد رفعه')}</span>
                  </span>
                </label>
              )}
              {view.errors.length > 0 && (
                <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 max-h-40 overflow-y-auto">
                  <p className="text-xs font-semibold text-amber-800 flex items-center gap-1 mb-2"><AlertTriangle size={13} /> {tr('صفوف بها أخطاء')}</p>
                  {view.errors.slice(0, 20).map((er, i) => (
                    <p key={i} className="text-[11px] text-amber-700">{tr('صف')} {er.row}: {tr(er.message)}<RowErrorValue er={er} tr={tr} /></p>
                  ))}
                  {view.errors.length > 20 && <p className="text-[11px] text-amber-600 mt-1">+{view.errors.length - 20} …</p>}
                </div>
              )}

              {view.ledgerKind && view.chooserCtx && (
                <UndatedDateChooser ctx={view.chooserCtx} count={view.undated} input={undatedInput} onInput={setUndatedInput}
                  confirmed={undatedDate} onConfirm={(v) => { setUndatedDate(v); setPreview({ ...preview, conflict: null }); }}
                  onChange={() => { setUndatedInput(undatedDate ?? undatedInput); setUndatedDate(null); }} />
              )}
              {view.split && ledger && (
                <CutoverSplitNotice ctx={ledger} split={view.split} excludeAfter={excludeAfter}
                  onToggleExclude={(v) => { setExcludeAfter(v); setPreview({ ...preview, conflict: null }); }} />
              )}

              {preview.conflict?.type === 'duplicate' && preview.conflict.running && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900" role="alert">
                  <p className="font-semibold flex items-center gap-1"><Loader2 size={13} className="animate-spin" /> {tr('دفعة الملف نفسه قيد الاستيراد')}</p>
                  <p className="mt-1">
                    {tr('انتظر انتهاءها ثم راجع سجل الاستيرادات. لا تعد رفع الملف قبل ذلك')}
                    {preview.conflict.createdAt ? <> · {formatDateTime(preview.conflict.createdAt)}</> : null}
                  </p>
                  {retryConflictButton('إعادة الفحص')}
                </div>
              )}
              {preview.conflict?.type === 'duplicate' && !preview.conflict.running && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[11px] text-[#8E2A1F]" role="alert">
                  <p className="font-semibold flex items-center gap-1"><AlertTriangle size={13} /> {tr('هذا الملف استورد مسبقا')}</p>
                  <p className="mt-1">
                    {tr('توجد دفعة غير متراجع عنها بالمحتوى نفسه')}
                    {preview.conflict.createdAt ? <> · {formatDate(preview.conflict.createdAt)}</> : null}
                    {'. '}{tr(duplicateConsequenceKey(preview.kind))}
                  </p>
                  <button type="button" onClick={() => doImport({ force: true })} disabled={busy !== null}
                    className="mt-2 text-xs font-semibold text-red-700 border border-red-300 rounded-lg px-3 py-1.5 hover:bg-red-100 disabled:opacity-50">
                    {tr('استيراد رغم التكرار')}
                  </button>
                </div>
              )}
              {preview.conflict?.type === 'inProgress' && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900" role="alert">
                  <p className="font-semibold flex items-center gap-1"><Loader2 size={13} className="animate-spin" /> {tr('استيراد آخر جار الآن')}</p>
                  <p className="mt-1">
                    {tr(IMPORT_IN_PROGRESS_TEXT)}
                    {preview.conflict.kind ? <> · {tr(kindLabel(preview.conflict.kind))}</> : null}
                    {preview.conflict.createdAt ? <> · {formatDateTime(preview.conflict.createdAt)}</> : null}
                  </p>
                  {retryConflictButton('إعادة المحاولة')}
                </div>
              )}
              {preview.conflict?.type === 'invalidDate' && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[11px] text-[#8E2A1F] max-h-48 overflow-y-auto" role="alert">
                  <p className="font-semibold flex items-center gap-1"><AlertTriangle size={13} /> {tr('تواريخ غير صالحة في الملف')}</p>
                  <p className="mt-1">{tr('صحح التواريخ في الملف بصيغة يوم/شهر/سنة ثم أعد رفعه')}</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {preview.conflict.rows.slice(0, 20).map((r, i) => (
                      <li key={i}>{r.row > 0 ? <>{tr('صف')} {r.row}: </> : null}<bdi className="font-mono">{r.date || '—'}</bdi></li>
                    ))}
                  </ul>
                  {preview.conflict.rows.length > 20 && <p className="mt-1">+{preview.conflict.rows.length - 20} …</p>}
                </div>
              )}
              {preview.kind === OPENING_STOCK && stockGate.state === 'ack' && (
                <OpeningStockAckPanel cutoverDate={stockGate.cutoverDate} minCutoverDate={stockGate.minCutoverDate}
                  checked={stockAck} disabled={busy !== null} onChange={setStockAck} />
              )}
              {preview.conflict?.type === 'openingStock' && (
                <OpeningStockNote gate={{ state: 'blocked', reason: preview.conflict.reason, cutoverDate: preview.conflict.cutoverDate ?? null }} />
              )}
              {preview.conflict?.type === 'overlap' && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[11px] text-[#8E2A1F]" role="alert">
                  <p className="font-semibold flex items-center gap-1"><AlertTriangle size={13} /> {tr('عملاء لهم رصيد مستورد أو كشف سابق')}</p>
                  <p className="mt-1">{tr('استيراد الكشف فوق رصيد قائم قد يضاعف الذمة. راجع قبل المتابعة')}</p>
                  {preview.conflict.overlap.length > 0 && (
                    <table className="w-full mt-2 text-[11px]">
                      <thead><tr className="text-[#6E6557]">
                        <th className="text-start font-medium pe-2">{tr('العميل')}</th>
                        <th className="text-end font-medium pe-2">{tr('الرصيد القائم')}</th>
                        <th className="text-end font-medium">{tr('صافي الكشف')}</th>
                      </tr></thead>
                      <tbody>
                        {preview.conflict.overlap.slice(0, 15).map((o, i) => (
                          <tr key={o.customerId || i}>
                            <td className="pe-2">{o.customerName || o.customerId}</td>
                            <td className="text-end tabular-nums pe-2" dir="ltr">{String(o.existingBalance ?? '')}</td>
                            <td className="text-end tabular-nums" dir="ltr">{String(o.statementNet ?? '')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {preview.conflict.overlap.length > 15 && <p className="mt-1">+{preview.conflict.overlap.length - 15} …</p>}
                  <button type="button" onClick={() => doImport({ confirmOverlap: true })} disabled={busy !== null}
                    className="mt-2 text-xs font-semibold text-red-700 border border-red-300 rounded-lg px-3 py-1.5 hover:bg-red-100 disabled:opacity-50">
                    {tr('متابعة رغم التداخل')}
                  </button>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => doImport()}
                  disabled={busy !== null || importButtonBlocked({
                    rows: view.rows.length, blockers: view.blockers, needUndatedChoice: view.needUndatedChoice, conflict: !!preview.conflict,
                    stockBlocked: preview.kind === OPENING_STOCK && (stockAckInfo.blocksImport || stockGate.state === 'blocked'),
                    zeroPrice: view.zeroPrice,
                  })}
                  className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {tr('استيراد')} {view.rows.length} {tr('صف')}
                </button>
                <button onClick={() => setPreview(null)} disabled={busy !== null} className="btn-secondary">{tr('إلغاء')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* نتيجة الاستيراد */}
      {result && (() => {
        // البند 8: لون وعنوان بحسب النتيجة الفعلية، وخانات منفصلة للمكرر والصفري وغير المطابق والملتبس
        const rv = importResultView(result.res);
        const toneBox = rv.tone === 'success' ? 'bg-green-50' : rv.tone === 'warning' ? 'bg-amber-50' : 'bg-red-50';
        const ToneIcon = rv.tone === 'success' ? Check : rv.tone === 'warning' ? AlertTriangle : X;
        const toneIcon = rv.tone === 'success' ? 'text-green-600' : rv.tone === 'warning' ? 'text-amber-600' : 'text-red-600';
        const row = (n: number) => fileRowOf(result.fileRows, n);
        const w = result.res.warnings;
        const merged = w?.merged ?? [];
        const similar = w?.similar ?? [];
        const skippedRows = result.res.skippedRows ?? [];
        const attachedRows = result.res.attachedRows ?? [];
        const stat = (value: number, label: string, cls: string, show = true) => show ? (
          <div className="min-w-[4.5rem]"><p className={`text-xl font-bold tabular-nums ${cls}`}>{value}</p><p className="text-xs text-gray-500">{tr(label)}</p></div>
        ) : null;
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(() => setResult(null))}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="p-6 text-center">
                <div className={`w-14 h-14 ${toneBox} rounded-2xl flex items-center justify-center mx-auto mb-3`}><ToneIcon size={30} className={toneIcon} /></div>
                <h3 className="font-bold text-gray-800 mb-1" role={rv.tone === 'success' ? undefined : 'alert'}>{tr(rv.titleKey)} — {tr(IMPORT_TYPES[result.kind].label)}</h3>
                <div className="flex flex-wrap justify-center gap-x-5 gap-y-3 mt-4 text-sm">
                  {stat(rv.counts.created, 'أضيف', rv.counts.created > 0 ? 'text-green-700' : 'text-gray-400')}
                  {/* البند 7: الأسعار — ما استُبدل من أسعار قائمة كتابة فعلية منفصلة عن الإنشاء */}
                  {stat(rv.counts.updated, 'حُدّث', 'text-green-700', typeof result.res.updated === 'number')}
                  {stat(rv.counts.attached, 'ربط كود', 'text-green-700', rv.counts.attached > 0)}
                  {stat(rv.counts.skipped, 'مكرر تخطي', 'text-gray-500')}
                  {stat(rv.counts.zero, 'صفري', 'text-gray-500', typeof result.res.zero === 'number')}
                  {stat(rv.counts.notFound, 'عميل غير مطابق', 'text-red-600', rv.counts.notFound > 0)}
                  {stat(rv.counts.ambiguous, 'مطابقة ملتبسة', 'text-red-600', rv.counts.ambiguous > 0)}
                  {stat(rv.counts.otherErrors, 'خطأ', 'text-amber-600')}
                </div>
                {result.kind === OPENING_STOCK && typeof result.res.totalCost === 'number' && result.res.created > 0 && (
                  <p className="bg-[#FBF7F0] border border-[#E8E0D2] rounded-xl p-2.5 mt-4 text-[11px] text-[#6E6557] flex items-center justify-between">
                    <span>{tr('إجمالي التكلفة الصافية')}</span>
                    <bdi className="tabular-nums font-bold text-gray-800">{formatCurrency(result.res.totalCost)}</bdi>
                  </p>
                )}
                {/* البند 15: لم يُضف شيء لأن الأصناف مستوردة في دفعة سابقة ⇒ الطريق هو التراجع عنها */}
                {openingStockRevertHint(result.kind, result.res) && (
                  <p className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 mt-4 text-[11px] text-amber-900 text-right">
                    <AlertTriangle size={12} className="inline me-1" />
                    {tr(OPENING_STOCK_REVERT_HINT)}
                  </p>
                )}
                {(w?.undatedAsToday ?? 0) > 0 && (
                  <p className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 mt-4 text-[11px] text-amber-900 text-right">
                    <AlertTriangle size={12} className="inline me-1" />
                    {w!.undatedAsToday} {tr('صف بلا تاريخ أخذ تاريخ اليوم')}
                  </p>
                )}
                {merged.length > 0 && (
                  <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 mt-4 max-h-32 overflow-y-auto text-right">
                    <p className="text-[11px] font-semibold text-amber-800 mb-1">{tr('أسطر عميل واحد جُمعت')}</p>
                    {merged.slice(0, 15).map((m, i) => (
                      <p key={i} className="text-[11px] text-amber-700" title={(m.rows ?? []).map(row).join(', ')}>
                        <bdi>{m.customerName || '-'}</bdi> (<bdi className="tabular-nums">{m.rows?.length ?? 0}</bdi>) = <bdi className="tabular-nums" dir="ltr">{formatCurrency(Number(m.total ?? 0))}</bdi>
                      </p>
                    ))}
                    {merged.length > 15 && <p className="text-[11px] text-amber-600 mt-1">+{merged.length - 15} …</p>}
                  </div>
                )}
                {(skippedRows.length > 0 || similar.length > 0 || attachedRows.length > 0) && (
                  <div className="bg-[#FBF7F0] border border-[#E8E0D2] rounded-xl p-3 mt-4 max-h-32 overflow-y-auto text-right">
                    {/* البند 30: المنتجات لها أسبابها (الكود موجود / مكرر داخل الملف) بكود الصنف */}
                    {skippedRows.slice(0, 15).map((s, i) => (
                      <p key={`s${i}`} className="text-[11px] text-[#6E6557]">
                        {tr('صف')} {row(s.row)}{s.code ? <> (<bdi className="font-mono">{s.code}</bdi>)</> : null}
                        : {tr(result.kind === 'products' ? productSkipReasonKey(s.reason) : customerSkipReasonKey(s.reason))}
                      </p>
                    ))}
                    {skippedRows.length > 15 && <p className="text-[11px] text-gray-400">+{skippedRows.length - 15} …</p>}
                    {attachedRows.slice(0, 15).map((s, i) => (
                      <p key={`a${i}`} className="text-[11px] text-green-700">
                        {tr('صف')} {row(s.row)}{s.code ? <> (<bdi className="font-mono">{s.code}</bdi>)</> : null}: {tr(attachedCodeKey(s.matchedBy))}
                      </p>
                    ))}
                    {attachedRows.length > 15 && <p className="text-[11px] text-green-600">+{attachedRows.length - 15} …</p>}
                    {similar.slice(0, 15).map((s, i) => (
                      <p key={`m${i}`} className="text-[11px] text-amber-700">
                        {tr('صف')} {row(s.row)}{s.code ? <> (<bdi className="font-mono">{s.code}</bdi>)</> : null}: {tr(similarWarningKey(s.matchedBy))}
                      </p>
                    ))}
                    {similar.length > 15 && <p className="text-[11px] text-amber-600">+{similar.length - 15} …</p>}
                  </div>
                )}
                {(w?.skipped?.length ?? 0) > 0 && (
                  <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 mt-4 max-h-32 overflow-y-auto text-right">
                    <p className="text-[11px] font-semibold text-amber-800 mb-1">{tr('عملاء تخطي رصيدهم')}</p>
                    {w!.skipped!.slice(0, 15).map((s, i) => (
                      <p key={i} className="text-[11px] text-amber-700">{s.customerName || '-'}{s.reason ? `: ${tr(s.reason)}` : ''}</p>
                    ))}
                  </div>
                )}
                {result.res.errors.length > 0 && (
                  <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 mt-4 max-h-40 overflow-y-auto text-right">
                    {result.res.errors.slice(0, 20).map((er, i) => (
                      <p key={i} className="text-[11px] text-amber-700">
                        {tr('صف')} {row(er.row)}: {tr(importRowErrorKey(er))}<RowErrorValue er={er} tr={tr} />
                      </p>
                    ))}
                    {result.res.errors.length > 20 && <p className="text-[11px] text-amber-600 mt-1">+{result.res.errors.length - 20} …</p>}
                  </div>
                )}
                <button onClick={() => setResult(null)} className="btn-primary w-full justify-center py-2.5 mt-5">{tr('تم')}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
