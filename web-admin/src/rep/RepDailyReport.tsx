import { useEffect, useState } from 'react';
import { ClipboardCheck, Send, AlertCircle, CheckCircle2, Clock, RotateCcw } from 'lucide-react';
import repApi from './repApi';
import { useTr } from '../i18n/strings';
import { outboxAdd, currentRepId } from './offlineDb';
import { formatDate } from '../utils/format';
import { deviceDay } from './deviceDay';

/**
 * شاشة «تقرير اليوم» في تطبيق المندوب.
 *
 * إقرارٌ يكتبه المندوب بيده — الأرقام يدويّة بحتة بقرار المالك، ولا يُعرض
 * إلى جانبها ما يعرفه النظام. وتُحفظ في الصندوق الصادر كالفواتير تماماً،
 * فتقريرُ آخر النهار في منطقةٍ بلا تغطية لا يضيع.
 *
 * **يوم التقرير من الجهاز لا من الخادم**: يُكتب آخر الخميس ويُرفع صباح السبت،
 * واشتقاقُه على الخادم يحوّله تقريرَ السبت.
 */

interface Field {
  id: string;
  label: string;
  kind: string;
  required: boolean;
}

interface Comment {
  id: string;
  fieldId: string | null;
  authorAdminName: string;
  body: string;
  createdAt: string;
}

interface Report {
  id: string;
  reportDate: string;
  status: string;
  round: number;
  values: { fieldId: string; levelSeq: number; declaredNum: number | null; declaredText: string | null; labelSnapshot: string }[];
  comments: Comment[];
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'مرفوع بانتظار المراجعة',
  IN_REVIEW: 'قيد المراجعة',
  RETURNED: 'أعيد إليك للتصحيح',
  APPROVED: 'معتمد',
};

export default function RepDailyReport({ onDone }: { onDone?: () => void }) {
  const tr = useTr();
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<Field[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [returnReason, setReturnReason] = useState<string | null>(null);
  const [chainIssues, setChainIssues] = useState<string[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [offline, setOffline] = useState(false);

  const today = deviceDay();
  /* اليوم المعروض قد لا يكون يوم الجهاز: تقريرٌ أُعيد للتصحيح أمس يجب أن
   * يُفتح ويُصحَّح، وشاشةٌ مقفولة على `today` كانت تحبسه إلى الأبد. */
  const [activeDate, setActiveDate] = useState(deviceDay());
  const [returnedElsewhere, setReturnedElsewhere] = useState<{ reportDate: string; reason: string | null } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await repApi.get('/daily-reports/form', { params: { date: activeDate } });
      const d = res.data.data;
      setFields(d.fields || []);
      setReport(d.report || null);
      setReturnReason(d.returnReason || null);
      setChainIssues(d.chainIssues || []);
      setReturnedElsewhere(d.returnedElsewhere || null);
      // إعادة تعبئة ما كتبه سابقاً حين يكون التقرير مُعاداً للتصحيح
      if (d.report) {
        const m: Record<string, string> = {};
        for (const v of d.report.values as Report['values']) {
          if (v.levelSeq !== 0) continue;
          m[v.fieldId] = v.declaredText ?? (v.declaredNum === null ? '' : String(v.declaredNum));
        }
        setVals(m);
        setNote(d.report.note || '');
      }
      setOffline(false);
    } catch {
      // بلا شبكة: لا نعرف حالة اليوم ولا الخانات — نقولها صراحةً ولا نعرض نموذجاً كاذباً
      setOffline(true);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeDate]);

  const locked = report && (report.status === 'SUBMITTED' || report.status === 'IN_REVIEW' || report.status === 'APPROVED');

  const submit = async () => {
    setMsg(null);
    const missing = fields.filter(f => f.required && !String(vals[f.id] ?? '').trim());
    if (missing.length) { setMsg({ kind: 'err', text: `${tr('املأ')} «${missing[0].label}»` }); return; }

    setSaving(true);
    // الجولة **القادمة** لا المخزَّنة: بعد الإعادة تكون round=1 في القاعدة،
    // فمفتاحٌ مبنيّ عليها يساوي مفتاح الرفع الأول — فيردّ الخادم «تمّ» بلا أن
    // يكتب شيئاً، ويعلق التقرير في «أعيد للتصحيح» أبداً.
    // المفتاح والتاريخ يتبعان **اليوم المعروض**: تصحيحُ تقرير أمسِ يُرفع لأمس
    const clientRef = `dr-${currentRepId()}-${activeDate}-${(report?.round ?? 0) + 1}`;
    const payload = {
      reportDate: activeDate,
      tzOffsetMin: -new Date().getTimezoneOffset(),
      clientCreatedAt: new Date().toISOString(),
      clientRef,
      note: note.trim() || null,
      values: fields.map(f => {
        const raw = String(vals[f.id] ?? '').trim();
        return f.kind === 'TEXT'
          ? { fieldId: f.id, text: raw || null, num: null }
          : { fieldId: f.id, num: raw === '' ? null : Number(raw), text: null };
      }),
    };

    try {
      await repApi.post('/daily-reports', payload);
      setMsg({ kind: 'ok', text: tr('رفع التقرير') });
      await load();
      onDone?.();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const serverMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      if (!status) {
        // انقطاع: يُحفظ في الصندوق الصادر ويرتفع وحده عند عودة الشبكة
        await outboxAdd({
          clientRef, repId: currentRepId(), kind: 'dailyReport',
          payload, status: 'queued', clientCreatedAt: payload.clientCreatedAt,
        });
        setMsg({ kind: 'ok', text: tr('حفظ في الصندوق الصادر وسيرفع عند عودة الشبكة') });
        onDone?.();
      } else {
        setMsg({ kind: 'err', text: serverMsg || tr('تعذر الرفع') });
      }
    }
    setSaving(false);
  };

  if (loading) return <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>;

  if (offline) {
    return (
      <div className="p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-amber-800 text-sm flex gap-2">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{tr('لا يمكن فتح التقرير بلا اتصال')}</p>
            <p className="text-xs mt-1">{tr('نموذج اليوم يأتي من الخادم افتح التقرير مرة وأنت متصل')}</p>
          </div>
        </div>
        <button onClick={load} className="w-full mt-3 py-2.5 rounded-xl border border-[#E9E1D3] text-sm font-semibold">{tr('إعادة المحاولة')}</button>
      </div>
    );
  }

  if (chainIssues.length) {
    return (
      <div className="p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-amber-800 text-sm flex gap-2">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{tr('التقرير اليومي غير جاهز بعد')}</p>
            <p className="text-xs mt-1">{tr('راجع الإدارة لضبط مستويات الاعتماد')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full pb-28">
      <div className="flex items-center gap-2">
        <ClipboardCheck size={22} className="text-[#E15A30]" />
        <div>
          <h2 className="font-bold text-[#1F1A13]">{tr('تقرير اليوم')}</h2>
          <p className="text-xs text-gray-500">{formatDate(new Date().toISOString())}</p>
        </div>
      </div>

      {/* سبب الإعادة — يظهر فوق النموذج لا في سجلٍّ مطويّ */}
      {/* يومٌ سابق أُعيد للتصحيح — المدخل الوحيد إليه، وبدونه يعلق إلى الأبد */}
      {returnedElsewhere && returnedElsewhere.reportDate !== activeDate && (
        <button type="button" onClick={() => setActiveDate(returnedElsewhere.reportDate)}
          className="w-full text-start bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
          <p className="text-xs font-bold text-amber-800">
            {tr('تقرير يوم')} {returnedElsewhere.reportDate} {tr('أعيد إليك للتصحيح')}
          </p>
          {returnedElsewhere.reason && (
            <p className="text-[11px] text-amber-700 mt-1 leading-relaxed">{returnedElsewhere.reason}</p>
          )}
          <p className="text-[11px] font-bold text-amber-900 mt-1.5">{tr('افتحه وصححه')}</p>
        </button>
      )}

      {/* تنبيهٌ صريح حين لا يكون المعروض يوم الجهاز — وإلا ظنّ أنّه يرفع اليوم */}
      {activeDate !== today && (
        <div className="flex items-center justify-between gap-2 bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl p-3 mb-3">
          <p className="text-xs text-[#1E40AF]">
            {tr('تعرض تقرير يوم')} <b>{activeDate}</b> {tr('لا تقرير اليوم')}
          </p>
          <button type="button" onClick={() => setActiveDate(today)}
            className="text-xs font-bold text-[#1E40AF] underline flex-shrink-0">
            {tr('عد لليوم')}
          </button>
        </div>
      )}

      {report?.status === 'RETURNED' && returnReason && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-800 text-sm flex gap-2">
          <RotateCcw size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{tr('أعيد إليك للتصحيح')}</p>
            <p className="text-xs mt-1 leading-relaxed">{returnReason}</p>
          </div>
        </div>
      )}

      {locked && (
        <div className={`rounded-2xl p-4 text-sm flex gap-2 ${report!.status === 'APPROVED' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-blue-50 border border-blue-200 text-blue-800'}`}>
          {report!.status === 'APPROVED' ? <CheckCircle2 size={18} className="shrink-0 mt-0.5" /> : <Clock size={18} className="shrink-0 mt-0.5" />}
          <div>
            <p className="font-semibold">{tr(STATUS_LABEL[report!.status] || report!.status)}</p>
            <p className="text-xs mt-1">{tr('لا يمكن تعديله الآن')}</p>
          </div>
        </div>
      )}

      {/* تعليقات المستويات على الخانات — يراها المندوب مع خانته لا في صفحة أخرى */}
      {fields.map(f => {
        const cs = (report?.comments || []).filter(c => c.fieldId === f.id);
        return (
          <div key={f.id}>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {f.label}{f.required && <span className="text-red-500"> *</span>}
            </label>
            {f.kind === 'TEXT' ? (
              <textarea
                rows={2} disabled={!!locked}
                className="w-full px-3 py-2.5 rounded-xl border border-[#E9E1D3] text-sm disabled:bg-gray-50 disabled:text-gray-500"
                value={vals[f.id] ?? ''} onChange={e => setVals(v => ({ ...v, [f.id]: e.target.value }))}
              />
            ) : (
              <input
                type="number" inputMode="decimal" step={f.kind === 'COUNT' ? '1' : 'any'} disabled={!!locked}
                className="w-full px-3 py-2.5 rounded-xl border border-[#E9E1D3] text-sm disabled:bg-gray-50 disabled:text-gray-500"
                value={vals[f.id] ?? ''} onChange={e => setVals(v => ({ ...v, [f.id]: e.target.value }))}
              />
            )}
            {cs.map(c => (
              <p key={c.id} className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-1.5">
                <span className="font-semibold">{c.authorAdminName}:</span> {c.body}
              </p>
            ))}
          </div>
        );
      })}

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">{tr('ملاحظة')}</label>
        <textarea
          rows={2} disabled={!!locked}
          className="w-full px-3 py-2.5 rounded-xl border border-[#E9E1D3] text-sm disabled:bg-gray-50"
          value={note} onChange={e => setNote(e.target.value)}
        />
      </div>

      {msg && (
        <p className={`text-sm rounded-xl px-3 py-2.5 ${msg.kind === 'ok' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </p>
      )}

      {!locked && (
        <button
          onClick={submit} disabled={saving}
          className="w-full py-3 rounded-2xl bg-[#E15A30] text-white font-bold flex items-center justify-center gap-2 disabled:opacity-60"
        >
          <Send size={18} />
          {saving ? tr('جار الرفع') : report?.status === 'RETURNED' ? tr('إعادة الرفع بعد التصحيح') : tr('رفع التقرير')}
        </button>
      )}
    </div>
  );
}
