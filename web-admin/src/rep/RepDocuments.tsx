import { forwardRef, useRef, useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { formatCurrency, formatDate, formatTime, formatDateTime, paymentMethodLabels } from '../utils/format';
import { periodShape, statementFinalBalance } from './statementFacts';
import { adjustTotals, receiveTotalQty, uncostedCount, isCosted, noticeRef } from './warehouseNoticeFacts';
import { useTr } from '../i18n/strings';
import { elementToPdfBlob, shareOrDownloadPdf } from './pdf';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import { printThermalInvoice, printThermalReceipt } from './thermal';
import { backdropClose } from '../lib/backdropClose';
import { useBackClose } from '../lib/useBackClose';
import { Share2, Download, Check, ArrowRight, Printer, X } from 'lucide-react';

// رمز QR كصورة PNG (data URL) بدل <canvas> — لأن html2canvas لا يلتقط محتوى الـcanvas
// عند توليد الـPDF فيختفي الرمز. الصورة (data URL) تُلتقط بثبات في PDF والطباعة والمشاركة.
function QrImage({ value, size }: { value: string; size: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size * 3, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [value, size]);
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
  company?: Company | null;
  customer: DocCustomer;
  repName: string;
  items: { name: string; unit?: string; qty: number; unitPrice: number; discountPct: number; taxPct: number; lineTotal: number }[];
  subtotal: number;   // صافٍ قبل الضريبة دائما
  discount: number;   // صافٍ قبل الضريبة دائما
  tax: number;
  total: number;
  /** اسعار البنود (unitPrice و lineTotal) شاملة الضريبة — فواتير تطبيق المندوب */
  pricesIncludeTax?: boolean;
  paidAmt?: number;
  remainingAmt?: number;
  einvoice?: { provider?: string | null; status?: string | null; uuid?: string | null; qr?: string | null } | null;
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
  notes?: string;
  /**
   * مرفقات رفعها المندوب عند الإصدار. **لا تدخل قالب الطباعة** —
   * انظر `ReceiptAttachments` لسبب فصلها عن المستند.
   * وتصل من `GET /receipts/:id` وحده؛ القائمة لا تُرجعها فتكون غائبة.
   */
  photos?: ReceiptPhoto[];
  offline?: boolean;
}

export interface StatementEntry {
  date: string;
  description: string;
  ref?: string;
  debit: number;
  credit: number;
  balance: number;
  type?: string; // نوع القيد (INVOICE_DEBIT بيع · RECEIPT_CREDIT تحصيل · INVOICE_CREDIT مرتجع)
  items?: { name: string; qty: number; unit?: string }[]; // أصناف الفاتورة (لعرضها في كشف الحساب)
}

export interface StatementDoc {
  kind: 'statement';
  company?: Company | null;
  customer: DocCustomer & { balance?: number; totalSales?: number; totalCollected?: number };
  repName: string;
  date: string;
  fromDate?: string;
  toDate?: string;
  entries: StatementEntry[];
  /** رصيد ما قبل الفترة — يُطبع صفّاً أوّل حين تكون للكشف بداية.
   *  بدونه يبدأ عمود الرصيد من رقمٍ لا تُنتجه أيّ حركةٍ في الورقة. */
  openingBalance?: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
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

export interface LoadNoticeItem { name: string; qty: number; unit?: string; }

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
  /** موجبٌ للوارد، وموجبٌ أو سالبٌ للتسوية */
  qty: number;
  /** صافٍ قبل الضريبة بأربع خانات — `null` = بلا سعر معروف */
  unitCost?: number | null;
  /** قيمة السطر كما قرّبها الخادم — مجموعها يطابق `totalCost` فلساً بفلس */
  lineCost?: number | null;
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

export type AnyDoc = InvoiceDoc | ReceiptDoc | StatementDoc | SettlementLogDoc | LoadNoticeDoc | WarehouseNoticeDoc;

function fullAddress(c: { address?: string; district?: string; city?: string }): string {
  return [c.address, c.district, c.city].filter(Boolean).join(' ');
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

export function Header({ title, company }: { title: string; company?: Company | null }) {
  const tr = useTr();
  const brand = brandColor(company);
  const style = company?.headerStyle || 'classic';
  const logo = company?.logo || null;

  const line = (label: string, value?: string, light?: boolean) =>
    value ? <div style={{ fontSize: 11.5, color: light ? 'rgba(255,255,255,0.9)' : '#4b5563' }}>
      <span style={{ color: light ? 'rgba(255,255,255,0.65)' : '#9ca3af' }}>{label}: </span>{value}</div> : null;

  const Logo = ({ size }: { size: number }) =>
    logo ? <img src={logo} alt="" style={{ width: size, height: size, objectFit: 'contain', borderRadius: 6 }} /> : null;

  const infoLines = (light?: boolean) => (
    <>
      {line(tr('العنوان'), company?.address, light)}
      {line(tr('الرقم الضريبي'), company?.taxNumber, light)}
      {line(tr('السجل التجاري'), company?.commercialReg, light)}
      {line(tr('هاتف'), company?.phone, light)}
      {line(tr('البريد'), company?.email, light)}
    </>
  );

  // شكل "بانر": شريط ملوّن كامل بالشعار والاسم باللون الأبيض
  if (style === 'banner') {
    return (
      <div style={{ marginBottom: 20 }}>
        <div style={{ background: brand, borderRadius: 12, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Logo size={46} />
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{company?.name || tr('اسم الشركة')}</div>
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
            <div style={{ fontSize: 19, fontWeight: 700, color: '#1f2937' }}>{company?.name || tr('اسم الشركة')}</div>
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
          <div style={{ fontSize: 20, fontWeight: 700, color: brand }}>{company?.name || tr('اسم الشركة')}</div>
        </div>
        {infoLines(false)}
      </div>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: brand }}>{title}</div>
      </div>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ color: '#6b7280', fontSize: 13 }}>{label}: </span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span>
    </div>
  );
}

// ============ قالب الفاتورة ============
export const PrintableInvoice = forwardRef<HTMLDivElement, { doc: InvoiceDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '10px 8px', fontSize: 13, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '9px 8px', fontSize: 13, textAlign: 'center', borderBottom: '1px solid #eef2f7' };

  const addr = fullAddress(doc.customer);
  // تصنيف الفاتورة وفق ZATCA: مبسّطة (B2C) إن لم يكن للعميل رقم ضريبي، وقياسية (B2B) إن وُجد
  const isSimplified = !doc.customer.taxNumber;
  const docTitle = doc.isReturn
    ? tr('إشعار دائن مرتجع')
    : !isSaudiDoc(doc.company) ? tr('فاتورة')
    : (isSimplified ? tr('فاتورة ضريبية مبسطة') : tr('فاتورة ضريبية'));
  // رمز QR وفق هيئة الزكاة والضريبة — يظهر فقط إذا كان للشركة رقم ضريبي
  const qrValue = doc.company?.taxNumber
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
    <div ref={ref} style={PAGE}>
      <Header title={docTitle} company={doc.company} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 20 }}>
        <div style={{ flex: 1, background: doc.isReturn ? '#fffbeb' : '#eff6ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{doc.isReturn ? tr('بيانات المرتجع') : tr('بيانات الفاتورة')}</div>
          <InfoBox label={doc.isReturn ? tr('رقم المرتجع') : tr('رقم الفاتورة')} value={doc.number} />
          <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={tr('وقت الإصدار')} value={formatTime(doc.date)} />
          {!doc.isReturn && <InfoBox label={tr('النوع')} value={
            doc.paymentPlan === 'INSTALLMENT' ? tr('تقسيط') : (doc.type === 'CASH' ? tr('نقدي') : tr('آجل'))
          } />}
          {doc.deliveryDate && <InfoBox label={tr('تاريخ التسليم')} value={formatDate(doc.deliveryDate)} />}
          <InfoBox label={tr('المندوب')} value={doc.repName} />
        </div>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات العميل')}</div>
          <InfoBox label={tr('الاسم')} value={doc.customer.name} />
          {doc.customer.businessName && <InfoBox label={tr('المنشأة')} value={doc.customer.businessName} />}
          {doc.customer.commercialReg && <InfoBox label={tr('السجل التجاري')} value={doc.customer.commercialReg} />}
          {doc.customer.taxNumber && <InfoBox label={tr('الرقم الضريبي')} value={doc.customer.taxNumber} />}
          {doc.customer.phone && <InfoBox label={tr('الجوال')} value={doc.customer.phone} />}
          {addr && <InfoBox label={tr('العنوان')} value={addr} />}
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('الصنف')}</th>
            <th style={th}>{tr('الكمية')}</th>
            <th style={th}>{inclusiveDoc ? tr('السعر شامل الضريبة') : tr('السعر')}</th>
            <th style={th}>{tr('الخصم')}</th>
            <th style={th}>{tr('الضريبة')}</th>
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('الإجمالي')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <span style={{ fontWeight: 600 }}>{it.name}</span>
                {it.unit && <span style={{ color: '#9ca3af', fontSize: 11 }}> ({it.unit})</span>}
              </td>
              <td style={td}>{it.qty}</td>
              <td style={td}>
                {formatCurrency(it.unitPrice)}
                {/* الفاتورة الضريبية القياسية توجب اظهار سعر الوحدة غير شامل الضريبة */}
                {inclusiveDoc && !isSimplified && it.taxPct > 0 && (
                  <div style={{ color: '#9ca3af', fontSize: 10.5, marginTop: 2 }}>
                    {tr('قبل الضريبة')}: {formatCurrency((it.unitPrice * 100) / (100 + Number(it.taxPct)))}
                  </div>
                )}
              </td>
              <td style={td}>{it.discountPct > 0 ? `${it.discountPct}%` : '-'}</td>
              <td style={td}>{it.taxPct}%</td>
              <td style={{ ...td, fontWeight: 700 }}>{formatCurrency(it.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inclusiveDoc && (
        <div style={{ fontSize: 10.5, color: '#9ca3af', marginBottom: 10 }}>
          {tr('الأسعار المعروضة شاملة ضريبة القيمة المضافة')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 }}>
        {/* رمز QR / معرّف الاعتماد للفاتورة الإلكترونية */}
        {(() => {
          const einv = doc.einvoice;
          const gov = !!einv?.provider && ['eta', 'peppol', 'ttn'].includes(einv.provider);
          const box: React.CSSProperties = { background: '#fff', padding: 6, border: '1px solid #eef2f7', borderRadius: 8, display: 'block', width: 'fit-content', margin: '0 auto' };
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
                <div style={box}><QrImage value={qrValue} size={108} /></div>
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, maxWidth: 130 }}>{tr('رمز الاستجابة السريعة للفاتورة الضريبية')}</div>
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

        <div style={{ width: 300, fontSize: 14 }}>
          <Row label={tr('المجموع قبل الخصم')} value={formatCurrency(doc.subtotal)} />
          {doc.discount > 0 && <Row label={tr('الخصم')} value={`- ${formatCurrency(doc.discount)}`} color="#dc2626" />}
          {doc.tax > 0 && <Row label={tr('الوعاء الخاضع للضريبة')} value={formatCurrency(doc.total - doc.tax)} />}
          <Row label={`${inclusiveDoc ? tr('منها ضريبة القيمة المضافة') : tr('ضريبة القيمة المضافة')} ${vatRate}`} value={formatCurrency(doc.tax)} color="#1E7A52" />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: `2px solid ${brand}`, marginTop: 6, fontWeight: 700, fontSize: 18, color: doc.isReturn ? '#b45309' : brand }}>
            <span>{doc.isReturn ? tr('إجمالي المرتجع دائن') : tr('الإجمالي النهائي')}</span>
            <span>{formatCurrency(doc.total)}</span>
          </div>
          {!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined && (
            <>
              <Row label={tr('المدفوع')} value={formatCurrency(doc.paidAmt ?? 0)} color="#16a34a" />
              <Row label={tr('المتبقي')} value={formatCurrency(doc.remainingAmt)} color="#dc2626" />
            </>
          )}
        </div>
      </div>

      {/* جدول الأقساط — الورقة تُثبت صحّتها للعميل: سطر المجموع يقابل الإجمالي */}
      {!doc.isReturn && doc.paymentPlan === 'INSTALLMENT' && (doc.installments?.length ?? 0) > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: '#1F1A13' }}>{tr('جدول الأقساط')}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...th, borderRadius: '8px 0 0 0' }}>#</th>
                <th style={th}>{tr('تاريخ الاستحقاق')}</th>
                <th style={{ ...th, borderRadius: '0 8px 0 0' }}>{tr('المبلغ')}</th>
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
                <td style={{ ...td, borderTop: '2px solid #E15A30', fontWeight: 700 }} colSpan={2}>{tr('مجموع الأقساط')}</td>
                <td style={{ ...td, borderTop: '2px solid #E15A30', textAlign: 'center', fontWeight: 700 }}>
                  {formatCurrency(doc.installments!.reduce((s, r) => s + Number(r.amount), 0))}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: '#6E6557', marginTop: 6 }}>
            {tr('الضريبة مستحقة بالكامل على هذه الفاتورة عند التوريد والأقساط جدول سداد لا تجزئة ضريبية')}
          </p>
        </div>
      )}

      <div style={{ marginTop: 60, display: 'flex', justifyContent: 'space-between', color: '#6b7280', fontSize: 13 }}>
        <div>{tr('توقيع المستلم')}: ........................</div>
        <div>{tr('توقيع المندوب')}: ........................</div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {tr('شكرا لتعاملكم معنا')} — {doc.company?.name || ''}
        {/* بصمة المنصّة: كل فاتورة مطبوعة تسوّق للمنصّة لدى تجّار الجملة والتجزئة (حلقة فيروسية) */}
        <div style={{ marginTop: 6, fontSize: 10, color: '#c3bcae' }}>
          {tr('صدرت عبر منصة')} Field Sales · fieldsa.net
        </div>
      </div>
    </div>
  );
});
PrintableInvoice.displayName = 'PrintableInvoice';

// ============ قالب سند القبض ============
export const PrintableReceipt = forwardRef<HTMLDivElement, { doc: ReceiptDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const brand = brandColor(doc.company);
  const addr = fullAddress(doc.customer);
  return (
    <div ref={ref} style={PAGE}>
      <Header title={tr('سند قبض')} company={doc.company} />

      <div style={{ marginBottom: 20 }}>
        <InfoBox label={tr('رقم السند')} value={doc.number} />
        <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
        <InfoBox label={tr('وقت الإصدار')} value={formatTime(doc.date)} />
        <InfoBox label={tr('المندوب')} value={doc.repName} />
      </div>

      <div style={{ background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: 14, padding: 24, textAlign: 'center', marginBottom: 20 }}>
        <div style={{ color: '#15803d', fontSize: 14, marginBottom: 8 }}>{tr('المبلغ المستلم')}</div>
        <div style={{ fontSize: 38, fontWeight: 700, color: '#15803d' }}>{formatCurrency(doc.amount)}</div>
      </div>

      <div style={{ background: '#f8fafc', borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات العميل')}</div>
        <InfoBox label={tr('استلمنا من السيد')} value={doc.customer.name} />
        {doc.customer.businessName && <InfoBox label={tr('المنشأة')} value={doc.customer.businessName} />}
        {doc.customer.commercialReg && <InfoBox label={tr('السجل التجاري')} value={doc.customer.commercialReg} />}
        {doc.customer.taxNumber && <InfoBox label={tr('الرقم الضريبي')} value={doc.customer.taxNumber} />}
        {doc.customer.phone && <InfoBox label={tr('الجوال')} value={doc.customer.phone} />}
        {addr && <InfoBox label={tr('العنوان')} value={addr} />}
        <div style={{ height: 8 }} />
        <InfoBox label={tr('طريقة الدفع')} value={tr(paymentMethodLabels[doc.paymentMethod] || doc.paymentMethod)} />
        {doc.notes && <InfoBox label={tr('ملاحظات')} value={doc.notes} />}
      </div>

      <div style={{ marginTop: 80, display: 'flex', justifyContent: 'space-between', color: '#6b7280', fontSize: 13 }}>
        <div>{tr('توقيع الدافع')}: ........................</div>
        <div>{tr('توقيع المستلم المندوب')}: ........................</div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''}
        <div style={{ marginTop: 6, fontSize: 10, color: '#c3bcae' }}>
          {tr('صدرت عبر منصة')} Field Sales · fieldsa.net
        </div>
      </div>
    </div>
  );
});
PrintableReceipt.displayName = 'PrintableReceipt';

// ============ قالب كشف الحساب ============
export const PrintableStatement = forwardRef<HTMLDivElement, { doc: StatementDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const addr = fullAddress(doc.customer);
  /* كل طرفٍ على حدة: اشتراطُ الطرفين كان يطبع «كل الفترات» على كشفٍ مُصفّى
   * بطرفٍ واحد — ورقةٌ تقول للعميل إنّها تاريخه كلّه وهي شهرٌ منه. (ولم يظهر
   * قبل اليوم لأنّ كلّ المستدعين كانوا يطلبون الكشف بلا مدّة.) */
  const shape = periodShape(doc.fromDate, doc.toDate);
  const period = shape === 'range' ? `${formatDate(doc.fromDate as string)} — ${formatDate(doc.toDate as string)}`
    : shape === 'from' ? `${tr('من')} ${formatDate(doc.fromDate as string)}`
    : shape === 'to' ? `${tr('حتى')} ${formatDate(doc.toDate as string)}`
    : tr('كل الفترات');
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
    <div ref={ref} style={PAGE}>
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
            <InfoBox label={tr('إجمالي المبيعات')} value={formatCurrency(doc.customer.totalSales ?? 0)} />
            <InfoBox label={tr('إجمالي التحصيل')} value={formatCurrency(doc.customer.totalCollected ?? 0)} />
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
              <td style={{ ...td }}>{formatDate(doc.fromDate)}</td>
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
              <td style={{ ...td, verticalAlign: 'top' }}>{formatDate(e.date)}</td>
              <td style={{ ...td, textAlign: 'right', verticalAlign: 'top' }}>
                {e.description}
                {e.items && e.items.length > 0 && (
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
                    <b style={{ color: '#4b5563' }}>{e.items.length} {tr('صنف')}:</b> {e.items.map(it => `${it.name} ×${it.qty}`).join(' ')}
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
            <span style={{ fontSize: 14, color: '#374151' }}>{tr('الرصيد المستحق على العميل')}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: doc.finalBalance > 0 ? '#dc2626' : '#16a34a' }}>{formatCurrency(doc.finalBalance)}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''} — {tr('تم الإصدار في')} {formatDateTime(doc.date)}
      </div>
    </div>
  );
});
PrintableStatement.displayName = 'PrintableStatement';

// سجلّ استلامات التحصيل لمندوب — جدولٌ مرتّب بالوقت والمبلغ ومن استلم، برأس الشركة
export const PrintableSettlementLog = forwardRef<HTMLDivElement, { doc: SettlementLogDoc }>(({ doc }, ref) => {
  const tr = useTr();
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
    <div ref={ref} style={PAGE}>
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
    </div>
  );
});
PrintableSettlementLog.displayName = 'PrintableSettlementLog';

// إشعار حركة بضاعة لسيارة مندوب — اسم المندوب + الأصناف بكمياتها + التاريخ والوقت، برأس الشركة
export const PrintableLoadNotice = forwardRef<HTMLDivElement, { doc: LoadNoticeDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const title = doc.movementKind === 'UNLOAD' ? tr('إشعار تنزيل بضاعة')
    : doc.movementKind === 'ADJUST' ? tr('إشعار تسوية مخزون') : tr('إشعار تحميل بضاعة');
  const totalQty = Number(doc.items.reduce((a, i) => a + Math.abs(i.qty), 0).toFixed(2));

  return (
    <div ref={ref} style={PAGE}>
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
          <InfoBox label={tr('إجمالي الكميات')} value={String(totalQty)} />
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
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('الوحدة')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={4}>{tr('لا توجد أصناف')}</td></tr>
          ) : doc.items.map((it, i) => (
            <tr key={i}>
              <td style={td}>{i + 1}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{it.name}</td>
              <td style={{ ...td, fontWeight: 700, color: '#16a34a' }}>{Number(Math.abs(it.qty).toFixed(2))}</td>
              <td style={{ ...td, color: '#6b7280' }}>{it.unit || '-'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }} colSpan={2}>{tr('الإجمالي')}</td>
            <td style={{ ...td, color: '#16a34a', borderTop: `2px solid ${brand}` }}>{totalQty}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{tr('وحدة')}</td>
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
    </div>
  );
});
PrintableLoadNotice.displayName = 'PrintableLoadNotice';

/** كمّية بلا أصفارٍ زائدة — الوحدات الموزونة قد تحمل كسوراً */
const fmtNoticeQty = (n: number) => String(Number(Number(n).toFixed(2)));

export const PrintableWarehouseNotice = forwardRef<HTMLDivElement, { doc: WarehouseNoticeDoc }>(({ doc }, ref) => {
  const tr = useTr();
  const brand = brandColor(doc.company);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const receive = doc.entryType === 'RECEIVE';
  const title = receive ? tr('إشعار وارد بضاعة') : tr('إشعار تسوية مخزون');
  const adj = adjustTotals(doc.items);
  const uncosted = receive ? uncostedCount(doc.items) : 0;
  /* وارد بلا أيّ سطرٍ مسعَّر (سُجّل قبل وصول فاتورة المورّد): إجماليه صفرٌ
   * حسابياً، لكنّ طباعته «٠٫٠٠» تقول على ورقةٍ موقَّعة إنّ البضاعة بلا ثمن —
   * وهي القاعدة نفسها التي تطبع «—» لسطرٍ بلا سعر، والشاشة تُخفي القيمة
   * أصلاً حين تكون صفراً. */
  const anyCosted = doc.items.some(isCosted);
  const cols = receive ? 6 : 4;

  return (
    <div ref={ref} style={PAGE}>
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
            ? <InfoBox label={tr('إجمالي الكميات')} value={fmtNoticeQty(receiveTotalQty(doc.items))} />
            : <>
                <InfoBox label={tr('إجمالي الزيادة')} value={fmtNoticeQty(adj.added)} />
                <InfoBox label={tr('إجمالي النقص')} value={fmtNoticeQty(adj.removed)} />
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
            <th style={receive ? th : { ...th, borderRadius: '8px 0 0 0' }}>{tr('الوحدة')}</th>
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
              <td style={{ ...td, borderTop: `2px solid ${brand}`, textAlign: 'right' }} colSpan={5}>{tr('قيمة البضاعة قبل الضريبة')}</td>
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
    </div>
  );
});
PrintableWarehouseNotice.displayName = 'PrintableWarehouseNotice';

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', color: color || '#374151' }}>
      <span>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ============ بناء مستند من بيانات الخادم ============
export function invoiceDocFromDetail(inv: any, repName: string, company?: Company | null): InvoiceDoc {
  return {
    kind: 'invoice',
    number: inv.number,
    date: inv.invoiceDate,
    deliveryDate: inv.deliveryDate ?? undefined,
    type: inv.type === 'RETURN' ? 'CREDIT' : inv.type,
    isReturn: inv.type === 'RETURN',
    company: company ?? null,
    customer: inv.customer,
    repName: inv.salesRep?.name ?? repName,
    items: (inv.items ?? []).map((it: any) => ({
      name: it.product?.name ?? '-',
      unit: it.product?.unit,
      qty: Number(it.qty),
      unitPrice: Number(it.unitPrice),
      discountPct: Number(it.discountPct),
      taxPct: Number(it.taxPct),
      lineTotal: Number(it.lineTotal),
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
   */
  range?: { from?: string; to?: string; openingBalance?: number; closingBalance?: number }
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
    items: (e.type !== 'RECEIPT_CREDIT' ? (e.invoice?.items || []) : []).map((it: any) => ({ name: it.product?.name ?? '-', qty: Number(it.qty), unit: it.product?.unit })),
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
    openingBalance: range?.openingBalance,
    entries: mapped,
    totalDebit,
    totalCredit,
    finalBalance,
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
  movement: { kind: string; date: string; ref?: string; by?: string | null; items: { name: string; qty: number; unit?: string }[] },
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
    items: movement.items.map((i) => ({ name: i.name, qty: Number(i.qty), unit: i.unit || undefined })),
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
    items: { qty: number; unitCost?: number | null; lineCost?: number | null; product: { name: string; unit?: string } }[];
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
    items: entry.items.map(i => ({
      name: i.product.name,
      unit: i.product.unit || undefined,
      qty: Number(i.qty),
      unitCost: i.unitCost == null ? null : Number(i.unitCost),
      lineCost: i.lineCost == null ? null : Number(i.lineCost),
    })),
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

// ============ شاشة النتيجة (معاينة + مشاركة/حفظ PDF) ============
export function DocumentResult({ doc, onClose }: { doc: AnyDoc; onClose: () => void }) {
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
  const canThermal = doc.kind === 'invoice' || doc.kind === 'receipt';

  const printThermal = async () => {
    setBusy(true); setStatus('');
    try {
      if (doc.kind === 'invoice') await printThermalInvoice(doc);
      else if (doc.kind === 'receipt') await printThermalReceipt(doc);
    } catch { setStatus(tr('تعذرت الطباعة تأكد من إعداد الطابعة')); }
    setBusy(false);
  };

  const isReturnDoc = doc.kind === 'invoice' && doc.isReturn;
  const subjectName = (doc.kind === 'settlement' || doc.kind === 'loadNotice') ? doc.repName
    : doc.kind === 'warehouseNotice' ? (doc.supplier || tr('مخزون الشركة'))
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
    : `${tr('كشف حساب')} — ${doc.customer.name}`;
  const filename = (doc.kind === 'invoice' ? `${isReturnDoc ? tr('مرتجع') : tr('فاتورة')}-${doc.number}`
    : doc.kind === 'receipt' ? `${tr('سند قبض')}-${doc.number}`
    : doc.kind === 'settlement' ? `${doc.entries.length === 1 ? tr('سند تحصيل') : tr('سجل تحصيل')}-${doc.repName}`
    : doc.kind === 'loadNotice' ? `${noticeLabel}-${doc.repName}`
    : doc.kind === 'warehouseNotice' ? `${warehouseLabel}-${doc.ref}`
    : `${tr('كشف حساب')}-${doc.customer.name}`) + '.pdf';
  const confirmText = isSettlement ? tr('سجل التحصيل جاهز') : (isLoadNotice || isWarehouseNotice) ? tr('الإشعار جاهز') : isStatement ? tr('كشف الحساب جاهز') : tr('تم الإصدار بنجاح');

  const renderDoc = (refProp?: React.Ref<HTMLDivElement>) => {
    if (doc.kind === 'invoice') return <PrintableInvoice ref={refProp} doc={doc} />;
    if (doc.kind === 'receipt') return <PrintableReceipt ref={refProp} doc={doc} />;
    if (doc.kind === 'settlement') return <PrintableSettlementLog ref={refProp} doc={doc} />;
    if (doc.kind === 'loadNotice') return <PrintableLoadNotice ref={refProp} doc={doc} />;
    if (doc.kind === 'warehouseNotice') return <PrintableWarehouseNotice ref={refProp} doc={doc} />;
    return <PrintableStatement ref={refProp} doc={doc} />;
  };

  const makePdf = async () => {
    if (!printRef.current) return;
    setBusy(true); setStatus('');
    try {
      const blob = await elementToPdfBlob(printRef.current);
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
        {/* تأكيد */}
        <div className={`${confirmBg} border rounded-2xl p-4 mb-4 flex items-center gap-3`}>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${accentBtn} text-white`}>
            <Check size={20} />
          </div>
          <div>
            <p className="font-bold text-gray-800 text-sm">{confirmText}</p>
            <p className="text-xs text-gray-500">{subjectName}</p>
          </div>
        </div>

        {/* تنبيه العمل دون اتصال: المستند مُلتقَط محلياً برقم مؤقّت، يرتفع للخادم عند الاتصال */}
        {(doc.kind === 'invoice' || doc.kind === 'receipt') && doc.offline && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-4 text-xs text-amber-800 leading-relaxed">
            <b>{tr('أنشئ دون اتصال')}</b> — {tr('الرقم مؤقت ويعتمد رقمه النهائي تلقائيا عند اتصالك بالإنترنت اطبع/سلم نسختك الآن بشكل طبيعي')}
          </div>
        )}

        {/* المرفقات قبل المعاينة عمداً: المعاينة كتلة بطول 470px تدفع الشريط تحت
            حافّة الشاشة، والمحاسب إنما فتح السند ليرى إيصال التحويل */}
        {doc.kind === 'receipt' && !!doc.photos?.length && <ReceiptAttachments photos={doc.photos} />}

        {/* معاينة مصغّرة للمستند */}
        <p className="text-xs text-gray-400 mb-2">{tr('معاينة المستند')}</p>
        <div className="mx-auto bg-white rounded-xl border border-gray-200 shadow-sm" style={{ width: 340, height: 470, overflow: 'hidden' }}>
          <div style={{ transform: 'scale(0.428)', transformOrigin: 'top right', width: 794 }}>
            {renderDoc()}
          </div>
        </div>

        {status && <p className="text-center text-green-600 text-sm font-medium mt-3">{status}</p>}
      </div>

      {/* أزرار */}
      <div className="p-4 border-t bg-white space-y-2">
        {canThermal && (
          <button onClick={printThermal} disabled={busy}
            className="w-full bg-white border-2 border-[#DED5C4] text-[#1F1A13] font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
            <Printer size={17} /> {tr('طباعة حرارية 58 مم')}
          </button>
        )}
        <button onClick={makePdf} disabled={busy}
          className={`w-full ${accentBtn} text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60`}>
          {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Share2 size={17} />}
          {tr('مشاركة / حفظ PDF')}
        </button>
        <button onClick={onClose} className="w-full bg-gray-100 text-gray-700 font-semibold py-3 rounded-xl">{tr('تم')}</button>
      </div>

      {/* النسخة الكاملة (خارج الشاشة) للالتقاط */}
      <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
        {renderDoc(printRef)}
      </div>
    </div>
  );
}
