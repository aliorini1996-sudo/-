import { forwardRef, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../../api/client';
import { supplierPaymentsApi, type SupplierPaymentView } from '../../api/suppliers';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { isTaxOff } from '../../lib/taxMode';
import { brandColor, Header, type Company } from '../../rep/RepDocuments';
import { elementToPdfBlob, downloadPdf } from '../../rep/pdf';
import { formatCurrency, formatDateTime, formatDayOnly } from '../../utils/format';
import { isPaymentView, paymentMethodLabel, referenceLabel, safeFileName, voucherSplit } from './supplierLogic';

/** بيانات المورّد التي تُطبع على السند (من بطاقته إن توفّرت — السند وحده يحمل الاسم) */
export interface VoucherSupplier { name: string; vatNumber?: string | null; phone?: string | null; iban?: string | null; bankName?: string | null }

const SHEET: React.CSSProperties = {
  width: 794, background: '#fff', padding: 40, boxSizing: 'border-box',
  fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif", color: '#1f2937', direction: 'rtl',
};

/** شركةٌ «بلا ضريبة» لا يُطبع رقمها الضريبي في الترويسة (كـtaxFreeView في مستندات المندوب) */
export function voucherCompany(company: Company | null | undefined): Company | null {
  if (!company) return null;
  return isTaxOff(company) ? { ...company, taxNumber: undefined } : company;
}

/**
 * سند صرف المورّد ورقةً A4 («ربط الدفاتر» L1): رقم SP-، والتاريخ، والمستفيد، والمبلغ، والطريقة ومرجعها، والبيان، والفواتير التي
 * سدّدها السند وما بقي دفعةً مقدَّمة، وتوقيعا المستلم والمحاسب. السند الملغى يُطبع بختم «ملغى» وسببه — لا يُخفى ولا يُحذف.
 * المبلغ كتابةً غير مطبوع: لا أداة تفقيط في المشروع بعد.
 */
export const SupplierPaymentVoucher = forwardRef<HTMLDivElement, {
  payment: SupplierPaymentView; company: Company | null; supplier?: VoucherSupplier | null;
}>(({ payment: p, company, supplier }, ref) => {
  const tr = useTr();
  const co = voucherCompany(company);
  const taxOff = isTaxOff(company);
  const brand = brandColor(co);
  const split = voucherSplit(p);
  const cancelled = p.status === 'CANCELLED';
  const name = supplier?.name || p.supplierName;
  const box: React.CSSProperties = { flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14, fontSize: 12.5, lineHeight: 2 };
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '8px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 12, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const line = (label: string, value: React.ReactNode) => (
    <div><span style={{ color: '#6b7280' }}>{label}: </span><b>{value}</b></div>
  );
  return (
    <div ref={ref} style={SHEET}>
      <Header title={tr('سند صرف')} company={co} />

      <div style={{ position: 'relative' }}>
        {cancelled && (
          <div style={{
            position: 'absolute', top: 30, left: '30%', transform: 'rotate(-14deg)', border: '4px solid #dc2626', color: '#dc2626',
            borderRadius: 12, padding: '6px 28px', fontSize: 34, fontWeight: 800, opacity: 0.8, zIndex: 1, background: 'rgba(255,255,255,0.6)',
          }}>
            {tr('ملغى')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
          <div style={box}>
            {line(tr('رقم السند'), <bdi dir="ltr">{p.displayNumber}</bdi>)}
            {line(tr('تاريخ الدفع'), formatDayOnly(p.paidAt))}
            {line(tr('طريقة الدفع'), tr(paymentMethodLabel(p.method)))}
            {p.method === 'REP_CUSTODY' && p.salesRepName && line(tr('المندوب'), p.salesRepName)}
            {p.reference && line(tr(referenceLabel(p.method)), <bdi>{p.reference}</bdi>)}
          </div>
          <div style={box}>
            {line(tr('صرفنا إلى'), name)}
            {!taxOff && supplier?.vatNumber && line(tr('الرقم الضريبي'), <bdi dir="ltr">{supplier.vatNumber}</bdi>)}
            {supplier?.phone && line(tr('الجوال'), <bdi dir="ltr">{supplier.phone}</bdi>)}
            {p.method === 'BANK_TRANSFER' && supplier?.iban && line(tr('الآيبان'), <bdi dir="ltr">{supplier.iban}</bdi>)}
            {p.method === 'BANK_TRANSFER' && supplier?.bankName && line(tr('البنك'), supplier.bankName)}
          </div>
        </div>

        <div style={{ border: `2px solid ${brand}`, borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 14, color: '#374151', fontWeight: 600 }}>{tr('المبلغ')}</span>
          <span style={{ fontSize: 26, fontWeight: 800, color: brand }}>{formatCurrency(p.amount)}</span>
        </div>

        {p.note && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
            <b>{tr('البيان')}:</b> {p.note}
          </div>
        )}

        {p.allocations.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead>
              <tr>
                <th style={{ ...th, borderRadius: '0 8px 0 0', width: 40 }}>#</th>
                <th style={{ ...th, textAlign: 'right' }}>{tr('فاتورة المورد')}</th>
                <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('المبلغ المسدد')}</th>
              </tr>
            </thead>
            <tbody>
              {p.allocations.map((a, i) => (
                <tr key={a.warehouseEntryId}>
                  <td style={td}>{i + 1}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{a.supplierRef ? <bdi>{a.supplierRef}</bdi> : tr('بلا رقم فاتورة')}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{formatCurrency(a.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                <td style={{ ...td, borderTop: `2px solid ${brand}`, textAlign: 'right' }} colSpan={2}>{tr('إجمالي المسدد من الفواتير')}</td>
                <td style={{ ...td, borderTop: `2px solid ${brand}`, color: brand }}>{formatCurrency(split.allocated)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {split.unapplied > 0 && (
          <p style={{ fontSize: 12.5, color: '#374151', margin: '6px 0 0' }}>
            {tr('دفعة مقدمة غير مخصصة لفاتورة')}: <b>{formatCurrency(split.unapplied)}</b>
          </p>
        )}
        {p.autoForEntryId && (
          <p style={{ fontSize: 11.5, color: '#6b7280', margin: '6px 0 0' }}>{tr('سند آلي لشراء نقدي')}</p>
        )}
        {cancelled && (
          <p style={{ fontSize: 12, color: '#b91c1c', margin: '8px 0 0' }}>
            {tr('ألغي السند')}{p.cancelledAt ? ` ${formatDateTime(p.cancelledAt)}` : ''}{p.cancelReason ? ` — ${p.cancelReason}` : ''}
          </p>
        )}
      </div>

      {/* التوقيعان */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40, marginTop: 30 }}>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 50 }}>{tr('توقيع المستلم')}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
          <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 50 }}>{tr('توقيع المحاسب')}</div>
        </div>
      </div>

      <div style={{ marginTop: 30, textAlign: 'center', color: '#9ca3af', fontSize: 11.5, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
        {co?.name || ''} — {tr('تاريخ الإصدار')} {formatDateTime(p.createdAt)}
      </div>
    </div>
  );
});
SupplierPaymentVoucher.displayName = 'SupplierPaymentVoucher';

/** PDF السند من عنصره المرسوم — صفحة واحدة دائماً */
export async function voucherPdfBlob(el: HTMLElement): Promise<Blob> {
  return elementToPdfBlob(el, { singlePage: true });
}

export function voucherFileName(p: Pick<SupplierPaymentView, 'displayNumber' | 'supplierName'>, tr: (s: string) => string): string {
  return `${safeFileName(`${tr('سند صرف')} ${p.displayNumber} ${p.supplierName}`)}.pdf`;
}

/**
 * نافذة السند: معاينةٌ مصغَّرة، و«تنزيل PDF»، و«فتح للطباعة» في تبويبٍ جديد (منعه المتصفّح ⇒ تنزيل). `payment` يُعرض فوراً،
 * أو `paymentId` يُجلب (من سطر كشف الحساب). يُلتقط نسخةٌ كاملة المقاس خارج الشاشة لا المعاينة المصغَّرة.
 */
export function SupplierPaymentVoucherModal({ payment, paymentId, supplier, onClose }: {
  payment?: SupplierPaymentView | null; paymentId?: string | null; supplier?: VoucherSupplier | null; onClose: () => void;
}) {
  const tr = useTr();
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as Company | null,
    staleTime: 300_000,
  });
  const given = isPaymentView(payment) ? payment : null;
  const id = given?.id ?? paymentId ?? null;
  const payQ = useQuery({
    queryKey: ['supplier-payment', id],
    queryFn: async () => (await supplierPaymentsApi.get(id as string)).data.data as unknown,
    enabled: !!id && !given,
  });
  // سندٌ لا يُرسم (ردٌّ ناقص) يُعامل خطأ تحميل لا ورقةً تسقط
  const fetched = isPaymentView(payQ.data) ? payQ.data : null;
  const p = given ?? fetched;
  const loadFailed = payQ.isError || (payQ.isSuccess && !fetched) || (!given && !id);
  const pdfRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const make = async (open: boolean) => {
    if (!p || !pdfRef.current) return;
    setBusy(true);
    try {
      const blob = await voucherPdfBlob(pdfRef.current);
      if (open) {
        const url = URL.createObjectURL(blob);
        // بلا 'noopener': مع هذه السمة يعيد window.open دائماً null فيُظنّ التبويب ممنوعاً — والرابط Blob من صنعنا
        const w = window.open(url, '_blank');
        if (!w) downloadPdf(blob, voucherFileName(p, tr));
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
      } else {
        downloadPdf(blob, voucherFileName(p, tr));
        toast.success(tr('تم التصدير'));
      }
    } catch {
      toast.error(tr('تعذر إنشاء الملف حاول مجددا'));
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#F1EBDF]">
          <h2 className="text-lg font-bold text-[#1F1A13]">{tr('سند صرف')} {p && <bdi dir="ltr" className="text-[#6E6557] text-base">{p.displayNumber}</bdi>}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-auto bg-[#F6F1E7] p-4">
          {!p ? (
            <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
              {loadFailed ? tr('تعذر تحميل السند') : tr('جاري التحميل')}
            </div>
          ) : (
            // معاينةٌ مصغَّرة بعرض النافذة — zoom لا transform فيأخذ الارتفاع المصغَّر نفسه
            <div className="mx-auto shadow-sm" style={{ width: 794, zoom: 0.78 }}>
              <SupplierPaymentVoucher payment={p} company={companyQ.data ?? null} supplier={supplier} />
            </div>
          )}
        </div>
        <div className="flex gap-2 p-4 border-t border-[#F1EBDF] flex-wrap">
          <button className="btn-primary" disabled={!p || busy} onClick={() => make(false)}><Download size={16} /> {tr('تنزيل PDF')}</button>
          <button className="btn-secondary" disabled={!p || busy} onClick={() => make(true)}><ExternalLink size={16} /> {tr('فتح للطباعة')}</button>
          <button className="btn-secondary ms-auto" onClick={onClose}>{tr('إغلاق')}</button>
        </div>
      </div>
      {/* نسخة الالتقاط بالمقاس الكامل خارج الشاشة */}
      {p && (
        <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
          <SupplierPaymentVoucher ref={pdfRef} payment={p} company={companyQ.data ?? null} supplier={supplier} />
        </div>
      )}
    </div>
  );
}
