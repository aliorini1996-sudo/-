/**
 * «كلاسيكي بإطارات — ثنائي اللغة» (grid_bilingual) — قالب A4/النقطية الجديد على نموذج فاتورة أنظمة ERP التي أرسلها المالك
 * (٣ نوفمبر ٢٠٢٦): ترويسة إنجليزي يساراً وشعار في الوسط وعربي يميناً، صندوق الرقم والتاريخ وطريقة الدفع وبجانبه رمز QR،
 * صندوقا البائع والمشتري، جدول أصناف بشبكة كاملة وعناوين بلغتين، صندوق الإجماليات، وأربع خانات توقيع.
 *
 * قواعده:
 * · ليس TemplateId جديداً — يُختار بـ`options.layout.design='grid_bilingual'` فيصل هنا من PrintableInvoice/PrintableReceipt
 *   (rep/RepDocuments.tsx) وحدهما. وكل ما بلا `layout` يبقى على قالب اليوم حرفاً بحرف (الحرّاس الذهبية).
 * · نقيّ تقوده الخصائص: الحقائق (القرار الضريبي والعنوان والنسبة) تُحسب في القالب الأصليّ وتُمرَّر، والرمز عقدةٌ جاهزة (`qr`)
 *   يبنيها القالب الأصليّ (InvoiceQrBlock) — هذا الملف لا يبني رمزاً ولا يكتب قيمته ولا يستورد من RepDocuments إلا أنواعاً.
 * · العربية أولاً دائماً (إلزامية في الفاتورة الضريبية) والإنجليزية ثانيةً من `pt.en` — أيّاً كانت لغة واجهة الجهاز.
 * · «حذف السطر» (نصوص المطبوعات): مفتاحٌ محذوف يُسقط وحدته كاملة — التسمية العربية والإنجليزية والقيمة، أو عمود الجدول كله،
 *   أو صفّ الإجمالي، أو الخانة، أو الصندوق الذي يعنونه. كل عنصرٍ من الوحدة يحمل `data-line` بمفاتيحه (مفصولةً بمسافة) فيُفحص
 *   غيابه بـ`[data-line~="key"]`. وفي معاينة المحرّر لا يُحذف شيء: الوحدة مشطوبةٌ باهتة وتسميتها قابلةٌ للنقر.
 * · رمز QR ليس عبارة: يُطبع متى مُرِّر مهما حُذف من النصوص — والقالب الأصليّ لا يمرّره (null) إلا حين تحذفه الشركة صراحةً
 *   (isQrRemoved، قرار المالك ٤ نوفمبر ٢٠٢٦). وأختام الحالة (وسم البروفة والإشعار و«سند ملغى») تسقط بـareStampsRemoved وحده.
 * · أحادي اللون/النقطية: حدود ‎#000 بعرض 1px وبلا تعبئة رمادية (عتبة النقطية ١٦٠)؛ ولون التمييز (accentColor) على خط الترويسة
 *   وخلفية رؤوس الجدول في الطابعات الملوّنة وحدها.
 * · «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦، pd_spec B.2/B.3): مع مفتاحٍ حرّ (hasFreeLayout) أو معاينة المصمّم كل قسمٍ ظاهر
 *   ملفوفٌ بـ<div data-sec> بمحاذاته ومسافتيه، وحجم خطّه `fontSize: pct%` (القالب بوحدة em — لا zoom ولا filter)؛ والمخفيّ يسقط؛
 *   والشعار بحجمٍ حرّ (logoMm: max-width/max-height بلا object-fit — html2canvas يمطّه) وكتلةٌ مستقلة (data-section="logo")
 *   أعلى الورقة أو بعد قسم؛ و«البيانات» مخفيّة ⇒ رمز QR كتلةٌ وحده (data-section="qr") بعد الترويسة — لا يُحذف إلا صراحةً؛ ووسم
 *   النسخة بعد غلاف الترويسة (data-copy-anchor). وبلا مفتاحٍ حرّ ولا معاينة: الورقة كما هي حرفاً (layout6 والحرّاس الذهبية).
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';
import type { ZatcaPrintDecision } from '../lib/zatca/docPrint';
import { phraseIn, titleKeyOf, type PrintTexts } from '../lib/print/printTexts';
import { PRINT_LOOK_CSS, lookNeedsCss, lookRootAttrs, type PrintLook } from './printLook';
import {
  accentColor, fmtQty4, hasFreeLayout, lineVat, logoBox, logoPlan, mmToPx, orderedSections, qrOrphan, sectionCss, sectionLook, visibleOrder,
  type LogoPlan, type ResolvedLayout, type SectionLook,
} from '../lib/print/layout';
import type { Align, SectionId } from '../lib/print/printSettingsCore';
import { areStampsRemoved } from '../lib/print/printSettings';
import { pdProps, usePrintDesignPreview, type PrintDesignPreview } from './printDesignContext';
import { getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { factorOf } from '../lib/units';
import { invoiceLotsOf, lotLineText } from './docLots';
import { methodLabelFor } from '../lib/paymentMethodsConfig';
import { receiptLinkView } from './receiptLinks';

export interface GridInvoiceFacts {
  pt: PrintTexts;
  zDecision: ZatcaPrintDecision;
  title: { text: string; alt: string | null };
  inclusiveDoc: boolean;
  vatRate: string;
  noteRefs: { ref: string | null; reason: string | null };
}

/** ارتفاع ورقة A4 بعرض 794 بكسل — الورقة مرنة عمودياً فيستقرّ التذييل أسفل فاتورة الصفحة الواحدة */
export const GRID_SHEET_MIN_HEIGHT = 1123;
/** أكثر من هذا من البنود ⇒ مستندٌ متعدّد الصفحات: بلا صفّ حشوٍ ولا تمدّد للجدول */
export const GRID_FILLER_MAX_ITEMS = 18;

/**
 * مفاتيح «نصوص المطبوعات» التي يرسمها هذا القالب (متى وُجدت بياناتها) — كلٌّ بوحدةٍ تحمل `data-line`. ما سواها من القائمة لا موضع
 * له هنا فحذفه لا يغيّر الورقة: inv.type (طريقة الدفع هنا inv.paymentType)، cust.phone، item.beforeTax (السعر هنا قبل الضريبة
 * أصلاً)، qr.caption (من عقدة الرمز الممرَّرة)، tot.subtotal (سند التسليم ذو الخصم وحده)، h.taxNumber (في سند القبض وحده).
 * الأزواج تشترك وحدةً واحدة: col.price/col.priceIncl، tot.vat/tot.vatIncl، tot.due/tot.grand.
 */
export const GRID_INVOICE_KEYS: readonly string[] = Object.freeze([
  'h.address', 'h.phone', 'h.email', 'h.commercialReg',
  'inv.title', 'inv.returnTitle', 'inv.debitTitle', 'inv.deliveryNoteTitle', 'inv.voidTitle', 'inv.pendingTitle', 'inv.infoHeading', 'inv.returnInfoHeading', 'inv.number', 'inv.returnNumber', 'inv.date', 'inv.time',
  'inv.paymentType', 'inv.deliveryDate', 'inv.originalRef', 'inv.noteReason', 'inv.rep',
  'cust.heading', 'cust.name', 'cust.business', 'cust.address', 'cust.city', 'cust.postalCode', 'cust.commercialReg', 'cust.taxNumber',
  'sel.heading', 'sel.name', 'sel.address', 'sel.city', 'sel.postalCode', 'sel.taxNumber',
  'col.seq', 'col.code', 'col.item', 'col.qty', 'col.unit', 'col.discount', 'col.price', 'col.priceIncl', 'col.vatAmount', 'col.tax', 'col.total',
  'note.pricesIncl', 'tot.subtotal', 'tot.exclVat', 'tot.discount', 'tot.taxable', 'tot.vat', 'tot.vatIncl', 'tot.due', 'tot.grand',
  'tot.returnGrand', 'tot.paid', 'tot.remaining',
  'inst.heading', 'inst.dueDate', 'inst.amount', 'inst.sum', 'inst.note',
  'sig.recipient', 'sig.rep', 'sig.warehouse', 'sig.remarks', 'foot.thanks', 'foot.company', 'foot.platform',
]);
export const GRID_RECEIPT_KEYS: readonly string[] = Object.freeze([
  'h.address', 'h.phone', 'h.email', 'h.commercialReg', 'h.taxNumber',
  'rcp.title', 'rcp.number', 'rcp.date', 'rcp.time', 'rcp.rep', 'rcp.method', 'rcp.notes',
  'rcp.customerHeading', 'rcp.from', 'rcp.business', 'rcp.commercialReg', 'rcp.taxNumber', 'rcp.phone', 'rcp.address',
  'rcp.amount', 'rcp.forInvoice', 'rcp.forInvoices', 'rcp.invoiceNo', 'rcp.credit', 'rcp.sigPayer', 'rcp.sigCollector',
  'foot.company', 'foot.platform',
]);

const FONT = "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif";
const INK = '#000';
const B = `1px solid ${INK}`;
const BRAND_FALLBACK = '#1e3a8a';
const STRIKE: CSSProperties = { textDecoration: 'line-through', opacity: 0.35 };
const LTR: CSSProperties = { unicodeBidi: 'isolate' };

// ─── نسخٌ صغيرة محلية (لا استيراد تشغيليّ من RepDocuments: هو من يستورد هذا الملف) ───

/** = isSaudiDoc في RepDocuments: غياب الدولة سعوديّ (افتراض العمود) */
const isSaudi = (c?: { countryCode?: string | null } | null): boolean => (c?.countryCode ?? 'SA').toUpperCase() === 'SA';
/** = isSignatureSrc في RepDocuments */
const isSigSrc = (v: unknown): v is string => typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v);
/** = showsItemUnit في RepDocuments */
const showsUnit = (it: { unit?: string; unitFactor?: number | null; multiUnit?: boolean }, showItemUnit: boolean): boolean =>
  !!it.unit && (showItemUnit || it.multiUnit === true || factorOf(it) !== 1);
const hasArabic = (s: string): boolean => /[؀-ۿ]/.test(s);
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** «03/11/2026 10:42» بأرقام لاتينية بتوقيت الجهاز (كتاريخ قوالب اليوم) — بلا وقتٍ لليوم الخالص */
export function gridDateTime(v: string | Date, withTime: boolean): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

/** التاريخ ومعه وقت الإصدار مقطعاً مستقلاً (وحدة مفتاح الوقت): حذف «وقت الإصدار» يُسقط الوقت ويبقى التاريخ */
function dateWithTime(pt: PrintTexts, v: string, timeKey: string): ReactNode {
  const day = gridDateTime(v, false);
  if (pt.hidden(timeKey) || day === '-') return day;
  const full = gridDateTime(v, true);
  return <>{day}<span {...unitProps(pt, [timeKey])}>{full.slice(day.length)}</span></>;
}

// ─── أدوات النصوص: تسمية بلغتين، حذف الوحدة، ومعاينة المحرّر ───

interface Kit {
  pt: PrintTexts;
  mono: boolean;
  accent: string;
  cur: string;
  dec: number;
  money: (n: number) => string;
}

function kitOf(pt: PrintTexts, look: PrintLook, layout: ResolvedLayout, company: { primaryColor?: string | null; countryCode?: string | null } | null | undefined): Kit {
  const cur = isSaudi(company) ? 'SAR' : getActiveCurrency();
  const dec = currencyDecimals(cur);
  return {
    pt,
    mono: look.mono,
    accent: accentColor(layout, company?.primaryColor, look.mono, BRAND_FALLBACK),
    cur,
    dec,
    money: (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }),
  };
}

/** التسمية العربية: صياغة الشركة أو الافتراضي — بالعربية دائماً (لا بلغة واجهة الجهاز: القالب عربيّ أولاً) */
const arOf = (pt: PrintTexts, key: string, def: string): string => (pt.on ? pt.text(key, def) : def);
/** التسمية الإنجليزية (pt.en) — ولا تكرّر العربي */
function enOf(pt: PrintTexts, key: string, def: string): string | null {
  const v = pt.en(key, def);
  return v && v !== arOf(pt, key, def) ? v : null;
}
/** الوحدة محذوفة (أيّ مفتاحٍ من مفاتيحها المزدوجة) — والمعاينة لا تحذف شيئاً */
const goneAny = (pt: PrintTexts, keys: readonly string[]): boolean => keys.some((k) => pt.hidden(k));
/** في المعاينة: الوحدة المحذوفة في الإعداد مشطوبةٌ باهتة */
const struckAny = (pt: PrintTexts, keys: readonly string[]): boolean => !!pt.preview && keys.some((k) => pt.hiddenInSettings(k));
/** سمات عنصرٍ من الوحدة: مفاتيحها (للفحص) وشطب المعاينة */
function unitProps(pt: PrintTexts, keys: readonly string[], style?: CSSProperties): { 'data-line': string; style: CSSProperties | undefined } {
  const s = struckAny(pt, keys) ? { ...(style ?? {}), ...STRIKE } : style;
  return { 'data-line': keys.join(' '), style: s };
}

/** تسميةٌ قابلةٌ للنقر في معاينة المحرّر — وخارجها محتواها كما هو */
function Pk({ pt, k, children }: { pt: PrintTexts; k: string; children: ReactNode }) {
  const p = pt.preview;
  if (!p) return <>{children}</>;
  return (
    <span data-pt-key={k} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onPick(k); }}
      style={{ cursor: 'pointer', borderRadius: 3, outline: p.active === k ? '2px solid #E15A30' : '1px dashed rgba(225,90,48,0.55)', outlineOffset: 1 }}>
      {children}
    </span>
  );
}

const Ltr = ({ children }: { children: ReactNode }) => <span dir="ltr" style={LTR}>{children}</span>;

// ─── الصناديق: صفّ [EN | القيمة | العربي] ───

interface KvRow {
  keys: string[];
  def: string;
  value: ReactNode;
  /** القيمة لاتينية/رقمية ⇒ معزولة يساراً */
  ltr?: boolean;
  /** نصّ يُلحق بالعربي (نسبة الضريبة) */
  suffix?: string;
}

function KvBox({ kit, rows, enW, arW, style }: { kit: Kit; rows: KvRow[]; enW: number; arW: number; style?: CSSProperties }) {
  const { pt } = kit;
  if (rows.length === 0) return null;
  return (
    <div dir="ltr" style={{ border: B, display: 'flex', flexDirection: 'column', ...style }}>
      {rows.map((r, i) => {
        const k = r.keys[0];
        const ar = arOf(pt, k, r.def);
        const en = enOf(pt, k, r.def);
        return (
          <div key={`${r.keys.join(' ')}-${i}`} {...unitProps(pt, r.keys, {
            display: 'grid', gridTemplateColumns: `${enW}px 1fr ${arW}px`, borderTop: i === 0 ? 'none' : B, flex: '1 1 auto',
          })}>
            <div style={{ padding: '3px 6px', borderRight: B, fontWeight: 700, textAlign: 'left', display: 'flex', alignItems: 'center' }}>
              {en ? <Pk pt={pt} k={k}><span dir="ltr" style={LTR}>{en}</span></Pk> : null}
            </div>
            <div style={{ padding: '3px 6px', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {r.ltr ? <Ltr>{r.value}</Ltr> : <span dir="rtl">{r.value}</span>}
            </div>
            <div dir="rtl" style={{ padding: '3px 6px', borderLeft: B, fontWeight: 700, textAlign: 'right', display: 'flex', alignItems: 'center' }}>
              <Pk pt={pt} k={k}>{r.suffix ? `${ar} ${r.suffix}` : ar}</Pk>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** قيمة ثابتة (نقدي/آجل/تقسيط) بالعربية ومعها لغة العمود الثاني (pt.gridLang — الإنجليزية بلا نصوص): «آجل / Credit» */
function bilingualValue(ar: string, lang: PrintTexts['gridLang']): ReactNode {
  const en = phraseIn(ar, lang);
  return en && en !== ar ? <>{ar} / <Ltr>{en}</Ltr></> : ar;
}

// ─── الشعار: صندوق اليوم (logoBox) أو خطة التحرير الحرّ (logoPlan) ───

/** صورة الشعار ومحاذاتها ومكانها — at='header' داخل الترويسة كاليوم، وغيرها كتلةٌ مستقلة (والترويسة بلا شعار) */
export interface GridLogo { img: ReactNode | null; align: Align; at: LogoPlan['at'] }

export function gridLogo(look: PrintLook, layout: ResolvedLayout, src: string | null | undefined): GridLogo {
  const plan = logoPlan(layout, 'classic', 'grid');
  if (!plan) {
    const lb = logoBox(layout, 'classic', 'grid');
    const logoSrc = lb.show && look.showLogo ? (src || null) : null;
    return { img: logoSrc ? <img src={logoSrc} alt="" style={{ width: lb.px, height: lb.px, objectFit: 'contain', borderRadius: '50%' }} /> : null, align: lb.align, at: 'header' };
  }
  const logoSrc = plan.show && look.showLogo ? (src || null) : null;
  // صندوقٌ أقصى بنسبة الصورة (لا مربّعٌ بـobject-fit: النقطية والـPDF يمطّانه) وبلا قصٍّ دائريّ يأكل أطراف الشعار العريض
  const img = logoSrc
    ? <img src={logoSrc} alt="" style={{ display: 'block', maxWidth: mmToPx(plan.maxWmm), maxHeight: mmToPx(plan.maxHmm), width: 'auto', height: 'auto' }} />
    : null;
  return { img, align: plan.align, at: plan.at };
}

const flexJustify = (a: Align): CSSProperties['justifyContent'] => (a === 'start' ? 'flex-start' : a === 'end' ? 'flex-end' : 'center');

// ─── الترويسة: إنجليزي يساراً، الشعار، عربي يميناً ───

interface HeaderCompany {
  name?: string; address?: string; taxNumber?: string; commercialReg?: string; phone?: string; email?: string;
  logo?: string | null; addrCity?: string | null;
}

/** العلامة المائية للبروفة وتنبيه سند التسليم (قرار الطباعة لا الشركة): في الترويسة كاليوم، وبعد موضعها إن أُخفيت (التحرير الحرّ) */
function gridZatcaBanner(zDecision: ZatcaPrintDecision | null | undefined): ReactNode[] {
  return [
    zDecision?.watermark ? <div key="wm" style={{ border: B, padding: '5px 8px', marginTop: 6, fontWeight: 700, textAlign: 'center' }}>{zDecision.watermark}</div> : null,
    zDecision?.notice ? <div key="nt" style={{ border: B, padding: '5px 8px', marginTop: 6, lineHeight: 1.7 }}>{zDecision.notice}</div> : null,
  ];
}

function GridHeader({ kit, look, logo: lg, company, title, titleKey, showTax, zDecision }: {
  kit: Kit; look: PrintLook; logo: GridLogo; company: HeaderCompany | null | undefined;
  title: { text: string; alt: string | null }; titleKey: string; showTax: boolean; zDecision?: ZatcaPrintDecision | null;
}) {
  const { pt } = kit;
  // لغة العمود الثاني: اللغة الثانية التي اختارتها الشركة، وإلا الإنجليزية كاليوم (C-G1)
  const gl = pt.gridLang;
  const name = company?.name || 'اسم الشركة';
  const nameEn = pt.companyNameAlt ?? (company?.name ? phraseIn(company.name, gl) : null);
  const city = clean(company?.addrCity);
  const lines: { keys: string[]; def: string; value: string; valueEn?: string | null }[] = [];
  if (look.showContact && company?.address) lines.push({ keys: ['h.address'], def: 'العنوان', value: company.address, valueEn: pt.companyAddressAlt });
  if (look.showContact && company?.phone) lines.push({ keys: ['h.phone'], def: 'هاتف', value: company.phone });
  if (look.showContact && company?.email) lines.push({ keys: ['h.email'], def: 'البريد', value: company.email });
  if (company?.commercialReg) lines.push({ keys: ['h.commercialReg'], def: 'السجل التجاري', value: company.commercialReg });
  if (showTax && company?.taxNumber) lines.push({ keys: ['h.taxNumber'], def: 'الرقم الضريبي', value: company.taxNumber });
  const shown = lines.filter((l) => !goneAny(pt, l.keys));
  const saudi = look.showContact && isSaudi(company as { countryCode?: string | null } | null);

  // الشعار داخل الترويسة إلا إن صار كتلةً مستقلة (logoAfter)
  const logo = lg.at === 'header' && lg.img
    ? <div style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center' }}>{lg.img}</div>
    : null;

  const arBlock = (
    <div dir="rtl" style={{ flex: '1 1 0', textAlign: 'right' }}>
      <div style={{ fontSize: '1.45em', fontWeight: 700, marginBottom: 2 }}>{name}</div>
      {shown.map((l) => (
        <div key={l.keys[0]} {...unitProps(pt, l.keys, { fontSize: '0.92em' })}>
          <Pk pt={pt} k={l.keys[0]}>{arOf(pt, l.keys[0], l.def)}</Pk>: {l.keys[0] === 'h.address' ? l.value : <Ltr>{l.value}</Ltr>}
        </div>
      ))}
      {saudi && <div style={{ fontSize: '0.92em' }}>{city ? `المملكة العربية السعودية - ${city}` : 'المملكة العربية السعودية'}</div>}
    </div>
  );
  const enBlock = (
    <div dir="ltr" style={{ flex: '1 1 0', textAlign: 'left', unicodeBidi: 'isolate' }}>
      {nameEn ? <div style={{ fontSize: '1.3em', fontWeight: 700, marginBottom: 2 }}>{nameEn}</div> : null}
      {shown.map((l) => {
        const en = enOf(pt, l.keys[0], l.def);
        const v = l.keys[0] === 'h.address' ? (l.valueEn ?? null) : l.value;
        if (!v) return null;
        return (
          <div key={l.keys[0]} {...unitProps(pt, l.keys, { fontSize: '0.92em' })}>
            {en ? <><Pk pt={pt} k={l.keys[0]}>{en}</Pk>: </> : null}{v}
          </div>
        );
      })}
      {saudi && (gl === 'en'
        ? <div style={{ fontSize: '0.92em' }}>{city && !hasArabic(city) ? `Saudi Arabia - ${city}` : 'Saudi Arabia'}</div>
        : <div style={{ fontSize: '0.92em' }}>{(() => { const c = phraseIn('المملكة العربية السعودية', gl) ?? 'Saudi Arabia'; return city && !hasArabic(city) ? `${c} - ${city}` : c; })()}</div>)}
    </div>
  );

  // العنوان المحذوف يصل هنا نصّاً فارغاً (pt.title ونصّ rcp.title) — لا pt.hidden: لكل عنوانٍ مفتاحه (الملغى وسند التسليم بمفتاحيهما لا inv.title)
  const titleGone = title.text === '';
  const titleEn = title.alt ?? phraseIn(title.text, gl);
  return (
    <div data-section="header">
      <div dir="rtl" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 8, borderBottom: `2px solid ${kit.mono ? INK : kit.accent}` }}>
        {lg.align === 'start' ? logo : null}
        {arBlock}
        {lg.align === 'center' ? logo : null}
        {enBlock}
        {lg.align === 'end' ? logo : null}
      </div>
      {!titleGone && (
        <div {...unitProps(pt, [titleKey], { textAlign: 'center', fontSize: '1.45em', fontWeight: 700, margin: '8px 0 2px' })}>
          <Pk pt={pt} k={titleKey}>
            {title.text}
            {titleEn && titleEn !== title.text ? <span dir="ltr" style={{ display: 'block', fontSize: '0.7em', fontWeight: 700, unicodeBidi: 'isolate' }}>{titleEn}</span> : null}
          </Pk>
        </div>
      )}
      {gridZatcaBanner(zDecision)}
    </div>
  );
}

// ─── التواقيع والتذييل ───

interface Slot { key: string; def: string; img?: string | null; name?: string | null }

function Signatures({ kit, slots }: { kit: Kit; slots: Slot[] }) {
  const { pt } = kit;
  const live = slots.filter((s) => !pt.hidden(s.key));
  if (live.length === 0) return null;
  return (
    <div data-section="signatures" dir="ltr" style={{ display: 'grid', gridTemplateColumns: `repeat(${live.length}, 1fr)`, border: B, marginTop: 8, breakInside: 'avoid' }}>
      {live.map((s, i) => {
        const en = enOf(pt, s.key, s.def);
        return (
          <div key={s.key} {...unitProps(pt, [s.key], { borderLeft: i === 0 ? 'none' : B, padding: '4px 6px', minHeight: 64, display: 'flex', flexDirection: 'column' })}>
            <Pk pt={pt} k={s.key}>
              {en ? <span dir="ltr" style={{ fontWeight: 700, display: 'block', unicodeBidi: 'isolate' }}>{en}</span> : null}
              <span dir="rtl" style={{ fontWeight: 700, display: 'block' }}>{arOf(pt, s.key, s.def)}</span>
            </Pk>
            {isSigSrc(s.img) ? <img src={s.img} alt="" style={{ display: 'block', margin: '2px auto 0', height: 44, maxWidth: 160, objectFit: 'contain' }} /> : null}
            {s.name ? <div dir="rtl" style={{ marginTop: 'auto', textAlign: 'center' }}>{s.name}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

const PLATFORM_DEFAULT = 'صدرت عبر منصة Field Sales · fieldsa.net';

/** نصّ الشركة باللغة الثانية بعد سطرٍ عربيّ بأسلوب القالب « · Alt» — لا شيء بلا نصّها (C-G3/C-G4) */
const withOwnAlt = (alt: string | null): ReactNode => (alt ? <> · <Ltr>{alt}</Ltr></> : null);

function Footer({ kit, thanks, thanksAlt = null, companyName }: { kit: Kit; thanks: string | null; thanksAlt?: string | null; companyName: string }) {
  const { pt } = kit;
  const t = thanks !== null && !pt.hidden('foot.thanks') ? thanks : null;
  // اسم الشركة في التذييل: صياغة الشركة له (foot.company) إن كتبتها، وإلا الاسم كما هو
  const n = pt.hidden('foot.company') ? null : (arOf(pt, 'foot.company', companyName) || null);
  const platform = pt.hidden('foot.platform') ? null : arOf(pt, 'foot.platform', PLATFORM_DEFAULT);
  if (t === null && n === null && platform === null) return null;
  return (
    <div data-section="footer" style={{ marginTop: 8, textAlign: 'center', fontSize: '0.9em' }}>
      {t !== null || n !== null ? (
        <div>
          {t !== null ? <span {...unitProps(pt, ['foot.thanks'])}><Pk pt={pt} k="foot.thanks">{t}{withOwnAlt(thanksAlt)}</Pk></span> : null}
          {t !== null && n !== null ? ' — ' : null}
          {n !== null ? <span {...unitProps(pt, ['foot.company'])}><Pk pt={pt} k="foot.company">{n}{withOwnAlt(pt.ownAlt('foot.company'))}</Pk></span> : null}
        </div>
      ) : null}
      {platform !== null ? (
        <div {...unitProps(pt, ['foot.platform'], { marginTop: 3, fontSize: '0.85em' })}><Pk pt={pt} k="foot.platform">{platform}{withOwnAlt(pt.ownAlt('foot.platform'))}</Pk></div>
      ) : null}
    </div>
  );
}

/** صفوف الإجمالي: [العربي + الإنجليزي | القيمة | العملة] */
interface TotRow { keys: string[]; def: string; value: number; suffix?: string; neg?: boolean; strong?: boolean }

function TotalsBox({ kit, rows }: { kit: Kit; rows: TotRow[] }) {
  const { pt } = kit;
  const live = rows.filter((r) => !goneAny(pt, r.keys));
  if (live.length === 0) return null;
  return (
    <div data-section="totals" dir="rtl" style={{ border: B, marginTop: 8, breakInside: 'avoid' }}>
      {live.map((r, i) => {
        const k = r.keys[0];
        const ar = arOf(pt, k, r.def);
        const en = enOf(pt, k, r.def);
        return (
          <div key={`${r.keys.join(' ')}-${i}`} {...unitProps(pt, r.keys, {
            display: 'grid', gridTemplateColumns: '1fr 120px 52px', borderTop: i === 0 ? 'none' : B,
            fontWeight: r.strong ? 700 : 400, fontSize: r.strong ? '1.12em' : undefined,
          })}>
            <div style={{ padding: '4px 8px', textAlign: 'right' }}>
              <Pk pt={pt} k={k}>
                <span style={{ fontWeight: 700 }}>{r.suffix ? `${ar} ${r.suffix}` : ar}</span>
                {en ? <span dir="ltr" style={{ marginRight: 8, unicodeBidi: 'isolate' }}>{en}</span> : null}
              </Pk>
            </div>
            <div style={{ padding: '4px 8px', borderRight: B, textAlign: 'center' }}><Ltr>{r.neg ? `- ${kit.money(r.value)}` : kit.money(r.value)}</Ltr></div>
            <div style={{ padding: '4px 8px', borderRight: B, textAlign: 'center' }}><Ltr>{kit.cur}</Ltr></div>
          </div>
        );
      })}
    </div>
  );
}

function sheetStyle(look: PrintLook, layout: ResolvedLayout): CSSProperties {
  return {
    width: 794, minHeight: GRID_SHEET_MIN_HEIGHT, background: '#fff', padding: look.pagePadding, boxSizing: 'border-box',
    fontFamily: FONT, color: INK, direction: 'rtl', display: 'flex', flexDirection: 'column',
    fontSize: Math.round(11 * (layout.fontScale || 1) * 100) / 100, lineHeight: 1.45,
  };
}

/** الأقسام بالترتيب المحفوظ — وما لا يخصّ هذا التصميم يُتجاهل */
const sectionsOf = (layout: ResolvedLayout): readonly SectionId[] => orderedSections(layout, layout.printer, 'grid_bilingual');

/** مسار «التحرير الحرّ»: مفتاحٌ جديد في التخطيط، أو معاينة المصمّم (لوسم الأقسام بـdata-pd) — وإلا ورقة اليوم حرفاً */
const onFreePath = (layout: ResolvedLayout, dctx: PrintDesignPreview | null): boolean => dctx !== null || hasFreeLayout(layout);

/** مظهر قسمٍ بلا تنسيق (معاينةٌ بلا مفتاحٍ حرّ) */
const PLAIN_LOOK: SectionLook = { visible: true, align: null, fontPct: 100, spaceBeforeMm: 0, spaceAfterMm: 0 };

/** نمط غلاف القسم: المحاذاة والمسافتان (sectionCss) والخط بالنسبة المئوية لوحدة em — و`fill` لقسمٍ يتمدّد في الورقة المرنة */
export function gridSectionStyle(s: SectionLook | null, fill = false): CSSProperties {
  const look = s ?? PLAIN_LOOK;
  return {
    display: fill ? 'flex' : 'flow-root',
    ...(fill ? { flexDirection: 'column', flex: '1 1 auto' } : {}),
    ...(sectionCss(look) as CSSProperties),
    ...(look.fontPct !== 100 && Number.isFinite(look.fontPct) ? { fontSize: `${look.fontPct}%` } : {}),
  };
}

const isNode = (n: ReactNode): boolean => n !== null && n !== undefined && n !== false && n !== '';

/**
 * أقسام الورقة على المسار الحرّ بالترتيب: الشعار المستقلّ (أعلى الورقة أو بعد قسمه — ولو أُخفي القسم)، وكل قسمٍ ظاهر بغلافه،
 * ورمز QR وحده بعد الترويسة متى أُخفيت «البيانات» (qrOrphan) — والترويسة تحمل مرساة وسم النسخة.
 */
function gridFreeBody(
  layout: ResolvedLayout, dctx: PrintDesignPreview | null, bySection: Partial<Record<SectionId, ReactNode>>, logo: GridLogo,
  opts: { qr?: ReactNode | null; fill?: ReadonlySet<SectionId>; before?: Partial<Record<SectionId, ReactNode>>; banner?: { at: SectionId; nodes: ReactNode[] } },
): ReactNode[] {
  const all = sectionsOf(layout);
  const visible = new Set<SectionId>(visibleOrder(layout, layout.printer, 'grid_bilingual'));
  const orphan = isNode(opts.qr) && qrOrphan(layout, layout.printer, 'grid_bilingual');
  const logoBlock = (key: string): ReactNode => (logo.img ? (
    <div key={key} data-section="logo" {...(pdProps(dctx, 'logo') as Record<string, never>)}
      style={{ display: 'flex', justifyContent: flexJustify(logo.align), marginTop: 8 }}>
      {logo.img}
    </div>
  ) : null);
  const standalone = logo.at !== 'header';
  const logoAt = standalone && logo.at !== 'top' && all.includes(logo.at) ? logo.at : null;
  const out: ReactNode[] = [];
  if (standalone && !logoAt) out.push(logoBlock('logo-top'));
  for (const id of all) {
    const node = visible.has(id) ? bySection[id] ?? null : null;
    // الفاصل المرن قبل موضع القسم ولو أُخفي (التذييل أسفل الورقة كاليوم)
    if (opts.before?.[id]) out.push(opts.before[id]);
    if (isNode(node)) {
      out.push(
        <div key={id} data-sec={id} {...(id === 'header' ? { 'data-copy-anchor': '' } : {})} {...(pdProps(dctx, id) as Record<string, never>)}
          style={gridSectionStyle(sectionLook(layout, id), opts.fill?.has(id) === true)}>
          {node}
        </div>,
      );
    }
    // القسم الحامل مخفيّ: العلامة المائية والتنبيه (قرار الطباعة، في الترويسة) ووسم «سند ملغى» (في البيانات) لا يسقطان معه — في موضعه
    if (opts.banner && id === opts.banner.at && !isNode(node) && opts.banner.nodes.some(isNode)) out.push(<div key="keep-banner">{opts.banner.nodes}</div>);
    if (logoAt === id) out.push(logoBlock(`logo-${id}`));
    if (id === 'header' && orphan) {
      // QR المرحلة الثانية لا يُحذف بإخفاء حامله: «البيانات» مخفيّة ⇒ كتلته وحدها بعد الترويسة (حذفه الصريح: opts.qr = null وqrOrphan = false)
      out.push(
        <div key="qr-orphan" data-section="qr" data-grid-qr="" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>{opts.qr}</div>,
      );
    }
  }
  return out;
}

// ═══════════════════════ الفاتورة (البيع والمرتجع/الإشعار وسند التسليم والمُبطل) ═══════════════════════

type GridItem = InvoiceDoc['items'][number] & { code?: string | null; taxAmt?: number | null };

interface Col {
  keys: string[];
  def: string;
  width?: number;
  cell: (it: GridItem, i: number) => ReactNode;
  align?: 'right' | 'center';
}

export const GridInvoice = forwardRef<HTMLDivElement, {
  doc: InvoiceDoc; facts: GridInvoiceFacts; look: PrintLook; layout: ResolvedLayout; qr: ReactNode | null;
}>(({ doc, facts, look, layout, qr }, ref) => {
  const { pt, zDecision, inclusiveDoc, vatRate, noteRefs } = facts;
  const company = (doc.company ?? null) as (InvoiceDoc['company'] & { addrCity?: string | null; addrPostalCode?: string | null }) | null;
  const customer = doc.customer as InvoiceDoc['customer'] & { postalCode?: string | null };
  const items = doc.items as GridItem[];
  const kit = kitOf(pt, look, layout, company);
  const dctx = usePrintDesignPreview();
  const logo = gridLogo(look, layout, company?.logo);
  const tax = zDecision.showTaxBreakdown;
  /* الإشعار المدين (المرحلة الثانية) عنوانه بمفتاحه inv.debitTitle، وعناوين الحالة (سند التسليم/الملغى/بانتظار الاعتماد) بمفاتيحها
   * (قرار المالك ٤ نوفمبر ٢٠٢٦) — وبلا نصوص ولا معاينة المفتاح كاليوم (سمة data-line نفسها حرفاً) */
  const legacyTitleKey = doc.isReturn ? 'inv.returnTitle' : 'inv.title';
  const titleKey = pt.on || pt.preview ? titleKeyOf(zDecision.title, !!doc.isReturn) ?? legacyTitleKey : legacyTitleKey;
  // أختام الحالة من قرار الطباعة — تُحذف بقرار الشركة وحده (stamps:false) في الترويسة وفي شريطها المعاد
  // (العنوان ليس ختماً: يبقى عنوان القرار ومفتاحه أعلاه)
  const marks = areStampsRemoved(layout) ? null : zDecision;

  // ── بيانات المستند ──
  const infoRows: KvRow[] = [];
  infoRows.push(doc.isReturn
    ? { keys: ['inv.returnNumber'], def: 'رقم المرتجع', value: doc.number, ltr: true }
    : { keys: ['inv.number'], def: 'رقم الفاتورة', value: doc.number, ltr: true });
  infoRows.push({ keys: ['inv.date'], def: 'التاريخ', value: dateWithTime(pt, doc.date, 'inv.time'), ltr: true });
  if (!doc.isReturn) {
    const v = doc.paymentPlan === 'INSTALLMENT' ? 'تقسيط' : (doc.type === 'CASH' ? 'نقدي' : 'آجل');
    infoRows.push({ keys: ['inv.paymentType'], def: 'طريقة الدفع', value: bilingualValue(v, pt.gridLang) });
  }
  if (doc.deliveryDate) infoRows.push({ keys: ['inv.deliveryDate'], def: 'تاريخ التسليم', value: gridDateTime(doc.deliveryDate, false), ltr: true });
  if (noteRefs.ref) infoRows.push({ keys: ['inv.originalRef'], def: 'الفاتورة الأصلية', value: noteRefs.ref, ltr: true });
  if (noteRefs.reason) infoRows.push({ keys: ['inv.noteReason'], def: 'سبب الإرجاع', value: noteRefs.reason });
  if (look.showRepName && doc.repName) infoRows.push({ keys: ['inv.rep'], def: 'المندوب', value: doc.repName });
  const infoGone = pt.hidden(doc.isReturn ? 'inv.returnInfoHeading' : 'inv.infoHeading');
  const info = (
    <div key="info" data-section="info" dir="rtl" style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginTop: 8 }}>
      {qr ? <div data-grid-qr="" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{qr}</div> : null}
      {infoGone ? null : (
        <div {...unitProps(pt, [doc.isReturn ? 'inv.returnInfoHeading' : 'inv.infoHeading'], { flex: '1 1 auto', display: 'flex' })}>
          <KvBox kit={kit} rows={infoRows.filter((r) => !goneAny(pt, r.keys))} enW={128} arW={140} style={{ flex: '1 1 auto' }} />
        </div>
      )}
    </div>
  );

  // ── البائع والمشتري (المشتري يميناً: أولاً في ترتيب DOM لورقةٍ RTL) ──
  const buyerRows: KvRow[] = [];
  if (customer.name) buyerRows.push({ keys: ['cust.name'], def: 'الاسم', value: customer.name });
  if (customer.businessName) buyerRows.push({ keys: ['cust.business'], def: 'المنشأة', value: customer.businessName });
  const custAddr = [customer.address, customer.district].filter(Boolean).join('، ');
  if (custAddr) buyerRows.push({ keys: ['cust.address'], def: 'العنوان', value: custAddr });
  if (customer.city) buyerRows.push({ keys: ['cust.city'], def: 'المدينة', value: customer.city });
  if (clean(customer.postalCode)) buyerRows.push({ keys: ['cust.postalCode'], def: 'الرمز البريدي', value: clean(customer.postalCode), ltr: true });
  if (customer.commercialReg) buyerRows.push({ keys: ['cust.commercialReg'], def: 'السجل التجاري', value: customer.commercialReg, ltr: true });
  if (customer.taxNumber) buyerRows.push({ keys: ['cust.taxNumber'], def: 'الرقم الضريبي', value: customer.taxNumber, ltr: true });
  const sellerRows: KvRow[] = [];
  if (company?.name) sellerRows.push({ keys: ['sel.name'], def: 'الاسم', value: company.name });
  if (company?.address) sellerRows.push({ keys: ['sel.address'], def: 'العنوان', value: company.address });
  if (clean(company?.addrCity)) sellerRows.push({ keys: ['sel.city'], def: 'المدينة', value: clean(company?.addrCity) });
  if (clean(company?.addrPostalCode)) sellerRows.push({ keys: ['sel.postalCode'], def: 'الرمز البريدي', value: clean(company?.addrPostalCode), ltr: true });
  if (company?.taxNumber) sellerRows.push({ keys: ['sel.taxNumber'], def: 'الرقم الضريبي', value: company.taxNumber, ltr: true });
  const partyBox = (headingKey: string, rows: KvRow[]) => {
    const live = rows.filter((r) => !goneAny(pt, r.keys));
    if (pt.hidden(headingKey) || live.length === 0) return <div style={{ flex: '1 1 0' }} />;
    return (
      <div {...unitProps(pt, [headingKey], { flex: '1 1 0', display: 'flex' })}>
        <KvBox kit={kit} rows={live} enW={96} arW={104} style={{ flex: '1 1 auto' }} />
      </div>
    );
  };
  const buyerLive = !pt.hidden('cust.heading') && buyerRows.some((r) => !goneAny(pt, r.keys));
  const sellerLive = !pt.hidden('sel.heading') && sellerRows.some((r) => !goneAny(pt, r.keys));
  const parties = buyerLive || sellerLive ? (
    <div key="parties" data-section="parties" dir="rtl" style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginTop: 8 }}>
      {partyBox('cust.heading', buyerRows)}
      {partyBox('sel.heading', sellerRows)}
    </div>
  ) : null;

  // ── جدول الأصناف ──
  const unitPriceExcl = (it: GridItem): number => {
    const r = Number(it.taxPct) || 0;
    return tax && inclusiveDoc && r > 0 ? (it.unitPrice * 100) / (100 + r) : it.unitPrice;
  };
  /* lineTotal المخزَّن شاملٌ الضريبة في الوضعين (computeInvoiceTotals: الحصري net+tax، والشامل أساسه الشامل) — والقالب الحالي
   * يطبعه «الإجمالي» كما هو ومجموعه = doc.total. فضريبة السطر بلا taxAmt تُشتقّ منه شاملاً، و«المبلغ الكلي» هو هو بلا إضافة */
  const vatOf = (it: GridItem): number => lineVat(it, true);
  const totalOf = (it: GridItem): number => it.lineTotal;
  const allCols: (Col | null)[] = [
    { keys: ['col.seq'], def: 'رقم', width: 34, cell: (_it, i) => <Ltr>{i + 1}</Ltr> },
    items.some((it) => clean(it.code)) ? { keys: ['col.code'], def: 'رقم الصنف', width: 76, cell: (it) => <Ltr>{clean(it.code)}</Ltr> } : null,
    {
      keys: ['col.item'], def: 'الصنف', align: 'right', cell: (it) => (
        <>
          <span style={{ fontWeight: 700 }}>{it.name}</span>
          {doc.isReturn && it.returnExpired != null && it.expiresAt ? (
            <div style={{ fontSize: '0.86em' }}>{it.returnExpired ? 'منتهي الصلاحية' : 'ساري الصلاحية'} · <Ltr>{gridDateTime(it.expiresAt, false)}</Ltr></div>
          ) : null}
          {invoiceLotsOf(company, it).map((l, k) => (
            <div key={k} style={{ fontSize: '0.86em' }}>{lotLineText(l, { tr: (s: string) => s, unitFactor: it.unitFactor })}</div>
          ))}
        </>
      ),
    },
    { keys: ['col.qty'], def: 'الكمية', width: 62, cell: (it) => <Ltr>{fmtQty4(Number(it.qty))}</Ltr> },
    items.some((it) => showsUnit(it, look.showItemUnit)) ? { keys: ['col.unit'], def: 'الوحدة', width: 56, cell: (it) => (showsUnit(it, look.showItemUnit) ? it.unit : '') } : null,
    items.some((it) => Number(it.discountPct) > 0) ? { keys: ['col.discount'], def: 'الخصم', width: 48, cell: (it) => (Number(it.discountPct) > 0 ? <Ltr>{`${it.discountPct}%`}</Ltr> : '-') } : null,
    { keys: ['col.price', 'col.priceIncl'], def: 'السعر', width: 76, cell: (it) => <Ltr>{kit.money(unitPriceExcl(it))}</Ltr> },
    tax ? {
      keys: ['col.vatAmount'], def: 'ضريبة القيمة المضافة', width: 76, cell: (it) => (
        <>
          <Ltr>{kit.money(vatOf(it))}</Ltr>
          {!pt.hidden('col.tax') ? <span data-line="col.tax" style={{ display: 'block', fontSize: '0.82em', ...(struckAny(pt, ['col.tax']) ? STRIKE : {}) }}><Ltr>{`${it.taxPct}%`}</Ltr></span> : null}
        </>
      ),
    } : null,
    { keys: ['col.total'], def: 'الإجمالي', width: 88, cell: (it) => <Ltr>{kit.money(totalOf(it))}</Ltr> },
  ];
  const cols = allCols.filter((c): c is Col => c !== null && !goneAny(pt, c.keys));
  const filler = items.length <= GRID_FILLER_MAX_ITEMS;
  const th: CSSProperties = {
    border: B, padding: '3px 4px', fontWeight: 700, textAlign: 'center', lineHeight: 1.25,
    ...(kit.mono ? {} : { background: kit.accent, color: '#fff' }),
  };
  const td: CSSProperties = { border: B, padding: '2px 4px', textAlign: 'center', verticalAlign: 'middle', height: 22 };
  const itemsNode = (
    <div key="items" data-section="items" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', ...(filler ? { flex: '1 1 auto' } : {}) }}>
      {/* الحشو: الجدول نفسه يتمدّد (flex) فيأخذ صفّ الحشو الفراغ حتى التذييل — height:100% لا يُحلّ داخل ورقةٍ min-height فقط */}
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', ...(filler ? { flex: '1 1 auto' } : {}) }}>
        <colgroup>
          {cols.map((c) => <col key={c.keys[0]} data-line={c.keys.join(' ')} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead style={{ display: 'table-header-group' }}>
          <tr>
            {cols.map((c) => {
              const k = c.keys[0];
              const en = enOf(pt, k, c.def);
              return (
                <th key={k} {...unitProps(pt, c.keys, th)}>
                  <Pk pt={pt} k={k}>
                    {arOf(pt, k, c.def)}
                    {en ? <span dir="ltr" style={{ display: 'block', fontSize: '0.86em', unicodeBidi: 'isolate' }}>{en}</span> : null}
                  </Pk>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} style={{ breakInside: 'avoid' }}>
              {cols.map((c) => <td key={c.keys[0]} {...unitProps(pt, c.keys, c.align === 'right' ? { ...td, textAlign: 'right', height: undefined } : td)}>{c.cell(it, i)}</td>)}
            </tr>
          ))}
          {filler ? (
            <tr data-grid-filler="">
              {cols.map((c) => <td key={c.keys[0]} {...unitProps(pt, c.keys, { borderLeft: B, borderRight: B, borderBottom: B, borderTop: 'none', height: 'auto' })} />)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );

  // ── ملاحظة الأسعار الشاملة ──
  const noteNode = tax && inclusiveDoc && !pt.hidden('note.pricesIncl') ? (() => {
    const def = 'الأسعار المعروضة شاملة ضريبة القيمة المضافة';
    const en = enOf(pt, 'note.pricesIncl', def);
    return (
      <div key="note" data-section="note" {...unitProps(pt, ['note.pricesIncl'], { marginTop: 4, fontSize: '0.9em' })}>
        <Pk pt={pt} k="note.pricesIncl">{arOf(pt, 'note.pricesIncl', def)}{en ? <> · <Ltr>{en}</Ltr></> : null}</Pk>
      </div>
    );
  })() : null;

  // ── الإجماليات ──
  const totRows: TotRow[] = [];
  if (tax) totRows.push({ keys: ['tot.exclVat'], def: 'الإجمالي الخاضع للضريبة (غير شامل الضريبة)', value: doc.subtotal });
  else if (doc.discount > 0) totRows.push({ keys: ['tot.subtotal'], def: 'المجموع قبل الخصم', value: doc.subtotal });
  if (doc.discount > 0) totRows.push({ keys: ['tot.discount'], def: 'الخصم', value: doc.discount, neg: true });
  if (tax && doc.discount > 0 && doc.tax > 0) totRows.push({ keys: ['tot.taxable'], def: 'الوعاء الخاضع للضريبة', value: doc.total - doc.tax });
  if (tax) totRows.push({ keys: ['tot.vat', 'tot.vatIncl'], def: 'ضريبة القيمة المضافة', value: doc.tax, suffix: vatRate });
  totRows.push(doc.isReturn
    ? { keys: ['tot.returnGrand'], def: 'إجمالي المرتجع دائن', value: doc.total, strong: true }
    : { keys: ['tot.due', 'tot.grand'], def: 'إجمالي المبلغ المستحق', value: doc.total, strong: true });
  if (!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined) {
    totRows.push({ keys: ['tot.paid'], def: 'المدفوع', value: doc.paidAmt ?? 0 });
    totRows.push({ keys: ['tot.remaining'], def: 'المتبقي', value: doc.remainingAmt });
  }
  const totalsNode = <TotalsBox key="totals" kit={kit} rows={totRows} />;

  // ── جدول الأقساط ──
  const instNode = !doc.isReturn && doc.paymentPlan === 'INSTALLMENT' && (doc.installments?.length ?? 0) > 0 && !pt.hidden('inst.heading') ? (() => {
    const showDue = !pt.hidden('inst.dueDate');
    const showAmt = !pt.hidden('inst.amount');
    const showSum = !pt.hidden('inst.sum');
    const hcell = (k: string, def: string) => {
      const en = enOf(pt, k, def);
      return (
        <th {...unitProps(pt, [k], { ...th })}>
          <Pk pt={pt} k={k}>{arOf(pt, k, def)}{en ? <span dir="ltr" style={{ display: 'block', fontSize: '0.86em', unicodeBidi: 'isolate' }}>{en}</span> : null}</Pk>
        </th>
      );
    };
    const sumDef = 'مجموع الأقساط';
    const sumEn = enOf(pt, 'inst.sum', sumDef);
    const noteDef = 'الضريبة مستحقة بالكامل على هذه الفاتورة عند التوريد والأقساط جدول سداد لا تجزئة ضريبية';
    const headEn = enOf(pt, 'inst.heading', 'جدول الأقساط');
    return (
      <div key="installments" data-section="installments" {...unitProps(pt, ['inst.heading'], { marginTop: 8, breakInside: 'avoid' })}>
        <div style={{ fontWeight: 700, marginBottom: 3 }}>
          <Pk pt={pt} k="inst.heading">{arOf(pt, 'inst.heading', 'جدول الأقساط')}{headEn ? <> · <Ltr>{headEn}</Ltr></> : null}</Pk>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 40 }}>#</th>
              {showDue ? hcell('inst.dueDate', 'تاريخ الاستحقاق') : null}
              {showAmt ? hcell('inst.amount', 'المبلغ') : null}
            </tr>
          </thead>
          <tbody>
            {doc.installments!.map((r) => (
              <tr key={r.seq}>
                <td style={td}><Ltr>{r.seq}</Ltr></td>
                {showDue ? <td {...unitProps(pt, ['inst.dueDate'], td)}><Ltr>{gridDateTime(r.dueDate as string, false)}</Ltr></td> : null}
                {showAmt ? <td {...unitProps(pt, ['inst.amount'], { ...td, fontWeight: 700 })}><Ltr>{kit.money(Number(r.amount))}</Ltr></td> : null}
              </tr>
            ))}
            {showSum ? (
              <tr {...unitProps(pt, ['inst.sum'])}>
                <td style={{ ...td, fontWeight: 700 }} colSpan={showDue ? 2 : 1}>
                  <Pk pt={pt} k="inst.sum">{arOf(pt, 'inst.sum', sumDef)}{sumEn ? <> · <Ltr>{sumEn}</Ltr></> : null}</Pk>
                </td>
                {showAmt ? <td style={{ ...td, fontWeight: 700 }} data-line="inst.amount"><Ltr>{kit.money(doc.installments!.reduce((s, r) => s + Number(r.amount), 0))}</Ltr></td> : null}
              </tr>
            ) : null}
          </tbody>
        </table>
        {!pt.hidden('inst.note') ? (
          <div {...unitProps(pt, ['inst.note'], { marginTop: 3, fontSize: '0.9em' })}><Pk pt={pt} k="inst.note">{arOf(pt, 'inst.note', noteDef)}{withOwnAlt(pt.ownAlt('inst.note'))}</Pk></div>
        ) : null}
      </div>
    );
  })() : null;

  // ── التواقيع والتذييل ──
  const sigNode = look.showSignatures ? (
    <Signatures key="signatures" kit={kit} slots={[
      { key: 'sig.recipient', def: 'توقيع المستلم', img: doc.recipientSignature },
      { key: 'sig.rep', def: 'توقيع المندوب', img: doc.repSignature, name: doc.repName },
      { key: 'sig.warehouse', def: 'المستودع' },
      { key: 'sig.remarks', def: 'ملاحظات وتعليمات' },
    ]} />
  ) : null;
  const thanksReworded = pt.on && pt.text('foot.thanks', '') !== '';
  const thanksFromFooterText = look.footerText !== null && !thanksReworded;
  const thanks = thanksFromFooterText ? look.footerText : arOf(pt, 'foot.thanks', 'شكرا لتعاملكم معنا');
  // نصّ الشكر الثاني للشركة يتبع سطرها وحده — لا نصّ تذييل قالب الطباعة (C-G3)
  const thanksAlt = thanksFromFooterText ? null : pt.ownAlt('foot.thanks');
  const footerNode = <Footer key="footer" kit={kit} thanks={thanks} thanksAlt={thanksAlt} companyName={company?.name || ''} />;

  const headerNode = (
    <GridHeader key="header" kit={kit} look={look} logo={logo} company={company}
      // بلا نصوص: عنوان القرار بالعربية (العنوان الممرَّر مترجمٌ بلغة واجهة الجهاز كقالب اليوم) — القالب عربيٌّ أولاً
      title={pt.on ? facts.title : { text: zDecision.title, alt: null }} titleKey={titleKey}
      showTax={false} zDecision={marks} />
  );

  const bySection: Partial<Record<SectionId, ReactNode>> = {
    header: headerNode, info, parties, items: itemsNode, note: noteNode, totals: totalsNode,
    installments: instNode, signatures: sigNode, footer: footerNode,
  };
  return (
    <div ref={ref} style={sheetStyle(look, layout)} {...lookRootAttrs(look)}>
      {onFreePath(layout, dctx)
        ? gridFreeBody(layout, dctx, bySection, logo, { qr, fill: filler ? new Set<SectionId>(['items']) : undefined, banner: { at: 'header', nodes: gridZatcaBanner(marks) } })
        : sectionsOf(layout).map((id) => bySection[id] ?? null)}
      {lookNeedsCss(look) ? <style>{PRINT_LOOK_CSS}</style> : null}
    </div>
  );
});
GridInvoice.displayName = 'GridInvoice';

// ═══════════════════════ سند القبض (بلا رمز QR كاليوم) ═══════════════════════

export const GridReceipt = forwardRef<HTMLDivElement, {
  doc: ReceiptDoc; pt: PrintTexts; title: { text: string; alt: string | null }; look: PrintLook; layout: ResolvedLayout;
}>(({ doc, pt, title, look, layout }, ref) => {
  const company = (doc.company ?? null) as (ReceiptDoc['company'] & { addrCity?: string | null }) | null;
  const customer = doc.customer;
  const kit = kitOf(pt, look, layout, company);
  const dctx = usePrintDesignPreview();
  const logo = gridLogo(look, layout, company?.logo);

  const infoRows: KvRow[] = [
    { keys: ['rcp.number'], def: 'رقم السند', value: doc.number, ltr: true },
    { keys: ['rcp.date'], def: 'التاريخ', value: dateWithTime(pt, doc.date, 'rcp.time'), ltr: true },
  ];
  if (look.showRepName && doc.repName) infoRows.push({ keys: ['rcp.rep'], def: 'المندوب', value: doc.repName });
  infoRows.push({ keys: ['rcp.method'], def: 'طريقة الدفع', value: methodLabelFor(company, doc.paymentMethod, doc.paymentMethodKey, (s: string) => s) });
  if (doc.notes) infoRows.push({ keys: ['rcp.notes'], def: 'ملاحظات', value: doc.notes });
  const cancelledMark = doc.cancelled && !areStampsRemoved(layout) ? <div style={{ border: `2px solid ${INK}`, padding: 6, marginTop: 6, textAlign: 'center', fontWeight: 700, fontSize: '1.3em' }}>سند ملغى</div> : null;
  const info = (
    <div key="info" data-section="info" style={{ marginTop: 8 }}>
      <KvBox kit={kit} rows={infoRows.filter((r) => !goneAny(pt, r.keys))} enW={128} arW={140} />
      {cancelledMark}
    </div>
  );

  const buyerRows: KvRow[] = [];
  if (customer.name) buyerRows.push({ keys: ['rcp.from'], def: 'استلمنا من السيد', value: customer.name });
  if (customer.businessName) buyerRows.push({ keys: ['rcp.business'], def: 'المنشأة', value: customer.businessName });
  if (customer.commercialReg) buyerRows.push({ keys: ['rcp.commercialReg'], def: 'السجل التجاري', value: customer.commercialReg, ltr: true });
  if (customer.taxNumber) buyerRows.push({ keys: ['rcp.taxNumber'], def: 'الرقم الضريبي', value: customer.taxNumber, ltr: true });
  if (customer.phone) buyerRows.push({ keys: ['rcp.phone'], def: 'الجوال', value: customer.phone, ltr: true });
  const addr = [customer.address, customer.district, customer.city].filter(Boolean).join('، ');
  if (addr) buyerRows.push({ keys: ['rcp.address'], def: 'العنوان', value: addr });
  const buyerLive = buyerRows.filter((r) => !goneAny(pt, r.keys));
  const parties = !pt.hidden('rcp.customerHeading') && buyerLive.length > 0 ? (
    <div key="parties" data-section="parties" {...unitProps(pt, ['rcp.customerHeading'], { marginTop: 8 })}>
      <KvBox kit={kit} rows={buyerLive} enW={128} arW={140} />
    </div>
  ) : null;

  // ── المبلغ وفواتيره ──
  const amountGone = pt.hidden('rcp.amount');
  const view = receiptLinkView(doc, kit.dec);
  const linkRows: TotRow[] = [];
  let linkNote: string | null = null;
  let single: { number: string } | null = null;
  if (view.kind === 'pending') linkNote = 'يحدد رقم الفاتورة عند مزامنة السند';
  else if (view.kind === 'onAccount') linkNote = 'دفعة على الحساب غير مرتبطة بفاتورة';
  else if (view.kind === 'invoices') {
    if (view.links.length === 1) single = view.links[0];
    const showAmounts = view.links.length > 1 || view.unallocated > 0;
    if (showAmounts && !(view.links.length > 1 && pt.hidden('rcp.forInvoices'))) {
      for (const l of view.links) linkRows.push({ keys: ['rcp.invoiceNo'], def: 'فاتورة رقم', value: l.amount, suffix: l.number });
    }
    if (view.unallocated > 0) linkRows.push({ keys: ['rcp.credit'], def: 'رصيد دائن للعميل غير مخصص لفاتورة', value: view.unallocated });
  }
  const multiHeading = view.kind === 'invoices' && view.links.length > 1 && !pt.hidden('rcp.forInvoices');
  const items = (
    <div key="items" data-section="items" style={{ marginTop: 8 }}>
      {amountGone ? null : (
        <TotalsBox kit={kit} rows={[{ keys: ['rcp.amount'], def: 'المبلغ المستلم', value: doc.amount, strong: true }]} />
      )}
      {linkNote ? <div style={{ border: B, padding: '5px 8px', marginTop: 8, textAlign: 'center' }}>{linkNote}</div> : null}
      {single && !pt.hidden('rcp.forInvoice') ? (
        <div style={{ marginTop: 8 }}>
          <KvBox kit={kit} rows={[{ keys: ['rcp.forInvoice'], def: 'مقابل الفاتورة رقم', value: single.number, ltr: true }]} enW={128} arW={140} />
        </div>
      ) : null}
      {multiHeading ? (
        <div {...unitProps(pt, ['rcp.forInvoices'], { marginTop: 8, fontWeight: 700 })}>
          <Pk pt={pt} k="rcp.forInvoices">{arOf(pt, 'rcp.forInvoices', 'مقابل الفواتير')}{(() => { const en = enOf(pt, 'rcp.forInvoices', 'مقابل الفواتير'); return en ? <> · <Ltr>{en}</Ltr></> : null; })()}</Pk>
        </div>
      ) : null}
      {linkRows.length > 0 ? <TotalsBox kit={kit} rows={linkRows} /> : null}
    </div>
  );

  const sig = (
    <Signatures key="signatures" kit={kit} slots={[
      { key: 'rcp.sigPayer', def: 'توقيع الدافع' },
      { key: 'rcp.sigCollector', def: 'توقيع المستلم المندوب', name: doc.repName },
    ]} />
  );
  const footer = <Footer key="footer" kit={kit} thanks={null} companyName={company?.name || ''} />;
  const header = (
    <GridHeader key="header" kit={kit} look={look} logo={logo} company={company}
      title={pt.on ? title : { text: 'سند قبض', alt: null }} titleKey="rcp.title" showTax />
  );
  const bySection: Partial<Record<SectionId, ReactNode>> = { header, info, parties, items, signatures: sig, footer };
  const order = sectionsOf(layout);
  return (
    <div ref={ref} style={sheetStyle(look, layout)} {...lookRootAttrs(look)}>
      {onFreePath(layout, dctx)
        // التواقيع أسفل الورقة كاليوم: الفاصل المرن قبل غلافها
        ? gridFreeBody(layout, dctx, bySection, logo, { before: { signatures: <div key="spacer" style={{ flex: '1 1 auto' }} /> }, banner: { at: 'info', nodes: [cancelledMark] } })
        : order.map((id) => (id === 'signatures' ? [<div key="spacer" style={{ flex: '1 1 auto' }} />, bySection[id] ?? null] : bySection[id] ?? null))}
      {lookNeedsCss(look) ? <style>{PRINT_LOOK_CSS}</style> : null}
    </div>
  );
});
GridReceipt.displayName = 'GridReceipt';
