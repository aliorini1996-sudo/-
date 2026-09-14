import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, Loader2, Search, Trash2, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { quotesApi } from '../api/client';
import { backdropClose } from '../lib/backdropClose';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';
import { IssuedQuoteRow, QuoteDocument, dmy, money, rowToDocProps } from '../quote/quoteDoc';

/**
 * سجلّ عروض الأسعار — لوحة المالك. كل عرضٍ صدر من الرابط الخاص `/q-fs7k2m`
 * (المالك أو موظّف مبيعات) يظهر هنا، ويُعاد رسم مستنده **من المكوّن نفسه** الذي
 * طبعه للعميل، فالمعاينة والملف المُعاد تنزيله مطابقان لما وصله.
 */

const QUOTE_PATH = '/q-fs7k2m';

interface QuoteList {
  items: IssuedQuoteRow[];
  total: number;
  page: number;
  pageSize: number;
  totalHalalas: number;
  last30Days: number;
}

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

export default function QuotesPanel({ onClose }: { onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<IssuedQuoteRow | null>(null);

  // البحث بعد توقّف الكتابة، ويعود للصفحة الأولى
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['issued-quotes', q, page],
    queryFn: async () => (await quotesApi.list({ q: q || undefined, page })).data.data as QuoteList,
    placeholderData: keepPreviousData,
  });

  const link = `${window.location.origin}${QUOTE_PATH}`;
  const copyLink = () => {
    navigator.clipboard?.writeText(link)
      .then(() => toast.success('نسخ رابط الإصدار'))
      .catch(() => toast.error('تعذر النسخ انسخه يدويا'));
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // حذف آخر عرضٍ في آخر صفحة يترك «لا عروض» كاذبة بلا ترقيم — نعود لآخر صفحةٍ موجودة
  useEffect(() => { if (data && page > pages) setPage(pages); }, [data, page, pages]);

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-2 sm:p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[94vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center flex-shrink-0">
              <FileText size={20} className="text-[#E15A30]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#1F1A13]">عروض الأسعار</h2>
              <p className="text-xs text-[#6E6557]">كل عرض صدر من رابط الإصدار الخاص مع معاينة مستنده</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label="إغلاق"><X size={18} /></button>
        </div>

        {/* رابط الإصدار + الملخّص + البحث */}
        <div className="px-4 sm:px-5 py-3 border-b border-[#F1EBDF] space-y-3">
          <div className="flex items-center gap-2 bg-[#FAF7F0] rounded-xl px-3 py-2 text-[12px]">
            <span className="text-[#6E6557] flex-shrink-0">رابط الإصدار</span>
            <span className="font-mono text-[#1F1A13] truncate flex-1 text-left" dir="ltr">{link.replace(/^https?:\/\//, '')}</span>
            <button onClick={copyLink} className="p-1.5 rounded-lg hover:bg-white text-[#6E6557]" title="نسخ"><Copy size={14} /></button>
            <a href={QUOTE_PATH} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-lg hover:bg-white text-[#6E6557]" title="فتح">
              <ExternalLink size={14} />
            </a>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label={q ? 'نتائج البحث' : 'كل العروض'} value={data ? String(data.total) : '—'} />
            <Stat label="قيمتها الإجمالية" value={data ? `${money(data.totalHalalas / 100)} ر.س` : '—'} />
            <Stat label="آخر ٣٠ يوماً" value={data ? String(data.last30Days) : '—'} />
          </div>

          <div className="relative">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
            <input className="input w-full pr-9" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="ابحث باسم المنشأة أو الرقم الموحد أو مقدم العرض أو رقم العرض" />
          </div>
        </div>

        {/* السجل */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {isLoading ? (
            <p className="text-center text-gray-400 py-10">جار التحميل</p>
          ) : isError ? (
            <p className="text-center text-red-500 py-10">تعذر تحميل عروض الأسعار</p>
          ) : !data || data.items.length === 0 ? (
            <p className="text-center text-gray-400 py-10">
              {q ? 'لا عروض تطابق البحث' : 'لا عروض بعد — كل عرض يصدر من رابط الإصدار يظهر هنا'}
            </p>
          ) : (
            <ul className={isFetching ? 'opacity-60 transition-opacity' : ''}>
              {data.items.map(r => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(r)}
                    className="w-full text-start px-4 sm:px-5 py-3 border-b border-[#F1EBDF] hover:bg-[#FAF7F0] flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="font-bold text-[#1F1A13] truncate">{r.company}</span>
                        <span className="text-[11px] text-[#9A8F7E] flex-shrink-0" dir="ltr">{r.unifiedNo}</span>
                        {r.offline && <OfflineBadge />}
                      </div>
                      <div className="text-[11px] text-[#6E6557] mt-0.5 truncate">
                        {r.packageName} · {r.cycle === 'yearly' ? 'سنوية' : 'شهرية'}
                        {r.presenter ? ` · ${r.presenter}` : ''}
                        {r.note ? ' · فيه ملاحظات' : ''}
                      </div>
                    </div>
                    <div className="text-left flex-shrink-0">
                      <div className="font-bold tabular-nums text-[#1F1A13]">{money(r.totalHalalas / 100)} ر.س</div>
                      <div className="text-[10px] text-[#9A8F7E] tabular-nums" dir="ltr">{r.quoteNo} · {dmy(new Date(r.issuedAt))}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(pages > 1 || page > 1) && (
          <div className="flex items-center justify-between px-4 sm:px-5 py-2.5 border-t border-[#F1EBDF] text-[12px] text-[#6E6557]">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[#FAF7F0] disabled:opacity-40">
              <ChevronRight size={14} /> الأحدث
            </button>
            <span className="tabular-nums">صفحة {page} من {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[#FAF7F0] disabled:opacity-40">
              الأقدم <ChevronLeft size={14} />
            </button>
          </div>
        )}
      </div>

      {open && <QuotePreview row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** صدر برقمٍ مؤقّت ولحظةٍ من الجوال — الرقم والتاريخ من الجهاز لا من الخادم */
function OfflineBadge() {
  return (
    <span className="text-[10px] font-semibold bg-[#FBF0D8] text-[#9A6B1E] px-1.5 py-0.5 rounded-md flex-shrink-0"
      title="صدر برقم مؤقت من جوال الموظف وسجل لاحقا عند عودة الاتصال">
      بلا اتصال
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#FAF7F0] rounded-xl px-2 py-2 min-w-0">
      <div className="text-[10px] text-[#9A8F7E]">{label}</div>
      <div className="text-sm font-bold text-[#1F1A13] tabular-nums truncate">{value}</div>
    </div>
  );
}

/** معاينة المستند بمقاسٍ يلائم الشاشة + تنزيل PDF من نسخةٍ بمقاسها الحقيقي خارج الشاشة */
function QuotePreview({ row, onClose }: { row: IssuedQuoteRow; onClose: () => void }) {
  const qc = useQueryClient();
  const props = rowToDocProps(row);
  const boxRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [docH, setDocH] = useState(1123);
  const [busy, setBusy] = useState(false);

  // html2canvas لا يلتقط عنصراً مُحجَّماً بـtransform بدقّة — فالمعاينة للعين والنسخة الخفيّة للملف
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => {
      setScale(Math.min(1, el.clientWidth / 794));
      if (printRef.current) setDocH(Math.max(1123, printRef.current.offsetHeight));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    if (printRef.current) ro.observe(printRef.current);
    return () => ro.disconnect();
  }, []);

  const remove = useMutation({
    mutationFn: () => quotesApi.remove(row.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issued-quotes'] });
      toast.success('حذف العرض');
      onClose();
    },
    onError: (e) => toast.error(errMsg(e, 'تعذر حذف العرض')),
  });

  const download = async () => {
    if (!printRef.current || busy) return;
    setBusy(true);
    try {
      const blob = await elementToPdfBlob(printRef.current, { singlePage: true });
      const safe = row.company.replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
      await shareOrDownloadPdf(blob, `عرض سعر - ${safe} - ${row.quoteNo}.pdf`);
    } catch {
      toast.error('تعذر تجهيز الملف');
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = () => {
    if (window.confirm(`حذف العرض ${row.quoteNo} لـ ${row.company} نهائياً؟`)) remove.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-2 sm:p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-[#F1EBDF] rounded-2xl shadow-2xl w-full max-w-[860px] max-h-[96vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-white rounded-t-2xl border-b border-[#E9E1D3]">
          <div className="min-w-0">
            <p className="font-bold text-[#1F1A13] truncate">{row.company}</p>
            <p className="text-[11px] text-[#9A8F7E] tabular-nums flex items-center gap-1.5">
              <span dir="ltr">{row.quoteNo}</span>{row.offline && <OfflineBadge />}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={download} disabled={busy}
              className="inline-flex items-center gap-1.5 bg-[#E15A30] text-white text-[13px] font-bold px-3 py-2 rounded-xl disabled:opacity-60 hover:bg-[#C94E28]">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} PDF
            </button>
            <button onClick={confirmRemove} disabled={remove.isPending}
              className="p-2 rounded-xl text-[#C0392B] hover:bg-red-50 disabled:opacity-50" title="حذف العرض" aria-label="حذف العرض">
              <Trash2 size={16} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl text-gray-500" aria-label="إغلاق"><X size={18} /></button>
          </div>
        </div>

        <div className="overflow-y-auto p-3 sm:p-5" style={{ scrollbarGutter: 'stable' }}>
          <div ref={boxRef} className="w-full">
            <div dir="ltr" className="mx-auto shadow-md overflow-hidden bg-white" style={{ width: 794 * scale, height: docH * scale }}>
              <div style={{ width: 794, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                <QuoteDocument {...props} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* نسخة الطباعة بمقاسها الحقيقي — خارج الشاشة */}
      <div style={{ position: 'fixed', left: -10000, top: 0 }} aria-hidden>
        <QuoteDocument ref={printRef} {...props} />
      </div>
    </div>
  );
}
