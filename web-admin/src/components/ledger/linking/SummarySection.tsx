import { Boxes, FileSearch, ListOrdered } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDateTime, formatDayOnly } from '../../../utils/format';
import { Badge } from '../SyncBadges';
import type { PreviewResultJson } from '../../../api/ledgerLinking';
import { eventStatusLabels, skipReasonLabels, sourceEventLabels, sourceTypeLabels, eventNoteText, eventTone } from '../../../lib/ledger/sync';
import {
  inventoryModeLabels, linkBasisLabels, locationLabel, pivotEventCounts, shortHash, sortLocations,
} from '../../../lib/ledger/linking';
import { Amt, Count, KeyValueGrid, LinkingSection, TableShell, Td, Th } from './LinkingUi';

/** «الملخّص» (العقد §15 البند 2): تواريخ الربط واللقطة والبصمة، وأعداد الأحداث بالنوع والحالة، وملخّص محرّك التكلفة */
export function SummarySection({ r }: { r: PreviewResultJson }) {
  const tr = useTr();
  const totalMs = r.timings.reduce((t, x) => t + (Number.isFinite(x.ms) ? x.ms : 0), 0);
  return (
    <LinkingSection id="linking-summary" title={tr('الملخص')} icon={<FileSearch size={16} className="text-[#E15A30]" />}>
      <KeyValueGrid items={[
        { label: tr('أساس الربط'), value: linkBasisLabels(tr)[r.basis] ?? r.basis },
        { label: tr('تاريخ الربط'), value: <bdi>{formatDayOnly(r.linkedFrom)}</bdi> },
        { label: tr('تاريخ القيد الافتتاحي'), value: <bdi>{formatDayOnly(r.openingDate)}</bdi> },
        { label: tr('لحظة اللقطة'), value: <bdi>{formatDateTime(r.snapshotAt)}</bdi> },
        { label: tr('ساعة قاعدة البيانات'), value: <bdi>{formatDateTime(r.dbNow)}</bdi> },
        { label: tr('العملة'), value: <bdi dir="ltr">{r.currency} · {r.currencyDecimals}</bdi> },
        { label: tr('المنطقة الزمنية'), value: <bdi dir="ltr">{r.timezone}</bdi> },
        { label: tr('القالب'), value: <bdi dir="ltr">{r.templateKey}</bdi> },
        { label: tr('طريقة المخزون'), value: inventoryModeLabels(tr)[r.inventoryMode] ?? r.inventoryMode },
        { label: tr('بصمة البيانات'), value: <bdi dir="ltr" className="font-mono text-xs">{shortHash(r.dataHash)}</bdi>, title: r.dataHash },
        { label: tr('بصمة النتيجة'), value: <bdi dir="ltr" className="font-mono text-xs">{shortHash(r.resultHash)}</bdi>, title: r.resultHash },
        { label: tr('مدة المعاينة'), value: <><bdi className="tabular-nums">{Math.max(1, Math.round(totalMs / 1000))}</bdi> {tr('ثانية')}</> },
      ]} />
      <EventCountsTable r={r} />
      <CostingSummaryBlock r={r} />
    </LinkingSection>
  );
}

function EventCountsTable({ r }: { r: PreviewResultJson }) {
  const tr = useTr();
  const pivot = pivotEventCounts(r.eventCounts);
  const statusLabels = eventStatusLabels(tr);
  const types = sourceTypeLabels(tr);
  const events = sourceEventLabels(tr);
  const skips = skipReasonLabels(tr);
  if (pivot.rows.length === 0) return <p className="text-sm text-[#6E6557]">{tr('لا أحداث في الفترة')}</p>;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-[#1F1A13] inline-flex items-center gap-1.5"><ListOrdered size={15} className="text-[#E15A30]" />{tr('أعداد الأحداث بالنوع والحالة')}</h3>
      <TableShell label={tr('أعداد الأحداث بالنوع والحالة')}>
        <thead>
          <tr>
            <Th>{tr('المصدر')}</Th>
            <Th>{tr('الحدث')}</Th>
            {pivot.statuses.map(s => <Th key={s} end>{statusLabels[s] ?? s}</Th>)}
            <Th end>{tr('المجموع')}</Th>
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map(row => (
            <tr key={`${row.sourceType}|${row.event}`}>
              <Td>{types[row.sourceType] ?? <bdi dir="ltr" className="font-mono text-xs">{row.sourceType}</bdi>}</Td>
              <Td>{events[row.event] ?? <bdi dir="ltr" className="font-mono text-xs">{row.event}</bdi>}</Td>
              {pivot.statuses.map(s => <Td key={s} end className="tabular-nums">{row.counts[s] ? <Count n={row.counts[s]} /> : ''}</Td>)}
              <Td end className="font-semibold"><Count n={row.total} /></Td>
            </tr>
          ))}
          <tr className="bg-[#FBF7F0] font-semibold">
            <Td colSpan={2}>{tr('المجموع')}</Td>
            {pivot.statuses.map(s => <Td key={s} end><Count n={pivot.totals[s] ?? 0} /></Td>)}
            <Td end><Count n={pivot.total} /></Td>
          </tr>
        </tbody>
      </TableShell>
      {pivot.reasons.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {pivot.reasons.map(x => (
            <li key={`${x.status}|${x.reason}`}>
              <Badge tone={eventTone(x.status)}>
                {statusLabels[x.status] ?? x.status} · {x.status === 'SKIPPED' ? (skips[x.reason] ?? x.reason) : (eventNoteText(tr, { kind: 'HELD', reason: x.reason }) ?? x.reason)}: <Count n={x.count} />
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CostingSummaryBlock({ r }: { r: PreviewResultJson }) {
  const tr = useTr();
  const s = r.costing.summary;
  const d = r.currencyDecimals;
  const opening = new Map(s.openingByLocation.map(x => [x.location, x]));
  const locations = sortLocations([...new Map([...s.openingByLocation, ...s.nowByLocation].map(x => [x.location, x])).values()]);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-[#1F1A13] inline-flex items-center gap-1.5"><Boxes size={15} className="text-[#E15A30]" />{tr('تكلفة المخزون (المتوسط المرجح لكل موقع)')}</h3>
      <KeyValueGrid items={[
        { label: tr('حركات المخزون'), value: <Count n={s.moveCount} /> },
        { label: tr('الأصناف'), value: <Count n={s.productCount} /> },
        { label: tr('تكلفة المبيعات المتوقعة للسنة'), value: <Amt value={s.fyCogsMilli} decimals={d} /> },
        { label: tr('فروق سد الرصيد السالب'), value: <Amt value={s.fyVarianceMilli} decimals={d} /> },
        { label: tr('شطب المرتجعات التالفة'), value: <Amt value={s.fyWriteOffMilli} decimals={d} /> },
        { label: tr('كمية بلا تكلفة في بداية السنة'), value: <bdi className="tabular-nums">{s.uncostedAtCutoverTotalQty}</bdi> },
      ]} />
      {locations.length > 0 && (
        <TableShell label={tr('قيمة المخزون لكل موقع')}>
          <thead>
            <tr>
              <Th>{tr('الموقع')}</Th>
              <Th end>{tr('الافتتاحي')}</Th>
              <Th end>{tr('الكمية الآن')}</Th>
              <Th end>{tr('القيمة الآن')}</Th>
            </tr>
          </thead>
          <tbody>
            {locations.map(x => {
              const now = s.nowByLocation.find(n => n.location === x.location);
              return (
                <tr key={x.location}>
                  <Td>{locationLabel(tr, x.location)}</Td>
                  <Td end><Amt value={opening.get(x.location)?.valueMilli ?? '0'} decimals={d} /></Td>
                  <Td end className="tabular-nums"><bdi>{now ? now.qtyBase : 0}</bdi></Td>
                  <Td end><Amt value={now?.valueMilli ?? '0'} decimals={d} /></Td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
      {s.holesFy.count > 0 && (
        <p className="text-xs text-[#6E6557]">
          {tr('حفر رصيد سالب سُدّت خلال السنة')}: <Count n={s.holesFy.count} /> · <Amt value={s.holesFy.varianceMilli} decimals={d} />
        </p>
      )}
    </div>
  );
}
