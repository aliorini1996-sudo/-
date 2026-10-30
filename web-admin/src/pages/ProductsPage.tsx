import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productApi, companyApi, lotsApi } from '../api/client';
import { zatcaCollectOn, type ZatcaCompanyLike } from '../lib/zatcaRegime';
import { Product } from '../types';
import { formatCurrency, formatNumber, statusLabels } from '../utils/format';
import { unitPriceOf } from '../lib/units';
import { useTr } from '../i18n/strings';
import { Plus, Search, Edit, Trash2, ChevronLeft, ChevronRight, Layers, X, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import ProductModal from '../components/forms/ProductModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import { useAuthStore } from '../store/authStore';
import { lotFlagsOf, type LotTrackingRequest, type LotTrackingResultDto } from '../lib/lots';
import { attentionRows, trackingBalanceOf, trackingRequest, type AttentionRow, type TrackingBalanceProduct } from '../lib/lotTrackingUi';

/** حمولة حفظ الصنف — والتأكيد بعد 409 LOT_TRACKING_HAS_BALANCE (D9) */
type ProductSave = Partial<Product> & { confirmLotBalances?: boolean };
/** تأكيد إطفاء التتبّع بأرصدة مسمّاة (D9): لصنفٍ من نافذته، أو للتفعيل الجماعي */
type BalanceConfirm =
  | { kind: 'product'; values: ProductSave; products: TrackingBalanceProduct[] }
  | { kind: 'bulk'; req: LotTrackingRequest; products: TrackingBalanceProduct[]; updated: number };

export default function ProductsPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  // «تتبّع اللوط» — فلتر الفئة والتحديد الجماعي ونوافذه، كلها خلف علم الشركة (§١٠.١)
  const [categoryId, setCategoryId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [bulkScope, setBulkScope] = useState<'selected' | 'category' | 'all'>('selected');
  const [bulkAsk, setBulkAsk] = useState<LotTrackingRequest | null>(null);
  const [balanceConfirm, setBalanceConfirm] = useState<BalanceConfirm | null>(null);
  const [attention, setAttention] = useState<AttentionRow[] | null>(null);

  // صفحة الأصناف كلّها أسعارٌ وضريبة: تُمنع مع المحاسبة، ولا يُطلَب جدولها أصلاً
  // (مسار /products يردّ ٤٠٣ فتظهر لافتة خطأ — واللافتة نفسها تسريب).
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  // فوترة ZATCA (Z5.1a): الفئة الضريبية في بطاقة الصنف للشركة التي تجمع بيانات الفوترة وحدها
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: async () => { const res = await companyApi.get(); return res.data.data as ZatcaCompanyLike & { lotTrackingEnabled?: boolean }; },
  });
  const zatcaCollect = zatcaCollectOn(company);
  // «تتبّع اللوط»: مطفأ ⇒ الصفحة كما كانت حرفياً (لا عمود ولا فلتر ولا طلب). والتفعيل الجماعي بصلاحية مخزون السيارات أيضاً
  // (routes/lots.ts: canManageVanStock على الموجّه، وcanManageProducts على المسار)
  const lotOn = lotFlagsOf(company).on;
  const user = useAuthStore(s => s.user);
  const canBulk = lotOn && user?.canManageVanStock !== false;
  const catFilter = lotOn ? categoryId : '';

  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
    enabled: lotOn,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['products', search, page, ...(catFilter ? [catFilter] : [])],
    queryFn: async () => {
      const res = await productApi.list({ search, page, limit: 15, ...(catFilter ? { categoryId: catFilter } : {}) });
      return res.data as { data: Product[]; pagination: { total: number; pages: number } };
    },
    enabled: accountingReady && accountingOn,
  });

  const saveMutation = useMutation({
    mutationFn: (values: ProductSave) =>
      selected ? productApi.update(selected.id, values) : productApi.create(values),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); toast.success(selected ? tr('تم التحديث') : tr('تم الإضافة')); setShowModal(false); setSelected(null); setBalanceConfirm(null); },
    // رسالة الخادم لا «حدث خطأ» العمياء — سبب الرفض (تحقق/تكرار كود) يصل للمستخدم
    onError: (err: unknown, values) => {
      // إطفاء تتبّع صنفٍ له أرصدة في تشغيلات (D9): تأكيدٌ بالتفاصيل ثم الإرسال نفسه بـconfirmLotBalances
      const bal = selected ? trackingBalanceOf(err) : null;
      if (bal && !values.confirmLotBalances) { setBalanceConfirm({ kind: 'product', values, products: bal.products }); return; }
      setBalanceConfirm(null);
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => productApi.remove(id),
    onSuccess: (res: { data?: { archived?: boolean } }) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      // الأرشفة تطمئن المستخدم صراحة أن فواتير الصنف وكشوفه القديمة لم تمس
      toast.success(res?.data?.archived ? tr('حذف الصنف من القوائم فواتيره وكشوفه القديمة باقية كما هي') : tr('تم حذف الصنف'));
      setDeleting(null);
    },
    onError: (err: unknown) => {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حذف الصنف'));
      setDeleting(null);
    },
  });

  // التفعيل والإطفاء الجماعي (POST /lots/products/tracking): بعد التفعيل نافذة «يحتاج انتباهاً» بالسالب وغير المسمّى (إجراء يوم التفعيل)
  const bulkMutation = useMutation({
    mutationFn: async (req: LotTrackingRequest) => (await lotsApi.setTracking(req)).data.data as LotTrackingResultDto,
    onSuccess: (res, req) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      setBulkAsk(null); setBalanceConfirm(null); setPicked(new Set());
      toast.success(`${tr('تم تحديث تتبع اللوط')} — ${formatNumber(res?.updated ?? 0)} ${tr('صنف')}`);
      const rows = req.enabled ? attentionRows(res) : [];
      if (rows.length) setAttention(rows);
    },
    onError: (err: unknown, req) => {
      setBulkAsk(null);
      const bal = trackingBalanceOf(err);
      if (bal && !req.enabled && !req.confirmLotBalances) {
        // الدفعات السابقة التزمت (updated) — والتأكيد يعيد الطلب نفسه فيكمل ما بقي
        if (bal.updated > 0) qc.invalidateQueries({ queryKey: ['products'] });
        setBalanceConfirm({ kind: 'bulk', req, products: bal.products, updated: bal.updated });
        return;
      }
      setBalanceConfirm(null);
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('حدث خطأ'));
    },
  });

  const askBulk = (enabled: boolean) => {
    const scope = bulkScope === 'selected' ? { kind: 'selected' as const, ids: [...picked] }
      : bulkScope === 'category' ? { kind: 'category' as const, categoryId: catFilter }
        : { kind: 'all' as const };
    const req = trackingRequest(scope, enabled);
    if (!req) { toast.error(bulkScope === 'selected' ? tr('حدد صنفا واحدا على الأقل') : tr('اختر الفئة من الفلتر أولا')); return; }
    setBulkAsk(req);
  };

  if (!accountingReady) return null;
  if (!accountingOn) return <AccountingOffNotice />;

  const rows = data?.data ?? [];
  const pageIds = rows.map(p => p.id);
  const allPicked = pageIds.length > 0 && pageIds.every(id => picked.has(id));
  const togglePick = (id: string) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = () => setPicked(s => { const n = new Set(s); for (const id of pageIds) { if (allPicked) n.delete(id); else n.add(id); } return n; });
  const cols = 8 + (lotOn ? 1 : 0) + (canBulk ? 1 : 0);
  const scopeLabel = (req: LotTrackingRequest) => req.productIds ? `${formatNumber(req.productIds.length)} ${tr('صنف محدد')}`
    : req.categoryId ? `${tr('أصناف الفئة')} «${categories?.find(c => c.id === req.categoryId)?.name ?? ''}»` : tr('كل أصناف الشركة');

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('إدارة المنتجات')}</h1>
        <button className="btn-primary" onClick={() => { setSelected(null); setShowModal(true); }}><Plus size={16} />{tr('إضافة صنف')}</button>
      </div>

      <div className="card mb-4">
        <div className={lotOn ? 'flex flex-wrap items-center gap-2' : undefined}>
          <div className="relative">
            <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9 max-w-sm" placeholder={tr('بحث بالاسم أو الكود أو الباركود')}
              value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          {lotOn && (
            <select className="input w-auto max-w-[14rem]" value={categoryId} aria-label={tr('الفئة')}
              onChange={e => { setCategoryId(e.target.value); setPage(1); if (!e.target.value && bulkScope === 'category') setBulkScope('selected'); }}>
              <option value="">{tr('كل الفئات')}</option>
              {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        {/* التفعيل الجماعي لتتبّع اللوط — للمحدد أو الفئة المعروضة أو كل الأصناف */}
        {canBulk && (
          <div className="mt-3 pt-3 border-t border-[#F1EBDF] flex flex-wrap items-center gap-2" data-lot-bulk="">
            <span className="text-sm font-semibold text-[#1F1A13] flex items-center gap-1.5"><Layers size={15} className="text-[#E15A30]" /> {tr('تتبع باللوط')}</span>
            <select className="input w-auto py-1.5 text-sm" value={bulkScope} aria-label={tr('نطاق التفعيل')}
              onChange={e => setBulkScope(e.target.value as typeof bulkScope)}>
              <option value="selected">{tr('الأصناف المحددة')} ({formatNumber(picked.size)})</option>
              {catFilter && <option value="category">{tr('أصناف الفئة المعروضة')}</option>}
              <option value="all">{tr('كل أصناف الشركة')}</option>
            </select>
            <button type="button" className="btn-primary py-1.5 text-sm" disabled={bulkMutation.isPending} onClick={() => askBulk(true)}>{tr('تفعيل التتبع')}</button>
            <button type="button" className="btn-secondary py-1.5 text-sm" disabled={bulkMutation.isPending} onClick={() => askBulk(false)}>{tr('إطفاء التتبع')}</button>
            {picked.size > 0 && (
              <button type="button" className="text-xs text-[#6E6557] hover:text-[#1F1A13] flex items-center gap-1" onClick={() => setPicked(new Set())}>
                <X size={12} /> {tr('إلغاء التحديد')}
              </button>
            )}
            <p className="basis-full text-[11px] text-[#6E6557] leading-relaxed">
              {tr('قبل تفعيل الأصناف صحح الأرصدة السالبة بتسوية موجبة ثم سم رصيد المستودع والسيارات من شاشة تتبع اللوط')}
            </p>
          </div>
        )}
      </div>

      <div className="card p-0">
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                {canBulk && (
                  <th className="w-8"><input type="checkbox" className="w-4 h-4 accent-[#E15A30]" aria-label={tr('تحديد أصناف الصفحة')}
                    checked={allPicked} onChange={togglePage} disabled={!pageIds.length} /></th>
                )}
                <th>{tr('الكود')}</th><th>{tr('اسم الصنف')}</th><th>{tr('الفئة')}</th><th>{tr('الوحدة')}</th><th>{tr('السعر الأساسي')}</th><th>{tr('الضريبة %')}</th>
                {lotOn && <th>{tr('التشغيلة')}</th>}
                <th>{tr('الحالة')}</th><th>{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={cols} className="text-center py-12 text-gray-400">{tr('جاري التحميل')}</td></tr>
              ) : data?.data.map(p => (
                <tr key={p.id}>
                  {canBulk && (
                    <td><input type="checkbox" className="w-4 h-4 accent-[#E15A30]" aria-label={p.name}
                      checked={picked.has(p.id)} onChange={() => togglePick(p.id)} /></td>
                  )}
                  <td className="font-mono text-xs text-gray-500">{p.code}</td>
                  <td>
                    <p className="font-medium text-gray-800">{p.name}</p>
                    {p.barcode && <p className="text-xs text-gray-400 font-mono">{p.barcode}</p>}
                  </td>
                  <td className="text-gray-500 text-sm">{p.category?.name || '-'}</td>
                  <td className="text-gray-600">
                    {p.unit}
                    {/* وحدات البيع الأكبر بمعاملها وسعرها («كرتون 24 = 48.00») — السعر الأساسي بجانبها لوحدة الأساس */}
                    {(p.units ?? []).filter(u => u.isActive !== false).map(u => (
                      <span key={u.id} className="block text-[11px] text-gray-400 whitespace-nowrap">
                        {u.name} {Number(u.factor)} = {formatCurrency(unitPriceOf({ name: u.name, factor: Number(u.factor), price: u.price ?? undefined }, p.basePrice))}
                      </span>
                    ))}
                  </td>
                  <td className="font-semibold text-[#E15A30]">{formatCurrency(p.basePrice)}</td>
                  <td className="text-gray-600">{p.taxPct}%</td>
                  {lotOn && (
                    <td>
                      {p.lotTracked === true
                        ? <span className="text-[11px] font-semibold text-[#C94E28] bg-[#FBEBE2] border border-[#F2CDBE] rounded px-1.5 py-0.5" data-lot-badge="">{tr('لوط')}</span>
                        : <span className="text-gray-300">-</span>}
                    </td>
                  )}
                  <td><span className={p.status === 'ACTIVE' ? 'badge-active' : 'badge-inactive'}>{tr(statusLabels[p.status])}</span></td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setSelected(p); setShowModal(true); }} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Edit size={14} /></button>
                      <button onClick={() => setDeleting(p)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title={tr('حذف الصنف')}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">{data.pagination.total} {tr('صنف')}</p>
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronRight size={16} /></button>
              <span className="text-sm text-gray-600 px-2">{page} / {data.pagination.pages}</span>
              <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page >= data.pagination.pages} onClick={() => setPage(p => p + 1)}><ChevronLeft size={16} /></button>
            </div>
          </div>
        )}
      </div>

      {showModal && (
        <ProductModal
          zatcaCollect={zatcaCollect}
          lotTrackingOn={lotOn}
          product={selected}
          onClose={() => { setShowModal(false); setSelected(null); }}
          onSave={saveMutation.mutate}
          loading={saveMutation.isPending}
        />
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف الصنف')}
          message={`${tr('سيتم حذف الصنف')} «${deleting.name}» ${tr('من كل القوائم ولن يمكن بيعه في فواتير جديدة فواتيره وسنداته وكشوفه القديمة تبقى كما هي بالاسم نفسه ولا يمكن التراجع عن الحذف')}`}
          confirmLabel={tr('حذف نهائي')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}

      {bulkAsk && (
        <ConfirmDialog
          title={bulkAsk.enabled ? tr('تفعيل تتبع اللوط') : tr('إطفاء تتبع اللوط')}
          message={`${bulkAsk.enabled ? tr('سيفعل تتبع اللوط لـ') : tr('سيطفأ تتبع اللوط لـ')} ${scopeLabel(bulkAsk)} — ${bulkAsk.enabled
            ? tr('الرصيد القائم يبقى غير مسمى حتى تسميه والمندوب يصرف الأقرب انتهاء تلقائيا')
            : tr('الإطفاء يخفي التشغيلات ولا يحذفها')}`}
          confirmLabel={bulkAsk.enabled ? tr('تفعيل التتبع') : tr('إطفاء التتبع')}
          loading={bulkMutation.isPending}
          onConfirm={() => bulkMutation.mutate(bulkAsk)}
          onClose={() => setBulkAsk(null)}
        />
      )}

      {/* D9: إطفاء التتبّع والأصناف لها أرصدة في تشغيلات — تأكيدٌ صريح بالتفاصيل، والإطفاء يُخفي ولا يحذف */}
      {balanceConfirm && (
        <ConfirmDialog
          danger
          title={tr('للصنف أرصدة في تشغيلات')}
          message={tr('إطفاء التتبع يخفي هذه التشغيلات ولا يحذفها وإعادة التفعيل لاحقا تبدأ حقبة جديدة تصير فيها الأرصدة غير مسماة حتى تسمى')}
          extra={(
            <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-[#E9E1D3] divide-y divide-[#F1EBDF] text-start text-xs" data-lot-balances="">
              {balanceConfirm.kind === 'bulk' && balanceConfirm.updated > 0 && (
                <p className="px-3 py-2 text-[#6E6557]">{tr('أطفئ التتبع لأصناف بلا أرصدة')}: {formatNumber(balanceConfirm.updated)}</p>
              )}
              {balanceConfirm.products.map(b => (
                <div key={b.productId} className="px-3 py-2">
                  <p className="font-semibold text-[#1F1A13]">{b.name ?? '-'}</p>
                  <p className="text-[#6E6557]">
                    {tr('المستودع')} {formatNumber(b.warehouse)}
                    {b.vans.length > 0 && <> · {tr('في سيارات المناديب')} {formatNumber(b.vans.reduce((s, v) => s + v.qty, 0))} ({formatNumber(b.vans.length)})</>}
                  </p>
                </div>
              ))}
            </div>
          )}
          confirmLabel={tr('أكد الإطفاء')}
          loading={saveMutation.isPending || bulkMutation.isPending}
          onConfirm={() => {
            if (balanceConfirm.kind === 'product') saveMutation.mutate({ ...balanceConfirm.values, confirmLotBalances: true });
            else bulkMutation.mutate({ ...balanceConfirm.req, confirmLotBalances: true });
          }}
          onClose={() => setBalanceConfirm(null)}
        />
      )}

      {attention && <LotAttentionModal rows={attention} onClose={() => setAttention(null)} />}
    </div>
  );
}

/**
 * بعد التفعيل الجماعي: الأصناف التي يبقى رصيدها كله أو بعضه غير مسمّى، أو لها رصيد سالب في مكانٍ ما (§٤.٢، إجراء يوم التفعيل):
 * السالب يُصحَّح بتسويةٍ موجبة غير مسمّاة أولاً (لا يُنقص غير المسمّى السالب)، ثم تُسمّى أرصدة المستودع والسيارات من شاشة التتبّع.
 * البيع لا يتوقّف: غير المسمّى يُصرف بعد نفاد المسمّى (D17).
 */
function LotAttentionModal({ rows, onClose }: { rows: AttentionRow[]; onClose: () => void }) {
  const tr = useTr();
  const negatives = rows.filter(r => r.negative).length;
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Layers size={18} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('أصناف تحتاج تسمية رصيدها')}</h2>
              <p className="text-xs text-[#6E6557]">{formatNumber(rows.length)} {tr('صنف')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <ol className="text-xs text-[#6E6557] space-y-1 leading-relaxed list-decimal ps-4">
            {negatives > 0 && <li>{tr('صحح الأرصدة السالبة بتسوية موجبة غير مسماة')}</li>}
            <li>{tr('سم رصيد المستودع ثم السيارات من شاشة تتبع اللوط تسمية الرصيد القائم')}</li>
            <li>{tr('البيع لا يتوقف الرصيد غير المسمى يصرف بعد نفاد التشغيلات المسماة')}</li>
          </ol>
          <div className="rounded-xl border border-[#E9E1D3] divide-y divide-[#F1EBDF] text-sm" data-lot-attention="">
            {rows.map(r => (
              <div key={r.productId} className="px-3 py-2">
                <p className="font-semibold text-[#1F1A13] flex items-center gap-2">
                  {r.name || '-'}
                  {r.negative && (
                    <span className="text-[10px] font-semibold text-[#C0392B] bg-[#FBE3DF] rounded px-1.5 py-0.5 flex items-center gap-1">
                      <AlertTriangle size={10} /> {tr('رصيد سالب')}
                    </span>
                  )}
                </p>
                {r.warehouse && (
                  <p className="text-xs text-[#6E6557]">
                    {tr('المستودع')}: {formatNumber(r.warehouse.total)} · {tr('غير مسمى')} {formatNumber(r.warehouse.unknown)}
                  </p>
                )}
                {r.vans.length > 0 && (
                  <p className="text-xs text-[#6E6557]">
                    {tr('في سيارات المناديب')} ({formatNumber(r.vans.length)}): {formatNumber(r.vans.reduce((s, v) => s + v.total, 0))} · {tr('غير مسمى')} {formatNumber(r.vans.reduce((s, v) => s + v.unknown, 0))}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3] shrink-0">
          <Link to="/app/lots" className="btn-primary flex-1 justify-center py-2.5">{tr('تسمية الرصيد القائم')}</Link>
          <button onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>
    </div>
  );
}
