import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, CircleAlert, ExternalLink, Loader2, Receipt, Undo2, Users, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { ledgerMovesApi } from '../../../api/ledgerMoves';
import { useTr } from '../../../i18n/strings';
import { currencyDecimals } from '../../../i18n/countries';
import type { PostedMove } from '../../../lib/aiAccountant';
import { canLedger } from '../../../lib/ledgerPerms';
import { useAuthStore } from '../../../store/authStore';
import { formatCurrency, formatDateTime, formatDayOnly, getActiveCurrency } from '../../../utils/format';
import { LedgerAmount } from '../../ledger/LedgerAmount';
import {
  POSTS_QUERY_KEY, REVERSE_REASON_MAX, isMobilePath, ledgerMoveHref, postedKindLabel, postedKindTone, reasonValid, reverseBody,
  reverseErrorInfo, reverseOutcome, reverseSuccessText, type ReverseErrorInfo, type ReverseOutcome,
} from './aiPosts';

/**
 * بطاقة قيدٍ رحّله «المحاسب الذكي» (في ردّ المحادثة وفي تبويب «قيود المحاسب الذكي»): نوعه ورقمه ومرجعه وتاريخه الميلادي
 * ومبلغه وملخّصه وسطوره (الحساب، مدين، دائن)، وحالته «مُرحّل» أو «معكوس».
 *
 * الترحيل مباشرٌ بلا «نعم» (قرار المالك)، فالضمانة زرّ «عكس القيد» على كل بطاقة: يفتح خانة سببٍ إلزاميّة داخل البطاقة
 * (لا نافذة المتصفّح المنبثقة) ثم يستدعي مسار الدفاتر القائم POST /ledger/moves/:id/reverse — نفسه الذي يعكس القيود اليدوية،
 * بصلاحية «ترحيل القيود» والفترات المقفلة كما هي. النجاح: إشعار، والبطاقة «معكوس» فوراً، وتُبطَل قائمة القيود
 * (['ai-accountant-posts']) ويُبلَّغ الأب (onReversed). الرفض يُعرض داخل البطاقة؛ والفترة المقفلة تعرض أوّل تاريخٍ مفتوح
 * وزرّ «العكس بتاريخ …» به (الخادم يتحقّق منه مجدداً).
 *
 * البطاقة لا تحسب رقماً: المبلغ والسطور كما أعادها الخادم.
 */
export default function PostedMoveCard({ move, onReversed }: { move: PostedMove; onReversed?: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const inputId = useId();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ReverseErrorInfo | null>(null);
  /** نتيجة عكسٍ نجح من هذه البطاقة — تُرسم «معكوساً» فوراً قبل أن يصل تحديث الأب أو القائمة */
  const [done, setDone] = useState<ReverseOutcome | null>(null);

  const reversed = move.reversed === true || done !== null;

  const run = useMutation({
    // date: أوّل تاريخٍ مفتوح بعد رفض الفترة المقفلة، وإلا null (الخادم يعكس بتاريخ max(اليوم، تاريخ القيد))
    mutationFn: async (date: string | null) => {
      const body = reverseBody(reason, date);
      if (!body) throw new Error('REVERSE_REASON_REQUIRED');
      const res = await ledgerMovesApi.moves.reverse(move.moveId, body);
      return reverseOutcome(res.data?.data);
    },
    onSuccess: (o) => {
      toast.success(reverseSuccessText(o, tr));
      setDone(o);
      setOpen(false);
      setReason('');
      setErr(null);
      void qc.invalidateQueries({ queryKey: POSTS_QUERY_KEY });
      onReversed?.();
    },
    onError: (e) => setErr(reverseErrorInfo(e, tr)),
  });
  const busy = run.isPending;
  const canSubmit = !busy && !reversed && reasonValid(reason);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) run.mutate(null);
  };
  const cancel = () => {
    if (busy) return;
    setOpen(false);
    setReason('');
    setErr(null);
  };

  const KindIcon = move.kind === 'SALARIES' ? Users : move.kind === 'SALARIES_SETTLE' ? Wallet : Receipt;
  const decimals = currencyDecimals(getActiveCurrency());
  // صفحات الدفاتر للويب ولمن يراها؛ تُفتح في لسانٍ جديد فلا تضيع المحادثة (في الذاكرة وحدها)
  const showLink = typeof window !== 'undefined' && !isMobilePath(window.location.pathname) && canLedger(user, 'canViewLedger');
  const reversalNo = done?.reversalNumber ?? null;

  return (
    <section
      aria-label={`${postedKindLabel(move.kind, tr)} ${move.moveNumber ?? ''}`.trim()}
      data-move-id={move.moveId}
      className="rounded-2xl border border-[#E9E1D3] bg-white overflow-hidden shadow-sm"
    >
      {/* الرأس: النوع والرقم والحالة، ثم الملخّص والمبلغ */}
      <div className="px-4 py-3 bg-[#FAF7F0] border-b border-[#F1EBDF]">
        <div className="flex items-start gap-2">
          <KindIcon size={18} className="text-[#E15A30] mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${postedKindTone(move.kind)}`}>
                {postedKindLabel(move.kind, tr)}
              </span>
              <h3 className="font-bold text-sm text-[#1F1A13]">
                {move.moveNumber ? <bdi dir="ltr">{move.moveNumber}</bdi> : <span className="text-[#9A8F7E] font-medium">{tr('بلا رقم')}</span>}
              </h3>
              {reversed ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#F1EBDF] text-[#6E6557]">
                  <Undo2 size={11} /> {tr('معكوس')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#E4F1EA] text-[#1E7A52]">
                  <BookOpenCheck size={11} /> {tr('مُرحّل')}
                </span>
              )}
            </div>
            {move.summaryAr && (
              <p dir="auto" className="text-[13px] text-[#1F1A13] mt-1 leading-relaxed break-words">{move.summaryAr}</p>
            )}
          </div>
          <p className={`shrink-0 font-bold text-[15px] tabular-nums whitespace-nowrap ${reversed ? 'text-[#9A8F7E] line-through' : 'text-[#1F1A13]'}`}>
            {formatCurrency(move.amount)}
          </p>
        </div>

        <div className="mt-1.5 ps-[26px] flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#6E6557]">
          <span>{tr('التاريخ')}: <bdi>{formatDayOnly(move.date)}</bdi></span>
          {move.ref && (
            <span className="min-w-0 break-all">
              {tr('المرجع')}: <bdi dir="ltr" className="font-mono select-all">{move.ref}</bdi>
            </span>
          )}
          {(move.adminName || move.createdAt) && (
            <span className="text-[#9A8F7E]">
              {move.adminName && tr('بطلب {name}').replace('{name}', move.adminName)}
              {move.adminName && move.createdAt && ' · '}
              {move.createdAt && <bdi>{formatDateTime(move.createdAt)}</bdi>}
            </span>
          )}
        </div>
      </div>

      {/* السطور: الدائن بإزاحة كعادة القيد اليومي («من حـ/ … إلى حـ/») */}
      {move.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className={`w-full text-[12px] ${reversed ? 'opacity-70' : ''}`}>
            <thead>
              <tr className="text-[#9A8F7E]">
                <th scope="col" className="text-start font-medium px-4 py-1.5">{tr('الحساب')}</th>
                <th scope="col" className="text-end font-medium px-2 py-1.5 w-24">{tr('مدين')}</th>
                <th scope="col" className="text-end font-medium ps-2 pe-4 py-1.5 w-24">{tr('دائن')}</th>
              </tr>
            </thead>
            <tbody>
              {move.lines.map((l, i) => {
                const creditOnly = l.credit !== 0 && l.debit === 0;
                return (
                  <tr key={`${l.accountCode}-${i}`} className="border-t border-[#F6F1E7]">
                    <td className={`py-1.5 pe-2 text-[#1F1A13] ${creditOnly ? 'ps-8' : 'ps-4'}`}>
                      {l.accountCode && <bdi dir="ltr" className="font-mono text-[11px] text-[#9A8F7E] me-1.5">{l.accountCode}</bdi>}
                      <span className="break-words">{l.accountName}</span>
                    </td>
                    <td className="px-2 py-1.5 text-end"><LedgerAmount value={l.debit} decimals={decimals} blankZero /></td>
                    <td className="ps-2 pe-4 py-1.5 text-end"><LedgerAmount value={l.credit} decimals={decimals} blankZero /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* العكس */}
      <div className="px-4 py-2.5 border-t border-[#F1EBDF]">
        {!open ? (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => { setOpen(true); setErr(null); }}
              disabled={reversed}
              title={reversed ? tr('القيد معكوس مسبقا') : undefined}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#F3C9BF] text-[#C94E28] hover:bg-[#FDF1EE] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <Undo2 size={13} /> {tr('عكس القيد')}
            </button>
            {reversalNo && (
              <span className="text-[11px] text-[#6E6557]">{tr('قيد العكس')} <bdi dir="ltr">{reversalNo}</bdi></span>
            )}
            {showLink && (
              <a
                href={ledgerMoveHref(move.moveId)}
                target="_blank"
                rel="noopener noreferrer"
                className="ms-auto inline-flex items-center gap-1 text-xs text-[#6E6557] hover:text-[#E15A30]"
              >
                <ExternalLink size={12} /> {tr('فتح في الدفاتر')}
              </a>
            )}
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="text-[12px] text-[#6E6557] leading-relaxed">
              {tr('يُنشأ قيد عكسي مرحّل يلغي أثر هذا القيد، ويبقى الأصل في الدفاتر')}
            </p>
            <label htmlFor={inputId} className="block text-xs font-medium text-[#44403a] mt-2 mb-1">
              {tr('سبب العكس')} <span className="text-[#C0392B]" aria-hidden>*</span>
            </label>
            {/* text-base على الجوال: خانةٌ أصغر من ١٦px تُكبّر صفحة الآيفون عند التركيز */}
            <input
              id={inputId}
              type="text"
              dir="auto"
              autoFocus
              required
              aria-required
              maxLength={REVERSE_REASON_MAX}
              value={reason}
              disabled={busy}
              onChange={(e) => { setReason(e.target.value); if (err) setErr(null); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
              placeholder={tr('مثال: المبلغ مسجل خطأ')}
              className="input !py-1.5 text-base sm:text-sm"
            />
            {err && (
              <div role="alert" className="mt-2 rounded-lg border border-[#F3C9BF] bg-[#FDF1EE] text-[#8E2B1F] text-xs px-2.5 py-2">
                <p className="flex items-start gap-1.5">
                  <CircleAlert size={13} className="shrink-0 mt-0.5" /> <span>{err.message}</span>
                </p>
                {err.locked && err.firstOpenDate && (
                  <div className="ps-5 mt-1">
                    <p>{tr('أول تاريخ مفتوح: {date}').replace('{date}', formatDayOnly(err.firstOpenDate))}</p>
                    <button
                      type="button"
                      onClick={() => { if (canSubmit && err.firstOpenDate) run.mutate(err.firstOpenDate); }}
                      disabled={!canSubmit}
                      className="mt-1 inline-flex items-center gap-1 font-semibold text-[#C94E28] hover:text-[#E15A30] disabled:opacity-50"
                    >
                      <Undo2 size={12} /> {tr('العكس بتاريخ {date}').replace('{date}', formatDayOnly(err.firstOpenDate))}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2.5">
              <button type="submit" disabled={!canSubmit} className="btn-primary !px-3 !py-1.5 !text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} {busy ? tr('جارٍ العكس…') : tr('تأكيد العكس')}
              </button>
              <button type="button" onClick={cancel} disabled={busy} className="btn-secondary !px-3 !py-1.5 !text-xs disabled:opacity-50">
                {tr('إلغاء')}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
