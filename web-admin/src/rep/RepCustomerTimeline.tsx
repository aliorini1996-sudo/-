/**
 * «السجل الزمني» للعميل في تطبيق المندوب (طلب المالك ٢٦ نوفمبر ٢٠٢٦: «أضف أيقونة لفتح السجل الزمني لمعرفة الجميع كل
 * سجل عمل أي أحد مع هذا العميل»).
 *
 * ورقةٌ ملء الشاشة تُفتح من أيقونة بطاقة العميل (بجوار «تعديل»): كل ما جرى مع العميل — زيارة، فاتورة، مرتجع، سند،
 * رابط دفع، تعديل بيانات… — ومن أيّ أحد (مندوب، إداري، الدعم الفني للمنصّة، الربط البرمجي، العميل نفسه، النظام).
 *
 * قراءةٌ فقط، بلا استثناء: طلبٌ واحد GET إلى `/customers/:id/activity`، ولا زرّ حذفٍ أو تعديل ولا أي طلب كتابة —
 * فالسجل ثابتٌ في الخادم (جدول إلحاقٍ فقط يحرسه زناد قاعدة البيانات) ولا يُغيَّر من التطبيق أبداً.
 *
 * والسجل يُعرض من الخادم مباشرةً (لا نسخة على الجهاز: سجلّ كل من عمل مع العميل يتغيّر بعمل غيرك)، فدون اتصال
 * تظهر رسالةٌ ودودة وزرّ «أعد المحاولة» داخل الورقة وحدها — بقية التطبيق تعمل كالمعتاد ولا تُحجب.
 *
 * العرض نفسه (التجميع باليوم والأيقونات والتصنيفات و«تحميل المزيد» وإخفاء المبالغ حين تُطفأ المحاسبة) في المكوّن
 * المشترك ActivityTimeline — الذي يعرضه «أرشيف العميل» في لوحة الشركة أيضاً.
 *
 * المال في الورقة خلف علمين معاً: «النظام المحاسبي» وصلاحية المندوب «كشف الحساب» (canViewStatement) — كما يحجب ملفّ العميل
 * كشفه عنه. الخادم يجرّد المبالغ أصلاً لمن لا يملكها، وهذا حاجزٌ ثانٍ في الواجهة.
 *
 * الورقة محفوظة (memo): مؤقّت الزيارة الجاري يعيد رسم ملفّ العميل كل ثانية، والورقة وقائمتها لا تتبعانه.
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, History, RefreshCw, WifiOff, UserX, AlertTriangle, CloudOff } from 'lucide-react';
import repApi from './repApi';
import { isNetworkError } from './offlineSync';
import ActivityTimeline from '../components/customerActivity/ActivityTimeline';
import { activityQuery, normalizePage, type ActivityPage } from '../lib/customerActivity';
import { formatCustomerNumber } from '../lib/customerNumber';
import { useTr } from '../i18n/strings';

/** سبب تعذّر الصفحة الأولى: لا اتصال، أو العميل ليس ضمن نطاق المندوب (404/403)، أو خللٌ في الخادم */
type TimelineFailure = 'offline' | 'denied' | 'error';

const FAILURE_TEXT: Record<TimelineFailure, { title: string; body: string }> = {
  offline: {
    title: 'لا يوجد اتصال بالإنترنت',
    body: 'السجل الزمني يعرض من الخادم مباشرة — اتصل ثم أعد المحاولة، وبقية التطبيق تعمل كالمعتاد',
  },
  denied: {
    title: 'لا يمكنك عرض سجل هذا العميل',
    body: 'ربما نقلته الإدارة إلى مندوب آخر — راجع الإدارة إن كان ذلك غير متوقع',
  },
  error: {
    title: 'تعذر تحميل السجل الزمني',
    body: 'خلل مؤقت في الخادم — أعد المحاولة بعد قليل',
  },
};

/** لا استجابة = لا اتصال؛ 404/403 = العميل خارج نطاق المندوب (نُزع منه أو حُذف)؛ غير ذلك خللٌ مؤقّت */
function failureOf(err: unknown): TimelineFailure {
  if (isNetworkError(err)) return 'offline';
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 403 ? 'denied' : 'error';
}

function RepCustomerTimeline({ customer, accountingOn: accountingFlag, canViewStatement = true, taxOff = false, onClose }: {
  customer: { id?: unknown; name?: string | null; number?: number | null; _offline?: boolean };
  /** «النظام المحاسبي» مفعّل؟ إطفاؤه يُخفي المبالغ من السجل (المكوّن المشترك يتولّى الإخفاء) */
  accountingOn: boolean;
  /** صلاحية المندوب «كشف الحساب» — بلاها لا مبلغ في السجل (والخادم يجرّدها أصلاً) */
  canViewStatement?: boolean;
  /** «إزالة الضريبة» للشركة: لا ذكر للضريبة في السجل */
  taxOff?: boolean;
  onClose: () => void;
}) {
  const tr = useTr();
  // المبالغ في السجل: المحاسبة مفعّلة وللمندوب كشف الحساب معاً
  const accountingOn = accountingFlag && canViewStatement !== false;
  const id = String(customer?.id ?? '');
  // العميل المضاف دون اتصال لم يُرفع بعد: لا سجلّ له في الخادم حتى المزامنة — رسالةٌ بدل طلبٍ يرتدّ 404
  const local = !id || id.startsWith('local-') || customer?._offline === true;
  const num = formatCustomerNumber(customer?.number);

  const [first, setFirst] = useState<ActivityPage | null>(null);
  const [failure, setFailure] = useState<TimelineFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  // الصفحة الأولى يجلبها الغلاف، فيسلّمها لأول طلبٍ من القائمة بدل طلبٍ ثانٍ للصفحة نفسها
  const primed = useRef<ActivityPage | null>(null);

  // GET وحده — لا طلب كتابة في هذه الورقة إطلاقاً (السجل ثابت لا يُعدَّل ولا يُحذف).
  // الردّ {success, data:{items, nextBefore}} ← صفحةٌ سليمة الشكل مهما نقص منه
  const load = useCallback(async (before?: string, category?: string): Promise<ActivityPage> => {
    const res = await repApi.get(`/customers/${id}/activity`, { params: activityQuery({ before, category }) });
    return normalizePage(res.data?.data);
  }, [id]);

  // الصفحة الأولى: فشلُها رسالةٌ ودودة وإعادة محاولة داخل الورقة وحدها — لا يُحجب شيءٌ آخر في التطبيق
  useEffect(() => {
    if (local) return;
    let alive = true;
    primed.current = null;
    setFirst(null);
    setFailure(null);
    load()
      .then((p) => { if (!alive) return; primed.current = p; setFirst(p); })
      .catch((e) => { if (alive) setFailure(failureOf(e)); });
    return () => { alive = false; };
  }, [load, local, attempt]);

  // «تحميل المزيد» وتبديل القسم: فشلُهما تعرضه القائمة نفسها (رسالة «دون اتصال» وإعادة المحاولة) فوق ما عُرض
  const fetchPage = useCallback(async (before?: string, category?: string): Promise<ActivityPage> => {
    if (!before && (!category || category === 'all') && primed.current) {
      const p = primed.current;
      primed.current = null;
      return p;
    }
    return load(before, category);
  }, [load]);

  const retry = () => setAttempt((a) => a + 1);

  return (
    // فوق شاشة العميل كلّها (absolute على حاوية التطبيق كـ«العمل دون اتصال») وتحت حاجز الموقع z-[1300]
    <div className="absolute inset-0 z-[60] bg-gray-50 flex flex-col" dir="rtl" role="dialog" aria-modal="true"
      aria-label={tr('السجل الزمني')} data-rep-customer-timeline="">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3 flex-shrink-0">
        <button type="button" onClick={onClose} aria-label={tr('رجوع')}><ArrowRight size={20} /></button>
        <History size={18} className="text-[#E8C9BC] flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm">{tr('السجل الزمني')}</p>
          <p className="text-[#E8C9BC] text-xs truncate">
            {customer?.name || ''}
            {num && <>{' · '}{tr('رقم العميل')} <span dir="ltr" className="tabular-nums">{num}</span></>}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {local ? (
          <TimelineNotice icon={<CloudOff size={36} className="mx-auto text-gray-300 mb-2" />}
            title={tr('هذا العميل لم يرفع إلى الخادم بعد')}
            body={tr('أضيف دون اتصال — يظهر سجله بعد رفعه مع المزامنة')} />
        ) : failure ? (
          <TimelineNotice
            icon={failure === 'offline' ? <WifiOff size={36} className="mx-auto text-gray-300 mb-2" />
              : failure === 'denied' ? <UserX size={36} className="mx-auto text-gray-300 mb-2" />
              : <AlertTriangle size={36} className="mx-auto text-amber-400 mb-2" />}
            title={tr(FAILURE_TEXT[failure].title)}
            body={tr(FAILURE_TEXT[failure].body)}
            retryLabel={tr('اعد المحاولة')} onRetry={retry} />
        ) : !first ? (
          <div className="text-center py-16 text-gray-400">
            <span className="inline-block w-6 h-6 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin mb-2" />
            <p className="text-sm">{tr('جار التحميل')}</p>
          </div>
        ) : (
          <ActivityTimeline key={attempt} fetchPage={fetchPage} accountingOn={accountingOn} taxOff={taxOff} compact />
        )}
      </div>
    </div>
  );
}

/** محفوظةً: العميل نفسه وأعلامٌ أوّلية ورجوعٌ ثابت (useCallback في الملفّ) ⇒ لا رسم مع نبضة مؤقّت الزيارة كل ثانية */
export default memo(RepCustomerTimeline);

/** رسالةٌ وسط الورقة (لا اتصال / خارج النطاق / خلل / عميلٌ لم يُرفع) — وإعادة المحاولة حين تنفع */
function TimelineNotice({ icon, title, body, retryLabel, onRetry }: {
  icon: ReactNode; title: string; body: string; retryLabel?: string; onRetry?: () => void;
}) {
  return (
    <div className="text-center py-14 px-4" role="status">
      {icon}
      <p className="font-bold text-sm text-gray-700 mb-1">{title}</p>
      <p className="text-xs text-gray-500 leading-relaxed mb-4">{body}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#E15A30] text-white text-xs font-semibold active:scale-95 transition">
          <RefreshCw size={13} /> {retryLabel}
        </button>
      )}
    </div>
  );
}
