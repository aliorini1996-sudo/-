import { Loader2, Play, History } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { formatDateTime, formatDayOnly } from '../../../utils/format';
import { Badge } from '../SyncBadges';
import { LINK_BASES, type GlLinkPreviewSummary, type GlLinkPreviewView, type LinkBasis } from '../../../api/ledgerLinking';
import {
  formatBytes, isActivePreview, linkBasisHints, linkBasisLabels, previewErrorText, previewPhaseLabels, previewProgress,
  previewStatusLabels, previewStatusTone, sortPreviews,
} from '../../../lib/ledger/linking';
import { LinkingNotice } from './LinkingUi';

/**
 * رأس المعاينة (العقد §15 البند 1): أساس الربط، وزرّ «تشغيل المعاينة» (الكتابة الوحيدة في الصفحة — صفّ المعاينة نفسه)
 * وسبب تعطيله مكتوباً لا تلميحاً (الجوال بلا مؤشّر)، وشريط التقدّم بالمرحلة والنسبة، وآخر المعاينات.
 */
export function PreviewControls({ basis, onBasis, onRun, disabledReason, pending }: {
  basis: LinkBasis;
  onBasis: (b: LinkBasis) => void;
  onRun: () => void;
  disabledReason: string | null;
  pending: boolean;
}) {
  const tr = useTr();
  const labels = linkBasisLabels(tr);
  const hints = linkBasisHints(tr);
  return (
    <div className="card space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-[#1F1A13] mb-1">{tr('أساس الربط')}</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {LINK_BASES.map(b => (
            <label key={b} className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer ${basis === b ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#F1EBDF] hover:bg-[#FBF7F0]'}`}>
              <input type="radio" name="link-basis" className="mt-1 accent-[#E15A30]" checked={basis === b} onChange={() => onBasis(b)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[#1F1A13]">{labels[b]}{b === 'FY_RESTATED' && <span className="text-xs text-[#6E6557]"> · {tr('الافتراضي')}</span>}</span>
                <span className="block text-xs text-[#6E6557] leading-relaxed">{hints[b]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
          disabled={!!disabledReason}
          title={disabledReason ?? undefined}
          onClick={onRun}
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}{tr('تشغيل المعاينة')}
        </button>
        {disabledReason
          ? <span className="text-xs text-[#8E2A1F]">{disabledReason}</span>
          : <span className="text-xs text-[#6E6557]">{tr('للقراءة فقط: لا يُكتب شيء في الدفاتر، وقد تستغرق دقائق لشركة كبيرة')}</span>}
      </div>
    </div>
  );
}

/** حالة المعاينة المختارة: شريط التقدّم أثناء التشغيل، وسبب الفشل، ووقت الاكتمال */
export function PreviewProgressCard({ view }: { view: GlLinkPreviewView }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const { pct, phase } = previewProgress(view);
  const active = isActivePreview(view.status);
  return (
    <div className="card space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={previewStatusTone(view.status)}>{active && <Loader2 size={11} className="animate-spin" />}{previewStatusLabels(tr)[view.status]}</Badge>
        <span className="text-[#1F1A13] font-medium">{linkBasisLabels(tr)[view.basis] ?? view.basis}</span>
        <span className="text-[#6E6557]">· {tr('تاريخ الربط')}: <bdi>{formatDayOnly(view.linkedFrom)}</bdi></span>
        <span className="text-xs text-[#9A8F7E] ms-auto">{tr('طُلبت')}: <bdi>{formatDateTime(view.createdAt)}</bdi></span>
      </div>
      {view.status !== 'DONE' && (
        <div>
          <div className="flex items-center justify-between text-xs text-[#6E6557] mb-1">
            <span>{previewPhaseLabels(tr)[phase] ?? phase}</span>
            <bdi className="tabular-nums">{pct}%</bdi>
          </div>
          <div className="h-2 rounded-full bg-[#F1EBDF] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`h-full rounded-full transition-all ${view.status === 'FAILED' ? 'bg-[#C0392B]' : 'bg-[#E15A30]'}`} style={{ width: `${pct}%` }} />
          </div>
          {active && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تُحدَّث الحالة كل ثانيتين، ويمكنك مغادرة الصفحة والعودة')}</p>}
        </div>
      )}
      {view.status === 'FAILED' && (
        <LinkingNotice tone="error">
          <p className="font-semibold">{previewErrorText(tr, view.errorCode)}</p>
          {lang === 'ar' && view.error && <p className="text-xs mt-0.5">{view.error}</p>}
        </LinkingNotice>
      )}
      {view.status === 'DONE' && view.finishedAt && (
        <p className="text-xs text-[#6E6557]">
          {tr('اكتملت')}: <bdi>{formatDateTime(view.finishedAt)}</bdi>
          {view.resultBytes != null && <> · {tr('حجم النتيجة')}: <bdi dir="ltr">{formatBytes(view.resultBytes)}</bdi></>}
        </p>
      )}
    </div>
  );
}

/** آخر المعاينات (الأحدث أولاً) — النقر يعرض المعاينة */
export function RecentPreviews({ list, selectedId, onSelect }: { list: readonly GlLinkPreviewSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const tr = useTr();
  const statusLabels = previewStatusLabels(tr);
  const basisLabels = linkBasisLabels(tr);
  if (list.length === 0) return null;
  return (
    <div className="card !p-0 overflow-hidden">
      <h2 className="px-4 py-2.5 text-sm font-semibold text-[#1F1A13] inline-flex items-center gap-1.5"><History size={15} className="text-[#E15A30]" />{tr('آخر المعاينات')}</h2>
      <ul className="divide-y divide-[#F1EBDF] border-t border-[#F1EBDF]">
        {sortPreviews(list).map(p => (
          <li key={p.id}>
            <button
              type="button"
              aria-current={p.id === selectedId ? 'true' : undefined}
              className={`w-full flex flex-wrap items-center gap-2 px-4 py-2 text-start text-sm hover:bg-[#FBF7F0] ${p.id === selectedId ? 'bg-[#FBEBE2]' : ''}`}
              onClick={() => onSelect(p.id)}
            >
              <Badge tone={previewStatusTone(p.status)}>{statusLabels[p.status] ?? p.status}</Badge>
              <span className="text-[#1F1A13]">{basisLabels[p.basis] ?? p.basis}</span>
              <span className="text-xs text-[#6E6557]">{tr('تاريخ الربط')}: <bdi>{formatDayOnly(p.linkedFrom)}</bdi></span>
              <span className="text-xs text-[#9A8F7E] ms-auto"><bdi>{formatDateTime(p.createdAt)}</bdi></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
