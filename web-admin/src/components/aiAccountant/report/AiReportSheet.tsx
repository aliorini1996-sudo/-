import { forwardRef } from 'react';
import { useLang } from '../../../i18n/lang';
import { useTr } from '../../../i18n/strings';
import type { AiReport } from '../../../lib/aiAccountant';
import { voucherCompany } from '../../../pages/suppliers/SupplierPaymentVoucher';
import { brandColor, Header, type Company } from '../../../rep/RepDocuments';
import { formatDateTime } from '../../../utils/format';
import {
  flattenReport, isEstimatedReport, notesWeight, paginateReport, reportKindName, reportPeriodText, reportRowView, reportTitle,
  SLICE_CAPACITY,
} from './reportPdf';

/** ورقة A4 بعرض 794 بكسل (PAGE في RepDocuments.tsx) — كـSHEET في كشف حساب المورّد */
const SHEET: React.CSSProperties = {
  width: 794, background: '#fff', padding: '32px 36px', boxSizing: 'border-box',
  fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif", color: '#1f2937', direction: 'rtl',
};

export interface AiReportSheetProps {
  report: AiReport;
  /** هوية الشركة من ['company'] — تمرّ عبر voucherCompany فشركةٌ «بلا ضريبة» لا يُطبع رقمها الضريبي */
  company: Company | null;
  /** لحظة الإصدار المطبوعة (الافتراضي الآن) */
  issuedAt?: Date;
}

/**
 * تقرير «المحاسب الذكي» ورقةً A4 بهوية الشركة (نمط SupplierStatementDoc — pages/suppliers/SupplierStatementTab.tsx):
 * شرائح data-pdf-slice كلٌّ دون صفحة، الأولى بالترويسة (الشعار والاسم والرقم الضريبي والسجل) وصندوق الفترة والعملة،
 * وكلّها بعناوين الجدول بلون الشركة، والأخيرة بالملاحظات وسطر «أعدّه المحاسب الذكي». تُرسم خارج الشاشة ثم تُلتقط PDF أو تُطبع.
 * التواريخ ميلادية (formatDayOnly/formatDateTime: ca-gregory)، والمبالغ بنظام أرقام الشركة (formatCurrency).
 */
const AiReportSheet = forwardRef<HTMLDivElement, AiReportSheetProps>(({ report, company, issuedAt }, ref) => {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const co = voucherCompany(company);
  const brand = brandColor(co);
  const estimated = isEstimatedReport(report);
  const kindName = reportKindName(report.kind, tr);
  const title = reportTitle(report, lang, tr);
  const periodText = reportPeriodText(report.period);
  const notes = (report.notes ?? []).filter((n) => String(n ?? '').trim());
  const slices = paginateReport(flattenReport(report), SLICE_CAPACITY, notesWeight(notes));

  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '7px 10px', fontSize: 11, fontWeight: 600 };
  const td: React.CSSProperties = { padding: '5px 10px', fontSize: 10.5, borderBottom: '1px solid #eef2f7', verticalAlign: 'top' };
  const box: React.CSSProperties = { flex: 1, background: '#f8fafc', borderRadius: 10, padding: 12, fontSize: 11.5, lineHeight: 1.9 };
  const head = (
    <thead>
      <tr>
        <th style={{ ...th, textAlign: 'right', borderRadius: '0 6px 0 0' }}>{tr('البند')}</th>
        <th style={{ ...th, textAlign: 'left', width: 190, borderRadius: '6px 0 0 0' }}>{tr('المبلغ')}</th>
      </tr>
    </thead>
  );

  return (
    <div ref={ref}>
      {slices.map((rows, si) => (
        <div key={si} data-pdf-slice style={SHEET}>
          {si === 0 && (
            <>
              <Header title={title} company={co} />
              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div style={box}>
                  {kindName && <div><b>{tr('التقرير')}:</b> {kindName}</div>}
                  <div><b>{tr('الفترة')}:</b> {periodText || '—'}</div>
                </div>
                <div style={box}>
                  {report.currency && <div><b>{tr('العملة')}:</b> <bdi dir="ltr">{report.currency}</bdi></div>}
                  <div><b>{tr('تاريخ الإصدار')}:</b> {formatDateTime(issuedAt ?? new Date())}</div>
                </div>
              </div>
              {estimated && (
                <div style={{
                  background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8,
                  padding: '7px 12px', fontSize: 11, fontWeight: 600, marginBottom: 12,
                }}>
                  {tr('تقديري')} — {tr('أرقام تقديرية وليست من الدفاتر المحاسبية')}
                </div>
              )}
            </>
          )}
          {rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              {head}
              <tbody>
                {rows.map((f) => {
                  if (f.kind === 'section') {
                    return (
                      <tr key={f.key}>
                        <td colSpan={2} style={{ ...td, background: '#f8fafc', fontWeight: 700, fontSize: 11.5, color: '#111827', paddingTop: 8 }}>{tr(f.title)}</td>
                      </tr>
                    );
                  }
                  if (f.kind === 'empty') {
                    return (
                      <tr key={f.key}>
                        <td colSpan={2} style={{ ...td, textAlign: 'center', color: '#9ca3af' }}>{tr('لا توجد بيانات')}</td>
                      </tr>
                    );
                  }
                  const v = reportRowView(f.row, report.currency);
                  const strong: React.CSSProperties = v.bold ? { fontWeight: 700, background: '#f9fafb', borderTop: `1.5px solid ${brand}` } : {};
                  return (
                    <tr key={f.key}>
                      {/* الورقة RTL دائماً: بداية السطر يمين — المسافة البادئة بالمستوى paddingRight (html2canvas لا يقرأ الخصائص المنطقية) */}
                      <td style={{ ...td, ...strong, textAlign: 'right', paddingRight: 10 + v.level * 18 }}>
                        {tr(v.label)}
                        {v.note && <span style={{ color: '#6b7280', fontSize: 9.5, fontWeight: 400, marginRight: 6 }}>{tr(v.note)}</span>}
                      </td>
                      <td style={{
                        ...td, ...strong, textAlign: 'left', whiteSpace: 'nowrap',
                        color: v.negative ? '#b91c1c' : v.muted ? '#6b7280' : '#111827',
                      }}>
                        <bdi>{v.value}</bdi>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {si === slices.length - 1 && (
            <>
              {notes.length > 0 && (
                <div style={{ marginTop: 14, background: '#f8fafc', borderRadius: 10, padding: '10px 12px', fontSize: 10.5, lineHeight: 1.8, color: '#4b5563' }}>
                  <div style={{ fontWeight: 700, color: '#111827', marginBottom: 2 }}>{tr('ملاحظات')}</div>
                  {notes.map((n, i) => <div key={i}>• {n}</div>)}
                </div>
              )}
              <div style={{ marginTop: 18, textAlign: 'center', color: '#9ca3af', fontSize: 10, borderTop: '1px solid #eef2f7', paddingTop: 8 }}>
                {tr('أعده المحاسب الذكي من بيانات النظام')}{co?.name ? ` — ${co.name}` : ''}
              </div>
            </>
          )}
          {slices.length > 1 && (
            <div style={{ marginTop: 8, textAlign: 'center', color: '#9ca3af', fontSize: 9.5 }}>
              {tr('صفحة')} {si + 1} / {slices.length}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
AiReportSheet.displayName = 'AiReportSheet';

export default AiReportSheet;
