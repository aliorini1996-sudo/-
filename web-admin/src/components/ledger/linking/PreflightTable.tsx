import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ListChecks, MinusCircle, XCircle } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir, useLang } from '../../../i18n/lang';
import { formatDayOnly } from '../../../utils/format';
import { Badge } from '../SyncBadges';
import type { PreflightCheck, PreflightReport } from '../../../api/ledgerLinking';
import { cappedListState, preflightCounts, preflightExpandable, preflightLevelLabels, preflightTitle, preflightTone } from '../../../lib/ledger/linking';
import { Amt, Count, LinkingNotice, LinkingSection } from './LinkingUi';

/**
 * «الفحوص المسبقة» P1..P14 (العقد §12 و§15 البند 3): LIGHT من GET /preflight فوراً، وFULL من نتيجة المعاينة.
 * بطاقة لكل فحص (لا جدول عريض — الجوال): الرمز، شارة المستوى B/W، ✓/✗، العنوان المترجم، التفاصيل (نصّ الخادم
 * العربي — للعربية وحدها)، العدد والقيمة، والعناصر قابلة للطيّ. العناصر التي قصّها الخادم (itemsTruncated) تُفتح في كل
 * اللغات ولو قُصّت كلها، فيظهر عددها.
 */
export function PreflightTable({ report, source, decimals, loading, error }: {
  report: PreflightReport | null;
  source: 'LIGHT' | 'FULL' | null;
  decimals: number;
  loading?: boolean;
  error?: string | null;
}) {
  const tr = useTr();
  const counts = report ? preflightCounts(report) : null;
  return (
    <LinkingSection
      id="linking-preflight"
      title={tr('الفحوص المسبقة')}
      icon={<ListChecks size={16} className="text-[#E15A30]" />}
      badge={source && (
        <Badge tone={source === 'FULL' ? 'green' : 'blue'}>{source === 'FULL' ? tr('من المعاينة الكاملة') : tr('تقدير سريع')}</Badge>
      )}
      hint={counts && (
        <>
          {tr('تحجب الاعتماد')}: <bdi className="tabular-nums">{counts.blocking}</bdi> · {tr('تحذيرات')}: <bdi className="tabular-nums">{counts.warnings}</bdi> · {tr('سليمة')}: <bdi className="tabular-nums">{counts.passed}</bdi>
        </>
      )}
    >
      {loading && !report && <p className="text-sm text-[#9A8F7E]">{tr('جاري الفحص...')}</p>}
      {error && <p className="text-sm text-[#8E2A1F]">{error}</p>}
      {report && (
        <>
          <p className="text-xs text-[#6E6557]">
            {tr('تاريخ الربط')}: <bdi>{formatDayOnly(report.linkedFrom)}</bdi>
            {' · '}{source === 'FULL' ? tr('الفحوص من المعاينة الكاملة نفسها') : tr('تقدير سريع قبل المعاينة، يُستبدل بنتيجتها حين تكتمل')}
          </p>
          <ul className="space-y-1.5">
            {report.checks.map(c => <PreflightRow key={c.code} c={c} decimals={decimals} />)}
          </ul>
        </>
      )}
    </LinkingSection>
  );
}

/** بطاقة فحص: مطويّة افتراضياً (defaultOpen يتجاوزه) */
export function PreflightRow({ c, decimals, defaultOpen = false }: { c: PreflightCheck; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const dir = useDir();
  const [open, setOpen] = useState(defaultOpen);
  const Closed = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const items = c.items ?? [];
  const expandable = preflightExpandable(c, lang);
  const itemsState = cappedListState(items.length, c.itemsTruncated);
  const Icon = c.notApplicable ? MinusCircle : c.ok ? CheckCircle2 : XCircle;
  const iconCls = c.notApplicable ? 'text-[#9A8F7E]' : c.ok ? 'text-emerald-600' : c.level === 'B' ? 'text-[#C0392B]' : 'text-amber-600';
  const status = c.notApplicable ? tr('لا ينطبق') : c.ok ? tr('سليم') : c.level === 'B' ? tr('يحجب الاعتماد') : tr('تحذير');
  return (
    <li className="rounded-xl border border-[#F1EBDF]">
      <button
        type="button"
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-start disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(o => !o)}
      >
        {expandable ? (open ? <ChevronDown size={14} /> : <Closed size={14} />) : <span className="w-[14px]" />}
        <span className="font-mono text-xs text-[#9A8F7E] w-8">{c.code}</span>
        <Icon size={16} className={iconCls} aria-label={status} />
        <Badge tone={c.level === 'B' ? 'red' : 'amber'} title={preflightLevelLabels(tr)[c.level]}>{c.level}<span className="sr-only"> · {preflightLevelLabels(tr)[c.level]}</span></Badge>
        <span className="font-medium text-[#1F1A13] text-sm">{preflightTitle(tr, c, lang)}</span>
        <Badge tone={preflightTone(c)}>{status}</Badge>
        {c.count != null && <span className="text-xs text-[#6E6557]">{tr('العدد')}: <Count n={c.count} /></span>}
        {c.valueMilli != null && <span className="text-xs text-[#6E6557]">{tr('القيمة')}: <Amt value={c.valueMilli} decimals={decimals} /></span>}
      </button>
      {open && (
        <div className="border-t border-[#F1EBDF] px-3 py-2 space-y-2 text-sm">
          {lang === 'ar' && c.details && <p className="text-[#3D362C] leading-relaxed">{c.details}</p>}
          {items.length > 0 && (
            <ul className="text-xs divide-y divide-[#F1EBDF]">
              {items.map((it, i) => (
                <li key={`${it.id ?? ''}|${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
                  <bdi className="text-[#1F1A13]">{it.label}</bdi>
                  {it.qty != null && <span className="text-[#6E6557]">{tr('الكمية')}: <bdi className="tabular-nums">{it.qty}</bdi></span>}
                  {it.valueMilli != null && <span className="text-[#6E6557]">{tr('القيمة')}: <Amt value={it.valueMilli} decimals={decimals} /></span>}
                  {it.date && <span className="text-[#6E6557]"><bdi>{formatDayOnly(it.date)}</bdi></span>}
                </li>
              ))}
            </ul>
          )}
          {itemsState === 'ALL_TRUNCATED' && (
            <LinkingNotice tone="warn">{tr('قُصّت كل العناصر من النتيجة لتبقى ضمن الحجم المسموح: {count} عنصراً').replace('{count}', String(c.itemsTruncated))}</LinkingNotice>
          )}
          {itemsState === 'SHOWN' && !!c.itemsTruncated && <p className="text-xs text-[#9A8F7E]">{tr('و {count} عنصراً آخر لم يُعرض').replace('{count}', String(c.itemsTruncated))}</p>}
        </div>
      )}
    </li>
  );
}
