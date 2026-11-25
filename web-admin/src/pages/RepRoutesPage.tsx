import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Route as RouteIcon, Plus, Trash2, ArrowUp, ArrowDown, Search, X, CheckCircle2, Repeat, CalendarDays, Navigation, Undo2,
  ListOrdered, Shuffle, CalendarCheck, Sun, MapPin, MapPinOff,
} from 'lucide-react';
import { repRouteApi, salesRepApi, customerApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';
import { orderByDistance } from '../lib/routeOrder';
import { formatCustomerNumber, matchesCustomerNumber } from '../lib/customerNumber';
import {
  ALL_DAYS, DEFAULT_OFF_DAYS, DIST_MODES, WEEKDAYS_AR, byIds, daysText, editorTakenDays, groupByRep, mergeOrder, modeOf, moveItem,
  planOrderSave, toggleDay, weekdaysGate,
  type DistMode, type RouteListRow,
} from '../lib/routeSchedule';

/**
 * بناء خطوط سير المناديب — قائمة عملاء مرتّبة يجب زيارتهم.
 *
 * **الإنجاز يُقرأ من سجلّ الزيارات ولا يُخزَّن**: العميل يُعدّ مُنجَزاً حين
 * تُسجَّل له زيارةٌ من المندوب في اليوم نفسه — فزيارةٌ سُجّلت من ملفّ العميل
 * مباشرةً تُحتسب، ولا يقع تناقضٌ بين شاشتين.
 *
 * والخط نوعان: **دائمٌ** يتكرّر كل يوم، و**مؤقّتٌ** ليومٍ بعينه. وحين يجتمعان
 * يفوز المؤقّت: تخصيصُ يومٍ أحدثُ قصداً من خطّةٍ عامّة وُضعت قبل شهر.
 *
 * و«طريقة توزيع الخطوط» لكل مندوب (طلب المالك ٢٢ نوفمبر ٢٠٢٦): خطٌّ دائمٌ واحد يومياً (الافتراض القديم)،
 * أو عدّة دوائم **حسب أيام الأسبوع**، أو **تناوبٌ بالترتيب** الذي يضعه المالك بتخطّي أيام الراحة. خطّ اليوم
 * يحسبه الخادم وحده (services/routeSchedule.ts) — فالقائمة وتطبيق المندوب وخريطة التتبّع على جوابٍ واحد.
 */

interface RouteRow extends RouteListRow {
  total: number;
  /** null = ليس خطَّ اليوم فلا معنى لعدّاده */
  doneToday: number | null;
}
/** ردّ GET /rep-routes/schedule/:salesRepId */
interface ScheduleView {
  day: string;
  schedule: { mode: string; rotationStart: string | null; offDays: number[] } | null;
  routes: { id: string; name: string; weekdays: number[]; rotationOrder: number }[];
  today: { routeId: string; name: string; isPermanent: boolean } | null;
}
const errText = (e: unknown): string | undefined => (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
const errCode = (e: unknown): string | undefined => (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
/* «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): للعرض وحده بجانب الاسم — customerName يبقى الاسم الخالص،
 * والحفظ يرسل customerId وحده. المحطّات المحفوظة تحمله customerNumber من GET /rep-routes/:id */
/** hasLoc: له موقع محفوظ (يُعرف من قائمة الاختيار لحظة الإضافة) — للعرض وحده، لا يُرسل مع الحفظ */
interface Stop { customerId: string; customerName: string; customerNumber?: number | null; note?: string | null; hasLoc?: boolean }
interface Named { id: string; name: string; businessName?: string | null; number?: number | null; lat?: number | null; lng?: number | null }

/**
 * علامة «الموقع» بجانب العميل في محرّر خط السير (طلب المالك ٢٥ نوفمبر ٢٠٢٦): دبّوس أخضر = له موقع محفوظ (لوكيشن)،
 * ودبّوس مشطوب رمادي = بلا موقع — فيعرف المشرف من يُرتَّب بالمسافة ويظهر على الخريطة ومن يحتاج تثبيت موقعه.
 * on=undefined (المواقع لم تُجلب بعد أو تعذّرت) لا يُرسم شيئاً: لا نقول «بلا موقع» عن عميلٍ لم نعرف حاله.
 */
function LocMark({ on, tr }: { on: boolean | undefined; tr: (s: string) => string }) {
  if (on === undefined) return null;
  const label = on ? tr('له موقع محفوظ') : tr('بلا موقع');
  return on
    ? <MapPin size={14} className="text-green-600 shrink-0" aria-label={label} role="img" data-loc="on"><title>{label}</title></MapPin>
    : <MapPinOff size={14} className="text-gray-400 shrink-0" aria-label={label} role="img" data-loc="off"><title>{label}</title></MapPinOff>;
}
/** موقع عميل من /customers/locations — المفتاح نفسه الذي تقرؤه خريطة التتبّع فيُعاد استعمال ما جُلب */
interface CustomerLoc { id: string; lat: number; lng: number }

const km = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

/**
 * نافذةٌ لا صفحة: خطوط السير تُبنى وأنت تنظر إلى مواقع عملائك على الخريطة.
 * إخراجُها إلى صفحةٍ مستقلّة يقطع تلك النظرة — فتُبنى فوق الخريطة نفسها.
 */
export default function RepRoutesModal({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  /** المندوب المفتوحة لوحةُ «طريقة توزيع الخطوط» له */
  const [openRep, setOpenRep] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['rep-routes'],
    queryFn: async () => (await repRouteApi.list()).data.data as RouteRow[],
  });
  // الخطوط والجدول وجهان لحالٍ واحدة — كل كتابةٍ تُحدّثهما معاً
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['rep-routes'] });
    qc.invalidateQueries({ queryKey: ['rep-route-schedule'] });
  };
  const mDel = useMutation({
    mutationFn: (id: string) => repRouteApi.remove(id),
    onSuccess: refresh,
  });
  const groups = useMemo(() => groupByRep(q.data ?? []), [q.data]);
  const modeLabel = (m: DistMode) => tr(DIST_MODES.find(x => x.mode === m)!.label);

  return (
    <div className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div
        className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-bold text-[#1F1A13] flex items-center gap-2">
              <RouteIcon size={18} className="text-[#E15A30]" /> {tr('خطوط سير المناديب')}
            </p>
            <p className="text-[#6E6557] text-xs mt-0.5 truncate">{tr('حدد لكل مندوب العملاء الذين يزورهم وبأي ترتيب')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editing && <button className="btn-primary text-xs" onClick={() => setEditing({})}><Plus size={15} /> {tr('خط سير جديد')}</button>}
            <button onClick={onClose} className="p-1.5 text-[#9A8F7E] hover:text-[#1F1A13]" aria-label={tr('إغلاق')}><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {editing ? (
            <RouteEditor id={editing.id} onDone={() => { setEditing(null); refresh(); }} />
          ) : (
      <div className="card overflow-hidden p-0">
        {q.isLoading ? <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
          : !q.data?.length ? (
            <div className="p-10 text-center">
              <RouteIcon size={30} className="mx-auto text-gray-300" />
              <p className="text-sm text-[#6E6557] mt-2">{tr('لا خطوط سير بعد')}</p>
              <p className="text-xs text-gray-400 mt-1">{tr('أنشئ خطا ليظهر للمندوب في تطبيقه')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                    <th className="text-right font-semibold px-5 py-2.5">{tr('الاسم')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('النوع')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('العملاء')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('أنجز اليوم')}</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                {groups.map(g => (
                  <tbody key={g.salesRepId}>
                    {/* رأس المندوب: طريقته وخطّ يومه، وزرّ «طريقة توزيع الخطوط» */}
                    <tr className="border-t-2 border-[#F1EBDF] bg-[#FFFBF7]">
                      <td colSpan={5} className="px-5 py-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-[#1F1A13]">{g.salesRepName}</span>
                          <span className="inline-flex items-center gap-1 text-[11px] bg-white border border-[#F1EBDF] text-[#6E6557] rounded-full px-2 py-0.5">
                            {g.mode === 'rotation' ? <Shuffle size={11} /> : g.mode === 'weekdays' ? <CalendarCheck size={11} /> : <Repeat size={11} />}
                            {modeLabel(g.mode)}
                          </span>
                          <span className="text-[11px] text-[#6E6557]">
                            {tr('خط اليوم')}: {g.today ? <b className="text-[#E15A30]">{g.today.name}</b> : <span className="text-gray-400">{tr('لا خط اليوم')}</span>}
                          </span>
                          <button
                            type="button"
                            onClick={() => setOpenRep(v => (v === g.salesRepId ? null : g.salesRepId))}
                            className={`ms-auto btn-secondary text-xs ${openRep === g.salesRepId ? '!border-[#E15A30] !text-[#E15A30]' : ''}`}
                          >
                            <ListOrdered size={14} /> {tr('طريقة توزيع الخطوط')}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {openRep === g.salesRepId && (
                      <tr>
                        <td colSpan={5} className="px-4 pb-3">
                          <RepSchedulePanel salesRepId={g.salesRepId} onChanged={refresh} />
                        </td>
                      </tr>
                    )}
                    {[...g.permanents, ...g.dated].map(r => (
                      <tr key={r.id} className="border-t border-[#F5F0E6]">
                        <td className="px-5 py-3 font-semibold text-[#1F1A13]">
                          <span className="inline-flex items-center gap-1.5 flex-wrap">
                            {r.name}
                            {/* الخطّ الذي يتبعه المندوب اليوم — بحساب الخادم */}
                            {r.isToday && (
                              <span className="inline-flex items-center gap-1 text-[10px] bg-[#E15A30] text-white rounded-full px-1.5 py-0.5"><Sun size={10} /> {tr('خط اليوم')}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {r.isPermanent ? (
                            <span className="inline-flex items-center gap-1 flex-wrap justify-center">
                              <span className="inline-flex items-center gap-1 text-xs bg-[#EEF2FF] text-[#4338CA] rounded-full px-2 py-0.5"><Repeat size={11} /> {tr('دائم')}</span>
                              {g.mode === 'weekdays' && (r.weekdays?.length
                                ? <span className="text-[11px] bg-[#FFF1EA] text-[#B4441F] rounded-full px-2 py-0.5">{daysText(r.weekdays, tr)}</span>
                                : <span className="text-[11px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5">{tr('بلا أيام')}</span>)}
                              {g.mode === 'rotation' && (
                                <span className="text-[11px] bg-[#FFF1EA] text-[#B4441F] rounded-full px-2 py-0.5" title={tr('ترتيب التناوب')}>
                                  #{g.permanents.indexOf(r) + 1}
                                </span>
                              )}
                            </span>
                          ) : <span className="inline-flex items-center gap-1 text-xs bg-[#FFF7ED] text-[#C2410C] rounded-full px-2 py-0.5"><CalendarDays size={11} /> {r.routeDate}</span>}
                        </td>
                        <td className="px-3 py-3 text-center">{r.total}</td>
                        <td className="px-3 py-3 text-center">
                          {/* خطٌّ ليس خطَّ اليوم لا «أنجز اليوم» له — شرطةٌ لا رقمٌ كاذب */}
                          {r.doneToday === null ? <span className="text-gray-300">—</span> : (
                            <span className={r.doneToday === r.total ? 'text-green-600 font-semibold' : 'text-[#6E6557]'}>
                              {r.doneToday} / {r.total}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-left">
                          <div className="flex items-center gap-2 justify-end">
                            <button onClick={() => setEditing({ id: r.id })} className="btn-secondary text-xs">{tr('تعديل')}</button>
                            {/* حذفٌ فعليّ بلا نسخةٍ مخفيّة — فيُسأل قبله */}
                            <button onClick={() => { if (window.confirm(`${tr('حذف نهائي')}: ${r.name}؟`)) mDel.mutate(r.id); }} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title={tr('حذف')}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
      </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * «طريقة توزيع الخطوط» لمندوب: خطٌّ واحد يومياً، أو حسب أيام الأسبوع، أو تناوبٌ بالترتيب (بدايته وأيام راحته
 * وترتيب خطوطه بالأسهم).
 *
 * **الحقول تتبع الخادم ما لم يغيّر المالك شيئاً** (مراجعة ٢٢ نوفمبر ٢٠٢٦): كل جلبٍ جديد (حذف خطٍّ من القائمة،
 * إضافةٌ من المحرّر، حفظٌ من نافذةٍ أخرى) يُعاد ملؤه — وكانت تُملأ مرّةً فتبقى خطوطٌ محذوفة في الترتيب ويُرسَل
 * ترتيبٌ قديم يردّه الخادم 400 ORDER_MISMATCH. وما إن يلمس المالك الطريقة أو البداية أو أيام الراحة أو الأسهم
 * (`dirty`) لا يمحو جلبٌ ما غيّره ولم يحفظه (عيبُ المحرّر الذي أُصلح قبلاً).
 */
function RepSchedulePanel({ salesRepId, onChanged }: { salesRepId: string; onChanged: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['rep-route-schedule', salesRepId],
    queryFn: async () => (await repRouteApi.schedule(salesRepId)).data.data as ScheduleView,
    refetchOnWindowFocus: false,
  });
  const [view, setView] = useState<ScheduleView | null>(null);
  const [mode, setMode] = useState<DistMode>('single');
  const [start, setStart] = useState('');
  const [offDays, setOffDays] = useState<number[]>(DEFAULT_OFF_DAYS);
  const [order, setOrder] = useState<ScheduleView['routes']>([]);
  /** ترتيب الخطوط كما بدأ منه المالك (آخر ما ملأه الخادم) — الأسهم تُقاس عليه عند الحفظ */
  const [startIds, setStartIds] = useState<string[]>([]);
  /** غيّر المالك شيئاً لم يُحفظ بعد — فلا يُعاد الملء من الخادم فوقه */
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  /** `ids`: ترتيبٌ يُعرض بدل ترتيب الخادم (ترتيب المالك مدموجاً بالخطوط الحاليّة ليراجعه) */
  const apply = (v: ScheduleView, ids?: string[]) => {
    setView(v);
    setMode(modeOf(v.schedule));
    setStart(v.schedule?.rotationStart || v.day);
    setOffDays(v.schedule?.offDays ?? DEFAULT_OFF_DAYS);
    setStartIds(v.routes.map(r => r.id));
    setOrder(ids ? byIds(v.routes, ids) : v.routes);
  };
  // كل جلبٍ جديد (dataUpdatedAt) يُعاد ملؤه ما لم يغيّر المالك شيئاً — لا مرّةً واحدة
  useEffect(() => { if (q.data && !dirty) apply(q.data); }, [q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  /** كل تغييرٍ من المالك يمرّ هنا */
  const touch = () => { setDirty(true); setMsg(null); };

  const save = useMutation({
    mutationFn: async (): Promise<{ v: ScheduleView; review?: string[] }> => {
      let v = (await repRouteApi.setSchedule(salesRepId, mode === 'rotation' ? { mode, rotationStart: start || null, offDays } : { mode })).data.data as ScheduleView;
      if (mode !== 'rotation') return { v };
      /* الترتيب يُكتب بعد الطريقة وحين حرّك المالك الأسهم وحده، مبنيّاً على خطوط الخادم الحاليّة (ردّ الحفظ) — لا قائمةٌ
       * قديمة أبداً؛ وإن تغيّرت الخطوط منذ بدأ يراجع ترتيبه قبل أن يُكتب (lib/routeSchedule.ts planOrderSave) */
      const plan = planOrderSave(startIds, order.map(r => r.id), v.routes.map(r => r.id));
      if (plan.kind === 'review') return { v, review: plan.ids };
      if (plan.kind === 'send') {
        try {
          v = (await repRouteApi.setOrder(salesRepId, plan.ids)).data.data as ScheduleView;
        } catch (e) {
          if (errCode(e) !== 'ORDER_MISMATCH') throw e;
          // تغيّرت الخطوط بين الطلبين: يُجلب الحاليّ ويراجع المالك ترتيبه عليه
          const fresh = (await repRouteApi.schedule(salesRepId)).data.data as ScheduleView;
          return { v: fresh, review: mergeOrder(order.map(r => r.id), fresh.routes.map(r => r.id)) };
        }
      }
      return { v };
    },
    onSuccess: ({ v, review }) => {
      onChanged();
      if (review) {
        // الطريقة حُفظت والترتيب لا: يبقى ما غيّره المالك معروضاً على الخطوط الحاليّة حتى يحفظه
        apply(v, review);
        setDirty(true);
        setMsg({ tone: 'err', text: tr('تغيرت خطوط المندوب أثناء التعديل — حفظت الطريقة ولم يحفظ الترتيب، راجع الترتيب ثم احفظ') });
        return;
      }
      apply(v);
      setDirty(false);
      setMsg({ tone: 'ok', text: tr('تم الحفظ') });
    },
    onError: (e: unknown) => setMsg({ tone: 'err', text: errText(e) || tr('تعذر الحفظ') }),
  });

  if (q.isLoading || (!view && !q.isError)) return <div className="card text-center text-xs text-gray-400 py-4">{tr('جار التحميل')}</div>;
  if (!view) return <div className="card text-center text-xs text-amber-700 py-4">{tr('تعذر جلب طريقة التوزيع')}</div>;

  // «حسب أيام الأسبوع» وخطوطٌ بلا أيام: كلّها ⇒ يُمنع الحفظ (لا خطّ في أي يوم)، وبعضها ⇒ يُسأل المالك بأسمائها
  const gate = weekdaysGate(order);
  const ready = mode === 'rotation' ? (!!start && offDays.length < 7) : mode === 'weekdays' ? !gate.block : true;
  const submit = () => {
    setMsg(null);
    if (mode === 'weekdays' && gate.missing.length
      && !window.confirm(`${tr('هذه الخطوط بلا أيام ولن تظهر للمندوب')}: ${gate.missing.join('، ')}\n${tr('حفظ الطريقة رغم ذلك؟')}`)) return;
    save.mutate();
  };

  return (
    <div className="card space-y-3 border-[#F7D9CC]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-bold text-[#1F1A13]">{tr('طريقة توزيع الخطوط')}</span>
        <div className="inline-flex rounded-xl border border-[#F1EBDF] overflow-hidden">
          {DIST_MODES.map(m => (
            <button
              key={m.mode} type="button" onClick={() => { setMode(m.mode); touch(); }}
              className={`px-3 py-1.5 text-xs font-semibold ${mode === m.mode ? 'bg-[#E15A30] text-white' : 'bg-white text-[#6E6557] hover:bg-[#FAF7F0]'}`}
            >
              {tr(m.label)}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-[#6E6557] ms-auto">
          {tr('خط اليوم')}: {view.today ? <b className="text-[#E15A30]">{view.today.name}</b> : <span className="text-gray-400">{tr('لا خط اليوم')}</span>}
        </span>
      </div>

      {mode === 'single' && (
        <p className="text-xs text-[#6E6557]">
          {tr('يتبع المندوب خطا دائما واحدا كل يوم')}
          {order.length > 1 && <span className="block mt-1 text-amber-700">{tr('للمندوب أكثر من خط دائم — احذف الزائد قبل اختيار خط واحد يوميا')}</span>}
        </p>
      )}

      {mode === 'weekdays' && (
        <div className="space-y-2">
          <p className="text-xs text-[#6E6557]">{tr('لكل خط أيامه من الأسبوع وتحدد الأيام من تعديل الخط')}</p>
          {!order.length ? <p className="text-xs text-gray-400">{tr('لا خطوط دائمة لهذا المندوب بعد')}</p> : (
            <div className="divide-y divide-[#F5F0E6] rounded-xl border border-[#F1EBDF]">
              {order.map(r => (
                <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="flex-1 truncate text-[#1F1A13]">{r.name}</span>
                  {r.weekdays?.length
                    ? <span className="text-[11px] bg-[#FFF1EA] text-[#B4441F] rounded-full px-2 py-0.5">{daysText(r.weekdays, tr)}</span>
                    : <span className="text-[11px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5">{tr('بلا أيام')}</span>}
                </div>
              ))}
            </div>
          )}
          {/* الخطوط بلا أيام بأسمائها: كلّها ⇒ الحفظ ممنوع (الخادم يردّ 409 NO_WEEKDAYS)، وبعضها ⇒ يُسأل المالك */}
          {gate.block ? (
            <p className="text-[11px] text-red-700 bg-red-50 rounded-lg px-3 py-2">
              {tr('لا أيام لأي خط من خطوط المندوب — حدد أيام كل خط من تعديل الخط قبل اختيار هذه الطريقة')}: {gate.missing.join('، ')}
            </p>
          ) : gate.missing.length > 0 && (
            <p className="text-[11px] text-amber-700">{tr('هذه الخطوط بلا أيام ولن تظهر للمندوب')}: {gate.missing.join('، ')}</p>
          )}
        </div>
      )}

      {mode === 'rotation' && (
        <div className="space-y-3">
          <p className="text-xs text-[#6E6557]">{tr('يتنقل المندوب بين خطوطه يوما بيوم بالترتيب ويتخطى أيام الراحة')}</p>
          <div className="flex gap-4 flex-wrap items-end">
            <div>
              <label className="label text-xs">{tr('بداية التناوب')}</label>
              {/* تاريخٌ ميلاديّ 'YYYY-MM-DD' — يومه لأوّل خطٍّ في الترتيب */}
              <input type="date" className="input w-40" value={start} onChange={e => { setStart(e.target.value); touch(); }} />
            </div>
            <div>
              <label className="label text-xs">{tr('أيام الراحة')}</label>
              <div className="flex gap-1 flex-wrap">
                {ALL_DAYS.map(d => {
                  const on = offDays.includes(d);
                  return (
                    <button
                      key={d} type="button" aria-pressed={on} onClick={() => { setOffDays(v => toggleDay(v, d)); touch(); }}
                      className={`px-2.5 py-1 rounded-full text-xs border ${on ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#F1EBDF] hover:border-[#E15A30]'}`}
                    >
                      {tr(WEEKDAYS_AR[d])}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          {offDays.length >= 7 && <p className="text-[11px] text-red-700">{tr('لا بد من يوم عمل واحد على الأقل')}</p>}
          <div>
            <p className="label text-xs">{tr('ترتيب التناوب')}</p>
            {order.length < 2 && <p className="text-[11px] text-amber-700 mb-1">{tr('أضف خطين دائمين على الأقل لهذا المندوب ليتناوب بينهما')}</p>}
            {order.length > 0 && (
              <div className="divide-y divide-[#F5F0E6] rounded-xl border border-[#F1EBDF]">
                {order.map((r, i) => (
                  <div key={r.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="w-6 h-6 rounded-full bg-[#FFF1EA] text-[#E15A30] text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="flex-1 text-sm text-[#1F1A13] truncate">{r.name}</span>
                    <button type="button" onClick={() => { setOrder(v => moveItem(v, i, -1)); touch(); }} disabled={i === 0} className="p-1 text-[#6E6557] disabled:opacity-30" aria-label={tr('تحريك لأعلى')}><ArrowUp size={14} /></button>
                    <button type="button" onClick={() => { setOrder(v => moveItem(v, i, 1)); touch(); }} disabled={i === order.length - 1} className="p-1 text-[#6E6557] disabled:opacity-30" aria-label={tr('تحريك لأسفل')}><ArrowDown size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {msg && <p className={`text-xs rounded-lg px-3 py-2 ${msg.tone === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-xs" disabled={!ready || save.isPending} onClick={submit}>
          {save.isPending ? tr('جار الحفظ') : tr('حفظ الطريقة')}
        </button>
      </div>
    </div>
  );
}

function RouteEditor({ id, onDone }: { id?: string; onDone: () => void }) {
  const tr = useTr();
  const [salesRepId, setSalesRepId] = useState('');
  const [name, setName] = useState('');
  const [isPermanent, setIsPermanent] = useState(true);
  const [routeDate, setRouteDate] = useState('');
  /** أيام الخطّ الدائم — تُحدَّد وتُرسَل أيّاً كانت طريقة المندوب، وتُقرأ حين يوزّع خطوطه «حسب أيام الأسبوع» */
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');

  const repsQ = useQuery({
    queryKey: ['reps-for-route'],
    queryFn: async () => (await salesRepApi.list()).data.data as Named[],
  });
  const custQ = useQuery({
    queryKey: ['customers-for-route', search],
    queryFn: async () => (await customerApi.list({ search, limit: 50 })).data.data as Named[],
  });
  /* مواقع العملاء المحفوظة لعلامة «الموقع» في «ترتيب الزيارة» — المفتاح نفسه الذي يقرؤه «ترتيب بالمسافة» وخريطة التتبّع،
   * فلا جلب مكرّر. وقائمة الاختيار تعرف موقع كل عميل من صفّه نفسه (lat/lng) */
  const locQ = useQuery({
    queryKey: ['customer-locations'],
    queryFn: async () => (await customerApi.locations()).data.data as CustomerLoc[],
    staleTime: 60_000,
  });
  const locatedIds = useMemo(() => new Set((locQ.data ?? []).map(l => l.id)), [locQ.data]);
  // المسار يعيد ٥٠٠٠ موقعاً على الأكثر: قائمةٌ بلغت السقف قد تُسقط عميلاً له موقع، فلا نحكم بـ«بلا موقع» حينها
  const locComplete = locQ.isSuccess && (locQ.data?.length ?? 0) < 5000;
  const stopHasLoc = (s: Stop): boolean | undefined => (s.hasLoc || locatedIds.has(s.customerId) ? true : locComplete ? false : undefined);
  /**
    * التحميل الابتدائيّ في تأثيرٍ يعمل **مرّة واحدة**، لا في queryFn.
    *
    * كان في queryFn فوقع خطآن: إعادةُ الجلب عند عودة التركيز إلى النافذة
    * تمحو ما كتبه المالك ولم يحفظه بعد، وإعادةُ فتح «تعديل» خلال مدّة الطزاجة
    * تعرض نموذجاً **فارغاً** لخطٍّ ممتلئ (البيانات من الكاش فلا تُنفَّذ الدالّة
    * ولا تُملأ الحقول) — فيحفظ المالك خطّاً بلا عملاء ظانّاً أنه يعدّل.
    */
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const d = (await repRouteApi.get(id)).data.data;
        if (!alive) return;
        setSalesRepId(d.salesRepId); setName(d.name);
        setIsPermanent(d.isPermanent); setRouteDate(d.routeDate || '');
        setWeekdays(Array.isArray(d.weekdays) ? d.weekdays : []);
        setStops(d.stops.map((s: Stop) => ({ customerId: s.customerId, customerName: s.customerName, customerNumber: s.customerNumber ?? null, note: s.note })));
      } catch { if (alive) setLoadFailed(true); }
    })();
    return () => { alive = false; };
  }, [id]);

  /* طريقة توزيع خطوط المندوب المختار — تحدّد ما يُعرض للخطّ الدائم: أيامه، أو موضعه في التناوب، أو أنّه يستبدل
   * دائمه الوحيد (طلب المالك ٢٢ نوفمبر ٢٠٢٦) */
  const schedQ = useQuery({
    queryKey: ['rep-route-schedule', salesRepId],
    queryFn: async () => (await repRouteApi.schedule(salesRepId)).data.data as ScheduleView,
    enabled: !!salesRepId && isPermanent,
  });
  const repMode: DistMode = modeOf(schedQ.data?.schedule);
  // أيام خطوط المندوب الأخرى الباقية بعد الحفظ — في «خط واحد يومياً» يُستبدل دائمه فلا يحجز يوماً (كالخادم)
  const taken = useMemo(() => editorTakenDays(repMode, schedQ.data?.routes ?? [], id), [schedQ.data, id, repMode]);
  const otherPerms = (schedQ.data?.routes ?? []).filter(r => r.id !== id);

  const save = useMutation({
    mutationFn: () => repRouteApi.save({
      salesRepId, name: name.trim(), isPermanent,
      routeDate: isPermanent ? null : routeDate,
      /* أيام الدائم تُرسَل أيّاً كانت الطريقة (مراجعة ٢٢ نوفمبر ٢٠٢٦): تُعدّ في التناوب تمهيداً لـ«حسب أيام الأسبوع»،
       * والخادم يفحص تعارضها متى أُرسلت. وخطٌّ تعذّر تحميله لا يُرسل أياماً فارغة تمحو أيامه — غيابها يُبقيها */
      ...(isPermanent && !loadFailed && { weekdays }),
      // الخطّ المُحرَّر يُحذف فعلياً بمعرّفه لا بمفاتيحه: تغييرُ التاريخ أو النوع أو
      // المندوب كان يُنشئ خطّاً ثانياً ويترك الأول نشطاً يعمل عليه المندوب
      ...(id && { replacesId: id }),
      stops: stops.map(s => ({ customerId: s.customerId, note: s.note ?? null })),
    }),
    onSuccess: (res) => {
      // العملاء الساقطون خارج النطاق كان الخادم يُخبر بهم والواجهة تتجاهله،
      // فيظنّ المالك أنّ خطّه كامل وهو ناقص
      const w = (res as { data?: { warning?: string } })?.data?.warning;
      if (w) { setErr(w); setTimeout(onDone, 2500); return; }
      onDone();
    },
    onError: (e: unknown) => setErr(errText(e) || tr('تعذر الحفظ')),
  });

  const chosen = useMemo(() => new Set(stops.map(s => s.customerId)), [stops]);
  const move = (i: number, d: -1 | 1) => setStops(v => {
    const j = i + d;
    if (j < 0 || j >= v.length) return v;
    const c = [...v]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  /**
   * ترتيب حسب المسافة (lib/routeOrder.ts): العملاء متتابعين حسب مواقعهم وحدها — لا موقع المندوب ولا
   * عميلٌ مثبَّت — بأقصر مسارٍ مفتوح تقريبيّ. لا يُحفظ شيء: يتغيّر الترتيب في النموذج فيراجعه المشرف
   * ثم يحفظ، و«تراجع عن الترتيب» تعيد ما كان.
   */
  const qc = useQueryClient();
  const [sorting, setSorting] = useState(false);
  const [sortMsg, setSortMsg] = useState<{ text: string; tone: 'ok' | 'info' | 'err' } | null>(null);
  const [beforeSort, setBeforeSort] = useState<Stop[] | null>(null);
  const sortByDistance = async () => {
    setSorting(true); setSortMsg(null);
    try {
      // تعذّر الجلب مع وجود مواقع سابقة في الذاكرة (من الخريطة): تُستعمل — المواقع لا تتغيّر بين دقيقة وأخرى
      const locs = await qc.fetchQuery({
        queryKey: ['customer-locations'],
        queryFn: async () => (await customerApi.locations()).data.data as CustomerLoc[],
        staleTime: 60_000,
      }).catch((e) => {
        const cached = qc.getQueryData<CustomerLoc[]>(['customer-locations']);
        if (cached?.length) return cached;
        throw e;
      });
      const byId = new Map((locs || []).map(l => [l.id, l]));
      const r = orderByDistance(stops.map(s => ({ ...s, id: s.customerId, lat: byId.get(s.customerId)?.lat, lng: byId.get(s.customerId)?.lng })));
      const located = stops.length - r.missing;
      const missingNote = r.missing ? ` · ${r.missing} ${tr('بلا موقع على الخريطة في آخر القائمة')}` : '';
      if (located < 3) {
        setSortMsg({ tone: 'info', text: tr('يلزم ثلاثة عملاء على الأقل لهم موقع على الخريطة') });
      } else if (r.changed) {
        setBeforeSort(stops);
        setStops(r.ordered.map(({ customerId, customerName, customerNumber, note }) => ({ customerId, customerName, customerNumber, note })));
        setSortMsg({ tone: 'ok', text: `${tr('رتب بأقصر مسار تقريبي')}: ${km(r.afterKm)} ${tr('كم')} ${tr('بدل')} ${km(r.beforeKm)} ${tr('كم')}${missingNote}` });
      } else {
        setSortMsg({ tone: 'info', text: `${tr('الترتيب الحالي هو الأقصر')}: ${km(r.beforeKm)} ${tr('كم')}${missingNote}` });
      }
    } catch {
      setSortMsg({ tone: 'err', text: tr('تعذر جلب مواقع العملاء') });
    } finally {
      setSorting(false);
    }
  };
  const undoSort = () => {
    if (beforeSort) setStops(beforeSort);
    setBeforeSort(null); setSortMsg(null);
  };

  const ready = !!salesRepId && !!name.trim() && stops.length > 0 && (isPermanent || !!routeDate);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onDone} className="btn-secondary text-xs"><X size={14} /> {tr('رجوع')}</button>
        <p className="text-sm font-bold text-[#1F1A13]">{id ? tr('تعديل خط السير') : tr('خط سير جديد')}</p>
      </div>

      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">{err}</p>}

      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label text-xs">{tr('المندوب')}</label>
            <select className="input w-52" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
              <option value="">{tr('اختر مندوبا')}</option>
              {repsQ.data?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {repsQ.isError && <p className="text-[11px] text-amber-700 mt-1">{tr('تعذر جلب المناديب — تحقق من صلاحية المناديب')}</p>}
          </div>
          <div>
            <label className="label text-xs">{tr('اسم خط السير')}</label>
            <input className="input w-52" value={name} onChange={e => setName(e.target.value)} placeholder={tr('مسار وسط الرياض')} />
          </div>
          <div>
            <label className="label text-xs">{tr('النوع')}</label>
            <select className="input w-44" value={isPermanent ? 'perm' : 'temp'} onChange={e => setIsPermanent(e.target.value === 'perm')}>
              <option value="perm">{tr('دائم يتكرر كل يوم')}</option>
              <option value="temp">{tr('مؤقت ليوم محدد')}</option>
            </select>
          </div>
          {!isPermanent && (
            <div>
              <label className="label text-xs">{tr('تاريخ اليوم')}</label>
              <input type="date" className="input w-40" value={routeDate} onChange={e => setRouteDate(e.target.value)} />
            </div>
          )}
          <button
            type="button" onClick={sortByDistance} disabled={stops.length < 3 || sorting}
            title={tr('يرتب العملاء متتابعين حسب مواقعهم بأقصر مسار تقريبي')}
            className="btn-secondary !px-3 whitespace-nowrap disabled:opacity-50"
          >
            <Navigation size={14} className="text-[#E15A30]" /> {sorting ? tr('جار الترتيب') : tr('ترتيب بالمسافة')}
          </button>
        </div>
        <p className="text-xs text-[#6E6557] mt-2">
          {!isPermanent
            ? tr('يظهر في يومه وحده، ويسبق الخط الدائم إن وجد')
            : repMode === 'weekdays' ? tr('يظهر للمندوب في أيامه المحددة، وعلامة الإنجاز تبدأ من جديد كل صباح')
              : repMode === 'rotation' ? tr('يظهر للمندوب في دوره من التناوب، وعلامة الإنجاز تبدأ من جديد كل صباح')
                : tr('يظهر للمندوب كل يوم، وعلامة الإنجاز تبدأ من جديد كل صباح')}
        </p>
        {/* أيام الخطّ لكل دائمٍ أيّاً كانت طريقة المندوب (مراجعة ٢٢ نوفمبر ٢٠٢٦) — كانت في «حسب أيام الأسبوع» وحده،
            فلا يُحوَّل مندوبٌ إليها إلا بخطوطٍ بلا أيام لا تظهر له */}
        {isPermanent && salesRepId && (
          <div className="mt-3">
            <p className="label text-xs">{tr('أيام الخط')}</p>
            {repMode !== 'weekdays' && <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('تستعمل الأيام حين تكون طريقة توزيع خطوط المندوب حسب أيام الأسبوع')}</p>}
            <div className="flex gap-1 flex-wrap">
              {ALL_DAYS.map(d => {
                const on = weekdays.includes(d);
                // يومٌ لخطٍّ آخر لهذا المندوب لا يُختار — لكل يومٍ خطٌّ واحد (والخادم يرفضه كذلك)
                const owner = !on ? taken.get(d) : undefined;
                return (
                  <button
                    key={d} type="button" aria-pressed={on} disabled={!!owner}
                    onClick={() => setWeekdays(v => toggleDay(v, d))}
                    title={owner ? `${tr('محجوز لخط')}: ${owner}` : undefined}
                    className={`px-2.5 py-1 rounded-full text-xs border ${on ? 'bg-[#E15A30] text-white border-[#E15A30]'
                      : owner ? 'bg-[#F5F0E6] text-gray-400 border-[#F1EBDF] line-through cursor-not-allowed'
                        : 'bg-white text-[#6E6557] border-[#F1EBDF] hover:border-[#E15A30]'}`}
                  >
                    {tr(WEEKDAYS_AR[d])}
                  </button>
                );
              })}
            </div>
            {taken.size > 0 && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('الأيام المشطوبة لخطوط أخرى لهذا المندوب')}</p>}
            {repMode === 'weekdays' && !weekdays.length && <p className="text-[11px] text-amber-700 mt-1">{tr('خط بلا أيام لا يظهر للمندوب')}</p>}
          </div>
        )}
        {isPermanent && salesRepId && repMode === 'rotation' && !id && (
          <p className="text-[11px] text-[#6E6557] mt-2">{tr('يضاف إلى آخر ترتيب التناوب')}</p>
        )}
        {isPermanent && salesRepId && repMode === 'single' && otherPerms.length > 0 && (
          <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2">
            {tr('حفظ خط دائم يستبدل الخط الدائم الحالي لهذا المندوب')} — {tr('لتعدد الخطوط اختر طريقة توزيع الخطوط للمندوب')}
          </p>
        )}
        {sortMsg && (
          <p className={`text-xs mt-2 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap ${
            sortMsg.tone === 'ok' ? 'bg-green-50 text-green-800' : sortMsg.tone === 'err' ? 'bg-red-50 text-red-700' : 'bg-[#FAF7F0] text-[#6E6557]'}`}>
            <span>{sortMsg.text}</span>
            {sortMsg.tone === 'ok' && beforeSort && (
              <button type="button" onClick={undoSort} className="inline-flex items-center gap-1 font-semibold underline">
                <Undo2 size={12} /> {tr('تراجع عن الترتيب')}
              </button>
            )}
          </p>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* المختارون بالترتيب */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#F1EBDF] font-bold text-sm">
            {tr('ترتيب الزيارة')} ({stops.length})
            {(() => {
              const missing = stops.filter(s => stopHasLoc(s) === false).length;
              return missing > 0 && (
                <span className="ms-2 text-[11px] font-normal text-[#9A8F7E] inline-flex items-center gap-1" data-loc-missing="">
                  <MapPinOff size={12} /> {missing} {tr('بلا موقع')}
                </span>
              );
            })()}
          </div>
          {!stops.length ? (
            <p className="p-6 text-center text-xs text-gray-400">{tr('أضف عملاء من القائمة المجاورة')}</p>
          ) : (
            <div className="divide-y divide-[#F5F0E6] max-h-[26rem] overflow-y-auto">
              {stops.map((s, i) => (
                <div key={s.customerId} className="flex items-center gap-2 px-3 py-2.5">
                  <span className="w-6 h-6 rounded-full bg-[#FFF1EA] text-[#E15A30] text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <span className="flex-1 text-sm text-[#1F1A13] truncate">
                    {s.customerNumber != null && <><span dir="ltr" className="tabular-nums text-[#9A8F7E]">{formatCustomerNumber(s.customerNumber)}</span>{' · '}</>}
                    {s.customerName}
                  </span>
                  <LocMark on={stopHasLoc(s)} tr={tr} />
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-[#6E6557] disabled:opacity-30"><ArrowUp size={14} /></button>
                  <button onClick={() => move(i, 1)} disabled={i === stops.length - 1} className="p-1 text-[#6E6557] disabled:opacity-30"><ArrowDown size={14} /></button>
                  <button onClick={() => setStops(v => v.filter(x => x.customerId !== s.customerId))} className="p-1 text-red-600"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* اختيار العملاء */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#F1EBDF]">
            <div className="relative">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="input w-full pr-9 text-sm" value={search}
                onChange={e => setSearch(e.target.value)} placeholder={tr('ابحث بالاسم أو الجوال أو رقم العميل')}
              />
            </div>
          </div>
          <div className="divide-y divide-[#F5F0E6] max-h-[26rem] overflow-y-auto">
            {custQ.isLoading ? <p className="p-6 text-center text-xs text-gray-400">{tr('جار التحميل')}</p>
              : custQ.isError ? (
                /* «لا نتائج» تكذب هنا: الغالب أنّ المستخدم لا يملك صلاحية
                   العملاء، فيظنّ الشركة بلا عملاء ويشكو من عطل لا وجود له */
                <p className="p-6 text-center text-xs text-amber-700">{tr('تعذر جلب العملاء — تحقق من صلاحية العملاء')}</p>
              )
              : !custQ.data?.length ? <p className="p-6 text-center text-xs text-gray-400">{tr('لا نتائج')}</p>
              // البحث في الخادم يطابق «رقم العميل» بالضبط (وقبله الاسم والجوال) — والمطابق بالرقم يتصدّر النتائج
              : [...custQ.data].sort((a, b) => Number(matchesCustomerNumber(search, b.number)) - Number(matchesCustomerNumber(search, a.number))).map(c => {
                const on = chosen.has(c.id);
                const label = c.businessName || c.name;
                const hasLoc = c.lat != null && c.lng != null;
                return (
                  <button
                    key={c.id} disabled={on}
                    onClick={() => setStops(v => [...v, { customerId: c.id, customerName: label, customerNumber: c.number ?? null, hasLoc }])}
                    className={`w-full text-right px-4 py-2.5 text-sm flex items-center gap-2 ${on ? 'bg-[#F7FBF8] text-gray-400' : 'hover:bg-[#FAF7F0] text-[#1F1A13]'}`}
                  >
                    {on ? <CheckCircle2 size={14} className="text-green-600 shrink-0" /> : <Plus size={14} className="text-[#E15A30] shrink-0" />}
                    <span className="truncate flex-1">
                      {c.number != null && <><span dir="ltr" className="tabular-nums text-[#9A8F7E]">{formatCustomerNumber(c.number)}</span>{' · '}</>}
                      {label}
                    </span>
                    <LocMark on={hasLoc} tr={tr} />
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button className="btn-primary" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tr('جار الحفظ') : tr('حفظ خط السير')}
        </button>
        <button className="btn-secondary" onClick={onDone}>{tr('إلغاء')}</button>
      </div>
      {!ready && (
        <p className="text-xs text-[#6E6557]">
          {tr('اختر المندوب والاسم وعميلا واحدا على الأقل')}{!isPermanent && !routeDate ? ` · ${tr('وحدد التاريخ')}` : ''}
        </p>
      )}
    </div>
  );
}
