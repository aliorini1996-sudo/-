import { forwardRef, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileSpreadsheet, FileText, Paperclip, Receipt } from 'lucide-react';
import toast from 'react-hot-toast';
import { suppliersApi, type Supplier, type SupplierStatement, type SupplierStatementLine } from '../../api/suppliers';
import EntryAttachmentsModal, { type AttachmentsEntry } from '../../components/EntryAttachmentsModal';
import { useTr } from '../../i18n/strings';
import { localDay } from '../../lib/paymentMethods';
import { brandColor, Header, type Company } from '../../rep/RepDocuments';
import { downloadPdf, elementsToPdfBlob } from '../../rep/pdf';
import { exportExcel } from '../../utils/excel';
import { formatCurrency, formatDateTime, formatDayOnly, getActiveCurrency } from '../../utils/format';
import { currencyDecimals } from '../../i18n/countries';
import {
  balanceSide, defaultStatementPeriod, periodInverted, safeFileName, statementKindLabel, statementRows, statementSheet, toCsv, type Tr,
} from './supplierLogic';
import { SupplierPaymentVoucherModal, voucherCompany } from './SupplierPaymentVoucher';
import { useEntryNotice } from './useEntryNotice';

/** سطور كل شريحة PDF — كل شريحةٍ عنصرٌ يُلتقط وحده فلا يتجاوز التقاطٌ حدّ canvas في كشفٍ طويل */
const PDF_SLICE_ROWS = 220;

/** الأنواع التي سطرها حركة مستودع (فاتورة/مرتجع) — تُفتح بإشعارها */
const ENTRY_KINDS = new Set(['BILL', 'BILL_REV', 'RETURN']);

/** مبلغٌ أو شرطة — الصفر في عمود المدين/الدائن فراغٌ لا «٠٫٠٠» (كشف حسابٍ يُقرأ بعينه) */
function amountCell(v: number, currency: string): string {
  return Math.round((Number(v) || 0) * 1000) === 0 ? '' : formatCurrency(v, currency);
}

/** الرصيد بجهته: الموجب مستحقٌّ للمورّد (دائن)، والسالب دفعة مقدّمة (مدين) */
export function BalanceText({ value, currency, tr }: { value: number; currency?: string; tr: Tr }) {
  const side = balanceSide(value);
  return (
    <span className={`tabular-nums font-semibold ${side === 'ADVANCE' ? 'text-green-700' : side === 'PAYABLE' ? 'text-[#1F1A13]' : 'text-gray-400'}`}>
      {formatCurrency(Math.abs(value), currency)}
      {side === 'ADVANCE' && <span className="ms-1 text-[10px] font-semibold">({tr('مقدم')})</span>}
    </span>
  );
}

/**
 * «كشف الحساب» للمورّد: من/إلى (الافتراضي من أول السنة)، والرصيد الافتتاحي، ومدين/دائن/رصيد جارٍ لكل سطر، والإجمالي والإقفال.
 * المرجع يفتح مستنده: حركة المستودع بإشعارها، وسند الصرف بورقته، ومرفقات الحركة بنافذتها القائمة. والتصدير Excel وCSV وPDF.
 */
export default function SupplierStatementTab({ supplier, company, canEdit }: { supplier: Supplier; company: Company | null; canEdit: boolean }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(() => defaultStatementPeriod(localDay()));
  const inverted = periodInverted(period.from, period.to);
  const stQ = useQuery({
    queryKey: ['supplier-statement', supplier.id, period.from, period.to],
    queryFn: async () => (await suppliersApi.statement(supplier.id, { from: period.from || undefined, to: period.to || undefined })).data.data as SupplierStatement,
    enabled: !inverted,
    placeholderData: keepPreviousData,
  });
  const st = stQ.data;
  const currency = st?.currency;

  // حركة المستودع (فاتورة/مرتجع) بإشعارها القائم
  const notice = useEntryNotice(supplier.id, company);
  const openEntry = notice.open;

  const [atts, setAtts] = useState<AttachmentsEntry | null>(null);
  const [voucherId, setVoucherId] = useState<string | null>(null);

  // التصدير
  const fileBase = () => safeFileName(`${tr('كشف حساب مورد')} ${supplier.name} ${period.from || ''} ${period.to || ''}`);
  // الأيام في الملفات بصيغة ISO (YYYY-MM-DD): تُفرز وتُقرأ تاريخاً في Excel وأي نظام محاسبي، لا نصّاً بأرقام اللغة
  const dayText = (d: string | null) => d ?? '';
  // منازل عملة الكشف (مصدر formatCurrency نفسه) — الدينار ثلاث، والريال اثنتان
  const decimals = () => currencyDecimals(currency || getActiveCurrency());
  const exportXlsx = async () => {
    if (!st) return;
    try {
      await exportExcel([statementSheet(st, { tr, decimals: decimals(), dayText })], fileBase());
      toast.success(tr('تم التصدير'));
    } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
  };
  const exportCsv = () => {
    if (!st) return;
    const blob = new Blob([toCsv(statementRows(st, { tr, decimals: decimals(), dayText }))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${fileBase()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast.success(tr('تم التصدير'));
  };
  // PDF: الورقة تُرسم خارج الشاشة عند الطلب وحده (كشفٌ بآلاف السطور لا يبقى في الصفحة)، ثم تُلتقط شرائحها
  const [pdfOn, setPdfOn] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);
  // حارس الالتقاط الواحد: StrictMode يشغّل الأثر مرتين في التطوير فيُنزَّل الملف مرتين بلاه
  const pdfBusy = useRef(false);
  useEffect(() => {
    if (!pdfOn || !st || pdfBusy.current) return;
    pdfBusy.current = true;
    const run = async () => {
      // إطاران: React رسم الورقة والمتصفّح حسب تخطيطها قبل الالتقاط
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const slices = Array.from(pdfRef.current?.querySelectorAll<HTMLElement>('[data-pdf-slice]') ?? []);
        if (!slices.length) throw new Error('no slices');
        downloadPdf(await elementsToPdfBlob(slices), `${fileBase()}.pdf`);
        toast.success(tr('تم التصدير'));
      } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
      pdfBusy.current = false;
      // بلا شرط «ما زال مركّباً»: في StrictMode يُنظَّف الأثر الأول قبل أن ينتهي التقاطه، والثاني يتخطّاه الحارس — فلولا هذا بقي الزرّ معطّلاً
      setPdfOn(false);
    };
    void run();
    // يُطلق بالضغط وحده (pdfOn) — الكشف والاسم يُقرآن لحظة الالتقاط
  }, [pdfOn]);

  const lineRef = (l: SupplierStatementLine) => {
    const text = l.ref ? <bdi>{l.ref}</bdi> : <span className="text-[#9A8F7E]">—</span>;
    if (l.supplierPaymentId) {
      return <button type="button" className="text-[#C94E28] hover:underline font-medium" onClick={() => setVoucherId(l.supplierPaymentId)}>{text}</button>;
    }
    if (l.warehouseEntryId && ENTRY_KINDS.has(l.kind)) {
      return <button type="button" className="text-[#C94E28] hover:underline font-medium" onClick={() => openEntry(l.warehouseEntryId as string)}>{text}</button>;
    }
    return text;
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('من')}</label>
            <input type="date" className="input w-40" value={period.from} max={period.to || undefined} onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-40" value={period.to} min={period.from || undefined} onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))} />
          </div>
          <button type="button" className="btn-secondary" onClick={() => setPeriod({ from: '', to: '' })}>{tr('كل الفترات')}</button>
          <div className="flex gap-2 flex-wrap ms-auto">
            <button className="btn-secondary" onClick={exportXlsx} disabled={!st}><FileSpreadsheet size={15} /> {tr('تصدير Excel')}</button>
            <button className="btn-secondary" onClick={exportCsv} disabled={!st}><Download size={15} /> {tr('تصدير CSV')}</button>
            <button className="btn-secondary" onClick={() => setPdfOn(true)} disabled={!st || pdfOn}><FileText size={15} /> {tr('تصدير PDF')}</button>
          </div>
        </div>
        {inverted && <p className="text-xs text-red-600 mt-2">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
      </div>

      {inverted ? null : stQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : stQ.isError || !st ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل كشف الحساب')}</span>
          <button onClick={() => stQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('الرصيد الافتتاحي')}</p>
              <p className="text-lg mt-0.5"><BalanceText value={st.opening} currency={currency} tr={tr} /></p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('مدين')} <span className="text-[10px] text-[#9A8F7E]">({tr('سداد ومرتجعات')})</span></p>
              <p className="text-lg font-bold tabular-nums text-green-700 mt-0.5">{formatCurrency(st.totalDebit, currency)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('دائن')} <span className="text-[10px] text-[#9A8F7E]">({tr('فواتير المورد')})</span></p>
              <p className="text-lg font-bold tabular-nums text-[#C94E28] mt-0.5">{formatCurrency(st.totalCredit, currency)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('الرصيد الختامي')}</p>
              <p className="text-lg mt-0.5"><BalanceText value={st.closing} currency={currency} tr={tr} /></p>
            </div>
          </div>

          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('التاريخ')}</th>
                    <th>{tr('النوع')}</th>
                    <th>{tr('المرجع')}</th>
                    <th>{tr('البيان')}</th>
                    <th>{tr('تاريخ الاستحقاق')}</th>
                    <th>{tr('مدين')}</th>
                    <th>{tr('دائن')}</th>
                    <th>{tr('الرصيد')}</th>
                    <th className="w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-[#FAF7F0]">
                    <td className="text-[#6E6557]">{st.from ? formatDayOnly(st.from) : '—'}</td>
                    <td colSpan={6} className="font-semibold text-[#6E6557]">{tr('رصيد افتتاحي')}</td>
                    <td><BalanceText value={st.opening} currency={currency} tr={tr} /></td>
                    <td></td>
                  </tr>
                  {st.lines.length === 0 ? (
                    <tr><td colSpan={9} className="text-center text-gray-400 py-8">{tr('لا حركات في هذه الفترة')}</td></tr>
                  ) : st.lines.map(l => (
                    <tr key={l.id}>
                      <td className="whitespace-nowrap">{formatDayOnly(l.date)}</td>
                      <td className="whitespace-nowrap">{tr(statementKindLabel(l.kind))}</td>
                      <td>{lineRef(l)}</td>
                      <td className="text-[12px] text-[#6E6557] max-w-[240px]">{l.description || ''}</td>
                      <td className="whitespace-nowrap text-[12px]">{l.dueDate ? formatDayOnly(l.dueDate) : ''}</td>
                      <td className="tabular-nums text-green-700">{amountCell(l.debit, currency ?? '')}</td>
                      <td className="tabular-nums text-[#C94E28]">{amountCell(l.credit, currency ?? '')}</td>
                      <td><BalanceText value={l.balance} currency={currency} tr={tr} /></td>
                      <td>
                        <div className="flex items-center gap-1 justify-end">
                          {l.warehouseEntryId && ENTRY_KINDS.has(l.kind) && (
                            <button type="button" title={tr('عرض الحركة')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" onClick={() => openEntry(l.warehouseEntryId as string)}>
                              <Eye size={15} />
                            </button>
                          )}
                          {l.supplierPaymentId && (
                            <button type="button" title={tr('سند الصرف')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557]" onClick={() => setVoucherId(l.supplierPaymentId)}>
                              <Receipt size={15} />
                            </button>
                          )}
                          {l.warehouseEntryId && l.attachmentsCount > 0 && (
                            <button type="button" title={tr('المرفقات')} className="p-1.5 rounded-lg hover:bg-[#F6F1E7] text-[#6E6557] inline-flex items-center gap-0.5"
                              onClick={() => setAtts({ id: l.warehouseEntryId as string, type: l.kind === 'RETURN' ? 'RETURN' : 'RECEIVE', supplier: supplier.name, createdAt: l.date, attachmentsCount: l.attachmentsCount })}>
                              <Paperclip size={15} /><span className="text-[11px] tabular-nums">{l.attachmentsCount}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#F1EBDF]/60 font-bold">
                    <td colSpan={5}>{tr('الإجمالي')}</td>
                    <td className="tabular-nums text-green-700">{formatCurrency(st.totalDebit, currency)}</td>
                    <td className="tabular-nums text-[#C94E28]">{formatCurrency(st.totalCredit, currency)}</td>
                    <td><BalanceText value={st.closing} currency={currency} tr={tr} /></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-[#9A8F7E]">{tr('الدائن يزيد المستحق للمورد والمدين ينقصه والرصيد السالب دفعة مقدمة للمورد')}</p>
        </>
      )}

      {notice.modal}
      {atts && (
        <EntryAttachmentsModal entry={atts} canEdit={canEdit} onClose={() => {
          setAtts(null);
          // أُضيف مرفقٌ أو حُذف ⇒ عدد المرفقات في الكشف
          qc.invalidateQueries({ queryKey: ['supplier-statement', supplier.id] });
        }} />
      )}
      {voucherId && <SupplierPaymentVoucherModal paymentId={voucherId} supplier={supplier} onClose={() => setVoucherId(null)} />}

      {pdfOn && st && (
        <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
          <SupplierStatementDoc ref={pdfRef} st={st} company={company} />
        </div>
      )}
    </div>
  );
}

const SHEET: React.CSSProperties = {
  width: 794, background: '#fff', padding: '32px 36px', boxSizing: 'border-box',
  fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif", color: '#1f2937', direction: 'rtl',
};

/** كشف حساب المورّد ورقةً A4 بشرائح (data-pdf-slice): الأولى بالترويسة وبيانات المورّد، وكلّها بعناوين الجدول */
export const SupplierStatementDoc = forwardRef<HTMLDivElement, { st: SupplierStatement; company: Company | null }>(({ st, company }, ref) => {
  const tr = useTr();
  const co = voucherCompany(company);
  const brand = brandColor(co);
  const cur = st.currency;
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '7px 5px', fontSize: 10.5, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '5px 5px', fontSize: 10, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const bal = (v: number) => `${formatCurrency(Math.abs(v), cur)}${balanceSide(v) === 'ADVANCE' ? ` (${tr('مقدم')})` : ''}`;
  const slices: SupplierStatementLine[][] = [];
  for (let i = 0; i < Math.max(1, st.lines.length); i += PDF_SLICE_ROWS) slices.push(st.lines.slice(i, i + PDF_SLICE_ROWS));
  const head = (
    <thead>
      <tr>
        <th style={{ ...th, borderRadius: '0 6px 0 0' }}>{tr('التاريخ')}</th>
        <th style={th}>{tr('النوع')}</th>
        <th style={th}>{tr('المرجع')}</th>
        <th style={{ ...th, textAlign: 'right' }}>{tr('البيان')}</th>
        <th style={th}>{tr('الاستحقاق')}</th>
        <th style={th}>{tr('مدين')}</th>
        <th style={th}>{tr('دائن')}</th>
        <th style={{ ...th, borderRadius: '6px 0 0 0' }}>{tr('الرصيد')}</th>
      </tr>
    </thead>
  );
  const s = st.supplier;
  return (
    <div ref={ref}>
      {slices.map((rows, si) => (
        <div key={si} data-pdf-slice style={SHEET}>
          {si === 0 && (
            <>
              <Header title={tr('كشف حساب مورد')} company={co} />
              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 12, fontSize: 11.5, lineHeight: 1.9 }}>
                  <div><b>{tr('المورد')}:</b> {s.name}{s.code ? ` · ${s.code}` : ''}</div>
                  {s.vatNumber && !(company?.taxDisabled === true) && <div><b>{tr('الرقم الضريبي')}:</b> <bdi dir="ltr">{s.vatNumber}</bdi></div>}
                  {s.phone && <div><b>{tr('الجوال')}:</b> <bdi dir="ltr">{s.phone}</bdi></div>}
                </div>
                <div style={{ flex: 1, background: '#f8fafc', borderRadius: 10, padding: 12, fontSize: 11.5, lineHeight: 1.9 }}>
                  <div><b>{tr('الفترة')}:</b> {st.from ? formatDayOnly(st.from) : tr('البداية')} — {st.to ? formatDayOnly(st.to) : tr('اليوم')}</div>
                  <div><b>{tr('الرصيد الافتتاحي')}:</b> {bal(st.opening)}</div>
                  <div><b>{tr('الرصيد الختامي')}:</b> {bal(st.closing)}</div>
                  <div><b>{tr('تاريخ الكشف')}:</b> {formatDateTime(new Date())}</div>
                </div>
              </div>
            </>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            {head}
            <tbody>
              {si === 0 && (
                <tr style={{ background: '#f8fafc' }}>
                  <td style={td}>{st.from ? formatDayOnly(st.from) : '—'}</td>
                  <td style={{ ...td, fontWeight: 700, textAlign: 'right' }} colSpan={6}>{tr('رصيد افتتاحي')}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{bal(st.opening)}</td>
                </tr>
              )}
              {rows.map(l => (
                <tr key={l.id}>
                  <td style={td}>{formatDayOnly(l.date)}</td>
                  <td style={td}>{tr(statementKindLabel(l.kind))}</td>
                  <td style={td}>{l.ref ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{l.description ?? ''}</td>
                  <td style={td}>{l.dueDate ? formatDayOnly(l.dueDate) : ''}</td>
                  <td style={td}>{amountCell(l.debit, cur)}</td>
                  <td style={td}>{amountCell(l.credit, cur)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{bal(l.balance)}</td>
                </tr>
              ))}
            </tbody>
            {si === slices.length - 1 && (
              <tfoot>
                <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                  <td style={{ ...td, borderTop: `2px solid ${brand}`, textAlign: 'right' }} colSpan={5}>{tr('الإجمالي')}</td>
                  <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{formatCurrency(st.totalDebit, cur)}</td>
                  <td style={{ ...td, borderTop: `2px solid ${brand}` }}>{formatCurrency(st.totalCredit, cur)}</td>
                  <td style={{ ...td, borderTop: `2px solid ${brand}`, color: brand }}>{bal(st.closing)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          {si === slices.length - 1 && (
            <div style={{ marginTop: 22, textAlign: 'center', color: '#9ca3af', fontSize: 10.5, borderTop: '1px solid #eef2f7', paddingTop: 10 }}>
              {tr('الدائن يزيد المستحق للمورد والمدين ينقصه والرصيد السالب دفعة مقدمة للمورد')} — {co?.name || ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
SupplierStatementDoc.displayName = 'SupplierStatementDoc';
