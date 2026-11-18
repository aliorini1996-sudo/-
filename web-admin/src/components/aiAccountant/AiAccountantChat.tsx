import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Eye, ListChecks, Lock, MessageSquareText, RotateCcw, SendHorizontal } from 'lucide-react';
import { aiAccountantApi, companyApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { canLedger } from '../../lib/ledgerPerms';
import { useAuthStore } from '../../store/authStore';
import {
  MAX_TEXT, browserToday, buildChatBody, chatErrorInfo, entryId, firstBlankRange, hasBlank, isBlockingError, markReversed,
  newClientRef, normalizeChatResponse, normalizeStatus, statusLine, templateText,
  type AiStatus, type ChatEntry, type ChatTemplate,
} from '../../lib/aiAccountant';
import TemplateBar from './chat/TemplateBar';
import { AssistantBubble, ThinkingBubble, UserBubble, WelcomeCard } from './chat/ChatBubbles';
import AiPostsList from './posts/AiPostsList';

/**
 * «المحاسب الذكي AI» — غلاف المحادثة (صفحة الويب /app/ai-accountant وشاشة /m بـcompact).
 *
 * - شريط الحالة من GET /ai-accountant/status: «الدفاتر مفعّلة — يسجّل القيود» أو «قراءة فقط…»، وتبويب «قيود المحاسب
 *   الذكي» لمن يرى الدفاتر المفعّلة (سجلّ ما رحّله المحاسب — لا «يرحّل الآن»: مفتاح الإطفاء AI_ACCOUNTANT_WRITE=0 يُطفأ
 *   غالباً بعد ترحيلٍ خاطئ، وحينها بالذات يُحتاج السجلّ وزرّ «عكس القيد»). رفض الخادم (٤٠٣ الميزة/المحاسبة/الصلاحية/النطاق)
 *   يحجب المحادثة بإشعارٍ واضح — الخادم يفرضها كلّها، والواجهة تشرح فقط.
 * - المحادثة في ذاكرة المكوّن وحدها (لا تخزين — قرار المواصفة)، والطلب آخر ١٢ رسالة بمرجع UUID جديد لكل إرسال؛
 *   «إعادة المحاولة» تعيد مرجع الرسالة نفسه فلا يُرحَّل قيدٌ مرّتين إن انقطعت المهلة بعد الترحيل (lib/aiAccountant.ts).
 * - كل ردّ: نصّه، ثم بطاقة لكل تقرير (ReportCard: جدول + PDF بهوية الشركة + طباعة)، ثم بطاقة لكل قيد رُحّل
 *   (PostedMoveCard: رقمه ومرجعه وحساباته و«عكس القيد») — نجاح العكس يَسِم البطاقة ويحدّث قائمة القيود.
 * - compact: ملء الارتفاع، حشوٌ أصغر، وشرائح تُمرَّر أفقياً، و«Enter» سطرٌ جديد (لوحة مفاتيح الجوال) والإرسال بالزر.
 */
const STATUS_KEY = ['ai-accountant-status'] as const;
const POSTS_KEY = ['ai-accountant-posts'] as const;

const httpStatus = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status ?? 0;

export default function AiAccountantChat({ compact = false }: { compact?: boolean }) {
  const tr = useTr();
  const qc = useQueryClient();

  const statusQ = useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => ((await aiAccountantApi.status()).data?.data ?? null) as unknown,
    staleTime: 60_000,
    // رفضٌ صريح (٤xx) لا يتغيّر بالإعادة — الإعادة لانقطاع الشبكة و٥xx وحدهما
    retry: (n, e) => { const s = httpStatus(e); return !(s >= 400 && s < 500) && n < 2; },
  });
  // احتياط علمَي الحالة إن لم يرسلهما الخادم: رؤية الدفاتر بمسند الخادم نفسه (canLedger، وجلسة المالك تمرّ كما في
  // acctCtxFrom)، والمخزون من علم الشركة — المفتاح ['company'] نفسه في كل اللوحة فيُقرأ من الذاكرة غالباً
  const user = useAuthStore(s => s.user);
  const ownerSession = useAuthStore(s => !!s.impersonating);
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { warehouseEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  const companyWarehouse = companyQ.data ? companyQ.data.warehouseEnabled === true : undefined;
  const status: AiStatus | null = useMemo(
    () => normalizeStatus(statusQ.data, { canViewLedger: ownerSession || canLedger(user, 'canViewLedger'), warehouseOn: companyWarehouse }),
    [statusQ.data, ownerSession, user, companyWarehouse],
  );

  const [tab, setTab] = useState<'chat' | 'posts'>('chat');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  /** رفضٌ حاجب وصل من المحادثة نفسها (أطفأ المالك الميزة أثناء الجلسة مثلاً) */
  const [blocked, setBlocked] = useState<string | null>(null);
  /**
   * الخانة ملأها قالب ترحيل (بفراغ «…») — فحص الفراغ لها وحدها: لوحة الآيفون تحوّل «...» إلى «…» تلقائياً، فلو فُحص كل
   * نصّ لمُنع سؤالٌ عادي كتبه المستخدم بثلاث نقاط.
   */
  const [fromTemplate, setFromTemplate] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  // التبويب لمن له سجلٌّ يراه (الدفاتر مفعّلة ويراها) — لا لمن يرحّل الآن وحده: GET /posts يعيد القيود لكل من يرى الدفاتر
  const showPosts = status?.booksActivated === true && status?.canViewLedger === true;
  const activeTab = showPosts ? tab : 'chat';

  // الخانة تكبر مع النص حتى خمسة أسطر تقريباً ثم تُمرَّر
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 112 : 140)}px`;
  }, [input, compact, activeTab]);

  // التمرير: ردٌّ جديد يُعرض من أوّله (التقرير الطويل لا يُقفز فوقه إلى آخره)، وما سواه إلى الأسفل
  const lastId = entries[entries.length - 1]?.id;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const last = entries[entries.length - 1];
    if (!pending && last?.role === 'assistant' && !last.error) {
      const el = box.querySelector<HTMLElement>(`[data-entry="${last.id}"]`);
      if (el) { box.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' }); return; }
    }
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- يكفي تغيّر آخر فقاعة وحالة الانتظار
  }, [lastId, pending]);

  /** إرسال سياقٍ ينتهي برسالة `user` — جديدةً كانت أو مُعادة (بمرجعها نفسه) */
  const run = async (all: ChatEntry[], user: ChatEntry) => {
    // قفلٌ متزامن فوق حالة الانتظار: ضغطتا Enter قبل إعادة الرسم كانتا طلبين بمرجعين — وقيدين لو كان طلب ترحيل
    if (busy.current) return;
    const body = user.clientRef ? buildChatBody(all, user.clientRef, user.id) : null;
    if (!body) return;
    busy.current = true;
    setEntries(all.map(e => (e.id === user.id ? { ...e, failed: false } : e)));
    setPending(true);
    try {
      const res = await aiAccountantApi.chat(body);
      const d = normalizeChatResponse(res.data?.data);
      setEntries(cur => [...cur, {
        id: entryId(), role: 'assistant', text: d.text,
        reports: d.reports, posted: d.posted, warnings: d.warnings, guard: d.guard, turnId: d.turnId,
      }]);
      if (d.posted.length) void qc.invalidateQueries({ queryKey: POSTS_KEY });
    } catch (err) {
      const info = chatErrorInfo(err);
      setEntries(cur => [
        ...cur.map(e => (e.id === user.id ? { ...e, failed: true } : e)),
        { id: entryId(), role: 'assistant', text: '', error: info.message, retryable: info.retryable },
      ]);
      if (isBlockingError(info.kind)) {
        setBlocked(info.message);
        void qc.invalidateQueries({ queryKey: STATUS_KEY });
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const focusBlank = (text: string) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const [a, b] = firstBlankRange(text);
      el.focus();
      try { el.setSelectionRange(a, b); } catch { /* متصفّحٌ لا يدعم التحديد في هذه الحالة */ }
    });
  };

  /**
   * إرسال نصّ: من الخانة (fromInput — تُفرَّغ بعده) أو من شريحة قالب (الخانة ومسوّدتها تبقيان كما هما).
   */
  const send = (raw: string, fromInput = false) => {
    const text = raw.trim();
    if (!text || pending || busy.current) return;
    // نصّ قالب ترحيلٍ لم يُكمَل: لا يُرسَل «…» إلى المحاسب (المبلغ يكتبه المستخدم بنفسه)
    if (fromInput && fromTemplate && hasBlank(text)) { setHint('أكمل الفراغات (…) قبل الإرسال'); focusBlank(raw); return; }
    const user: ChatEntry = { id: entryId(), role: 'user', text: text.slice(0, MAX_TEXT), clientRef: newClientRef() };
    if (fromInput) {
      setInput('');
      setFromTemplate(false);
      setHint(null);
    }
    void run([...entries, user], user);
  };

  const retry = (errorId: string) => {
    if (pending) return;
    const idx = entries.findIndex(e => e.id === errorId);
    if (idx < 0) return;
    const user = entries.slice(0, idx).reverse().find(e => e.role === 'user');
    if (!user?.clientRef) return;
    void run(entries.filter(e => e.id !== errorId), user);
  };

  const onReversed = (moveId: string) => {
    setEntries(cur => markReversed(cur, moveId));
    void qc.invalidateQueries({ queryKey: POSTS_KEY });
    void qc.invalidateQueries({ queryKey: STATUS_KEY });
  };

  const today = status?.todayLocal ?? browserToday();
  const onPick = (t: ChatTemplate) => {
    const text = templateText(t, { todayLocal: today, currency: status?.currency, booksActivated: status?.booksActivated }, tr);
    if (t.mode === 'prefill') {
      setInput(text);
      setFromTemplate(true);
      setHint(null);
      focusBlank(text);
      return;
    }
    send(text);
  };
  const onRange = (t: ChatTemplate, range: { from: string; to: string }) =>
    send(templateText(t, { todayLocal: today, currency: status?.currency, booksActivated: status?.booksActivated, range }, tr));

  const reset = () => {
    if (pending) return;
    setEntries([]);
    setInput('');
    setFromTemplate(false);
    setHint(null);
  };

  // ─── الحالات الحاجبة ───
  const statusErr = statusQ.error ? chatErrorInfo(statusQ.error) : null;
  const blockMsg = blocked
    ?? (statusErr && isBlockingError(statusErr.kind) ? statusErr.message : null)
    ?? (status && !status.enabled ? 'المحاسب الذكي غير مفعل لشركتك — تواصل مع مزود الخدمة لتفعيله' : null);

  const shell = compact
    ? 'h-full min-h-0 flex flex-col bg-[#FAF7F0]'
    : 'card !p-0 flex flex-col overflow-hidden h-[calc(100vh-11rem)] min-h-[520px]';

  if (blockMsg) {
    return (
      <div className={shell}>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
          <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
            <Lock size={22} />
          </div>
          <p className="text-sm font-semibold text-[#1F1A13] max-w-md">{tr(blockMsg)}</p>
        </div>
      </div>
    );
  }

  if (statusQ.isPending) {
    return (
      <div className={shell}>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#9A8F7E]">
          <span className="w-7 h-7 border-2 border-[#E9E1D3] border-t-[#E15A30] rounded-full animate-spin" />
          <p className="text-xs">{tr('جاري التحميل')}</p>
        </div>
      </div>
    );
  }

  if (statusErr || !status) {
    return (
      <div className={shell}>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6 py-10">
          <p className="text-sm text-[#6E6557]">{tr(statusErr?.message ?? 'تعذر تحميل حالة المحاسب الذكي')}</p>
          <button type="button" className="btn-secondary" onClick={() => void statusQ.refetch()}>
            <RotateCcw size={14} /> {tr('إعادة المحاولة')}
          </button>
        </div>
      </div>
    );
  }

  const line = statusLine(status);
  const toneCls = line.tone === 'post'
    ? 'bg-[#E4F1EA] text-[#1E7A52] border-[#C6E3D2]'
    : line.tone === 'read-only'
      ? 'bg-[#FAEFD8] text-[#8A6A12] border-[#F0DDB0]'
      : 'bg-[#F1EBDF] text-[#6E6557] border-[#E0D7C6]';
  const lastEntry = entries[entries.length - 1];
  const tabBtn = (id: 'chat' | 'posts', label: string, Icon: typeof MessageSquareText) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === id}
      onClick={() => setTab(id)}
      className={`inline-flex items-center gap-1.5 border-b-2 transition-colors ${compact ? 'px-2.5 py-2 text-xs' : 'px-3 py-2.5 text-sm'} ${activeTab === id ? 'border-[#E15A30] text-[#1F1A13] font-semibold' : 'border-transparent text-[#9A8F7E] hover:text-[#44403a]'}`}
    >
      <Icon size={compact ? 13 : 15} /> {tr(label)}
    </button>
  );

  return (
    <div className={shell}>
      {/* شريط الحالة والتبويبات */}
      <div className={`flex-shrink-0 border-b border-[#E9E1D3] bg-white ${compact ? 'px-3' : 'px-4'}`}>
        <div className={`flex items-center gap-2 flex-wrap ${compact ? 'pt-2 pb-1' : 'pt-3 pb-1.5'}`}>
          <span className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${compact ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'} ${toneCls}`}>
            {line.tone === 'post' ? <BookOpenCheck size={compact ? 12 : 13} /> : <Eye size={compact ? 12 : 13} />}
            {tr(line.text)}
          </span>
          <span className={`text-[#9A8F7E] ${compact ? 'text-[11px]' : 'text-xs'}`} dir="ltr">{status.currency}</span>
          {entries.length > 0 && activeTab === 'chat' && (
            <button type="button" onClick={reset} disabled={pending}
              className={`ms-auto inline-flex items-center gap-1 text-[#6E6557] hover:text-[#E15A30] disabled:opacity-40 ${compact ? 'text-[11px]' : 'text-xs'}`}>
              <RotateCcw size={12} /> {tr('محادثة جديدة')}
            </button>
          )}
        </div>
        {showPosts && (
          <div className="flex items-center gap-1 -mb-px" role="tablist">
            {tabBtn('chat', 'المحادثة', MessageSquareText)}
            {tabBtn('posts', 'قيود المحاسب الذكي', ListChecks)}
          </div>
        )}
      </div>

      {activeTab === 'posts' ? (
        <div className={`flex-1 min-h-0 overflow-y-auto ${compact ? 'p-3' : 'p-4'}`}>
          <AiPostsList />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className={`relative flex-1 min-h-0 overflow-y-auto ${compact ? 'px-3 py-3 space-y-3' : 'px-4 py-4 space-y-4'}`}>
            {entries.length === 0 && !pending && <WelcomeCard status={status} compact={compact} />}
            {entries.map(e => (
              <div key={e.id} data-entry={e.id}>
                {e.role === 'user'
                  ? <UserBubble entry={e} compact={compact} />
                  : <AssistantBubble entry={e} compact={compact} onReversed={onReversed}
                      canRetry={!pending && e.retryable === true && e.id === lastEntry?.id}
                      onRetry={() => retry(e.id)} />}
              </div>
            ))}
            {pending && <ThinkingBubble compact={compact} />}
          </div>

          <div className={`flex-shrink-0 bg-white border-t border-[#E9E1D3] ${compact ? '' : 'pb-1'}`}>
            <TemplateBar status={status} compact={compact} singleRow={compact || entries.length > 0} disabled={pending}
              onPick={onPick} onRange={onRange} />
            <form
              onSubmit={e => { e.preventDefault(); send(input, true); }}
              className={`flex items-end gap-2 ${compact ? 'px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]' : 'px-4 pt-1.5 pb-2'}`}
            >
              <textarea
                ref={inputRef}
                rows={1}
                dir="auto"
                maxLength={MAX_TEXT}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  if (!e.target.value.trim()) setFromTemplate(false);
                  if (hint) setHint(null);
                }}
                onKeyDown={e => {
                  // الويب: Enter يرسل وShift+Enter سطرٌ جديد (ولا إرسال أثناء تركيب حروف لوحة IME)؛ الجوال يرسل بالزر
                  if (!compact && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(input, true);
                  }
                }}
                placeholder={tr('اكتب سؤالك… مثل: كم بعنا هذا الشهر؟')}
                aria-label={tr('رسالتك للمحاسب الذكي')}
                className={`input resize-none leading-relaxed ${compact ? 'text-[13px] py-2' : ''}`}
              />
              <button
                type="submit"
                disabled={!input.trim() || pending}
                aria-label={tr('إرسال')}
                title={tr('إرسال')}
                className={`shrink-0 rounded-xl bg-[#E15A30] hover:bg-[#C94E28] text-white flex items-center justify-center transition-colors disabled:opacity-40 disabled:hover:bg-[#E15A30] ${compact ? 'w-10 h-10' : 'w-11 h-[38px]'}`}
              >
                <SendHorizontal size={18} className="rtl:-scale-x-100" />
              </button>
            </form>
            {hint && <p className={`text-xs text-[#C0392B] ${compact ? 'px-3 pb-2' : 'px-4 pb-2'}`}>{tr(hint)}</p>}
            {!compact && !hint && (
              <p className="px-4 pb-1.5 text-[11px] text-[#9A8F7E]">{tr('الأرقام من النظام مباشرة — راجع القيود في الدفاتر قبل الاعتماد النهائي')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
