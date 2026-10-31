import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertTriangle, ArrowRight, Download, FileText, History, Layers, Lock, Pencil, Plus, RotateCcw, Search, ShieldAlert, Tags, Trash2,
  Truck, Users, X,
} from 'lucide-react';
import { companyApi, lotsApi, productApi, vanStockApi } from '../api/client';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { backdropClose } from '../lib/backdropClose';
import { localDay } from '../lib/paymentMethods';
import {
  LOT_BUCKET_LABELS, LOT_CERTAINTY_LABELS, LOT_EPS, LOT_NUMBER_MAX, LOT_ROW_FLAG_LABELS, LOT_SOURCE_LABELS, LOT_WARNING_LABELS,
  lotDatesProblem, lotDay, lotErrorOf, lotWarningsOf, normalizeLotNumber, roundLot,
  type LotBucket, type LotCertainty, type LotPlace, type LotTraceDto, type LotUnloadPlanDto, type ProductLotDto,
} from '../lib/lots';
import {
  autoBroad, defaultRelabelPlace, eventKindLabel, expiryState, extendsExpiry, healthByProduct, lotQtyOk, lotStatusLabel, originKindLabel, placeName,
  lotUnloadOn, relabelProblem, relabelReasonOf, relabelSources, statusActions, traceSheets, traceTotals, unloadBody, TRACE_PLACE_COLUMNS, vanName,
  baseChangedError, lotQtyDir, lotQtyText, lotQtyUnitText, lotRowProduct, lotUnitTag, lotsUnitNote, relabelBody,
  type LotBalancesResponse, type LotDeficitRow, type LotDetailDto, type LotListRow, type LotStatusAction, type LotUnitProduct,
  type PlaceViewWithAvailability, type RelabelLineForm,
} from '../lib/lotsPage';
import { primaryUnitOf } from '../lib/units';
import { activeLocale, formatDate, formatDateTime, formatDayOnly } from '../utils/format';
import { shareOrDownloadExcel } from '../utils/excel';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';
import { Header, type Company } from '../rep/RepDocuments';

/**
 * «التشغيلات» (تتبّع اللوط، المواصفة §٦.١ و§٤.١٦–٤.١٧) — ميزةٌ يفعّلها المالك لكل شركة، والصفحة بصلاحية مخزون السيارات كموجّه
 * /api/lots. البوّابات بترتيب «لوكيشن»: المحاسبة ثم عَلَم الشركة ثم الصلاحية (PermissionRoute في App.tsx) — والخادم يفرضها كلها.
 *
 * - **البحث** برقم التشغيلة أو اسم الصنف، والحالة، والقريب من الانتهاء؛ وإنشاء بطاقة.
 * - **البطاقة**: التواريخ وتعديلها (مدّ الانتهاء لتشغيلةٍ لها حركات بسببٍ ولغير المقيّد، D27)، والإيقاف الاحترازي والسحب وإعادة
 *   التنشيط بسببٍ إلزامي، ثم خطة التنزيل من كل سيارة (والمحذوفة بـdeletedSalesRepId، D30)، والتسمية وإعادة التصنيف بقيود D27.
 * - **التتبّع**: المصدر، والأماكن بالخام والصالح والمحجوز، والعملاء بفواتيرهم وكمّياتهم ويقينهم؛ النطاق الموسّع تلقائيٌّ في السحب،
 *   وExcel وPDF. والمقيّد بنطاق يرى شريط «النتيجة مقيدة بنطاقك».
 * - **سلامة الأرصدة** من /lots/health، وإجراء يوم التفعيل.
 * كل كمية بوحدة الأساس (D22) — وحدة الصنف المعروضة هي الأساس. و«الوحدة الرئيسية» عرضٌ وحده (R1): صنفٌ له رئيسية تُعرض
 * كمياته «2 كرتون و3 قارورة» (lotQtyText)، ومدخلات التسمية تبقى بالأساس باسمه لاصقاً ومعادلٍ حيّ (R8)؛ وExcel بالأساس.
 */

type Tr = (ar: string) => string;
type CompanyCfg = (Company & { lotTrackingEnabled?: boolean; warehouseEnabled?: boolean }) | null;

const PAGE_SIZE = 50;
const SOON_DAYS = 30;

// رفضٌ صريح من الخادم (٤٠٣ عَلَم، ٤٠٤ تشغيلة) لا يتغيّر بالإعادة — الإعادة لانقطاع الشبكة و٥xx وحدهما
const retryNetOnly = (n: number, e: unknown) => {
  const status = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
  return !(status >= 400 && status < 500) && n < 2;
};

/** رسالة الخطأ: رمز اللوط برسالة الخادم، ثم رسالة الخادم العامة، ثم البديل */
const errText = (e: unknown, tr: Tr, fallback: string): string =>
  lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr(fallback);

const fmtQ = (n: number | null | undefined) =>
  roundLot(Number(n) || 0).toLocaleString(activeLocale(), { maximumFractionDigits: 4 });

/** خليّة كمية في «الأماكن» (الشاشة وورقة PDF): الصفر «—» في أعمدة dash (المحجوز والمنتهي والتالف)، والكمية بالرئيسية إن وُجدت */
const placeQtyText = (c: (typeof TRACE_PLACE_COLUMNS)[number], p: LotTraceDto['places'][number], prod: LotUnitProduct | null) => {
  const q = c.qty(p);
  return c.dash && Math.abs(q) <= LOT_EPS ? '—' : lotQtyText(q, prod, fmtQ);
};

const dayText = (v: string | null | undefined) => (lotDay(v) ? formatDayOnly(lotDay(v)) : '—');

/** شارة الحالة: نشطة، أو إيقاف احترازي، أو سحب */
function StatusBadge({ lot }: { lot: Pick<ProductLotDto, 'status' | 'blockKind'> }) {
  const tr = useTr();
  const cls = lot.status !== 'BLOCKED' ? 'bg-[#E4F1EA] text-[#1E7A52]'
    : lot.blockKind === 'RECALL' ? 'bg-[#FBE3DF] text-[#C0392B]' : 'bg-amber-50 text-amber-700';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{tr(lotStatusLabel(lot))}</span>;
}

/** شارة الانتهاء: منتهية أو قريبة (≤ ٣٠ يوماً) — والسارية بلا شارة */
function ExpiryBadge({ expiryDate, day }: { expiryDate: string | null; day: string }) {
  const tr = useTr();
  const s = expiryState(expiryDate, day, SOON_DAYS);
  if (s === 'expired') return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FBE3DF] text-[#C0392B]">{tr('منتهية')}</span>;
  if (s === 'soon') return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">{tr('قريبة الانتهاء')}</span>;
  return null;
}

function CertaintyBadge({ c }: { c: LotCertainty }) {
  const tr = useTr();
  const cls = c === 'CONFIRMED' ? 'bg-[#E4F1EA] text-[#1E7A52]' : c === 'ASSUMED' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600';
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{tr(LOT_CERTAINTY_LABELS[c] ?? c)}</span>;
}

function ScopedBanner() {
  const tr = useTr();
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800 flex items-center gap-2">
      <Lock size={14} /> {tr('النتيجة مقيدة بنطاقك')}
    </div>
  );
}

export default function LotsPage() {
  const tr = useTr();
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  // مفتاح ['company'] ودالّته كبقيّة اللوحة — كاشٌ واحد لا طلبٌ ثانٍ
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as CompanyCfg,
    staleTime: 300_000,
  });
  // مطفأة افتراضياً: لا تُفتح إلا بـtrue صريحة (غيابها من ردٍّ قديم = مطفأة)
  const featureOn = companyQ.data?.lotTrackingEnabled === true;
  const [params, setParams] = useSearchParams();
  const lotId = params.get('lot');
  const tab = params.get('tab') === 'health' ? 'health' : 'lots';
  const go = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v == null) n.delete(k); else n.set(k, v); }
    return n;
  });

  if (!accountingReady || companyQ.isLoading) return null;
  if (!accountingOn) return <AccountingOffNotice />;
  if (!featureOn) return <FeatureOff />;

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Layers size={24} className="text-[#E15A30]" /> {tr('التشغيلات')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{tr('أرصدة كل تشغيلة في المستودع والسيارات ومن بيعت لهم وإيقافها وسحبها')}</p>
        </div>
      </div>

      {lotId ? (
        <LotDetail id={lotId} company={companyQ.data ?? null} onBack={() => go({ lot: null })} onOpen={(id) => go({ lot: id })} />
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            {([['lots', tr('التشغيلات'), Layers], ['health', tr('سلامة الأرصدة'), ShieldAlert]] as const).map(([k, label, Icon]) => (
              <button key={k} type="button" onClick={() => go({ tab: k === 'lots' ? null : k })}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors ${tab === k ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:bg-[#FAF7F0]'}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
          {tab === 'health' ? <HealthPanel onOpen={(id) => go({ lot: id, tab: null })} /> : <LotsList onOpen={(id) => go({ lot: id })} />}
        </>
      )}
    </div>
  );
}

function FeatureOff() {
  const tr = useTr();
  return (
    <div className="card max-w-xl mx-auto text-center py-10">
      <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
        <Lock size={22} />
      </div>
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('تتبع LOT غير مفعل لشركتك')}</h1>
      <p className="text-sm text-gray-500 mt-1.5">{tr('تواصل مع مزود الخدمة لتفعيلها')}</p>
    </div>
  );
}

// ═══ القائمة والبحث ═══

function LotsList({ onOpen }: { onOpen: (id: string) => void }) {
  const tr = useTr();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(qInput.trim()), 300); return () => clearTimeout(t); }, [qInput]);
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'BLOCKED'>('');
  const [soon, setSoon] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, status, soon]);
  const [creating, setCreating] = useState(false);
  const today = localDay();

  const listQ = useQuery({
    queryKey: ['lots', 'list', q, status, soon, page],
    queryFn: async () => (await lotsApi.list({
      ...(q ? { q } : {}), ...(status ? { status } : {}), ...(soon ? { expiringWithinDays: SOON_DAYS } : {}), page, limit: PAGE_SIZE,
    })).data as { data: LotListRow[]; pagination: { total: number; page: number; pages: number }; scoped: boolean },
    placeholderData: keepPreviousData,
    retry: retryNetOnly,
  });
  const rows = listQ.data?.data ?? [];
  const pg = listQ.data?.pagination;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="label">{tr('بحث')}</label>
            <div className="relative">
              <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input className="input pr-9" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={tr('رقم التشغيلة أو اسم الصنف')} />
            </div>
          </div>
          <div>
            <label className="label">{tr('الحالة')}</label>
            <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="">{tr('الكل')}</option>
              <option value="ACTIVE">{tr('نشطة')}</option>
              <option value="BLOCKED">{tr('تشغيلة موقوفة')}</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-[#6E6557] pb-2.5 cursor-pointer">
            <input type="checkbox" checked={soon} onChange={(e) => setSoon(e.target.checked)} className="accent-[#E15A30]" />
            {tr('تنتهي خلال 30 يوما أو انتهت')}
          </label>
          <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> {tr('تشغيلة جديدة')}</button>
        </div>
      </div>

      {listQ.data?.scoped && <ScopedBanner />}

      {listQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : listQ.isError ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{errText(listQ.error, tr, 'تعذر تحميل التشغيلات')}</span>
          <button onClick={() => listQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-10 text-gray-500 text-sm">{q || status || soon ? tr('لا توجد تشغيلات مطابقة') : tr('لا توجد تشغيلات بعد سجل وارد التشغيلة من مخزون الشركة أو أنشئ بطاقة')}</div>
      ) : (
        <div className="card p-0">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('رقم التشغيلة')}</th>
                  <th>{tr('الصنف')}</th>
                  <th>{tr('تاريخ الانتهاء')}</th>
                  <th>{tr('الحالة')}</th>
                  <th>{tr('المستودع')}</th>
                  <th>{tr('السيارات')}</th>
                  <th>{tr('محجوز')}</th>
                  <th>{tr('الإجمالي')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const vans = r.summary ? r.summary.vans.SELLABLE + r.summary.vans.EXPIRED + r.summary.vans.DAMAGED : 0;
                  const prod = lotRowProduct(r);
                  return (
                    <tr key={r.id} className="cursor-pointer hover:bg-[#FAF7F0]" onClick={() => onOpen(r.id)}>
                      <td className="font-semibold text-[#1F1A13]"><bdi dir="ltr">{r.lotNumber}</bdi></td>
                      <td>
                        <div className="font-medium">{r.productName}</div>
                        {r.productCode && <div className="text-[11px] text-gray-400">{r.productCode}</div>}
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="tabular-nums">{dayText(r.expiryDate)}</span>
                          <ExpiryBadge expiryDate={r.expiryDate} day={today} />
                        </div>
                      </td>
                      <td><StatusBadge lot={r} /></td>
                      <td className="tabular-nums">{r.summary ? lotQtyText(r.summary.warehouse, prod, fmtQ) : '—'}</td>
                      <td className="tabular-nums">
                        {r.summary ? lotQtyText(vans, prod, fmtQ) : '—'}
                        {r.summary && r.summary.vanCount > 0 && <span className="text-[11px] text-gray-400"> · {r.summary.vanCount} {tr('سيارة')}</span>}
                      </td>
                      <td className="tabular-nums">{r.summary && r.summary.held > LOT_EPS ? lotQtyText(r.summary.held, prod, fmtQ) : '—'}</td>
                      <td className="tabular-nums font-semibold">{r.summary ? lotQtyText(r.summary.total, prod, fmtQ) : '—'} <span className="text-[11px] text-gray-400 font-normal">{lotUnitTag(prod)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pg && pg.pages > 1 && (
            <div className="flex items-center justify-between p-3 border-t border-[#F1EBDF] text-sm">
              <span className="text-gray-500 tabular-nums">{pg.page} / {pg.pages}</span>
              <div className="flex gap-2">
                <button className="btn-secondary py-1.5" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>{tr('السابق')}</button>
                <button className="btn-secondary py-1.5" disabled={page >= pg.pages} onClick={() => setPage((p) => p + 1)}>{tr('التالي')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {creating && <CreateLotModal onClose={() => setCreating(false)} onOpen={(id) => { setCreating(false); onOpen(id); }} />}
    </div>
  );
}

// ═══ إنشاء بطاقة ═══

interface ProductPick { id: string; name: string; code?: string | null; unit?: string | null; lotTracked?: boolean; shelfLifeEnabled?: boolean }

function CreateLotModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<ProductPick | null>(null);
  const [lotNumber, setLotNumber] = useState('');
  const [production, setProduction] = useState('');
  const [expiry, setExpiry] = useState('');
  const [note, setNote] = useState('');
  // طلبٌ بعد توقّف الكتابة لا مع كل حرف
  const [searchQ, setSearchQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearchQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const productsQ = useQuery({
    queryKey: ['lots', 'products', searchQ],
    // /products بلا مرشّح تتبّع: صفحةٌ واسعة ثم المتتبَّع منها — صفحة ٣٠ كانت تُخفي صنفاً متتبَّعاً وراء غير المتتبَّعين
    queryFn: async () => ((await productApi.list({ ...(searchQ ? { search: searchQ } : {}), limit: 200 })).data.data as ProductPick[])
      .filter((p) => p.lotTracked === true).slice(0, 50),
    enabled: !product,
    placeholderData: keepPreviousData,
  });
  const expiryRequired = product?.shelfLifeEnabled === true;
  const create = useMutation({
    mutationFn: async () => (await lotsApi.create({
      productId: product!.id, lotNumber, productionDate: production || null, expiryDate: expiry || null, note: note.trim() || null,
    })).data.data as ProductLotDto,
    onSuccess: (lot) => { qc.invalidateQueries({ queryKey: ['lots'] }); toast.success(tr('تم إنشاء التشغيلة')); onOpen(lot.id); },
    onError: (e) => {
      const le = lotErrorOf(e);
      const existing = le?.code === 'LOT_NUMBER_TAKEN' && typeof le.detail?.id === 'string' ? le.detail.id : null;
      if (existing) { toast(tr('رقم التشغيلة مسجل لهذا الصنف')); onOpen(existing); return; }
      toast.error(errText(e, tr, 'تعذر الحفظ'));
    },
  });
  const submit = () => {
    if (!product) { toast.error(tr('اختر الصنف')); return; }
    if (!normalizeLotNumber(lotNumber)) { toast.error(tr('اكتب رقم التشغيلة')); return; }
    const p = lotDatesProblem(production || null, expiry || null, { expiryRequired });
    if (p === 'LOT_EXPIRY_REQUIRED') { toast.error(tr('تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعلة')); return; }
    if (p) { toast.error(tr('تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح')); return; }
    create.mutate();
  };

  return (
    <Modal title={tr('تشغيلة جديدة')} icon={<Plus size={20} className="text-[#E15A30]" />} onClose={onClose}
      footer={<>
        <button className="btn-primary" onClick={submit} disabled={create.isPending}>{tr('حفظ')}</button>
        <button className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
      </>}>
      <div>
        <label className="label">{tr('الصنف')} *</label>
        {product ? (
          <div className="flex items-center justify-between gap-2 bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl px-3 py-2">
            <span className="font-semibold text-sm">{product.name}{product.code ? <span className="text-gray-400 font-normal"> · {product.code}</span> : null}</span>
            <button type="button" className="text-xs text-[#C94E28] font-semibold" onClick={() => setProduct(null)}>{tr('تغيير')}</button>
          </div>
        ) : (
          <>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('ابحث عن صنف متتبع بـLOT')} autoFocus />
            <div className="mt-2 max-h-48 overflow-y-auto border border-[#F1EBDF] rounded-xl divide-y divide-[#F1EBDF]">
              {(productsQ.data ?? []).length === 0 ? (
                <p className="text-xs text-gray-400 p-3">{productsQ.isFetching ? tr('جاري التحميل') : tr('لا أصناف متتبعة بـLOT فعل التتبع من صفحة المنتجات')}</p>
              ) : (productsQ.data ?? []).map((p) => (
                <button key={p.id} type="button" onClick={() => setProduct(p)} className="w-full text-right px-3 py-2 text-sm hover:bg-[#FAF7F0]">
                  {p.name}{p.code ? <span className="text-gray-400"> · {p.code}</span> : null}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div>
        <label className="label">{tr('رقم التشغيلة')} *</label>
        <input className="input" dir="ltr" value={lotNumber} maxLength={LOT_NUMBER_MAX} onChange={(e) => setLotNumber(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{tr('تاريخ الإنتاج')}</label>
          <input type="date" className="input" value={production} onChange={(e) => setProduction(e.target.value)} />
        </div>
        <div>
          <label className="label">{tr('تاريخ الانتهاء')}{expiryRequired ? ' *' : ''}</label>
          <input type="date" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">{tr('ملاحظة')}</label>
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

/** نافذةٌ بهوية اللوحة: عنوان وجسمٌ يتمرّر وأزرار */
function Modal({ title, icon, onClose, children, footer, wide }: {
  title: string; icon?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[92vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2">{icon} {title}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">{children}</div>
        {footer && <div className="flex gap-3 p-5 pt-0">{footer}</div>}
      </div>
    </div>
  );
}

// ═══ البطاقة والتتبّع ═══

function LotDetail({ id, company, onBack, onOpen }: { id: string; company: CompanyCfg; onBack: () => void; onOpen: (id: string) => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const impersonating = useAuthStore((s) => s.impersonating);

  const lotQ = useQuery({
    queryKey: ['lots', 'one', id],
    queryFn: async () => (await lotsApi.get(id)).data.data as LotDetailDto,
    retry: retryNetOnly,
  });
  const lot = lotQ.data;
  // المقيّد بنطاق لا يوقف ولا يسحب ولا يمدّ انتهاءً (LOT_SCOPED_USER) — حكم الخادم (scoped = adminScopeEnabled: مقيّد القوائم
  // ومشرف الفرق، وجلسة المالك غير مقيّدة) أولاً، وعَلَم المستخدم المحفوظ قبل وصول البطاقة
  const scopedUser = lot ? lot.scoped === true : user?.scopeEnabled === true && !impersonating;
  const [scopeSel, setScopeSel] = useState<'STRICT' | 'BROAD' | null>(null);
  const scope = scopeSel ?? (autoBroad(lot) ? 'BROAD' : 'STRICT');
  const traceQ = useQuery({
    queryKey: ['lots', 'trace', id, scope],
    queryFn: async () => (await lotsApi.trace(id, scope)).data.data as LotTraceDto,
    enabled: !!lot,
    retry: retryNetOnly,
  });
  // الموقوفة من صنفٍ متتبَّع وحده: غير المتتبَّع ينزل من «مخزون السيارات» (lotUnloadOn)
  const unloadOn = lotUnloadOn(lot);
  const planQ = useQuery({
    queryKey: ['lots', 'unload', id],
    queryFn: async () => (await lotsApi.unloadPlan(id)).data.data as LotUnloadPlanDto[],
    enabled: unloadOn,
    retry: retryNetOnly,
  });

  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<LotStatusAction | null>(null);
  const [relabel, setRelabel] = useState<'LABEL' | 'RECLASSIFY' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [unloadRow, setUnloadRow] = useState<LotUnloadPlanDto | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lots'] });

  const remove = useMutation({
    mutationFn: () => lotsApi.remove(id),
    onSuccess: () => { refresh(); toast.success(tr('تم حذف التشغيلة')); onBack(); },
    onError: (e) => { setDeleting(false); toast.error(errText(e, tr, 'تعذر الحذف')); },
  });
  const unload = useMutation({
    mutationFn: async (row: LotUnloadPlanDto) => {
      const body = lot ? unloadBody(lot, row, `${tr('تنزيل تشغيلة موقوفة')} ${lot.lotNumber}`) : null;
      if (!body) throw new Error('empty');
      return (await vanStockApi.createLoad(body)).data;
    },
    onSuccess: (res) => {
      setUnloadRow(null);
      refresh();
      qc.invalidateQueries({ queryKey: ['van-stock'] });
      for (const w of lotWarningsOf((res as { warnings?: unknown })?.warnings)) toast(tr(LOT_WARNING_LABELS[w.code]));
      toast.success(tr('تم تنزيل التشغيلة من السيارة'));
    },
    onError: (e) => {
      setUnloadRow(null);
      // أساس الصنف تغيّر منذ قُرئت البطاقة (baseUnitName في البند) ⇒ تُعاد قراءتها وخطّتها قبل المحاولة التالية
      if (baseChangedError(e)) refresh();
      toast.error(errText(e, tr, 'تعذر الحفظ'));
    },
  });

  const exportExcel = async () => {
    if (!traceQ.data) return;
    try {
      const out = await shareOrDownloadExcel(traceSheets(traceQ.data, tr), `${tr('تتبع التشغيلة')}-${traceQ.data.lot.lotNumber}`);
      toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
    } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
  };
  const exportPdf = async () => {
    if (!traceQ.data || !pdfRef.current) return;
    setPdfBusy(true);
    try {
      const blob = await elementToPdfBlob(pdfRef.current);
      const out = await shareOrDownloadPdf(blob, `${tr('تتبع التشغيلة')}-${traceQ.data.lot.lotNumber}.pdf`);
      toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
    } catch { toast.error(tr('تعذر إنشاء الملف حاول مجددا')); }
    setPdfBusy(false);
  };

  if (lotQ.isPending) return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  if (lotQ.isError || !lot) {
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{errText(lotQ.error, tr, 'تعذر تحميل التشغيلة')}</span>
        <div className="flex gap-2">
          <button onClick={onBack} className="btn-secondary"><ArrowRight size={15} /> {tr('رجوع')}</button>
          <button onClick={() => lotQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      </div>
    );
  }

  const trace = traceQ.data;
  const totals = trace ? traceTotals(trace) : null;
  // صنف البطاقة بوحداته ورئيسيّه — كل كمية في الشاشة وورقتها بالأساس، تُعرض بالرئيسية إن وُجدت (R1)
  const prod: LotUnitProduct = lot.product;
  const actions = statusActions(lot);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-[#6E6557] hover:text-[#1F1A13]"><ArrowRight size={15} /> {tr('كل التشغيلات')}</button>

      {(lot.scoped || trace?.scoped) && <ScopedBanner />}

      {/* البطاقة */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold text-[#1F1A13]"><bdi dir="ltr">{lot.lotNumber}</bdi></h2>
              <StatusBadge lot={lot} />
              <ExpiryBadge expiryDate={lot.expiryDate} day={lot.day} />
            </div>
            <p className="text-sm text-[#6E6557] mt-1">{lot.product.name}{lot.product.code ? ` · ${lot.product.code}` : ''}</p>
            {!lot.product.lotTracked && <p className="text-xs text-amber-700 mt-1">{tr('تتبع هذا الصنف بـLOT مطفأ والتشغيلة للسجل وحده')}</p>}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" onClick={exportExcel} disabled={!trace}><Download size={15} /> {tr('تصدير Excel')}</button>
            <button className="btn-secondary" onClick={exportPdf} disabled={!trace || pdfBusy}><FileText size={15} /> {tr('تصدير PDF')}</button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <Info label={tr('تاريخ الإنتاج')} value={dayText(lot.productionDate)} />
          <Info label={tr('تاريخ الانتهاء')} value={dayText(lot.expiryDate)} />
          <Info label={tr('المصدر')} value={tr(LOT_SOURCE_LABELS[lot.source] ?? lot.source)} />
          <Info label={tr('أنشئت')} value={formatDateTime(lot.createdAt)} />
          {lot.status === 'BLOCKED' && lot.blockReason && <Info label={tr('سبب إيقاف التشغيلة')} value={lot.blockReason} wide />}
          {lot.note && <Info label={tr('ملاحظة')} value={lot.note} wide />}
        </div>

        <div className="flex gap-2 flex-wrap border-t border-[#F1EBDF] pt-3">
          <button className="btn-secondary" onClick={() => setEditing(true)}><Pencil size={15} /> {tr('تعديل التواريخ')}</button>
          {actions.map((a) => (
            <button key={`${a.status}-${a.blockKind ?? ''}`} onClick={() => setAction(a)} disabled={scopedUser}
              title={scopedUser ? tr('هذا الإجراء على التشغيلات لمستخدم غير مقيد بنطاق') : undefined}
              className={a.status === 'ACTIVE' ? 'btn-secondary' : a.danger ? 'btn-danger' : 'btn-secondary'}>
              {a.status === 'ACTIVE' ? <RotateCcw size={15} /> : <AlertTriangle size={15} />} {tr(a.label)}
            </button>
          ))}
          <button className="btn-secondary" onClick={() => setRelabel('LABEL')} disabled={!lot.product.lotTracked}><Tags size={15} /> {tr('تسمية الرصيد القائم')}</button>
          <button className="btn-secondary" onClick={() => setRelabel('RECLASSIFY')} disabled={!lot.product.lotTracked}><Tags size={15} /> {tr('إعادة التصنيف')}</button>
          {!lot.inUse && <button className="btn-secondary text-red-600" onClick={() => setDeleting(true)}><Trash2 size={15} /> {tr('حذف')}</button>}
        </div>
        {scopedUser && <p className="text-[11px] text-[#9A8F7E]">{tr('هذا الإجراء على التشغيلات لمستخدم غير مقيد بنطاق')}</p>}
      </div>

      {/* خطة التنزيل بعد الإيقاف أو السحب */}
      {unloadOn && (
        <div className="card space-y-3">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Truck size={18} className="text-[#E15A30]" /> {tr('تنزيل التشغيلة من السيارات')}</h3>
          <p className="text-xs text-[#6E6557]">{tr('الموقوفة لا تحمل ولا تباع نزل صالحها من كل سيارة إلى المستودع والمحجوز ينزل بعد اعتماد إشعاره')}</p>
          {planQ.isPending ? (
            <p className="text-sm text-gray-400">{tr('جاري التحميل')}</p>
          ) : planQ.isError ? (
            <p className="text-sm text-red-600">{errText(planQ.error, tr, 'تعذر التحميل')}</p>
          ) : (planQ.data ?? []).length === 0 ? (
            <p className="text-sm text-[#1E7A52]">{tr('لا رصيد لهذه التشغيلة في السيارات')}</p>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead><tr><th>{tr('المندوب')}</th><th>{tr('الصالح للتنزيل')}</th><th>{tr('محجوز')}</th><th>{tr('منتهي الصلاحية')}</th><th>{tr('تالف')}</th><th></th></tr></thead>
                <tbody>
                  {(planQ.data ?? []).map((r) => (
                    <tr key={r.salesRepId}>
                      <td className={r.deleted ? 'text-amber-700' : ''}>{vanName(r, tr)}</td>
                      <td className="tabular-nums font-semibold">{lotQtyText(r.usable.SELLABLE, prod, fmtQ)} <span className="text-[11px] text-gray-400 font-normal">{lotUnitTag(prod)}</span></td>
                      <td className="tabular-nums">{r.held.SELLABLE > LOT_EPS ? lotQtyText(r.held.SELLABLE, prod, fmtQ) : '—'}</td>
                      <td className="tabular-nums">{r.usable.EXPIRED > LOT_EPS ? lotQtyText(r.usable.EXPIRED, prod, fmtQ) : '—'}</td>
                      <td className="tabular-nums">{r.usable.DAMAGED > LOT_EPS ? lotQtyText(r.usable.DAMAGED, prod, fmtQ) : '—'}</td>
                      <td>
                        {r.usable.SELLABLE > LOT_EPS && (
                          <button className="btn-secondary py-1.5 text-xs" disabled={unload.isPending} onClick={() => setUnloadRow(r)}>{tr('تنزيل')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* ما لا يُنزَّل من هنا: رصيد المستودع يُتلف بتسوية نقصٍ بالتشغيلة (§٤.١٦)، والمنتهي والتالف في السيارة يزالان من دلويهما */}
          {(lot.summary?.warehouse ?? 0) > LOT_EPS && (
            <p className="text-xs text-[#6E6557]">
              {tr('رصيد المستودع من التشغيلة الموقوفة يتلف بتسوية نقص بالتشغيلة')} — <Link to="/app/warehouse" className="text-[#C94E28] font-semibold">{tr('مخزون الشركة')}</Link>
            </p>
          )}
          {(planQ.data ?? []).some((r) => r.usable.EXPIRED > LOT_EPS || r.usable.DAMAGED > LOT_EPS) && (
            <p className="text-xs text-[#6E6557]">
              {tr('المنتهي والتالف من التشغيلة يزالان من دلويهما في السيارة')} — <Link to="/app/van-stock" className="text-[#C94E28] font-semibold">{tr('مخزون السيارات')}</Link>
            </p>
          )}
        </div>
      )}

      {/* الأماكن */}
      <div className="card space-y-3">
        <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Layers size={18} className="text-[#E15A30]" /> {tr('الأماكن')}</h3>
        {traceQ.isPending ? <p className="text-sm text-gray-400">{tr('جاري التحميل')}</p>
          : traceQ.isError || !trace ? <p className="text-sm text-red-600">{errText(traceQ.error, tr, 'تعذر التحميل')}</p>
          : trace.places.length === 0 ? <p className="text-sm text-gray-500">{tr('لا حركات لهذه التشغيلة بعد')}</p>
          : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('المكان')}</th>
                    {TRACE_PLACE_COLUMNS.map((c) => <th key={c.label}>{tr(c.label)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {trace.places.map((p, i) => (
                    <tr key={`${p.place}-${p.salesRepId ?? i}`}>
                      <td>
                        {placeName(p, tr)}
                        {p.approximate && <span className="text-[11px] text-amber-700"> · {tr('تقريبي')}</span>}
                      </td>
                      {TRACE_PLACE_COLUMNS.map((c) => (
                        <td key={c.label} className={`tabular-nums ${c.strong ? `font-semibold ${c.qty(p) < -LOT_EPS ? 'text-red-600' : ''}` : ''}`}>
                          {placeQtyText(c, p, prod)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {trace && trace.origin.length > 0 && (
          <div className="border-t border-[#F1EBDF] pt-3">
            <p className="text-xs font-bold text-[#6E6557] mb-1.5">{tr('مصدر التشغيلة')}</p>
            <div className="space-y-1">
              {trace.origin.map((o, i) => (
                <div key={i} className="flex items-center justify-between text-xs gap-3">
                  <span>{originKindLabel(o.kind, tr)} · <span className="text-gray-400">{formatDateTime(o.at)}</span></span>
                  <span className={`tabular-nums font-semibold ${o.qty < 0 ? 'text-red-600' : 'text-[#1E7A52]'}`} dir={lotQtyDir(prod)}>{o.qty < 0 ? '−' : '+'}{lotQtyText(Math.abs(o.qty), prod, fmtQ)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* العملاء */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Users size={18} className="text-[#E15A30]" /> {tr('العملاء الذين وصلتهم التشغيلة')}</h3>
          <div className="flex gap-1 bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl p-1">
            {(['STRICT', 'BROAD'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setScopeSel(s)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold ${scope === s ? 'bg-[#1F1A13] text-white' : 'text-[#6E6557]'}`}>
                {s === 'STRICT' ? tr('النطاق الدقيق') : tr('النطاق الموسع')}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-[#9A8F7E] leading-relaxed">
          {scope === 'BROAD'
            ? tr('الموسع يضيف كل بيع للصنف من السيارة أثناء وجود التشغيلة فيها بيقين مفترض')
            : tr('الدقيق ما سجل بهذه التشغيلة في الفواتير المؤكدة')}
          {autoBroad(lot) && scopeSel === null && <> · {tr('الموسع تلقائي في السحب')}</>}
        </p>
        {traceQ.isPending ? <p className="text-sm text-gray-400">{tr('جاري التحميل')}</p>
          : !trace ? null
          : trace.customersHidden ? <p className="text-sm text-gray-500">{tr('قائمة العملاء تتطلب صلاحية العملاء')}</p>
          : (trace.customers ?? []).length === 0 ? <p className="text-sm text-gray-500">{tr('لم تبع هذه التشغيلة لأي عميل')}</p>
          : (
            <>
              {totals && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
                  <MiniStat label={tr('المباع')} value={lotQtyUnitText(totals.sold, prod, fmtQ)} />
                  <MiniStat label={tr('المرتجع')} value={lotQtyUnitText(totals.returned, prod, fmtQ)} />
                  <MiniStat label={tr('الصافي')} value={lotQtyUnitText(totals.net, prod, fmtQ)} />
                  <MiniStat label={tr('العملاء')} value={`${totals.customers} · ${totals.invoices} ${tr('فاتورة')}`} />
                </div>
              )}
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr><th>{tr('العميل')}</th><th>{tr('الفاتورة')}</th><th>{tr('التاريخ')}</th><th>{tr('المباع')}</th><th>{tr('المرتجع')}</th><th>{tr('الصافي')}</th><th>{tr('اليقين')}</th></tr>
                  </thead>
                  <tbody>
                    {(trace.customers ?? []).flatMap((c) => c.invoices.map((inv, k) => (
                      <tr key={`${c.customerId}-${inv.invoiceId}`} className={inv.broad ? 'bg-[#FFFBF2]' : ''}>
                        {k === 0 && (
                          <td rowSpan={c.invoices.length} className="align-top">
                            <div className="font-semibold">{c.name}</div>
                            {c.phone && <div className="text-[11px] text-gray-500" dir="ltr">{c.phone}</div>}
                            {(c.city || c.address) && <div className="text-[11px] text-gray-400">{[c.city, c.address].filter(Boolean).join(' · ')}</div>}
                          </td>
                        )}
                        <td>
                          <bdi dir="ltr">{inv.number}</bdi>
                          {inv.broad && <span className="text-[10px] text-amber-700"> · {tr('النطاق الموسع')}</span>}
                          {inv.flags.length > 0 && <div className="text-[10px] text-[#C94E28]">{inv.flags.map((f) => tr(LOT_ROW_FLAG_LABELS[f] ?? f)).join(' · ')}</div>}
                        </td>
                        <td className="tabular-nums">{formatDate(inv.date)}</td>
                        <td className="tabular-nums">{lotQtyText(inv.sold, prod, fmtQ)}</td>
                        <td className="tabular-nums">{inv.returned > LOT_EPS ? lotQtyText(inv.returned, prod, fmtQ) : '—'}</td>
                        <td className="tabular-nums font-semibold">{lotQtyText(inv.net, prod, fmtQ)}</td>
                        <td><CertaintyBadge c={inv.weakest} /></td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </div>

      {/* السجل */}
      <div className="card space-y-2">
        <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><History size={18} className="text-[#E15A30]" /> {tr('سجل التشغيلة')}</h3>
        {!trace || trace.events.length === 0 ? <p className="text-sm text-gray-500">{tr('لا أحداث')}</p> : (
          <div className="divide-y divide-[#F1EBDF]">
            {[...trace.events].reverse().map((e, i) => (
              <div key={i} className="py-2 text-sm flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[#1F1A13]">{eventKindLabel(e.kind, tr)}</div>
                  {e.reason && <div className="text-xs text-[#6E6557]">{tr('السبب')}: {e.reason}</div>}
                </div>
                <div className="text-[11px] text-gray-400 text-left shrink-0">
                  <div>{formatDateTime(e.at)}</div>
                  {e.actorName && <div>{e.actorName}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && <EditDatesModal lot={lot} scopedUser={scopedUser} onClose={() => setEditing(false)} onDone={() => { setEditing(false); refresh(); }} />}
      {action && <StatusDialog lot={lot} action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); setScopeSel(null); refresh(); }} />}
      {relabel && <RelabelModal lot={lot} preset={relabel} onClose={() => setRelabel(null)} onDone={() => { setRelabel(null); refresh(); }} onOpen={onOpen} />}
      {deleting && (
        <ConfirmDialog danger title={tr('حذف التشغيلة')} message={tr('تحذف البطاقة وحدها لأنها بلا حركات ويبقى سجلها')}
          confirmLabel={tr('حذف')} loading={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => setDeleting(false)} />
      )}
      {unloadOn && unloadRow && (
        <ConfirmDialog title={tr('تنزيل التشغيلة من السيارة')}
          message={`${vanName(unloadRow, tr)} — ${lotQtyUnitText(unloadRow.usable.SELLABLE, prod, fmtQ)}`}
          confirmLabel={tr('تنزيل')} loading={unload.isPending} onConfirm={() => unload.mutate(unloadRow)} onClose={() => setUnloadRow(null)} />
      )}

      {/* ورقة PDF (خارج الشاشة) — تُلتقط عند التصدير */}
      {trace && (
        <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
          <LotTraceDoc ref={pdfRef} trace={trace} company={company} prod={prod} />
        </div>
      )}
    </div>
  );
}

function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 lg:col-span-4' : ''}>
      <p className="text-[11px] text-[#9A8F7E]">{label}</p>
      <p className="font-medium text-[#1F1A13] break-words">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#FAF7F0] border border-[#F1EBDF] rounded-xl py-2">
      <p className="text-[11px] text-[#9A8F7E]">{label}</p>
      <p className="font-bold text-[#1F1A13] tabular-nums text-sm">{value}</p>
    </div>
  );
}

// ═══ تعديل التواريخ (§٤.٣) ═══

/**
 * خطأ حفظ البطاقة: رسالته (رمز اللوط برسالة الخادم)، و«تغيّرت التشغيلة منذ فتحها» (LOT_CHANGED) يعيد قراءتها فتحمل المحاولة
 * التالية نسختها الجديدة (updatedAt) — وإلا تكرّر الرفض نفسه حتى يُغلق المستخدم النافذة ويعيد فتحها.
 */
function useLotSaveError(lotId: string) {
  const tr = useTr();
  const qc = useQueryClient();
  return (e: unknown) => {
    toast.error(errText(e, tr, 'تعذر الحفظ'));
    if (lotErrorOf(e)?.code === 'LOT_CHANGED') qc.invalidateQueries({ queryKey: ['lots', 'one', lotId] });
  };
}

function EditDatesModal({ lot, scopedUser, onClose, onDone }: { lot: LotDetailDto; scopedUser: boolean; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const [production, setProduction] = useState(lotDay(lot.productionDate) ?? '');
  const [expiry, setExpiry] = useState(lotDay(lot.expiryDate) ?? '');
  const [note, setNote] = useState(lot.note ?? '');
  const [reason, setReason] = useState('');
  // مدّ الانتهاء (أو محوه) لتشغيلةٍ لها حركات يعيد المنتهي إلى البيع — بسببٍ ولغير المقيّد (D27)
  const needsReason = lot.inUse && extendsExpiry(lot.expiryDate, expiry || null);
  const onSaveError = useLotSaveError(lot.id);
  const save = useMutation({
    mutationFn: () => lotsApi.update(lot.id, {
      productionDate: production || null, expiryDate: expiry || null, note: note.trim() || null,
      ...(reason.trim() ? { reason: reason.trim() } : {}), updatedAt: lot.updatedAt,
    }),
    onSuccess: () => { toast.success(tr('تم الحفظ')); onDone(); },
    onError: onSaveError,
  });
  const submit = () => {
    const p = lotDatesProblem(production || null, expiry || null, { expiryRequired: lot.product.shelfLifeOn });
    if (p === 'LOT_EXPIRY_REQUIRED') { toast.error(tr('تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعلة')); return; }
    if (p) { toast.error(tr('تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح')); return; }
    if (needsReason && scopedUser) { toast.error(tr('هذا الإجراء على التشغيلات لمستخدم غير مقيد بنطاق')); return; }
    if (needsReason && !reason.trim()) { toast.error(tr('اكتب سبب هذا التعديل على التشغيلة')); return; }
    save.mutate();
  };
  return (
    <Modal title={tr('تعديل التواريخ')} icon={<Pencil size={20} className="text-[#E15A30]" />} onClose={onClose}
      footer={<>
        <button className="btn-primary" onClick={submit} disabled={save.isPending}>{tr('حفظ')}</button>
        <button className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{tr('تاريخ الإنتاج')}</label>
          <input type="date" className="input" value={production} onChange={(e) => setProduction(e.target.value)} />
        </div>
        <div>
          <label className="label">{tr('تاريخ الانتهاء')}{lot.product.shelfLifeOn ? ' *' : ''}</label>
          <input type="date" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">{tr('ملاحظة')}</label>
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <label className="label">{tr('السبب')}{needsReason ? ' *' : ''}</label>
        <textarea className="input min-h-[70px]" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {needsReason && <p className="text-[11px] text-amber-700 mt-1">{tr('مد انتهاء تشغيلة لها حركات يعيد المنتهي إلى البيع فاكتب السبب')}</p>}
        <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تواريخ الانتهاء المطبوعة على الفواتير السابقة لا تتغير')}</p>
      </div>
    </Modal>
  );
}

// ═══ الإيقاف والسحب وإعادة التنشيط (§٤.١٦) ═══

function StatusDialog({ lot, action, onClose, onDone }: { lot: LotDetailDto; action: LotStatusAction; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const [reason, setReason] = useState('');
  const onSaveError = useLotSaveError(lot.id);
  const save = useMutation({
    mutationFn: () => lotsApi.setStatus(lot.id, {
      status: action.status, ...(action.blockKind ? { blockKind: action.blockKind } : {}), reason: reason.trim(), updatedAt: lot.updatedAt,
    }),
    onSuccess: () => {
      toast.success(action.status === 'BLOCKED' ? tr('تم إيقاف التشغيلة نزلها الآن من السيارات') : tr('أعيد تنشيط التشغيلة'));
      onDone();
    },
    onError: onSaveError,
  });
  const message = action.status === 'ACTIVE'
    ? tr('تعود التشغيلة إلى التحميل والبيع')
    : action.blockKind === 'RECALL'
      ? tr('لا تحمل ولا تباع ولا يعاد تصنيفها وتعرض شاشة التتبع كل من وصلته بالنطاق الموسع')
      : tr('لا تحمل ولا تباع ولا يعاد تصنيفها حتى تعيد تنشيطها');
  return (
    <ConfirmDialog
      title={`${tr(action.label)} — ${lot.lotNumber}`}
      message={message}
      danger={action.danger}
      confirmLabel={tr(action.label)}
      loading={save.isPending}
      onClose={onClose}
      onConfirm={() => { if (!reason.trim()) { toast.error(tr('اكتب سبب هذا التعديل على التشغيلة')); return; } save.mutate(); }}
      extra={(
        <div className="text-right mt-3">
          <label className="label">{tr('السبب')} *</label>
          <textarea className="input min-h-[70px]" value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
    />
  );
}

// ═══ التسمية وإعادة التصنيف (§٤.٦، D27) ═══

const emptyLine = (mode: RelabelLineForm['mode'], toLotId: string | null = null): RelabelLineForm =>
  ({ mode, toLotId, lotNumber: '', productionDate: '', expiryDate: '', qty: '' });

function RelabelModal({ lot, preset, onClose, onDone, onOpen }: {
  lot: LotDetailDto; preset: 'LABEL' | 'RECLASSIFY'; onClose: () => void; onDone: () => void; onOpen: (id: string) => void;
}) {
  const tr = useTr();
  const productId = lot.product.id;
  const balQ = useQuery({
    queryKey: ['lots', 'balances', productId],
    queryFn: async () => (await lotsApi.balances({ productId })).data.data as LotBalancesResponse,
    retry: retryNetOnly,
  });
  const lotsQ = useQuery({
    queryKey: ['lots', 'of-product', productId],
    queryFn: async () => (await lotsApi.list({ productId, limit: 200 })).data.data as LotListRow[],
    retry: retryNetOnly,
  });
  const bal = balQ.data;
  const places = useMemo(() => {
    const out: { key: string; place: LotPlace; vanKey: string | null; label: string; view: PlaceViewWithAvailability }[] = [];
    if (!bal) return out;
    for (const v of bal.warehouse) out.push({ key: 'WAREHOUSE', place: 'WAREHOUSE', vanKey: null, label: tr('المستودع'), view: v });
    for (const v of bal.vans) out.push({ key: `VAN:${v.salesRepId}`, place: 'VAN', vanKey: v.salesRepId, label: vanName(v, tr), view: v.view });
    return out;
  }, [bal, tr]);
  const day = bal?.day ?? lot.day;
  // التسمية: من غير المسمّى إلى هذه التشغيلة؛ إعادة التصنيف: من هذه التشغيلة إلى غيرها
  const defaultFrom = preset === 'LABEL' ? null : lot.id;
  const defaultSrc = defaultFrom ?? '∅';
  const [placeKey, setPlaceKey] = useState('');
  // المكان الافتراضي حيث المصدر الافتراضي صالح (التشغيلة في سيارةٍ لا في المستودع)، ثم ما اختاره المستخدم
  const place = places.find((p) => p.key === placeKey) ?? defaultRelabelPlace(places, defaultFrom, day);
  const [bucket, setBucket] = useState<LotBucket>('SELLABLE');
  const effBucket: LotBucket = place?.place === 'VAN' ? bucket : 'SELLABLE';
  const sources = useMemo(() => relabelSources(place?.view, effBucket, day), [place, effBucket, day]);
  const [srcKey, setSrcKey] = useState<string | null>(null);
  const source = sources.find((s) => (s.lotId ?? '∅') === (srcKey ?? defaultSrc)) ?? null;
  const [lines, setLines] = useState<RelabelLineForm[]>(() => [preset === 'LABEL' ? emptyLine('EXISTING', lot.id) : emptyLine('NEW')]);
  const [note, setNote] = useState('');
  const others = (lotsQ.data ?? []).filter((l) => l.id !== source?.lotId);
  const setLine = (i: number, patch: Partial<RelabelLineForm>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const toUnknown = lines.some((l) => l.mode === 'UNKNOWN');
  const reason = relabelReasonOf(source?.lotId ?? null, toUnknown);

  const qc = useQueryClient();
  // R8: المدخلات بالأساس دائماً — ولصنفٍ له وحدة رئيسية اسمُ الأساس لاصقٌ بالخانة ومعادلٌ حيّ تحتها
  const prod: LotUnitProduct = lot.product;
  const hasPrimary = !!primaryUnitOf(prod);
  const save = useMutation({
    mutationFn: async () => {
      // baseUnitName: الأساس كما قرأته البطاقة (§2.11ب) — تحويلٌ بينهما يُردّ ٤٠٠/٤٠٩ لا تسميةً بأساسٍ قديم
      const body = relabelBody({
        productId, place: place!.place, vanKey: place!.vanKey, bucket: effBucket, fromLotId: source!.lotId, reason,
        note, lines, baseUnitName: lot.product.unit,
      });
      return (await lotsApi.relabel(body)).data.data as { rows: number; warnings?: unknown };
    },
    onSuccess: (res) => {
      for (const w of lotWarningsOf(res?.warnings)) toast(tr(LOT_WARNING_LABELS[w.code]));
      toast.success(tr('تمت التسمية'));
      onDone();
    },
    onError: (e) => {
      // أساس الصنف تغيّر منذ فُتحت النافذة ⇒ تُعاد قراءة البطاقة والأرصدة (والاسم اللاصق معها)
      if (baseChangedError(e)) qc.invalidateQueries({ queryKey: ['lots'] });
      toast.error(errText(e, tr, 'تعذر الحفظ'));
    },
  });
  const submit = () => {
    if (!place) { toast.error(tr('لا رصيد لهذا الصنف في المستودع أو السيارات')); return; }
    const p = relabelProblem({ source, lines, note, expiryRequired: lot.product.shelfLifeOn });
    if (p) { toast.error(tr(p)); return; }
    save.mutate();
  };
  const srcLabel = (s: { lotId: string | null; lotNumber: string | null; usable: number; blockedWhy: string | null }) =>
    `${s.lotId == null ? tr('غير مسمى') : s.lotNumber} — ${tr('المتاح')} ${lotQtyText(s.usable, prod, fmtQ)}${s.blockedWhy ? ` (${tr(s.blockedWhy)})` : ''}`;

  return (
    <Modal wide title={preset === 'LABEL' ? tr('تسمية الرصيد القائم') : tr('إعادة التصنيف')} icon={<Tags size={20} className="text-[#E15A30]" />} onClose={onClose}
      footer={<>
        <button className="btn-primary" onClick={submit} disabled={save.isPending || !place}>{tr('حفظ')}</button>
        <button className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
      </>}>
      <p className="text-xs text-[#6E6557] leading-relaxed">{tr('التسمية تغير بعد التشغيلة وحده لا رصيد الصنف ولا قيمته والموقوفة والمنتهية لا يعاد تصنيفها')}</p>
      {balQ.isPending ? <p className="text-sm text-gray-400">{tr('جاري التحميل')}</p>
        : balQ.isError ? <p className="text-sm text-red-600">{errText(balQ.error, tr, 'تعذر التحميل')}</p>
        : places.length === 0 ? <p className="text-sm text-gray-500">{tr('لا رصيد لهذا الصنف في المستودع أو السيارات')}</p>
        : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{tr('المكان')}</label>
                <select className="input" value={place?.key ?? ''} onChange={(e) => { setPlaceKey(e.target.value); setSrcKey(null); }}>
                  {places.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              {place?.place === 'VAN' && (
                <div>
                  <label className="label">{tr('الدلو')}</label>
                  <select className="input" value={bucket} onChange={(e) => { setBucket(e.target.value as LotBucket); setSrcKey(null); }}>
                    {(['SELLABLE', 'EXPIRED', 'DAMAGED'] as const).map((b) => <option key={b} value={b}>{tr(LOT_BUCKET_LABELS[b])}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div>
              <label className="label">{tr('من')}</label>
              {sources.length === 0 ? <p className="text-sm text-gray-500">{tr('لا رصيد صالح في هذا المكان')}</p> : (
                <select className="input" value={source ? (source.lotId ?? '∅') : ''} onChange={(e) => setSrcKey(e.target.value)}>
                  {!source && <option value="">{tr('اختر مصدر الكمية')}</option>}
                  {sources.map((s) => <option key={s.lotId ?? '∅'} value={s.lotId ?? '∅'} disabled={!!s.blockedWhy}>{srcLabel(s)}</option>)}
                </select>
              )}
              {place?.view.unknown && place.view.unknown[effBucket] < -LOT_EPS && (
                <p className="text-[11px] text-red-600 mt-1">{tr('غير المسمى سالب صحح الرصيد بتسوية موجبة غير مسماة أولا')}</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="label">{tr('إلى')}</label>
              {lines.map((l, i) => (
                <div key={i} className="border border-[#E9E1D3] rounded-xl p-3 space-y-2">
                  <div className="flex gap-2 flex-wrap items-end">
                    <div>
                      <select className="input w-40" value={l.mode} onChange={(e) => setLine(i, { mode: e.target.value as RelabelLineForm['mode'], toLotId: null })}>
                        <option value="EXISTING">{tr('تشغيلة قائمة')}</option>
                        <option value="NEW">{tr('تشغيلة جديدة')}</option>
                        {source?.lotId != null && <option value="UNKNOWN">{tr('غير مسمى')}</option>}
                      </select>
                    </div>
                    {l.mode === 'EXISTING' && (
                      <select className="input flex-1 min-w-[160px]" value={l.toLotId ?? ''} onChange={(e) => setLine(i, { toLotId: e.target.value || null })}>
                        <option value="">{tr('اختر التشغيلة')}</option>
                        {others.map((o) => <option key={o.id} value={o.id}>{o.lotNumber}{o.expiryDate ? ` · ${dayText(o.expiryDate)}` : ''}{o.status === 'BLOCKED' ? ` · ${tr('تشغيلة موقوفة')}` : ''}</option>)}
                      </select>
                    )}
                    {l.mode === 'NEW' && (
                      <input className="input flex-1 min-w-[140px]" dir="ltr" placeholder={tr('رقم التشغيلة')} value={l.lotNumber} maxLength={LOT_NUMBER_MAX}
                        onChange={(e) => setLine(i, { lotNumber: e.target.value })} />
                    )}
                    {hasPrimary ? (
                      <div className="w-36">
                        {/* R8: الخانة بالأساس واسمه لاصقٌ بها بخطٍّ بارز — «10» هنا قوارير لا كراتين */}
                        <div className="flex items-stretch">
                          <input className="input tabular-nums rounded-e-none" inputMode="decimal" placeholder={tr('الكمية')} value={l.qty}
                            onChange={(e) => setLine(i, { qty: e.target.value })} />
                          <span className="shrink-0 inline-flex items-center px-2 border border-s-0 border-[#E9E1D3] rounded-e-xl bg-[#FAF7F0] text-xs font-bold text-[#1F1A13]">{lot.product.unit}</span>
                        </div>
                        {lotQtyOk(l.qty) && <p className="text-[11px] text-[#6E6557] mt-0.5 tabular-nums">= {lotQtyText(Number(l.qty), prod, fmtQ)}</p>}
                      </div>
                    ) : (
                      <div className="w-28">
                        <input className="input tabular-nums" inputMode="decimal" placeholder={tr('الكمية')} value={l.qty}
                          onChange={(e) => setLine(i, { qty: e.target.value })} />
                      </div>
                    )}
                    {lines.length > 1 && (
                      <button type="button" className="p-2 text-gray-400 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><X size={16} /></button>
                    )}
                  </div>
                  {l.mode === 'NEW' && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-[#9A8F7E]">{tr('تاريخ الإنتاج')}</label>
                        <input type="date" className="input" value={l.productionDate} onChange={(e) => setLine(i, { productionDate: e.target.value })} />
                      </div>
                      <div>
                        <label className="text-[11px] text-[#9A8F7E]">{tr('تاريخ الانتهاء')}{lot.product.shelfLifeOn ? ' *' : ''}</label>
                        <input type="date" className="input" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
                      </div>
                    </div>
                  )}
                  {l.qty !== '' && !lotQtyOk(l.qty) && <p className="text-[11px] text-red-600">{tr('كمية غير صالحة')}</p>}
                </div>
              ))}
              {lines.length < 20 && (
                <button type="button" className="btn-secondary text-xs py-1.5" onClick={() => setLines((ls) => [...ls, emptyLine('NEW')])}><Plus size={14} /> {tr('سطر آخر')}</button>
              )}
            </div>
            <div>
              <label className="label">{tr('ملاحظة')}{toUnknown ? ' *' : ''}</label>
              <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
            <p className="text-[11px] text-[#9A8F7E]">{lotsUnitNote(prod, tr)}</p>
            {lines.some((l) => l.mode === 'EXISTING' && l.toLotId && l.toLotId !== lot.id) && (
              <button type="button" className="text-xs text-[#C94E28] font-semibold" onClick={() => { const t = lines.find((l) => l.toLotId && l.toLotId !== lot.id)?.toLotId; if (t) { onClose(); onOpen(t); } }}>
                {tr('فتح التشغيلة المختارة')}
              </button>
            )}
          </>
        )}
    </Modal>
  );
}

// ═══ سلامة الأرصدة (/lots/health) ═══

function HealthPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['lots', 'health'],
    queryFn: async () => (await lotsApi.health()).data.data as { deficits: LotDeficitRow[]; scoped: boolean },
    retry: retryNetOnly,
  });
  const groups = useMemo(() => healthByProduct(q.data?.deficits ?? []), [q.data]);
  return (
    <div className="space-y-4">
      {q.data?.scoped && <ScopedBanner />}
      <div className="card space-y-2">
        <h3 className="font-bold text-[#1F1A13]">{tr('إجراء يوم التفعيل')}</h3>
        <ol className="list-decimal pr-5 text-sm text-[#6E6557] space-y-1">
          <li>{tr('صحح الأرصدة السالبة بتسوية موجبة غير مسماة')}</li>
          <li>{tr('سم رصيد المستودع ثم السيارات')}</li>
          <li>{tr('فعل تتبع الأصناف من صفحة المنتجات')}</li>
        </ol>
      </div>
      {q.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : q.isError ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{errText(q.error, tr, 'تعذر التحميل')}</span>
          <button onClick={() => q.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : groups.length === 0 ? (
        <div className="card text-center py-10 text-[#1E7A52] text-sm font-semibold">{tr('لا عجز في أرصدة التشغيلات')}</div>
      ) : (
        <div className="card p-0">
          <div className="p-4 border-b border-[#F1EBDF] text-xs text-[#6E6557] leading-relaxed">
            {tr('العجز رصيد سالب في تشغيلة أو في غير المسمى ولا يقتطع من غيره يصحح بتسوية أو تسمية')}
          </div>
          <div className="table-wrapper">
            <table className="table">
              <thead><tr><th>{tr('الصنف')}</th><th>{tr('المكان')}</th><th>{tr('التشغيلة')}</th><th>{tr('الدلو')}</th><th>{tr('العجز')}</th></tr></thead>
              <tbody>
                {groups.flatMap((g) => g.rows.map((r, k) => (
                  <tr key={`${g.productId}-${k}`}>
                    {k === 0 && <td rowSpan={g.rows.length} className="align-top font-semibold">{g.productName ?? '—'}</td>}
                    <td>{placeName(r, tr)}</td>
                    <td>
                      {r.lotId ? (
                        <button type="button" className="text-[#C94E28] font-semibold" onClick={() => onOpen(r.lotId!)}><bdi dir="ltr">{r.lotNumber ?? r.lotId}</bdi></button>
                      ) : tr('غير مسمى')}
                    </td>
                    <td>{tr(LOT_BUCKET_LABELS[r.bucket] ?? r.bucket)}</td>
                    <td className="tabular-nums text-red-600 font-semibold" dir={lotQtyDir(lotRowProduct(r))}>{lotQtyText(r.qty, lotRowProduct(r), fmtQ)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ ورقة PDF لشاشة التتبّع ═══

const SHEET: React.CSSProperties = {
  width: 794, minHeight: 1000, background: '#fff', padding: 40, boxSizing: 'border-box',
  fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif", color: '#1f2937', direction: 'rtl',
};

/** «تتبّع التشغيلة» ورقةً A4: البطاقة، والمجاميع، والأماكن، والعملاء فاتورةً فاتورة، والسجل — من ردّ الشاشة نفسه بلا طلبٍ ثانٍ */
const LotTraceDoc = forwardRef<HTMLDivElement, { trace: LotTraceDto; company: CompanyCfg; prod: LotUnitProduct | null }>(({ trace, company, prod }, ref) => {
  const tr = useTr();
  const brand = company?.primaryColor || '#1e3a8a';
  const t = traceTotals(trace);
  const th: React.CSSProperties = { background: brand, color: '#fff', padding: '7px 5px', fontSize: 11, fontWeight: 600, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '6px 5px', fontSize: 10.5, textAlign: 'center', borderBottom: '1px solid #eef2f7' };
  const box: React.CSSProperties = { flex: 1, background: '#f8fafc', borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.9 };
  const lot = trace.lot;
  return (
    <div ref={ref} style={SHEET}>
      <Header title={tr('تتبع التشغيلة')} company={company} />
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <div style={box}>
          <div><b>{tr('رقم التشغيلة')}:</b> <bdi dir="ltr">{lot.lotNumber}</bdi></div>
          <div><b>{tr('الصنف')}:</b> {lot.productName}</div>
          <div><b>{tr('تاريخ الإنتاج')}:</b> {dayText(lot.productionDate)} · <b>{tr('تاريخ الانتهاء')}:</b> {dayText(lot.expiryDate)}</div>
          <div><b>{tr('الحالة')}:</b> {tr(lotStatusLabel(lot))}</div>
        </div>
        <div style={box}>
          <div><b>{tr('النطاق')}:</b> {trace.scope === 'BROAD' ? tr('النطاق الموسع') : tr('النطاق الدقيق')}</div>
          <div><b>{tr('المباع')}:</b> {lotQtyUnitText(t.sold, prod, fmtQ)} · <b>{tr('المرتجع')}:</b> {lotQtyText(t.returned, prod, fmtQ)} · <b>{tr('الصافي')}:</b> {lotQtyText(t.net, prod, fmtQ)}</div>
          <div><b>{tr('عدد العملاء')}:</b> {t.customers} · <b>{tr('عدد الفواتير')}:</b> {t.invoices}</div>
          <div><b>{tr('تاريخ التقرير')}:</b> {formatDateTime(new Date())}</div>
        </div>
      </div>
      {trace.scoped && <p style={{ fontSize: 11, color: '#92400E', margin: '0 0 10px' }}>{tr('النتيجة مقيدة بنطاقك')}</p>}

      <p style={{ fontWeight: 700, color: brand, margin: '6px 0' }}>{tr('الأماكن')}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
        <thead><tr>
          <th style={th}>{tr('المكان')}</th>
          {TRACE_PLACE_COLUMNS.map((c) => <th key={c.label} style={th}>{tr(c.label)}</th>)}
        </tr></thead>
        <tbody>
          {trace.places.map((p, i) => (
            <tr key={i}>
              <td style={{ ...td, textAlign: 'right' }}>{placeName(p, tr)}{p.approximate ? ` (${tr('تقريبي')})` : ''}</td>
              {TRACE_PLACE_COLUMNS.map((c) => <td key={c.label} style={c.strong ? { ...td, fontWeight: 700 } : td}>{placeQtyText(c, p, prod)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      {trace.customers && trace.customers.length > 0 && (
        <>
          <p style={{ fontWeight: 700, color: brand, margin: '6px 0' }}>{tr('العملاء الذين وصلتهم التشغيلة')}</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
            <thead><tr>
              <th style={th}>{tr('العميل')}</th><th style={th}>{tr('الجوال')}</th><th style={th}>{tr('الفاتورة')}</th><th style={th}>{tr('التاريخ')}</th>
              <th style={th}>{tr('المباع')}</th><th style={th}>{tr('المرتجع')}</th><th style={th}>{tr('الصافي')}</th><th style={th}>{tr('اليقين')}</th>
            </tr></thead>
            <tbody>
              {trace.customers.flatMap((c) => c.invoices.map((inv) => (
                <tr key={`${c.customerId}-${inv.invoiceId}`}>
                  <td style={{ ...td, textAlign: 'right' }}>{c.name}{c.city ? ` · ${c.city}` : ''}</td>
                  <td style={td} dir="ltr">{c.phone ?? ''}</td>
                  <td style={td}>{inv.number}{inv.broad ? ` (${tr('النطاق الموسع')})` : ''}</td>
                  <td style={td}>{formatDate(inv.date)}</td>
                  <td style={td}>{lotQtyText(inv.sold, prod, fmtQ)}</td><td style={td}>{lotQtyText(inv.returned, prod, fmtQ)}</td><td style={{ ...td, fontWeight: 700 }}>{lotQtyText(inv.net, prod, fmtQ)}</td>
                  <td style={td}>{tr(LOT_CERTAINTY_LABELS[inv.weakest] ?? inv.weakest)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </>
      )}
      {trace.customersHidden && <p style={{ fontSize: 11, color: '#6b7280' }}>{tr('قائمة العملاء تتطلب صلاحية العملاء')}</p>}

      {trace.events.length > 0 && (
        <>
          <p style={{ fontWeight: 700, color: brand, margin: '6px 0' }}>{tr('سجل التشغيلة')}</p>
          {trace.events.map((e, i) => (
            <div key={i} style={{ fontSize: 10.5, borderBottom: '1px solid #eef2f7', padding: '4px 0' }}>
              {formatDateTime(e.at)} — {eventKindLabel(e.kind, tr)}{e.actorName ? ` · ${e.actorName}` : ''}{e.reason ? ` · ${e.reason}` : ''}
            </div>
          ))}
        </>
      )}
      <div style={{ marginTop: 24, textAlign: 'center', color: '#9ca3af', fontSize: 11, borderTop: '1px solid #eef2f7', paddingTop: 10 }}>
        {company?.name || ''}
      </div>
    </div>
  );
});
LotTraceDoc.displayName = 'LotTraceDoc';
