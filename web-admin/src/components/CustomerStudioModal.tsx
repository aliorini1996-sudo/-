import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Camera, ImagePlus, ChevronLeft, ChevronRight, Download, Trash2, FileImage, MapPin, Receipt, Archive, Clock, Search,
  ArrowDownUp, UserRound, ArrowLeftRight, Images, ListOrdered, MessageSquareText,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { customerApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { activeLocale, formatDateTime, formatTime } from '../utils/format';
import { compressImage } from '../rep/imageCompress';
import { backdropClose } from '../lib/backdropClose';
import { CustomerDocKind, DOC_COMPRESS, docKindLabel, docKindsFor } from '../lib/customerDocs';
import { useAuthStore } from '../store/authStore';
import { formatCustomerNumber } from '../lib/customerNumber';
import { buildEntries, filterEntries, handoversOf, lastOf, repsOf, sortEntries, type ArchiveEntry, type ArchiveItem, type ArchiveVisit } from '../lib/customerArchive';

/**
 * «أرشيف العميل» (كان «استديو العميل» — طلب المالك ١٣ نوفمبر ٢٠٢٦، وصار أرشيفاً ٢١ نوفمبر): كل ما سُجّل للعميل في مكانٍ واحد
 * بتسلسله الزمني — زياراته الميدانية بملاحظاتها كاملةً وصورها ومندوبها ومدّتها، ووثائقه، ومرفقات سندات قبضه — وفي أعلاه
 * «أين توقّفنا» (آخر زيارة ومن خدم العميل)، وعلامةٌ عند كل تغيّرٍ للمندوب: فموظفٌ تسلّم العميل يعرف من أين توقّف سابقه.
 * وتبويب «الصور والوثائق» شبكة الصور كما كانت، مع رفع وثائق جديدة وحذفها. القائمة تصل بلا الصور، وكل صورة تُطلب حين تظهر.
 * القيود (النطاق، صلاحية السندات) في الخادم: routes/customerStudio.ts.
 */

type Source = ArchiveItem['source'];
type StudioItem = ArchiveItem;
interface StudioData {
  customer: { id: string; name: string; businessName: string | null };
  items: StudioItem[];
  visits?: ArchiveVisit[];
  receiptsHidden: boolean;
  truncated: { visit: boolean; receipt: boolean; visits?: boolean };
  limits: { perRequest: number; perCustomer: number; docCount: number };
}

type ApiErr = { response?: { status?: number; data?: { message?: string; code?: string } } };

/** صفحة الشبكة: تُعرض الصور دفعةً دفعة — كل دفعة طلباتٌ قليلة، فلا يستنفد تصفّح عميلٍ كثير الصور حدّ الطلبات ولا ذاكرة المتصفح */
const PAGE = 40;
/** صفحة السجلّ الزمني */
const TL_PAGE = 30;
/** مصغّرات البند الواحد في السجلّ — والباقي «+ن» يفتح العارض: زيارةٌ بثماني صور لا تُطلق ثمانية طلبات لكل بطاقة */
const CARD_THUMBS = 4;

/** حاوية التمرير — جذر IntersectionObserver فيعمل هامش التحميل المسبق داخلها لا داخل نافذة المتصفح وحدها */
const ScrollRootCtx = createContext<Element | null>(null);

/** صورةٌ يجوز عرضها رابطاً: data URL صورة وحده (صور الزيارات والسندات القديمة نصٌّ لم يُفحص عند حفظه) */
const safeImage = (s: unknown): string | null => (typeof s === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(s) ? s : null);

/** يظهر العنصر في الشاشة؟ — لتُطلب صورته عندها لا قبلها (قد تكون مئات) */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const root = useContext(ScrollRootCtx);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { root, rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, root]);
  return [ref, seen] as const;
}

/** الصورة نفسها (data URL) — لا تتغيّر بعد رفعها، فتُحفظ ما بقيت النافذة */
function useStudioImage(customerId: string, item: StudioItem | null, enabled: boolean) {
  return useQuery({
    queryKey: ['customer-studio-img', customerId, item?.source, item?.id],
    queryFn: async () => {
      const data = safeImage((await customerApi.studioItem(customerId, item!.source, item!.id)).data?.data?.data);
      if (!data) throw new Error('not-an-image');
      return data;
    },
    enabled: enabled && !!item,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  });
}

function itemTitle(it: StudioItem, tr: (s: string) => string, taxOff: boolean): string {
  if (it.source === 'doc') return tr(docKindLabel(it.kind, taxOff));
  if (it.source === 'visit') return tr('صورة زيارة');
  return `${tr('مرفق سند قبض')} ${it.number ?? ''}`.trim();
}

const SOURCE_ICON = { doc: FileImage, visit: MapPin, receipt: Receipt } as const;

/** مدّة الزيارة كما في خريطة التتبّع: س:دد:ثث أو دد:ثث */
function fmtDur(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** يوم اللحظة على جهاز القارئ — مفتاح تجميع السجلّ */
const dayKey = (at: string) => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayHeader(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat(activeLocale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}
/** «قبل ٣ أيام» بلغة الواجهة */
function sinceText(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  try { return new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' }).format(-days, 'day'); } catch { return ''; }
}

function Thumb({ customerId, item, onOpen, taxOff, small = false }: { customerId: string; item: StudioItem; onOpen: () => void; taxOff: boolean; small?: boolean }) {
  const tr = useTr();
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const img = useStudioImage(customerId, item, seen);
  const Icon = SOURCE_ICON[item.source];
  if (small) {
    return (
      <button ref={ref} type="button" onClick={onOpen} title={itemTitle(item, tr, taxOff)}
        className="relative w-20 h-20 rounded-lg overflow-hidden border border-[#E9E1D3] bg-[#FBF7EF] hover:border-[#E15A30]/60 hover:shadow transition flex-shrink-0">
        {img.data ? <img src={img.data} alt={itemTitle(item, tr, taxOff)} className="w-full h-full object-cover" loading="lazy" />
          : img.isError ? <span className="text-[9px] text-red-400 p-1 block">{tr('تعذر تحميل الصورة')}</span>
          : <span className="block w-full h-full animate-pulse bg-[#F1EBDF]" />}
      </button>
    );
  }
  return (
    <button ref={ref} type="button" onClick={onOpen}
      className="group text-right rounded-xl border border-[#E9E1D3] bg-white overflow-hidden hover:shadow-md hover:border-[#E15A30]/40 transition">
      <div className="relative aspect-square bg-[#FBF7EF]">
        {img.data ? <img src={img.data} alt={itemTitle(item, tr, taxOff)} className="w-full h-full object-cover" loading="lazy" />
          : img.isError ? <div className="w-full h-full flex items-center justify-center text-[11px] text-red-400">{tr('تعذر تحميل الصورة')}</div>
          : <div className="w-full h-full animate-pulse bg-[#F1EBDF]" />}
        <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-white/90 flex items-center justify-center text-[#8A6D1F] shadow-sm">
          <Icon size={13} />
        </span>
        {item.cancelled && <span className="absolute bottom-1.5 right-1.5 text-[10px] font-bold bg-red-600 text-white rounded px-1.5">{tr('ملغى')}</span>}
      </div>
      <div className="px-2 py-1.5">
        <p className="text-xs font-semibold text-[#1F1A13] truncate">{itemTitle(item, tr, taxOff)}</p>
        <p className="text-[10px] text-[#6E6557] truncate" dir="auto">{item.by ? `${item.by} · ` : ''}<span dir="ltr">{formatDateTime(item.at)}</span></p>
      </div>
    </button>
  );
}

function Viewer({ customerId, items, index, onIndex, onClose, onDelete, deleting, canDelete, taxOff }: {
  customerId: string; items: StudioItem[]; index: number; onIndex: (i: number) => void; onClose: () => void;
  onDelete: (it: StudioItem) => void; deleting: boolean; canDelete: boolean; taxOff: boolean;
}) {
  const tr = useTr();
  const it = items[index];
  // التركيز داخل العارض (زرّ الإغلاق) لا على المصغّرة التي فتحته — وإلا أعاد Enter أو المسافة فتح الصورة الأولى — ويعود إليها عند الإغلاق
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { before?.focus?.(); };
  }, []);
  const img = useStudioImage(customerId, it, true);
  // الجارتان تُحمَّلان مسبقاً — التنقّل بلا انتظار
  useStudioImage(customerId, items[index + 1] ?? null, true);
  useStudioImage(customerId, items[index - 1] ?? null, true);
  const prev = () => index > 0 && onIndex(index - 1);
  const next = () => index < items.length - 1 && onIndex(index + 1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // RTL: السهم الأيمن للسابق والأيسر للتالي
      if (e.key === 'ArrowRight') prev();
      if (e.key === 'ArrowLeft') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!it) return null;
  const fileName = `${itemTitle(it, tr, taxOff)}-${String(it.at).slice(0, 10)}.jpg`.replace(/[\\/:*?"<>|\s]+/g, '-');
  return (
    <div className="fixed inset-0 z-[60] bg-black/90 flex flex-col" dir="rtl" {...backdropClose(onClose)}>
      <div className="flex items-center justify-between gap-3 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0">
          <p className="font-bold text-sm truncate">{itemTitle(it, tr, taxOff)}{it.cancelled ? ` · ${tr('ملغى')}` : ''}</p>
          <p className="text-xs text-white/70 truncate">
            {it.by ? `${it.by} · ` : ''}<span dir="ltr">{formatDateTime(it.at)}</span> · {index + 1}/{items.length}
          </p>
          {it.note && <p className="text-xs text-white/80 mt-0.5 line-clamp-2" dir="auto">{it.note}</p>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {img.data && (
            <a href={img.data} download={fileName} className="p-2 rounded-lg hover:bg-white/10" title={tr('تنزيل الصورة')} aria-label={tr('تنزيل الصورة')}>
              <Download size={18} />
            </a>
          )}
          {it.source === 'doc' && canDelete && (
            <button onClick={() => onDelete(it)} disabled={deleting} className="p-2 rounded-lg hover:bg-red-500/30 text-red-300" title={tr('حذف الوثيقة')} aria-label={tr('حذف الوثيقة')}>
              <Trash2 size={18} />
            </button>
          )}
          <button ref={closeRef} onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label={tr('إغلاق')}><X size={20} /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center gap-2 px-2 pb-4">
        <button onClick={(e) => { e.stopPropagation(); prev(); }} disabled={index === 0} aria-label={tr('السابق')}
          className="p-2 rounded-full bg-white/10 text-white disabled:opacity-20 hover:bg-white/20"><ChevronRight size={22} /></button>
        <div className="flex-1 h-full min-w-0 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          {img.data ? <img src={img.data} alt={itemTitle(it, tr, taxOff)} className="max-w-full max-h-full object-contain rounded-lg" />
            : img.isError ? <p className="text-red-300 text-sm">{tr('تعذر تحميل الصورة')}</p>
            : <span className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
        </div>
        <button onClick={(e) => { e.stopPropagation(); next(); }} disabled={index >= items.length - 1} aria-label={tr('التالي')}
          className="p-2 rounded-full bg-white/10 text-white disabled:opacity-20 hover:bg-white/20"><ChevronLeft size={22} /></button>
      </div>
    </div>
  );
}

// ═══ السجلّ الزمني ═══

function Timeline({ data, customerId, taxOff, onOpenPhotos }: {
  data: StudioData; customerId: string; taxOff: boolean; onOpenPhotos: (items: StudioItem[], index: number) => void;
}) {
  const tr = useTr();
  const [repFilter, setRepFilter] = useState('');
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [limit, setLimit] = useState(TL_PAGE);
  const visits = data.visits ?? [];
  const reps = useMemo(() => repsOf(visits), [visits]);
  const handovers = useMemo(() => handoversOf(visits), [visits]);
  const all = useMemo(() => buildEntries(data), [data]);
  useEffect(() => { setLimit(TL_PAGE); }, [repFilter, q, order]);

  const shown = useMemo(() => sortEntries(filterEntries(all, {
    repId: repFilter, q,
    labelOf: (e) => (e.type === 'doc' ? tr(docKindLabel(e.item.kind, taxOff)) : ''),
  }), order), [all, repFilter, q, order, tr, taxOff]);

  const { last, lastNoted } = useMemo(() => lastOf(visits), [visits]);

  const rows: ReactElement[] = [];
  let prevDay = '';
  for (const e of shown.slice(0, limit)) {
    const dk = dayKey(e.at);
    if (dk !== prevDay) {
      rows.push(
        <div key={`h-${e.key}`} className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-[#FFFDF9]/95 backdrop-blur">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#1F1A13] bg-[#F4EEE3] rounded-full px-3 py-1">{dayHeader(e.at)}</span>
        </div>,
      );
      prevDay = dk;
    }
    const handFrom = e.type === 'visit' && !repFilter ? handovers.get(e.v.id) : undefined;
    const hand = handFrom !== undefined && e.type === 'visit' ? (
      <div key={`ho-${e.key}`} className="flex items-center gap-2 my-1 text-[11px] font-semibold text-[#B4471F]">
        <span className="flex-1 h-px bg-[#E15A30]/30" />
        <span className="inline-flex items-center gap-1.5 bg-[#FBEBE2] rounded-full px-3 py-1">
          <ArrowLeftRight size={12} className="flex-shrink-0" />
          {/* dir="auto" يُحسب من نصّ القالب لا من الاسمين (المعزولين بـbdi): «X took over from Y» تبقى بترتيبها في الإنجليزية */}
          <span dir="auto">
            {tr('تسلم {to} العميل بعد {from}').split(/(\{to\}|\{from\})/).map((part, i) =>
              part === '{to}' ? <bdi key={i}>{e.v.rep ?? '—'}</bdi> : part === '{from}' ? <bdi key={i}>{handFrom}</bdi> : part)}
          </span>
        </span>
        <span className="flex-1 h-px bg-[#E15A30]/30" />
      </div>
    ) : null;
    if (hand && order === 'asc') rows.push(hand);
    rows.push(<TimelineCard key={e.key} e={e} customerId={customerId} taxOff={taxOff} onOpenPhotos={onOpenPhotos} />);
    if (hand && order === 'desc') rows.push(hand);
  }

  return (
    <div className="space-y-4">
      {/* أين توقّفنا */}
      <div className="rounded-2xl border border-[#E9E1D3] bg-white p-4">
        <div className="flex items-center gap-2 mb-3">
          <ListOrdered size={16} className="text-[#E15A30]" />
          <h3 className="text-sm font-bold text-[#1F1A13]">{tr('أين توقفنا مع العميل')}</h3>
        </div>
        {last ? (
          <div className="grid gap-3 sm:grid-cols-[1.3fr_1fr]">
            <div className="rounded-xl bg-[#FBF7EF] p-3 min-w-0">
              <p className="text-[11px] text-[#6E6557]">{tr('آخر زيارة')}</p>
              <p className="text-sm font-bold text-[#1F1A13] mt-0.5" dir="auto">
                {last.rep ?? '—'} · <span dir="ltr">{formatDateTime(last.at)}</span>
                <span className="text-[11px] font-semibold text-[#E15A30] ms-2">{sinceText(last.at)}</span>
              </p>
              {lastNoted ? (
                <div className="mt-2">
                  <p className="text-[11px] text-[#6E6557]">
                    {tr('آخر ملاحظة')}{lastNoted.id !== last.id ? <> · {lastNoted.rep ?? '—'} · <span dir="ltr">{formatDateTime(lastNoted.at)}</span></> : null}
                  </p>
                  <p className="text-sm text-[#1F1A13] whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-4 mt-0.5" dir="auto">{lastNoted.note}</p>
                </div>
              ) : <p className="text-xs text-[#6E6557] mt-2">{tr('لا توجد ملاحظات مكتوبة في الزيارات بعد')}</p>}
            </div>
            <div className="rounded-xl bg-[#FBF7EF] p-3 min-w-0">
              <p className="text-[11px] text-[#6E6557] mb-1.5">{tr('من خدم العميل')} · {visits.length} {tr('زيارة')}</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {reps.map((r) => (
                  <button key={r.repId} type="button" onClick={() => setRepFilter((f) => (f === r.repId ? '' : r.repId))}
                    className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-right border transition ${repFilter === r.repId ? 'border-[#E15A30] bg-white' : 'border-transparent hover:bg-white'}`}>
                    <span className="flex items-center gap-1.5 min-w-0">
                      <UserRound size={13} className="text-[#8A6D1F] flex-shrink-0" />
                      <span className="text-xs font-semibold text-[#1F1A13] truncate" dir="auto">{r.rep}</span>
                    </span>
                    <span className="text-[10px] text-[#6E6557] flex-shrink-0">
                      {r.count} {tr('زيارة')} · <span dir="ltr">{formatDateTime(r.last)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : <p className="text-xs text-[#6E6557]">{tr('لم تسجل زيارات لهذا العميل بعد')}</p>}
      </div>

      {/* الفرز والبحث */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6E6557]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('ابحث في الملاحظات')}
            className="w-full text-sm border border-[#E9E1D3] rounded-lg pr-9 pl-3 py-2 bg-white outline-none focus:border-[#E15A30]" />
        </div>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} aria-label={tr('المندوب')}
          className="text-sm border border-[#E9E1D3] rounded-lg px-2 py-2 bg-white outline-none focus:border-[#E15A30]">
          <option value="">{tr('كل المناديب')}</option>
          {reps.map((r) => <option key={r.repId} value={r.repId}>{r.rep}</option>)}
        </select>
        <button type="button" onClick={() => setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))}
          className="flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] hover:border-[#E15A30]">
          <ArrowDownUp size={14} /> {order === 'desc' ? tr('الأحدث أولا') : tr('الأقدم أولا')}
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="text-center py-12 text-[#6E6557]">
          <Archive size={40} className="mx-auto text-[#E9E1D3] mb-3" />
          <p className="font-semibold">{all.length === 0 ? tr('لا يوجد شيء في أرشيف هذا العميل بعد') : tr('لا نتائج مطابقة')}</p>
        </div>
      ) : (
        <div className="relative pr-5 border-r-2 border-[#F1EBDF] space-y-2.5">{rows}</div>
      )}
      {shown.length > limit && (
        <div className="text-center">
          <button onClick={() => setLimit((n) => n + TL_PAGE)}
            className="text-sm font-semibold rounded-lg px-4 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] hover:border-[#E15A30]">
            {tr('عرض المزيد')} ({shown.length - limit})
          </button>
        </div>
      )}
      {data.truncated.visits && <p className="text-center text-[11px] text-[#6E6557]">{tr('يعرض الأرشيف أحدث 500 زيارة')}</p>}
      {data.truncated.receipt && <p className="text-center text-[11px] text-[#6E6557]">{tr('تعرض أحدث 300 صورة من الزيارات والسندات')}</p>}
    </div>
  );
}

/** مصغّرات بندٍ في السجلّ بسقف CARD_THUMBS — والباقي زرّ «+ن» */
function CardThumbs({ photos, customerId, taxOff, onOpenPhotos }: {
  photos: StudioItem[]; customerId: string; taxOff: boolean; onOpenPhotos: (items: StudioItem[], index: number) => void;
}) {
  const more = photos.length - CARD_THUMBS;
  return (
    <>
      {photos.slice(0, CARD_THUMBS).map((p, i) => <Thumb key={p.id} small customerId={customerId} item={p} taxOff={taxOff} onOpen={() => onOpenPhotos(photos, i)} />)}
      {more > 0 && (
        <button type="button" onClick={() => onOpenPhotos(photos, CARD_THUMBS)}
          className="w-20 h-20 rounded-lg border border-dashed border-[#D9CDB8] bg-[#FBF7EF] text-sm font-bold text-[#6E6557] hover:border-[#E15A30] hover:text-[#E15A30] flex-shrink-0">
          +{more}
        </button>
      )}
    </>
  );
}

function TimelineCard({ e, customerId, taxOff, onOpenPhotos }: {
  e: ArchiveEntry; customerId: string; taxOff: boolean; onOpenPhotos: (items: StudioItem[], index: number) => void;
}) {
  const tr = useTr();
  const dot = 'absolute -right-[27px] top-4 w-3.5 h-3.5 rounded-full border-2 border-white shadow';
  if (e.type === 'visit') {
    const v = e.v;
    const dur = fmtDur(v.durationSec);
    return (
      <div className="relative rounded-xl border border-[#E9E1D3] bg-white p-3.5">
        <span className={`${dot} bg-[#E15A30]`} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[#1F1A13]" dir="auto">
            <MapPin size={14} className="text-[#E15A30]" /> {tr('زيارة')} · {v.rep ?? '—'}
          </p>
          <p className="flex items-center gap-2 text-[11px] text-[#6E6557]">
            {dur && <span className="inline-flex items-center gap-1 rounded-full bg-[#EAF4EE] text-[#1E7A52] font-semibold px-2 py-0.5"><Clock size={11} /> {tr('مدة الزيارة')} <span dir="ltr">{dur}</span></span>}
            <span dir="ltr">{formatTime(v.at)}</span>
          </p>
        </div>
        {v.note ? (
          <p className="mt-2 text-sm text-[#1F1A13] whitespace-pre-wrap leading-relaxed flex gap-1.5" dir="auto">
            <MessageSquareText size={14} className="text-[#8A6D1F] mt-1 flex-shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{v.note}</span>
          </p>
        ) : <p className="mt-2 text-xs text-[#A39A8B]">{tr('بلا ملاحظة')}</p>}
        {e.photos.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <CardThumbs photos={e.photos} customerId={customerId} taxOff={taxOff} onOpenPhotos={onOpenPhotos} />
          </div>
        )}
        {v.lat != null && v.lng != null && (
          <a href={`https://www.google.com/maps?q=${v.lat},${v.lng}`} target="_blank" rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-[#8A6D1F] hover:text-[#E15A30]">
            <MapPin size={11} /> {tr('موقع تسجيل الزيارة')}
          </a>
        )}
      </div>
    );
  }
  if (e.type === 'doc') {
    return (
      <div className="relative rounded-xl border border-[#E9E1D3] bg-white p-3.5 flex items-center gap-3">
        <span className={`${dot} bg-[#E0A02C]`} />
        <Thumb small customerId={customerId} item={e.item} taxOff={taxOff} onOpen={() => onOpenPhotos([e.item], 0)} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[#1F1A13]"><FileImage size={14} className="text-[#E0A02C]" /> {tr('رفعت وثيقة')}: {tr(docKindLabel(e.item.kind, taxOff))}</p>
          <p className="text-[11px] text-[#6E6557] mt-0.5" dir="auto">{e.item.by ? `${e.item.by} · ` : ''}<span dir="ltr">{formatTime(e.at)}</span></p>
        </div>
      </div>
    );
  }
  return (
    <div className="relative rounded-xl border border-[#E9E1D3] bg-white p-3.5">
      <span className={`${dot} bg-[#1E7A52]`} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold text-[#1F1A13]" dir="auto">
          <Receipt size={14} className="text-[#1E7A52]" /> {tr('مرفق سند قبض')} {e.number ?? ''}{e.by ? ` · ${e.by}` : ''}
          {e.cancelled && <span className="text-[10px] font-bold bg-red-600 text-white rounded px-1.5">{tr('ملغى')}</span>}
        </p>
        <span className="text-[11px] text-[#6E6557]" dir="ltr">{formatTime(e.at)}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <CardThumbs photos={e.photos} customerId={customerId} taxOff={taxOff} onOpenPhotos={onOpenPhotos} />
      </div>
    </div>
  );
}

export default function CustomerStudioModal({ customer, onClose, taxOff = false }: {
  /** number: «رقم العميل» التسلسليّ (٢٣ نوفمبر ٢٠٢٦) يُعرض في الرأس متى رُقِّم */
  customer: { id: string; name: string; number?: number | null };
  onClose: () => void;
  /** «إزالة الضريبة»: لا نوع «الشهادة الضريبية» في الرفع */
  taxOff?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const canDelete = useAuthStore((s) => s.user?.canDelete) !== false;
  // رسالة الخادم بالعربية تُترجم إن كانت في القاموس — والسقف (الرقم داخل نصّه) بعبارةٍ ثابتة
  const errMsg = (e: unknown, fallback: string) => {
    const r = (e as ApiErr)?.response;
    if (r?.data?.code === 'CUSTOMER_DOCS_LIMIT') return tr('بلغ العميل الحد الأقصى للوثائق');
    return r?.data?.message ? tr(r.data.message) : fallback;
  };
  const [view, setView] = useState<'timeline' | 'gallery'>('timeline');
  const [tab, setTab] = useState<'all' | Source>('all');
  const [limit, setLimit] = useState(PAGE);
  // العارض يتبع الصورة بمفتاحها لا بموضعها: تحديثٌ في الخلفية يُدخل صورةً أحدث فلا ينتقل العارض إلى غيرها
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  // عارض صور بندٍ في السجلّ (صور زيارةٍ واحدة أو سندٍ واحد أو وثيقة)
  const [tlViewer, setTlViewer] = useState<{ items: StudioItem[]; index: number } | null>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [kind, setKind] = useState<CustomerDocKind>('OTHER');
  const [preparing, setPreparing] = useState(false);
  const kinds = docKindsFor(taxOff);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-studio', customer.id],
    queryFn: async () => (await customerApi.studio(customer.id)).data.data as StudioData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['customer-studio', customer.id] });

  const counts = useMemo(() => {
    const c = { all: 0, doc: 0, visit: 0, receipt: 0 };
    for (const it of data?.items ?? []) { c.all++; c[it.source]++; }
    return c;
  }, [data]);
  const shown = useMemo(() => (data?.items ?? []).filter((it) => tab === 'all' || it.source === tab), [data, tab]);
  const keyOf = (it: StudioItem) => `${it.source}-${it.id}`;
  const viewerIndex = viewerKey ? shown.findIndex((it) => keyOf(it) === viewerKey) : -1;
  useEffect(() => { setLimit(PAGE); }, [tab]);

  const upload = useMutation({
    mutationFn: (docs: { kind: string; data: string }[]) => customerApi.addDocuments(customer.id, docs),
    onSuccess: (res) => {
      const warned = (res.data?.warnings ?? []).length > 0;
      toast.success(tr('تم رفع الوثائق'));
      if (warned) toast.error(tr('لم تحفظ بعض الصور لأنها ليست صورا صالحة'));
      setTab((t) => (t === 'all' || t === 'doc' ? t : 'doc'));
      refresh();
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر رفع الوثائق'))),
  });
  const remove = useMutation({
    mutationFn: (docId: string) => customerApi.removeDocument(customer.id, docId),
    onSuccess: () => { toast.success(tr('تم حذف الوثيقة')); setViewerKey(null); setTlViewer(null); refresh(); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر حذف الوثيقة'))),
  });

  const room = data ? Math.max(0, Math.min(data.limits.perRequest, data.limits.perCustomer - data.limits.docCount)) : 0;
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0 || !data) return;
    if (room === 0) { toast.error(tr('بلغ العميل الحد الأقصى للوثائق')); return; }
    if (files.length > room) toast(tr('يرفع في المرة الواحدة {n} صور على الأكثر').replace('{n}', String(room)));
    setPreparing(true);
    const docs: { kind: string; data: string }[] = [];
    for (const f of files.slice(0, room)) {
      try { docs.push({ kind, data: await compressImage(f, DOC_COMPRESS) }); } catch { /* ملفٌ تالف لا يُسقط الباقي */ }
    }
    setPreparing(false);
    if (docs.length === 0) { toast.error(tr('تعذرت قراءة الصور المختارة')); return; }
    upload.mutate(docs);
  };
  const busy = preparing || upload.isPending;

  const onDelete = (it: StudioItem) => {
    if (window.confirm(tr('حذف هذه الوثيقة نهائيا؟ لا يمكن التراجع'))) remove.mutate(it.id);
  };

  const TABS: { id: 'all' | Source; label: string; hidden?: boolean }[] = [
    { id: 'all', label: 'الكل' },
    { id: 'doc', label: 'الوثائق' },
    { id: 'visit', label: 'صور الزيارات' },
    { id: 'receipt', label: 'مرفقات السندات', hidden: data?.receiptsHidden },
  ];
  const VIEWS = [
    { id: 'timeline' as const, label: 'السجل الزمني', icon: ListOrdered, n: data ? (data.visits?.length ?? 0) : null },
    { id: 'gallery' as const, label: 'الصور والوثائق', icon: Images, n: data ? counts.all : null },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3 sm:p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-[#FFFDF9] rounded-2xl shadow-2xl w-full max-w-5xl h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* الرأس */}
        <div className="flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-[#E9E1D3] bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 bg-[#FBEBE2] rounded-xl flex items-center justify-center flex-shrink-0">
              <Archive size={22} className="text-[#E15A30]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('أرشيف العميل')}</h2>
              <p className="text-sm text-[#6E6557] truncate">
                {customer.name}
                {customer.number != null && (
                  <span className="mr-2 text-xs text-[#9A8F7E] whitespace-nowrap">
                    {tr('رقم العميل')} <span dir="ltr" className="tabular-nums">{formatCustomerNumber(customer.number)}</span>
                  </span>
                )}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        {/* العرض: السجلّ الزمني أو الصور — والرفع */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-[#F1EBDF] bg-white">
          <div className="flex rounded-xl bg-[#F4EEE3] p-1">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)}
                className={`flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 transition ${view === v.id ? 'bg-white text-[#1F1A13] shadow-sm' : 'text-[#6E6557] hover:text-[#1F1A13]'}`}>
                <v.icon size={14} /> {tr(v.label)}{v.n != null && <span className="opacity-60">({v.n})</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select value={kind} onChange={(e) => setKind(e.target.value as CustomerDocKind)} aria-label={tr('نوع الوثيقة')}
              className="text-xs border border-[#E9E1D3] rounded-lg px-2 py-2 bg-white outline-none focus:border-[#E15A30]">
              {kinds.map((k) => <option key={k.code} value={k.code}>{tr(k.label)}</option>)}
            </select>
            <label className={`flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] cursor-pointer hover:border-[#E15A30] ${busy || !data ? 'opacity-50 pointer-events-none' : ''}`}>
              <Camera size={15} /> {tr('تصوير')}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
            </label>
            <label className={`flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 bg-[#E15A30] text-white cursor-pointer hover:bg-[#C94C25] ${busy || !data ? 'opacity-50 pointer-events-none' : ''}`}>
              {busy ? <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <ImagePlus size={15} />}
              {busy ? tr('جاري الرفع') : tr('رفع وثائق')}
              <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
            </label>
          </div>
        </div>

        {view === 'gallery' && data && (
          <div className="flex flex-wrap gap-1.5 px-4 sm:px-5 pt-3">
            {TABS.filter((t) => !t.hidden).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`text-xs font-semibold rounded-full px-3 py-1.5 border transition ${tab === t.id ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:border-[#1F1A13]/40'}`}>
                {tr(t.label)} <span className="opacity-70">({counts[t.id]})</span>
              </button>
            ))}
          </div>
        )}

        {/* المحتوى */}
        <div ref={setScrollRoot} className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-[#F1EBDF] animate-pulse" />)}
            </div>
          ) : isError || !data ? (
            <p className="text-center text-red-500 py-16">{tr('تعذر تحميل أرشيف العميل')}</p>
          ) : (
            <ScrollRootCtx.Provider value={scrollRoot}>
              {view === 'timeline' ? (
                <Timeline data={data} customerId={customer.id} taxOff={taxOff} onOpenPhotos={(items, index) => setTlViewer({ items, index })} />
              ) : shown.length === 0 ? (
                <div className="text-center py-16 text-[#6E6557]">
                  <Images size={40} className="mx-auto text-[#E9E1D3] mb-3" />
                  <p className="font-semibold">{tab === 'all' ? tr('لا توجد صور أو وثائق لهذا العميل بعد') : tr('لا توجد صور في هذا القسم')}</p>
                  <p className="text-xs mt-1">{tr('ارفع السجل التجاري أو الهوية أو صورة المحل من زر رفع وثائق')}</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
                    {shown.slice(0, limit).map((it) => (
                      <Thumb key={keyOf(it)} customerId={customer.id} item={it} taxOff={taxOff} onOpen={() => setViewerKey(keyOf(it))} />
                    ))}
                  </div>
                  {shown.length > limit && (
                    <div className="text-center mt-4">
                      <button onClick={() => setLimit((n) => n + PAGE)}
                        className="text-sm font-semibold rounded-lg px-4 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] hover:border-[#E15A30]">
                        {tr('عرض المزيد')} ({shown.length - limit})
                      </button>
                    </div>
                  )}
                  {(data.truncated.visit || data.truncated.receipt) && (
                    <p className="text-center text-[11px] text-[#6E6557] mt-4">{tr('تعرض أحدث 300 صورة من الزيارات والسندات')}</p>
                  )}
                </>
              )}
            </ScrollRootCtx.Provider>
          )}
        </div>
      </div>

      {viewerIndex >= 0 && data && (
        <Viewer customerId={customer.id} items={shown} index={viewerIndex} onIndex={(i) => setViewerKey(shown[i] ? keyOf(shown[i]) : null)}
          onClose={() => setViewerKey(null)} onDelete={onDelete} deleting={remove.isPending} canDelete={canDelete} taxOff={taxOff} />
      )}
      {tlViewer && (
        <Viewer customerId={customer.id} items={tlViewer.items} index={tlViewer.index} onIndex={(i) => setTlViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setTlViewer(null)} onDelete={onDelete} deleting={remove.isPending} canDelete={canDelete} taxOff={taxOff} />
      )}
    </div>
  );
}
