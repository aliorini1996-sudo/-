import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, GitCompareArrows } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir, useLang } from '../../../i18n/lang';
import { Badge } from '../SyncBadges';
import type { ParityCheck, ParityDrillRow } from '../../../api/ledgerLinking';
import {
  cappedListState, infoEntries, isZeroMilliText, locationLabel, parityCounts, parityDisplayStatus, parityExpandable, parityReasonText,
  parityScopeLabels, parityStatusLabels, parityTitle, parityTone, partnerTypeLabels, visibleDrill,
} from '../../../lib/ledger/linking';
import { Amt, LinkingNotice, LinkingSection, TableShell, Td, Th } from './LinkingUi';

/**
 * «المطابقة» R1..R13 (العقد §13 و§15 البند 6): شارة الحالة (مطابق/فرق/غير متاح بعد مع «يُضاف في Lx»/لا ينطبق)،
 * والمتوقَّع (التشغيل/محرّك التكلفة) والفعلي (أستاذ الظلّ) والفرق بالملّي، وتعمّق حسب الشريك مرتّباً بـ|الفرق|.
 * التسامح صفر: فرق ملّي واحد «فرق». «لا ينطبق» (R8 لجرد دوري) بلا مرحلة، وتعمّقه للاطلاع بلا عمود فرق.
 * التعمّق الذي قصّه الخادم كله (capResult) يُعلَن بعدده — لا يُقرأ غيابه «لا فروق».
 */
export function ParitySection({ checks, decimals }: { checks: ParityCheck[]; decimals: number }) {
  const tr = useTr();
  const counts = parityCounts(checks);
  const labels = parityStatusLabels(tr);
  return (
    <LinkingSection
      id="linking-parity"
      title={tr('المطابقة مع التشغيل')}
      icon={<GitCompareArrows size={16} className="text-[#E15A30]" />}
      badge={(
        <span className="inline-flex flex-wrap gap-1">
          <Badge tone="green">{labels.OK}: <bdi className="tabular-nums">{counts.ok}</bdi></Badge>
          {counts.mismatch > 0 && <Badge tone="red">{labels.MISMATCH}: <bdi className="tabular-nums">{counts.mismatch}</bdi></Badge>}
          <Badge tone="gray">{labels.NOT_AVAILABLE}: <bdi className="tabular-nums">{counts.notAvailable}</bdi></Badge>
          {counts.notApplicable > 0 && <Badge tone="gray">{labels.NOT_APPLICABLE}: <bdi className="tabular-nums">{counts.notApplicable}</bdi></Badge>}
        </span>
      )}
      hint={tr('المتوقع من المستندات ومحرك التكلفة، والفعلي من الترحيل التجريبي — والتسامح صفر')}
    >
      <ul className="space-y-1.5">
        {checks.map(c => <ParityRow key={c.code} c={c} decimals={decimals} />)}
      </ul>
    </LinkingSection>
  );
}

/** صفّ مطابقة: مفتوح افتراضياً للفرق وحده (defaultOpen يتجاوزه) */
export function ParityRow({ c, decimals, defaultOpen }: { c: ParityCheck; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const dir = useDir();
  const [open, setOpen] = useState(defaultOpen ?? c.status === 'MISMATCH');
  const Closed = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const reason = parityReasonText(tr, c, lang);
  const info = infoEntries(c.info);
  const expandable = parityExpandable(c);
  const status = parityDisplayStatus(c);
  const informational = status === 'NOT_APPLICABLE';
  return (
    <li className={`rounded-xl border ${c.status === 'MISMATCH' ? 'border-[#F3C6BF]' : 'border-[#F1EBDF]'}`}>
      <button
        type="button"
        className="w-full px-3 py-2 text-start space-y-1 disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex flex-wrap items-center gap-2">
          {expandable ? (open ? <ChevronDown size={14} /> : <Closed size={14} />) : <span className="w-[14px]" />}
          <span className="font-mono text-xs text-[#9A8F7E] w-8">{c.code}</span>
          <span className="font-medium text-sm text-[#1F1A13]">{parityTitle(tr, c, lang)}</span>
          <Badge tone={parityTone(status)}>{parityStatusLabels(tr)[status]}</Badge>
          {c.status !== 'NOT_AVAILABLE' && c.scope !== 'FULL' && <span className="text-xs text-[#6E6557]">{parityScopeLabels(tr)[c.scope]}</span>}
        </span>
        {reason && <span className="block text-xs text-[#6E6557] ps-6">{reason}</span>}
        {(c.expectedMilli !== null || c.actualMilli !== null) && (
          <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[#6E6557] ps-6">
            {c.expectedMilli !== null && <span>{tr('المتوقع')}: <Amt value={c.expectedMilli} decimals={decimals} /></span>}
            {c.actualMilli !== null && <span>{tr('الفعلي')}: <Amt value={c.actualMilli} decimals={decimals} /></span>}
            {c.diffMilli !== null && <span>{tr('الفرق')}: <Amt value={c.diffMilli} decimals={decimals} /></span>}
            {informational && <span className="text-[#9A8F7E]">{tr('للاطلاع، ليس فرقاً')}</span>}
          </span>
        )}
      </button>
      {open && expandable && (
        <div className="border-t border-[#F1EBDF] px-3 py-2 space-y-2">
          {info.length > 0 && (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {info.map(e => (
                <div key={e.key} className="inline-flex gap-1">
                  <dt className="text-[#9A8F7E] font-mono">{e.key}</dt>
                  <dd className="text-[#1F1A13]">{e.milli ? <Amt value={e.value === null ? null : String(e.value)} decimals={decimals} /> : <bdi>{e.value === null ? '—' : String(e.value)}</bdi>}</dd>
                </div>
              ))}
            </dl>
          )}
          {(c.drill.length > 0 || c.drillTruncated > 0) && <DrillTable rows={c.drill} truncated={c.drillTruncated} decimals={decimals} informational={informational} />}
        </div>
      )}
    </li>
  );
}

function partnerText(tr: (s: string) => string, r: ParityDrillRow): string {
  if (r.partnerType === 'LOCATION' && r.partnerId) return r.name ? `${locationLabel(tr, r.partnerId)} — ${r.name}` : locationLabel(tr, r.partnerId);
  return r.name ?? r.partnerId ?? '—';
}

/**
 * التعمّق: «الفروق وحدها» افتراضياً إن كان فيه فرق. للاطلاع («لا ينطبق»): كل الصفوف بلا عمود فرق ولا مرشّحه — فقيمة
 * التشغيل مقابل أستاذ لا يحملها ليست فرقاً. وإن قصّه الخادم كله: عدد المقصوص وحده، لا «لا فروق».
 */
function DrillTable({ rows, truncated, decimals, informational = false }: { rows: ParityDrillRow[]; truncated: number; decimals: number; informational?: boolean }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const partners = partnerTypeLabels(tr);
  const anyDiff = !informational && rows.some(r => !isZeroMilliText(r.diffMilli));
  const [onlyDiff, setOnlyDiff] = useState(anyDiff);
  const state = cappedListState(rows.length, truncated);
  if (state === 'ALL_TRUNCATED') {
    return <LinkingNotice tone="warn">{tr('قُصّت كل صفوف التعمق من النتيجة لتبقى ضمن الحجم المسموح: {count} صفاً').replace('{count}', String(truncated))}</LinkingNotice>;
  }
  const shown = visibleDrill(rows, !informational && onlyDiff);
  return (
    <div className="space-y-1.5">
      {informational ? <p className="text-xs text-[#9A8F7E]">{tr('للاطلاع، ليس فرقاً')}</p> : (
        <label className="inline-flex items-center gap-2 text-xs text-[#6E6557]">
          <input type="checkbox" className="accent-[#E15A30]" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />{tr('الفروق وحدها')}
        </label>
      )}
      {shown.length === 0 ? <p className="text-xs text-[#6E6557]">{tr('لا فروق')}</p> : (
        <TableShell label={tr('التعمق حسب الشريك')}>
          <thead>
            <tr><Th>{tr('الشريك')}</Th><Th end>{tr('المتوقع')}</Th><Th end>{tr('الفعلي')}</Th>{!informational && <Th end>{tr('الفرق')}</Th>}<Th>{tr('ملاحظة')}</Th></tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.partnerType}|${r.partnerId ?? ''}|${i}`}>
                <Td><span className="text-xs text-[#9A8F7E]">{partners[r.partnerType] ?? r.partnerType}</span> <bdi>{partnerText(tr, r)}</bdi></Td>
                <Td end><Amt value={r.expectedMilli} decimals={decimals} /></Td>
                <Td end><Amt value={r.actualMilli} decimals={decimals} /></Td>
                {!informational && <Td end className="font-medium"><Amt value={r.diffMilli} decimals={decimals} /></Td>}
                <Td className="text-xs text-[#6E6557]">
                  {lang === 'ar' && r.note && <span className="block">{r.note}</span>}
                  {r.refs && r.refs.length > 0 && (
                    <span className="block font-mono text-[11px]" dir="ltr" title={r.refs.join('\n')}>
                      {r.refs.slice(0, 3).join(' · ')}{r.refs.length > 3 ? ` (+${r.refs.length - 3})` : ''}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
      {truncated > 0 && <p className="text-xs text-[#9A8F7E]">{tr('و {count} صفاً آخر لم يُعرض (الأكبر فرقاً أولاً)').replace('{count}', String(truncated))}</p>}
    </div>
  );
}
