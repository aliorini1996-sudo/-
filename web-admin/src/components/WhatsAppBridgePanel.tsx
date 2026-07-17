/**
 * غرفة واتساب ويب — لوحة المالك.
 *
 * تعرض رمز QR لربط جلسة واتساب ويب على جهازك (عبر الجسر المحلي في wa-bridge/)،
 * ثم تتيح إرسال رسالة مخصّصة **لكل عميل على حدة** مع قراءة محادثته.
 *
 * الرسالة تُولَّد من قالب المالك + زاوية دولة العميل، وتبقى قابلة للتحرير قبل الإرسال —
 * لأن الرسالة التي تُقرأ كآلة تُحظر، والتي تُقرأ كإنسان تُجاب.
 */

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  X, MessageCircle, Smartphone, Send, LogOut, RefreshCw, Loader2,
  CheckCheck, AlertTriangle, Clock, Pencil, Save, Ban, Users, Phone,
} from 'lucide-react';
import { leadApi } from '../api/client';
import { Lead } from '../types';

interface Session {
  status: 'DISCONNECTED' | 'QR' | 'CONNECTED' | 'AUTH_FAILED';
  bridgeAlive: boolean;
  keyConfigured: boolean;
  qr: string | null;
  phone: string | null;
  pushName: string | null;
  lastError: string | null;
  queued: number;
  dailyCap: number;
  remainingToday: number;
}

interface ThreadMsg {
  id: string;
  direction: 'OUT' | 'IN';
  body: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export default function WhatsAppBridgePanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Lead | null>(null);
  const [text, setText] = useState('');
  const [editingDraft, setEditingDraft] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);

  // حالة الجلسة — نُسرّع التحديث أثناء انتظار مسح QR ونُبطئه بعد الاتصال
  const { data: session } = useQuery({
    queryKey: ['wa-bridge-session'],
    queryFn: async () => (await leadApi.waBridgeSession()).data.data as Session,
    refetchInterval: (q) => ((q.state.data as Session | undefined)?.status === 'CONNECTED' ? 10000 : 3000),
  });

  const connected = session?.status === 'CONNECTED';

  // العملاء الذين لهم هاتف ولم ينسحبوا
  const { data: leads } = useQuery({
    queryKey: ['wa-bridge-leads'],
    queryFn: async () => (await leadApi.list({ hasPhone: true, optedOut: 'false', pageSize: 60 })).data.data as Lead[],
  });

  // القالب الافتراضي (يُحرّره المالك)
  const { data: draftData } = useQuery({
    queryKey: ['wa-bridge-draft'],
    queryFn: async () => (await leadApi.waBridgeDraft()).data.data as { template: string },
  });
  useEffect(() => { if (draftData?.template) setDraft(draftData.template); }, [draftData]);

  // معاينة الرسالة المخصّصة للعميل المحدَّد
  const { data: preview } = useQuery({
    queryKey: ['wa-bridge-preview', selected?.id],
    enabled: !!selected,
    queryFn: async () => (await leadApi.waBridgePreview(selected!.id)).data.data as { text: string; phone: string },
  });
  useEffect(() => { if (preview?.text) setText(preview.text); }, [preview]);

  const { data: thread } = useQuery({
    queryKey: ['wa-bridge-thread', selected?.id],
    enabled: !!selected,
    refetchInterval: 8000, // الردود تصل عبر الجسر — نُحدّث دورياً
    queryFn: async () => (await leadApi.waBridgeThread(selected!.id)).data.data as ThreadMsg[],
  });

  const send = useMutation({
    mutationFn: () => leadApi.waBridgeSend({ leadId: selected!.id, text }),
    onSuccess: () => {
      toast.success('أُدرجت في الطابور — الجسر سيرسلها خلال ثوانٍ');
      qc.invalidateQueries({ queryKey: ['wa-bridge-thread', selected?.id] });
      qc.invalidateQueries({ queryKey: ['wa-bridge-session'] });
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الإرسال'),
  });

  const saveDraft = useMutation({
    mutationFn: () => leadApi.waBridgeDraftSave({ template: draft }),
    onSuccess: () => {
      toast.success('حُفظ القالب');
      setEditingDraft(false);
      qc.invalidateQueries({ queryKey: ['wa-bridge-draft'] });
      qc.invalidateQueries({ queryKey: ['wa-bridge-preview'] });
    },
  });

  const logout = useMutation({
    mutationFn: () => leadApi.waBridgeLogout(),
    onSuccess: () => {
      toast.success('سيُفصل الجسر خلال ثوانٍ');
      qc.invalidateQueries({ queryKey: ['wa-bridge-session'] });
    },
  });

  // كم عميلاً سيُستهدف بالإرسال الجماعي الآن؟
  const { data: bulkCount } = useQuery({
    queryKey: ['wa-bridge-bulk-count'],
    enabled: connected,
    refetchInterval: 15000,
    queryFn: async () => (await leadApi.waBridgeBulkCount()).data.data as
      { eligible: number; remainingToday: number; willSend: number },
  });

  const bulk = useMutation({
    mutationFn: () => leadApi.waBridgeBulk({ limit: bulkCount?.willSend || 50 }),
    onSuccess: (res) => {
      const d = res.data.data as { queued: number; skipped: number; remainingToday: number };
      toast.success(`أُدرجت ${d.queued} رسالة في الطابور — الجسر يرسلها تباعاً`, { duration: 6000 });
      setConfirmBulk(false);
      qc.invalidateQueries({ queryKey: ['wa-bridge-session'] });
      qc.invalidateQueries({ queryKey: ['wa-bridge-bulk-count'] });
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الإدراج'),
  });

  // جودة الأرقام: الأرضي يُهدر الحصّة ويُضعف السمعة — نعرضه ونصنّف غير المصنَّف
  const { data: phones } = useQuery({
    queryKey: ['wa-phone-audit'],
    enabled: connected,
    queryFn: async () => (await leadApi.phoneAudit()).data.data as
      { mobile: number; landline: number; unknown: number; unclassified: number },
  });

  const classify = useMutation({
    mutationFn: () => leadApi.phoneClassify(),
    onSuccess: (res) => {
      const d = res.data.data as { total: number; mobile: number; landline: number; changed: number };
      toast.success(`صُنّف ${d.total} رقماً: ${d.mobile} جوّال · ${d.landline} أرضي (استُبعد)`, { duration: 6000 });
      qc.invalidateQueries({ queryKey: ['wa-phone-audit'] });
      qc.invalidateQueries({ queryKey: ['wa-bridge-bulk-count'] });
    },
    onError: () => toast.error('تعذّر التصنيف'),
  });

  const clearQueue = useMutation({
    mutationFn: () => leadApi.waBridgeQueueClear(),
    onSuccess: (res) => {
      toast.success(`أُفرغ الطابور (${(res.data.data as { cleared: number }).cleared} رسالة)`);
      qc.invalidateQueries({ queryKey: ['wa-bridge-session'] });
      qc.invalidateQueries({ queryKey: ['wa-bridge-bulk-count'] });
    },
  });

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 p-4 flex items-center justify-center" dir="rtl" onClick={onClose}>
      <div
        className="bg-[#FAF7F0] rounded-2xl w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* الترويسة */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#1F1A13] text-white flex-shrink-0">
          <h3 className="font-bold flex items-center gap-2">
            <MessageCircle size={18} className="text-[#25D366]" /> غرفة واتساب ويب
          </h3>
          <div className="flex items-center gap-3">
            {connected && (
              <span className="text-xs flex items-center gap-1.5 bg-[#25D366]/20 text-[#25D366] px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-[#25D366] animate-pulse" />
                {session?.phone ? `+${session.phone}` : 'متصل'}
              </span>
            )}
            <button onClick={onClose} className="text-white/60 hover:text-white"><X size={20} /></button>
          </div>
        </div>

        {/* غير متصل: شاشة الربط */}
        {!connected ? (
          <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
            <div className="max-w-md w-full text-center space-y-4">
              {session?.keyConfigured === false ? (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 text-right">
                  <b className="flex items-center gap-1.5 mb-1"><AlertTriangle size={15} /> ينقص مفتاح الجسر</b>
                  أضِف <code className="bg-red-100 px-1 rounded">WA_BRIDGE_KEY</code> في متغيّرات بيئة الخادم على Render،
                  واستخدم القيمة نفسها عند تشغيل الجسر على جهازك.
                </div>
              ) : session?.qr ? (
                <>
                  <div className="bg-white rounded-xl p-4 inline-block shadow-sm">
                    <img src={session.qr} alt="رمز QR لربط واتساب" className="w-64 h-64" />
                  </div>
                  <div className="text-sm text-gray-600 space-y-1">
                    <p className="font-semibold text-[#1F1A13]">امسح الرمز بهاتفك</p>
                    <p className="text-xs leading-relaxed">
                      واتساب ← الإعدادات ← <b>الأجهزة المرتبطة</b> ← ربط جهاز
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Smartphone size={44} className="mx-auto text-gray-300" />
                  <div className="space-y-1.5">
                    <p className="font-semibold text-[#1F1A13]">الجسر غير متصل</p>
                    <p className="text-sm text-gray-500 leading-relaxed">
                      شغّل الجسر على جهازك ثم سيظهر رمز QR هنا تلقائياً:
                    </p>
                    <code className="block bg-[#1F1A13] text-[#9A8F7E] rounded-lg p-2.5 text-xs text-left" dir="ltr">
                      cd wa-bridge<br />npm start
                    </code>
                    <p className="text-xs text-gray-400">التفاصيل في <code>wa-bridge/README.md</code></p>
                  </div>
                </>
              )}
              {session?.lastError && (
                <p className="text-xs text-red-500 bg-red-50 rounded-lg p-2">{session.lastError}</p>
              )}

              {/* الطابور يُدار من هنا أيضاً — إلغاء دفعة مُدرجة يجب أن يكون متاحاً **خصوصاً**
                  والجسر متوقّف: حبسُه خلف الاتصال يعني أن تصل الجلسة فتنطلق الرسائل قبل أن تُلغيها. */}
              {!!session?.queued && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-right space-y-2">
                  <p className="text-sm text-amber-900 leading-relaxed">
                    <Clock size={13} className="inline ml-1" />
                    <b>{session.queued}</b> رسالة تنتظر في الطابور — ستنطلق تلقائياً بمجرّد اتصال الجسر.
                  </p>
                  <button
                    onClick={() => clearQueue.mutate()}
                    disabled={clearQueue.isPending}
                    className="w-full border border-red-300 text-red-600 rounded-lg py-1.5 text-xs flex items-center justify-center gap-1 hover:bg-red-50 disabled:opacity-50"
                  >
                    {clearQueue.isPending ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
                    إفراغ الطابور الآن (قبل الاتصال)
                  </button>
                </div>
              )}

              <div className="flex items-center justify-center gap-1.5 text-xs text-gray-400">
                <Loader2 size={12} className="animate-spin" /> بانتظار الجسر...
              </div>
            </div>
          </div>
        ) : (
          /* متصل: العملاء + المحادثة */
          <div className="flex-1 flex overflow-hidden">
            {/* قائمة العملاء */}
            <aside className="w-64 flex-shrink-0 border-l border-[#E9E1D3] bg-white overflow-y-auto">
              <div className="p-2.5 border-b border-[#E9E1D3] text-xs text-gray-500 sticky top-0 bg-white">
                عملاء لديهم رقم ({leads?.length ?? 0})
              </div>
              {leads?.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setSelected(l)}
                  className={`w-full text-right px-3 py-2.5 border-b border-[#F1EBDF] hover:bg-[#FAF7F0] transition ${selected?.id === l.id ? 'bg-[#dcf8e8]' : ''}`}
                >
                  <p className="text-sm font-medium text-[#1F1A13] truncate">{l.name}</p>
                  <p className="text-xs text-gray-400 truncate">{[l.city, l.country].filter(Boolean).join(' · ') || l.phone}</p>
                </button>
              ))}
              {!leads?.length && <p className="p-4 text-xs text-gray-400 text-center">لا يوجد عملاء بأرقام هواتف</p>}
            </aside>

            {/* المحادثة والإنشاء */}
            <main className="flex-1 flex flex-col overflow-hidden">
              {!selected ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  اختر عميلاً من القائمة لإرسال رسالة
                </div>
              ) : (
                <>
                  <div className="px-4 py-2.5 border-b border-[#E9E1D3] bg-white flex items-center justify-between flex-shrink-0">
                    <div>
                      <p className="font-semibold text-sm text-[#1F1A13]">{selected.name}</p>
                      <p className="text-xs text-gray-400" dir="ltr">{preview?.phone ? `+${preview.phone}` : selected.phone}</p>
                    </div>
                    <span className="text-xs text-gray-400">{selected.country}</span>
                  </div>

                  {/* المحادثة */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {thread?.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === 'OUT' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${m.direction === 'OUT' ? 'bg-[#dcf8e8] text-[#1F1A13]' : 'bg-white border border-[#E9E1D3] text-gray-700'}`}>
                          {m.body}
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-400">
                            {m.direction === 'OUT' && (
                              m.status === 'QUEUED' ? <Clock size={10} /> :
                              m.status === 'FAILED' ? <AlertTriangle size={10} className="text-red-500" /> :
                              <CheckCheck size={10} className="text-[#25D366]" />
                            )}
                            {new Date(m.createdAt).toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                            {m.error && <span className="text-red-500">· {m.error}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                    {!thread?.length && <p className="text-center text-xs text-gray-400 py-6">لا توجد رسائل بعد</p>}
                  </div>

                  {/* الإنشاء */}
                  <div className="border-t border-[#E9E1D3] bg-white p-3 space-y-2 flex-shrink-0">
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={5}
                      className="input text-sm w-full"
                      placeholder="نصّ الرسالة..."
                    />
                    <div className="flex items-center gap-2">
                      <button
                        disabled={send.isPending || !text.trim() || (session?.remainingToday ?? 0) <= 0}
                        onClick={() => send.mutate()}
                        className="bg-[#25D366] text-white rounded-lg px-4 py-2 text-sm flex items-center gap-2 hover:bg-[#1eb356] disabled:opacity-50"
                      >
                        {send.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                        إرسال
                      </button>
                      <span className="text-xs text-gray-400">
                        متبقٍّ اليوم {session?.remainingToday ?? 0} / {session?.dailyCap ?? '—'}
                        {!!session?.queued && <> · في الطابور {session.queued}</>}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </main>

            {/* القالب والتحكّم */}
            <aside className="w-72 flex-shrink-0 border-r border-[#E9E1D3] bg-white p-3 space-y-3 overflow-y-auto">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="label mb-0">القالب الافتراضي</label>
                  {editingDraft ? (
                    <button onClick={() => saveDraft.mutate()} className="text-xs text-[#25D366] flex items-center gap-1 hover:underline">
                      <Save size={12} /> حفظ
                    </button>
                  ) : (
                    <button onClick={() => setEditingDraft(true)} className="text-xs text-gray-400 flex items-center gap-1 hover:text-[#E15A30]">
                      <Pencil size={12} /> تحرير
                    </button>
                  )}
                </div>
                {editingDraft ? (
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} className="input text-xs w-full" />
                ) : (
                  <p className="text-xs text-gray-500 bg-[#FAF7F0] rounded-lg p-2 whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto">{draft}</p>
                )}
                <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                  عناصر نائبة: <code>{'{{name}}'}</code> <code>{'{{city}}'}</code> <code>{'{{country}}'}</code>{' '}
                  <code className="text-[#E15A30]">{'{{angle}}'}</code> — زاوية دولة العميل تُحقن تلقائياً.
                </p>
              </div>

              {/* تنظيف الأرقام الأرضية — تُهدر الحصّة وتُضعف سمعة الرقم بمحاولة فاشلة */}
              {!!phones && (phones.landline > 0 || phones.unclassified > 0) && (
                <div className="border-t border-[#E9E1D3] pt-3">
                  <label className="label flex items-center gap-1"><Phone size={12} /> جودة الأرقام</label>
                  <div className="text-xs space-y-1 bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg p-2.5">
                    <div className="flex justify-between"><span className="text-gray-500">جوّال (صالح لواتساب)</span><b className="text-[#166534]">{phones.mobile}</b></div>
                    <div className="flex justify-between"><span className="text-gray-500">أرضي (مستبعَد)</span><b className="text-red-600">{phones.landline}</b></div>
                    {!!phones.unclassified && (
                      <div className="flex justify-between"><span className="text-gray-500">غير مصنَّف</span><b className="text-amber-600">{phones.unclassified}</b></div>
                    )}
                  </div>
                  {!!phones.unclassified && (
                    <button
                      onClick={() => classify.mutate()}
                      disabled={classify.isPending}
                      className="w-full mt-2 border border-[#E9E1D3] rounded-lg py-1.5 text-xs text-gray-700 flex items-center justify-center gap-1 hover:border-[#E15A30] disabled:opacity-50"
                    >
                      {classify.isPending ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />}
                      صنّف {phones.unclassified} رقماً
                    </button>
                  )}
                  <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
                    الأرضي لا واتساب له — يُستبعد من الاستهداف ولا يُحذف من عملائك (يبقى للاتصال والبريد).
                  </p>
                </div>
              )}

              {/* الإرسال الجماعي — يُدرج الكلّ في الطابور، والجسر يرسل بإيقاع بشري */}
              <div className="border-t border-[#E9E1D3] pt-3">
                <label className="label flex items-center gap-1"><Users size={12} /> إرسال جماعي</label>
                <div className="bg-[#dcf8e8] rounded-lg p-2.5 text-xs text-[#166534] leading-relaxed mb-2">
                  <b>{bulkCount?.eligible ?? 0}</b> عميل مؤهَّل (له رقم · لم يُراسَل · لم ينسحب)
                  <br />سيُدرج الآن: <b>{bulkCount?.willSend ?? 0}</b> ضمن حصّة اليوم
                  <br />من تصله الرسالة ⇒ <b>«تم التواصل»</b> تلقائياً
                </div>

                {!confirmBulk ? (
                  <button
                    disabled={!bulkCount?.willSend}
                    onClick={() => setConfirmBulk(true)}
                    className="w-full bg-[#128C7E] text-white rounded-lg py-2 text-sm flex items-center justify-center gap-2 hover:bg-[#0f7268] disabled:opacity-50"
                  >
                    <Send size={14} /> إرسال جماعي لـ{bulkCount?.willSend ?? 0}
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2 leading-relaxed">
                      ستُرسل <b>{bulkCount?.willSend}</b> رسالة حقيقية لأرقام حقيقية. متأكّد؟
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        disabled={bulk.isPending}
                        onClick={() => bulk.mutate()}
                        className="flex-1 bg-[#128C7E] text-white rounded-lg py-1.5 text-xs flex items-center justify-center gap-1 disabled:opacity-50"
                      >
                        {bulk.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} نعم، أرسل
                      </button>
                      <button onClick={() => setConfirmBulk(false)} className="flex-1 border border-[#E9E1D3] rounded-lg py-1.5 text-xs text-gray-600">
                        إلغاء
                      </button>
                    </div>
                  </div>
                )}

                {!!session?.queued && (
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <span className="text-gray-500 flex items-center gap-1">
                      <Clock size={11} /> في الطابور: <b>{session.queued}</b>
                    </span>
                    <button onClick={() => clearQueue.mutate()} className="text-red-500 hover:underline">إفراغ</button>
                  </div>
                )}
              </div>

              <div className="border-t border-[#E9E1D3] pt-3 space-y-2">
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 leading-relaxed">
                  <Ban size={11} className="inline ml-1" />
                  من يردّ «إيقاف» يُستثنى تلقائياً وللأبد. ابدأ بعدد قليل يومياً — الحظر يأتي من البلاغات لا من العدد.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => qc.invalidateQueries({ queryKey: ['wa-bridge-session'] })}
                    className="flex-1 text-xs border border-[#E9E1D3] rounded-lg py-1.5 text-gray-600 flex items-center justify-center gap-1 hover:border-[#E15A30]"
                  >
                    <RefreshCw size={12} /> تحديث
                  </button>
                  <button
                    onClick={() => logout.mutate()}
                    className="flex-1 text-xs border border-red-200 text-red-600 rounded-lg py-1.5 flex items-center justify-center gap-1 hover:bg-red-50"
                  >
                    <LogOut size={12} /> فصل الجلسة
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
