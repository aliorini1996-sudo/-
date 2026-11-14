import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { formatDayOnly } from '../../../utils/format';
import { Badge } from '../SyncBadges';
import type { OpeningPreview, OpeningPreviewLine } from '../../../api/ledgerLinking';
import {
  cappedListState, linkingManualIssueText, openingBalanceCheck, openingOriginLabels, partnerTypeLabels, toBig,
} from '../../../lib/ledger/linking';
import { Amt, KeyValueGrid, LinkingNotice, LinkingSection, ShowMoreButton, TableShell, Td, Th, useShowMore } from './LinkingUi';

const PAGE = 200;

/**
 * «القيد الافتتاحي» (العقد §15 البند 4، §11): سطراً سطراً (الحساب، الشريك، المصدر مشتقّ/يدوي/فرق، مدين، دائن)
 * أو مجمّعاً حسب الحساب، والمجاميع وفرق 319002. التوازن يُحسب هنا بالملّي من المجاميع (BigInt) ولا يُفترض.
 * السطور التي قصّها الخادم كلها (linesTruncated) تُعلَن بعددها — لا «لا أرصدة افتتاحية».
 */
export function OpeningMoveSection({ opening, decimals }: { opening: OpeningPreview; decimals: number }) {
  const tr = useTr();
  const [view, setView] = useState<'lines' | 'accounts'>('lines');
  const [shown, more] = useShowMore(PAGE);
  const check = openingBalanceCheck(opening);
  const t = opening.totals;
  const equity = toBig(t.equityDiffMilli);
  const linesState = cappedListState(opening.lines.length, opening.linesTruncated);
  return (
    <LinkingSection
      id="linking-opening"
      title={tr('القيد الافتتاحي')}
      icon={<BookOpen size={16} className="text-[#E15A30]" />}
      badge={<Badge tone={check.balanced ? 'green' : 'red'}>{check.balanced ? tr('متوازن') : tr('غير متوازن')}</Badge>}
      hint={<>{tr('كما في')} <bdi>{formatDayOnly(opening.date)}</bdi></>}
    >
      {!check.balanced && (
        <LinkingNotice tone="error">{tr('مجموع المدين لا يساوي مجموع الدائن')}: <Amt value={check.diffMilli} decimals={decimals} /></LinkingNotice>
      )}
      {check.linesMatchTotals === false && (
        <LinkingNotice tone="error">{tr('مجموع السطور المعروضة لا يطابق مجاميع القيد')}</LinkingNotice>
      )}
      <KeyValueGrid items={[
        { label: tr('إجمالي المدين'), value: <Amt value={t.debitMilli} decimals={decimals} /> },
        { label: tr('إجمالي الدائن'), value: <Amt value={t.creditMilli} decimals={decimals} /> },
        { label: tr('صافي الأرصدة المشتقة من التشغيل'), value: <Amt value={t.derivedNetMilli} decimals={decimals} /> },
        { label: tr('الأرصدة اليدوية: مدين'), value: <Amt value={t.manualDebitMilli} decimals={decimals} /> },
        { label: tr('الأرصدة اليدوية: دائن'), value: <Amt value={t.manualCreditMilli} decimals={decimals} /> },
        {
          label: tr('الفرق إلى حساب الأرصدة الافتتاحية'),
          value: <><Amt value={t.equityDiffMilli} decimals={decimals} /> <span className="text-xs text-[#6E6557]">{equity > 0n ? tr('دائن') : equity < 0n ? tr('مدين') : ''}</span></>,
          title: '319002',
        },
      ]} />
      {opening.manualIssues.length > 0 && (
        <LinkingNotice tone="warn">
          <p className="font-semibold">{tr('أرصدة افتتاحية يدوية غير صالحة')}: <bdi className="tabular-nums">{opening.manualIssues.length}</bdi></p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {opening.manualIssues.map(is => (
              <li key={`${is.index}|${is.reason}`}>
                {tr('السطر')} <bdi className="tabular-nums">{is.index + 1}</bdi> · <bdi dir="ltr" className="font-mono">{is.accountCode || '—'}</bdi> — {linkingManualIssueText(tr, is.reason)}
              </li>
            ))}
          </ul>
        </LinkingNotice>
      )}
      <div className="inline-flex rounded-lg border border-[#F1EBDF] p-0.5 text-xs" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'lines'} className={`px-3 py-1 rounded-md ${view === 'lines' ? 'bg-[#E15A30] text-white' : 'text-[#6E6557]'}`} onClick={() => setView('lines')}>{tr('سطرا سطرا')}</button>
        <button type="button" role="tab" aria-selected={view === 'accounts'} className={`px-3 py-1 rounded-md ${view === 'accounts' ? 'bg-[#E15A30] text-white' : 'text-[#6E6557]'}`} onClick={() => setView('accounts')}>{tr('حسب الحساب')}</button>
      </div>
      {view === 'lines' ? (
        <>
          {linesState === 'ALL_TRUNCATED' ? (
            <LinkingNotice tone="warn">
              {tr('قُصّت كل سطور القيد الافتتاحي من النتيجة لتبقى ضمن الحجم المسموح: {count} سطراً (المجاميع تشملها)').replace('{count}', String(opening.linesTruncated))}
            </LinkingNotice>
          ) : (
            <>
              <OpeningLinesTable lines={opening.lines.slice(0, shown)} decimals={decimals} />
              <div className="flex flex-wrap items-center gap-3">
                <ShowMoreButton shown={Math.min(shown, opening.lines.length)} total={opening.lines.length} onMore={more} />
                {opening.linesTruncated > 0 && (
                  <span className="text-xs text-[#9A8F7E]">{tr('و {count} سطراً آخر لم تُحفظ في النتيجة (المجاميع تشملها)').replace('{count}', String(opening.linesTruncated))}</span>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <TableShell label={tr('حسب الحساب')}>
          <thead>
            <tr><Th>{tr('الحساب')}</Th><Th end>{tr('السطور')}</Th><Th end>{tr('مدين')}</Th><Th end>{tr('دائن')}</Th><Th end>{tr('الصافي')}</Th></tr>
          </thead>
          <tbody>
            {opening.byAccount.map(a => (
              <tr key={a.accountCode} className={a.accountCode === '319002' ? 'bg-[#FBF7F0]' : ''}>
                <Td><bdi dir="ltr" className="font-mono text-xs">{a.accountCode}</bdi> <span className="text-[#1F1A13]">{a.accountName}</span></Td>
                <Td end className="tabular-nums"><bdi>{a.lines}</bdi></Td>
                <Td end><Amt value={a.debitMilli} decimals={decimals} blankZero /></Td>
                <Td end><Amt value={a.creditMilli} decimals={decimals} blankZero /></Td>
                <Td end><Amt value={(toBig(a.debitMilli) - toBig(a.creditMilli)).toString()} decimals={decimals} /></Td>
              </tr>
            ))}
            <tr className="bg-[#FBF7F0] font-semibold">
              <Td colSpan={2}>{tr('المجموع')}</Td>
              <Td end><Amt value={t.debitMilli} decimals={decimals} /></Td>
              <Td end><Amt value={t.creditMilli} decimals={decimals} /></Td>
              <Td end><Amt value={check.diffMilli} decimals={decimals} /></Td>
            </tr>
          </tbody>
        </TableShell>
      )}
    </LinkingSection>
  );
}

function OpeningLinesTable({ lines, decimals }: { lines: OpeningPreviewLine[]; decimals: number }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const origins = openingOriginLabels(tr);
  const partners = partnerTypeLabels(tr);
  if (lines.length === 0) return <p className="text-sm text-[#6E6557]">{tr('لا أرصدة افتتاحية')}</p>;
  return (
    <TableShell label={tr('سطور القيد الافتتاحي')}>
      <thead>
        <tr><Th>{tr('الحساب')}</Th><Th>{tr('الشريك')}</Th><Th>{tr('المصدر')}</Th><Th>{tr('البيان')}</Th><Th end>{tr('مدين')}</Th><Th end>{tr('دائن')}</Th></tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className={l.origin === 'EQUITY' ? 'bg-[#FBF7F0] font-medium' : ''}>
            <Td><bdi dir="ltr" className="font-mono text-xs">{l.accountCode}</bdi> <span className="text-[#1F1A13]">{l.accountName}</span></Td>
            <Td>{l.partnerType ? <><span className="text-xs text-[#9A8F7E]">{partners[l.partnerType]}</span> <bdi>{l.partnerName ?? l.partnerId ?? '—'}</bdi></> : '—'}</Td>
            <Td><Badge tone={l.origin === 'DERIVED' ? 'blue' : l.origin === 'MANUAL' ? 'amber' : 'gray'}>{origins[l.origin]}</Badge></Td>
            <Td className="text-xs text-[#6E6557]">{lang === 'ar' ? l.label : origins[l.origin]}</Td>
            <Td end><Amt value={l.debitMilli} decimals={decimals} blankZero /></Td>
            <Td end><Amt value={l.creditMilli} decimals={decimals} blankZero /></Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
