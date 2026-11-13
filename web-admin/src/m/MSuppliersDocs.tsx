import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Printer, Share2 } from 'lucide-react';
import type { SupplierPaymentView, SupplierStatement } from '../api/suppliers';
import { Header, brandColor, type Company } from '../rep/RepDocuments';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';
import { printPageNode } from '../rep/printPage';
import { periodShape } from '../rep/statementFacts';
import { announceDocOpen } from '../rep/companyRefresh';
import { pdfProfileOf, profileFor, readPrintSettings, type PrintProfile } from '../lib/print/printSettings';
import { isTaxOff } from '../lib/taxMode';
import { formatCurrency, formatDateTime, formatDayOnly, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { BALANCE_LABELS, balanceState, ledgerKindOf, payMethodLabel, paymentUnapplied } from './MSuppliersLogic';

/**
 * ورقتا الموردين — كشف الحساب وسند الصرف — بمعاينةٍ ومشاركة PDF وطباعة، في حزمةٍ كسولة (تجرّ jspdf وhtml2canvas).
 *
 * لماذا ورقتان هنا لا `DocumentResult` من تطبيق المندوب: قوالبه مكتوبةٌ للعميل («بيانات العميل»، «الرصيد المستحق على العميل»،
 * «إجمالي المبيعات») — وكشف المورّد بها يقول للمورّد إنّه مدينٌ لنا وهو دائن. فالورقة هنا بعباراتها، وتستعير من هناك ما لا
 * يخصّ الطرف: ترويسة الشركة (`Header` بشعارها ولونها ونصوصها) وصانع الـPDF والطباعة بنظام الجهاز.
 *
 * والكشف يُبنى من الصفوف التي على الشاشة بمدّتها (لا بطلبٍ جديد): مدّةٌ أخرى من الخادم تعطي ورقةً تخالف ما رآه المستخدم.
 */

export type SupplierDoc =
  | { kind: 'statement'; statement: SupplierStatement; from?: string; to?: string }
  | { kind: 'payment'; payment: SupplierPaymentView };

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

/** «إزالة الضريبة»: الترويسة بلا الرقم الضريبي للشركة — كما تفعل taxFreeView بأوراق المندوب */
function headerCompany(company: Company | null): Company | null {
  if (!company || !isTaxOff(company) || !company.taxNumber) return company;
  const { taxNumber: _dropped, ...rest } = company;
  return rest as Company;
}

/** قالب الطباعة: قالب الشركة لنوع المستند إن كان صفحيّاً، وإلّا قالب الـPDF (A4) — الورقة صفحةٌ لا شريطٌ حراريّ */
function pageProfileFor(company: Company | null, kind: SupplierDoc['kind']): PrintProfile | null {
  const { settings } = readPrintSettings(company?.printSettings);
  const routed = profileFor(settings, kind === 'statement' ? 'statement' : 'receipt');
  if (routed && routed.printer !== 'thermal') return routed;
  const pdf = pdfProfileOf(settings);
  return pdf.printer !== 'thermal' ? pdf : null;
}

export default function MSuppliersDocs({ doc, company, issuer, onClose }: {
  doc: SupplierDoc;
  company?: unknown;
  /** من أصدر الورقة — يُطبع فيها */
  issuer: string;
  onClose: () => void;
}) {
  const tr = useTr();
  const co = (company as Company | null | undefined) ?? null;
  const printRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  // فتح ورقةٍ يطلب إعدادات الشركة الأحدث في الخلفية (القوقعة تستمع) — شعارٌ حُدّث للتوّ يصل الورقة
  useEffect(() => { announceDocOpen(); }, []);
  const profile = useMemo(() => pageProfileFor(co, doc.kind), [co, doc.kind]);

  const title = doc.kind === 'statement'
    ? `${tr('كشف حساب مورد')} — ${doc.statement.supplier.name}`
    : `${tr('سند صرف')} — ${doc.payment.displayNumber}`;
  const filename = (doc.kind === 'statement'
    ? `${tr('كشف حساب مورد')}-${doc.statement.supplier.name}`
    : `${tr('سند صرف')}-${doc.payment.displayNumber}`).replace(/[\\/:*?"<>|]+/g, '-') + '.pdf';

  const sheet = (ref?: React.Ref<HTMLDivElement>) => doc.kind === 'statement'
    ? <SupplierStatementSheet ref={ref} doc={doc} company={co} issuer={issuer} />
    : <SupplierPaymentSheet ref={ref} payment={doc.payment} company={co} issuer={issuer} />;

  const share = async () => {
    if (!printRef.current) return;
    setBusy(true); setStatus('');
    try {
      const blob = await elementToPdfBlob(printRef.current);
      const r = await shareOrDownloadPdf(blob, filename);
      setStatus(r === 'shared' ? tr('✓ تمت المشاركة') : tr('✓ تم حفظ الملف في جهازك'));
    } catch {
      setStatus(tr('تعذر إنشاء الملف حاول مجددا'));
    }
    setBusy(false);
  };

  const print = async () => {
    if (!printRef.current || !profile) return;
    setBusy(true); setStatus('');
    try {
      await printPageNode(printRef.current, profile, [tr('الأصل'), tr('نسخة')]);
    } catch {
      setStatus(tr('تعذرت الطباعة تأكد من إعداد الطابعة'));
    }
    setBusy(false);
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose} aria-label={tr('رجوع')}><ArrowRight size={20} /></button>
        <span className="font-bold text-sm truncate">{title}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="bg-[#E4F1EA] border border-[#cfe8db] rounded-2xl p-4 mb-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white bg-[#1E7A52]"><Check size={20} /></div>
          <div className="min-w-0">
            <p className="font-bold text-gray-800 text-sm">{doc.kind === 'statement' ? tr('كشف الحساب جاهز') : tr('السند جاهز')}</p>
            <p className="text-xs text-gray-500 truncate">{doc.kind === 'statement' ? doc.statement.supplier.name : doc.payment.supplierName}</p>
          </div>
        </div>

        <p className="text-xs text-gray-400 mb-2">{tr('معاينة المستند')}</p>
        <div className="mx-auto bg-white rounded-xl border border-gray-200 shadow-sm" style={{ width: 340, height: 470, overflow: 'hidden' }}>
          <div style={{ transform: 'scale(0.428)', transformOrigin: 'top right', width: 794 }}>{sheet()}</div>
        </div>
        {status && <p className="text-center text-green-600 text-sm font-medium mt-3">{status}</p>}
      </div>

      <div className="p-4 border-t bg-white space-y-2" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        {profile && (
          <button onClick={print} disabled={busy}
            className="w-full bg-white border-2 border-[#DED5C4] text-[#1F1A13] font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
            <Printer size={17} /> {tr('طباعة')}
          </button>
        )}
        <button onClick={share} disabled={busy}
          className="w-full bg-[#1E7A52] hover:bg-[#176A46] text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Share2 size={17} />}
          {tr('مشاركة / حفظ PDF')}
        </button>
        <button onClick={onClose} className="w-full bg-gray-100 text-gray-700 font-semibold py-3 rounded-xl">{tr('تم')}</button>
      </div>

      {/* النسخة الكاملة خارج الشاشة للالتقاط والطباعة — المعاينة أعلاه مصغّرةٌ بالتحويل فلا تُلتقط */}
      <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>{sheet(printRef)}</div>
    </div>
  );
}

// ═══ أجزاء مشتركة ═══

function InfoRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ color: '#6b7280', fontSize: 13 }}>{label}: </span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span>
    </div>
  );
}

function Footer({ company, issuer }: { company: Company | null; issuer: string }) {
  const tr = useTr();
  return (
    <div style={{ marginTop: 40, textAlign: 'center', color: '#9ca3af', fontSize: 12, borderTop: '1px solid #eef2f7', paddingTop: 12 }}>
      {company?.name || ''} — {tr('تم الإصدار في')} {formatDateTime(new Date())} — {issuer}
    </div>
  );
}

// ═══ كشف حساب المورّد ═══

const SupplierStatementSheet = forwardRef<HTMLDivElement, {
  doc: Extract<SupplierDoc, { kind: 'statement' }>; company: Company | null; issuer: string;
}>(({ doc, company, issuer }, ref) => {
  const tr = useTr();
  const st = doc.statement;
  const sup = st.supplier;
  const taxOff = isTaxOff(company);
  const brand = brandColor(company);
  const cur = st.currency || undefined;
  const decimals = currencyDecimals(st.currency || getActiveCurrency());
  const money = (v: number) => formatCurrency(v, cur);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 6px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 11.5, textAlign: 'center', borderBottom: '1px solid #eef2f7', verticalAlign: 'top' };
  /* حدّا المدّة يومان خالصان (YYYY-MM-DD) يُقرآن بأجزائهما — وكلُّ طرفٍ على حدة: ورقةٌ بطرفٍ واحد لا تُطبع «كل الفترات» */
  const shape = periodShape(doc.from, doc.to);
  const period = shape === 'range' ? `${formatDayOnly(doc.from)} — ${formatDayOnly(doc.to)}`
    : shape === 'from' ? `${tr('من')} ${formatDayOnly(doc.from)}`
    : shape === 'to' ? `${tr('حتى')} ${formatDayOnly(doc.to)}`
    : tr('كل الفترات');
  const closing = balanceState(st.closing, decimals);
  const closingTone = closing.state === 'owed' ? { bg: '#fef2f2', bd: '#fca5a5', fg: '#dc2626' }
    : closing.state === 'advance' ? { bg: '#eff6ff', bd: '#93c5fd', fg: '#2563eb' }
    : { bg: '#f0fdf4', bd: '#86efac', fg: '#16a34a' };
  const addr = [sup.city, sup.address].filter(Boolean).join('، ');

  return (
    <div ref={ref} style={PAGE}>
      <Header title={tr('كشف حساب مورد')} company={headerCompany(company)} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات المورد')}</div>
          <InfoRow label={tr('الاسم')} value={sup.name} />
          {sup.code && <InfoRow label={tr('الرمز')} value={sup.code} />}
          {sup.crNumber && <InfoRow label={tr('السجل التجاري')} value={sup.crNumber} />}
          {!taxOff && sup.vatNumber && <InfoRow label={tr('الرقم الضريبي')} value={sup.vatNumber} />}
          {sup.phone && <InfoRow label={tr('الجوال')} value={<span dir="ltr">{sup.phone}</span>} />}
          {addr && <InfoRow label={tr('العنوان')} value={addr} />}
        </div>
        <div style={{ flex: 1, background: '#eff6ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, color: brand, marginBottom: 8, fontSize: 14 }}>{tr('بيانات الكشف')}</div>
          <InfoRow label={tr('تاريخ الإصدار')} value={formatDateTime(new Date())} />
          <InfoRow label={tr('الفترة')} value={period} />
          <InfoRow label={tr('أصدره')} value={issuer} />
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #cbd5e1' }}>
            <InfoRow label={tr('مجموع الفواتير والإضافات')} value={money(st.totalCredit)} />
            <InfoRow label={tr('مجموع السداد والمرتجعات')} value={money(st.totalDebit)} />
          </div>
        </div>
      </div>

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
          {doc.from && (
            <tr style={{ background: '#f8fafc' }}>
              <td style={td}>-</td>
              <td style={td}>{formatDayOnly(doc.from)}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{tr('رصيد مرحل من قبل الفترة')}</td>
              <td style={td}>-</td>
              <td style={{ ...td, color: '#cbd5e1' }}>-</td>
              <td style={{ ...td, color: '#cbd5e1' }}>-</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(st.opening)}</td>
            </tr>
          )}
          {st.lines.length === 0 ? (
            <tr><td style={{ ...td, padding: 20, color: '#9ca3af' }} colSpan={7}>{tr('لا توجد حركات في هذه الفترة')}</td></tr>
          ) : st.lines.map((l, i) => (
            <tr key={l.id}>
              <td style={td}>{i + 1}</td>
              <td style={td}>{formatDayOnly(l.date)}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                {/* بيان الخادم كاملٌ بنوعه ومرجعه وطريقته («سند صرف SP-000012 — نقدي») — والاسم المترجَم بديله حين يغيب */}
                {l.description || tr(ledgerKindOf(l.kind).label)}
                {l.kind === 'BILL' && l.dueDate && l.dueDate !== l.date && (
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>{tr('يستحق')} {formatDayOnly(l.dueDate)}</div>
                )}
              </td>
              <td style={{ ...td, fontSize: 10, color: '#6b7280' }}>{l.ref || '-'}</td>
              <td style={{ ...td, color: l.debit > 0 ? '#16a34a' : '#cbd5e1' }}>{l.debit > 0 ? money(l.debit) : '-'}</td>
              <td style={{ ...td, color: l.credit > 0 ? '#dc2626' : '#cbd5e1' }}>{l.credit > 0 ? money(l.credit) : '-'}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(l.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }} colSpan={4}>{tr('الإجماليات')}</td>
            <td style={{ ...td, color: '#16a34a', borderTop: `2px solid ${brand}` }}>{money(st.totalDebit)}</td>
            <td style={{ ...td, color: '#dc2626', borderTop: `2px solid ${brand}` }}>{money(st.totalCredit)}</td>
            <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{money(st.closing)}</td>
          </tr>
        </tfoot>
      </table>

      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div style={{ background: closingTone.bg, border: `2px solid ${closingTone.bd}`, borderRadius: 12, padding: '14px 24px', minWidth: 300 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 14, color: '#374151' }}>{tr(BALANCE_LABELS[closing.state])}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: closingTone.fg }}>{formatCurrency(closing.amount, cur)}</span>
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{doc.to ? tr('رصيد نهاية الفترة') : tr('الرصيد الحالي')}</div>
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280' }}>
        {tr('الدائن يزيد المستحق للمورد فواتير وإلغاء سندات والمدين ينقصه سندات صرف ومرتجعات والرصيد الموجب مستحق له')}
      </div>

      <Footer company={company} issuer={issuer} />
    </div>
  );
});
SupplierStatementSheet.displayName = 'SupplierStatementSheet';

// ═══ سند الصرف ═══

const SupplierPaymentSheet = forwardRef<HTMLDivElement, {
  payment: SupplierPaymentView; company: Company | null; issuer: string;
}>(({ payment: p, company, issuer }, ref) => {
  const tr = useTr();
  const brand = brandColor(company);
  const decimals = currencyDecimals(getActiveCurrency());
  const cancelled = p.status === 'CANCELLED';
  const unapplied = paymentUnapplied(p, decimals);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '9px 8px', fontSize: 12, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '8px', fontSize: 12, textAlign: 'center', borderBottom: '1px solid #eef2f7' };

  return (
    <div ref={ref} style={{ ...PAGE, position: 'relative' }}>
      <Header title={tr('سند صرف')} company={headerCompany(company)} />

      {/* الملغى يُوسَم على الورقة نفسها — ورقةٌ تُسلَّم كسندٍ ساري وهو ملغى تكذب بأصدق ختم */}
      {cancelled && (
        <div style={{ border: '3px solid #dc2626', color: '#dc2626', borderRadius: 12, padding: '8px 16px', marginBottom: 16, textAlign: 'center', fontWeight: 800, fontSize: 18 }}>
          {tr('سند ملغى')}{p.cancelReason ? <span style={{ fontWeight: 600, fontSize: 13 }}> — {p.cancelReason}</span> : null}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
          <InfoRow label={tr('رقم السند')} value={<span dir="ltr">{p.displayNumber}</span>} />
          <InfoRow label={tr('تاريخ السند')} value={formatDayOnly(p.paidAt)} />
          <InfoRow label={tr('صرف إلى المورد')} value={p.supplierName} />
        </div>
        <div style={{ flex: 1, background: '#eff6ff', borderRadius: 10, padding: 14 }}>
          <InfoRow label={tr('طريقة الدفع')} value={tr(payMethodLabel(p.method))} />
          {p.method === 'REP_CUSTODY' && <InfoRow label={tr('المندوب')} value={p.salesRepName || '—'} />}
          {p.reference && <InfoRow label={tr('المرجع')} value={<span dir="ltr">{p.reference}</span>} />}
          {p.note && <InfoRow label={tr('ملاحظات')} value={p.note} />}
          {p.createdBy && <InfoRow label={tr('سجله')} value={p.createdBy} />}
        </div>
      </div>

      <div style={{ background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 12, padding: '16px 24px', marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 15, color: '#374151' }}>{tr('المبلغ')}</span>
        <span style={{ fontSize: 26, fontWeight: 800, color: cancelled ? '#9ca3af' : '#16a34a', textDecoration: cancelled ? 'line-through' : 'none' }}>
          {formatCurrency(p.amount)}
        </span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderRadius: '0 8px 0 0' }}>#</th>
            <th style={{ ...th, textAlign: 'right' }}>{tr('رقم فاتورة المورد')}</th>
            <th style={{ ...th, borderRadius: '8px 0 0 0' }}>{tr('المبلغ المخصص')}</th>
          </tr>
        </thead>
        <tbody>
          {p.allocations.length === 0 && unapplied === 0 ? (
            <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={3}>{tr('لا تخصيص')}</td></tr>
          ) : null}
          {p.allocations.map((a, i) => (
            <tr key={a.warehouseEntryId}>
              <td style={td}>{i + 1}</td>
              <td style={{ ...td, textAlign: 'right' }}>{a.supplierRef || tr('بلا رقم فاتورة')}</td>
              <td style={{ ...td, fontWeight: 700 }}>{formatCurrency(a.amount)}</td>
            </tr>
          ))}
          {unapplied > 0 && (
            <tr style={{ background: '#eff6ff' }}>
              <td style={td}>-</td>
              <td style={{ ...td, textAlign: 'right' }}>{tr('دفعة مقدمة غير مخصصة')}</td>
              <td style={{ ...td, fontWeight: 700, color: '#2563eb' }}>{formatCurrency(unapplied)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 40, marginTop: 50 }}>
        {[tr('المستلم'), tr('المحاسب')].map(label => (
          <div key={label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ borderTop: '1px solid #9ca3af', paddingTop: 6, fontSize: 12, color: '#6b7280' }}>{label}</div>
          </div>
        ))}
      </div>

      <Footer company={company} issuer={issuer} />
    </div>
  );
});
SupplierPaymentSheet.displayName = 'SupplierPaymentSheet';
