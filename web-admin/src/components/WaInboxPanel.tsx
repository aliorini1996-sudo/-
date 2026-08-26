import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { waInboxApi } from '../api/client';
import {
  X, MessageSquare, Search, Bot, User, AlertTriangle, BanIcon,
  RefreshCw, Users, ArrowRight,
} from 'lucide-react';
import { backdropClose } from '../lib/backdropClose';

interface Thread {
  phone: string; name: string | null; stage: string; stageAr: string;
  repCount: number | null; optOut: boolean; messageCount: number;
  lastAt: string; lastBody: string; lastFrom: string;
}
interface ThreadList { total: number; truncated: boolean; threads: Thread[] }
interface TimelineItem {
  kind: 'msg' | 'event'; id: string; at: string; from: string;
  direction: string; body: string; status: string;
}
interface ThreadDetail {
  lead: {
    phone: string; name: string | null; stage: string; stageAr: string;
    repCount: number | null; optOut: boolean; firstAt: string; lastAt: string;
  };
  timeline: TimelineItem[];
  truncated: boolean;
}
interface Stats {
  total: number; active7d: number; messagesIn: number; messagesOut: number;
  byStage: { stage: string; stageAr: string; count: number }[];
}

const STAGE_CLS: Record<string, string> = {
  NEW: 'bg-slate-100 text-slate-700',
  QUALIFIED: 'bg-blue-50 text-blue-700',
  ESCALATED: 'bg-amber-50 text-amber-800',
  WON: 'bg-emerald-50 text-emerald-700',
  LOST: 'bg-red-50 text-red-600',
};

/** وقت مقروء بتوقيت الرياض — البوت يعمل بتوقيت عملائه لا بتوقيت الخادم */
const when = (iso: string) =>
  new Date(iso).toLocaleString('ar-SA-u-nu-latn', {
    timeZone: 'Asia/Riyadh', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

/**
 * محادثات بوت واتساب — قراءةٌ فقط لما دار فعلاً مع العملاء.
 *
 * البوت كان يحفظ كل رسالة منذ يومه الأول ولا سبيل لأحد أن يقرأها. أن يتحدّث
 * بوتٌ نيابةً عنك مع عملائك دون أن ترى ما قال ليس أتمتةً بل عمًى — ولا يمكن
 * تصحيح ما لا يُرى.
 *
 * القراءة فقط عمداً: الردّ من هنا يحتاج نافذة واتساب الـ٢٤ ساعة وقالباً
 * معتمداً، ووعدُ زرِّ إرسالٍ يفشل صامتاً أسوأ من غياب الزرّ.
 */
export default function WaInboxPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [openPhone, setOpenPhone] = useState<string | null>(null);

  const { data: stats } = useQuery({
    queryKey: ['wa-inbox-stats'],
    queryFn: async () => (await waInboxApi.stats()).data.data as Stats,
    retry: 1,
  });

  const { data: list, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['wa-inbox-threads', stage, q],
    queryFn: async () => (await waInboxApi.threads({ stage, q, limit: 80 })).data.data as ThreadList,
    retry: 1,
  });

  const { data: thread, isLoading: threadLoading } = useQuery({
    queryKey: ['wa-inbox-thread', openPhone],
    queryFn: async () => (await waInboxApi.thread(openPhone!)).data.data as ThreadDetail,
    enabled: !!openPhone,
  });

  const errMsg = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
    || 'تعذّر الوصول للبوت';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto"
      {...backdropClose(onClose)}
    >
      <div className="bg-[#FAF7F0] rounded-2xl w-full max-w-5xl shadow-xl my-4">

        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7DECD] sticky top-0 bg-[#FAF7F0] rounded-t-2xl z-10">
          <div className="flex items-center gap-2.5">
            <MessageSquare className="w-5 h-5 text-[#25D366]" />
            <h2 className="text-lg font-bold text-[#1F1A13]">محادثات بوت واتساب</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => refetch()} disabled={isFetching}
              className="p-1.5 rounded-lg hover:bg-black/5 disabled:opacity-40" aria-label="تحديث"
            >
              <RefreshCw className={`w-4 h-4 text-gray-500 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5" aria-label="إغلاق">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">

          {/* محادثة مفتوحة */}
          {openPhone ? (
            <>
              <button
                onClick={() => setOpenPhone(null)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#B8431F] hover:text-[#8A2F14]"
              >
                <ArrowRight className="w-3.5 h-3.5" /> كل المحادثات
              </button>

              {threadLoading && <p className="text-sm text-gray-500 py-8 text-center">جارٍ فتح المحادثة…</p>}

              {thread && (
                <>
                  <div className="rounded-xl border border-[#E7DECD] bg-white p-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                    <span className="font-bold text-[#1F1A13] text-sm">
                      {thread.lead.name || 'بلا اسم'}
                    </span>
                    <span className="tabular-nums text-gray-600" dir="ltr">+{thread.lead.phone}</span>
                    <span className={`px-2 py-0.5 rounded-full font-semibold ${STAGE_CLS[thread.lead.stage] || STAGE_CLS.NEW}`}>
                      {thread.lead.stageAr}
                    </span>
                    {thread.lead.repCount != null && (
                      <span className="text-gray-600 inline-flex items-center gap-1">
                        <Users className="w-3 h-3" /> {thread.lead.repCount} مندوب
                      </span>
                    )}
                    {thread.lead.optOut && (
                      <span className="text-red-600 font-semibold inline-flex items-center gap-1">
                        <BanIcon className="w-3 h-3" /> طلب الإيقاف
                      </span>
                    )}
                    <span className="text-gray-400">أول تواصل {when(thread.lead.firstAt)}</span>
                    <a
                      href={`https://wa.me/${thread.lead.phone}`}
                      target="_blank" rel="noopener noreferrer"
                      className="ms-auto text-[#128C7E] font-semibold hover:underline"
                    >
                      افتح في واتساب ↗
                    </a>
                  </div>

                  {thread.truncated && (
                    <p className="text-[11px] text-amber-700">معروض أول ٥٠٠ رسالة فقط من هذه المحادثة.</p>
                  )}

                  <div className="space-y-2.5">
                    {thread.timeline.map((m) =>
                      m.kind === 'event' ? (
                        <div key={m.id} className="flex justify-center">
                          <div className="max-w-[85%] rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 text-center">
                            {m.body}
                            <span className="block text-[10px] text-amber-700/70 mt-0.5">{when(m.at)}</span>
                          </div>
                        </div>
                      ) : (
                        <div key={m.id} className={`flex ${m.direction === 'IN' ? 'justify-start' : 'justify-end'}`}>
                          <div
                            className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${
                              m.direction === 'IN'
                                ? 'bg-white border border-[#E7DECD] rounded-ss-sm'
                                : 'bg-[#DCF8C6] border border-[#C5E8AC] rounded-se-sm'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 mb-1 text-[10px] font-semibold text-gray-500">
                              {m.direction === 'IN'
                                ? <><User className="w-3 h-3" /> العميل</>
                                : <><Bot className="w-3 h-3" /> البوت</>}
                              <span className="font-normal text-gray-400">{when(m.at)}</span>
                              {m.status === 'FAILED' && (
                                <span className="text-red-600 inline-flex items-center gap-0.5">
                                  <AlertTriangle className="w-3 h-3" /> لم تصل
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[#1F1A13] whitespace-pre-wrap break-words leading-relaxed">{m.body}</p>
                          </div>
                        </div>
                      ),
                    )}
                  </div>

                  <p className="text-[11px] text-gray-400 text-center pt-2">
                    عرضٌ للقراءة فقط — للردّ افتح المحادثة في واتساب.
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              {/* الإحصاء */}
              {stats && (
                <div className="rounded-xl border border-[#E7DECD] bg-white px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                  <span className="font-bold text-[#1F1A13]">{stats.total} محادثة</span>
                  <span className="text-gray-600">نشطة آخر ٧ أيام: <b className="tabular-nums">{stats.active7d}</b></span>
                  <span className="text-gray-600">
                    رسائل: <b className="tabular-nums">{stats.messagesIn}</b> واردة ·{' '}
                    <b className="tabular-nums">{stats.messagesOut}</b> صادرة
                  </span>
                  {stats.byStage.map((s) => (
                    <span key={s.stage} className={`px-2 py-0.5 rounded-full font-semibold ${STAGE_CLS[s.stage] || STAGE_CLS.NEW}`}>
                      {s.stageAr} {s.count}
                    </span>
                  ))}
                </div>
              )}

              {/* بحث وتصفية */}
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="w-4 h-4 text-gray-400 absolute top-1/2 -translate-y-1/2 start-3" />
                  <input
                    value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="ابحث برقم أو اسم"
                    className="w-full ps-9 pe-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white"
                  />
                </div>
                <select
                  value={stage} onChange={(e) => setStage(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[#E7DECD] text-sm bg-white"
                >
                  <option value="">كل المراحل</option>
                  <option value="NEW">جديد</option>
                  <option value="QUALIFIED">مؤهَّل</option>
                  <option value="ESCALATED">مُصعَّد للمالك</option>
                  <option value="WON">اشترى</option>
                  <option value="LOST">خسرناه</option>
                </select>
              </div>

              {isLoading && <p className="text-sm text-gray-500 py-8 text-center">جارٍ جلب المحادثات…</p>}

              {isError && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-4">
                  <p className="text-sm font-semibold text-red-700">{errMsg}</p>
                  <p className="text-xs text-red-600/80 mt-1">
                    البوت على خطّة تُنيم الخدمة؛ أوّل نداء بعد نوم قد يستغرق قرابة دقيقة — جرّب التحديث.
                  </p>
                </div>
              )}

              {list && !list.threads.length && (
                <p className="text-sm text-gray-500 text-center py-8">
                  {q || stage ? 'لا نتائج لهذا البحث.' : 'لم يراسل البوت أحدٌ بعد.'}
                </p>
              )}

              <div className="space-y-2">
                {list?.threads.map((t) => (
                  <button
                    key={t.phone}
                    onClick={() => setOpenPhone(t.phone)}
                    className="w-full text-start flex items-center gap-3 rounded-lg border border-[#E7DECD] bg-white p-3 hover:bg-[#FBF6EC] transition"
                  >
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${STAGE_CLS[t.stage] || STAGE_CLS.NEW}`}>
                      {t.stageAr}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#1F1A13] truncate flex items-center gap-2">
                        {t.name || 'بلا اسم'}
                        <span className="text-[11px] font-normal text-gray-500 tabular-nums" dir="ltr">+{t.phone}</span>
                        {t.optOut && <BanIcon className="w-3 h-3 text-red-500 shrink-0" />}
                      </p>
                      <p className="text-[11px] text-gray-500 truncate">
                        {t.lastFrom && <b className="font-semibold">{t.lastFrom}: </b>}{t.lastBody || '—'}
                      </p>
                    </div>
                    <div className="text-left shrink-0">
                      <p className="text-[11px] text-gray-500">{when(t.lastAt)}</p>
                      <p className="text-[10px] text-gray-400 tabular-nums">{t.messageCount} رسالة</p>
                    </div>
                  </button>
                ))}
              </div>

              {list?.truncated && (
                <p className="text-[11px] text-amber-700 text-center">
                  معروض {list.threads.length} من {list.total} محادثة — ضيّق البحث لرؤية الباقي.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
