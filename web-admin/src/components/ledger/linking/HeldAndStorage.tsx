import { AlertTriangle, Database, PauseCircle } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { formatDayOnly } from '../../../utils/format';
import { Badge } from '../SyncBadges';
import type { HeldLine, PreviewEta, PreviewStorage, PreviewWarning } from '../../../api/ledgerLinking';
import { eventNoteText, eventStatusLabels, sourceTypeLabels } from '../../../lib/ledger/sync';
import { cappedListState, durationText, formatBytes, heldKindLabels, linkingWarningText, partnerTypeLabels } from '../../../lib/ledger/linking';
import { Amt, Count, KeyValueGrid, LinkingNotice, LinkingSection, ShowMoreButton, TableShell, Td, Th, useShowMore } from './LinkingUi';

const PAGE = 100;

/**
 * «السطور المحجوزة» (العقد §15 البند 7): أحداث HELD/ERROR/BLOCKED باقية بعد الترحيل التجريبي، وسطور حساب التعليق
 * 911001 — ما سيحتاج انتباهاً بعد الربط. «لا شيء» هو المطلوب، فلا تُقال إلا والقائمة فارغة حقاً: إن قصّها الخادم كلها
 * (capResult) فالعدد المقصوص بتنبيه، لا رسالة خضراء.
 */
export function HeldLinesSection({ lines, truncated, decimals }: { lines: HeldLine[]; truncated: number; decimals: number }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const [shown, more] = useShowMore(PAGE);
  const kinds = heldKindLabels(tr);
  const types = sourceTypeLabels(tr);
  const statuses = eventStatusLabels(tr) as Record<string, string>;
  const partners = partnerTypeLabels(tr);
  const total = lines.length + truncated;
  const state = cappedListState(lines.length, truncated);
  return (
    <LinkingSection
      id="linking-held"
      title={tr('السطور المحجوزة وحساب التعليق')}
      icon={<PauseCircle size={16} className="text-[#E15A30]" />}
      badge={<Badge tone={total === 0 ? 'green' : 'amber'}><bdi className="tabular-nums">{total}</bdi></Badge>}
    >
      {state === 'EMPTY' && <LinkingNotice tone="ok">{tr('لا أحداث محجوزة ولا سطور على حساب التعليق')}</LinkingNotice>}
      {state === 'ALL_TRUNCATED' && (
        <LinkingNotice tone="warn">{tr('قُصّت كل السطور المحجوزة من النتيجة لتبقى ضمن الحجم المسموح: {count} سطراً').replace('{count}', String(truncated))}</LinkingNotice>
      )}
      {state === 'SHOWN' && (
        <>
          <TableShell label={tr('السطور المحجوزة وحساب التعليق')}>
            <thead>
              <tr><Th>{tr('النوع')}</Th><Th>{tr('المصدر')}</Th><Th>{tr('المفتاح')}</Th><Th>{tr('الحالة')}</Th><Th>{tr('السبب')}</Th><Th>{tr('التاريخ')}</Th><Th>{tr('الشريك')}</Th><Th end>{tr('المبلغ')}</Th></tr>
            </thead>
            <tbody>
              {lines.slice(0, shown).map((l, i) => (
                <tr key={`${l.sourceKey}|${i}`}>
                  <Td>{kinds[l.kind] ?? l.kind}</Td>
                  <Td>{types[l.sourceType] ?? <bdi dir="ltr" className="font-mono text-xs">{l.sourceType}</bdi>}</Td>
                  <Td><bdi dir="ltr" className="font-mono text-[11px] break-all">{l.sourceKey}</bdi></Td>
                  <Td>{statuses[l.status] ?? <bdi dir="ltr" className="font-mono text-xs">{l.status}</bdi>}</Td>
                  <Td className="text-xs">
                    {l.reason ? eventNoteText(tr, { kind: 'HELD', reason: l.reason }) : '—'}
                    {lang === 'ar' && l.detail && <span className="block text-[#9A8F7E]">{l.detail}</span>}
                  </Td>
                  <Td className="whitespace-nowrap">{l.effectDate ? <bdi>{formatDayOnly(l.effectDate)}</bdi> : '—'}</Td>
                  <Td>{l.partnerType ? <><span className="text-xs text-[#9A8F7E]">{partners[l.partnerType]}</span> <bdi>{l.partnerName ?? l.partnerId ?? '—'}</bdi></> : '—'}</Td>
                  <Td end>{l.amountMilli !== null ? <Amt value={l.amountMilli} decimals={decimals} /> : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <div className="flex flex-wrap items-center gap-3">
            <ShowMoreButton shown={Math.min(shown, lines.length)} total={lines.length} onMore={more} />
            {truncated > 0 && <span className="text-xs text-[#9A8F7E]">{tr('و {count} سطراً آخر لم يُحفظ في النتيجة').replace('{count}', String(truncated))}</span>}
          </div>
        </>
      )}
    </LinkingSection>
  );
}

/** «الوقت والتخزين» (العقد §15 البند 7): مدة الترحيل التاريخي خارج الذروة وفيها، والصفوف والبايتات، وملاحظة الهامش */
export function EtaStorageSection({ eta, storage, defaultOpen = false }: { eta: PreviewEta; storage: PreviewStorage; defaultOpen?: boolean }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const r = storage.rows;
  return (
    <LinkingSection id="linking-eta" title={tr('الوقت والتخزين')} icon={<Database size={16} className="text-[#E15A30]" />} defaultOpen={defaultOpen}>
      <KeyValueGrid items={[
        { label: tr('أحداث ستُرحَّل'), value: <Count n={eta.eventsToPost} /> },
        { label: tr('الوقت المتوقع خارج الذروة'), value: durationText(tr, eta.etaMinutesOffPeak) },
        { label: tr('الوقت المتوقع في الذروة وحدها'), value: durationText(tr, eta.etaMinutesPeakOnly) },
        { label: tr('متوسط زمن الحدث'), value: <><bdi className="tabular-nums">{eta.msPerEvent}</bdi> ms</> },
      ]} />
      <TableShell label={tr('الصفوف المتوقعة')}>
        <thead><tr><Th>{tr('الجدول')}</Th><Th end>{tr('الصفوف')}</Th></tr></thead>
        <tbody>
          <tr><Td>{tr('أحداث الترحيل')}</Td><Td end><Count n={r.events} /></Td></tr>
          <tr><Td>{tr('القيود')}</Td><Td end><Count n={r.moves} /></Td></tr>
          <tr><Td>{tr('سطور القيود')}</Td><Td end><Count n={r.lines} /></Td></tr>
          <tr><Td>{tr('مصادر القيود')}</Td><Td end><Count n={r.moveSources} /></Td></tr>
          <tr><Td>{tr('سجل التدقيق')}</Td><Td end><Count n={r.audits} /></Td></tr>
          <tr><Td>{tr('لقطات التكلفة')}</Td><Td end><Count n={r.costSnapshots} /></Td></tr>
          <tr className="bg-[#FBF7F0] font-semibold"><Td>{tr('المجموع')}</Td><Td end><Count n={r.total} /></Td></tr>
        </tbody>
      </TableShell>
      <p className="text-sm text-[#6E6557]">{tr('الحجم التقديري')}: <bdi dir="ltr" className="font-medium text-[#1F1A13]">{formatBytes(storage.bytesEstimate)}</bdi></p>
      {storage.headroomNote && (
        <LinkingNotice tone="warn">{lang === 'ar' ? storage.headroomNote : tr('التقدير يتجاوز هامش قاعدة البيانات الحالي، راجع السعة قبل الاعتماد')}</LinkingNotice>
      )}
    </LinkingSection>
  );
}

export function WarningsSection({ warnings }: { warnings: PreviewWarning[] }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  if (warnings.length === 0) return null;
  return (
    <LinkingSection id="linking-warnings" title={tr('تحذيرات')} icon={<AlertTriangle size={16} className="text-amber-600" />}
      badge={<Badge tone="amber"><bdi className="tabular-nums">{warnings.length}</bdi></Badge>}>
      <ul className="space-y-1 text-sm">
        {warnings.map((w, i) => (
          <li key={`${w.code}|${i}`} className="flex flex-wrap items-baseline gap-2">
            <bdi dir="ltr" className="font-mono text-[11px] text-[#9A8F7E]">{w.code}</bdi>
            <span className="text-[#1F1A13]">{linkingWarningText(tr, w, lang)}</span>
            {w.count != null && <span className="text-xs text-[#6E6557]">(<Count n={w.count} />)</span>}
          </li>
        ))}
      </ul>
    </LinkingSection>
  );
}
