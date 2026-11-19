import { AlertTriangle, BrainCircuit, CircleAlert, RotateCcw } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { plainText, type AiStatus, type ChatEntry, type DocRefusal } from '../../../lib/aiAccountant';
import ReportCard from '../report/ReportCard';
import PostedMoveCard from '../posts/PostedMoveCard';
import DocCard, { DocCardDeleted, DocCardStub, type DocCardEnv } from '../docs/DocCard';
import { SentDocChips } from '../docs/DocChips';
import type { ViewerDoc } from '../docs/DocViewer';

/**
 * فقاعات المحادثة. اتجاه RTL: رسائل المستخدم في الطرف المقابل (justify-end) بلون العلامة، وردود المحاسب في البداية
 * بيضاء ومعها بطاقات المستندات والتقارير والقيود بعرض العمود كاملاً (الجداول تحتاج المساحة).
 *
 * النصّ يُعرض نصّاً صرفاً بأسطره (plainText تنزع علامات Markdown، وReact يهرّب الباقي) و`dir="auto"`: ردٌّ إنجليزي في
 * واجهة عربية لا تنقلب علامات ترقيمه.
 *
 * المستندات: فقاعة المستخدم تعرض شرائح ما أُرفق بها (تُفتح في العارض)، وردّ المحاسب يعرض بطاقة كل مستندٍ ذكره — كاملةً في
 * أحدث ردٍّ يملكها (cardOwners)، وسطراً مختصراً فيما قبله وفي ردّ «رُحّل»، و«حُذف المستند» لما حُذف.
 */

/** ما يحتاجه ردّ المحاسب لرسم بطاقات المستندات (تمرّره المحادثة) */
export interface BubbleDocs {
  env: DocCardEnv;
  /** المستند ⇐ الفقاعة صاحبة بطاقته الكاملة */
  owners: Readonly<Record<string, string>>;
  /** آخر رفضٍ لترحيل كل مستند */
  refusals: Readonly<Record<string, DocRefusal>>;
  deleted: Readonly<Record<string, true>>;
}

export function UserBubble({ entry, compact, onOpenDoc }: { entry: ChatEntry; compact?: boolean; onOpenDoc?: (d: ViewerDoc) => void }) {
  const tr = useTr();
  return (
    <div className="flex justify-end">
      <div className={compact ? 'max-w-[90%]' : 'max-w-[85%]'}>
        <div
          dir="auto"
          className={`rounded-2xl rounded-ee-md whitespace-pre-wrap break-words leading-relaxed ${compact ? 'px-3 py-2 text-[13px]' : 'px-4 py-2.5 text-sm'} ${entry.failed ? 'bg-[#F1EBDF] text-[#6E6557]' : 'bg-[#E15A30] text-white'}`}
        >
          {entry.text}
        </div>
        {!!entry.attachments?.length && <SentDocChips docs={entry.attachments} onOpen={onOpenDoc} compact={compact} />}
        {entry.failed && (
          <p className="mt-0.5 text-[11px] text-[#C0392B] flex items-center gap-1 justify-end">
            <CircleAlert size={11} /> {tr('لم ترسل')}
          </p>
        )}
      </div>
    </div>
  );
}

export function AssistantBubble({ entry, compact, canRetry, onRetry, onReversed, docs }: {
  entry: ChatEntry;
  compact?: boolean;
  canRetry?: boolean;
  onRetry?: () => void;
  onReversed: (moveId: string) => void;
  /** بطاقات المستندات — بغيابه لا تُرسم (المحادثة بلا رفع) */
  docs?: BubbleDocs;
}) {
  const tr = useTr();
  const pad = compact ? 'px-3 py-2 text-[13px]' : 'px-4 py-2.5 text-sm';
  const documents = docs ? entry.documents ?? [] : [];
  const docCards = docs && documents.map(v => (
    <div key={`d${v.id}`} className={compact ? '' : 'ps-9'}>
      {docs.deleted[v.id]
        ? <DocCardDeleted fileName={v.fileName} />
        : docs.owners[v.id] === entry.id
          ? <DocCard view={v} env={docs.env} refusal={docs.refusals[v.id] ?? null} compact={compact} />
          : <DocCardStub view={v} onOpen={docs.env.onOpen} />}
    </div>
  ));

  if (entry.error) {
    // ردٌّ تعذّر لرسالة رفع (الحدّ اليومي مثلاً): بطاقات مستنداتها تحت الإشعار — «سجّل القيد» لا يحتاج النموذج
    return (
      <div className="w-full min-w-0 space-y-2">
        <div className="flex justify-start">
          <div className={`max-w-[90%] rounded-2xl rounded-ss-md border border-[#F3C9BF] bg-[#FDF1EE] text-[#8E2B1F] ${pad}`}>
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>{tr(entry.error)}</span>
            </p>
            {canRetry && onRetry && (
              <button type="button" onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#C94E28] hover:text-[#E15A30]">
                <RotateCcw size={12} /> {tr('إعادة المحاولة')}
              </button>
            )}
          </div>
        </div>
        {docCards}
      </div>
    );
  }

  const text = plainText(entry.text);
  const reports = entry.reports ?? [];
  const posted = entry.posted ?? [];
  const warnings = entry.warnings ?? [];
  // ردٌّ فارغٌ تماماً (لا نصّ ولا مستند ولا تقرير ولا قيد) — يُقال بدل فقاعةٍ خالية
  const empty = !text && !documents.length && !reports.length && !posted.length && !warnings.length;

  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0 space-y-2">
        {(text || empty) && (
          <div className="flex items-start gap-2">
            {!compact && (
              <span className="w-7 h-7 rounded-full bg-[#1F1A13] text-[#F4B49C] flex items-center justify-center shrink-0 mt-0.5">
                <BrainCircuit size={15} />
              </span>
            )}
            <div dir="auto"
              className={`max-w-[85%] rounded-2xl rounded-ss-md bg-white border border-[#E9E1D3] text-[#1F1A13] whitespace-pre-wrap break-words leading-relaxed shadow-sm ${pad}`}>
              {text || <span className="text-[#9A8F7E]">{tr('لم يصل رد — أعد صياغة سؤالك')}</span>}
            </div>
          </div>
        )}
        {docCards}
        {reports.map((r, i) => (
          <div key={`r${i}`} className={compact ? '' : 'ps-9'}>
            <ReportCard report={r} />
          </div>
        ))}
        {posted.map(m => (
          <div key={m.moveId} className={compact ? '' : 'ps-9'}>
            <PostedMoveCard move={m} onReversed={() => onReversed(m.moveId)} />
          </div>
        ))}
        {warnings.length > 0 && (
          <ul className={`space-y-1 ${compact ? '' : 'ps-9'}`}>
            {warnings.map((w, i) => (
              <li key={i} dir="auto" className="flex items-start gap-1.5 text-xs text-[#8A6A12] bg-[#FAEFD8] border border-[#F0DDB0] rounded-lg px-2.5 py-1.5">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ThinkingBubble({ compact }: { compact?: boolean }) {
  const tr = useTr();
  return (
    <div className="flex justify-start" aria-live="polite">
      <div className="flex items-center gap-2">
        {!compact && (
          <span className="w-7 h-7 rounded-full bg-[#1F1A13] text-[#F4B49C] flex items-center justify-center shrink-0">
            <BrainCircuit size={15} className="animate-pulse" />
          </span>
        )}
        <div className={`rounded-2xl rounded-ss-md bg-white border border-[#E9E1D3] text-[#6E6557] flex items-center gap-2 ${compact ? 'px-3 py-2 text-[13px]' : 'px-4 py-2.5 text-sm'}`}>
          <span className="flex gap-1" aria-hidden>
            <span className="w-1.5 h-1.5 rounded-full bg-[#E15A30] animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#E15A30] animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-[#E15A30] animate-bounce" />
          </span>
          {tr('يفكّر…')}
        </div>
      </div>
    </div>
  );
}

/** ترحيب المحادثة الفارغة — ما يفعله وما لا يفعله (قرارات المواصفة) بلا وعودٍ تتجاوز صلاحية الحساب */
export function WelcomeCard({ status, compact }: { status: Pick<AiStatus, 'canPost' | 'companyName'> | null; compact?: boolean }) {
  const tr = useTr();
  return (
    <div className={`mx-auto text-center ${compact ? 'max-w-sm py-4 px-2' : 'max-w-lg py-8'}`}>
      <div className={`${compact ? 'w-11 h-11' : 'w-14 h-14'} rounded-2xl bg-[#1F1A13] text-[#F4B49C] flex items-center justify-center mx-auto mb-3`}>
        <BrainCircuit size={compact ? 22 : 28} />
      </div>
      <h2 className={`font-bold text-[#1F1A13] ${compact ? 'text-sm' : 'text-base'}`}>
        {tr('اسألني عن أرقام شركتك أو اختر طلبا جاهزا')}
      </h2>
      {status?.companyName && <p className="text-xs text-[#9A8F7E] mt-0.5" dir="auto">{status.companyName}</p>}
      <ul className={`mt-3 space-y-1.5 text-start text-[#6E6557] ${compact ? 'text-xs' : 'text-sm'}`}>
        <li className="flex gap-2"><span className="text-[#E15A30]">•</span>{tr('أجيب من بيانات النظام مباشرة — لا أخمن رقما')}</li>
        {status?.canPost && (
          <li className="flex gap-2"><span className="text-[#E15A30]">•</span>{tr('أسجل المصروفات والرواتب قيودا في الدفاتر فورا، وكل قيد يمكن عكسه')}</li>
        )}
        <li className="flex gap-2"><span className="text-[#E15A30]">•</span>{tr('لا أقفل السنة ولا أعد الإقرار الضريبي — هذه يتولاها محاسبك')}</li>
      </ul>
    </div>
  );
}
