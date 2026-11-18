import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileBarChart, Info, Loader2, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../../../api/client';
import { useLang } from '../../../i18n/lang';
import { useTr } from '../../../i18n/strings';
import type { AiReport } from '../../../lib/aiAccountant';
import type { Company } from '../../../rep/RepDocuments';
import { downloadPdf, elementsToPdfBlob, shareOrDownloadPdf } from '../../../rep/pdf';
import { printHtmlDocument } from '../../../rep/printPage';
import AiReportSheet from './AiReportSheet';
import {
  buildReportPrintHtml, flattenReport, isEstimatedReport, pageHeadHtml, pdfDeliveryFor, reportFileName,
  reportPeriodText, reportRowView, reportTitle,
} from './reportPdf';

/** سطور البطاقة قبل «عرض الكل» — ميزان مراجعةٍ بمئة حساب لا يملأ المحادثة */
const PREVIEW_ROWS = 14;

/** المسافة البادئة بمستوى البند (خصائص منطقية: يمين في العربية ويسار في غيرها) */
const INDENT = ['ps-4', 'ps-8', 'ps-12'] as const;

// هوية الشركة (الشعار والاسم والرقم الضريبي واللون) — المفتاح نفسه في كل اللوحة فتُقرأ من الذاكرة غالباً
const fetchCompany = async () => ((await companyApi.get()).data.data ?? null) as Company | null;

type Mode = 'pdf' | 'print';

/**
 * بطاقة تقرير «المحاسب الذكي» داخل المحادثة: العنوان والفترة وشارة «تقديري»، والأقسام جدولاً مضغوطاً بمستويات البنود
 * وإجمالياتها، والملاحظات، وزرّا «تحميل PDF» و«طباعة» بهوية الشركة (AiReportSheet خارج الشاشة ثم الالتقاط أو الطباعة).
 * الأرقام كما حسبها الخادم — البطاقة لا تجمع شيئاً.
 */
export default function ReportCard({ report }: { report: AiReport }) {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const qc = useQueryClient();
  // تحميلٌ مبكر للهوية: الشعار جاهزٌ قبل الضغط فلا ينتظر الالتقاط الشبكة
  useQuery({ queryKey: ['company'], queryFn: fetchCompany, staleTime: 300_000 });

  const [expanded, setExpanded] = useState(false);
  const [job, setJob] = useState<{ mode: Mode; company: Company | null } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // حارس الالتقاط الواحد: StrictMode يشغّل الأثر مرتين في التطوير فيُنزَّل الملف مرتين بلاه
  const busy = useRef(false);
  // حارس الضغط المزدوج أثناء جلب الهوية
  const starting = useRef(false);

  const estimated = isEstimatedReport(report);
  const title = reportTitle(report, lang, tr);
  const periodText = reportPeriodText(report.period);
  const flat = flattenReport(report);
  const shown = expanded ? flat : flat.slice(0, PREVIEW_ROWS);
  const notes = (report.notes ?? []).filter((n) => String(n ?? '').trim());

  const start = async (mode: Mode) => {
    if (job || busy.current || starting.current) return;
    starting.current = true;
    let co: Company | null = null;
    try {
      co = (await qc.ensureQueryData({ queryKey: ['company'], queryFn: fetchCompany })) ?? null;
    } catch { co = null; /* بلا هوية أهون من لا ملف: الترويسة تكتب «اسم الشركة» */ }
    starting.current = false;
    setJob({ mode, company: co });
  };

  useEffect(() => {
    if (!job || busy.current) return;
    busy.current = true;
    const run = async () => {
      // إطاران: React رسم الورقة والمتصفّح حسب تخطيطها قبل الالتقاط
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const slices = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>('[data-pdf-slice]') ?? []);
        if (!slices.length) throw new Error('no slices');
        if (job.mode === 'pdf') {
          const blob = await elementsToPdfBlob(slices);
          const name = reportFileName(report, tr);
          if (pdfDeliveryFor(window.location.pathname) === 'share') {
            const r = await shareOrDownloadPdf(blob, name);
            toast.success(r === 'shared' ? tr('✓ تمت المشاركة') : tr('✓ تم حفظ الملف في جهازك'));
          } else {
            downloadPdf(blob, name);
            toast.success(tr('تم التصدير'));
          }
        } else {
          await printHtmlDocument(buildReportPrintHtml(slices.map((s) => s.outerHTML), pageHeadHtml()), 210);
        }
      } catch {
        toast.error(job.mode === 'pdf' ? tr('تعذر إنشاء الملف حاول مجددا') : tr('تعذرت الطباعة تأكد من إعداد الطابعة'));
      }
      busy.current = false;
      // بلا شرط «ما زال مركّباً»: في StrictMode يُنظَّف الأثر الأول قبل أن ينتهي التقاطه، والثاني يتخطّاه الحارس
      setJob(null);
    };
    void run();
    // يُطلق بالضغط وحده (job) — التقرير والاسم يُقرآن لحظة الالتقاط
  }, [job]);

  return (
    <div className="rounded-2xl border border-[#E9E1D3] bg-white overflow-hidden shadow-sm">
      <div className="flex items-start gap-2 px-4 py-3 bg-[#FAF7F0] border-b border-[#F1EBDF]">
        <FileBarChart size={18} className="text-[#E15A30] mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-sm text-[#1F1A13]">{title}</h3>
            {estimated && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{tr('تقديري')}</span>
            )}
          </div>
          {periodText && (
            <p className="text-[11px] text-[#6E6557] mt-0.5">{tr('الفترة')}: <bdi>{periodText}</bdi></p>
          )}
          {estimated && (
            <p className="text-[11px] text-amber-800 mt-0.5">{tr('أرقام تقديرية وليست من الدفاتر المحاسبية')}</p>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <tbody>
            {shown.map((f) => {
              if (f.kind === 'section') {
                return (
                  <tr key={f.key}>
                    <td colSpan={2} className="bg-[#FAF7F0]/70 px-4 pt-2.5 pb-1 text-[12px] font-semibold text-[#1F1A13]">{tr(f.title)}</td>
                  </tr>
                );
              }
              if (f.kind === 'empty') {
                return (
                  <tr key={f.key}>
                    <td colSpan={2} className="px-4 py-3 text-center text-[12px] text-[#9A8F7E]">{tr('لا توجد بيانات')}</td>
                  </tr>
                );
              }
              const v = reportRowView(f.row, report.currency);
              return (
                <tr key={f.key} className={`border-t border-[#F6F1E7] ${v.bold ? 'font-semibold bg-[#FCFAF5]' : ''}`}>
                  <td className={`py-1.5 pe-2 text-[#1F1A13] ${INDENT[v.level]}`}>
                    {tr(v.label)}
                    {v.note && <span className="ms-1.5 text-[11px] font-normal text-[#9A8F7E]">{tr(v.note)}</span>}
                  </td>
                  <td className={`py-1.5 px-4 text-end tabular-nums whitespace-nowrap ${v.negative ? 'text-red-700' : v.muted ? 'text-[#6E6557]' : 'text-[#1F1A13]'}`}>
                    <bdi>{v.value}</bdi>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {flat.length > PREVIEW_ROWS && (
        <button
          type="button"
          className="w-full text-center text-[12px] font-medium text-[#C94E28] hover:bg-[#FAF7F0] py-2 border-t border-[#F6F1E7]"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? tr('عرض أقل') : `${tr('عرض الكل')} (${flat.length})`}
        </button>
      )}

      {notes.length > 0 && (
        <ul className="px-4 py-2 space-y-1 border-t border-[#F1EBDF]">
          {notes.map((n, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] leading-5 text-[#6E6557]">
              <Info size={12} className="mt-1 shrink-0 text-[#9A8F7E]" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2 flex-wrap px-4 py-2.5 border-t border-[#F1EBDF]">
        <button type="button" className="btn-secondary !px-3 !py-1.5 !text-xs" onClick={() => void start('pdf')} disabled={!!job}>
          {job?.mode === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {tr('تحميل PDF')}
        </button>
        <button type="button" className="btn-secondary !px-3 !py-1.5 !text-xs" onClick={() => void start('print')} disabled={!!job}>
          {job?.mode === 'print' ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} {tr('طباعة')}
        </button>
      </div>

      {job && (
        <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
          <AiReportSheet ref={sheetRef} report={report} company={job.company} />
        </div>
      )}
    </div>
  );
}
