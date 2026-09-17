import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { backdropClose } from '../../lib/backdropClose';
import { LedgerAmount } from './LedgerAmount';
import type { EventStatus, Posting } from '../../api/ledgerReview';
import { ledgerErrorOf } from '../../api/ledgerConfig';
import { ledgerErrorMessage } from '../../lib/ledger/errors';
import {
  TONE_CLASSES, eventNoteText, eventStatusLabels, eventTone, milliAmount, postingStateLabels, postingTone, skipReasonLabels,
  type Tone,
} from '../../lib/ledger/sync';

/** نص خطأ «مزامنة الآن» (503 LEDGER_WORKER_UNAVAILABLE وغيره) */
export function syncResultText(tr: (ar: string) => string, err: unknown): string {
  const e = ledgerErrorOf(err);
  if (e?.reason === 'LEDGER_WORKER_UNAVAILABLE') return tr('معالج الترحيل غير متاح حاليا');
  return ledgerErrorMessage(tr, e);
}

/** مكوّنات مشتركة لقوائم «مراجعة» و«العملاء» (M3): شارات الحالة، ومبلغ الملّي، وحوار السبب الإلزامي. */

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${TONE_CLASSES[tone]}`}>{children}</span>;
}

export function EventStatusBadge({ status, skipReason }: { status: EventStatus; skipReason?: string | null }) {
  const tr = useTr();
  const skip = skipReason ? skipReasonLabels(tr)[skipReason] ?? skipReason : null;
  return <Badge tone={eventTone(status)} title={skip ?? undefined}>{eventStatusLabels(tr)[status] ?? status}{skip && status === 'SKIPPED' ? ` · ${skip}` : ''}</Badge>;
}

/** حالة ترحيل مستند مع رابط قيده (وقيد عكسه) وسبب الإيقاف */
export function PostingBadge({ posting }: { posting: Posting | null | undefined }) {
  const tr = useTr();
  if (!posting) return null;
  const note = eventNoteText(tr, posting.reverse?.note ?? null) ?? eventNoteText(tr, posting.post?.note ?? null);
  const showNote = ['BLOCKED', 'ERROR', 'HELD', 'REVERSE_PENDING'].includes(posting.state) ? note : null;
  return (
    <span className="inline-flex flex-col items-start gap-0.5" onClick={e => e.stopPropagation()}>
      <Badge tone={postingTone(posting.state)} title={showNote ?? undefined}>{postingStateLabels(tr)[posting.state]}</Badge>
      <span className="flex flex-wrap gap-1 text-[11px]">
        {posting.post?.moveId && (
          <Link className="text-[#E15A30] hover:underline" to={`/app/ledger/entries/${posting.post.moveId}`}><bdi>{posting.post.moveNumber ?? tr('(مسودة)')}</bdi></Link>
        )}
        {posting.reverse?.moveId && (
          <Link className="text-[#E15A30] hover:underline" to={`/app/ledger/entries/${posting.reverse.moveId}`}>↩ <bdi>{posting.reverse.moveNumber ?? ''}</bdi></Link>
        )}
        {(posting.post || posting.reverse) && ['BLOCKED', 'ERROR', 'HELD', 'PENDING', 'REVERSE_PENDING'].includes(posting.state) && (
          <Link className="text-[#6E6557] hover:underline" to={`/app/ledger/review/events?q=${encodeURIComponent((posting.post ?? posting.reverse)!.sourceKey.split(':').slice(0, 2).join(':'))}`}>{tr('الأحداث')}</Link>
        )}
      </span>
      {showNote && <span className="text-[11px] text-[#8E2A1F] max-w-[16rem] truncate" title={showNote}>{showNote}</span>}
    </span>
  );
}

export function MilliAmount({ value, decimals, colored = true }: { value: string | null | undefined; decimals: number; colored?: boolean }) {
  return <LedgerAmount value={milliAmount(value)} decimals={decimals} colored={colored} />;
}

/** حوار سبب مكتوب إلزامي (تخطي حدث، قيد تصحيح…) — `children` حقول إضافية فوق السبب. */
export function ReasonDialog({ title, description, confirmLabel, danger, busy, onClose, onConfirm, children, extraValid = true }: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
  extraValid?: boolean;
}) {
  const tr = useTr();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length > 0 && extraValid;
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="reason-dialog-title">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
          <h2 id="reason-dialog-title" className="text-lg font-bold text-[#1F1A13] flex-1">{title}</h2>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
        </div>
        <form className="p-5 space-y-4" onSubmit={e => { e.preventDefault(); if (valid && !busy) onConfirm(reason.trim()); }}>
          {description && <div className="text-sm text-[#6E6557]">{description}</div>}
          {children}
          <div>
            <label className="label" htmlFor="reason-dialog-reason">{tr('السبب')} *</label>
            <textarea id="reason-dialog-reason" className="input min-h-[4rem] text-sm" required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
            <button type="submit" className={`${danger ? 'btn-danger' : 'btn-primary'} disabled:opacity-50`} disabled={!valid || busy}>{confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
