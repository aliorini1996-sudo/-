import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Eye, ListChecks, Lock, MessageSquareText, Paperclip, RotateCcw, SendHorizontal } from 'lucide-react';
import { aiAccountantApi, companyApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { canLedger } from '../../lib/ledgerPerms';
import { isTaxOff } from '../../lib/taxMode';
import { useAuthStore } from '../../store/authStore';
import {
  MAX_TEXT, browserToday, buildChatBody, chatErrorInfo, entryId, firstBlankRange, hasBlank, isBlockingError, markReversed,
  newClientRef, normalizeChatResponse, normalizeStatus, replaceDocView, statusLine, templateText,
  type AcctDocConfirm, type AcctDocView, type AiStatus, type ChatAttachment, type ChatEntry, type ChatTemplate,
} from '../../lib/aiAccountant';
import {
  createBlobUrlRegistry, docApiErrorInfo, docDefaultText, docFileProblemText, normalizeDocResponse, prepareDocUpload,
} from '../../lib/aiAccountantDocs';
import TemplateBar from './chat/TemplateBar';
import { AssistantBubble, ThinkingBubble, UserBubble, WelcomeCard } from './chat/ChatBubbles';
import AiPostsList from './posts/AiPostsList';
import AttachTray from './docs/AttachTray';
import DocChips from './docs/DocChips';
import DocViewer, { DocViewerRenderContext, type RenderDocViewer, type ViewerDoc } from './docs/DocViewer';
import type { DocCardEnv } from './docs/DocCard';
import {
  activeRefusals, cardOwners, confirmingDocId, docIdInUse, lastConfirms, latestDocView, pendingBusy, readyDocIds, refusalsByDoc,
  slotsLeft, type PendingDoc,
} from './docs/docCardLogic';

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
 * - رفع المستندات (طلب المالك ١٨ نوفمبر): 📎 أوّل خانة الكتابة لمن status.docs.enabled وحده ⇒ صينية «تصوير / من الاستديو /
 *   ملف PDF» (AttachTray) ⇒ كل ملفٍّ يُجهَّز في الجهاز (ضغط الصورة وقراءة رمز QR — لا قارئ ذكاء اصطناعي، D4) ثم يُرفع بشريحةٍ
 *   بنسبتها (DocChips)، وحتى ٣ في الرسالة. الإرسال بلا نصّ ⇒ «اقرأ المستند المرفق ولخّص بياناته» (لا يطابق نيّة التسجيل).
 *   الردّ يحمل بطاقة المستند (DocCard) — لا ترحيل إلا بضغطة «سجّل القيد» فيها: رسالةٌ بنصٍّ مركّب وdocConfirm، والخادم يرحّل بلا
 *   نموذج. ردٌّ تعذّر (الحدّ اليومي مثلاً — ودورة التأكيد لا تحتاج النموذج ولا الحصّة) يحمل بطاقات مستندات رسالته في إشعار خطئه
 *   فلا يضيع مستندٌ رُفع. «محادثة جديدة» تمحو المرفقات وتُبطل روابط المعاينة. العارض: DocViewer هنا، أو عارض الجوال بـrenderViewer.
 */
const STATUS_KEY = ['ai-accountant-status'] as const;
const POSTS_KEY = ['ai-accountant-posts'] as const;

const httpStatus = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status ?? 0;

/** ما يُرفق برسالةٍ تُرسَل: مستنداتها، وdocConfirm لرسالة «سجّل القيد» من البطاقة */
interface SendExtra {
  docIds?: string[];
  docConfirm?: AcctDocConfirm;
}

let chipSeq = 0;
const chipKey = () => `doc-${Date.now().toString(36)}-${(chipSeq++).toString(36)}`;

export default function AiAccountantChat({ compact = false, renderViewer }: {
  compact?: boolean;
  /**
   * عارض المستند البديل (طبقة الجوال MDocViewer) — بغيابه DocViewer لسطح المكتب. src رابط المعاينة المحلي (Blob) إن رُفع
   * الملف من هذا الجهاز: يملكه المستدعي هنا (سجلّ الروابط) فلا يُبطله العارض.
   */
  renderViewer?: (doc: ViewerDoc, onClose: () => void, src?: string | null) => ReactNode;
}) {
  const viewerCtx: RenderDocViewer | null = renderViewer ?? null;
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
    queryFn: async () => (await companyApi.get()).data.data as { warehouseEnabled?: boolean; taxDisabled?: boolean | null } | null,
    staleTime: 300_000,
  });
  const companyWarehouse = companyQ.data ? companyQ.data.warehouseEnabled === true : undefined;
  // «إزالة الضريبة»: بطاقة المستند بلا صفوف ضريبة ولا رقم ضريبي ولا رمز QR (lib/taxMode.ts)
  const taxOff = isTaxOff(companyQ.data);
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

  // ─── المستندات ───
  const [trayOpen, setTrayOpen] = useState(false);
  /** شرائح خانة الكتابة قبل الإرسال */
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  /** مستنداتٌ حُذفت في هذه المحادثة — بطاقاتها سطرٌ «حُذف المستند» */
  const [deletedDocs, setDeletedDocs] = useState<Record<string, true>>({});
  /** مستنداتٌ صُحّحت (PATCH) بعد آخر «سجّل القيد» لها — رفضها السابق لم يعد يصدق (activeRefusals) */
  const [patchedSince, setPatchedSince] = useState<Record<string, true>>({});
  const [viewer, setViewer] = useState<{ doc: ViewerDoc; src: string | null } | null>(null);
  /** روابط المعاينة المحلية (Blob) — تُبطل كلّها عند «محادثة جديدة» وعند مغادرة الصفحة */
  const blobs = useRef(createBlobUrlRegistry());
  /** المستند ⇐ رابط معاينته المحلي (الملف كما رُفع من هذا الجهاز) */
  const localUrls = useRef(new Map<string, string>());
  /** بطاقات الرفع — احتياط ردٍّ لا يحمل documents (خادمٌ تعذّر نموذجه مثلاً) فتظهر البطاقة على أي حال */
  const uploaded = useRef(new Map<string, AcctDocView>());
  /** شرائح حُذفت أثناء رفعها — مستندها يُحذف من الخادم حين يكتمل */
  const removedChips = useRef(new Set<string>());
  /** جيل المحادثة: «محادثة جديدة» تزيده فيُهمل ما كان قيد التجهيز أو الرفع */
  const gen = useRef(0);
  /** آخر ما رُسم من الشرائح والمحادثة — للرفع غير المتزامن (المستند نفسه في شريحةٍ أخرى أو رسالةٍ أُرسلت لا يُحذف) */
  const pendingRef = useRef<PendingDoc[]>([]);
  const entriesRef = useRef<ChatEntry[]>([]);
  pendingRef.current = pendingDocs;
  entriesRef.current = entries;
  useEffect(() => () => { blobs.current.revokeAll(); }, []);

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
      // بطاقات المستندات: من الردّ، وإلا (رسالة رفعٍ وردٌّ بلا documents) بطاقات الرفع نفسها — فلا يضيع مستندٌ بلا بطاقة
      const docs = d.documents ?? (user.docConfirm ? [] : (user.docIds ?? [])
        .map(id => uploaded.current.get(id)).filter((v): v is AcctDocView => !!v));
      setEntries(cur => {
        let next: ChatEntry[] = [...cur, {
          id: entryId(), role: 'assistant', text: d.text,
          reports: d.reports, posted: d.posted, warnings: d.warnings, guard: d.guard, turnId: d.turnId,
          ...(docs.length ? { documents: docs } : {}),
          ...(d.action ? { action: d.action } : {}),
          ...(d.refusal ? { refusal: d.refusal } : {}),
        }];
        // الحالة الأحدث لكل مستند (مُرحّل، أو فحوصٌ جديدة) في كل فقاعة تذكره
        for (const v of d.documents ?? []) next = replaceDocView(next, v);
        return next;
      });
      if (d.posted.length) void qc.invalidateQueries({ queryKey: POSTS_KEY });
    } catch (err) {
      const info = chatErrorInfo(err);
      setEntries(cur => {
        // رسالة رفعٍ لم يصل ردّها (الحدّ اليومي ٤٢٩ يُرفض قبل قراءة المستندات): بطاقاتها في إشعار الخطأ نفسه — فالمستند لا يضيع
        // و«سجّل القيد» يعمل (رسالته تحمل مستندها ودورتها بلا نموذج). رسالة التأكيد بطاقتها في مكانها من قبل
        const docs = user.docConfirm ? [] : (user.docIds ?? [])
          .map(id => latestDocView(cur, id) ?? uploaded.current.get(id) ?? null).filter((v): v is AcctDocView => !!v);
        return [
          ...cur.map(e => (e.id === user.id ? { ...e, failed: true } : e)),
          {
            id: entryId(), role: 'assistant', text: '', error: info.message, retryable: info.retryable,
            ...(docs.length ? { documents: docs } : {}),
          },
        ];
      });
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

  const perMessage = status?.docs.caps.perMessage ?? 3;

  /** أحدث بطاقةٍ لمستند في المحادثة (أو بطاقة رفعه) */
  const findView = (id: string): AcctDocView | null => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const v = entries[i].documents?.find(d => d.id === id);
      if (v) return v;
    }
    return uploaded.current.get(id) ?? null;
  };

  /** شريحة المرفق في فقاعة المستخدم (للعرض وحده) */
  const attachmentOf = (id: string): ChatAttachment => {
    const p = pendingDocs.find(x => x.docId === id);
    if (p) return { id, fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes };
    const v = findView(id);
    return { id, fileName: v?.fileName ?? '', mimeType: v?.mimeType ?? '', sizeBytes: v?.sizeBytes ?? 0 };
  };

  /**
   * إرسال نصّ: من الخانة (fromInput — تُفرَّغ بعده ومعها مستنداتها الجاهزة) أو من شريحة قالب (الخانة ومسوّدتها ومرفقاتها تبقى
   * كما هي) أو من بطاقة مستند («سجّل القيد»: extra بمستندها وdocConfirm). مستنداتٌ بلا نصّ ⇒ «اقرأ المستند المرفق ولخّص
   * بياناته» — طلب قراءةٍ لا نيّة تسجيل.
   */
  const send = (raw: string, fromInput = false, extra: SendExtra = {}) => {
    if (pending || busy.current) return;
    if (fromInput && pendingBusy(pendingDocs)) { setHint('انتظر حتى يكتمل رفع المستندات'); return; }
    const docIds = extra.docIds ?? (fromInput ? readyDocIds(pendingDocs, perMessage) : []);
    const text = raw.trim() || (fromInput && docIds.length ? docDefaultText(tr) : '');
    if (!text) return;
    // نصّ قالب ترحيلٍ لم يُكمَل: لا يُرسَل «…» إلى المحاسب (المبلغ يكتبه المستخدم بنفسه)
    if (fromInput && fromTemplate && hasBlank(text)) { setHint('أكمل الفراغات (…) قبل الإرسال'); focusBlank(raw); return; }
    const user: ChatEntry = {
      id: entryId(), role: 'user', text: text.slice(0, MAX_TEXT), clientRef: newClientRef(),
      ...(docIds.length ? { docIds, attachments: docIds.map(attachmentOf) } : {}),
      ...(extra.docConfirm ? { docConfirm: extra.docConfirm } : {}),
    };
    // محاولة «سجّل القيد» جديدة: رفضها (أو قبولها) يحكم من جديد على الحقائق كما هي الآن
    const confirmId = extra.docConfirm?.docId;
    if (confirmId) setPatchedSince(s => (s[confirmId] ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== confirmId)) : s));
    if (fromInput) {
      setInput('');
      setFromTemplate(false);
      setHint(null);
      if (pendingDocs.length) {
        // روابط المعاينة تنتقل مع مستنداتها إلى الفقاعة؛ وما لم يُرفع (شريحة خطأ) يُبطل رابطه الآن
        for (const p of pendingDocs) {
          if (p.phase === 'ready' && p.docId && p.localUrl) localUrls.current.set(p.docId, p.localUrl);
          else blobs.current.revoke(p.localUrl);
        }
        setPendingDocs([]);
        setTrayOpen(false);
      }
    }
    void run([...entries, user], user);
  };

  // ─── رفع المستندات ───

  const patchChip = (key: string, over: Partial<PendingDoc>) =>
    setPendingDocs(cur => cur.map(p => (p.key === key ? { ...p, ...over } : p)));

  /** ملفٌّ واحد: تجهيزٌ في الجهاز (ضغط ≤ ٤٠٠ ك.ب، وقراءة رمز QR للصورة) ثم رفعٌ خام بنسبته */
  const processFile = async (file: File, key: string, g: number) => {
    const caps = status?.docs.caps;
    const r = await prepareDocUpload(file, caps ? { caps } : {});
    // محادثةٌ جديدة أو شريحةٌ حُذفت أثناء التجهيز ⇒ لا رفع أصلاً
    if (g !== gen.current || removedChips.current.has(key)) return;
    if (!r.ok) { patchChip(key, { phase: 'error', error: docFileProblemText(r.problem, tr) }); return; }
    const localUrl = blobs.current.create(r.file.blob);
    patchChip(key, { phase: 'uploading', progress: 0, fileName: r.file.name, mimeType: r.file.mime, sizeBytes: r.file.size, localUrl });
    try {
      const res = await aiAccountantApi.documents.upload(r.file.blob, r.file.name, r.qr, (e) => {
        if (e.total) patchChip(key, { progress: Math.min(99, (e.loaded / e.total) * 100) });
      });
      const { document, deduped } = normalizeDocResponse(res.data?.data);
      if (!document) throw new Error('BAD_RESPONSE');
      uploaded.current.set(document.id, document);
      // المستند نفسه في شريحةٍ أخرى أو رسالةٍ أُرسلت (الملف أُرفق مرّتين فطابقه الخادم ببصمته) ⇒ لا يُحذف من الخادم أبداً هنا
      const shared = docIdInUse(document.id, pendingRef.current, entriesRef.current, key);
      // حُذفت الشريحة أو بدأت محادثةٌ جديدة أثناء الرفع ⇒ لا يبقى مستندٌ يتيم يأكل حصّة الشركة
      if (g !== gen.current || removedChips.current.has(key)) {
        blobs.current.revoke(localUrl);
        if (!deduped && !shared) void aiAccountantApi.documents.remove(document.id).catch(() => undefined);
        return;
      }
      // شريحةٌ أخرى تحمله في هذه الرسالة ⇒ هذه الشريحة زائدة: تُطوى (لا مستندان في الرسالة لملفٍّ واحد، ولا حذفٌ يُفقد الأخرى مستندها)
      if (pendingRef.current.some(p => p.key !== key && p.docId === document.id)) {
        blobs.current.revoke(localUrl);
        // الباقية ترث «أُنشئ الآن» إن كانت هذه أنشأته — فحذفها لاحقاً يحذفه ولا يبقى يتيماً
        setPendingDocs(cur => cur.filter(p => p.key !== key)
          .map(p => (p.docId === document.id && !deduped ? { ...p, deduped: false } : p)));
        return;
      }
      patchChip(key, { phase: 'ready', progress: 100, docId: document.id, deduped });
    } catch (e) {
      if (g === gen.current) patchChip(key, { phase: 'error', error: docApiErrorInfo(e, 'upload', tr).message });
    }
  };

  /** ملفاتٌ من الصينية: شرائح فوراً ثم تجهيزٌ ورفعٌ بالتتابع (واحدٌ تلو واحد — قفل حصّة الشركة في الخادم) */
  const addFiles = async (files: File[]) => {
    const take = files.slice(0, slotsLeft(pendingDocs, perMessage));
    if (!take.length) return;
    const chips: PendingDoc[] = take.map(f => ({
      key: chipKey(), fileName: f.name || tr('المستند'), mimeType: f.type || '', sizeBytes: f.size, phase: 'preparing', progress: 0,
      error: null, docId: null, deduped: false, localUrl: null,
    }));
    setPendingDocs(cur => [...cur, ...chips]);
    setHint(null);
    const g = gen.current;
    for (let i = 0; i < take.length; i++) {
      if (g !== gen.current) return;
      if (!removedChips.current.has(chips[i].key)) await processFile(take[i], chips[i].key, g);
    }
  };

  /**
   * حذف شريحة: رابطها يُبطل، ومستندها المرفوع للتوّ يُحذف من الخادم — لا المستند الموجود من قبل، ولا ما تحمله شريحةٌ أخرى أو
   * رسالةٌ أُرسلت (docIdInUse)
   */
  const removeChip = (key: string) => {
    const p = pendingDocs.find(x => x.key === key);
    removedChips.current.add(key);
    setPendingDocs(cur => cur.filter(x => x.key !== key));
    if (!p) return;
    blobs.current.revoke(p.localUrl);
    if (p.docId && !p.deduped && !docIdInUse(p.docId, pendingDocs, entries, key)) {
      void aiAccountantApi.documents.remove(p.docId).catch(() => undefined);
    }
  };

  const openDoc = (doc: ViewerDoc) => setViewer({
    doc: { id: doc.id, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes },
    src: localUrls.current.get(doc.id) ?? null,
  });
  const openChip = (p: PendingDoc) => {
    if (!p.docId) return;
    setViewer({ doc: { id: p.docId, fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes }, src: p.localUrl });
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
    // المرفقات: الشرائح والعارض وروابط المعاينة كلّها، وما زال يُجهَّز أو يُرفع يُهمل (الجيل التالي)
    gen.current += 1;
    setPendingDocs([]);
    setTrayOpen(false);
    setDeletedDocs({});
    setPatchedSince({});
    setViewer(null);
    blobs.current.revokeAll();
    localUrls.current.clear();
    uploaded.current.clear();
    removedChips.current.clear();
  };

  // بطاقات المستندات: صاحب كل بطاقة (أحدث ردٍّ يذكرها)، وآخر رفضٍ لترحيلها، وما يُرحَّل الآن — مشتقّةٌ من المحادثة نفسها
  const owners = useMemo(() => cardOwners(entries), [entries]);
  // رفضٌ صُحّحت حقائق مستنده بعده لا يُعرض (ولا يَسِم البطاقة «مكررة» فيتخطّى فحص التكرار للحقائق الجديدة)
  const refusals = useMemo(() => activeRefusals(refusalsByDoc(entries), patchedSince), [entries, patchedSince]);
  const confirms = useMemo(() => lastConfirms(entries) as Record<string, AcctDocConfirm>, [entries]);
  const docEnv: DocCardEnv = {
    taxOff,
    assetThreshold: status?.docs.assetThreshold ?? 2000,
    currency: status?.currency ?? 'SAR',
    todayLocal: status?.todayLocal ?? browserToday(),
    busy: pending,
    confirmingId: confirmingDocId(entries, pending),
    lastConfirms: confirms,
    onPatched: (v) => {
      setEntries(cur => replaceDocView(cur, v));
      setPatchedSince(s => (s[v.id] ? s : { ...s, [v.id]: true }));
    },
    onDeleted: (id) => {
      setDeletedDocs(s => ({ ...s, [id]: true }));
      blobs.current.revoke(localUrls.current.get(id));
      localUrls.current.delete(id);
    },
    onConfirm: (m) => send(m.text, false, { docIds: m.docIds, docConfirm: m.docConfirm }),
    onOpen: openDoc,
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
  // 📎 لمن docs.enabled وحده (مفتاح البيئة + علم الشركة + الترحيل متاح) — خادمٌ أقدم بلا الكتلة ⇒ مطفأ
  const docsOn = status.docs.enabled === true;
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
    <DocViewerRenderContext.Provider value={viewerCtx}>
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
                  ? <UserBubble entry={e} compact={compact} onOpenDoc={openDoc} />
                  : <AssistantBubble entry={e} compact={compact} onReversed={onReversed}
                      canRetry={!pending && e.retryable === true && e.id === lastEntry?.id}
                      onRetry={() => retry(e.id)}
                      docs={{ env: docEnv, owners, refusals, deleted: deletedDocs }} />}
              </div>
            ))}
            {pending && <ThinkingBubble compact={compact} />}
          </div>

          <div className={`flex-shrink-0 bg-white border-t border-[#E9E1D3] ${compact ? '' : 'pb-1'}`}>
            <TemplateBar status={status} compact={compact} singleRow={compact || entries.length > 0} disabled={pending}
              onPick={onPick} onRange={onRange} />
            {docsOn && (
              <AttachTray open={trayOpen} slots={slotsLeft(pendingDocs, perMessage)} max={perMessage} disabled={pending}
                onFiles={files => { void addFiles(files); }} onClose={() => setTrayOpen(false)} compact={compact} />
            )}
            {docsOn && <DocChips items={pendingDocs} onRemove={removeChip} onOpen={openChip} compact={compact} />}
            <form
              onSubmit={e => { e.preventDefault(); send(input, true); }}
              className={`flex items-end gap-2 ${compact ? 'px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]' : 'px-4 pt-1.5 pb-2'}`}
            >
              {docsOn && (
                <button
                  type="button"
                  onClick={() => setTrayOpen(o => !o)}
                  disabled={pending}
                  aria-label={tr('إرفاق مستند')}
                  title={tr('إرفاق مستند')}
                  aria-expanded={trayOpen}
                  className={`relative shrink-0 rounded-xl border flex items-center justify-center transition-colors disabled:opacity-40 ${trayOpen ? 'bg-[#FDECE6] border-[#E15A30] text-[#E15A30]' : 'bg-white border-[#E9E1D3] text-[#6E6557] hover:text-[#E15A30] hover:border-[#E15A30]'} ${compact ? 'w-10 h-10' : 'w-11 h-[38px]'}`}
                >
                  <Paperclip size={18} />
                  {pendingDocs.length > 0 && (
                    <span className="absolute -top-1.5 -end-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E15A30] text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                      {pendingDocs.length}
                    </span>
                  )}
                </button>
              )}
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
                disabled={(!input.trim() && !readyDocIds(pendingDocs, perMessage).length) || pending || pendingBusy(pendingDocs)}
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

      {/* عارض المستند: طبقة الجوال إن مُرّرت، وإلا نافذة سطح المكتب (الرابط المحلي إن رُفع الملف من هذا الجهاز) */}
      {viewer && (renderViewer
        ? renderViewer(viewer.doc, () => setViewer(null), viewer.src)
        : <DocViewer key={viewer.doc.id} doc={viewer.doc} src={viewer.src} onClose={() => setViewer(null)} />)}
    </div>
    </DocViewerRenderContext.Provider>
  );
}
