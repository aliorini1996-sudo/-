import { forwardRef, useRef, useState, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import { formatCurrency, formatDate, formatDayOnly, formatTime, formatDateTime, paymentMethodLabels, getActiveCurrency } from '../utils/format';
import { methodLabelFor } from '../lib/paymentMethodsConfig';
import { currencyDecimals } from '../i18n/countries';
import { periodShape, statementFinalBalance, statementZone } from './statementFacts';
import { adjustTotals, receiveTotalQty, uncostedCount, isCosted, noticeRef, qtyByUnit, unitTotalsText } from './warehouseNoticeFacts';
import { factorOf, formatQty, roundQty, type UnitDef } from '../lib/units';
import { stockRequestToLabel, stockRequestApproverLabel, stockRequestTotalQty, type StockRequestTo, type StockRequestLine } from '../lib/stockRequest';
import { docLotsFrom, type DocLotLine } from '../lib/lots';
import { docLotRows, invoiceLotsOf, lotCellText, lotLineText, noticeHasLots, warehouseLineLots } from './docLots';
import { useTr } from '../i18n/strings';
import { elementToPdfBlob, shareOrDownloadPdf } from './pdf';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import { zatcaChipOf, zatcaDocView, type ZatcaDocView } from '../lib/zatca/docStatus';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import { PrintRefusedError, printThermalInvoice, printThermalReceipt } from './thermal';
import { receiptInvoicesFrom, receiptLinkView, type ReceiptInvoiceLink } from './receiptLinks';
import { backdropClose } from '../lib/backdropClose';
import { useBackClose } from '../lib/useBackClose';
import {
  LEGACY_THERMAL_ID, PRINT_NOTES, deviceProfilesFor, pdfProfileOf, printKindOf, profileDisplayName, profileFor, readPrintSettings,
} from '../lib/print/printSettings';
import { PRINT_LOOK_CSS, PrintLookContext, lookFor, lookNeedsCss, lookRootAttrs, qrSlotStyle, usePrintLook } from './printLook';
import { makePrintTexts, normalizePrintTexts, type PrintTexts } from '../lib/print/printTexts';
import { DocTextsContext, useDocTexts, usePrintTextsPreview } from './printTextsContext';
import { printPageNode } from './printPage';
import { currentPrintIdentity, usePrintDeviceChoice, withKindChoice } from './printDevice';
import PrintDeviceSheet from './PrintDeviceSheet';
import { printHtmlDirect, printNodeDirect, supportsDirect, transportFor, type PrintTransport } from './printDirect';
import { DIRECT_PRINT_FALLBACK, DirectPrintError } from '../lib/print/printErrors';
import { directPrintAvailable, printerForJob } from '../lib/print/transport/btSerial';
import { DirectPrintOverlay, useDirectPrint } from '../components/print/DirectPrintUi';
import { Share2, Download, Check, ArrowRight, Printer, X, AlertTriangle } from 'lucide-react';

// رمز QR كصورة PNG (data URL) بدل <canvas> — لأن html2canvas لا يلتقط محتوى الـcanvas
// عند توليد الـPDF فيختفي الرمز. الصورة (data URL) تُلتقط بثبات في PDF والطباعة والمشاركة.
/* `ec`/`scale`: حمولة المرحلة الثانية (نحو ٧٠٠ محرف: التوقيع والمفتاح العامّ والبصمة) تعطي نسخةً بضعفَي حُجَيرات
 * رمز المرحلة الأولى. والورقة تمرّ على html2canvas بمقياس 2 ثمّ على ضغطٍ في الـPDF، فالافتراضيّ (١٢٤px من مصدر
 * ٣٧٢px بتصحيح M) ينزل بها دون ٣ بكسل للحُجَيرة — وهو الحدّ الذي حُكم في `thermal.ts` بأنّ الماسح لا يقرؤه.
 * فالمرحلة الثانية تمرّر مقاساً أكبر وتصحيح L (والمعيار لا يشترط مستوى تصحيح)، والمرحلة الأولى كما هي اليوم. */
function QrImage({ value, size, ec = 'M', scale = 3 }: {
  value: string; size: number; ec?: 'L' | 'M' | 'Q' | 'H'; scale?: number;
}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size * scale, margin: 1, errorCorrectionLevel: ec })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [value, size, ec, scale]);
  // عنصر بنفس المقاس دائماً (يحجز المساحة)، وتظهر الصورة فور جهوزيتها قبل ضغط زر المشاركة
  return <img src={src || undefined} width={size} height={size} alt="QR" style={{ display: 'block', width: size, height: size }} />;
}

export interface Company {
  name: string;
  address?: string;
  taxNumber?: string;
  commercialReg?: string;
  phone?: string;
  email?: string;
  logo?: string | null;          // شعار (base64 data URL)
  primaryColor?: string | null;  // لون الترويسة (hex)
  headerStyle?: string | null;   // classic | banner | minimal
  countryCode?: string | null;   // ISO alpha-2 — يصل مع ردّ /company
  // فوترة ZATCA المرحلة الثانية (Z5.0 أنواع فقط — تصل مع ردّ /company؛ الخادم هو المرجع، انظر lib/zatcaRegime.ts)
  einvoiceProvider?: string | null;
  zatcaPhase2Enabled?: boolean;
  zatcaPhase2StartedAt?: string | null;
  zatcaRegime?: { phase: 1 | 2; mode?: 'live' | 'rehearsal'; blocked?: string | null } | null;
  // «إعدادات الطباعة» v1 — خام كما في العمود (null = سلوك اليوم). لا يُقرأ إلا عبر normalizePrintSettings (lib/print/printSettings.ts):
  // نسخة أحدث أو عطب ⇒ الافتراضي، فلا يطبع جوال قديم ورقةً لم يُصمَّم لها
  printSettings?: unknown;
  // «إدارة طرق الدفع» v1 — خام كما في العمود (null = الطرق الخمس بأسمائها الافتراضية). لا يُقرأ إلا عبر companyMethodsConfig
  // (lib/paymentMethodsConfig.ts): نسخة أحدث أو عطب ⇒ الافتراضي — ومنه تُبنى اختيارات السند أوف‑لاين وأسماؤه المطبوعة
  paymentMethodsConfig?: unknown;
  // «تتبّع اللوط» — يصلان مع ردّ /company، وغيابهما (نسخة قديمة) إطفاء؛ lotOnInvoice يطبع التشغيلة على فاتورة العميل (lotFlagsOf)
  lotTrackingEnabled?: boolean;
  lotOnInvoice?: boolean;
  // «نصوص المطبوعات» v1 — خام كما في العمود (null = نصوص اليوم). لا يُقرأ إلا عبر normalizePrintTexts (lib/print/printTexts.ts):
  // صياغة نصوص الفاتورة والسند وإخفاء غير الإلزامي منها ولغةٌ ثانية على الورقة
  printTexts?: unknown;
}

/**
 * تصنيف «مبسّطة/ضريبية» مطلبٌ سعوديّ من هيئة الزكاة والضريبة (ZATCA).
 * فلا يُطبع على مستند شركةٍ خارج السعودية — يوهم بامتثالٍ لنظامٍ لا يخصّها.
 * وغياب الدولة يُعامَل سعوديّةً لأنه افتراض العمود في المخطّط (@default("SA")).
 */
export const isSaudiDoc = (company?: Company | null): boolean =>
  (company?.countryCode ?? 'SA').toUpperCase() === 'SA';

export interface DocCustomer {
  name: string;
  businessName?: string;
  commercialReg?: string;
  taxNumber?: string;
  phone?: string;
  address?: string;
  city?: string;
  district?: string;
}

export interface InvoiceDoc {
  kind: 'invoice';
  number: string;
  date: string;
  type: 'CASH' | 'CREDIT';
  /** خطة السداد — «تقسيط» جدولٌ فوق البيع الآجل لا نوع فاتورة ثالث */
  paymentPlan?: 'IMMEDIATE' | 'INSTALLMENT' | null;
  installments?: { seq: number; dueDate: string | Date; amount: number }[];
  isReturn?: boolean;
  deliveryDate?: string; // تاريخ التسليم — يُعرض ويُطبع فقط إن حُدد
  /** توقيع المستلم اليدويّ (PNG base64) — يُطبع آخر الفاتورة مكان سطر «توقيع المستلم» */
  recipientSignature?: string | null;
  /** توقيع المندوب اليدويّ (PNG base64) — يُطبع مكان سطر «توقيع المندوب» */
  repSignature?: string | null;
  company?: Company | null;
  customer: DocCustomer;
  repName: string;
  items: {
    name: string; unit?: string; qty: number; unitPrice: number; discountPct: number; taxPct: number; lineTotal: number;
    /* الوحدات المتعددة: `unit` لقطة وحدة البند (unitName ?? product.unit) والكمية والسعر بها. `unitFactor` ≠ ١ أو
     * `multiUnit` (للصنف وحدات) ⇒ الوحدة تُطبع ولو أخفاها القالب: «٢» وحدها لا تقول أكرتونان أم حبّتان */
    unitFactor?: number | null; multiUnit?: boolean;
    // للمرتجع: صلاحية الصنف المقيسة على بيعه (services/invoiceExpiry.ts) — منتهٍ أم سارٍ وتاريخ الانتهاء
    returnExpired?: boolean | null; expiresAt?: string | null;
    // «تتبّع اللوط»: تشغيلات البند من ردّ الخادم (items[].lots ← docLotsFrom) — تُطبع بشرط company.lotOnInvoice
    lots?: DocLotLine[];
  }[];
  subtotal: number;   // صافٍ قبل الضريبة دائما
  discount: number;   // صافٍ قبل الضريبة دائما
  tax: number;
  total: number;
  /** اسعار البنود (unitPrice و lineTotal) شاملة الضريبة — فواتير تطبيق المندوب */
  pricesIncludeTax?: boolean;
  paidAmt?: number;
  remainingAmt?: number;
  einvoice?: { provider?: string | null; status?: string | null; uuid?: string | null; qr?: string | null } | null;
  /**
   * فوترة ZATCA المرحلة الثانية (Z5.6b) — عرض المستند الضريبي من الخادم، أو `null`/غياب للمرحلة الأولى.
   * وجودُه وحده يحوّل القالب إلى فرع المرحلة الثانية؛ فما لم يبنه `zatcaDocView` لا يتغيّر فيه شيء.
   */
  zatca?: ZatcaDocView | null;
  offline?: boolean; // أُنشئت دون اتصال — رقم مؤقّت، ترتفع للخادم عند الاتصال
}

/** مرفق سند قبض — صورة إيصال تحويل أو شيك بصيغة data URL */
export interface ReceiptPhoto { id: string; data: string }

export interface ReceiptDoc {
  kind: 'receipt';
  number: string;
  date: string;
  company?: Company | null;
  customer: DocCustomer;
  repName: string;
  amount: number;
  paymentMethod: string;
  /**
   * «إدارة طرق الدفع»: مفتاح الطريقة المخصّصة (c_…) — الاسم المطبوع يُحلّ من `company` بـmethodLabelFor. غيابه = مدمجة،
   * و`paymentMethod` يبقى الأساس (نقدي/شبكة/تحويل/شيك) كما اليوم.
   */
  paymentMethodKey?: string | null;
  notes?: string;
  /**
   * مرفقات رفعها المندوب عند الإصدار. **لا تدخل قالب الطباعة** —
   * انظر `ReceiptAttachments` لسبب فصلها عن المستند.
   * وتصل من `GET /receipts/:id` وحده؛ القائمة لا تُرجعها فتكون غائبة.
   */
  photos?: ReceiptPhoto[];
  offline?: boolean;
  /**
   * الفواتير التي خُصّص لها مبلغ السند — تُطبع «مقابل الفاتورة رقم …».
   * `undefined` = غير معروفة (لا يُطبع شيء)، و`[]` = مؤكَّدٌ أنه بلا فاتورة.
   * انظر `receiptLinks.ts`.
   */
  invoices?: ReceiptInvoiceLink[];
  /** سند ملغى يُعاد فتحه من كشف الحساب — يُوسَم كي لا يُسلَّم كسندٍ ساري */
  cancelled?: boolean;
}

export interface StatementEntry {
  date: string;
  description: string;
  ref?: string;
  debit: number;
  credit: number;
  balance: number;
  type?: string; // نوع القيد (INVOICE_DEBIT بيع · RECEIPT_CREDIT تحصيل · INVOICE_CREDIT مرتجع)
  items?: { name: string; qty: number; unit?: string; unitFactor?: number | null }[]; // أصناف الفاتورة (لعرضها في كشف الحساب)
}

export interface StatementDoc {
  kind: 'statement';
  company?: Company | null;
  customer: DocCustomer & { balance?: number; totalSales?: number; totalCollected?: number };
  repName: string;
  date: string;
  fromDate?: string;
  toDate?: string;
  /**
   * منطقة الشركة التي رشّح بها الخادم أيام الفترة (يعيدها مع الكشف، وقد تكون `null`).
   *
   * الورقة تُسلَّم للعميل: حركةٌ داخل الفترة بحسب الخادم يجب ألّا يُطبع بجانبها يومٌ
   * خارجها لأنّ جهاز المُصدِر في منطقةٍ أخرى. وغيابها ارتدادٌ صريح إلى منطقة الجهاز.
   */
  timezone?: string | null;
  entries: StatementEntry[];
  /** رصيد ما قبل الفترة — يُطبع صفّاً أوّل حين تكون للكشف بداية.
   *  بدونه يبدأ عمود الرصيد من رقمٍ لا تُنتجه أيّ حركةٍ في الورقة. */
  openingBalance?: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
  /** «الفرق»: كشف مشرف فريق — قيود فرقه وحدها وإجماليات العميل لفريقه؛ يُعنوَن بذلك كي لا يُقرأ رصيداً كاملاً للعميل */
  teamScoped?: boolean;
}

export interface SettlementEntry {
  settledAt: string;
  amount: number;
  by?: string;   // اسم مستخدم الشركة الذي استلم
  note?: string;
  /**
   * نوع الاستلام — قاموسٌ مغلق مطابقٌ لسند القبض حرفاً بحرف:
   * CASH · BANK_TRANSFER · POS · CHEQUE. والاستلامات السابقة لهذا العمود تصل
   * بلا قيمة فتُقرأ **نقديّاً** — وهو افتراض العمود على الخادم، لا تخميناً منّا.
   */
  method?: string;
}

/** سجلّ استلامات التحصيل لمندوب — لكل مندوب على حدة، قابل للتصدير PDF */
export interface SettlementLogDoc {
  kind: 'settlement';
  company?: Company | null;
  repName: string;
  date: string;
  entries: SettlementEntry[];
  total: number;
  collected?: number;
  outstanding?: number;
}

export interface LoadNoticeItem {
  name: string; qty: number; unit?: string; /** معامل وحدة السطر — ≠١ ⇒ الإجمالي لكل وحدة */ unitFactor?: number | null;
  /** «تتبّع اللوط»: تشغيلات البند (withLots=1 ← docLotsFrom) — سطرٌ لكل تشغيلة متى وُجدت، وكمّياتها بالأساس (D19) */
  lots?: DocLotLine[];
}

/** إشعار حركة بضاعة (تحميل/تنزيل/تسوية) لسيارة مندوب — قابل للتصدير PDF */
export interface LoadNoticeDoc {
  kind: 'loadNotice';
  company?: Company | null;
  repName: string;
  date: string;
  movementKind?: string; // LOAD | UNLOAD | ADJUST
  note?: string;
  by?: string;
  items: LoadNoticeItem[];
}

/** سطر إشعار المستودع — القيمة من الخادم (`lineCost`) لا تُحسب هنا */
export interface WarehouseNoticeItem {
  name: string;
  unit?: string;
  /** معامل وحدة السطر (لقطته) — الكمية وسعر الوحدة بها، و≠١ ⇒ الإجمالي لكل وحدة */
  unitFactor?: number | null;
  /** موجبٌ للوارد، وموجبٌ أو سالبٌ للتسوية */
  qty: number;
  /** صافٍ قبل الضريبة بأربع خانات — `null` = بلا سعر معروف */
  unitCost?: number | null;
  /** قيمة السطر كما قرّبها الخادم — مجموعها يطابق `totalCost` فلساً بفلس */
  lineCost?: number | null;
  /** «تتبّع اللوط»: تشغيلة السطر (سطرٌ = تشغيلةٌ واحدة، من `lot` في السجل) */
  lots?: DocLotLine[];
}

/**
 * إشعار حركة مستودع الشركة (وارد أو تسوية) — ورقةٌ تُوقَّع.
 *
 * منفصلٌ عن `LoadNoticeDoc` عمداً لا نسخةً معدّلة منه: ذاك إشعارٌ **لمندوب**
 * (بياناته وتوقيعه)، يطبع الكمّيات مطلقةً بلا إشارة ولا سعر. وإشعار المستودع
 * طرفاه أمين المستودع والمورّد، وتسويته **ذات إشارة** (زيادة أو نقص)، ووارده
 * **ذو قيمة** قبل الضريبة. وتحميلُ هذه الفروق على نوعٍ واحد كان سيطبع تسوية
 * «−١٠» على أنّها «١٠» بتوقيع مندوبٍ لا وجود له.
 */
export interface WarehouseNoticeDoc {
  kind: 'warehouseNotice';
  company?: Company | null;
  /** RECEIVE | ADJUST */
  entryType: string;
  /** مرجعٌ قصير مشتقّ من معرّف الحركة */
  ref: string;
  date: string;
  supplier?: string;
  note?: string;
  by?: string;
  items: WarehouseNoticeItem[];
  /** إجمالي الوارد قبل الضريبة — كما حسبه الخادم */
  totalCost: number;
}

/**
 * سطر ورقة طلب المخزون: `StockRequestLine` ومعه اختيارياً وحدات الصنف (الوحدات المتعددة) — الرصيد `onHand` بالأساس فيُطبع
 * «٢ كرتون و٣ حبة» بجانب طلبٍ بالكرتون لا رقماً يُقرأ كراتين، و`unitFactor` معامل وحدة الكمية المطلوبة (`unit`) فلا يُجمع
 * كرتونٌ وحبّةٌ في «إجمالي الكميات» رقماً واحداً. غيابها ⇒ الورقة كما كانت حرفاً.
 */
export type StockRequestDocLine = StockRequestLine & { unitFactor?: number | null; units?: UnitDef[] | null; baseUnit?: string | null };

/**
 * طلب مخزون (زيادة المستودع) يُرسَل لإدارة المشتريات أو الإنتاج — انظر `lib/stockRequest.ts`.
 * ورقة طلبٍ لا حركة: لا قيمة فيها ولا تغيّر رصيداً، فلا يُحفظ لها سجلّ في الخادم.
 */
export interface StockRequestDoc {
  kind: 'stockRequest';
  company?: Company | null;
  /** `SR-…` من لحظة الإصدار */
  ref: string;
  date: string;
  to: StockRequestTo;
  /** «مطلوب قبل» — يومٌ بصيغة YYYY-MM-DD، اختياري */
  neededBy?: string;
  note?: string;
  /** مقدّم الطلب: المستخدم الذي أصدره */
  by?: string;
  items: StockRequestDocLine[];
  /** طلبات المناديب التي أُرسلت ضمنه — تفصيلٌ لمن يجهّز التحميل بعد وصول البضاعة */
  reps?: { name: string; items: { name: string; unit?: string; qty: number }[] }[];
}

export type AnyDoc = InvoiceDoc | ReceiptDoc | StatementDoc | SettlementLogDoc | LoadNoticeDoc | WarehouseNoticeDoc | StockRequestDoc;

/**
 * تُطبع وحدة البند؟ خيار القالب (showItemUnit)، **أو** بندٌ بغير وحدة الأساس، أو صنفٌ له وحدات — فخيار «إخفاء الوحدة»
 * يبقى لشركةٍ بوحدةٍ واحدة لكل صنف، ولا يصير «٢ × ٤٨» على فاتورةٍ ضريبية لغزاً: أكرتونان أم حبّتان؟
 */
export function showsItemUnit(it: { unit?: string; unitFactor?: number | null; multiUnit?: boolean }, showItemUnit: boolean): boolean {
  return !!it.unit && (showItemUnit || it.multiUnit === true || factorOf(it) !== 1);
}

function fullAddress(c: { address?: string; district?: string; city?: string }): string {
  return [c.address, c.district, c.city].filter(Boolean).join('، ');
}

const PAGE: React.CSSProperties = {
  width: 794,
  minHeight: 1000,
  background: '#fff',
  padding: 40,
  boxSizing: 'border-box',
  fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif",
  color: '#1f2937',
  direction: 'rtl',
};

const BRAND = '#1e3a8a';

// لون الترويسة الفعلي من إعدادات الشركة (أو الافتراضي)
export function brandColor(company?: Company | null): string {
  return company?.primaryColor || BRAND;
}

// ─── «نصوص المطبوعات» (lib/print/printTexts.ts): صياغة الشركة وإخفاؤها ولغتها الثانية — للفاتورة والسند وحدهما ───

/** محلِّل نصوص الفاتورة/السند من صفّ الشركة (ومعاينة المحرّر إن لفّته) — و`standard` من قرار الطباعة لا من التخمين */
function useTextsFor(company: Company | null | undefined, standard: boolean, uiTr: (ar: string) => string): PrintTexts {
  const preview = usePrintTextsPreview();
  const raw = company?.printTexts;
  const texts = useMemo(() => normalizePrintTexts(raw), [raw]);
  return useMemo(() => makePrintTexts(texts, uiTr, { standard, preview }), [texts, uiTr, standard, preview]);
}

/** سطر اللغة الثانية بجانب العربي (A4 عريضة) أو تحته (رؤوس الأعمدة والعنوان) — معزولٌ اتجاهاً كي لا تنقلب علاماته */
// الهامش يمينٌ صريح: الورقة RTL دائماً والسطر اللاتيني على يسار العربي — وinline-start لعنصرٍ ltr يقع يساره فيلتصق النصّان
const ALT_INLINE: React.CSSProperties = { fontSize: '0.8em', fontWeight: 400, opacity: 0.72, marginRight: 6, unicodeBidi: 'isolate' };
const ALT_STACK: React.CSSProperties = { display: 'block', fontSize: '0.78em', fontWeight: 400, opacity: 0.85, unicodeBidi: 'isolate' };

/** نصٌّ قابلٌ للنقر في معاينة المحرّر (والمخفيُّ في الإعداد باهتٌ مشطوب) — وخارج المعاينة محتواه كما هو */
function Pick({ pt, k, children }: { pt: PrintTexts; k: string; children: React.ReactNode }) {
  const p = pt.preview;
  if (!p) return <>{children}</>;
  const off = pt.hiddenInSettings(k);
  return (
    <span data-pt-key={k} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onPick(k); }}
      style={{ cursor: 'pointer', borderRadius: 3, outline: p.active === k ? '2px solid #E15A30' : '1px dashed rgba(225,90,48,0.55)', outlineOffset: 1, ...(off ? { textDecoration: 'line-through', opacity: 0.35 } : null) }}>
      {children}
    </span>
  );
}

/**
 * مُنشئ التسميات `L(key, ar)`: صياغة الشركة (أو `tr(ar)` كاليوم) ومعها سطر اللغة الثانية بجانبها أو تحتها (stack). بلا لغةٍ ثانية
 * ولا معاينة يعيد السلسلة نفسها — فلا يتغيّر DOM شركةٍ بلا نصوص حرفاً. `suffix` (نسبة الضريبة) يُلحق بالعربي وحده — مرّةً واحدة.
 */
function labeler(pt: PrintTexts) {
  return (key: string, ar: string, o?: { suffix?: string; stack?: boolean }): React.ReactNode => {
    const text = o?.suffix ? `${pt.text(key, ar)} ${o.suffix}` : pt.text(key, ar);
    const alt0 = pt.alt(key, ar);
    if (!alt0 && !pt.preview) return text;
    const alt = alt0 ? <span dir="ltr" style={o?.stack ? ALT_STACK : ALT_INLINE}>{alt0}</span> : null;
    return <Pick pt={pt} k={key}>{text}{alt}</Pick>;
  };
}

/** قيمةٌ ثابتة من القاموس (نقدي/آجل/تقسيط وعبارات القرار) بلغة القالب، وبجانبها اللغة الثانية — لا تُعاد صياغتها */
function valuer(pt: PrintTexts) {
  return (ar: string): React.ReactNode => {
    const text = pt.tr(ar);
    const alt = pt.valueAlt(ar, text);
    return alt ? <>{text}<span dir="ltr" style={ALT_INLINE}>{alt}</span></> : text;
  };
}

/** عنوان المستند للترويسة: العربي وتحته اللغة الثانية — وفي المعاينة قابلٌ للنقر */
function titleNode(pt: PrintTexts, key: string, t: { text: string; alt: string | null }): React.ReactNode {
  if (!t.alt && !pt.preview) return t.text;
  return <Pick pt={pt} k={key}>{t.text}{t.alt ? <span dir="ltr" style={{ display: 'block', fontSize: '0.62em', fontWeight: 600, opacity: 0.85, unicodeBidi: 'isolate' }}>{t.alt}</span> : null}</Pick>;
}

/**
 * جذر الورقة بمظهر الطباعة (rep/printLook.ts): حشوته، وسماته (أحادي اللون/خط عريض/مقاس الـPDF)، وأسلوبه المحصور آخرَ
 * عنصرٍ فيه (فتبقى الترويسة أولاً — بعدها يُدرج سطر «الأصل/نسخة» في rep/printPage.ts). المظهر الافتراضي يعيد PAGE نفسه
 * بلا سمةٍ ولا أسلوب: DOM اليوم كما هو لكل شركةٍ بلا «إعدادات الطباعة».
 */
function useSheet(): { style: React.CSSProperties; attrs: ReturnType<typeof lookRootAttrs>; css: React.ReactNode } {
  const look = usePrintLook();
  return {
    style: look.pagePadding === PAGE.padding ? PAGE : { ...PAGE, padding: look.pagePadding },
    attrs: lookRootAttrs(look),
    css: lookNeedsCss(look) ? <style>{PRINT_LOOK_CSS}</style> : null,
  };
}

export function Header({ title, company }: { title: React.ReactNode; company?: Company | null }) {
  const uiTr = useTr();
  /* مظهر الطباعة (rep/printLook.ts): الإبرية ترويستها «بسيط» إجباراً، والشعار والعنوان والهاتف والبريد خيارات القالب —
   * واسم الشركة ورقمها الضريبي وسجلّها والعنوان (title) لا تُخفى بأيّ مظهر. والمظهر الافتراضي = ترويسة اليوم حرفياً. */
  const look = usePrintLook();
  /* «نصوص المطبوعات»: الفاتورة والسند يوفّران محلِّلهما (DocTextsContext) — صياغة التسميات ولغةٌ ثانية واسم الشركة بها، والهاتف
   * والبريد يُخفيان؛ والرقم الضريبي والسجل والعنوان إلزامية لا تُخفى. بقية المستندات بلا محلِّل فتطبع ترويستها كاليوم. */
  const docPt = useDocTexts();
  const pt = useMemo(() => docPt ?? makePrintTexts(null, uiTr), [docPt, uiTr]);
  const tr = pt.tr;
  const L = labeler(pt);
  const nameAlt = pt.companyNameAlt
    ? <span dir="ltr" style={{ display: 'block', fontSize: '0.62em', fontWeight: 600, opacity: 0.8, unicodeBidi: 'isolate' }}>{pt.companyNameAlt}</span>
    : null;
  const brand = brandColor(company);
  const style = look.minimalHeader ? 'minimal' : (company?.headerStyle || 'classic');
  const logo = look.showLogo ? (company?.logo || null) : null;

  const line = (label: React.ReactNode, value?: string, light?: boolean, valueAlt?: string | null) =>
    value ? <div style={{ fontSize: 11.5, color: light ? 'rgba(255,255,255,0.9)' : '#4b5563' }}>
      <span style={{ color: light ? 'rgba(255,255,255,0.65)' : '#9ca3af' }}>{label}: </span>{value}{valueAlt ? <span dir="ltr" style={ALT_INLINE}>{valueAlt}</span> : null}</div> : null;

  const Logo = ({ size }: { size: number }) =>
    logo ? <img src={logo} alt="" style={{ width: size, height: size, objectFit: 'contain', borderRadius: 6 }} /> : null;

  const infoLines = (light?: boolean) => (
    <>
      {look.showContact && line(L('h.address', 'العنوان'), company?.address, light, pt.companyAddressAlt)}
      {line(L('h.taxNumber', 'الرقم الضريبي'), company?.taxNumber, light)}
      {line(L('h.commercialReg', 'السجل التجاري'), company?.commercialReg, light)}
      {look.showContact && !pt.hidden('h.phone') && line(L('h.phone', 'هاتف'), company?.phone, light)}
      {look.showContact && !pt.hidden('h.email') && line(L('h.email', 'البريد'), company?.email, light)}
    </>
  );

  // شكل "بانر": شريط ملوّن كامل بالشعار والاسم باللون الأبيض
  if (style === 'banner') {
    return (
      <div style={{ marginBottom: 20 }}>
        <div style={{ background: brand, borderRadius: 12, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Logo size={46} />
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{company?.name || tr('اسم الشركة')}{nameAlt}</div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{title}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>{infoLines(false)}</div>
      </div>
    );
  }

  // شكل "بسيط": خط رفيع وألوان هادئة
  if (style === 'minimal') {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `1px solid #e5e7eb`, paddingBottom: 14, marginBottom: 20 }}>
        <div style={{ maxWidth: 440 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <Logo size={34} />
            <div style={{ fontSize: 19, fontWeight: 700, color: '#1f2937' }}>{company?.name || tr('اسم الشركة')}{nameAlt}</div>
          </div>
          {infoLines(false)}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: brand }}>{title}</div>
      </div>
    );
  }

  // الشكل الكلاسيكي (افتراضي): الشعار + الاسم يميناً، العنوان يساراً، حد سفلي ملوّن
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `3px solid ${brand}`, paddingBottom: 16, marginBottom: 20 }}>
      <div style={{ maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Logo size={42} />
          <div style={{ fontSize: 20, fontWeight: 700, color: brand }}>{company?.name || tr('اسم الشركة')}{nameAlt}</div>
        </div>
        {infoLines(false)}
      </div>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: brand }}>{title}</div>
      </div>
    </div>
  );
}

function InfoBox({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ color: '#6b7280', fontSize: 13 }}>{label}: </span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span>
    </div>
  );
}

// ============ قالب الفاتورة ============
export const PrintableInvoice = forwardRef<HTMLDivElement, { doc: InvoiceDoc }>(({ doc }, ref) => {
  const uiTr = useTr();
  const sheet = useSheet();
  // خيارات القالب: اسم المندوب ووحدة الصنف والتوقيعات والتذييل — ولا خيار يمسّ العنوان أو الرمز أو الضريبة (§1.6)
  const look = usePrintLook();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '10px 8px', fontSize: 13, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '9px 8px', fontSize: 13, textAlign: 'center', borderBottom: '1px solid #eef2f7' };

  const addr = fullAddress(doc.customer);
  // تصنيف الفاتورة وفق ZATCA: مبسّطة (B2C) إن لم يكن للعميل رقم ضريبي، وقياسية (B2B) إن وُجد
  const isSimplified = !doc.customer.taxNumber;
  /* فوترة ZATCA المرحلة الثانية (Z5.6b، نقد الخطة 6): القرار الواحد قبل القالب — عنوانه ورمزه وهل يُظهر ضريبة.
   * `doc.zatca` فارغ لكلّ من لم يُفعَّل، فالقرار يعود `phase1` والقالب أدناه كما هو اليوم حرفاً بحرف. */
  const zDecision = zatcaPrintDecision(
    { isReturn: !!doc.isReturn, buyerHasTaxNumber: !isSimplified, saudi: isSaudiDoc(doc.company) },
    doc.zatca,
  );
  /* «نصوص المطبوعات»: صياغة الشركة وإخفاؤها ولغتها الثانية (L للتسميات، V للقيم الثابتة) — و`tr` لما ليس في القائمة: لغة
   * الواجهة كاليوم، أو العربية لشركةٍ لها نصوص. العنوان من القرار دائماً، وصياغة الشركة له لمستندات المرحلة الأولى وحدها. */
  const pt = useTextsFor(doc.company, zDecision.standardLayout, uiTr);
  const tr = pt.tr;
  const L = labeler(pt);
  const V = valuer(pt);
  const docTitle = pt.title(zDecision.title, { isReturn: !!doc.isReturn, phase2: !!doc.zatca });
  const custBoxShown = !pt.hidden('cust.heading') || !pt.hidden('cust.name') || !!doc.customer.taxNumber
    || (!!doc.customer.businessName && !pt.hidden('cust.business')) || (!!doc.customer.commercialReg && !pt.hidden('cust.commercialReg'))
    || (!!doc.customer.phone && !pt.hidden('cust.phone')) || (!!fullAddress(doc.customer) && !pt.hidden('cust.address'));
  /* رمز QR للمرحلة الأولى — يُبنى محلياً من إعدادات الشركة. لا يُبنى أبداً لصفٍّ من المرحلة الثانية:
   * رمزه مختومٌ من الخادم، ورمزٌ من صنعنا فوق عنوان «فاتورة ضريبية» ورقةٌ كاذبة. */
  const qrValue = zDecision.qr.source === 'phase1' && doc.company?.taxNumber
    ? buildZatcaQr({
        sellerName: doc.company.name || '',
        vatNumber: doc.company.taxNumber,
        timestamp: zatcaTimestamp(doc.date),
        total: doc.total,
        vatTotal: doc.tax,
      })
    : null;
  // النسبة من البنود لا من قسمة المبالغ — قسمة المبالغ تطبع نسبة مدمجة عند اختلاط النسب
  const vatPcts = [...new Set(doc.items.map(it => Number(it.taxPct)))];
  const vatRate = vatPcts.length === 1 ? `${vatPcts[0]}%` : tr('نسب متعددة');
  // العلم الصريح هو المرجع؛ والاستدلال الحسابي احتياط للفواتير القليلة التي كُتبت
  // في نافذة الالتباس (بين نشر الاسعار الشاملة ورد العمودين الى الصافي) قبل وجود العمود
  const inclusiveDoc = doc.pricesIncludeTax ?? (doc.tax > 0 && Math.abs((doc.subtotal - doc.discount) - doc.total) < 0.005);
  return (
    <DocTextsContext.Provider value={pt}>
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={titleNode(pt, doc.isReturn ? 'inv.returnTitle' : 'inv.title', docTitle)} company={doc.company} />

      {/* المرحلة الثانية: بيئة المحاكاة تُوسَم على الورقة نفسها — ورقة بروفة لا تُقرأ فاتورةً حقيقية */}
      {zDecision.watermark && (
        <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, fontWeight: 700, textAlign: 'center' }}>
          {tr(zDecision.watermark)}
        </div>
      )}
      {/* سند التسليم والمستند المُبطل: سبب الورقة مكتوبٌ عليها لا في شاشةٍ تُغلق */}
      {zDecision.notice && (
        <div style={{ background: zDecision.kind === 'void' ? '#FEE2E2' : '#EFF6FF', border: `1px solid ${zDecision.kind === 'void' ? '#FCA5A5' : '#BFDBFE'}`, color: zDecision.kind === 'void' ? '#991B1B' : '#1E40AF', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, lineHeight: 1.7 }}>
          {tr(zDecision.notice)}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 20 }}>
        <div style={{ flex: 1, background: doc.isReturn ? '#fffbeb' : '#eff6ff', borderRadius: 10, padding: 14 }}>
          {!pt.hidden(doc.isReturn ? 'inv.returnInfoHeading' : 'inv.infoHeading') && <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{doc.isReturn ? L('inv.returnInfoHeading', 'بيانات المرتجع') : L('inv.infoHeading', 'بيانات الفاتورة')}</div>}
          <InfoBox label={doc.isReturn ? L('inv.returnNumber', 'رقم المرتجع') : L('inv.number', 'رقم الفاتورة')} value={doc.number} />
          <InfoBox label={L('inv.date', 'التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={L('inv.time', 'وقت الإصدار')} value={formatTime(doc.date)} />
          {!doc.isReturn && !pt.hidden('inv.type') && <InfoBox label={L('inv.type', 'النوع')} value={
            doc.paymentPlan === 'INSTALLMENT' ? V('تقسيط') : (doc.type === 'CASH' ? V('نقدي') : V('آجل'))
          } />}
          {doc.deliveryDate && <InfoBox label={L('inv.deliveryDate', 'تاريخ التسليم')} value={formatDate(doc.deliveryDate)} />}
          {look.showRepName && !pt.hidden('inv.rep') && <InfoBox label={L('inv.rep', 'المندوب')} value={doc.repName} />}
        </div>
        {/* صندوق العميل كلّه حين تُخفي الشركة كل صفوفه (المبسّطة) — لا مستطيلاً رمادياً فارغاً؛ ويأخذ صندوق الفاتورة العرض */}
        {custBoxShown && <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          {!pt.hidden('cust.heading') && <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{L('cust.heading', 'بيانات العميل')}</div>}
          {!pt.hidden('cust.name') && <InfoBox label={L('cust.name', 'الاسم')} value={doc.customer.name} />}
          {doc.customer.businessName && !pt.hidden('cust.business') && <InfoBox label={L('cust.business', 'المنشأة')} value={doc.customer.businessName} />}
          {doc.customer.commercialReg && !pt.hidden('cust.commercialReg') && <InfoBox label={L('cust.commercialReg', 'السجل التجاري')} value={doc.customer.commercialReg} />}
          {doc.customer.taxNumber && <InfoBox label={L('cust.taxNumber', 'الرقم الضريبي')} value={doc.customer.taxNumber} />}
          {doc.customer.phone && !pt.hidden('cust.phone') && <InfoBox label={L('cust.phone', 'الجوال')} value={doc.customer.phone} />}
          {addr && !pt.hidden('cust.address') && <InfoBox label={L('cust.address', 'العنوان')} value={addr} />}
        </div>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{L('col.item', 'الصنف', { stack: true })}</th>
            <th style={th}>{L('col.qty', 'الكمية', { stack: true })}</th>
            {/* سند التسليم ينفي عن نفسه الصفة الضريبية، فلا يصرّح عمودُه بأنّ سعره شامل ضريبة القيمة المضافة */}
            <th style={th}>{zDecision.showTaxBreakdown && inclusiveDoc ? L('col.priceIncl', 'السعر شامل الضريبة', { stack: true }) : L('col.price', 'السعر', { stack: true })}</th>
            {!pt.hidden('col.discount') && <th style={th}>{L('col.discount', 'الخصم', { stack: true })}</th>}
            {zDecision.showTaxBreakdown && !pt.hidden('col.tax') && <th style={th}>{L('col.tax', 'الضريبة', { stack: true })}</th>}
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{L('col.total', 'الإجمالي', { stack: true })}</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <span style={{ fontWeight: 600 }}>{it.name}</span>
                {showsItemUnit(it, look.showItemUnit) && <span style={{ color: '#9ca3af', fontSize: 11 }}> ({it.unit})</span>}
                {/* المرتجع: هل عاد الصنف بعد انتهاء صلاحيته (من تاريخ بيعه) — لا يظهر لصنفٍ بلا صلاحية أو بلا بيعٍ سابق */}
                {doc.isReturn && it.returnExpired != null && it.expiresAt && (
                  <div style={{ fontSize: 10.5, marginTop: 2, fontWeight: 600, color: it.returnExpired ? '#dc2626' : '#1E7A52' }}>
                    {it.returnExpired
                      ? `${tr('منتهي الصلاحية')} · ${formatDayOnly(it.expiresAt)}`
                      : `${tr('ساري الصلاحية')} · ${tr('حتى')} ${formatDayOnly(it.expiresAt)}`}
                  </div>
                )}
                {/* «تتبّع اللوط»: سطرٌ لكل تشغيلة بشرط lotOnInvoice — النصّ نفسه في الشريط الحراري (rep/docLots.ts) */}
                {invoiceLotsOf(doc.company, it).map((l, k) => (
                  <div key={k} style={{ fontSize: 10.5, marginTop: 2, color: '#6b7280' }}>{lotLineText(l, { tr, unitFactor: it.unitFactor })}</div>
                ))}
              </td>
              <td style={td}>{it.qty}</td>
              <td style={td}>
                {formatCurrency(it.unitPrice)}
                {/* الفاتورة الضريبية القياسية توجب اظهار سعر الوحدة غير شامل الضريبة — والتصنيف من القرار
                    (مصدره الخادم في المرحلة الثانية) لا من رقم المشتري الضريبي، وإلا خالف الجسمُ العنوان */}
                {zDecision.showTaxBreakdown && inclusiveDoc && zDecision.standardLayout && it.taxPct > 0 && (
                  <div style={{ color: '#9ca3af', fontSize: 10.5, marginTop: 2 }}>
                    {L('item.beforeTax', 'قبل الضريبة')}: {formatCurrency((it.unitPrice * 100) / (100 + Number(it.taxPct)))}
                  </div>
                )}
              </td>
              {!pt.hidden('col.discount') && <td style={td}>{it.discountPct > 0 ? `${it.discountPct}%` : '-'}</td>}
              {zDecision.showTaxBreakdown && !pt.hidden('col.tax') && <td style={td}>{it.taxPct}%</td>}
              <td style={{ ...td, fontWeight: 700 }}>{formatCurrency(it.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {zDecision.showTaxBreakdown && inclusiveDoc && (
        <div style={{ fontSize: 10.5, color: '#9ca3af', marginBottom: 10 }}>
          {L('note.pricesIncl', 'الأسعار المعروضة شاملة ضريبة القيمة المضافة')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 }}>
        {/* رمز QR / معرّف الاعتماد للفاتورة الإلكترونية */}
        {(() => {
          const einv = doc.einvoice;
          const gov = !!einv?.provider && ['eta', 'peppol', 'ttn'].includes(einv.provider);
          const box: React.CSSProperties = { background: '#fff', padding: 6, border: '1px solid #eef2f7', borderRadius: 8, display: 'block', width: 'fit-content', margin: '0 auto' };
          /* «إعدادات الطباعة» M3: النقطية خانةٌ أكبر تحمل قيمة الرمز (data-qr-value) فيُرسم فيها بنقاط صحيحة في البلوتوث المباشر
           * (lib/print/raster.ts) — والصورة أدناه كما هي. القيمة من القرار أو من رمز المرحلة الأولى المحروس، لا تُبنى هنا.
           * المظهر بلا خانة (كل ما عدا النقطية) لا يضيف سمةً ولا أسلوباً: الصندوق كاليوم. */
          const slotBox: React.CSSProperties = { ...box, ...qrSlotStyle(look) };
          /* المرحلة الثانية أوّلاً: الرمز المختوم كما أعاده الخادم (لا بناء محليّ)، ومعه تسلسل المستند ومعرّفه
           * الفريد — بهما تُطابَق الورقةُ سجلَّ الهيئة. وبلا رمزٍ (سند تسليم أو مستند معلَّق) يُكتب السبب. */
          if (doc.zatca) {
            if (zDecision.qr.source === 'stamped' && zDecision.qr.value) {
              return (
                <div style={{ textAlign: 'center' }}>
                  <div style={slotBox} data-qr-value={look.qrSlotPx ? zDecision.qr.value : undefined} data-qr-ec={look.qrSlotPx ? 'L' : undefined}><QrImage value={zDecision.qr.value} size={176} ec="L" scale={4} /></div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, maxWidth: 160 }}>{tr(zDecision.qr.caption || '')}</div>
                  <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2, maxWidth: 160, wordBreak: 'break-all', direction: 'ltr' }}>
                    {doc.zatca.icv !== null ? `ICV ${doc.zatca.icv}` : ''}{doc.zatca.uuid ? ` · ${doc.zatca.uuid}` : ''}
                  </div>
                </div>
              );
            }
            return (
              <div style={{ fontSize: 10.5, color: '#b45309', maxWidth: 190, lineHeight: 1.7, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
                {tr('لا يحمل هذا المستند رمز فاتورة ضريبية')}
              </div>
            );
          }
          // فاتورة إلكترونية حكومية معتمدة (لها UUID) — عرض رمزها ومعرّفها
          if (gov && einv?.uuid) {
            return (
              <div style={{ textAlign: 'center' }}>
                <div style={box}><QrImage value={einv.qr || einv.uuid} size={108} /></div>
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, maxWidth: 150 }}>{tr('معرف الفاتورة الإلكترونية')}</div>
                <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2, maxWidth: 150, wordBreak: 'break-all', direction: 'ltr' }}>{einv.uuid}</div>
              </div>
            );
          }
          // ZATCA (السعودية) — رمز محلي مبنيّ من بيانات الفاتورة
          if (qrValue) {
            return (
              <div style={{ textAlign: 'center' }}>
                {/* display:block (لا inline-block) — html2canvas يُسقط inline-block المحاط بحدّ فيختفي الرمز في الـPDF */}
                <div style={slotBox} data-qr-value={look.qrSlotPx ? qrValue : undefined} data-qr-ec={look.qrSlotPx ? 'M' : undefined}><QrImage value={qrValue} size={108} /></div>
                {!pt.hidden('qr.caption') && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, maxWidth: 130 }}>{L('qr.caption', 'رمز الاستجابة السريعة للفاتورة الضريبية')}</div>}
              </div>
            );
          }
          // مزوّد حكومي لكن الفاتورة بانتظار الاعتماد
          if (gov) {
            return (
              <div style={{ fontSize: 10.5, color: '#b45309', maxWidth: 175, lineHeight: 1.6, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
                {tr('قيد الاعتماد لدى منظومة الفوترة الإلكترونية')}
              </div>
            );
          }
          return (
            <div style={{ fontSize: 10.5, color: '#9ca3af', maxWidth: 170, lineHeight: 1.6 }}>
              {tr('أضف الرقم الضريبي للشركة في إعدادات الشركة لإظهار رمز الفاتورة الضريبية المعتمد')}
            </div>
          );
        })()}

        <div style={{ width: pt.lang ? 340 : 300, fontSize: 14 }}>
          {!pt.hidden('tot.subtotal') && <Row label={L('tot.subtotal', 'المجموع قبل الخصم')} value={formatCurrency(doc.subtotal)} />}
          {doc.discount > 0 && !pt.hidden('tot.discount') && <Row label={L('tot.discount', 'الخصم')} value={`- ${formatCurrency(doc.discount)}`} color="#dc2626" />}
          {/* سند التسليم ورقةٌ غير ضريبية: لا وعاء ولا نسبة ولا مبلغ ضريبة عليها — وإلا قُرئت فاتورةً ضريبية */}
          {zDecision.showTaxBreakdown && doc.tax > 0 && <Row label={L('tot.taxable', 'الوعاء الخاضع للضريبة')} value={formatCurrency(doc.total - doc.tax)} />}
          {zDecision.showTaxBreakdown && <Row label={inclusiveDoc
            ? L('tot.vatIncl', 'منها ضريبة القيمة المضافة', { suffix: vatRate })
            : L('tot.vat', 'ضريبة القيمة المضافة', { suffix: vatRate })} value={formatCurrency(doc.tax)} color="#1E7A52" />}
          {/* ورقةٌ بلا تفصيل ضريبة وأسعارها غير شاملة: «المجموع − الخصم» لا يساوي الإجمالي، والفرق بلا سطر يفسّره.
              فيقوله عنوانُ السطر نفسه — بلا نسبة ولا وعاء، فتبقى الورقة غير ضريبية */}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: `2px solid ${brand}`, marginTop: 6, fontWeight: 700, fontSize: 18, color: doc.isReturn ? '#b45309' : brand }}>
            <span>{doc.isReturn ? L('tot.returnGrand', 'إجمالي المرتجع دائن')
              : !zDecision.showTaxBreakdown && !inclusiveDoc && doc.tax > 0 ? V('المبلغ المستحق شامل الضرائب')
              : L('tot.grand', 'الإجمالي النهائي')}</span>
            <span>{formatCurrency(doc.total)}</span>
          </div>
          {!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined && (
            <>
              {!pt.hidden('tot.paid') && <Row label={L('tot.paid', 'المدفوع')} value={formatCurrency(doc.paidAmt ?? 0)} color="#16a34a" />}
              {!pt.hidden('tot.remaining') && <Row label={L('tot.remaining', 'المتبقي')} value={formatCurrency(doc.remainingAmt)} color="#dc2626" />}
            </>
          )}
        </div>
      </div>

      {/* جدول الأقساط — الورقة تُثبت صحّتها للعميل: سطر المجموع يقابل الإجمالي */}
      {!doc.isReturn && doc.paymentPlan === 'INSTALLMENT' && (doc.installments?.length ?? 0) > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: '#1F1A13' }}>{L('inst.heading', 'جدول الأقساط')}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...th, borderRadius: '8px 0 0 0' }}>#</th>
                <th style={th}>{L('inst.dueDate', 'تاريخ الاستحقاق', { stack: true })}</th>
                <th style={{ ...th, borderRadius: '0 8px 0 0' }}>{L('inst.amount', 'المبلغ', { stack: true })}</th>
              </tr>
            </thead>
            <tbody>
              {doc.installments!.map(r => (
                <tr key={r.seq}>
                  <td style={{ ...td, textAlign: 'center' }}>{r.seq}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{formatDate(r.dueDate as string)}</td>
                  <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{formatCurrency(r.amount)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, borderTop: '2px solid #E15A30', fontWeight: 700 }} colSpan={2}>{L('inst.sum', 'مجموع الأقساط')}</td>
                <td style={{ ...td, borderTop: '2px solid #E15A30', textAlign: 'center', fontWeight: 700 }}>
                  {formatCurrency(doc.installments!.reduce((s, r) => s + Number(r.amount), 0))}
                </td>
              </tr>
            </tbody>
          </table>
          {!pt.hidden('inst.note') && <p style={{ fontSize: 11, color: '#6E6557', marginTop: 6 }}>
            {L('inst.note', 'الضريبة مستحقة بالكامل على هذه الفاتورة عند التوريد والأقساط جدول سداد لا تجزئة ضريبية')}
          </p>}
        </div>
      )}

      {look.showSignatures && (!pt.hidden('sig.recipient') || !pt.hidden('sig.rep')) && (
        <div style={{ marginTop: isSignatureSrc(doc.recipientSignature) || isSignatureSrc(doc.repSignature) ? 28 : 60, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', color: '#6b7280', fontSize: 13 }}>
          {!pt.hidden('sig.recipient') && <SignatureSlot src={doc.recipientSignature} label={L('sig.recipient', 'توقيع المستلم')} />}
          {!pt.hidden('sig.rep') && <SignatureSlot src={doc.repSignature} label={L('sig.rep', 'توقيع المندوب')} />}
        </div>
      )}

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        <FooterLine pt={pt} thanks={look.footerText !== null && !thanksReworded(pt) ? look.footerText : L('foot.thanks', 'شكرا لتعاملكم معنا')} name={doc.company?.name || ''} />
        {/* بصمة المنصّة: كل فاتورة مطبوعة تسوّق للمنصّة لدى تجّار الجملة والتجزئة (حلقة فيروسية) */}
        <div style={{ marginTop: 6, fontSize: 10, color: '#c3bcae' }}>
          {tr('صدرت عبر منصة')} Field Sales · fieldsa.net
        </div>
      </div>
      {sheet.css}
    </div>
    </DocTextsContext.Provider>
  );
});
PrintableInvoice.displayName = 'PrintableInvoice';

/** أعادت الشركة صياغة سطر الشكر في «نصوص المطبوعات» — فتسبق صياغتُها نصّ التذييل في قالب الطباعة (ما تراه في المعاينة يُطبع) */
const thanksReworded = (pt: PrintTexts): boolean => pt.on && pt.text('foot.thanks', '') !== '';

/**
 * سطر الشكر واسم الشركة في التذييل — كلٌّ يُخفى وحده («نصوص المطبوعات»). بلا نصوص: «الشكر — الاسم» كاليوم حرفياً.
 * الإخفاء يسبق كل شيء، ثم صياغة الشركة للشكر، ثم نصّ التذييل في قالب الطباعة (footerText)، ثم الافتراضي.
 */
function FooterLine({ pt, thanks, name }: { pt: PrintTexts; thanks: React.ReactNode | null; name: string }) {
  const t = pt.hidden('foot.thanks') ? null : thanks;
  const n = pt.hidden('foot.company') ? null : <Pick pt={pt} k="foot.company">{name}</Pick>;
  return <>{t}{t !== null && n !== null ? ' — ' : null}{n}</>;
}

// ============ قالب سند القبض ============
export const PrintableReceipt = forwardRef<HTMLDivElement, { doc: ReceiptDoc }>(({ doc }, ref) => {
  const uiTr = useTr();
  const sheet = useSheet();
  const look = usePrintLook();
  const brand = brandColor(doc.company);
  const addr = fullAddress(doc.customer);
  // «نصوص المطبوعات» كقالب الفاتورة — والسند لا تصنيف ضريبيّ له (standard: false)
  const pt = useTextsFor(doc.company, false, uiTr);
  const tr = pt.tr;
  const L = labeler(pt);
  const receiptTitle = pt.hidden('rcp.title') ? '' : titleNode(pt, 'rcp.title', { text: pt.text('rcp.title', 'سند قبض'), alt: pt.alt('rcp.title', 'سند قبض') });
  return (
    <DocTextsContext.Provider value={pt}>
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={receiptTitle} company={doc.company} />

      <div style={{ marginBottom: 20 }}>
        <InfoBox label={L('rcp.number', 'رقم السند')} value={doc.number} />
        <InfoBox label={L('rcp.date', 'التاريخ')} value={formatDate(doc.date)} />
        {!pt.hidden('rcp.time') && <InfoBox label={L('rcp.time', 'وقت الإصدار')} value={formatTime(doc.date)} />}
        {look.showRepName && !pt.hidden('rcp.rep') && <InfoBox label={L('rcp.rep', 'المندوب')} value={doc.repName} />}
      </div>

      {doc.cancelled && (
        <div style={{ background: '#fef2f2', border: '2px solid #dc2626', borderRadius: 10, padding: 10, textAlign: 'center', marginBottom: 16, color: '#b91c1c', fontWeight: 700, fontSize: 18 }}>
          {tr('سند ملغى')}
        </div>
      )}

      <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: 14, padding: 24, textAlign: 'center', marginBottom: 20 }}>
        <div style={{ color: '#15803d', fontSize: 14, marginBottom: 8 }}>{L('rcp.amount', 'المبلغ المستلم')}</div>
        <div style={{ fontSize: 38, fontWeight: 700, color: '#15803d' }}>{formatCurrency(doc.amount)}</div>
      </div>

      <ReceiptInvoicesBox doc={doc} />

      <div style={{ background: '#f8fafc', borderRadius: 10, padding: 16, marginBottom: 20 }}>
        {!pt.hidden('rcp.customerHeading') && <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{L('rcp.customerHeading', 'بيانات العميل')}</div>}
        <InfoBox label={L('rcp.from', 'استلمنا من السيد')} value={doc.customer.name} />
        {doc.customer.businessName && !pt.hidden('rcp.business') && <InfoBox label={L('rcp.business', 'المنشأة')} value={doc.customer.businessName} />}
        {doc.customer.commercialReg && !pt.hidden('rcp.commercialReg') && <InfoBox label={L('rcp.commercialReg', 'السجل التجاري')} value={doc.customer.commercialReg} />}
        {doc.customer.taxNumber && !pt.hidden('rcp.taxNumber') && <InfoBox label={L('rcp.taxNumber', 'الرقم الضريبي')} value={doc.customer.taxNumber} />}
        {doc.customer.phone && !pt.hidden('rcp.phone') && <InfoBox label={L('rcp.phone', 'الجوال')} value={doc.customer.phone} />}
        {addr && !pt.hidden('rcp.address') && <InfoBox label={L('rcp.address', 'العنوان')} value={addr} />}
        <div style={{ height: 8 }} />
        {/* «إدارة طرق الدفع»: اسم الشركة للطريقة (مخصّصة أو مدمجة سُمّيت) كما كتبته، وإلا الافتراضي مترجماً كما اليوم */}
        {!pt.hidden('rcp.method') && <InfoBox label={L('rcp.method', 'طريقة الدفع')} value={methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey, tr)} />}
        {doc.notes && !pt.hidden('rcp.notes') && <InfoBox label={L('rcp.notes', 'ملاحظات')} value={doc.notes} />}
      </div>

      <div style={{ marginTop: 80, display: 'flex', justifyContent: 'space-between', color: '#6b7280', fontSize: 13 }}>
        {!pt.hidden('rcp.sigPayer') && <div>{L('rcp.sigPayer', 'توقيع الدافع')}: ........................</div>}
        {!pt.hidden('rcp.sigCollector') && <div>{L('rcp.sigCollector', 'توقيع المستلم المندوب')}: ........................</div>}
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {pt.hidden('foot.company') ? null : <Pick pt={pt} k="foot.company">{doc.company?.name || ''}</Pick>}
        <div style={{ marginTop: 6, fontSize: 10, color: '#c3bcae' }}>
          {tr('صدرت عبر منصة')} Field Sales · fieldsa.net
        </div>
      </div>
      {sheet.css}
    </div>
    </DocTextsContext.Provider>
  );
});
PrintableReceipt.displayName = 'PrintableReceipt';

/**
 * «مقابل الفاتورة رقم …» داخل سند القبض — تحت المبلغ مباشرةً لأنه جواب سؤال
 * «هذا المبلغ عن ماذا؟». فاتورة واحدة ⇒ رقمها بخطّ كبير؛ أكثر ⇒ سطرٌ لكلٍّ
 * بمبلغه. والفائض عن الفواتير يُسمّى رصيداً دائناً لا يُترك صامتاً.
 */
function ReceiptInvoicesBox({ doc }: { doc: ReceiptDoc }) {
  const uiTr = useTr();
  // «نصوص المطبوعات»: محلِّل السند من سياقه (لا يُرسم هذا الصندوق خارج السند)
  const docPt = useDocTexts();
  const pt = useMemo(() => docPt ?? makePrintTexts(null, uiTr), [docPt, uiTr]);
  const tr = pt.tr;
  const L = labeler(pt);
  const view = receiptLinkView(doc, currencyDecimals(getActiveCurrency()));
  if (view.kind === 'unknown') return null;
  const box: React.CSSProperties = { border: '1.5px solid #cbd5e1', borderRadius: 12, padding: '14px 18px', marginBottom: 20 };
  if (view.kind === 'pending' || view.kind === 'onAccount') {
    return (
      <div style={{ ...box, color: '#475569', fontSize: 14, textAlign: 'center' }}>
        {view.kind === 'pending' ? tr('يحدد رقم الفاتورة عند مزامنة السند') : tr('دفعة على الحساب غير مرتبطة بفاتورة')}
      </div>
    );
  }
  const single = view.links.length === 1;
  const showAmounts = !single || view.unallocated > 0;
  return (
    <div style={box}>
      {/* «نصوص المطبوعات»: التسمية المخفية تسقط ويبقى رقم الفاتورة ومبلغها — ربط السند بفاتورته لا يُخفى */}
      {single ? (
        <div style={{ display: 'flex', justifyContent: pt.hidden('rcp.forInvoice') ? 'center' : 'space-between', alignItems: 'baseline', gap: 12 }}>
          {!pt.hidden('rcp.forInvoice') && <span style={{ color: '#475569', fontSize: 14 }}>{L('rcp.forInvoice', 'مقابل الفاتورة رقم')}</span>}
          <span style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', direction: 'ltr' }}>{view.links[0].number}</span>
        </div>
      ) : (
        !pt.hidden('rcp.forInvoices') && <div style={{ color: '#475569', fontSize: 14, marginBottom: 8 }}>{L('rcp.forInvoices', 'مقابل الفواتير')}</div>
      )}
      {showAmounts && view.links.map((l) => (
        <div key={l.number} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14, padding: '5px 0', borderTop: single ? 'none' : '1px solid #eef2f7' }}>
          <span>{pt.hidden('rcp.invoiceNo') ? null : <>{L('rcp.invoiceNo', 'فاتورة رقم')} </>}<b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{l.number}</b></span>
          <span style={{ fontWeight: 700 }}>{formatCurrency(l.amount)}</span>
        </div>
      ))}
      {view.unallocated > 0 && !pt.hidden('rcp.credit') && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '5px 0', borderTop: '1px solid #eef2f7', color: '#475569' }}>
          <span>{L('rcp.credit', 'رصيد دائن للعميل غير مخصص لفاتورة')}</span>
          <span style={{ fontWeight: 700 }}>{formatCurrency(view.unallocated)}</span>
        </div>
      )}
    </div>
  );
}

// ============ قالب كشف الحساب ============
export const PrintableStatement = forwardRef<HTMLDivElement, { doc: StatementDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const sheet = useSheet();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const addr = fullAddress(doc.customer);
  /* كل طرفٍ على حدة: اشتراطُ الطرفين كان يطبع «كل الفترات» على كشفٍ مُصفّى
   * بطرفٍ واحد — ورقةٌ تقول للعميل إنّها تاريخه كلّه وهي شهرٌ منه. (ولم يظهر
   * قبل اليوم لأنّ كلّ المستدعين كانوا يطلبون الكشف بلا مدّة.) */
  const shape = periodShape(doc.fromDate, doc.toDate);
  /* حدّا المدّة **يومان خالصان** جاءا من حقل تاريخ (`YYYY-MM-DD`): يُقرآن بأجزائهما لا
   * بمنطقة أحد. `formatDate` كانت تقرؤهما منتصفَ ليل غرينتش، فجهازٌ غرب غرينتش يطبع
   * على ورقة العميل «من ٣١ ديسمبر» وهي مدّةٌ بدايتها ١ يناير. */
  const period = shape === 'range' ? `${formatDayOnly(doc.fromDate as string)} — ${formatDayOnly(doc.toDate as string)}`
    : shape === 'from' ? `${tr('من')} ${formatDayOnly(doc.fromDate as string)}`
    : shape === 'to' ? `${tr('حتى')} ${formatDayOnly(doc.toDate as string)}`
    : tr('كل الفترات');
  // ولحظاتُ الحركات بمنطقة الشركة إن وصلت مع الكشف، وإلّا بمنطقة الجهاز (ارتداد صريح)
  const tz = statementZone(doc.timezone);
  // عدد الأصناف المباعة (مجموع الكميات) — يظهر في صف الإجماليات أسفل الكشف
  const soldUnits = (() => {
    const m = new Map<string, number>();
    for (const e of doc.entries) {
      if (e.type !== 'INVOICE_DEBIT') continue; // البيع الفعلي فقط (بلا تكرار التحصيل ولا المرتجعات)
      for (const it of (e.items || [])) {
        const u = (it.unit || '').trim() || tr('وحدة');
        m.set(u, (m.get(u) || 0) + Number(it.qty));
      }
    }
    return [...m.entries()].map(([u, q]) => `${q} ${u}`).join(' · ');
  })();

  return (
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={tr('كشف حساب')} company={doc.company} />

      {/* بيانات العميل + الفترة */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات العميل')}</div>
          <InfoBox label={tr('الاسم')} value={doc.customer.name} />
          {doc.customer.businessName && <InfoBox label={tr('المنشأة')} value={doc.customer.businessName} />}
          {doc.customer.commercialReg && <InfoBox label={tr('السجل التجاري')} value={doc.customer.commercialReg} />}
          {doc.customer.taxNumber && <InfoBox label={tr('الرقم الضريبي')} value={doc.customer.taxNumber} />}
          {doc.customer.phone && <InfoBox label={tr('الجوال')} value={doc.customer.phone} />}
          {addr && <InfoBox label={tr('العنوان')} value={addr} />}
        </div>
        <div style={{ flex: 1, background: '#eff6ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات الكشف')}</div>
          <InfoBox label={tr('تاريخ الإصدار')} value={formatDate(doc.date)} />
          <InfoBox label={tr('الفترة')} value={period} />
          <InfoBox label={tr('المندوب')} value={doc.repName} />
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #cbd5e1' }}>
            <InfoBox label={doc.teamScoped ? tr('مبيعات فريقك') : tr('إجمالي المبيعات')} value={formatCurrency(doc.customer.totalSales ?? 0)} />
            <InfoBox label={doc.teamScoped ? tr('تحصيل فريقك') : tr('إجمالي التحصيل')} value={formatCurrency(doc.customer.totalCollected ?? 0)} />
          </div>
        </div>
      </div>

      {/* جدول الحركات */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={th}>{tr('التاريخ')}</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('البيان')}</th>
            <th style={th}>{tr('المستند')}</th>
            <th style={th}>{tr('مدين')}</th>
            <th style={th}>{tr('دائن')}</th>
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('الرصيد')}</th>
          </tr>
        </thead>
        <tbody>
          {/* الرصيد المرحَّل صفّاً أوّل — كما يعرضه تطبيق الإدارة فوق الحركات */}
          {doc.fromDate && doc.openingBalance !== undefined && (
            <tr style={{ background: '#f8fafc' }}>
              <td style={{ ...td }}>-</td>
              <td style={{ ...td }}>{formatDayOnly(doc.fromDate)}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{tr('رصيد مرحل من قبل الفترة')}</td>
              <td style={{ ...td }}>-</td>
              <td style={{ ...td, color: '#cbd5e1' }}>-</td>
              <td style={{ ...td, color: '#cbd5e1' }}>-</td>
              <td style={{ ...td, fontWeight: 700 }}>{formatCurrency(doc.openingBalance)}</td>
            </tr>
          )}
          {doc.entries.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={7}>{tr('لا توجد حركات في هذه الفترة')}</td></tr>
          ) : doc.entries.map((e, i) => (
            <tr key={i}>
              <td style={{ ...td, verticalAlign: 'top' }}>{i + 1}</td>
              <td style={{ ...td, verticalAlign: 'top' }}>{formatDate(e.date, tz)}</td>
              <td style={{ ...td, textAlign: 'right', verticalAlign: 'top' }}>
                {e.description}
                {e.items && e.items.length > 0 && (
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
                    <b style={{ color: '#4b5563' }}>{e.items.length} {tr('صنف')}:</b> {e.items.map(it => `${it.name} ×${it.qty}${factorOf(it) !== 1 && it.unit ? ` ${it.unit}` : ''}`).join('، ')}
                  </div>
                )}
              </td>
              <td style={{ ...td, fontSize: 10, color: '#6b7280', verticalAlign: 'top' }}>{e.ref || '-'}</td>
              <td style={{ ...td, verticalAlign: 'top', color: e.debit > 0 ? '#dc2626' : '#cbd5e1' }}>{e.debit > 0 ? formatCurrency(e.debit) : '-'}</td>
              <td style={{ ...td, verticalAlign: 'top', color: e.credit > 0 ? '#16a34a' : '#cbd5e1' }}>{e.credit > 0 ? formatCurrency(e.credit) : '-'}</td>
              <td style={{ ...td, verticalAlign: 'top', fontWeight: 700 }}>{formatCurrency(e.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, textAlign: 'center', borderTop: `2px solid ${brand}` }} colSpan={2}>{tr('الإجماليات')}</td>
            <td style={{ ...td, textAlign: 'right', borderTop: `2px solid ${brand}` }}>{soldUnits || '-'}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }}>-</td>
            <td style={{ ...td, color: '#dc2626', borderTop: `2px solid ${brand}` }}>{formatCurrency(doc.totalDebit)}</td>
            <td style={{ ...td, color: '#16a34a', borderTop: `2px solid ${brand}` }}>{formatCurrency(doc.totalCredit)}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{formatCurrency(doc.finalBalance)}</td>
          </tr>
        </tfoot>
      </table>

      {/* الرصيد النهائي */}
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div style={{ background: doc.finalBalance > 0 ? '#fef2f2' : '#f0fdf4', border: `2px solid ${doc.finalBalance > 0 ? '#fca5a5' : '#86efac'}`, borderRadius: 12, padding: '14px 24px', minWidth: 260 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: '#374151' }}>{doc.teamScoped ? tr('رصيد فريقك') : tr('الرصيد المستحق على العميل')}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: doc.finalBalance > 0 ? '#dc2626' : '#16a34a' }}>{formatCurrency(doc.finalBalance)}</span>
          </div>
        </div>
      </div>
      {doc.teamScoped && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#8A5A00' }}>
          {tr('كشف فريقك فقط لا يشمل فواتير الفرق الأخرى وسنداتها ولا التسويات اليدوية')}
        </div>
      )}

      <div style={{ marginTop: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تم الإصدار في')} {formatDateTime(doc.date)}
      </div>
      {sheet.css}
    </div>
  );
});
PrintableStatement.displayName = 'PrintableStatement';

// سجلّ استلامات التحصيل لمندوب — جدولٌ مرتّب بالوقت والمبلغ ومن استلم، برأس الشركة
export const PrintableSettlementLog = forwardRef<HTMLDivElement, { doc: SettlementLogDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const sheet = useSheet();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const single = doc.entries.length === 1; // تصدير تسجيلٍ واحد = سند استلام
  /**
   * وسم نوع الاستلام — قاموس سند القبض نفسه (`paymentMethodLabels`) لا قاموسٌ
   * ثانٍ: النوعان يصفان الحركة المالية ذاتها، فاختلاف الوسمين بينهما يربك
   * المحاسب حين يطابق السند بالاستلام. والغياب يُقرأ CASH لأن استلامات ما قبل
   * العمود نقديّة بافتراض الخادم، وأيّ قيمة خارج القاموس يردّها الخادم إلى CASH.
   */
  const methodLabel = (m?: string): string => tr(paymentMethodLabels[m || 'CASH'] || paymentMethodLabels.CASH);

  return (
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={single ? tr('سند استلام تحصيل') : tr('سجل استلام التحصيل')} company={doc.company} />

      {/* بيانات المندوب + ملخّص التحصيل */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات المندوب')}</div>
          <InfoBox label={tr('المندوب')} value={doc.repName} />
          <InfoBox label={tr('تاريخ الإصدار')} value={formatDate(doc.date)} />
          {!single && <InfoBox label={tr('عدد الاستلامات')} value={String(doc.entries.length)} />}
        </div>
        <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('ملخص التحصيل')}</div>
          {doc.collected != null && <InfoBox label={tr('إجمالي التحصيل')} value={formatCurrency(doc.collected)} />}
          <InfoBox label={tr('إجمالي المسلم')} value={formatCurrency(doc.total)} />
          {doc.outstanding != null && <InfoBox label={tr('الرصيد المتبقي')} value={formatCurrency(doc.outstanding)} />}
        </div>
      </div>

      {/* جدول الاستلامات */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={th}>{tr('التاريخ')}</th>
            <th style={th}>{tr('الوقت')}</th>
            <th style={th}>{tr('المبلغ المستلم')}</th>
            <th style={th}>{tr('النوع')}</th>
            <th style={th}>{tr('استلمه')}</th>
            <th style={{ ...th, textAlign: 'right', borderRadius: '8px 0 0 0' }}>{tr('ملاحظة')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.entries.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={7}>{tr('لا توجد استلامات')}</td></tr>
          ) : doc.entries.map((e, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={td}>{formatDate(e.settledAt)}</td>
              <td style={td}>{formatTime(e.settledAt)}</td>
              <td style={{ ...td, fontWeight: 700, color: '#16a34a' }}>{formatCurrency(e.amount)}</td>
              <td style={td}>{methodLabel(e.method)}</td>
              <td style={td}>{e.by || '-'}</td>
              <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{e.note || '-'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }} colSpan={3}>{tr('الإجمالي')}</td>
            <td style={{ ...td, color: '#16a34a', borderTop: `2px solid ${brand}` }}>{formatCurrency(doc.total)}</td>
            {/* النوع + استلمه + ملاحظة — لا يُجمَع منها شيء */}
            <td style={{ ...td, borderTop: `2px solid ${brand}` }} colSpan={3}></td>
          </tr>
        </tfoot>
      </table>

      {/* إجمالي المُسلَّم */}
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div style={{ background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 12, padding: '14px 24px', minWidth: 260 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: '#374151' }}>{tr('إجمالي المسلم للإدارة')}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: '#16a34a' }}>{formatCurrency(doc.total)}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تم الإصدار في')} {formatDateTime(doc.date)}
      </div>
      {sheet.css}
    </div>
  );
});
PrintableSettlementLog.displayName = 'PrintableSettlementLog';

// إشعار حركة بضاعة لسيارة مندوب — اسم المندوب + الأصناف بكمياتها + التاريخ والوقت، برأس الشركة
export const PrintableLoadNotice = forwardRef<HTMLDivElement, { doc: LoadNoticeDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const sheet = useSheet();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const title = doc.movementKind === 'UNLOAD' ? tr('إشعار تنزيل بضاعة')
    : doc.movementKind === 'ADJUST' ? tr('إشعار تسوية مخزون') : tr('إشعار تحميل بضاعة');
  const totalQty = Number(doc.items.reduce((a, i) => a + Math.abs(i.qty), 0).toFixed(2));
  // وحداتٌ مختلطة: الإجمالي لكل وحدة — «٧ وحدة» لكرتونين وخمس حبّات رقمٌ بلا معنى على ورقةٍ يوقّعها المندوب
  const byUnit = qtyByUnit(doc.items, (q) => Math.abs(q));
  const totalText = byUnit ? unitTotalsText(byUnit, (n) => String(Number(n.toFixed(2)))) : String(totalQty);
  // «تتبّع اللوط»: عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة — سطرٌ لكل تشغيلة، وكمّيتها حين يتوزّع البند
  const withLots = noticeHasLots(doc.items);
  const cols = withLots ? 5 : 4;

  return (
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={title} company={doc.company} />

      {/* بيانات المندوب + ملخّص الحركة */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات المندوب')}</div>
          <InfoBox label={tr('المندوب')} value={doc.repName} />
          <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={tr('الوقت')} value={formatTime(doc.date)} />
        </div>
        <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('ملخص الحركة')}</div>
          <InfoBox label={tr('عدد الأصناف')} value={String(doc.items.length)} />
          <InfoBox label={tr('إجمالي الكميات')} value={totalText} />
          {doc.note && <InfoBox label={tr('ملاحظة')} value={doc.note} />}
        </div>
      </div>

      {/* جدول الأصناف */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('الصنف')}</th>
            <th style={th}>{tr('الكمية')}</th>
            <th style={withLots ? th : { ...th, borderRadius: '8px 0 0 0' }}>{tr('الوحدة')}</th>
            {withLots && <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('التشغيلة / الانتهاء')}</th>}
          </tr>
        </thead>
        <tbody>
          {doc.items.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={cols}>{tr('لا توجد أصناف')}</td></tr>
          ) : doc.items.map((it, i) => {
            const lots = docLotRows(it.lots);
            return (
              <tr key={i}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{it.name}</td>
                <td style={{ ...td, fontWeight: 700, color: '#16a34a' }}>{Number(Math.abs(it.qty).toFixed(2))}</td>
                <td style={{ ...td, color: '#6b7280' }}>{it.unit || '-'}</td>
                {withLots && (
                  <td style={{ ...td, fontSize: 10.5, color: '#374151' }}>
                    {lots.length === 0 ? '-' : lots.map((l, k) => (
                      <div key={k}>{lotCellText(l, { tr, unitFactor: it.unitFactor, withQty: lots.length > 1 })}</div>
                    ))}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }} colSpan={2}>{tr('الإجمالي')}</td>
            <td style={{ ...td, color: '#16a34a', borderTop: `2px solid ${brand}` }}>{totalText}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{byUnit ? '-' : tr('وحدة')}</td>
            {withLots && <td style={{ ...td, borderTop: `2px solid ${brand}` }}>-</td>}
          </tr>
        </tfoot>
      </table>

      {/* توقيعا التسليم والاستلام */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40, marginTop: 24 }}>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{tr('توقيع المندوب')}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{tr('توقيع المستودع')}</div>
        </div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تاريخ الحركة')} {formatDateTime(doc.date)}
      </div>
      {sheet.css}
    </div>
  );
});
PrintableLoadNotice.displayName = 'PrintableLoadNotice';

/** كمّية بلا أصفارٍ زائدة — الوحدات الموزونة قد تحمل كسوراً */
const fmtNoticeQty = (n: number) => String(Number(Number(n).toFixed(2)));

export const PrintableWarehouseNotice = forwardRef<HTMLDivElement, { doc: WarehouseNoticeDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const sheet = useSheet();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const receive = doc.entryType === 'RECEIVE';
  const title = receive ? tr('إشعار وارد بضاعة') : tr('إشعار تسوية مخزون');
  const adj = adjustTotals(doc.items);
  // وحداتٌ مختلطة: الوارد والزيادة والنقص لكل وحدة (qtyByUnit) — وإلا الأرقام كما كانت
  const unitTotal = (pick: (q: number) => number, n: number) => {
    const rows = qtyByUnit(doc.items, pick);
    return rows ? unitTotalsText(rows, fmtNoticeQty) : fmtNoticeQty(n);
  };
  const uncosted = receive ? uncostedCount(doc.items) : 0;
  /* وارد بلا أيّ سطرٍ مسعَّر (سُجّل قبل وصول فاتورة المورّد): إجماليه صفرٌ
   * حسابياً، لكنّ طباعته «٠٫٠٠» تقول على ورقةٍ موقَّعة إنّ البضاعة بلا ثمن —
   * وهي القاعدة نفسها التي تطبع «—» لسطرٍ بلا سعر، والشاشة تُخفي القيمة
   * أصلاً حين تكون صفراً. */
  const anyCosted = doc.items.some(isCosted);
  // «تتبّع اللوط»: عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة (سطرٌ = تشغيلةٌ واحدة) — بعد الوحدة، قبل السعر
  const withLots = noticeHasLots(doc.items);
  const cols = (receive ? 6 : 4) + (withLots ? 1 : 0);

  return (
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={title} company={doc.company} />

      {/* بيانات الحركة + ملخّصها */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات الحركة')}</div>
          <InfoBox label={tr('مرجع الحركة')} value={doc.ref} />
          <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={tr('الوقت')} value={formatTime(doc.date)} />
          {doc.by && <InfoBox label={tr('سجلها')} value={doc.by} />}
        </div>
        <div style={{ flex: 1, background: receive ? '#f0fdf4' : '#faf5ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('ملخص الحركة')}</div>
          {receive && doc.supplier && <InfoBox label={tr('المورد')} value={doc.supplier} />}
          <InfoBox label={tr('عدد الأصناف')} value={String(doc.items.length)} />
          {/* التسوية تُطبع زيادتها ونقصها منفصلين: صافيها يخفي حركةً نقلت كمّيات */}
          {receive
            ? <InfoBox label={tr('إجمالي الكميات')} value={unitTotal((q) => q, receiveTotalQty(doc.items))} />
            : <>
                <InfoBox label={tr('إجمالي الزيادة')} value={unitTotal((q) => (q > 0 ? q : 0), adj.added)} />
                <InfoBox label={tr('إجمالي النقص')} value={unitTotal((q) => (q < 0 ? -q : 0), adj.removed)} />
              </>}
        </div>
      </div>

      {doc.note && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          <b>{tr('ملاحظة')}:</b> {doc.note}
        </div>
      )}

      {/* جدول الأصناف */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('الصنف')}</th>
            <th style={th}>{tr('الكمية')}</th>
            <th style={receive || withLots ? th : { ...th, borderRadius: '8px 0 0 0' }}>{tr('الوحدة')}</th>
            {withLots && <th style={receive ? th : { ...th, borderRadius: '8px 0 0 0' }}>{tr('التشغيلة / الانتهاء')}</th>}
            {receive && <th style={th}>{tr('سعر الوحدة قبل الضريبة')}</th>}
            {receive && <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('القيمة قبل الضريبة')}</th>}
          </tr>
        </thead>
        <tbody>
          {doc.items.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={cols}>{tr('لا توجد أصناف')}</td></tr>
          ) : doc.items.map((it, i) => {
            const q = Number(it.qty);
            const costed = isCosted(it);
            return (
              <tr key={i}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{it.name}</td>
                {/* الإشارة جزءٌ من الرقم في التسوية: «١٠» و«−١٠» حركتان متعاكستان */}
                <td style={{ ...td, fontWeight: 700, color: receive ? '#1f2937' : q < 0 ? '#dc2626' : '#16a34a' }} dir="ltr">
                  {receive ? fmtNoticeQty(q) : `${q < 0 ? '−' : '+'}${fmtNoticeQty(Math.abs(q))}`}
                </td>
                <td style={{ ...td, color: '#6b7280' }}>{it.unit || '-'}</td>
                {withLots && (
                  <td style={{ ...td, fontSize: 10.5, color: '#374151' }}>
                    {docLotRows(it.lots).map((l, k) => <div key={k}>{lotCellText(l, { tr, unitFactor: it.unitFactor, withQty: false })}</div>)}
                    {docLotRows(it.lots).length === 0 && '-'}
                  </td>
                )}
                {/* سطرٌ بلا سعر يُطبع «—» لا صفراً: الصفر ادّعاءٌ بأنّ البضاعة مجّانية */}
                {receive && <td style={td}>{costed ? formatCurrency(Number(it.unitCost), undefined, 4) : '—'}</td>}
                {receive && <td style={{ ...td, fontWeight: 600 }}>{costed && it.lineCost != null ? formatCurrency(Number(it.lineCost)) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
        {receive && (
          <tfoot>
            <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
              <td style={{ ...td, borderTop: `2px solid ${brand}`, textAlign: 'right' }} colSpan={cols - 1}>{tr('قيمة البضاعة قبل الضريبة')}</td>
              <td style={{ ...td, borderTop: `2px solid ${brand}`, color: brand }}>{anyCosted ? formatCurrency(doc.totalCost) : '—'}</td>
            </tr>
          </tfoot>
        )}
      </table>

      {/* حدّ صدق القيمة — يُقال لا يُترك للاستنتاج */}
      {uncosted > 0 && (
        <p style={{ fontSize: 11.5, color: '#b45309', margin: '0 0 12px' }}>
          {tr('أصناف بلا سعر وحدة لا تدخل في القيمة')}: {uncosted}
        </p>
      )}

      {/* التوقيعان */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40, marginTop: 24 }}>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{tr('توقيع أمين المستودع')}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{receive ? tr('توقيع المورد') : tr('توقيع المعتمد')}</div>
        </div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تاريخ الحركة')} {formatDateTime(doc.date)}
      </div>
      {sheet.css}
    </div>
  );
});
PrintableWarehouseNotice.displayName = 'PrintableWarehouseNotice';

/** طلب مخزون — الأصناف بكمّياتها المطلوبة ورصيدها الآن، وخانتا مقدّم الطلب واعتماد الجهة */
export const PrintableStockRequest = forwardRef<HTMLDivElement, { doc: StockRequestDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const sheet = useSheet();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const totalQty = stockRequestTotalQty(doc.items);
  // وحداتٌ مختلطة في الكميات المطلوبة: الإجمالي لكل وحدة (qtyByUnit) — وإلا الرقم كما كان
  const byUnit = qtyByUnit(doc.items);
  const totalText = byUnit ? unitTotalsText(byUnit, fmtNoticeQty) : fmtNoticeQty(totalQty);
  // الرصيد بالأساس بوحدات الصنف «٢ كرتون و٣ حبة» حين تصل؛ والعجز بإشارة الطرح نفسها كما كان
  const onHandText = (it: StockRequestDocLine): string => {
    const big = (it.units ?? []).some((u) => Number(u.factor) > 1 && u.isActive !== false);
    const abs = Math.abs(it.onHand);
    const txt = big ? formatQty(abs, it.units ?? [], String(it.baseUnit || it.unit || '')) : fmtNoticeQty(abs);
    return it.onHand < 0 ? `−${txt}` : txt;
  };

  return (
    <div ref={ref} style={sheet.style} {...sheet.attrs}>
      <Header title={tr('طلب مخزون')} company={doc.company} />

      {/* بيانات الطلب + الجهة وملخّصه */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات الطلب')}</div>
          <InfoBox label={tr('رقم الطلب')} value={doc.ref} />
          <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={tr('الوقت')} value={formatTime(doc.date)} />
          {doc.by && <InfoBox label={tr('مقدم الطلب')} value={doc.by} />}
        </div>
        <div style={{ flex: 1, background: '#fff7ed', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('ملخص الطلب')}</div>
          <InfoBox label={tr('موجه إلى')} value={tr(stockRequestToLabel(doc.to))} />
          {doc.neededBy && <InfoBox label={tr('مطلوب قبل')} value={formatDayOnly(doc.neededBy)} />}
          <InfoBox label={tr('عدد الأصناف')} value={String(doc.items.length)} />
          <InfoBox label={tr('إجمالي الكميات')} value={totalText} />
        </div>
      </div>

      {doc.note && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          <b>{tr('ملاحظة')}:</b> {doc.note}
        </div>
      )}

      {/* جدول الأصناف */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('الصنف')}</th>
            <th style={th}>{tr('الوحدة')}</th>
            <th style={th}>{tr('الرصيد الحالي')}</th>
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('الكمية المطلوبة')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={5}>{tr('لا توجد أصناف')}</td></tr>
          ) : doc.items.map((it, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <div style={{ fontWeight: 600 }}>{it.name}</div>
                {/* الكود سطرٌ ثانٍ — ويُترك حين يكون نسخةً من الاسم كما في بعض الكتالوجات */}
                {it.code && it.code !== it.name && <div style={{ fontSize: 10, color: '#9ca3af' }}>{it.code}</div>}
              </td>
              <td style={{ ...td, color: '#6b7280' }}>{it.unit || '-'}</td>
              {/* الرصيد السالب عجزٌ مسجَّل — يُطبع بإشارته لا مطلقاً */}
              <td style={{ ...td, color: it.onHand < 0 ? '#dc2626' : it.onHand === 0 ? '#b45309' : '#6b7280' }} dir={onHandText(it).match(/[؀-ۿ]/) ? 'rtl' : 'ltr'}>
                {onHandText(it)}
              </td>
              <td style={{ ...td, fontWeight: 700, fontSize: 13, color: brand }}>{fmtNoticeQty(it.qty)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, borderTop: `2px solid ${brand}`, textAlign: 'right' }} colSpan={4}>{tr('إجمالي الكميات')}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}`, color: brand }}>{totalText}</td>
          </tr>
        </tfoot>
      </table>

      {/* طلبات المناديب المشمولة — سطرٌ لكل مندوب بأصنافه، فيعرف المستودع لمن يحمّل حين تصل البضاعة */}
      {doc.reps && doc.reps.length > 0 && (
        <div style={{ marginTop: 6, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 6, fontSize: 13 }}>{tr('تفصيل طلبات المناديب')}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {doc.reps.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, width: '28%', verticalAlign: 'top' }}>{r.name}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#374151' }}>
                    {r.items.length === 0 ? '-' : r.items.map((it, j) => (
                      <span key={j} style={{ display: 'inline-block', marginInlineEnd: 10 }}>
                        {it.name} <b dir="ltr">{fmtNoticeQty(it.qty)}</b> {it.unit || ''}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* التوقيعان */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40, marginTop: 24 }}>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{tr('توقيع مقدم الطلب')}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 44 }}>{tr(stockRequestApproverLabel(doc.to))}</div>
        </div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تاريخ الطلب')} {formatDateTime(doc.date)}
      </div>
      {sheet.css}
    </div>
  );
});
PrintableStockRequest.displayName = 'PrintableStockRequest';

function Row({ label, value, color }: { label: React.ReactNode; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', color: color || '#374151' }}>
      <span>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/** خانة توقيع آخر الفاتورة: الصورة فوق خطٍّ وتسمية، أو سطر نقاطٍ للتوقيع باليد على الورق */
function SignatureSlot({ src, label }: { src?: string | null; label: React.ReactNode }) {
  if (!isSignatureSrc(src)) return <div>{label}: ........................</div>;
  return (
    <div style={{ textAlign: 'center', minWidth: 170 }}>
      <img src={src} alt="" style={{ display: 'block', margin: '0 auto', height: 64, maxWidth: 220, objectFit: 'contain' }} />
      <div style={{ borderTop: '1px solid #cbd5e1', paddingTop: 4, marginTop: 2 }}>{label}</div>
    </div>
  );
}

/** صورة توقيعٍ صالحة للعرض: PNG base64 كما تصدرها لوحة التوقيع ويقبلها الخادم */
export const isSignatureSrc = (v: unknown): v is string =>
  typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v);

// ============ بناء مستند من بيانات الخادم ============
/** «تتبّع اللوط»: حقل lots للبند من صفوف الخادم — أو لا حقل (الشكل كما كان للشركة المطفأة) */
const lotsField = (raw: unknown): { lots?: DocLotLine[] } => {
  const lots = docLotsFrom(raw);
  return lots ? { lots } : {};
};

export function invoiceDocFromDetail(inv: any, repName: string, company?: Company | null): InvoiceDoc {
  return {
    kind: 'invoice',
    number: inv.number,
    date: inv.invoiceDate,
    deliveryDate: inv.deliveryDate ?? undefined,
    recipientSignature: inv.signature?.image ?? null,
    repSignature: inv.signature?.repImage ?? null,
    type: inv.type === 'RETURN' ? 'CREDIT' : inv.type,
    isReturn: inv.type === 'RETURN',
    company: company ?? null,
    customer: inv.customer,
    repName: inv.salesRep?.name ?? repName,
    items: (inv.items ?? []).map((it: any) => ({
      // «تتبّع اللوط»: صفوف توزيع البند (withLots=1 أو ردّ الإصدار) — غيابها لا يضيف حقلاً
      ...lotsField(it.lots),
      name: it.product?.name ?? '-',
      // لقطة وحدة البند (القاعدة ٨): وحدة الصنف الحالية صارت الأساس بعد التحويل، فـ«٢ (حبة)» لكرتونين خطأٌ ٢٤ ضعفاً
      unit: it.unitName || it.product?.unit,
      unitFactor: it.unitFactor == null ? undefined : factorOf(it),
      multiUnit: Array.isArray(it.product?.units) && it.product.units.length > 0,
      qty: Number(it.qty),
      unitPrice: Number(it.unitPrice),
      discountPct: Number(it.discountPct),
      taxPct: Number(it.taxPct),
      lineTotal: Number(it.lineTotal),
      returnExpired: it.returnExpired ?? null,
      expiresAt: it.expiresAt ?? null,
    })),
    pricesIncludeTax: inv.pricesIncludeTax ?? undefined,
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discountAmt),
    tax: Number(inv.taxAmt),
    total: Number(inv.total),
    paidAmt: Number(inv.paidAmt),
    remainingAmt: Number(inv.remainingAmt),
    paymentPlan: inv.paymentPlan ?? null,
    installments: Array.isArray(inv.installments)
      ? inv.installments.map((r: any) => ({ seq: Number(r.seq), dueDate: r.dueDate, amount: Number(r.amount) }))
      : undefined,
    einvoice: {
      provider: inv.einvoiceProvider ?? null,
      status: inv.einvoiceStatus ?? null,
      uuid: inv.einvoiceUuid ?? null,
      qr: inv.einvoiceQr ?? null,
    },
    /* فوترة ZATCA المرحلة الثانية: البانية الواحدة تغذّي ثلاث واجهات (المندوب، اللوحة، /m) — فالقرار يُتّخذ مرّة
     * واحدة هنا ولا يُنسى في واحدةٍ منها. `null` لصفوف المرحلة الأولى وهي كلّ ما عدا المفعَّلين. */
    zatca: zatcaDocView(inv),
  };
}

/**
 * مرفقات السند من ردّ الخادم. تُفحص صفّاً صفّاً لا تُمرَّر جملةً: الحقل غائب في
 * ردّ القائمة، وغائب عن كل سند أُنشئ قبل الميزة، وقد يصل صفٌّ بلا `data` —
 * وصورةٌ مصدرها `undefined` تطبع مربّعاً مكسوراً في وجه المحاسب.
 */
function receiptPhotosFrom(raw: unknown): ReceiptPhoto[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReceiptPhoto[] = [];
  raw.forEach((row, i) => {
    const { id, data } = (row ?? {}) as { id?: unknown; data?: unknown };
    if (typeof data === 'string' && data) {
      out.push({ id: typeof id === 'string' ? id : String(i), data });
    }
  });
  return out.length ? out : undefined;   // لا مصفوفة فارغة: الشريط يختفي بالغياب
}

export function receiptDocFromDetail(rcp: any, repName: string, company?: Company | null): ReceiptDoc {
  return {
    kind: 'receipt',
    number: rcp.number,
    date: rcp.receiptDate,
    company: company ?? null,
    customer: rcp.customer,
    repName: rcp.salesRep?.name ?? repName,
    amount: Number(rcp.amount),
    paymentMethod: rcp.paymentMethod,
    notes: rcp.notes ?? undefined,
    photos: receiptPhotosFrom(rcp.photos),
    invoices: receiptInvoicesFrom(rcp.invoiceItems),
    paymentMethodKey: rcp.paymentMethodKey ?? null,
    ...(rcp.status === 'CANCELLED' && { cancelled: true }),
  };
}

export function statementDocFromData(
  customer: any, entries: any[], repName: string, company?: Company | null,
  /**
   * مدّة الكشف وطرفا رصيدها **كما حسبهما الخادم**.
   *
   * `closingBalance` ليس تزيّداً: عند مدّةٍ بلا حركات كان المستند يسقط إلى
   * `customer.balance` — وهي لقطةٌ لكلّ الزمن يحذّر الخادم نفسه من قراءتها
   * (اقرأ تعليقه في `/statement`). فتطبع ورقةُ شهرٍ ساكنٍ رصيدَ اليوم مطالَباً
   * به عن ذلك الشهر. والمستدعون القدامى لا يمرّرون شيئاً فيبقى سلوكهم كما كان.
   *
   * و`timezone` منطقة الشركة التي رشّح بها الخادم الفترة (يعيدها مع الكشف): مرّرها كما
   * وصلت — بها تُطبع لحظاتُ الحركات بأيام الفترة نفسها لا بأيام جهاز المُصدِر.
   */
  range?: { from?: string; to?: string; openingBalance?: number; closingBalance?: number; timezone?: string | null; teamScoped?: boolean }
): StatementDoc {
  const mapped: StatementEntry[] = entries.map((e: any) => ({
    date: e.entryDate,
    description: e.description,
    ref: e.invoice?.number || e.receipt?.number || '',
    debit: Number(e.debit),
    credit: Number(e.credit),
    balance: Number(e.balance),
    type: e.type,
    // لا نُرفق الأصناف بقيد التحصيل النقدي (RECEIPT_CREDIT) فهو يكرّر نفس فاتورة البيع
    items: (e.type !== 'RECEIPT_CREDIT' ? (e.invoice?.items || []) : []).map((it: any) => ({
      name: it.product?.name ?? '-', qty: Number(it.qty), unit: it.unitName || it.product?.unit,
      ...(it.unitFactor != null && { unitFactor: factorOf(it) }),
    })),
  }));
  const totalDebit = mapped.reduce((s, e) => s + e.debit, 0);
  const totalCredit = mapped.reduce((s, e) => s + e.credit, 0);
  const finalBalance = statementFinalBalance({
    closingBalance: range?.closingBalance,
    lastEntryBalance: mapped.length ? mapped[mapped.length - 1].balance : undefined,
    customerBalance: Number(customer.balance ?? 0),
  });
  return {
    kind: 'statement',
    company: company ?? null,
    customer,
    repName,
    date: new Date().toISOString(),
    fromDate: range?.from,
    toDate: range?.to,
    // منطقة الشركة كما وصلت من الخادم؛ المستدعون الذين لا يمرّرونها تبقى ورقتهم بمنطقة الجهاز
    timezone: range?.timezone ?? null,
    openingBalance: range?.openingBalance,
    entries: mapped,
    totalDebit,
    totalCredit,
    finalBalance,
    teamScoped: range?.teamScoped === true,
  };
}

export function settlementLogDocFromData(
  repName: string,
  // `method` اختياريّ هنا عمداً: صفوف الخادم تحمله، والمستدعون القدامى (ومسار
  // العمل دون اتصال) يمرّون بلا حقل — فيقع الصفّ على «نقدي» افتراضَ العمود.
  items: { amount: number | string; note?: string | null; createdBy?: string | null; settledAt: string; method?: string | null }[],
  company?: Company | null,
  summary?: { collected?: number; outstanding?: number },
): SettlementLogDoc {
  const entries: SettlementEntry[] = items.map((s) => ({
    settledAt: s.settledAt,
    amount: Number(s.amount),
    by: s.createdBy || undefined,
    note: s.note || undefined,
    method: s.method || undefined,
  }));
  const total = entries.reduce((a, e) => a + e.amount, 0);
  return {
    kind: 'settlement',
    company: company ?? null,
    repName,
    date: new Date().toISOString(),
    entries,
    total,
    collected: summary?.collected,
    outstanding: summary?.outstanding,
  };
}

export function loadNoticeDocFromData(
  repName: string,
  // lots («تتبّع اللوط»): صفوف توزيع البند كما يضمّها /van-stock/loads أو /movements بـwithLots=1 (VanLoadItemLotDto)
  movement: { kind: string; date: string; ref?: string; by?: string | null; items: { name: string; qty: number; unit?: string; unitName?: string | null; unitFactor?: number | null; baseQty?: number | null; lots?: unknown }[] },
  company?: Company | null,
): LoadNoticeDoc {
  return {
    kind: 'loadNotice',
    company: company ?? null,
    repName,
    date: movement.date,
    movementKind: movement.kind,
    note: movement.ref || undefined,
    by: movement.by || undefined,
    /* لقطة وحدة السطر أوّلاً (VanLoadItem.unitName)، ثم ما أرسلته الحركة. والمعامل من لقطته، وإلا من الكمية بالأساس
     * التي يرسلها /van-stock/movements مع كل سطر — به يعرف الإشعار أنّ وحداته اختلطت فلا يجمعها رقماً واحداً */
    items: movement.items.map((i) => {
      const f = i.unitFactor != null ? factorOf(i)
        : i.baseQty != null && Number(i.qty) ? roundQty(Number(i.baseQty) / Number(i.qty)) : null;
      return { name: i.name, qty: Number(i.qty), unit: i.unitName || i.unit || undefined, ...(f != null && { unitFactor: f }), ...lotsField(i.lots) };
    }),
  };
}

/**
 * إشعار مستودع من حركةٍ كما يردّها `GET /warehouse/entries`.
 *
 * يُبنى من الصفّ الذي في اليد لا بطلبٍ جديد: السجلّ ردّ بالحركة كاملةً بأسطرها
 * وقيمها المحسوبة في الخادم، وإعادة حسابها هنا حسابٌ ثانٍ لرقمٍ واحد.
 */
export function warehouseNoticeDocFromEntry(
  entry: {
    id: string; type: string; createdAt: string;
    supplier?: string | null; note?: string | null; createdBy?: string | null;
    // lot («تتبّع اللوط»): تشغيلة السطر كما يضمّها السجل حين تكون الميزة مفعّلة — سطرٌ = تشغيلةٌ واحدة
    items: {
      qty: number; unitName?: string | null; unitFactor?: number | null; unitCost?: number | null; lineCost?: number | null; product: { name: string; unit?: string };
      lot?: { lotNumber?: string | null; productionDate?: string | null; expiryDate?: string | null } | null;
    }[];
    totalCost: number;
  },
  company?: Company | null,
): WarehouseNoticeDoc {
  return {
    kind: 'warehouseNotice',
    company: company ?? null,
    entryType: entry.type,
    ref: noticeRef(entry.id),
    date: entry.createdAt,
    supplier: entry.supplier || undefined,
    note: entry.note || undefined,
    by: entry.createdBy || undefined,
    items: entry.items.map(i => {
      const lots = warehouseLineLots(i.lot, Number(i.qty) * factorOf(i));
      return {
        name: i.product.name,
        // لقطة وحدة السطر: الكمية وسعر الوحدة بها — وإلا طُبعت تكلفة الكرتون منسوبةً للحبّة
        unit: i.unitName || i.product.unit || undefined,
        ...(i.unitFactor != null && { unitFactor: factorOf(i) }),
        qty: Number(i.qty),
        unitCost: i.unitCost == null ? null : Number(i.unitCost),
        lineCost: i.lineCost == null ? null : Number(i.lineCost),
        ...(lots && { lots }),
      };
    }),
    totalCost: Number(entry.totalCost) || 0,
  };
}

// ============ شريط مرفقات سند القبض ============
/**
 * صور إيصال التحويل أو الشيك التي أرفقها المندوب بالسند.
 *
 * **لماذا شريطٌ خارج المستند لا قسمٌ داخله:** `PrintableReceipt` تُلتقط كاملةً
 * إلى PDF بمقاس A4 (`PAGE`) — سندٌ رسميّ يُسلَّم للعميل ويُحفظ في دفاتره. وحشوُ
 * صورِ هاتفٍ بعرض الصفحة فيه يدفع التوقيعين إلى صفحة ثانية ويضخّم الملفّ
 * المُرسَل. فالمرفق **دليلٌ للمحاسب** لا بندٌ في السند: يُعرض هنا مصغّراً بمقاس
 * ثابت، ويُفتح كاملاً بنقرة. ولا يظهر عنوانٌ إن لم يكن ثمّة مرفق.
 *
 * ويكفي وجوده هنا لتُرى المرفقات في الأسطح الثلاثة: لوحة الويب (داخل
 * `DocumentModal`)، ولوحة الجوال (`MDocScreen`)، وتطبيق المندوب — فكلّها تفتح
 * السند بهذا المكوّن نفسه.
 */
function ReceiptAttachments({ photos }: { photos: ReceiptPhoto[] }) {
  const tr = useTr();
  const [zoom, setZoom] = useState<string | null>(null);

  // زرّ الرجوع في أندرويد يُغلق التكبير لا التطبيق — سطحان من الثلاثة تطبيقا جوّال
  useBackClose(!!zoom, () => setZoom(null));
  // وEscape للوحة الويب: المحاسب على لوحة مفاتيح لا على شاشة لمس
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  return (
    <>
      {/* نفس مفتاح لافتة الرفع في شاشة المندوب: من أرفق «مرفقات» يجدها «مرفقات» */}
      <p className="text-xs text-gray-400 mb-2">{tr('مرفقات')} ({photos.length})</p>
      {/* شريط أفقيّ يمتدّ لحافّتي الحاوية (-mx-4 px-4): سقف الخادم ثمانية مرفقات
          لا تسعها شبكةٌ في عرض 400px، والمقاس الثابت يمنع قفزة التخطيط عند التحميل */}
      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 mb-4">
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setZoom(p.data)}
            aria-label={`${tr('مرفقات')} ${i + 1}`}
            className="shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-gray-200 bg-white hover:border-[#1E7A52]"
          >
            <img src={p.data} alt="" loading="lazy" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>

      {/* تكبير — طبقة بسيطة فوق كل شيء: فتح data: URL في تبويب جديد يحجبه المتصفّح */}
      {zoom && (
        <div
          className="fixed inset-0 z-[1200] bg-black/90 flex items-center justify-center p-4"
          {...backdropClose(() => setZoom(null))}
        >
          <img src={zoom} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          <button
            type="button"
            onClick={() => setZoom(null)}
            aria-label={tr('إغلاق')}
            className="absolute p-2 text-white/80 hover:text-white"
            style={{ insetInlineEnd: 16, top: 'calc(1rem + env(safe-area-inset-top))' }}
          >
            <X size={26} />
          </button>
        </div>
      )}
    </>
  );
}

/**
 * «تتبّع اللوط» — شريط «تشغيلات البنود» خارج الورقة (نمط شريط المرفقات): تشغيلات كل بند متى وصلت من الخادم، ولو لم تُطبع على
 * الفاتورة (lotOnInvoice مطفأ) — فالمعاينة المصغّرة لا تُقرأ، والإدارة تحتاج اللوط لترد على سؤال العميل أو السحب. بلا صفوف
 * (الميزة مطفأة أو بلا withLots) ⇒ لا شيء. **للإدارة وحدها** (§٦.١): يُرسم بـshowLotsStrip من DocumentModal وMDocScreen، وشاشة
 * المندوب بلا شريط — ما يُريه العميلَ لا يُظهر التشغيلة إلا على الورقة بشرط lotOnInvoice.
 */
function InvoiceLotsStrip({ doc }: { doc: InvoiceDoc }) {
  const tr = useTr();
  const rows = doc.items.map((it) => ({ it, lots: docLotRows(it.lots) })).filter((r) => r.lots.length > 0);
  if (!rows.length) return null;
  return (
    <div className="bg-white border border-[#E9E1D3] rounded-2xl p-3 mb-4 text-xs leading-relaxed">
      <p className="font-bold text-[#1F1A13] mb-1">{tr('تشغيلات البنود')}</p>
      {rows.map(({ it, lots }, i) => (
        <div key={i} className={`py-1.5 ${i ? 'border-t border-[#F1EBDF]' : ''}`}>
          <p className="font-semibold text-[#6E6557]">{it.name}</p>
          {lots.map((l, k) => <p key={k} className="text-[#1F1A13]">{lotLineText(l, { tr, unitFactor: it.unitFactor })}</p>)}
        </div>
      ))}
    </div>
  );
}

// ============ شاشة النتيجة (معاينة + مشاركة/حفظ PDF) ============
export function DocumentResult({ doc, onClose, showLotsStrip = false }: {
  doc: AnyDoc; onClose: () => void;
  /** «تتبّع اللوط»: شريط «تشغيلات البنود» خارج الورقة — للإدارة وحدها (§٦.١)، فلا يمرّره تطبيق المندوب */
  showLotsStrip?: boolean;
}) {
  const tr = useTr();
  const printRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const isReceipt = doc.kind === 'receipt';
  const isStatement = doc.kind === 'statement';
  const isSettlement = doc.kind === 'settlement';
  const isLoadNotice = doc.kind === 'loadNotice';
  const isWarehouseNotice = doc.kind === 'warehouseNotice';
  const green = isReceipt || isSettlement || isLoadNotice || isWarehouseNotice; // مستندات الاستلام والحركة بطابع أخضر
  const headerBg = 'bg-[#1F1A13]';
  const accentBtn = green ? 'bg-[#1E7A52] hover:bg-[#176A46]' : 'bg-[#E15A30] hover:bg-[#C94E28]';
  const confirmBg = green ? 'bg-[#E4F1EA] border-[#cfe8db]' : 'bg-[#FBEBE2] border-[#F5DACE]';
  /* فوترة ZATCA المرحلة الثانية (Z5.6b): القرار نفسه الذي يبني الورقة يحكم أزرارها — مستندٌ لا ورقة له
   * لا زرّ طباعة له ولا مشاركة، ومستندٌ صار سند تسليم يُسمّى الزرُّ باسمه لا «مشاركة الفاتورة». */
  const zDoc = doc.kind === 'invoice' ? doc.zatca ?? null : null;
  const zDecision = doc.kind === 'invoice'
    ? zatcaPrintDecision({ isReturn: !!doc.isReturn, buyerHasTaxNumber: !!doc.customer.taxNumber, saudi: isSaudiDoc(doc.company) }, zDoc)
    : null;
  const zChip = zDoc ? zatcaChipOf(zDoc) : null;
  const zBlocked = zDecision !== null && !zDecision.canPrint;
  const canThermal = (doc.kind === 'invoice' || doc.kind === 'receipt') && !zBlocked;
  /* صندوق التأكيد يتبع القرار: مستندٌ رفضته الهيئة أو سُحب كان يظهر بعلامة صحّ خضراء فوق «المستند مبطل لدى الهيئة»
   * — أوّل ما يراه المندوب علامةُ نجاح ثمّ يقرأ تحتها البطلان. فالمُبطل بالأحمر، وما لم تحسمه الهيئة بالكهرمانيّ. */
  const zTone: 'void' | 'wait' | null = zDecision === null ? null
    : zDecision.kind === 'void' ? 'void'
    : zDecision.kind === 'pending' ? 'wait'
    : null;

  /* «إعدادات الطباعة» (M2): قالب الطباعة المباشرة لهذا النوع من توجيه الشركة (ومن اختيار الجهاز إن سمحت)، وقالب ملف PDF.
   * بلا إعدادات (null أو تالفة) ⇒ الافتراضي حرفياً: الزرّ الحراري بنصّه نفسه للفواتير والسندات وحدها وPDF الـA4 — ولا يُقرأ
   * اختيار الجهاز ولا يظهر سطر «تغيير». */
  const { settings, customized } = useMemo(() => readPrintSettings(doc.company?.printSettings), [doc.company?.printSettings]);
  const printKind = printKindOf(doc.kind);
  const printIdent = useMemo(() => currentPrintIdentity(), []);
  const [deviceChoice, setDeviceChoice] = usePrintDeviceChoice(printIdent);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const directProfile = profileFor(settings, printKind, customized ? deviceChoice : null);
  // كل طباعةٍ مباشرة (حرارية أو صفحة أو نقطية) محروسةٌ بحال المستند كزرّ المشاركة: مستندٌ لا ورقة له لا يُطبع من أيّ قالب
  const canDirect = directProfile !== null && !zBlocked && (directProfile.printer !== 'thermal' || canThermal);
  const legacyDirect = directProfile?.id === LEGACY_THERMAL_ID;
  const deviceChoices = customized && settings.repMayChoose ? deviceProfilesFor(settings, printKind) : [];
  const pdfProfile = pdfProfileOf(settings);
  const pdfLook = useMemo(() => lookFor(pdfProfile), [pdfProfile]);
  const pageProfile = directProfile !== null && directProfile.printer !== 'thermal' ? directProfile : null;
  const pageLook = useMemo(() => (pageProfile ? lookFor(pageProfile) : null), [pageProfile]);
  // قالب الطباعة غير قالب الـPDF ⇒ نسخةٌ ثانية خارج الشاشة بمظهره؛ وإلا فالنسخة نفسها
  const separatePage = pageProfile !== null && pageProfile.id !== pdfProfile.id;
  const pageRef = useRef<HTMLDivElement>(null);
  /* «إعدادات الطباعة» M3: طريقة هذا الجهاز — البلوتوث المباشر إن اختاره من «تغيير» ودعمه المتصفح والقالب، وإلا نظام الطباعة.
   * بلا إعدادات مخصّصة: نظام الطباعة دائماً (الزرّ كاليوم حرفاً بحرف). وتعذّر البلوتوث يعرض سببه وبديله (نظام الطباعة أو PDF). */
  const directTransport: PrintTransport = customized ? transportFor(directProfile, deviceChoice) : 'system';
  const bt = useDirectPrint();
  const [directError, setDirectError] = useState<string | null>(null);

  const printDirect = async () => {
    if (!canDirect || !directProfile) return;
    await printWith(directTransport);
  };
  /** الطباعة بطريقةٍ معلومة — زرّ الطباعة بطريقة الجهاز، وزرّ البديل بنظام الطباعة بعد تعذّر البلوتوث */
  const printWith = async (via: PrintTransport) => {
    if (!canDirect || !directProfile) return;
    setBusy(true); setStatus(''); setDirectError(null);
    try {
      // المنفذ أوّل الضغطة: نافذة اختيار الطابعة تحتاج إيماءة المستخدم قبل أيّ عملٍ طويل
      const port = via === 'bt-serial' && supportsDirect(directProfile) ? await printerForJob() : null;
      // حصيلة البلوتوث (تُكتب من داخل مسار الشريط) — حاويةٌ لا متغيّر: التضييق لا يتبع الإسناد داخل الدوالّ
      const sent: { outcome: 'done' | 'cancelled' | null } = { outcome: null };
      if (directProfile.printer === 'thermal') {
        // الملف الافتراضي (legacy-58) يعود في thermal.ts إلى شريط اليوم حرفاً بحرف (ولا يُرسل بالبلوتوث أبداً)
        const opts = {
          profile: directProfile, tr,
          raster: port ? async (html: string) => { sent.outcome = await bt.run((ui) => printHtmlDirect(port, html, directProfile, 'copies', ui), { slow: deviceChoice?.slow }); } : null,
        };
        if (doc.kind === 'invoice') await printThermalInvoice(doc, opts);
        else if (doc.kind === 'receipt') await printThermalReceipt(doc, opts);
      } else {
        const node = separatePage ? pageRef.current : printRef.current;
        if (!node) throw new Error('print sheet');
        if (port) sent.outcome = await bt.run((ui) => printNodeDirect(port, node, directProfile, [tr('الأصل'), tr('نسخة')], ui), { slow: deviceChoice?.slow });
        else await printPageNode(node, directProfile, [tr('الأصل'), tr('نسخة')]);
      }
      if (sent.outcome) setStatus(sent.outcome === 'cancelled' ? tr('ألغيت الطباعة') : tr('✓ تم الإرسال إلى الطابعة'));
    } catch (e) {
      if (e instanceof DirectPrintError) setDirectError(tr(e.message));
      else setStatus(tr(e instanceof PrintRefusedError ? e.message : 'تعذرت الطباعة تأكد من إعداد الطابعة'));
    }
    setBusy(false);
  };

  const isReturnDoc = doc.kind === 'invoice' && doc.isReturn;
  const subjectName = (doc.kind === 'settlement' || doc.kind === 'loadNotice') ? doc.repName
    : doc.kind === 'warehouseNotice' ? (doc.supplier || tr('مخزون الشركة'))
    : doc.kind === 'stockRequest' ? `${tr('موجه إلى')} ${tr(stockRequestToLabel(doc.to))}`
    : doc.customer.name;
  const warehouseLabel = doc.kind === 'warehouseNotice'
    ? (doc.entryType === 'RECEIVE' ? tr('إشعار وارد') : tr('إشعار تسوية'))
    : '';
  const noticeLabel = doc.kind === 'loadNotice'
    ? (doc.movementKind === 'UNLOAD' ? tr('إشعار تنزيل') : doc.movementKind === 'ADJUST' ? tr('إشعار تسوية') : tr('إشعار تحميل'))
    : '';
  const title = doc.kind === 'invoice' ? `${isReturnDoc ? tr('فاتورة مرتجع') : tr('الفاتورة')} — ${doc.number}`
    : doc.kind === 'receipt' ? `${tr('سند القبض')} — ${doc.number}`
    : doc.kind === 'settlement' ? `${doc.entries.length === 1 ? tr('سند استلام') : tr('سجل التحصيل')} — ${doc.repName}`
    : doc.kind === 'loadNotice' ? `${noticeLabel} — ${doc.repName}`
    : doc.kind === 'warehouseNotice' ? `${warehouseLabel} — ${doc.ref}`
    : doc.kind === 'stockRequest' ? `${tr('طلب مخزون')} — ${doc.ref}`
    : `${tr('كشف حساب')} — ${doc.customer.name}`;
  const filename = (doc.kind === 'invoice' ? `${zDecision?.kind === 'deliveryNote' ? tr('سند تسليم') : isReturnDoc ? tr('مرتجع') : tr('فاتورة')}-${doc.number}`
    : doc.kind === 'receipt' ? `${tr('سند قبض')}-${doc.number}`
    : doc.kind === 'settlement' ? `${doc.entries.length === 1 ? tr('سند تحصيل') : tr('سجل تحصيل')}-${doc.repName}`
    : doc.kind === 'loadNotice' ? `${noticeLabel}-${doc.repName}`
    : doc.kind === 'warehouseNotice' ? `${warehouseLabel}-${doc.ref}`
    : doc.kind === 'stockRequest' ? `${tr('طلب مخزون')}-${doc.ref}`
    : `${tr('كشف حساب')}-${doc.customer.name}`) + '.pdf';
  const confirmText = isSettlement ? tr('سجل التحصيل جاهز') : (isLoadNotice || isWarehouseNotice) ? tr('الإشعار جاهز')
    : doc.kind === 'stockRequest' ? tr('طلب المخزون جاهز')
    : isStatement ? tr('كشف الحساب جاهز') : tr(zDecision ? zDecision.confirmText : 'تم الإصدار بنجاح');

  const renderDoc = (refProp?: React.Ref<HTMLDivElement>) => {
    if (doc.kind === 'invoice') return <PrintableInvoice ref={refProp} doc={doc} />;
    if (doc.kind === 'receipt') return <PrintableReceipt ref={refProp} doc={doc} />;
    if (doc.kind === 'settlement') return <PrintableSettlementLog ref={refProp} doc={doc} />;
    if (doc.kind === 'loadNotice') return <PrintableLoadNotice ref={refProp} doc={doc} />;
    if (doc.kind === 'warehouseNotice') return <PrintableWarehouseNotice ref={refProp} doc={doc} />;
    if (doc.kind === 'stockRequest') return <PrintableStockRequest ref={refProp} doc={doc} />;
    return <PrintableStatement ref={refProp} doc={doc} />;
  };

  const makePdf = async () => {
    if (!printRef.current) return;
    setBusy(true); setStatus('');
    try {
      // الرمز المختوم لا يمرّ على ضغطٍ فاقد: حُجَيراته أدقّ من أن تحتمله (انظر elementToPdfBlob)
      const blob = await elementToPdfBlob(printRef.current, { lossless: zDecision?.qr.source === 'stamped' });
      const result = await shareOrDownloadPdf(blob, filename);
      setStatus(result === 'shared' ? tr('✓ تمت المشاركة') : tr('✓ تم حفظ الملف في جهازك'));
    } catch {
      setStatus(tr('تعذر إنشاء الملف حاول مجددا'));
    }
    setBusy(false);
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className={`${headerBg} text-white p-4 flex items-center gap-3`}>
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold text-sm">{title}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* تأكيد — ولونه وأيقونته من حال المستند لا من نوعه وحده */}
        <div className={`${zTone === 'void' ? 'bg-red-50 border-red-200' : zTone === 'wait' ? 'bg-amber-50 border-amber-200' : confirmBg} border rounded-2xl p-4 mb-4 flex items-center gap-3`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white ${
            zTone === 'void' ? 'bg-red-600' : zTone === 'wait' ? 'bg-amber-500' : accentBtn}`}>
            {zTone ? <AlertTriangle size={20} /> : <Check size={20} />}
          </div>
          <div>
            <p className="font-bold text-gray-800 text-sm">{confirmText}</p>
            <p className="text-xs text-gray-500">{subjectName}</p>
          </div>
        </div>

        {/* حالة المستند لدى الهيئة (المرحلة الثانية) — شارةٌ وشرحٌ عربيّ لما يفعله المندوب الآن */}
        {zChip && (
          <div className={`rounded-2xl p-3 mb-4 text-xs leading-relaxed border ${
            zChip.tone === 'danger' ? 'bg-red-50 border-red-200 text-red-800'
            : zChip.tone === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800'
            : zChip.tone === 'ok' ? 'bg-green-50 border-green-200 text-green-800'
            : zChip.tone === 'muted' ? 'bg-gray-50 border-gray-200 text-gray-600'
            : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
            <b>{tr(zChip.label)}</b> — {tr(zChip.hint)}
          </div>
        )}

        {/* تنبيه العمل دون اتصال: المستند مُلتقَط محلياً برقم مؤقّت، يرتفع للخادم عند الاتصال */}
        {(doc.kind === 'invoice' || doc.kind === 'receipt') && doc.offline && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-4 text-xs text-amber-800 leading-relaxed">
            <b>{tr('أنشئ دون اتصال')}</b> — {tr('الرقم مؤقت ويعتمد رقمه النهائي تلقائيا عند اتصالك بالإنترنت اطبع/سلم نسختك الآن بشكل طبيعي')}
          </div>
        )}

        {/* المرفقات قبل المعاينة عمداً: المعاينة كتلة بطول 470px تدفع الشريط تحت
            حافّة الشاشة، والمحاسب إنما فتح السند ليرى إيصال التحويل */}
        {doc.kind === 'receipt' && !!doc.photos?.length && <ReceiptAttachments photos={doc.photos} />}
        {doc.kind === 'invoice' && showLotsStrip && <InvoiceLotsStrip doc={doc} />}

        {/* معاينة مصغّرة للمستند */}
        <p className="text-xs text-gray-400 mb-2">{tr('معاينة المستند')}</p>
        <div className="mx-auto bg-white rounded-xl border border-gray-200 shadow-sm" style={{ width: 340, height: 470, overflow: 'hidden' }}>
          <div style={{ transform: 'scale(0.428)', transformOrigin: 'top right', width: 794 }}>
            <PrintLookContext.Provider value={pdfLook}>{renderDoc()}</PrintLookContext.Provider>
          </div>
        </div>

        {status && <p className="text-center text-green-600 text-sm font-medium mt-3">{status}</p>}
      </div>

      {/* أزرار */}
      <div className="p-4 border-t bg-white space-y-2">
        {/* الطباعة المباشرة بقالب المستند — الافتراضي بنصّ اليوم «طباعة حرارية 58 مم»، وغيره «طباعة — اسم القالب» كما كتبته الشركة */}
        {canDirect && directProfile && (
          <>
            <button onClick={printDirect} disabled={busy}
              className="w-full bg-white border-2 border-[#DED5C4] text-[#1F1A13] font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
              <Printer size={17} /> {legacyDirect ? tr('طباعة حرارية 58 مم') : `${tr('طباعة')} — ${profileDisplayName(directProfile, tr)}`}
            </button>
            {/* سطر الطابعة: لاختيار قالبٍ آخر (بإذن الشركة) أو للطريقة والمعايرة (قالبٌ يُرسل بالبلوتوث) — والإعداد الافتراضي بلا سطر */}
            {(deviceChoices.length > 1 || (customized && supportsDirect(directProfile))) && (
              <p className="text-[11px] text-gray-500 text-center">
                {tr('الطابعة')}: {profileDisplayName(directProfile, tr)}
                {customized && supportsDirect(directProfile) && <> · {directTransport === 'bt-serial' ? tr('بلوتوث مباشر') : tr('نظام الطباعة في الجهاز')}</>}
                {' '}·{' '}
                <button type="button" onClick={() => setDeviceOpen(true)} className="text-[#C94E28] font-semibold">{tr('تغيير')}</button>
              </p>
            )}
            {/* تعذّر البلوتوث: السبب بالعربية والبديل — نظام الطباعة هنا، وPDF في زرّه أدناه */}
            {directError && (
              <div className="bg-red-50 border border-red-200 text-red-800 text-xs leading-relaxed rounded-xl p-3 text-center" role="alert">
                <p className="font-semibold">{directError}</p>
                <p className="mt-1 text-red-700/80">{tr(DIRECT_PRINT_FALLBACK)}</p>
                <button type="button" onClick={() => printWith('system')} disabled={busy}
                  className="mt-2 w-full bg-white border border-red-200 text-[#1F1A13] font-semibold py-2 rounded-lg flex items-center justify-center gap-2 disabled:opacity-60">
                  <Printer size={15} /> {tr('اطبع بنظام الطباعة في الجهاز')}
                </button>
              </div>
            )}
            {customized && directProfile.printer === 'impact' && directTransport === 'system' && (
              <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                {tr(PRINT_NOTES.impactDesktop)}
                {directPrintAvailable() && <> — {tr('للطباعة من الجوال اختر البلوتوث المباشر من تغيير')}</>}
              </p>
            )}
          </>
        )}
        {/* مستند لا ورقة له (مُبطل أو لم تحسمه الهيئة): لا زرّ مشاركة يُخرج ورقةً تُقرأ مستنداً ضريبياً */}
        {zBlocked ? (
          <p className="w-full bg-red-50 border border-red-200 text-red-800 text-xs leading-relaxed rounded-xl p-3 text-center">
            {tr(zDecision?.notice || 'لا يحمل هذا المستند رمز فاتورة ضريبية')}
          </p>
        ) : (
          <button onClick={makePdf} disabled={busy}
            className={`w-full ${accentBtn} text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60`}>
            {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Share2 size={17} />}
            {tr(zDecision ? zDecision.shareLabel : 'مشاركة / حفظ PDF')}
          </button>
        )}
        <button onClick={onClose} className="w-full bg-gray-100 text-gray-700 font-semibold py-3 rounded-xl">{tr('تم')}</button>
      </div>

      {/* النسخة الكاملة (خارج الشاشة) للالتقاط — بمظهر قالب الـPDF؛ ونسخةٌ ثانية بمظهر قالب الطباعة حين يختلفان */}
      <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
        <PrintLookContext.Provider value={pdfLook}>{renderDoc(printRef)}</PrintLookContext.Provider>
        {separatePage && pageLook && <PrintLookContext.Provider value={pageLook}>{renderDoc(pageRef)}</PrintLookContext.Provider>}
      </div>

      {deviceOpen && directProfile && (
        <PrintDeviceSheet
          settings={settings} kind={printKind} current={directProfile}
          chosenId={deviceChoice?.byKind?.[printKind] ?? null}
          onPick={(id) => setDeviceChoice(withKindChoice(deviceChoice, printKind, id))}
          choice={deviceChoice} onChoice={setDeviceChoice}
          company={doc.company}
          renderSheet={(d, ref) => <PrintableInvoice ref={ref} doc={d} />}
          onClose={() => setDeviceOpen(false)}
        />
      )}
      <DirectPrintOverlay job={bt.job} onCancel={bt.cancel} />
    </div>
  );
}
