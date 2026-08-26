import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { waAgentApi } from '../api/client';
import { X, Copy, Sparkles, AlertTriangle, MessageCircle, Send, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { backdropClose } from '../lib/backdropClose';

/**
 * وضع الظل لوكيل واتساب — الخطوة الأولى قبل الأتمتة الكاملة.
 *
 * المالك يلصق رسالة العميل ورقمه (ليُستنتج اللهجة)، فيولّد الوكيل الردّ المقترح
 * بالعامية الصحيحة مارّاً بالحارس الحتمي، والمالك ينسخه ويرسله من واتسابه بنفسه.
 * لا إرسال ولا تسجيل ولا مساس بقاعدة العملاء — اختبار جودة خالص.
 */

const DIALECT_LABEL: Record<string, string> = {
  gulf: 'خليجي', egypt: 'مصري', levant: 'شامي', maghreb: 'مغاربي', msa: 'فصحى (لهجة غير معروفة)',
};

interface Suggestion {
  reply: string;
  dialect: string;
  wouldEscalate: boolean;
  reason: string;
  source: string;
  violations: string[];
}

export default function WaAgentShadowPanel({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Suggestion | null>(null);

  const { data: status } = useQuery({
    queryKey: ['wa-agent-status'],
    queryFn: () => waAgentApi.status().then((r) => r.data.data as {
      autoEnabled: boolean; claude: boolean; claudeModel: string | null; gemini: boolean; llmReady: boolean;
    }),
  });

  const suggest = useMutation({
    mutationFn: () => waAgentApi.suggest({ phone: phone.trim(), message: message.trim(), name: name.trim() || undefined })
      .then((r) => r.data.data as Suggestion),
    onSuccess: (d) => setResult(d),
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر توليد الرد';
      toast.error(msg);
    },
  });

  const copy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.reply);
    toast.success('نُسخ الرد — الصقه في واتساب');
  };

  const canSubmit = phone.trim().length >= 6 && message.trim().length >= 1 && !suggest.isPending;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
        {/* الترويسة */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#EDE7DC]">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-[#25D366]/10 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-[#128C4B]" />
            </div>
            <div>
              <h2 className="font-bold text-[#1F1A13]">مساعد واتساب — وضع الظل</h2>
              <p className="text-xs text-[#8A8072]">يقترح الرد باللهجة، وأنت ترسله بنفسك</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        {/* شريط الحالة */}
        <div className="px-5 pt-4">
          {status && !status.llmReady && (
            <div className="flex items-center gap-2 text-sm bg-[#FDECEC] text-[#B4322A] rounded-lg px-3 py-2 mb-3">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              لا يوجد مزوّد ذكاء مضبوط — اضبط ANTHROPIC_API_KEY أو GEMINI_API_KEY في الخادم.
            </div>
          )}
          {status?.llmReady && (
            <div className="text-xs text-[#8A8072] mb-3">
              المحرّك: {status.claude ? <span className="text-[#128C4B] font-semibold">Claude ({status.claudeModel})</span> : <span className="text-[#128C4B] font-semibold">Gemini</span>}
              {status.autoEnabled
                ? <span className="mr-2 text-[#9A6B1E]"> · الأتمتة الكاملة مفعّلة</span>
                : <span className="mr-2"> · الأتمتة الكاملة مطفأة (وضع ظل فقط)</span>}
            </div>
          )}
        </div>

        {/* النموذج */}
        <div className="px-5 pb-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-[#6E6557] mb-1">رقم واتساب العميل</label>
              <input
                dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+9665xxxxxxxx"
                className="w-full rounded-lg border border-[#E4DCCB] px-3 py-2 text-sm text-right focus:border-[#E15A30] outline-none"
              />
              <p className="text-[10px] text-[#A89E8C] mt-1">كود الدولة يحدّد اللهجة تلقائياً</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6E6557] mb-1">اسم العميل (اختياري)</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="كما يظهر في واتساب"
                className="w-full rounded-lg border border-[#E4DCCB] px-3 py-2 text-sm focus:border-[#E15A30] outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6E6557] mb-1">رسالة العميل</label>
            <textarea
              value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
              placeholder="الصق ما كتبه العميل هنا…"
              className="w-full rounded-lg border border-[#E4DCCB] px-3 py-2 text-sm resize-none focus:border-[#E15A30] outline-none"
            />
          </div>

          <button
            onClick={() => suggest.mutate()} disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#E15A30] text-white font-bold py-2.5 disabled:opacity-40 hover:bg-[#c94a24] transition"
          >
            <Sparkles className="w-4.5 h-4.5" />
            {suggest.isPending ? 'يفكّر…' : 'اقترح الرد'}
          </button>
        </div>

        {/* النتيجة */}
        {result && (
          <div className="px-5 pb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-[#6E6557]">
                اللهجة: <span className="text-[#E15A30]">{DIALECT_LABEL[result.dialect] || result.dialect}</span>
                <span className="text-[#A89E8C] mr-2">· {result.source === 'claude' ? 'Claude' : result.source === 'gemini' ? 'Gemini' : '—'}</span>
              </span>
              <button onClick={copy} className="flex items-center gap-1 text-xs text-[#128C4B] font-semibold hover:underline">
                <Copy className="w-3.5 h-3.5" /> نسخ
              </button>
            </div>

            {/* فقاعة واتساب */}
            <div className={`rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${result.wouldEscalate ? 'bg-[#FBF0D8] border border-[#E7C877]' : 'bg-[#E7FFDB] border border-[#B9E9A0]'}`}>
              {result.reply}
            </div>

            {result.wouldEscalate ? (
              <div className="mt-3 flex items-start gap-2 text-xs bg-[#FDF3E3] text-[#9A6B1E] rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <b>هذه الحالة كان الوكيل سيصعّدها إليك</b> بدل الرد آلياً — الرسالة أعلاه هي رسالة التحويل الآمنة.
                  {result.reason ? <span className="block mt-1 text-[#8A7B5E]">السبب: {result.reason}</span> : null}
                  <span className="block mt-1">أكمل أنت المحادثة البيعية بنفسك.</span>
                </span>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 text-xs text-[#8A8072]">
                <Send className="w-3.5 h-3.5" />
                انسخ الرد وأرسله من واتسابك — راجعه أولاً وعدّل ما تراه.
              </div>
            )}
          </div>
        )}

        {/* تلميح أول مرة */}
        {!result && (
          <div className="px-5 pb-6 -mt-1">
            <div className="flex items-start gap-2 text-xs text-[#8A8072] bg-[#F7F3EA] rounded-lg px-3 py-2.5">
              <User className="w-4 h-4 shrink-0 mt-0.5 text-[#B0A48E]" />
              الصق رسالة عميل حقيقية وجرّب: الوكيل يرحّب، يسأل عن عدد المناديب، يحسب التكلفة بالعرض، ويغلق بخيارين —
              وأي اعتراض سعري أو طلب مسؤول يصعّده إليك بدل أن يعِد بشيء.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
