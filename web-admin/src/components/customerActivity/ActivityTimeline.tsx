import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Inbox, Lock } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { formatNumber } from '../../utils/format';
import {
  ACTIVITY_FILTERS, CATEGORY_LABELS, VIEW_LOAD_CAP, VIEW_PAGE_LIMIT, actionLabel, applyView, mergeItems, normalizePage, viewActive, whoOptions,
  type ActivityFilter, type ActivityItem, type ActivityPage, type ActivityView, type ActivityWho,
} from '../../lib/customerActivity';
import ActivityList from './ActivityList';
import ActivityFilterBar from './ActivityFilterBar';

/**
 * «السجل الزمني» للعميل — كل إجراءٍ تمّ معه من أيّ أحد (طلب المالك ٢٦ نوفمبر ٢٠٢٦): زيارات، فواتير ومرتجعات وإشعارات،
 * سندات، روابط دفع، وثائق، تعديلات بياناته وإسناده وأسعاره — من المندوب أو الإداري أو الدعم الفني للمنصّة أو الربط البرمجي
 * أو العميل نفسه أو النظام. سجلٌّ ثابت للقراءة وحدها: لا زرّ فيه إلا الفرز بالقسم و«تحميل المزيد» و«إعادة المحاولة».
 *
 * مشتركٌ بين أرشيف العميل في اللوحة (CustomerStudioModal) وتطبيق المندوب (rep/RepApp.tsx): بلا React Query ولا توجيه،
 * والجلب عبر fetchPage الذي تمرّره الشاشة المضيفة (customerApi.activity أو repApi). الشاشة تعيد تركيبه بمفتاح العميل
 * (key={customerId}) عند تبدّله — fetchPage يُقرأ من مرجعٍ فلا يُعاد الجلب بكل رسمٍ لدالّةٍ جديدة.
 *
 * عرض الأرشيف (view + onViewChange، في اللوحة وحدها): البحث و«من نفّذ» و«الأقدم أولاً» فوق ما حُمّل — والسجلّ يُعرض بترتيب
 * الخادم كما هو، و«الأقدم أولاً» قلبُه لا فرزٌ جديد. ما دام العرض فعّالاً تُحمَّل بقية الصفحات تلقائياً حتى VIEW_LOAD_CAP،
 * وما بعده تذكره ملاحظةٌ ظاهرة.
 */
export interface ActivityTimelineProps {
  /** صفحةٌ من GET /customers/:id/activity — before: مؤشّر الصفحة التالية، category: القسم (بلا قسم = الكل)، limit: حجم الصفحة */
  fetchPage: (before?: string, category?: string, limit?: number) => Promise<ActivityPage>;
  /** النظام المحاسبي مفعّل للشركة (وللمندوب صلاحية كشف الحساب) — وإلا لا مبلغ ولا سعر في أي بند */
  accountingOn: boolean;
  /** شاشة الجوال (تطبيق المندوب): حشوٌ أقلّ وأزرار الأقسام في سطرٍ يمرَّر أفقياً */
  compact?: boolean;
  /** «إزالة الضريبة»: لا ذكر للضريبة */
  taxOff?: boolean;
  /** إضافةٌ تحت البند تعرفها الشاشة المضيفة (صور الزيارة ومرفقات السند في أرشيف اللوحة) — للعرض وحده */
  renderExtra?: (item: ActivityItem) => ReactNode;
  /** عرض الأرشيف (بحث، منفّذ، ترتيب) — تملكه الشاشة المضيفة؛ بلا onViewChange لا أدوات عرض */
  view?: ActivityView;
  onViewChange?: (next: ActivityView) => void;
  /** مناديب تعرفهم الشاشة المضيفة («من خدم العميل») — خياراتٌ في «من نفّذ» قبل أن تصل بنودهم */
  knownWho?: ActivityWho[];
}

type Status = 'loading' | 'ready' | 'error';

export function ActivityTimeline({
  fetchPage, accountingOn, compact = false, taxOff = false, renderExtra, view, onViewChange, knownWho,
}: ActivityTimelineProps) {
  const tr = useTr();
  const [category, setCategory] = useState<ActivityFilter>('all');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reload, setReload] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  // كل جلبٍ أول يحمل رقماً: ردٌّ متأخّر لقسمٍ سابق لا يكتب فوق القسم الحاليّ
  const req = useRef(0);

  useEffect(() => {
    const id = ++req.current;
    setStatus('loading'); setItems([]); setNextBefore(null); setMore('idle');
    fetchRef.current(undefined, category === 'all' ? undefined : category).then((raw) => {
      if (id !== req.current) return;
      const page = normalizePage(raw);
      setItems(mergeItems([], page.items));
      setNextBefore(page.nextBefore);
      setStatus('ready');
    }, () => { if (id === req.current) setStatus('error'); });
  }, [category, reload]);

  /** الصفحة التالية بمؤشّر الخادم — limit للتحميل التلقائي وحده (صفحةٌ أكبر، طلباتٌ أقلّ) */
  const fetchMore = useCallback((limit?: number) => {
    if (!nextBefore || more === 'loading') return;
    const id = req.current;
    setMore('loading');
    const cat = category === 'all' ? undefined : category;
    (limit ? fetchRef.current(nextBefore, cat, limit) : fetchRef.current(nextBefore, cat)).then((raw) => {
      if (id !== req.current) return;
      const page = normalizePage(raw);
      setItems((prev) => mergeItems(prev, page.items));
      // مؤشّرٌ لم يتقدّم = نهاية السجلّ — فلا يدور التحميل التلقائي على الصفحة نفسها بلا نهاية
      setNextBefore(page.nextBefore && page.nextBefore !== nextBefore ? page.nextBefore : null);
      setMore('idle');
    }, () => { if (id === req.current) setMore('error'); });
  }, [nextBefore, more, category]);
  const loadMore = useCallback(() => fetchMore(), [fetchMore]);

  // عرض الأرشيف: البحث والمنفّذ والترتيب فوق ما حُمّل — والبحث بعنوان البند بلغة الواجهة أيضاً
  const active = viewActive(view);
  const labelOf = useCallback((it: ActivityItem) => tr(actionLabel(it.action, { taxOff, data: it.data })), [tr, taxOff]);
  const shown = useMemo(() => applyView(items, view, { labelOf }), [items, view, labelOf]);
  const options = useMemo(() => (onViewChange ? whoOptions(items, knownWho) : []), [onViewChange, items, knownWho]);
  // العرض الفعّال يشمل السجلّ كله: تُحمَّل بقية الصفحات تلقائياً حتى السقف — والفشل يوقفها ويُبقي زرّ إعادة المحاولة
  const capped = items.length >= VIEW_LOAD_CAP;
  const autoLoading = active && status === 'ready' && !!nextBefore && !capped && more !== 'error';
  useEffect(() => {
    if (autoLoading && more === 'idle') fetchMore(VIEW_PAGE_LIMIT);
  }, [autoLoading, more, fetchMore]);

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  return (
    <div className="space-y-3" dir="rtl">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#6E6557]">
        <Lock size={12} className="text-[#8A6D1F] flex-shrink-0" /> {tr('سجل ثابت لا يمكن تعديله أو حذفه')}
      </p>

      <div className={`flex gap-1.5 ${compact ? 'overflow-x-auto pb-1 -mx-1 px-1' : 'flex-wrap'}`} role="tablist" aria-label={tr('أقسام السجل')}>
        {ACTIVITY_FILTERS.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)}
            className={`flex-shrink-0 whitespace-nowrap text-xs font-semibold rounded-full px-3 py-1.5 border transition ${category === c ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:border-[#1F1A13]/40'}`}>
            {tr(CATEGORY_LABELS[c])}
          </button>
        ))}
      </div>

      {onViewChange && <ActivityFilterBar view={view ?? {}} onChange={onViewChange} options={options} />}

      {status === 'loading' ? (
        <div className="space-y-2.5" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-xl bg-[#F1EBDF] animate-pulse" />)}
        </div>
      ) : status === 'error' ? (
        <div className="text-center py-10 text-[#6E6557]">
          <p className="font-semibold">{offline ? tr('لا يتوفر سجل العميل دون اتصال بالإنترنت') : tr('تعذر تحميل سجل العميل')}</p>
          <button type="button" onClick={() => setReload((n) => n + 1)}
            className="mt-3 text-sm font-semibold rounded-lg px-4 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] hover:border-[#E15A30]">
            {tr('إعادة المحاولة')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-[#6E6557]">
          <Inbox size={40} className="mx-auto text-[#E9E1D3] mb-3" />
          <p className="font-semibold">{category === 'all' ? tr('لا يوجد شيء في سجل هذا العميل بعد') : tr('لا يوجد شيء في هذا القسم')}</p>
        </div>
      ) : (
        <>
          {active && autoLoading && (
            <p className="flex items-center gap-2 text-[11px] font-semibold text-[#6E6557]" role="status">
              <span className="w-3 h-3 border-2 border-[#E9E1D3] border-t-[#E15A30] rounded-full animate-spin flex-shrink-0" />
              {tr('جار تحميل بقية السجل ليشمله البحث والترتيب')} <span dir="ltr">({formatNumber(items.length)})</span>
            </p>
          )}
          {active && capped && nextBefore && (
            <p className="text-[11px] font-semibold text-[#8A5A00] bg-[#FDF3DC] rounded-lg px-3 py-1.5" role="note">
              {tr('يشمل البحث والترتيب أحدث {n} بند فقط من السجل').replace('{n}', formatNumber(items.length))}
            </p>
          )}
          {shown.length === 0 ? (
            autoLoading ? null : (
              <div className="text-center py-10 text-[#6E6557]">
                <Inbox size={36} className="mx-auto text-[#E9E1D3] mb-2" />
                <p className="font-semibold">{tr('لا نتائج مطابقة')}</p>
              </div>
            )
          ) : (
            <ActivityList items={shown} accountingOn={accountingOn} taxOff={taxOff} compact={compact} renderExtra={renderExtra} />
          )}
          {nextBefore && !autoLoading && (
            <div className="text-center pt-1">
              <button type="button" onClick={loadMore} disabled={more === 'loading'}
                className="inline-flex items-center gap-2 text-sm font-semibold rounded-lg px-4 py-2 border border-[#E9E1D3] bg-white text-[#1F1A13] hover:border-[#E15A30] disabled:opacity-60">
                {more === 'loading' && <span className="w-3.5 h-3.5 border-2 border-[#E9E1D3] border-t-[#E15A30] rounded-full animate-spin" />}
                {more === 'error' ? tr('تعذر التحميل أعد المحاولة') : tr('تحميل المزيد')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** محفوظاً: الشاشة المضيفة تُعاد رسمها (مؤقّت الزيارة، كتابةٌ في نافذةٍ أخرى) فلا يُعاد السجلّ ما لم تتغيّر خصائصه */
export default memo(ActivityTimeline);
