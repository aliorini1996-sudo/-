import { useState } from 'react';
import { Landmark, Receipt, Scale, TrendingUp } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { formatLedgerAmount } from '../../../lib/ledger/format';
import { Badge } from '../SyncBadges';
import type { BalanceSheetPreview, PnlPreview, StatementPreviewLine, TrialBalanceByMonth, VatPeriodBoxRow } from '../../../api/ledgerLinking';
import {
  isStatementAccountLine, monthCell, monthNetMilli, statementLineLabel, toBig,
} from '../../../lib/ledger/linking';
import { milliAmount } from '../../../lib/ledger/sync';
import { Amt, KeyValueGrid, LinkingSection, TableShell, Td, Th } from './LinkingUi';

/**
 * التقارير الأربعة من أستاذ الظلّ (العقد §15 البند 5): ميزان المراجعة بالأشهر (حسابات × أشهر)، وقائمة الدخل منذ
 * بداية السنة، والميزانية اليوم، والضريبة بالفترة والمربع. أشهر الميزان «YYYY-MM» كما هي (ميلادية، بلا تنسيق تقويم).
 */

export function TrialBalanceSection({ tb, decimals, defaultOpen = false }: { tb: TrialBalanceByMonth; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  const [hideZero, setHideZero] = useState(true);
  const rows = hideZero
    ? tb.rows.filter(r => toBig(r.openingMilli) !== 0n || toBig(r.debitMilli) !== 0n || toBig(r.creditMilli) !== 0n || toBig(r.closingMilli) !== 0n)
    : tb.rows;
  const cellTitle = (d: string, c: string) => `${tr('مدين')} ${formatLedgerAmount(milliAmount(d), { decimals })} · ${tr('دائن')} ${formatLedgerAmount(milliAmount(c), { decimals })}`;
  return (
    <LinkingSection id="linking-tb" title={tr('ميزان المراجعة بالأشهر')} icon={<Scale size={16} className="text-[#E15A30]" />} defaultOpen={defaultOpen}
      hint={tr('صافي حركة كل شهر (مدين − دائن)، والافتتاحي رصيد ما قبل تاريخ الربط')}>
      <label className="inline-flex items-center gap-2 text-xs text-[#6E6557]">
        <input type="checkbox" className="accent-[#E15A30]" checked={hideZero} onChange={e => setHideZero(e.target.checked)} />{tr('إخفاء الحسابات الصفرية')}
      </label>
      <TableShell label={tr('ميزان المراجعة بالأشهر')}>
        <thead>
          <tr>
            <Th className="sticky start-0 bg-white z-10">{tr('الحساب')}</Th>
            <Th end>{tr('الافتتاحي')}</Th>
            {tb.months.map(m => <Th key={m} end><bdi dir="ltr">{m}</bdi></Th>)}
            <Th end>{tr('مدين')}</Th>
            <Th end>{tr('دائن')}</Th>
            <Th end>{tr('الختامي')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.accountId}>
              <Td className="sticky start-0 bg-white z-10 whitespace-nowrap"><bdi dir="ltr" className="font-mono text-xs">{r.accountCode}</bdi> <span className="text-[#1F1A13]">{r.accountName}</span></Td>
              <Td end><Amt value={r.openingMilli} decimals={decimals} blankZero /></Td>
              {tb.months.map(m => {
                const c = monthCell(r, m);
                return <Td key={m} end title={c ? cellTitle(c.debitMilli, c.creditMilli) : undefined}><Amt value={monthNetMilli(c)} decimals={decimals} blankZero /></Td>;
              })}
              <Td end><Amt value={r.debitMilli} decimals={decimals} blankZero /></Td>
              <Td end><Amt value={r.creditMilli} decimals={decimals} blankZero /></Td>
              <Td end className="font-medium"><Amt value={r.closingMilli} decimals={decimals} /></Td>
            </tr>
          ))}
          <tr className="bg-[#FBF7F0] font-semibold">
            <Td className="sticky start-0 bg-[#FBF7F0] z-10">{tr('المجموع')}</Td>
            <Td end><Amt value={tb.totals.openingMilli} decimals={decimals} /></Td>
            {tb.months.map(m => <Td key={m} end />)}
            <Td end><Amt value={tb.totals.debitMilli} decimals={decimals} /></Td>
            <Td end><Amt value={tb.totals.creditMilli} decimals={decimals} /></Td>
            <Td end><Amt value={tb.totals.closingMilli} decimals={decimals} /></Td>
          </tr>
        </tbody>
      </TableShell>
      {toBig(tb.totals.debitMilli) !== toBig(tb.totals.creditMilli) && (
        <p className="text-xs text-[#8E2A1F]">{tr('مجموع المدين لا يساوي مجموع الدائن')}</p>
      )}
    </LinkingSection>
  );
}

function StatementLines({ lines, decimals }: { lines: StatementPreviewLine[]; decimals: number }) {
  const tr = useTr();
  if (lines.length === 0) return <p className="text-sm text-[#6E6557]">{tr('لا أرصدة')}</p>;
  return (
    <ul className="text-sm divide-y divide-[#F1EBDF]">
      {lines.map(l => {
        const account = isStatementAccountLine(l);
        return (
          <li key={l.key} className={`flex items-baseline justify-between gap-3 py-1 ${account ? 'text-xs text-[#6E6557]' : l.depth === 0 ? 'font-semibold text-[#1F1A13]' : 'text-[#1F1A13]'}`}
            style={{ paddingInlineStart: `${Math.min(l.depth, 4) * 1}rem` }}>
            <span className="min-w-0 break-words">{statementLineLabel(tr, l)}</span>
            <Amt value={l.amountMilli} decimals={decimals} />
          </li>
        );
      })}
    </ul>
  );
}

export function PnlSection({ pnl, decimals, defaultOpen = false }: { pnl: PnlPreview; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  return (
    <LinkingSection id="linking-pnl" title={tr('قائمة الدخل منذ بداية السنة')} icon={<TrendingUp size={16} className="text-[#E15A30]" />} defaultOpen={defaultOpen}
      hint={<><bdi>{formatDayOnly(pnl.from)}</bdi> — <bdi>{formatDayOnly(pnl.to)}</bdi></>}>
      <StatementLines lines={pnl.lines} decimals={decimals} />
      {!pnl.lines.some(l => l.key === 'netProfit') && <div className="flex items-baseline justify-between gap-3 border-t-2 border-[#1F1A13] pt-2 font-bold text-[#1F1A13]">
        <span>{toBig(pnl.netMilli) < 0n ? tr('صافي الخسارة') : tr('صافي الربح')}</span>
        <Amt value={pnl.netMilli} decimals={decimals} />
      </div>}
    </LinkingSection>
  );
}

export function BalanceSheetSection({ bs, decimals, defaultOpen = false }: { bs: BalanceSheetPreview; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  return (
    <LinkingSection id="linking-bs" title={tr('الميزانية اليوم')} icon={<Landmark size={16} className="text-[#E15A30]" />} defaultOpen={defaultOpen}
      badge={<Badge tone={bs.balanced ? 'green' : 'red'}>{bs.balanced ? tr('متوازنة') : tr('غير متوازنة')}</Badge>}
      hint={<>{tr('كما في')} <bdi>{formatDayOnly(bs.asOf)}</bdi></>}>
      <KeyValueGrid items={[
        { label: tr('الأصول'), value: <Amt value={bs.assetsMilli} decimals={decimals} /> },
        { label: tr('الالتزامات'), value: <Amt value={bs.liabilitiesMilli} decimals={decimals} /> },
        { label: tr('حقوق الملكية'), value: <Amt value={bs.equityMilli} decimals={decimals} /> },
      ]} />
      <StatementLines lines={bs.lines} decimals={decimals} />
    </LinkingSection>
  );
}

export function VatSection({ rows, decimals, defaultOpen = false }: { rows: VatPeriodBoxRow[]; decimals: number; defaultOpen?: boolean }) {
  const tr = useTr();
  return (
    <LinkingSection id="linking-vat" title={tr('الضريبة بالفترة والمربع')} icon={<Receipt size={16} className="text-[#E15A30]" />} defaultOpen={defaultOpen}>
      {rows.length === 0 ? <p className="text-sm text-[#6E6557]">{tr('لا سطور ضريبة في الفترة')}</p> : (
        <TableShell label={tr('الضريبة بالفترة والمربع')}>
          <thead>
            <tr><Th>{tr('الفترة')}</Th><Th>{tr('من')}</Th><Th>{tr('إلى')}</Th><Th>{tr('مربع الإقرار')}</Th><Th end>{tr('الوعاء')}</Th><Th end>{tr('الضريبة')}</Th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.from}|${r.box ?? ''}`}>
                <Td><bdi dir="ltr" className="font-mono text-xs">{r.periodKey}</bdi></Td>
                <Td><bdi>{formatDayOnly(r.from)}</bdi></Td>
                <Td><bdi>{formatDayOnly(r.to)}</bdi></Td>
                <Td>{r.box ? <bdi dir="ltr" className="font-mono text-xs">{r.box}</bdi> : <span className="text-[#9A8F7E]">{tr('بلا مربع')}</span>}</Td>
                <Td end><Amt value={r.baseMilli} decimals={decimals} /></Td>
                <Td end><Amt value={r.taxMilli} decimals={decimals} /></Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </LinkingSection>
  );
}
