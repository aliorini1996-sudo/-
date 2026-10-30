import { useState, useEffect, useRef, useCallback } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, Layers, Truck, Users, History, AlertTriangle, RotateCcw, Phone, Download, Lock, ChevronLeft, Loader2, MapPin,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { lotsApi, vanStockApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useBackClose } from '../lib/useBackClose';
import { activeLocale, formatDate, formatDateTime, formatDayOnly, formatNumber } from '../utils/format';
import { shareOrDownloadExcel } from '../utils/excel';
import { localDay } from '../lib/paymentMethods';
import {
  LOT_CERTAINTY_LABELS, LOT_EPS, LOT_ROW_FLAG_LABELS, LOT_SOURCE_LABELS, LOT_WARNING_LABELS,
  lotDay, lotErrorOf, lotWarningsOf, roundLot,
  type LotCertainty, type LotTraceDto, type LotUnloadPlanDto, type ProductLotDto,
} from '../lib/lots';
import {
  autoBroad, eventKindLabel, expiryState, lotStatusLabel, lotUnloadOn, originKindLabel, placeName, statusActions, traceSheets, traceTotals, unloadBody, vanName,
  type LotDetailDto, type LotListRow, type LotStatusAction,
} from '../lib/lotsPage';
import { MCard, MRow, MHeader, MStat, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import {
  lotListParams, nextLotsLimit, statusReasonProblem, scopedLotUser, unloadPlanRows, unloadPlanTotals, unloadPlanHasRemovals, customerLotTotals, telHref,
  LOT_CACHE_KEYS, STOCK_CACHE_KEYS, LOT_REASON_MAX, M_LOTS_PAGE, M_LOTS_MAX, M_LOTS_SOON_DAYS, type MLotsFilter,
} from './mLotsLogic';

/**
 * «التشغيلات» في تطبيق الإدارة على الجوال (§٦.٢، والتدفّقات §٤.١٦–٤.١٧) — قسمٌ من الرئيسية لا تبويب (المقاعد خمسة وقد
 * امتلأت)، تفتحه القوقعة بحارس موجّه /api/lots نفسه: صلاحية مخزون السيارات، ثم النظام المحاسبي، ثم علم الشركة.
 *
 *  - **البحث** برقم التشغيلة أو اسم الصنف، والحالة، والقريب من الانتهاء — على الخادم، بدفعاتٍ تكبر بالتمرير حتى سقفه.
 *  - **البطاقة**: التواريخ والمصدر والأرصدة (المستودع والسيارات والمحجوز)، والإيقاف الاحترازي والسحب وإعادة التنشيط بسببٍ
 *    إلزامي (D27) لغير المقيّد بنطاق، ثم خطة التنزيل من كل سيارة (والمحذوفة بـdeletedSalesRepId، D30).
 *  - **التتبّع**: العملاء بفواتيرهم وكمّياتهم ويقينهم ووسومهم، ورابط اتصالٍ بكلٍّ منهم (السحب يبدأ بالهاتف)؛ والنطاق الموسّع
 *    تلقائيٌّ في السحب. ثم الأماكن ومصدر التشغيلة وسجلّها، وتصديرٌ إلى Excel بأوراق اللوحة نفسها (traceSheets).
 *  - ما لا يلزم الميدان يبقى في اللوحة: إنشاء البطاقة، وتعديل التواريخ، والتسمية وإعادة التصنيف، وسلامة الأرصدة.
 * المنطق الصرف في lib/lotsPage.ts (مشتركٌ مع اللوحة) وm/mLotsLogic.ts، والخادم صاحب القرار. كل كمية بوحدة الأساس (D22).
 */

type Tr = (ar: string) => string;

/** رفضٌ صريح (٤٠٣ علم أو صلاحية، ٤٠٤ تشغيلة) لا يتغيّر بالإعادة — الإعادة لانقطاع الشبكة و٥xx وحدهما */
const retryNetOnly = (n: number, e: unknown) => {
  const status = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
  return !(status >= 400 && status < 500) && n < 2;
};

/** رسالة الخطأ: رمز اللوط برسالة الخادم، ثم رسالة الخادم العامة، ثم البديل */
const errText = (e: unknown, tr: Tr, fallback: string): string =>
  lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr(fallback);

/** كمية لوطٍ بأربع خانات على الأكثر وبأرقام الشركة — الكمية الأساسية قد تكون كسراً (وزن) */
const fmtQ = (n: number | null | undefined): string =>
  new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 4 }).format(roundLot(Number(n) || 0));

const dayText = (v: string | null | undefined): string => (lotDay(v) ? formatDayOnly(lotDay(v)) : '—');

export default function MLots({ onBack, company }: {
  onBack: () => void;
  /** إعدادات الشركة — warehouseEnabled وحده: بلا مستودع لا خانة «المستودع» (رصيدها صفرٌ بالتعريف) */
  company?: unknown;
}) {
  const warehouseOn = (company as { warehouseEnabled?: boolean } | null)?.warehouseEnabled === true;
  const [openId, setOpenId] = useState<string | null>(null);
  // البطاقة طبقةٌ فوق القائمة لا بديلٌ عنها: الرجوع يعود إلى البحث نفسه وموضع التمرير نفسه
  useBackClose(!!openId, () => setOpenId(null));
  return (
    <div className="relative h-full">
      <LotsList onBack={onBack} onOpen={setOpenId} warehouseOn={warehouseOn} />
      {openId && (
        <div className="absolute inset-0 z-10 bg-white">
          <LotCard id={openId} warehouseOn={warehouseOn} onBack={() => setOpenId(null)} />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════ لبنات العرض ═══════════════════════ */

/** شارة الحالة: الموقوفة احترازياً كهرمانية، والمسحوبة حمراء — والنشطة بلا شارة في القائمة (ضجيجٌ لا معلومة) */
function StatusChip({ lot, showActive = false }: { lot: Pick<ProductLotDto, 'status' | 'blockKind'>; showActive?: boolean }) {
  const tr = useTr();
  if (lot.status !== 'BLOCKED' && !showActive) return null;
  const cls = lot.status !== 'BLOCKED' ? 'bg-[#E4F1EA] text-[#1E7A52]'
    : lot.blockKind === 'RECALL' ? 'bg-[#FBE3DF] text-[#C0392B]' : 'bg-[#FDF6E7] text-[#8A6D1F]';
  return <span className={`flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${cls}`}>{tr(lotStatusLabel(lot))}</span>;
}

/** شارة الانتهاء: منتهية أو قريبة (≤ ٣٠ يوماً كاللوحة) — والسارية بلا شارة. يوم الانتهاء نفسه آخر يوم صالح */
function ExpiryChip({ expiryDate, day }: { expiryDate: string | null; day: string }) {
  const tr = useTr();
  const s = expiryState(expiryDate, day, M_LOTS_SOON_DAYS);
  if (s === 'expired') return <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#FBE3DF] text-[#C0392B]">{tr('منتهية')}</span>;
  if (s === 'soon') return <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#FDF6E7] text-[#8A6D1F]">{tr('قريبة الانتهاء')}</span>;
  return null;
}

function CertaintyChip({ c }: { c: LotCertainty }) {
  const tr = useTr();
  const cls = c === 'CONFIRMED' ? 'bg-[#E4F1EA] text-[#1E7A52]' : c === 'ASSUMED' ? 'bg-[#FDF6E7] text-[#8A6D1F]' : 'bg-[#F1EBDF] text-[#6E6557]';
  return <span className={`flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${cls}`}>{tr(LOT_CERTAINTY_LABELS[c] ?? c)}</span>;
}

function ScopedBanner() {
  const tr = useTr();
  return (
    <p className="text-[11px] text-[#8A6D1F] bg-[#FDF6E7] border border-[#F0E0B8] rounded-xl px-3 py-2 flex items-center gap-1.5">
      <Lock size={12} className="flex-shrink-0" /> {tr('النتيجة مقيدة بنطاقك')}
    </p>
  );
}

function Section({ title, icon: Icon, children, action }: {
  title: string; icon?: React.ElementType; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-[11px] font-bold text-[#9A8F7E] uppercase tracking-wide flex items-center gap-1.5">
          {Icon && <Icon size={13} className="text-[#E15A30]" />} {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : 'min-w-0'}>
      <p className="text-[10px] text-[#9A8F7E]">{label}</p>
      <p className="text-[12px] font-medium text-[#1F1A13] break-words">{value}</p>
    </div>
  );
}

/** ورقة سفلية — الخلفية زرٌّ حقيقيّ لا `div` بنقرة، فتصلها لوحة المفاتيح والقارئ (نمط MProducts) */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const tr = useTr();
  return (
    <div className="absolute inset-0 z-30 flex items-end">
      <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="absolute inset-0 bg-black/40" />
      <div className="relative w-full bg-white rounded-t-2xl border-t border-[#E9E1D3] p-4 space-y-3 max-h-[85%] overflow-y-auto"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="text-sm font-bold text-[#1F1A13]">{title}</p>
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════ القائمة والبحث ═══════════════════════ */

function LotsList({ onBack, onOpen, warehouseOn }: { onBack: () => void; onOpen: (id: string) => void; warehouseOn: boolean }) {
  const tr = useTr();
  const [qInput, setQInput] = useState('');
  const [filter, setFilter] = useState<MLotsFilter>({ q: '', status: '', soon: false });
  const [limit, setLimit] = useState(M_LOTS_PAGE);
  // كل تغيّر في البحث أو التصفية يعيد الدفعة الأولى — لا يُطلب ٢٠٠ صفٍّ لأن المستخدم مرّر قبل أن يغيّر البحث
  const update = (patch: Partial<MLotsFilter>) => { setFilter(f => ({ ...f, ...patch })); setLimit(M_LOTS_PAGE); };
  // البحث بعد أن تستقرّ الكتابة — ونصٌّ لم يتغيّر بعد القصّ (مسافةٌ زائدة) لا يعيد الطلب ولا يصغّر الدفعة
  useEffect(() => {
    const q = qInput.trim();
    if (q === filter.q) return;
    const t = setTimeout(() => update({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update يكتب الحالة وحدها
  }, [qInput, filter.q]);
  // يوم الجهاز لشارة «قريبة الانتهاء» في القائمة (كاللوحة) — والبطاقة تأخذ يوم الشركة من الخادم
  const today = localDay();

  const listQ = useQuery({
    queryKey: ['m-lots', filter, limit],
    queryFn: async () => {
      const body = (await lotsApi.list(lotListParams(filter, limit))).data as {
        data?: unknown; pagination?: { total?: number }; scoped?: boolean;
      };
      return {
        rows: expectArray<LotListRow>(body?.data, tr('التشغيلات')),
        total: typeof body?.pagination?.total === 'number' ? body.pagination.total : null,
        scoped: body?.scoped === true,
      };
    },
    placeholderData: keepPreviousData,
    retry: retryNetOnly,
  });

  // تمرير قريب من القاع ⇒ دفعة أكبر (بلا زرّ «المزيد») حتى سقف الخادم
  const listRef = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching || !listQ.data) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight >= 160) return;
    const next = nextLotsLimit(limit, listQ.data.rows.length, listQ.data.total);
    if (next) setLimit(next);
  }, [listQ.isFetching, listQ.data, limit]);

  const filtered = !!filter.q || !!filter.status || filter.soon;
  const rows = listQ.data?.rows ?? [];
  const total = listQ.data?.total ?? null;
  const capped = total != null && rows.length >= M_LOTS_MAX && total > rows.length;

  const chip = (on: boolean) =>
    `flex-shrink-0 min-h-[36px] px-3 rounded-full text-[12px] font-semibold border ${on ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={tr('التشغيلات')}
        subtitle={total != null ? `${formatNumber(total)} ${tr('تشغيلة')}` : tr('أرصدة كل تشغيلة في المستودع والسيارات ومن بيعت لهم وإيقافها وسحبها')}
        onBack={onBack} />

      <div className="flex-shrink-0 p-3 pb-2 space-y-2">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={qInput} onChange={e => setQInput(e.target.value)} className="input ps-9 min-h-[44px]"
            placeholder={tr('رقم التشغيلة أو اسم الصنف')} aria-label={tr('بحث')} />
        </div>
        {/* تمريرٌ أفقي للرقائق: أربعٌ لا تتّسع لعرض ٣٦٠px بأحجام لمسٍ مريحة */}
        <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
          <button type="button" className={chip(filter.status === '')} onClick={() => update({ status: '' })}>{tr('الكل')}</button>
          <button type="button" className={chip(filter.status === 'ACTIVE')} onClick={() => update({ status: 'ACTIVE' })}>{tr('نشطة')}</button>
          <button type="button" className={chip(filter.status === 'BLOCKED')} onClick={() => update({ status: 'BLOCKED' })}>{tr('تشغيلة موقوفة')}</button>
          <button type="button" className={chip(filter.soon)} aria-pressed={filter.soon} onClick={() => update({ soon: !filter.soon })}>
            {tr('تنتهي خلال 30 يوما أو انتهت')}
          </button>
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 space-y-2">
        {listQ.data?.scoped && <ScopedBanner />}
        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} text={errText(listQ.error, tr, 'تعذر تحميل التشغيلات')} />
          : !rows.length ? (
            <MEmpty icon={Layers}
              text={filtered ? tr('لا توجد تشغيلات مطابقة')
                : warehouseOn ? tr('لا توجد تشغيلات بعد سجل وارد التشغيلة من مخزون الشركة') : tr('لا توجد تشغيلات بعد')} />
          ) : (
            <MCard>
              {rows.map(r => (
                <MRow key={r.id} onClick={() => onOpen(r.id)}
                  leading={
                    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${r.status === 'BLOCKED' ? 'bg-[#FBE3DF] text-[#C0392B]' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>
                      <Layers size={16} />
                    </span>
                  }
                  title={
                    <span className="flex items-center gap-1.5">
                      <bdi dir="ltr" className="truncate">{r.lotNumber}</bdi>
                      <StatusChip lot={r} />
                      <ExpiryChip expiryDate={r.expiryDate} day={today} />
                    </span>
                  }
                  subtitle={[r.productName, lotDay(r.expiryDate) ? `${tr('ينتهي')} ${dayText(r.expiryDate)}` : ''].filter(Boolean).join(' · ')}
                  trailing={
                    <span className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-end">
                        <span className="block text-xs font-bold text-[#1F1A13] tabular-nums">{r.summary ? fmtQ(r.summary.total) : '—'}</span>
                        <span className="block text-[9px] text-[#9A8F7E]">
                          {r.summary && r.summary.vanCount > 0 ? `${formatNumber(r.summary.vanCount)} ${tr('سيارة')}` : (r.productUnit || '')}
                        </span>
                      </span>
                      <ChevronLeft size={15} className="text-[#C9BFB0]" />
                    </span>
                  } />
              ))}
            </MCard>
          )}
        {listQ.isFetching && !listQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-2">{tr('جاري التحميل')}</p>
        )}
        {capped && !listQ.isFetching && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-2">{tr('يعرض أول 200 تشغيلة ضيق البحث')}</p>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════ البطاقة والتتبّع ═══════════════════════ */

function LotCard({ id, warehouseOn, onBack }: { id: string; warehouseOn: boolean; onBack: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const impersonating = useAuthStore(s => s.impersonating);
  // المقيّد بنطاق لا يوقف ولا يسحب (LOT_SCOPED_USER) — جلسة المالك غير مقيّدة
  const scopedUser = scopedLotUser(user, impersonating);

  const lotQ = useQuery({
    queryKey: ['m-lot', id],
    queryFn: async () => expectObject<LotDetailDto>((await lotsApi.get(id)).data?.data, tr('التشغيلة')),
    retry: retryNetOnly,
  });
  const lot = lotQ.data;
  // النطاق الموسّع تلقائيٌّ في السحب، والمستخدم يبدّله يدوياً متى شاء
  const [scopeSel, setScopeSel] = useState<'STRICT' | 'BROAD' | null>(null);
  const scope = scopeSel ?? (autoBroad(lot) ? 'BROAD' : 'STRICT');
  const traceQ = useQuery({
    queryKey: ['m-lot', id, 'trace', scope],
    enabled: !!lot,
    queryFn: async () => expectObject<LotTraceDto>((await lotsApi.trace(id, scope)).data?.data, tr('تتبع التشغيلة')),
    retry: retryNetOnly,
  });
  // الموقوفة من صنفٍ متتبَّع وحده: غير المتتبَّع ينزل من «مخزون السيارات» (lotUnloadOn)
  const unloadOn = lotUnloadOn(lot);
  const planQ = useQuery({
    queryKey: ['m-lot', id, 'unload'],
    enabled: unloadOn,
    queryFn: async () => expectArray<LotUnloadPlanDto>((await lotsApi.unloadPlan(id)).data?.data, tr('تنزيل التشغيلة من السيارات')),
    retry: retryNetOnly,
  });

  const [action, setAction] = useState<LotStatusAction | null>(null);
  const [reason, setReason] = useState('');
  const [unloadRow, setUnloadRow] = useState<LotUnloadPlanDto | null>(null);
  useBackClose(!!action, () => setAction(null));
  useBackClose(!!unloadRow, () => setUnloadRow(null));

  /** الحالة والحركة تغيّران أرصدة التشغيلات في كل شاشة (الجوال واللوحة) */
  const refreshLots = () => LOT_CACHE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  const setStatus = useMutation({
    mutationFn: async (a: LotStatusAction) => {
      if (!lot) throw new Error('no lot');
      return lotsApi.setStatus(lot.id, {
        status: a.status, ...(a.blockKind ? { blockKind: a.blockKind } : {}), reason: reason.trim(), updatedAt: lot.updatedAt,
      });
    },
    onSuccess: (_res, a) => {
      toast.success(a.status === 'BLOCKED' ? tr('تم إيقاف التشغيلة نزلها الآن من السيارات') : tr('أعيد تنشيط التشغيلة'));
      setAction(null);
      setReason('');
      setScopeSel(null);
      refreshLots();
    },
    onError: (e) => {
      // تغيّرت البطاقة منذ فُتحت (LOT_CHANGED): تُجلب نسختها الجديدة، وتبقى الورقة مفتوحة بسببها فيعيد المستخدم الضغط
      if (lotErrorOf(e)?.code === 'LOT_CHANGED') qc.invalidateQueries({ queryKey: ['m-lot', id] });
      toast.error(errText(e, tr, 'تعذر الحفظ'));
    },
  });

  const unload = useMutation({
    mutationFn: async (row: LotUnloadPlanDto) => {
      const body = lot ? unloadBody(lot, row, `${tr('تنزيل تشغيلة موقوفة')} ${lot.lotNumber}`) : null;
      if (!body) throw new Error('empty');
      return (await vanStockApi.createLoad(body)).data as { warnings?: unknown } | undefined;
    },
    onSuccess: (res) => {
      setUnloadRow(null);
      refreshLots();
      STOCK_CACHE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      [...new Set(lotWarningsOf(res?.warnings).map(w => w.code))].forEach(c => toast(tr(LOT_WARNING_LABELS[c])));
      toast.success(tr('تم تنزيل التشغيلة من السيارة'));
    },
    onError: (e) => { setUnloadRow(null); toast.error(errText(e, tr, 'تعذر الحفظ')); },
  });

  const exportExcel = async () => {
    if (!traceQ.data) return;
    try {
      const out = await shareOrDownloadExcel(traceSheets(traceQ.data, tr), `${tr('تتبع التشغيلة')}-${traceQ.data.lot.lotNumber}`);
      toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
    } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
  };

  if (lotQ.isLoading) {
    return (
      <div className="h-full flex flex-col bg-[#FAF7F0]">
        <MHeader title={tr('التشغيلة')} onBack={onBack} />
        <div className="flex-1"><MSpinner /></div>
      </div>
    );
  }
  if (lotQ.isError || !lot) {
    return (
      <div className="h-full flex flex-col bg-[#FAF7F0]">
        <MHeader title={tr('التشغيلة')} onBack={onBack} />
        <div className="flex-1"><MError onRetry={() => lotQ.refetch()} text={errText(lotQ.error, tr, 'تعذر تحميل التشغيلة')} /></div>
      </div>
    );
  }

  const trace = traceQ.data;
  const totals = trace ? traceTotals(trace) : null;
  const unit = lot.product.unit || '';
  const actions = statusActions(lot);
  const vansQty = lot.summary ? lot.summary.vans.SELLABLE + lot.summary.vans.EXPIRED + lot.summary.vans.DAMAGED : 0;
  const plan = unloadPlanRows(planQ.data);
  const planTotals = unloadPlanTotals(planQ.data);
  const reasonProblem = statusReasonProblem(reason);

  return (
    <div className="relative h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={lot.lotNumber}
        subtitle={lot.product.name}
        onBack={onBack}
        action={
          <button onClick={exportExcel} disabled={!trace} aria-label={tr('تصدير Excel')}
            className="w-11 h-11 rounded-xl border border-white/15 text-[#E8A87C] flex items-center justify-center flex-shrink-0 disabled:opacity-40">
            <Download size={18} />
          </button>
        } />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        {(lot.scoped || trace?.scoped) && <ScopedBanner />}

        {/* ─────────── البطاقة ─────────── */}
        <MCard className="p-3.5 space-y-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <bdi dir="ltr" className="text-lg font-bold text-[#1F1A13]">{lot.lotNumber}</bdi>
            <StatusChip lot={lot} showActive />
            <ExpiryChip expiryDate={lot.expiryDate} day={lot.day} />
          </div>
          <p className="text-[12px] text-[#6E6557] -mt-1.5">{lot.product.name}{lot.product.code ? ` · ${lot.product.code}` : ''}</p>
          {!lot.product.lotTracked && (
            <p className="text-[11px] text-[#8A6D1F]">{tr('تتبع هذا الصنف باللوط مطفأ والتشغيلة للسجل وحده')}</p>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Info label={tr('تاريخ الإنتاج')} value={dayText(lot.productionDate)} />
            <Info label={tr('تاريخ الانتهاء')} value={dayText(lot.expiryDate)} />
            <Info label={tr('المصدر')} value={tr(LOT_SOURCE_LABELS[lot.source] ?? lot.source)} />
            <Info label={tr('أنشئت')} value={formatDateTime(lot.createdAt)} />
            {lot.status === 'BLOCKED' && lot.blockReason && <Info label={tr('سبب إيقاف التشغيلة')} value={lot.blockReason} wide />}
            {lot.note && <Info label={tr('ملاحظة')} value={lot.note} wide />}
          </div>
        </MCard>

        {/* ─────────── الأرصدة ─────────── */}
        {lot.summary && (
          <div className="grid grid-cols-2 gap-2.5">
            {warehouseOn && <MStat label={tr('المستودع')} value={`${fmtQ(lot.summary.warehouse)} ${unit}`} compact />}
            <MStat label={lot.summary.vanCount > 0 ? `${tr('السيارات')} · ${formatNumber(lot.summary.vanCount)}` : tr('السيارات')}
              value={`${fmtQ(vansQty)} ${unit}`} compact />
            <MStat label={tr('محجوز')} value={lot.summary.held > LOT_EPS ? `${fmtQ(lot.summary.held)} ${unit}` : '—'}
              tone={lot.summary.held > LOT_EPS ? 'warn' : 'default'} compact />
            <MStat label={tr('الإجمالي')} value={`${fmtQ(lot.summary.total)} ${unit}`} compact />
          </div>
        )}

        {/* ─────────── الإيقاف والسحب وإعادة التنشيط (§٤.١٦) ─────────── */}
        <div className="space-y-1.5">
          <div className="flex gap-2">
            {actions.map(a => (
              <button key={`${a.status}-${a.blockKind ?? ''}`} type="button" disabled={scopedUser}
                onClick={() => { setReason(''); setAction(a); }}
                className={`flex-1 min-h-[48px] rounded-xl text-[13px] font-bold flex items-center justify-center gap-1.5 border disabled:opacity-50 ${
                  a.status === 'ACTIVE' ? 'bg-white text-[#1F1A13] border-[#E9E1D3]'
                    : a.danger ? 'bg-[#C0392B] text-white border-[#C0392B]' : 'bg-[#FDF6E7] text-[#8A6D1F] border-[#F0E0B8]'}`}>
                {a.status === 'ACTIVE' ? <RotateCcw size={15} /> : <AlertTriangle size={15} />} {tr(a.label)}
              </button>
            ))}
          </div>
          {scopedUser && <p className="text-[11px] text-[#9A8F7E] px-1">{tr('هذا الإجراء على التشغيلات لمستخدم غير مقيد بنطاق')}</p>}
        </div>

        {/* ─────────── خطة التنزيل بعد الإيقاف أو السحب ─────────── */}
        {unloadOn && (
          <Section title={tr('تنزيل التشغيلة من السيارات')} icon={Truck}>
            <p className="text-[11px] text-[#6E6557] px-1 leading-relaxed">
              {tr('الموقوفة لا تحمل ولا تباع نزل صالحها من كل سيارة إلى المستودع والمحجوز ينزل بعد اعتماد إشعاره')}
            </p>
            {planQ.isLoading ? <MCard><div className="py-8"><MSpinner /></div></MCard>
              : planQ.isError ? <MCard><div className="py-8"><MError onRetry={() => planQ.refetch()} text={errText(planQ.error, tr, 'تعذر التحميل')} /></div></MCard>
              : !plan.length ? <p className="text-[12px] text-[#1E7A52] px-1">{tr('لا رصيد لهذه التشغيلة في السيارات')}</p>
              : (
                <MCard>
                  {plan.map(r => (
                    <MRow key={r.salesRepId}
                      leading={<span className="w-9 h-9 rounded-lg bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center flex-shrink-0"><Truck size={16} /></span>}
                      title={<span className="flex items-center gap-1.5"><span className={`truncate ${r.deleted ? 'text-[#8A6D1F]' : ''}`}>{vanName(r, tr)}</span></span>}
                      subtitle={[
                        `${tr('الصالح للتنزيل')} ${fmtQ(r.usable.SELLABLE)} ${unit}`,
                        r.held.SELLABLE > LOT_EPS ? `${tr('محجوز')} ${fmtQ(r.held.SELLABLE)}` : '',
                        r.usable.EXPIRED > LOT_EPS ? `${tr('منتهي الصلاحية')} ${fmtQ(r.usable.EXPIRED)}` : '',
                        r.usable.DAMAGED > LOT_EPS ? `${tr('تالف')} ${fmtQ(r.usable.DAMAGED)}` : '',
                      ].filter(Boolean).join(' · ')}
                      trailing={r.usable.SELLABLE > LOT_EPS ? (
                        <button type="button" onClick={() => setUnloadRow(r)} disabled={unload.isPending}
                          className="min-h-[40px] px-3 rounded-xl bg-[#E15A30] text-white text-[12px] font-bold flex-shrink-0 disabled:opacity-60">
                          {tr('تنزيل')}
                        </button>
                      ) : undefined} />
                  ))}
                </MCard>
              )}
            {plan.length > 0 && (
              <p className="text-[11px] text-[#9A8F7E] px-1 tabular-nums">
                {tr('الصالح للتنزيل')} {fmtQ(planTotals.usable)} {unit} · {formatNumber(planTotals.vans)} {tr('سيارة')}
                {planTotals.held > LOT_EPS ? ` · ${tr('محجوز')} ${fmtQ(planTotals.held)}` : ''}
              </p>
            )}
            {/* ما لا يُنزَّل بزرّ «تنزيل»: المنتهي والتالف في السيارة يزالان من دلويهما (مخزون السيارات) — كاللوحة */}
            {unloadPlanHasRemovals(planQ.data) && (
              <p className="text-[11px] text-[#6E6557] px-1 leading-relaxed">{tr('المنتهي والتالف من التشغيلة يزالان من دلويهما في السيارة')}</p>
            )}
          </Section>
        )}

        {/* ─────────── العملاء ─────────── */}
        <Section title={tr('العملاء الذين وصلتهم التشغيلة')} icon={Users}>
          <div className="flex gap-1 bg-white border border-[#E9E1D3] rounded-xl p-1">
            {(['STRICT', 'BROAD'] as const).map(s => (
              <button key={s} type="button" onClick={() => setScopeSel(s)} aria-pressed={scope === s}
                className={`flex-1 min-h-[40px] rounded-lg text-[12px] font-semibold ${scope === s ? 'bg-[#1F1A13] text-white' : 'text-[#6E6557]'}`}>
                {s === 'STRICT' ? tr('النطاق الدقيق') : tr('النطاق الموسع')}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
            {scope === 'BROAD'
              ? tr('الموسع يضيف كل بيع للصنف من السيارة أثناء وجود التشغيلة فيها بيقين مفترض')
              : tr('الدقيق ما سجل بهذه التشغيلة في الفواتير المؤكدة')}
            {autoBroad(lot) && scopeSel === null && <> · {tr('الموسع تلقائي في السحب')}</>}
          </p>
          {traceQ.isLoading ? <MCard><div className="py-8"><MSpinner /></div></MCard>
            : traceQ.isError || !trace ? <MCard><div className="py-8"><MError onRetry={() => traceQ.refetch()} text={errText(traceQ.error, tr, 'تعذر التحميل')} /></div></MCard>
            : trace.customersHidden ? <p className="text-[12px] text-[#6E6557] px-1">{tr('قائمة العملاء تتطلب صلاحية العملاء')}</p>
            : !(trace.customers ?? []).length ? <p className="text-[12px] text-[#6E6557] px-1">{tr('لم تبع هذه التشغيلة لأي عميل')}</p>
            : (
              <>
                {totals && (
                  <div className="grid grid-cols-3 gap-2">
                    <MStat label={tr('المباع')} value={fmtQ(totals.sold)} compact />
                    <MStat label={tr('المرتجع')} value={fmtQ(totals.returned)} compact />
                    <MStat label={tr('الصافي')} value={fmtQ(totals.net)} compact />
                  </div>
                )}
                {totals && (
                  <p className="text-[11px] text-[#9A8F7E] px-1">
                    {formatNumber(totals.customers)} {tr('العملاء')} · {formatNumber(totals.invoices)} {tr('فاتورة')}
                    {totals.broad > 0 ? ` · ${tr('النطاق الموسع')} ${formatNumber(totals.broad)}` : ''} · {unit}
                  </p>
                )}
                {(trace.customers ?? []).map(c => <CustomerCard key={c.customerId} c={c} />)}
              </>
            )}
        </Section>

        {/* ─────────── الأماكن ومصدر التشغيلة ─────────── */}
        <Section title={tr('الأماكن')} icon={MapPin}>
          {!trace ? null : !trace.places.length ? (
            <p className="text-[12px] text-[#6E6557] px-1">{tr('لا حركات لهذه التشغيلة بعد')}</p>
          ) : (
            <MCard>
              {trace.places.map((p, i) => (
                <div key={`${p.place}-${p.salesRepId ?? i}`} className="px-3.5 py-3 border-b border-[#F1EBDF] last:border-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-[#1F1A13] truncate">
                      {placeName(p, tr)}
                      {p.approximate && <span className="text-[10px] font-normal text-[#8A6D1F]"> · {tr('تقريبي')}</span>}
                    </span>
                    <b className={`text-[13px] tabular-nums flex-shrink-0 ${p.raw.SELLABLE < -LOT_EPS ? 'text-[#C0392B]' : 'text-[#1F1A13]'}`}>
                      {fmtQ(p.raw.SELLABLE)} <span className="text-[10px] font-normal text-[#9A8F7E]">{unit}</span>
                    </b>
                  </div>
                  <p className="text-[10px] text-[#9A8F7E] tabular-nums leading-relaxed">
                    {[
                      `${tr('الصالح للإنقاص')} ${fmtQ(p.usable.SELLABLE)}`,
                      p.held.SELLABLE > LOT_EPS ? `${tr('محجوز')} ${fmtQ(p.held.SELLABLE)}` : '',
                      Math.abs(p.raw.EXPIRED) > LOT_EPS ? `${tr('منتهي الصلاحية')} ${fmtQ(p.raw.EXPIRED)}` : '',
                      Math.abs(p.raw.DAMAGED) > LOT_EPS ? `${tr('تالف')} ${fmtQ(p.raw.DAMAGED)}` : '',
                    ].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-[10px] text-[#9A8F7E] tabular-nums">
                    {tr('المحمل')} {fmtQ(p.loaded)} · {tr('المنزل')} {fmtQ(p.unloaded)} · {tr('المباع')} {fmtQ(p.sold)} · {tr('المرتجع')} {fmtQ(p.returned)}
                  </p>
                </div>
              ))}
            </MCard>
          )}
          {trace && trace.origin.length > 0 && (
            <MCard className="px-3.5 py-2.5 space-y-1">
              <p className="text-[11px] font-bold text-[#6E6557]">{tr('مصدر التشغيلة')}</p>
              {trace.origin.map((o, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-[#1F1A13]">
                    {originKindLabel(o.kind, tr)} · <span className="text-[#9A8F7E]">{formatDateTime(o.at)}</span>
                  </span>
                  <b className={`tabular-nums flex-shrink-0 ${o.qty < 0 ? 'text-[#C0392B]' : 'text-[#1E7A52]'}`} dir="ltr">
                    {o.qty < 0 ? '−' : '+'}{fmtQ(Math.abs(o.qty))}
                  </b>
                </div>
              ))}
            </MCard>
          )}
        </Section>

        {/* ─────────── السجل ─────────── */}
        <Section title={tr('سجل التشغيلة')} icon={History}>
          {!trace || !trace.events.length ? <p className="text-[12px] text-[#6E6557] px-1">{tr('لا أحداث')}</p> : (
            <MCard>
              {[...trace.events].reverse().map((e, i) => (
                <div key={i} className="px-3.5 py-2.5 border-b border-[#F1EBDF] last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[#1F1A13]">{eventKindLabel(e.kind, tr)}</span>
                    <span className="text-[10px] text-[#9A8F7E] flex-shrink-0">{formatDateTime(e.at)}</span>
                  </div>
                  {e.reason && <p className="text-[11px] text-[#6E6557]">{tr('السبب')}: {e.reason}</p>}
                  {e.actorName && <p className="text-[10px] text-[#9A8F7E]">{e.actorName}</p>}
                </div>
              ))}
            </MCard>
          )}
        </Section>

        <div className="h-2" />
      </div>

      {/* ورقة السبب — إلزامي في الاتجاهين (D27)، والنصّ يقول ما سيحدث قبل الضغط */}
      {action && (
        <Sheet title={`${tr(action.label)} — ${lot.lotNumber}`} onClose={() => setAction(null)}>
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            {action.status === 'ACTIVE'
              ? tr('تعود التشغيلة إلى التحميل والبيع')
              : action.blockKind === 'RECALL'
                ? tr('لا تحمل ولا تباع ولا يعاد تصنيفها وتعرض شاشة التتبع كل من وصلته بالنطاق الموسع')
                : tr('لا تحمل ولا تباع ولا يعاد تصنيفها حتى تعيد تنشيطها')}
          </p>
          <label className="block">
            <span className="label">{tr('السبب')} *</span>
            <textarea className="input min-h-[80px]" value={reason} maxLength={LOT_REASON_MAX} autoFocus
              onChange={e => setReason(e.target.value)} />
          </label>
          {reason.trim() !== '' && reasonProblem && <p className="text-[11px] text-[#C0392B]">{tr(reasonProblem)}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setStatus.mutate(action)} disabled={!!reasonProblem || setStatus.isPending}
              className={`flex-1 font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-50 text-white ${action.danger ? 'bg-[#C0392B]' : 'bg-[#E15A30]'}`}>
              {setStatus.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr(action.label)}
            </button>
            <button type="button" onClick={() => setAction(null)}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {/* تأكيد التنزيل — حركةٌ تغيّر رصيد السيارة والمستودع، فلا تُنفَّذ بنقرة واحدة */}
      {unloadOn && unloadRow && (
        <Sheet title={tr('تنزيل التشغيلة من السيارة')} onClose={() => setUnloadRow(null)}>
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            {vanName(unloadRow, tr)} — <b className="tabular-nums text-[#1F1A13]">{fmtQ(unloadRow.usable.SELLABLE)} {unit}</b>
          </p>
          {warehouseOn && <p className="text-[11px] text-[#9A8F7E]">{tr('تعود الكمية إلى المستودع وتبقى التشغيلة موقوفة هناك')}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => unload.mutate(unloadRow)} disabled={unload.isPending}
              className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
              {unload.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('تنزيل')}
            </button>
            <button type="button" onClick={() => setUnloadRow(null)}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** عميلٌ وصلته التشغيلة: هاتفه رابط اتصال، ومجاميعه وأضعف يقين، ثم فواتيره بكمّياتها ويقينها ووسومها */
function CustomerCard({ c }: { c: NonNullable<LotTraceDto['customers']>[number] }) {
  const tr = useTr();
  const t = customerLotTotals(c);
  const tel = telHref(c.phone);
  return (
    <MCard className="p-3 space-y-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-bold text-[#1F1A13] truncate">{c.name}</span>
            {t.weakest && <CertaintyChip c={t.weakest} />}
          </span>
          {(c.city || c.address) && (
            <span className="block text-[11px] text-[#9A8F7E] truncate">{[c.city, c.address].filter(Boolean).join(' · ')}</span>
          )}
          <span className="block text-[11px] text-[#6E6557] tabular-nums">
            {tr('المباع')} {fmtQ(t.sold)} · {tr('المرتجع')} {fmtQ(t.returned)} · {tr('الصافي')} <b>{fmtQ(t.net)}</b>
          </span>
        </span>
        {tel && (
          <a href={tel} aria-label={`${tr('اتصال')} ${c.name}`}
            className="w-11 h-11 rounded-xl bg-[#E4F1EA] text-[#1E7A52] flex items-center justify-center flex-shrink-0">
            <Phone size={17} />
          </a>
        )}
      </div>
      <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
        {c.invoices.map(inv => (
          <div key={inv.invoiceId} className={`px-2.5 py-2 space-y-0.5 ${inv.broad ? 'bg-[#FFFBF2]' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex items-center gap-1.5 text-[11px]">
                <bdi dir="ltr" className="font-semibold text-[#1F1A13] truncate">{inv.number}</bdi>
                <CertaintyChip c={inv.weakest} />
                {inv.broad && <span className="flex-shrink-0 text-[9px] font-bold text-[#8A6D1F]">{tr('النطاق الموسع')}</span>}
              </span>
              <span className="text-[10px] text-[#9A8F7E] flex-shrink-0">{formatDate(inv.date)}</span>
            </div>
            <p className="text-[10px] text-[#6E6557] tabular-nums">
              {tr('المباع')} {fmtQ(inv.sold)}
              {inv.returned > LOT_EPS ? ` · ${tr('المرتجع')} ${fmtQ(inv.returned)}` : ''}
              {' · '}{tr('الصافي')} {fmtQ(inv.net)}
            </p>
            {inv.flags.length > 0 && (
              <p className="text-[10px] text-[#C94E28]">{inv.flags.map(f => tr(LOT_ROW_FLAG_LABELS[f] ?? f)).join(' · ')}</p>
            )}
          </div>
        ))}
      </div>
    </MCard>
  );
}
