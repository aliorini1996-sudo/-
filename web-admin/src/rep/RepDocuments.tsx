import { forwardRef, useRef, useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { formatCurrency, formatDate, formatTime, formatDateTime, paymentMethodLabels } from '../utils/format';
import { useTr } from '../i18n/strings';
import { elementToPdfBlob, shareOrDownloadPdf } from './pdf';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import { printThermalInvoice, printThermalReceipt } from './thermal';
import { Share2, Download, Check, ArrowRight, Printer } from 'lucide-react';

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
}

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
  isReturn?: boolean;
  company?: Company | null;
  customer: DocCustomer;
  repName: string;
  items: { name: string; unit?: string; qty: number; unitPrice: number; discountPct: number; taxPct: number; lineTotal: number }[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmt?: number;
  remainingAmt?: number;
  einvoice?: { provider?: string | null; status?: string | null; uuid?: string | null; qr?: string | null } | null;
}

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
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
}

export type AnyDoc = InvoiceDoc | ReceiptDoc | StatementDoc;

function fullAddress(c: { address?: string; district?: string; city?: string }): string {
  return [c.address, c.district, c.city].filter(Boolean).join('، ');
}

const PAGE: React.CSSProperties = {
  width: 794,
  minHeight: 1000,
  background: '#fff',
  padding: 40,
  boxSizing: 'border-box',
  fontFamily: "'IBM Plex Sans Arabic', sans-serif",
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
    ? tr('إشعار دائن (مرتجع)')
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
  const vatRate = doc.subtotal - doc.discount > 0 ? Math.round((doc.tax / (doc.subtotal - doc.discount)) * 100) : 0;
  return (
    <div ref={ref} style={PAGE}>
      <Header title={docTitle} company={doc.company} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 20 }}>
        <div style={{ flex: 1, background: doc.isReturn ? '#fffbeb' : '#eff6ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{doc.isReturn ? tr('بيانات المرتجع') : tr('بيانات الفاتورة')}</div>
          <InfoBox label={doc.isReturn ? tr('رقم المرتجع') : tr('رقم الفاتورة')} value={doc.number} />
          <InfoBox label={tr('التاريخ')} value={formatDate(doc.date)} />
          <InfoBox label={tr('وقت الإصدار')} value={formatTime(doc.date)} />
          {!doc.isReturn && <InfoBox label={tr('النوع')} value={doc.type === 'CASH' ? tr('نقدي') : tr('آجل')} />}
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
            <th style={th}>{tr('السعر')}</th>
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
              <td style={td}>{formatCurrency(it.unitPrice)}</td>
              <td style={td}>{it.discountPct > 0 ? `${it.discountPct}%` : '-'}</td>
              <td style={td}>{it.taxPct}%</td>
              <td style={{ ...td, fontWeight: 700 }}>{formatCurrency(it.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, maxWidth: 150 }}>{tr('معرّف الفاتورة الإلكترونية')}</div>
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
                {tr('قيد الاعتماد لدى منظومة الفوترة الإلكترونية.')}
              </div>
            );
          }
          return (
            <div style={{ fontSize: 10.5, color: '#9ca3af', maxWidth: 170, lineHeight: 1.6 }}>
              {tr('أضف الرقم الضريبي للشركة في إعدادات الشركة لإظهار رمز الفاتورة الضريبية المعتمد.')}
            </div>
          );
        })()}

        <div style={{ width: 300, fontSize: 14 }}>
          <Row label={tr('المجموع قبل الخصم')} value={formatCurrency(doc.subtotal)} />
          {doc.discount > 0 && <Row label={tr('الخصم')} value={`- ${formatCurrency(doc.discount)}`} color="#dc2626" />}
          <Row label={`${tr('ضريبة القيمة المضافة')} ${vatRate}%`} value={formatCurrency(doc.tax)} color="#1E7A52" />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderTop: `2px solid ${brand}`, marginTop: 6, fontWeight: 700, fontSize: 18, color: doc.isReturn ? '#b45309' : brand }}>
            <span>{doc.isReturn ? tr('إجمالي المرتجع (دائن)') : tr('الإجمالي النهائي')}</span>
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

      <div style={{ marginTop: 60, display: 'flex', justifyContent: 'space-between', color: '#6b7280', fontSize: 13 }}>
        <div>{tr('توقيع المستلم')}: ........................</div>
        <div>{tr('توقيع المندوب')}: ........................</div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {tr('شكراً لتعاملكم معنا')} — {doc.company?.name || ''}
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
        <div>{tr('توقيع المستلم (المندوب)')}: ........................</div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {doc.company?.name || ''}
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
  const period = doc.fromDate && doc.toDate ? `${formatDate(doc.fromDate)} — ${formatDate(doc.toDate)}` : tr('كل الفترات');
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
                    <b style={{ color: '#4b5563' }}>{e.items.length} {tr('صنف')}:</b> {e.items.map(it => `${it.name} ×${it.qty}`).join('، ')}
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
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discountAmt),
    tax: Number(inv.taxAmt),
    total: Number(inv.total),
    paidAmt: Number(inv.paidAmt),
    remainingAmt: Number(inv.remainingAmt),
    einvoice: {
      provider: inv.einvoiceProvider ?? null,
      status: inv.einvoiceStatus ?? null,
      uuid: inv.einvoiceUuid ?? null,
      qr: inv.einvoiceQr ?? null,
    },
  };
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
  };
}

export function statementDocFromData(
  customer: any, entries: any[], repName: string, company?: Company | null,
  range?: { from?: string; to?: string }
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
  const finalBalance = mapped.length ? mapped[mapped.length - 1].balance : Number(customer.balance ?? 0);
  return {
    kind: 'statement',
    company: company ?? null,
    customer,
    repName,
    date: new Date().toISOString(),
    fromDate: range?.from,
    toDate: range?.to,
    entries: mapped,
    totalDebit,
    totalCredit,
    finalBalance,
  };
}

// ============ شاشة النتيجة (معاينة + مشاركة/حفظ PDF) ============
export function DocumentResult({ doc, onClose }: { doc: AnyDoc; onClose: () => void }) {
  const tr = useTr();
  const printRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const isReceipt = doc.kind === 'receipt';
  const isStatement = doc.kind === 'statement';
  const headerBg = 'bg-[#1F1A13]';
  const accentBtn = isReceipt ? 'bg-[#1E7A52] hover:bg-[#176A46]' : 'bg-[#E15A30] hover:bg-[#C94E28]';
  const confirmBg = isReceipt ? 'bg-[#E4F1EA] border-[#cfe8db]' : 'bg-[#FBEBE2] border-[#F5DACE]';
  const canThermal = doc.kind === 'invoice' || doc.kind === 'receipt';

  const printThermal = async () => {
    setBusy(true); setStatus('');
    try {
      if (doc.kind === 'invoice') await printThermalInvoice(doc);
      else if (doc.kind === 'receipt') await printThermalReceipt(doc);
    } catch { setStatus(tr('تعذّرت الطباعة، تأكد من إعداد الطابعة')); }
    setBusy(false);
  };

  const isReturnDoc = doc.kind === 'invoice' && doc.isReturn;
  const title = doc.kind === 'invoice' ? `${isReturnDoc ? tr('فاتورة مرتجع') : tr('الفاتورة')} — ${doc.number}`
    : doc.kind === 'receipt' ? `${tr('سند القبض')} — ${doc.number}`
    : `${tr('كشف حساب')} — ${doc.customer.name}`;
  const filename = (doc.kind === 'invoice' ? `${isReturnDoc ? tr('مرتجع') : tr('فاتورة')}-${doc.number}`
    : doc.kind === 'receipt' ? `${tr('سند قبض')}-${doc.number}`
    : `${tr('كشف حساب')}-${doc.customer.name}`) + '.pdf';
  const confirmText = isStatement ? tr('كشف الحساب جاهز') : tr('تم الإصدار بنجاح');

  const renderDoc = (refProp?: React.Ref<HTMLDivElement>) => {
    if (doc.kind === 'invoice') return <PrintableInvoice ref={refProp} doc={doc} />;
    if (doc.kind === 'receipt') return <PrintableReceipt ref={refProp} doc={doc} />;
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
      setStatus(tr('تعذّر إنشاء الملف، حاول مجدداً'));
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
            <p className="text-xs text-gray-500">{doc.customer.name}</p>
          </div>
        </div>

        {/* معاينة مصغّرة للمستند */}
        <p className="text-xs text-gray-400 mb-2">{tr('معاينة المستند:')}</p>
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
            <Printer size={17} /> {tr('طباعة حرارية (58 مم)')}
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
