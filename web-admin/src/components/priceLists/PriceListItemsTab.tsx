import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from 'lucide-react';
import { priceListApi, productApi } from '../../api/client';
import type { PriceListItemRow } from '../../types';
import { useTr } from '../../i18n/strings';
import { activeLocale, formatNumber } from '../../utils/format';
import {
  PRICE_LIST_ITEMS_PAGE, failedItemRowsOf, fillText, isUnitsChangedCode, itemCommitOf, itemShownPrice, itemsPageClampOf, itemsPageOf,
  itemsPagerShown, pricedChangedOf, savedItemsOf, syncItemsCacheAfterSave, type ItemsPage, type ItemsScope,
} from '../../lib/priceListEditor';
import { PRICE_RULE_MESSAGES } from '../../lib/priceRules';

/**
 * تبويب «أسعار الأصناف» في محرّر القائمة: سعر الصنف الثابت في القائمة (PriceListItem) صافياً قبل الضريبة **بالوحدة الرئيسية**
 * (الأساس بلاها) — صفحةٌ من الخادم (GET /price-lists/:id/items) ببحثٍ وفئةٍ و«المسعّرة في القائمة | كل الأصناف» («إضافة صنف»
 * يفتح الثانية ويركّز البحث).
 *
 * الحفظ تلقائيّ لكل سطر عند Enter أو الخروج من خانته (PUT /price-lists/:id/items بسطرٍ واحد ومعه أساس الصنف ورئيسيّته كما
 * عُرضا — 409 إن تغيّرا) والفارغ يحذف. وخطأ الخادم تحت سطره وفي قائمة أخطاءٍ ثابتة أعلى التبويب باسم الصنف (تبقى ولو غاب السطر
 * عن الصفحة أو البحث). فالنافذة تبقى «كل عمليةٍ تحفظ بنفسها»: وما بقي مكتوباً حين يُفكّ التبويب (رجوع، تبديل التبويب، إغلاق
 * النافذة) يُرسل بعد الفكّ سطراً سطراً وتقول نتيجتَه رسالةٌ باسم الصنف.
 * سطرٌ يُحفظ والمستخدم يكتب فيه ثانيةً: الجديد يُرسل بعد انتهاء الأول (لا طلبان متسابقان للصنف نفسه).
 * وحفظٌ يُدخل صنفاً «المسعّرة في القائمة» أو يخرجه منها يعيد الصفحات المعروضة من الخادم (pricedChangedOf)، وجلبٌ جارٍ لحظة ردّ
 * الحفظ يُلغى ويُعاد فلا يكتب فوق السعر المحفوظ ما قرأه قبله (syncItemsCacheAfterSave). وصفحةٌ صارت بعد آخر صفحة تُنقل إليها.
 * و٤٠٩ «تغيّرت وحدات الصنف»: المكتوب كُتب بالوحدات القديمة فيُسقط، ويُعاد السطر من الخادم برسالته — لا يُرسل الرقم القديم بالوحدات
 * الجديدة أبداً، لا بالخروج من الخانة ولا عند الإغلاق (قرار D6).
 */
type Err = { response?: { data?: { message?: string; code?: string } } };
const serverMsg = (e: unknown): string | undefined => (e as Err)?.response?.data?.message;
const serverCode = (e: unknown): string | undefined => (e as Err)?.response?.data?.code;

type RowStatus = { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };

/** طلب صفحةٍ من أصناف القائمة — مشتركٌ مع منتقي الصنف في نموذج القاعدة (المفتاح نفسه ⇒ الكاش نفسه) */
export function priceListItemsQuery(listId: string, scope: ItemsScope, search: string, categoryId: string, page: number) {
  return {
    queryKey: ['price-list-items', listId, scope, search, categoryId, page],
    queryFn: async (): Promise<ItemsPage> => itemsPageOf((await priceListApi.listItems(listId, {
      scope, page, limit: PRICE_LIST_ITEMS_PAGE, ...(search ? { search } : {}), ...(categoryId ? { categoryId } : {}),
    })).data.data),
  };
}

export default function PriceListItemsTab({ listId, itemsCount }: { listId: string; itemsCount?: number }) {
  const tr = useTr();
  const qc = useQueryClient();
  // قائمةٌ بلا أصناف بعد: «كل الأصناف» مباشرةً (لا جدول فارغ)
  const [scope, setScope] = useState<ItemsScope>(() => (itemsCount === 0 ? 'all' : 'priced'));
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // البحث من الخادم بعد ٣٠٠ms من آخر حرف — ومعه الصفحة الأولى
  useEffect(() => {
    const v = search.trim();
    if (v === debounced) return;
    const t = setTimeout(() => { setDebounced(v); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search, debounced]);

  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
  });
  const itemsQ = useQuery({ ...priceListItemsQuery(listId, scope, debounced, categoryId, page), placeholderData: keepPreviousData });
  const rows = itemsQ.data?.rows ?? [];
  const pages = itemsQ.data?.pagination.pages ?? 1;
  const total = itemsQ.data?.pagination.total ?? 0;
  // صفحةٌ لم تعد موجودة (حُذف آخر صنفٍ في الصفحة الأخيرة من «المسعّرة»): الخادم يردّها فارغةً بصفحاتٍ أقلّ فتُنقل إلى آخر صفحة —
  // ببياناتها الحقيقية المستقرّة وحدها (لا البديلة أثناء تبديل الصفحة، ولا المخبّأة وجلبُها الجديد جارٍ)
  useEffect(() => {
    const d = itemsQ.data;
    if (!d || itemsQ.isPlaceholderData || itemsQ.isFetching) return;
    const to = itemsPageClampOf(page, d.pagination.pages);
    if (to !== page) setPage(to);
  }, [itemsQ.data, itemsQ.isPlaceholderData, itemsQ.isFetching, page]);

  // ─── الحفظ التلقائي: المسودّات (ما كُتب ولم يُحفظ) والحالة لكل صنف — والمراجع تبقى بعد الفكّ لإرسال ما بقي ───
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const draftsRef = useRef<Record<string, string>>({});
  /** آخر ما يُعرف من كل صنف (المحفوظ في الخادم) — يُقارن به المكتوب */
  const rowsRef = useRef(new Map<string, PriceListItemRow>());
  /** صنفٌ يُحفظ الآن ⇒ ما كُتب أثناءه يُرسل بعده */
  const inflight = useRef(new Set<string>());
  const queued = useRef(new Set<string>());
  const mounted = useRef(true);
  const wrote = useRef(false);
  const trRef = useRef(tr);
  trRef.current = tr;
  useEffect(() => { for (const r of itemsQ.data?.rows ?? []) rowsRef.current.set(r.productId, r); }, [itemsQ.data]);

  const setDraft = (pid: string, v: string | undefined) => {
    const next = { ...draftsRef.current };
    if (v === undefined) delete next[pid]; else next[pid] = v;
    draftsRef.current = next;
    if (mounted.current) setDrafts(next);
  };
  const setRowStatus = (pid: string, s: RowStatus | undefined) => {
    if (!mounted.current) return;
    setStatus(m => { const n = { ...m }; if (s) n[pid] = s; else delete n[pid]; return n; });
  };
  /**
   * بعد كل كتابة: عدّادات القوائم، وأسعار الأصناف في فاتورة الإدارة ونافذة الصنف، وبقية صفحات الجدول عند فتحها. وصنفٌ دخل
   * «المسعّرة» أو خرج منها ⇒ الصفحات المعروضة الآن تُعاد من الخادم — فصفحة «المسعّرة» المخبّأة لا تبقى بلا الصنف المضاف من
   * «كل الأصناف» والمستخدم ينتقل إليها مباشرةً. وجلبٌ لصفحات القائمة جارٍ لحظة الردّ قد قرأ قبل التزام الحفظ: يُلغى ويُعاد،
   * فلا يهبط بالسعر القديم فوق المحفوظ (syncItemsCacheAfterSave)
   */
  const afterWrite = (saved: Array<{ productId: string; listPrice: number | null }>) => {
    const pricedChanged = pricedChangedOf(saved, pid => rowsRef.current.get(pid)?.listPrice);
    for (const s of saved) {
      const r = rowsRef.current.get(s.productId);
      if (r) rowsRef.current.set(s.productId, { ...r, listPrice: s.listPrice });
    }
    syncItemsCacheAfterSave(qc, listId, saved, pricedChanged);
    qc.invalidateQueries({ queryKey: ['price-lists'] });
    qc.invalidateQueries({ queryKey: ['price-list-rules'] });
    qc.invalidateQueries({ queryKey: ['products-all'] });
    // جدول المنتجات خلف النافذة (لقطة listPrices لنافذة الصنف): يُعلَّم قديماً مع كل سطر ويُعاد جلبه مرّةً عند الفكّ
    wrote.current = true;
    qc.invalidateQueries({ queryKey: ['products'], refetchType: mounted.current ? 'none' : 'active' });
  };

  const send = (pid: string, raw: string) => {
    const row = rowsRef.current.get(pid);
    if (!row) return;
    // يُحفظ الآن: يُقارَن الجديد بما يردّه الحفظ الجاري لا بما قبله (كُتب ٩٠ ثم أُعيد ١٠٠ قبل الردّ ⇒ يُرسل ١٠٠ بعده)
    if (inflight.current.has(pid)) { queued.current.add(pid); return; }
    const c = itemCommitOf(row, raw);
    if (c.kind === 'same') {
      if (draftsRef.current[pid] === raw) setDraft(pid, undefined);
      setRowStatus(pid, undefined);
      return;
    }
    if (c.kind === 'invalid') { setRowStatus(pid, { state: 'error', message: trRef.current(c.problem) }); return; }
    const write = c.write;
    inflight.current.add(pid);
    setRowStatus(pid, { state: 'saving' });
    priceListApi.saveItems(listId, [write])
      .then((res) => {
        afterWrite(savedItemsOf(res.data?.data, [write]));
        if (draftsRef.current[pid] === raw) setDraft(pid, undefined);
        setRowStatus(pid, { state: 'saved' });
        if (!mounted.current) toast.success(`${row.name}: ${trRef.current('تم الحفظ')}`);
      })
      .catch((e) => {
        const msg = serverMsg(e) ? trRef.current(serverMsg(e) as string) : trRef.current('تعذر الحفظ');
        setRowStatus(pid, { state: 'error', message: msg });
        // وحدات الصنف تغيّرت بعد التحميل: ما كُتب كان بالوحدة القديمة فيُسقط (ومعه ما كُتب أثناء الحفظ) — لا يُعاد إرساله بأساسٍ
        // ورئيسيةٍ جديدين عند الخروج من الخانة أو الإغلاق — ويُعاد الجدول بوحداته الحالية وتبقى رسالة الخادم تحت السطر
        if (isUnitsChangedCode(serverCode(e))) {
          queued.current.delete(pid);
          setDraft(pid, undefined);
          qc.invalidateQueries({ queryKey: ['price-list-items', listId] });
        }
        // بعد الفكّ لا جدول: الرسالة باسم الصنف لا نصّ الخادم وحده
        if (!mounted.current) toast.error(`${row.name}: ${msg}`);
      })
      .finally(() => {
        inflight.current.delete(pid);
        if (queued.current.delete(pid)) {
          const latest = draftsRef.current[pid];
          if (latest !== undefined) send(pid, latest);
        }
      });
  };
  const commit = (r: PriceListItemRow) => {
    const raw = draftsRef.current[r.productId];
    if (raw === undefined) return;
    if (!rowsRef.current.has(r.productId)) rowsRef.current.set(r.productId, r);
    send(r.productId, raw);
  };
  /**
   * الفكّ (رجوع، تبديل التبويب، إغلاق النافذة) وفي الخانات ما لم يُحفظ: كل سطرٍ بطلبه كالحفظ العادي (معاملةٌ لكلٍّ — سطرٌ تغيّرت
   * وحداته لا يُسقط غيره)، ونتيجته رسالةٌ باسم الصنف بعد غياب الجدول. وما يُحفظ الآن يُرسل جديده بعده، والتالف يُقال بأسماء
   * أصنافه لا يُسكت عنه
   */
  const flushOnUnmount = () => {
    const invalid: string[] = [];
    for (const [pid, raw] of Object.entries(draftsRef.current)) {
      const row = rowsRef.current.get(pid);
      if (!row) continue;
      if (inflight.current.has(pid)) { queued.current.add(pid); continue; }
      const c = itemCommitOf(row, raw);
      if (c.kind === 'invalid') invalid.push(row.name);
      if (c.kind === 'write') send(pid, raw);
    }
    if (invalid.length) toast.error(`${invalid.join('، ')}: ${trRef.current(PRICE_RULE_MESSAGES.price)}`);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flushOnUnmount();
      if (wrote.current) qc.invalidateQueries({ queryKey: ['products'] });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: KeyboardEvent<HTMLInputElement>, r: PriceListItemRow) => {
    if (e.key === 'Enter') {
      // Enter = حفظ السطر والانتقال للتالي (الخروج من الخانة يحفظها)
      e.preventDefault();
      const all = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>('input[data-list-item-price]') ?? []);
      const i = all.indexOf(e.currentTarget);
      if (i >= 0 && i + 1 < all.length) all[i + 1].focus(); else e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(r.productId, undefined);
      setRowStatus(r.productId, undefined);
    }
  };

  const fmtPrice = (n: number) => {
    try { return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 4 }).format(n); } catch { return String(n); }
  };
  const addProduct = () => {
    setScope('all');
    setPage(1);
    searchRef.current?.focus();
  };
  // قائمة الأخطاء الثابتة: كل سطرٍ لم يُحفظ باسم صنفه — «إظهار» يبحث عنه في «كل الأصناف»، و«تجاهل» يُسقط ما كُتب فيه (كـEscape)
  const failed = failedItemRowsOf(status, pid => rowsRef.current.get(pid));
  const showRow = (pid: string) => {
    const r = rowsRef.current.get(pid);
    setScope('all');
    setCategoryId('');
    setSearch(r?.code || r?.name || '');
    setPage(1);
  };
  const dismissRow = (pid: string) => {
    setDraft(pid, undefined);
    setRowStatus(pid, undefined);
  };
  const pricedTotal = itemsCount ?? itemsQ.data?.pricedCount;
  const filtered = !!debounced || !!categoryId;
  const toggle = (on: boolean) => `px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${on ? 'bg-white text-[#C94E28] shadow-sm' : 'text-[#6E6557] hover:text-[#1F1A13]'}`;

  return (
    <div className="space-y-3" data-price-list-items="">
      {failed.length > 0 && (
        <div className="sticky top-0 z-10 rounded-xl border border-red-200 bg-red-50 p-2.5 space-y-1.5 shadow-sm" aria-live="polite" data-list-item-errors="">
          <p className="text-xs font-semibold text-red-700 flex items-center gap-1.5"><AlertCircle size={14} className="shrink-0" /> {tr('لم يحفظ سعر هذه الأصناف')}</p>
          <ul className="space-y-1">
            {failed.map(f => (
              <li key={f.productId} className="flex items-start gap-2 text-[11px] text-red-700">
                <span className="min-w-0 flex-1 leading-snug break-words"><b>{f.name}</b>: {f.message}</span>
                <button type="button" className="shrink-0 font-semibold underline underline-offset-2 hover:text-red-900" onClick={() => showRow(f.productId)}>
                  {tr('إظهار')}
                </button>
                <button type="button" className="shrink-0 p-0.5 rounded hover:bg-red-100" aria-label={`${tr('تجاهل')} ${f.name}`} title={tr('تجاهل')}
                  onClick={() => dismissRow(f.productId)}><X size={13} /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 text-[#9A8F7E] pointer-events-none" style={{ insetInlineStart: 10 }} />
          <input ref={searchRef} className="input" style={{ paddingInlineStart: 32 }} value={search} onChange={e => setSearch(e.target.value)}
            placeholder={tr('بحث بالاسم أو الكود أو الباركود')} aria-label={tr('بحث بالاسم أو الكود أو الباركود')} />
        </div>
        {(categories?.length ?? 0) > 0 && (
          <select className="input w-auto max-w-[12rem]" value={categoryId} aria-label={tr('الفئة')}
            onChange={e => { setCategoryId(e.target.value); setPage(1); }}>
            <option value="">{tr('كل الفئات')}</option>
            {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="inline-flex rounded-xl bg-[#F3EEE6] p-1" role="radiogroup" aria-label={tr('أسعار الأصناف')}>
          <button type="button" role="radio" aria-checked={scope === 'priced'} className={toggle(scope === 'priced')}
            onClick={() => { setScope('priced'); setPage(1); }}>
            {tr('المسعرة في القائمة')}{pricedTotal != null ? ` (${formatNumber(pricedTotal)})` : ''}
          </button>
          <button type="button" role="radio" aria-checked={scope === 'all'} className={toggle(scope === 'all')}
            onClick={() => { setScope('all'); setPage(1); }}>
            {tr('كل الأصناف')}
          </button>
        </div>
        <button type="button" className="btn-primary !py-1.5 !px-3 text-xs" onClick={addProduct}><Plus size={14} /> {tr('إضافة صنف')}</button>
      </div>
      <p className="text-[11px] text-[#9A8F7E] leading-relaxed">
        {tr('السعر صاف قبل الضريبة بالوحدة الرئيسية، ويحفظ كل سطر عند Enter أو الخروج منه، والفارغ يحذف الصنف من القائمة')}
      </p>

      <div className="border border-[#E9E1D3] rounded-xl overflow-hidden bg-white">
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
          <span className="w-20 shrink-0">{tr('الكود')}</span>
          <span className="min-w-0 flex-1">{tr('الصنف')}</span>
          <span className="w-24 shrink-0 text-center">{tr('الوحدة الرئيسية')}</span>
          <span className="w-24 shrink-0 text-center">{tr('السعر الافتراضي')}</span>
          <span className="w-32 shrink-0 text-center">{tr('سعر القائمة')}</span>
          <span className="w-20 shrink-0 text-center">{tr('الحالة')}</span>
        </div>
        {itemsQ.isLoading ? (
          <p className="p-6 text-center text-sm text-gray-400">{tr('جار التحميل')}</p>
        ) : itemsQ.isError ? (
          <p className="p-6 text-center text-sm text-red-500">{tr('تعذر التحميل')}</p>
        ) : rows.length === 0 ? (
          scope === 'priced' && !filtered ? (
            <div className="p-6 text-center space-y-3">
              <p className="text-sm text-gray-400">{tr('لا أصناف مسعرة في هذه القائمة بعد')}</p>
              <button type="button" className="btn-secondary mx-auto !py-1.5 text-xs" onClick={addProduct}><Plus size={14} /> {tr('إضافة صنف')}</button>
            </div>
          ) : (
            <p className="p-6 text-center text-sm text-gray-400">{tr('لا أصناف مطابقة')}</p>
          )
        ) : (
          <div ref={listRef} className={`divide-y divide-[#F1EBDF] ${itemsQ.isPlaceholderData ? 'opacity-60' : ''}`}>
            {rows.map(r => {
              const draft = drafts[r.productId];
              const value = draft ?? itemShownPrice(r.listPrice);
              const st = status[r.productId];
              const dirty = draft !== undefined && itemCommitOf(r, draft).kind !== 'same';
              const unitName = r.primaryUnit?.name ?? r.unit;
              const unitText = r.primaryUnit ? `${unitName} (${formatNumber(r.primaryUnit.factor)} ${r.unit})` : unitName;
              return (
                <div key={r.productId} className="flex items-start gap-2 px-3 py-2" data-list-item-row="">
                  <span className="hidden sm:block w-20 shrink-0 pt-2 text-xs text-[#6E6557] truncate" dir="ltr" title={r.code}>{r.code}</span>
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm font-semibold text-[#1F1A13] truncate" title={r.name}>
                      {r.name}
                      {r.status && r.status !== 'ACTIVE' && <span className="badge-inactive ms-1.5 align-middle">{tr('غير نشط')}</span>}
                    </p>
                    <p className="sm:hidden text-[11px] text-[#9A8F7E] truncate">
                      {[r.code, unitText, `${tr('السعر الافتراضي')} ${fmtPrice(r.defaultPrice)}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="hidden sm:block w-24 shrink-0 pt-2 text-center text-xs text-[#6E6557] truncate" title={unitText}>{unitText}</span>
                  <span className="hidden sm:block w-24 shrink-0 pt-2 text-center text-sm text-[#6E6557]">{fmtPrice(r.defaultPrice)}</span>
                  <div className="w-28 sm:w-32 shrink-0">
                    <input type="text" inputMode="decimal" dir="ltr" autoComplete="off" data-list-item-price="" value={value}
                      aria-label={`${tr('سعر القائمة')} ${r.name}`} aria-invalid={st?.state === 'error' || undefined}
                      onChange={e => { setDraft(r.productId, e.target.value); if (status[r.productId]?.state !== 'saving') setRowStatus(r.productId, undefined); }}
                      onBlur={() => commit(r)}
                      onKeyDown={e => onKey(e, r)}
                      className={`input !py-1.5 text-center ${st?.state === 'error' ? '!border-red-400 bg-red-50' : dirty ? '!border-amber-400' : ''}`} />
                    {st?.state === 'error' && <p className="text-[10px] text-red-600 mt-0.5 leading-snug" role="alert">{st.message}</p>}
                  </div>
                  <span className="w-5 sm:w-20 shrink-0 pt-2 flex items-center justify-center gap-1 text-[11px]" aria-live="polite">
                    {st?.state === 'saving' ? (
                      <><Loader2 size={14} className="animate-spin text-[#9A8F7E]" /><span className="hidden sm:inline text-[#9A8F7E]">{tr('جار الحفظ')}</span></>
                    ) : st?.state === 'error' ? (
                      <AlertCircle size={14} className="text-red-500" />
                    ) : dirty ? (
                      <span className="w-2 h-2 rounded-full bg-amber-400" title={tr('لم يحفظ بعد')} />
                    ) : st?.state === 'saved' ? (
                      <><Check size={14} className="text-[#1E7A52]" /><span className="hidden sm:inline text-[#1E7A52]">{tr('تم الحفظ')}</span></>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {itemsPagerShown(page, pages) && (
        <div className="flex items-center justify-between gap-2 text-xs text-[#6E6557]">
          <span>{fillText(tr('{n} صنف'), { n: formatNumber(total) })}</span>
          <div className="flex items-center gap-1">
            <button type="button" className="p-1.5 rounded-lg hover:bg-[#F3EEE6] disabled:opacity-30" disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))} aria-label={tr('السابق')}><ChevronRight size={16} /></button>
            <span>{tr('صفحة')} {formatNumber(page)} / {formatNumber(pages)}</span>
            <button type="button" className="p-1.5 rounded-lg hover:bg-[#F3EEE6] disabled:opacity-30" disabled={page >= pages}
              onClick={() => setPage(p => Math.min(pages, p + 1))} aria-label={tr('التالي')}><ChevronLeft size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
