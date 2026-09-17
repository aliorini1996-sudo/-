import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Flag, Hourglass, Info, Lock, RotateCcw, Send, Undo2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { useAuthStore } from '../../../store/authStore';
import { canLedger } from '../../../lib/ledgerPerms';
import { formatDateTime, formatDayOnly } from '../../../utils/format';
import { backdropClose } from '../../../lib/backdropClose';
import { ledgerName } from '../../../lib/ledger/format';
import { LedgerForm, type LedgerFormGearItem } from '../../../components/ledger/LedgerForm';
import { MoveLinesGrid } from '../../../components/ledger/MoveLinesGrid';
import { gridLinesFromMove, moveInputLines, newGridLine, type GridLine } from '../../../lib/ledger/moveLines';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { todayLocal } from '../../../components/ledger/DateRangePicker';
import {
  fetchAllLedgerAccounts, ledgerConfigApi, ledgerErrorOf, ledgerKeys, isLedgerAccessError,
} from '../../../api/ledgerConfig';
import {
  ledgerMovesApi, ledgerMoveKeys, type GlMoveDetail, type MoveInput, type MoveIssue, type MoveOptionJournal, type MoveOptionTax,
  type ReviewState,
} from '../../../api/ledgerMoves';
import { ledgerHref } from '../routes';
import { ledgerErrorMessage, ledgerErrorText } from '../../../lib/ledger/errors';
import { ledgerReviewApi } from '../../../api/ledgerReview';
import { sourceDocumentHref, sourceTypeLabels } from '../../../lib/ledger/sync';
import ConfirmDialog from '../../../components/ConfirmDialog';

/**
 * نموذج قيد اليومية (JE‑04..12، JI‑01..05، §6.1، §8.3):
 * - إنشاء المسودة وتحريرها (المرجع، التاريخ المحاسبي، الدفتر؛ MISC افتراضياً أو `?journal=<code>` لدفتر GENERAL نشط).
 * - الضريبة على السطر تولّد سطر الضريبة ووعاءه في الخادم عند الحفظ: المولَّد بعلم `generated` من الخادم للقراءة
 *   ويُحذف من جسم إعادة الحفظ، وسطر الضريبة اليدوي قابل للتحرير ويُرسَل (lib/ledger/moveLines.ts).
 * - الدفاتر والضرائب من GET /moves/options بصلاحية القراءة (لا يحتاج canConfigureLedger).
 * - تحذير سطر الحساب الافتراضي لدفتر بنك (`useOutstandingAccounts`).
 * - الترحيل (409 LEDGER_NOT_SETUP قبل التفعيل)، والعكس و«إعادة إلى مسودة» بسبب إلزامي لليدوي وحده (I7)،
 *   وعلى المملوك لمصدر يُخفيان ويظهر رابط المصدر، و«إعادة الترحيل من المصدر» لقيد آلي مرحّل غير معكوس لمن يملك
 *   canConfigureLedger (M3، §6.1). حذف المسودة، و«تكرار كمسودة»، والمراجعة، والملاحظات والمرفقات.
 */

type Tr = (ar: string) => string;

interface FormState {
  journalId: string;
  date: string;
  ref: string;
  narration: string;
  autoPostOn: string;
  lines: GridLine[];
}

/** مربعات سطور الإقرار السعودي (1–5، 7–11). */
const SA_LINE_BOXES = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11];

const SAVE_FAILED = 'SAVE_FAILED';

function formFromMove(m: GlMoveDetail): FormState {
  return {
    journalId: m.journal.id,
    date: m.date,
    ref: m.ref ?? '',
    narration: m.narration ?? '',
    autoPostOn: m.autoPostOn ?? '',
    lines: gridLinesFromMove(m.lines),
  };
}

const inputLines = moveInputLines;

const snapshot = (f: FormState | null) => (f ? JSON.stringify({ ...f, lines: inputLines(f.lines).input }) : '');

function issueText(tr: Tr, i: MoveIssue): string {
  switch (i.reason) {
    case 'TOO_FEW_LINES': return tr('القيد يحتاج سطرين على الأقل');
    case 'ZERO_LINE_NOT_MARKER': return tr('سطر بلا مبلغ');
    case 'DEBIT_AND_CREDIT': return tr('السطر لا يحمل مدينا ودائنا معا');
    case 'NEGATIVE_AMOUNT': return tr('المبلغ لا يكون سالبا');
    case 'CUSTOMER_REQUIRED':
    case 'VENDOR_REQUIRED': return ledgerErrorText(tr, 'LEDGER_PARTNER_REQUIRED');
    default: return ledgerErrorText(tr, i.code, undefined, i.reason);
  }
}

export default function MoveForm() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const [sp] = useSearchParams();
  const isNew = !id || id === 'new';
  const { user } = useAuthStore();
  const canPost = canLedger(user, 'canPostJournals');

  // ═══ البيانات ═══
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const status = statusQ.data as (typeof statusQ.data & { timezone?: string | null; countryCode?: string | null }) | undefined;
  const activated = status ? !!status.activatedAt : true;
  const today = todayLocal(status?.timezone || 'Asia/Riyadh');

  const moveQ = useQuery({
    queryKey: ledgerMoveKeys.move(id ?? ''),
    queryFn: async () => (await ledgerMovesApi.moves.get(id!)).data.data,
    enabled: !isNew,
  });
  const move = isNew ? null : moveQ.data ?? null;

  const accountsQ = useQuery({
    queryKey: ledgerKeys.allAccounts,
    queryFn: fetchAllLedgerAccounts,
    staleTime: 5 * 60_000,
  });
  // الدفاتر والضرائب بصلاحية القراءة (GET /moves/options) — مستخدم canPostJournals وحده لا يتعطل
  const optionsQ = useQuery({
    queryKey: ledgerMoveKeys.options,
    queryFn: async () => (await ledgerMovesApi.moves.options()).data.data,
    staleTime: 5 * 60_000, retry: (n, e) => !isLedgerAccessError(e) && ledgerErrorOf(e)?.status !== 403 && n < 2,
  });
  const optionJournals = optionsQ.data?.journals;

  const accounts = accountsQ.data ?? [];
  const journals: MoveOptionJournal[] = useMemo(() => {
    const list = optionJournals ?? [];
    if (move && !list.some(j => j.id === move.journal.id)) {
      return [...list, {
        id: move.journal.id, code: move.journal.code, name: move.journal.name, nameEn: null, nameI18n: null, type: move.journal.type,
        systemKey: move.journal.systemKey, defaultAccountId: null, useOutstandingAccounts: false,
        sequenceReset: move.journal.sequenceReset, isActive: move.journal.isActive, isSystem: true,
      }];
    }
    return list;
  }, [optionJournals, move]);
  const taxes: MoveOptionTax[] = optionsQ.data?.taxes ?? [];
  const decimals = move?.currencyDecimals ?? status?.currencyDecimals ?? 2;

  // ═══ الدفتر الافتراضي للجديد: ?journal=<code> لدفتر GENERAL نشط، وإلا MISC مع تنبيه بالسبب (§8.3 JournalCard GENERIC) ═══
  const journalParam = sp.get('journal');
  const defaultJournal = useMemo(() => {
    if (!optionJournals) return null;
    const misc = optionJournals.find(j => j.systemKey === 'MISC') ?? optionJournals.find(j => j.code === 'MISC') ?? null;
    if (!journalParam) return { journal: misc, notice: null as string | null };
    const j = optionJournals.find(x => x.code.toUpperCase() === journalParam.toUpperCase());
    if (!j) return { journal: misc, notice: tr('رمز الدفتر في الرابط غير معروف، فُتح القيد على دفتر العمليات المتنوعة') };
    if (!j.isActive) return { journal: misc, notice: tr('الدفتر المطلوب مؤرشف، فُتح القيد على دفتر العمليات المتنوعة') };
    if (j.type !== 'GENERAL') return { journal: misc, notice: tr('الدفتر المطلوب ليس دفترا عاما، فُتح القيد على دفتر العمليات المتنوعة') };
    return { journal: j, notice: null };
  }, [optionJournals, journalParam, tr]);

  // ═══ حالة النموذج ═══
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loadedKey, setLoadedKey] = useState('');
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<null | 'reverse' | 'reset'>(null);
  const [confirmRepost, setConfirmRepost] = useState(false);

  // الجديد: يُهيّأ مرة بعد تحميل الدفاتر (أو فشله)، والدفتر الافتراضي المتأخر لا يُسقط ما كتبه المستخدم
  useEffect(() => {
    if (!isNew || optionsQ.isLoading) return;
    const jid = defaultJournal?.journal?.id ?? '';
    if (form && loadedKey === 'new') {
      if (!form.journalId && jid) setForm(f => (f ? { ...f, journalId: jid } : f));
      return;
    }
    const f: FormState = { journalId: jid, date: today, ref: '', narration: '', autoPostOn: '', lines: [newGridLine(), newGridLine()] };
    setForm(f); setBaseline(snapshot(f)); setLoadedKey('new'); setLineErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, optionsQ.isLoading, defaultJournal]);

  // القائم: يُعاد ضبطه عند تغيّر نسخته على الخادم (بعد الحفظ أو الترحيل)
  useEffect(() => {
    if (isNew || !move) return;
    const key = `${move.id}:${move.updatedAt}:${move.state}:${move.reviewState}`;
    if (key === loadedKey) return;
    const f = formFromMove(move);
    setForm(f); setBaseline(snapshot(f)); setLoadedKey(key); setLineErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, move]);

  const dirty = !!form && snapshot(form) !== baseline;
  const owned = !!move?.ownership;
  const isDraft = isNew || move?.state === 'DRAFT';
  const editable = canPost && isDraft && !owned;
  const patch = (p: Partial<FormState>) => setForm(f => (f ? { ...f, ...p } : f));

  const refresh = (moveId?: string) => {
    qc.invalidateQueries({ queryKey: ['ledger', 'moves'] });
    qc.invalidateQueries({ queryKey: ['ledger', 'items'] });
    if (moveId) {
      qc.invalidateQueries({ queryKey: ledgerMoveKeys.move(moveId) });
      qc.invalidateQueries({ queryKey: ledgerMoveKeys.notes(moveId) });
    }
  };

  const errorToast = (err: unknown) => {
    // السبب ثم الرمز ثم نص الحالة — لا رسالة الخادم العربية (lib/ledger/errors.ts)
    toast.error(ledgerErrorMessage(tr, ledgerErrorOf(err)), { duration: 6000 });
  };

  // ═══ الحفظ ═══
  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!form) throw new Error('no form');
      const { sent, input } = inputLines(form.lines);
      const body: MoveInput = {
        journalId: form.journalId, date: form.date, ref: form.ref.trim() || null, narration: form.narration.trim() || null,
        autoPostOn: form.autoPostOn || null, lines: input,
      };
      try {
        const r = isNew ? await ledgerMovesApi.moves.create(body) : await ledgerMovesApi.moves.update(id!, body);
        const d = r.data.data;
        if (d.issues.length) toast(tr('حُفظت المسودة، وفيها ملاحظات تمنع الترحيل'));
        else toast.success(tr('تم حفظ المسودة'));
        return d.id;
      } catch (err) {
        const e = ledgerErrorOf(err);
        const idx = typeof e?.lineIndex === 'number' ? e.lineIndex : null;
        if (idx !== null && sent[idx]) setLineErrors({ [sent[idx].key]: ledgerErrorMessage(tr, e) });
        throw err;
      }
    },
    onSuccess: (newId) => {
      setLineErrors({});
      refresh(newId);
      if (isNew) {
        setBaseline(snapshot(form));
        navigate(ledgerHref(`entries/${newId}`), { replace: true });
      }
    },
    onError: errorToast,
  });

  const post = useMutation({
    mutationFn: async () => {
      // تعديلات غير محفوظة تُحفظ أولاً؛ فشل الحفظ عرضه save نفسه
      if (dirty) { try { await save.mutateAsync(); } catch { throw new Error(SAVE_FAILED); } }
      return (await ledgerMovesApi.moves.post(id!)).data.data;
    },
    onSuccess: (r) => { toast.success(`${tr('تم ترحيل القيد')} ${r.number}`); refresh(id); },
    onError: (err) => { if ((err as Error)?.message !== SAVE_FAILED) errorToast(err); },
  });

  // «إعادة الترحيل من المصدر» (§6.1): عكس القيد الحيّ وإعادة بنائه بالربط الحالي في معاملة واحدة
  const repost = useMutation({
    mutationFn: async () => (await ledgerReviewApi.moves.repostFromSource(id!)).data.data,
    onSuccess: (r) => {
      setConfirmRepost(false);
      toast.success(`${tr('أُعيد الترحيل من المصدر')} ${r.repost.number ?? ''}`);
      refresh(id);
      navigate(ledgerHref(`entries/${r.repost.id}`));
    },
    onError: (err) => {
      setConfirmRepost(false);
      const e = ledgerErrorOf(err);
      const reasons: Record<string, string> = {
        NOT_AUTO_ORIGIN: tr('إعادة الترحيل للقيود الآلية وحدها'),
        NOT_POSTED: tr('القيد غير مرحّل'),
        NOT_LIVE_MOVE: tr('القيد ليس القيد الحيّ لمصدره، افتح أحدث قيد للمصدر'),
        SOURCE_REVERSED: tr('المستند المصدر أُلغي فلا شيء يُعاد ترحيله'),
        NO_SOURCE: tr('القيد بلا مصدر'),
        NOT_POST_SOURCE: tr('القيد بلا مصدر'),
        SOURCE_NOT_FOUND: tr('المستند المصدر غير موجود'),
        NO_RECIPE: tr('لا وصفة ترحيل لهذا المصدر'),
        NO_MOVE: tr('المصدر لا ينتج قيدا بالربط الحالي'),
      };
      toast.error((typeof e?.reason === 'string' && reasons[e.reason]) || ledgerErrorMessage(tr, e), { duration: 7000 });
    },
  });

  const review = useMutation({
    mutationFn: (s: ReviewState) => ledgerMovesApi.moves.review(id!, s),
    onSuccess: () => { toast.success(tr('تم تحديث المراجعة')); refresh(id); },
    onError: errorToast,
  });

  const removeDraft = async () => {
    try {
      await ledgerMovesApi.moves.remove(id!);
      toast.success(tr('تم حذف المسودة'));
      setBaseline(snapshot(form));
      refresh();
      navigate(ledgerHref('entries'), { replace: true });
    } catch (err) { errorToast(err); }
  };

  const duplicate = async () => {
    if (!move) return;
    try {
      const { input } = inputLines(formFromMove(move).lines);
      const r = await ledgerMovesApi.moves.create({
        journalId: move.journal.id, date: today, ref: move.ref, narration: move.narration, lines: input,
      });
      toast.success(tr('أُنشئت مسودة مكررة'));
      refresh();
      navigate(ledgerHref(`entries/${r.data.data.id}`));
    } catch (err) { errorToast(err); }
  };

  // ═══ تحذيرات السطور ═══
  const bankDefaultAccounts = useMemo(
    () => new Set(journals.filter(j => j.type === 'BANK' && j.useOutstandingAccounts && j.defaultAccountId).map(j => j.defaultAccountId as string)),
    [journals],
  );
  const warnings = useMemo(() => {
    const w: Record<string, string> = {};
    for (const l of form?.lines ?? []) {
      if (!l.generated && bankDefaultAccounts.has(l.accountId)) w[l.key] = tr('سيُطابَق مع الكشف عبر المرشّح 7 لا عبر 112002');
    }
    return w;
  }, [form?.lines, bankDefaultAccounts, tr]);

  const issueErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!move || dirty) return e;
    for (const i of move.issues ?? []) {
      const line = i.lineIndex !== null ? move.lines[i.lineIndex] : null;
      if (line && !e[line.id]) e[line.id] = issueText(tr, i);
    }
    return e;
  }, [move, dirty, tr]);

  const vatBoxes = useMemo(() => {
    const sa = status?.countryCode === 'SA' || taxes.some(t => t.vatBox?.startsWith('SA_'));
    if (!sa && !(form?.lines ?? []).some(l => l.vatBox)) return [];
    return SA_LINE_BOXES.map(n => ({ key: `SA_${n}`, label: `${tr('المربع')} ${n}` }));
  }, [status?.countryCode, taxes, form?.lines, tr]);

  const hasPendingTax = dirty && (form?.lines ?? []).some(l => !l.generated && l.taxId);

  // ═══ العرض ═══
  if (!isNew && moveQ.isError) {
    const e = ledgerErrorOf(moveQ.error);
    return (
      <div className="card max-w-xl mx-auto text-center py-8 text-sm text-[#8E2A1F]">
        {e?.status === 404 ? tr('السجل غير موجود') : ledgerErrorMessage(tr, e)}
        <div className="mt-3"><Link to={ledgerHref('entries')} className="text-[#E15A30] hover:underline">{tr('قيود اليومية')}</Link></div>
      </div>
    );
  }
  if (!isNew && !canPost && !canLedger(user, 'canViewLedger')) return null;
  if (isNew && !canPost) {
    return <div className="card max-w-xl mx-auto text-center py-8 text-sm text-[#8E2A1F]">{tr('لا تملك صلاحية إنشاء القيود')}</div>;
  }

  const title = isNew ? tr('جديد') : move?.number ?? tr('مسودة');
  const journal = journals.find(j => j.id === form?.journalId);
  const reversible = !!move && move.state === 'POSTED' && !owned && !move.reversal && canPost;

  const headerActions = (
    <>
      {!isNew && move?.state === 'DRAFT' && canPost && !owned && (
        <button type="button" className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50"
          disabled={post.isPending || save.isPending || !activated}
          title={!activated ? ledgerErrorText(tr, 'LEDGER_NOT_SETUP') : undefined}
          onClick={() => post.mutate()}>
          <Send size={14} />{tr('ترحيل')}
        </button>
      )}
      {reversible && (
        <>
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1" onClick={() => setDialog('reverse')}>
            <Undo2 size={14} />{tr('عكس')}
          </button>
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1" onClick={() => setDialog('reset')}>
            <RotateCcw size={14} />{tr('إعادة إلى مسودة')}
          </button>
        </>
      )}
      {!isNew && move && canPost && !move.secured && (
        move.reviewState === 'NONE' ? (
          <>
            <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1" disabled={review.isPending} onClick={() => review.mutate('REVIEWED')}>
              <CheckCircle2 size={14} />{tr('تعليم كمراجع')}
            </button>
            <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1" disabled={review.isPending} onClick={() => review.mutate('FLAGGED')}>
              <Flag size={14} />{tr('تعليم للمتابعة')}
            </button>
          </>
        ) : (
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1" disabled={review.isPending} onClick={() => review.mutate('NONE')}>
            <X size={14} />{tr('إلغاء المراجعة')}
          </button>
        )
      )}
    </>
  );

  const gearItems: LedgerFormGearItem[] = !isNew && move && !owned && move.origin === 'MANUAL'
    ? [{ label: tr('تكرار كمسودة'), perm: 'canPostJournals', run: duplicate }]
    : [];

  const banner = (
    <div className="space-y-0">
      {isNew && defaultJournal?.notice && <Notice tone="warn" icon={<AlertTriangle size={15} />}>{defaultJournal.notice}</Notice>}
      {isDraft && !activated && (
        <Notice tone="info" icon={<Hourglass size={15} />}>{tr('الدفاتر بانتظار الإعداد')} — {tr('المسودة تُحفظ الآن، والترحيل متاح بعد اكتمال الإعداد المبدئي للدفاتر')}</Notice>
      )}
      {optionsQ.isError && editable && (
        <Notice tone="warn" icon={<AlertTriangle size={15} />}>
          {isLedgerAccessError(optionsQ.error) ? ledgerErrorText(tr, 'LEDGER_PERMISSION_DENIED') : tr('تعذر تحميل دفاتر القيد وضرائبه، فلا يمكن اختيار الدفتر أو الضريبة الآن')}
          {' '}<button type="button" className="text-[#E15A30] hover:underline" onClick={() => void optionsQ.refetch()}>{tr('إعادة المحاولة')}</button>
        </Notice>
      )}
      {move?.lock?.locked && (
        <Notice tone="warn" icon={<Lock size={15} />}>{tr('تاريخ القيد ضمن فترة مقفلة')} (<bdi>{formatDayOnly(move.lock.lockDate)}</bdi>) — {tr('غيّر التاريخ قبل الترحيل')}</Notice>
      )}
      {move?.state === 'DRAFT' && !dirty && (move.issues?.length ?? 0) > 0 && (
        <Notice tone="warn" icon={<AlertTriangle size={15} />}>
          {tr('ملاحظات تمنع الترحيل')}: {[...new Set(move.issues.map(i => issueText(tr, i)))].join(' · ')}
        </Notice>
      )}
      {move?.needsAttention && (
        <Notice tone="warn" icon={<AlertTriangle size={15} />}>{tr('يحتاج انتباها')}{move.attentionReason ? <>: <bdi>{move.attentionReason}</bdi></> : null}</Notice>
      )}
      {move?.reversal && (
        <Notice tone="info" icon={<Info size={15} />}>
          {tr('عُكس هذا القيد بالقيد')} <Link className="text-[#E15A30] hover:underline" to={ledgerHref(`entries/${move.reversal.id}`)}><bdi>{move.reversal.number ?? tr('(مسودة)')}</bdi></Link>
          {move.draftCopies.map(c => (
            <span key={c.id}> · {tr('نسخة المسودة')} <Link className="text-[#E15A30] hover:underline" to={ledgerHref(`entries/${c.id}`)}><bdi>{c.number ?? tr('(مسودة)')}</bdi></Link></span>
          ))}
        </Notice>
      )}
      {move?.reversedMove && (
        <Notice tone="info" icon={<Info size={15} />}>
          {tr('قيد عكسي للقيد')} <Link className="text-[#E15A30] hover:underline" to={ledgerHref(`entries/${move.reversedMove.id}`)}><bdi>{move.reversedMove.number ?? ''}</bdi></Link>
          {move.reversalReason ? <> — {tr('السبب')}: {move.reversalReason}</> : null}
        </Notice>
      )}
      {move?.draftOfMoveId && (
        <Notice tone="info" icon={<Info size={15} />}>
          {tr('مسودة معادة من قيد مرحّل')} <Link className="text-[#E15A30] hover:underline" to={ledgerHref(`entries/${move.draftOfMoveId}`)}>{tr('فتح الأصل')}</Link>
        </Notice>
      )}
    </div>
  );

  const sourceType = move?.ownership?.sourceType ?? move?.sourceType ?? null;
  const sourceId = move?.ownership?.sourceId ?? move?.sourceId ?? null;
  const source = (owned || move?.origin === 'AUTO') && move ? {
    label: `${sourceType ? sourceTypeLabels(tr)[sourceType] ?? sourceType : tr('مستند')}${sourceId ? ` ${sourceId.slice(0, 8)}` : ''} — ${tr('يُلغى من مستنده')}`,
    href: sourceDocumentHref(sourceType, { customerId: move.customerId }) ?? undefined,
    origin: move.origin,
  } : null;
  const canRepost = !!move && move.origin === 'AUTO' && move.state === 'POSTED' && !move.reversal && !move.reversedMove && !move.secured
    && canLedger(user, 'canConfigureLedger');

  const linesTab = form && (
    <div className="space-y-2">
      <MoveLinesGrid
        lines={form.lines}
        onChange={lines => { setLineErrors({}); patch({ lines }); }}
        accounts={accounts}
        taxes={taxes}
        decimals={decimals}
        readOnly={!editable}
        vatBoxes={vatBoxes}
        warnings={warnings}
        lineErrors={{ ...issueErrors, ...lineErrors }}
      />
      {hasPendingTax && <p className="text-xs text-[#6E6557] flex items-center gap-1"><Info size={12} />{tr('سطور الضريبة تُولَّد آليا عند الحفظ')}</p>}
      {accountsQ.isError && <p className="text-xs text-[#C0392B]">{tr('تعذر تحميل الحسابات')}</p>}
    </div>
  );

  const otherTab = form && (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <label className="label" htmlFor="move-narration">{tr('الملاحظات الداخلية')}</label>
        <textarea id="move-narration" className="input min-h-[4.5rem] text-sm" disabled={!editable} value={form.narration} onChange={e => patch({ narration: e.target.value })} />
      </div>
      {isDraft && (
        <div>
          <label className="label" htmlFor="move-autopost">{tr('ترحيل تلقائي في')}</label>
          <input id="move-autopost" type="date" dir="ltr" className="input" disabled={!editable} min={today} value={form.autoPostOn} onChange={e => patch({ autoPostOn: e.target.value })} />
          <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('يرحّل المجدول المسودة في هذا التاريخ')}</p>
        </div>
      )}
      {move && (
        <dl className="md:col-span-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 text-sm">
          <Info2 label={tr('المصدر')}>{move.origin === 'AUTO' ? tr('آلي') : tr('يدوي')}{move.sourceType ? <> · <bdi>{move.sourceType}</bdi></> : null}</Info2>
          <Info2 label={tr('أُنشئ')}>
            <bdi>{formatDateTime(move.createdAt)}</bdi>
            {move.createdByImpersonated && <ImpTag tr={tr} />}
          </Info2>
          {move.postedAt && (
            <Info2 label={tr('رُحّل')}>
              <bdi>{formatDateTime(move.postedAt)}</bdi>
              {move.postedByImpersonated && <ImpTag tr={tr} />}
            </Info2>
          )}
          {move.lateArrival && (
            <Info2 label={tr('وصول متأخر')}>{tr('التاريخ الأصلي')}: <bdi>{formatDayOnly(move.originalDate)}</bdi></Info2>
          )}
          <Info2 label={tr('المراجعة')}>
            {move.reviewState === 'REVIEWED' ? tr('مراجع') : move.reviewState === 'FLAGGED' ? tr('للمتابعة') : tr('غير مراجع')}
            {move.reviewedAt && <> · <bdi>{formatDateTime(move.reviewedAt)}</bdi></>}
          </Info2>
          {move.secured && <Info2 label={tr('التأمين')}>{tr('القيد مؤمَّن')}</Info2>}
          {move.reversalReason && <Info2 label={tr('سبب العكس')}>{move.reversalReason}</Info2>}
          <Info2 label={tr('الإجمالي')}><LedgerAmount value={move.total} decimals={decimals} colored={false} /> <bdi>{move.currencyCode}</bdi></Info2>
        </dl>
      )}
    </div>
  );

  return (
    <>
      <LedgerForm
        breadcrumb={[{ label: tr('قيود اليومية'), to: ledgerHref('entries') }, { label: String(title) }]}
        recordPath={rid => ledgerHref(`entries/${rid}`)}
        status={isNew ? 'DRAFT' : move?.state}
        statusSteps={[{ key: 'DRAFT', label: tr('مسودة') }, { key: 'POSTED', label: tr('مُرحّل') }]}
        headerActions={headerActions}
        gearItems={gearItems}
        dirty={dirty}
        saving={save.isPending}
        canSave={editable && !!form?.journalId && !!form?.date}
        onSave={editable ? () => save.mutate() : undefined}
        onDiscard={() => { if (isNew) navigate(ledgerHref('entries')); else if (move) { const f = formFromMove(move); setForm(f); setBaseline(snapshot(f)); setLineErrors({}); } }}
        onDeleteDraft={!isNew && move?.state === 'DRAFT' && move.origin === 'MANUAL' && !owned ? removeDraft : undefined}
        loading={(!isNew && moveQ.isFetching) || accountsQ.isFetching || save.isPending || post.isPending}
        banner={banner}
        source={source}
        onRepostFromSource={canRepost ? () => setConfirmRepost(true) : undefined}
        audit={!isNew && move ? { entityType: 'MOVE', entityId: move.id } : undefined}
        chatter={!isNew && move ? { moveId: move.id } : undefined}
        title={<span className="inline-flex items-center gap-2"><bdi>{title}</bdi>{move?.state === 'DRAFT' && <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-[#F1EBDF] text-[#6E6557]">{tr('مسودة')}</span>}</span>}
        tabs={form ? [
          { key: 'lines', label: tr('عناصر اليومية'), content: linesTab },
          { key: 'other', label: tr('معلومات أخرى'), content: otherTab },
        ] : undefined}
      >
        {!form ? (
          <p className="text-sm text-[#9A8F7E]">{tr('جاري التحميل...')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="move-ref">{tr('المرجع')}</label>
              <input id="move-ref" className="input" disabled={!editable} value={form.ref} maxLength={200} onChange={e => patch({ ref: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="move-date">{tr('التاريخ المحاسبي')}</label>
              <input id="move-date" type="date" dir="ltr" className="input" disabled={!editable} value={form.date} onChange={e => patch({ date: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="move-journal">{tr('الدفتر')}</label>
              {editable ? (
                <select id="move-journal" className="input" value={form.journalId} onChange={e => patch({ journalId: e.target.value })}>
                  {!form.journalId && <option value="">—</option>}
                  {journals.filter(j => j.isActive || j.id === form.journalId).map(j => (
                    <option key={j.id} value={j.id}>{j.code} · {ledgerName(j, lang)}</option>
                  ))}
                </select>
              ) : (
                <p className="py-2 text-sm"><bdi className="text-[#6E6557]">{journal?.code}</bdi> {journal ? ledgerName(journal, lang) : ''}</p>
              )}
            </div>
          </div>
        )}
      </LedgerForm>

      {confirmRepost && move && (
        <ConfirmDialog
          title={tr('إعادة الترحيل من المصدر')}
          message={tr('يُعكس هذا القيد ويُعاد بناؤه من لقطة المستند بربط الحسابات الحالي في معاملة واحدة، ويبقى الأثر على الذمم والعهدة والأمانات صفرا')}
          confirmLabel={tr('إعادة الترحيل')}
          loading={repost.isPending}
          onClose={() => setConfirmRepost(false)}
          onConfirm={() => repost.mutate()}
        />
      )}

      {dialog && move && (
        <ReverseDialog
          mode={dialog}
          move={move}
          today={today}
          onClose={() => setDialog(null)}
          onDone={(targetId) => { setDialog(null); refresh(move.id); if (targetId) navigate(ledgerHref(`entries/${targetId}`)); }}
        />
      )}
    </>
  );
}

function Notice({ tone, icon, children }: { tone: 'info' | 'warn'; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-2 px-4 py-2 text-sm border-b ${tone === 'warn' ? 'bg-amber-50 text-amber-900 border-amber-100' : 'bg-[#FBEBE2]/60 text-[#1F1A13] border-[#F1EBDF]'}`}>
      <span className={`shrink-0 mt-0.5 ${tone === 'warn' ? 'text-amber-600' : 'text-[#E15A30]'}`}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

function Info2({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] text-[#9A8F7E]">{label}</dt>
      <dd className="text-[#1F1A13]">{children}</dd>
    </div>
  );
}

function ImpTag({ tr }: { tr: Tr }) {
  return <span className="ms-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 text-[10px]">{tr('بانتحال')}</span>;
}

/** معالج العكس (JE‑06) و«إعادة إلى مسودة» (JE‑07): السبب إلزامي (G5)، والتاريخ ≥ تاريخ الأصل، افتراضياً max(اليوم، الأصل). */
function ReverseDialog({ mode, move, today, onClose, onDone }: {
  mode: 'reverse' | 'reset';
  move: GlMoveDetail;
  today: string;
  onClose: () => void;
  onDone: (targetId: string | null) => void;
}) {
  const tr = useTr();
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today > move.date ? today : move.date);
  const run = useMutation({
    mutationFn: async () => {
      const body = { reason: reason.trim(), date: date || null };
      if (mode === 'reverse') {
        const r = (await ledgerMovesApi.moves.reverse(move.id, body)).data.data;
        return { msg: r.alreadyReversed ? tr('القيد معكوس مسبقا') : `${tr('تم عكس القيد')} ${r.reversal.number ?? ''}`, target: r.reversal.id };
      }
      const r = (await ledgerMovesApi.moves.resetDraft(move.id, body)).data.data;
      return { msg: tr('تم العكس وإنشاء نسخة مسودة'), target: r.draft.id };
    },
    onSuccess: (r) => { toast.success(r.msg); onDone(r.target); },
    onError: (err) => {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e), { duration: 6000 });
    },
  });
  const valid = reason.trim().length > 0 && (!date || date >= move.date);

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="reverse-title">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
          {mode === 'reverse' ? <Undo2 size={18} className="text-[#E15A30]" /> : <RotateCcw size={18} className="text-[#E15A30]" />}
          <h2 id="reverse-title" className="text-lg font-bold text-[#1F1A13] flex-1">{mode === 'reverse' ? tr('عكس القيد') : tr('إعادة إلى مسودة')}</h2>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
        </div>
        <form className="p-5 space-y-4" onSubmit={e => { e.preventDefault(); if (valid) run.mutate(); }}>
          <p className="text-sm text-[#6E6557]">
            {mode === 'reverse'
              ? tr('يُنشأ قيد عكسي مرحّل يلغي أثر هذا القيد، ويبقى الأصل في الدفاتر')
              : tr('يُنشأ قيد عكسي مرحّل ونسخة مسودة من القيد للتصحيح وإعادة الترحيل')}
          </p>
          <div>
            <label className="label" htmlFor="rev-date">{tr('تاريخ العكس')}</label>
            <input id="rev-date" type="date" dir="ltr" className="input" min={move.date} value={date} onChange={e => setDate(e.target.value)} />
            <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('لا يسبق تاريخ القيد الأصلي، ويقع خارج الفترات المقفلة')}</p>
          </div>
          <div>
            <label className="label" htmlFor="rev-reason">{tr('السبب')} *</label>
            <textarea id="rev-reason" className="input min-h-[4rem] text-sm" required value={reason} maxLength={500} onChange={e => setReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
            <button type="submit" className="btn-primary disabled:opacity-50" disabled={!valid || run.isPending}>
              {mode === 'reverse' ? tr('عكس') : tr('إعادة إلى مسودة')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
