import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useDir } from '../../../i18n/lang';
import {
  PARTNER_TYPES, carriedBalance, ledgerPartnersApi, ledgerPartnersKeys, partnerLedgerBalanced, partnerLedgerParams,
  partnerLedgerSearch, partnerTypeLabels, readPartnerLedgerState,
  type PartnerLedgerLine, type PartnerLedgerState, type PartnerType,
} from '../../../api/ledgerPartners';
import AttachmentLinks from './parts/AttachmentLinks';
import {
  Amount, CHIP, CTL, DateField, MoveLink, PartnerPicker, PartnerReportFrame, SourceLink, TD, TH, dayText, qtyText,
} from './parts/PartnerReportParts';

/**
 * **دفتر أستاذ الشركاء** («ربط الدفاتر» L8، عقد §6.2 و§6.4، Odoo Partner Ledger): سطور شريكٍ واحد على حساباته الرقابية
 * برصيد جارٍ — العميل على الذمم المدينة، والمورّد على الدائنة، والمندوب على عهدته (111003)، ومستخدم الشركة على عهدته (111004).
 *
 * - **الافتتاح + الحركة = الختام** ثابتٌ في الخادم، والشاشة تتحقّق منه بالملّي وتنبّه إن اختلّ.
 * - الترقيم في الخادم (100 سطر) والرصيد الجاري صحيح في كل صفحة؛ أعلى الصفحة التالية «رصيد مُرحَّل» = الرصيد قبل أول سطر فيها.
 * - للعميل والمورّد: الاستحقاق والمتبقّي والمطابقات (المطابقة الجزئية L8)، وخيار «غير المطابَقة وحدها» كـOdoo.
 * - من كل سطر: رابط إلى قيده، وإلى مستنده المصدر، ومرفقاته (صورة السند أو الاستلام أو التوقيع…)؛ وللعميل وثائقه.
 * - التصدير XLSX وPDF من نقطة التصدير بكامل الفترة بلا ترقيم.
 */
export default function PartnerLedgerPage() {
  const tr = useTr();
  const dir = useDir();
  const [sp, setSp] = useSearchParams();
  const spString = sp.toString();
  const state = useMemo(() => readPartnerLedgerState(spString), [spString]);
  const setState = useCallback((next: PartnerLedgerState) => setSp(new URLSearchParams(partnerLedgerSearch(next)), { replace: true }), [setSp]);

  const params = useMemo(() => partnerLedgerParams(state), [state]);
  const q = useQuery({
    queryKey: ledgerPartnersKeys.report('partner-ledger', params),
    queryFn: async () => (await ledgerPartnersApi.report('partner-ledger', params!)).data.data,
    enabled: params !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // ردٌّ سابق لشريك آخر لا يُعرض تحت اسم الشريك الجديد أثناء التحميل
  const data = q.data && params && q.data.partner.id === params.partnerId && q.data.partner.type === params.partnerType ? q.data : undefined;
  const decimals = data?.settings.currencyDecimals ?? data?.decimals ?? 2;
  const types = partnerTypeLabels(tr);
  const isArAp = state.type === 'customer' || state.type === 'vendor';
  const lines = data?.lines ?? [];
  const hasProduct = lines.some(l => !!l.productName || (l.quantity !== null && l.quantity !== 0));
  const page = data?.pagination.page ?? state.page;
  const pages = data?.pagination.pages ?? 1;
  const balanced = data ? partnerLedgerBalanced(data) : true;
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const partnerName = data?.partner.name ?? state.partnerName;
  const pickerPlaceholder: Record<PartnerType, string> = {
    customer: tr('ابحث عن عميل'),
    vendor: tr('ابحث عن مورّد'),
    rep: tr('ابحث عن مندوب'),
    user: tr('ابحث عن مستخدم'),
  };

  const controls = (
    <>
      <select
        className={CTL}
        value={state.type}
        onChange={e => setState({ ...state, type: e.target.value as PartnerType, partnerId: null, partnerName: null, page: 1 })}
        aria-label={tr('نوع الشريك')}
      >
        {PARTNER_TYPES.map(t => <option key={t} value={t}>{types[t]}</option>)}
      </select>
      <PartnerPicker
        type={state.type}
        value={state.partnerId ? { id: state.partnerId, name: partnerName ?? null } : null}
        onChange={p => setState({ ...state, partnerId: p?.id ?? null, partnerName: p?.name ?? null, page: 1 })}
        placeholder={pickerPlaceholder[state.type]}
        ariaLabel={tr('الشريك')}
      />
      <DateField label={tr('من')} value={state.from ?? data?.from} onChange={v => setState({ ...state, from: v, page: 1 })} />
      <DateField label={tr('إلى')} value={state.to ?? data?.to} onChange={v => setState({ ...state, to: v, page: 1 })} />
      {isArAp && (
        <label className="inline-flex items-center gap-1.5 text-xs text-[#1F1A13]">
          <input type="checkbox" checked={state.includeReconciled} onChange={e => setState({ ...state, includeReconciled: e.target.checked, page: 1 })} />
          {tr('إظهار البنود المطابَقة كلياً')}
        </label>
      )}
    </>
  );

  // التاريخ والقيد والبيان ومدين ودائن والرصيد والمستند والمرفقات، ثم الصنف، ثم الاستحقاق والمتبقّي والمطابقات للذمم
  const colCount = 8 + (hasProduct ? 1 : 0) + (isArAp ? 3 : 0);

  return (
    <PartnerReportFrame
      reportKey="partner-ledger"
      subtitle={data ? `${types[data.partner.type]} · ${dayText(data.from)} — ${dayText(data.to)}` : tr('اختر نوع الشريك ثم ابحث عنه لعرض دفتر أستاذه')}
      controls={controls}
      exportParams={params}
      warnings={data?.warnings}
      error={q.isError ? q.error : null}
      loading={q.isLoading}
      fetching={q.isFetching}
    >
      {data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { k: 'opening', label: tr('الرصيد الافتتاحي'), v: data.opening },
            { k: 'debit', label: tr('مدين الفترة'), v: data.totalDebit },
            { k: 'credit', label: tr('دائن الفترة'), v: data.totalCredit },
            { k: 'closing', label: tr('الرصيد الختامي'), v: data.closing },
          ].map(c => (
            <div key={c.k} className="rounded-xl border border-[#E8E0D2] bg-white p-2">
              <p className="text-[11px] text-[#6E6557]">{c.label}</p>
              <p className="text-sm"><Amount value={c.v} decimals={decimals} strong /></p>
            </div>
          ))}
        </div>
      )}
      {data && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#6E6557]">
          <span><bdi className="font-semibold text-[#1F1A13]">{data.partner.name ?? data.partner.id}</bdi> · {data.currency}</span>
          <span>{tr('عدد السطور')}: <bdi className="tabular-nums">{data.pagination.total}</bdi></span>
          {data.partner.type === 'customer' && (
            <span className="inline-flex items-center gap-1">
              <AttachmentLinks sourceType="CUSTOMER" sourceId={data.partner.id} count={data.documents.count} label={tr('وثائق العميل')} />
              {data.documents.count === 0 && <span>{tr('لا وثائق للعميل')}</span>}
            </span>
          )}
        </div>
      )}
      {data && !balanced && (
        <div className="rounded-xl border border-[#E8C3B7] bg-[#FBEBE2] p-2 text-xs text-[#C0392B]">{tr('الافتتاح والحركة لا يساويان الختام — أعد التحميل أو أبلغ الدعم')}</div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[#E8E0D2] bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[#F1EBDF] text-[#6E6557]">
            <tr>
              <th scope="col" className={`${TH} text-start`}>{tr('التاريخ')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('القيد')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('المرجع والبيان')}</th>
              {hasProduct && <th scope="col" className={`${TH} text-start`}>{tr('الصنف والكمية')}</th>}
              {isArAp && <th scope="col" className={`${TH} text-start`}>{tr('الاستحقاق')}</th>}
              <th scope="col" className={`${TH} text-end`}>{tr('مدين')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('دائن')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الرصيد')}</th>
              {isArAp && <th scope="col" className={`${TH} text-end`}>{tr('المتبقّي')}</th>}
              {isArAp && <th scope="col" className={`${TH} text-start`}>{tr('المطابقات')}</th>}
              <th scope="col" className={`${TH} text-start`}>{tr('المستند')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('المرفقات')}</th>
            </tr>
          </thead>
          <tbody>
            {!params ? (
              <tr><td colSpan={colCount} className="px-3 py-8 text-center text-[#9A8F7E]">{tr('اختر نوع الشريك ثم ابحث عنه لعرض دفتر أستاذه')}</td></tr>
            ) : !data ? (
              <tr><td colSpan={colCount} className="px-3 py-8 text-center text-[#9A8F7E]">{q.isError ? '' : tr('جاري التحميل...')}</td></tr>
            ) : (
              <>
                <tr className="border-b border-[#F1EBDF] bg-[#FBF7F0] font-semibold">
                  <td className={TD}>{page > 1 ? '' : dayText(data.from)}</td>
                  <td className={TD} colSpan={2 + (hasProduct ? 1 : 0) + (isArAp ? 1 : 0)}>{page > 1 ? tr('رصيد مُرحَّل') : tr('الرصيد الافتتاحي')}</td>
                  <td className={TD} />
                  <td className={TD} />
                  <td className={`${TD} text-end`}><Amount value={carriedBalance(data)} decimals={decimals} strong /></td>
                  <td className={TD} colSpan={2 + (isArAp ? 2 : 0)} />
                </tr>
                {lines.length === 0 && (
                  <tr><td colSpan={colCount} className="px-3 py-6 text-center text-[#9A8F7E]">{tr('لا حركة للشريك في هذه الفترة')}</td></tr>
                )}
                {lines.map(l => <LedgerLineRow key={l.lineId} line={l} decimals={decimals} hasProduct={hasProduct} isArAp={isArAp} customerId={state.type === 'customer' ? data.partner.id : null} />)}
              </>
            )}
          </tbody>
          {data && (
            <tfoot className="border-t-2 border-[#E8E0D2]">
              <tr className="bg-[#F1EBDF] font-semibold">
                <td className={TD}>{dayText(data.to)}</td>
                <td className={TD} colSpan={2 + (hasProduct ? 1 : 0) + (isArAp ? 1 : 0)}>{tr('إجمالي الفترة والرصيد الختامي')}</td>
                <td className={`${TD} text-end`}><Amount value={data.totalDebit} decimals={decimals} strong /></td>
                <td className={`${TD} text-end`}><Amount value={data.totalCredit} decimals={decimals} strong /></td>
                <td className={`${TD} text-end`}><Amount value={data.closing} decimals={decimals} strong /></td>
                <td className={TD} colSpan={2 + (isArAp ? 2 : 0)} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {data && pages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-[#6E6557]">
          <button type="button" className={CHIP} disabled={page <= 1 || q.isFetching} onClick={() => setState({ ...state, page: page - 1 })} aria-label={tr('الصفحة السابقة')}>
            <Prev size={14} />
          </button>
          <span>{tr('صفحة')} <bdi className="tabular-nums">{page}</bdi> {tr('من')} <bdi className="tabular-nums">{pages}</bdi></span>
          <button type="button" className={CHIP} disabled={page >= pages || q.isFetching} onClick={() => setState({ ...state, page: page + 1 })} aria-label={tr('الصفحة التالية')}>
            <Next size={14} />
          </button>
        </div>
      )}
    </PartnerReportFrame>
  );
}

const MATCHES_SHOWN = 3;

function LedgerLineRow({ line: l, decimals, hasProduct, isArAp, customerId }: {
  line: PartnerLedgerLine;
  decimals: number;
  hasProduct: boolean;
  isArAp: boolean;
  customerId: string | null;
}) {
  const tr = useTr();
  const shown = l.matches.slice(0, MATCHES_SHOWN);
  return (
    <tr className="border-b border-[#F1EBDF]">
      <td className={`${TD} whitespace-nowrap`}>{dayText(l.date)}</td>
      <td className={`${TD} whitespace-nowrap`}>
        <MoveLink moveId={l.moveId} number={l.moveNumber} />
        {l.journalCode ? <bdi className="ms-1 font-mono text-[10px] text-[#9A8F7E]">{l.journalCode}</bdi> : null}
      </td>
      <td className={TD}>
        {l.ref ? <bdi className="block font-medium text-[#1F1A13]">{l.ref}</bdi> : null}
        {l.label ? <bdi className="block text-[#6E6557]">{l.label}</bdi> : null}
      </td>
      {hasProduct && (
        <td className={TD}>
          {l.productName ? <bdi className="block">{l.productName}</bdi> : null}
          {l.quantity !== null && l.quantity !== 0 ? <bdi className="block tabular-nums text-[#6E6557]">{qtyText(l.quantity)}</bdi> : null}
        </td>
      )}
      {isArAp && <td className={`${TD} whitespace-nowrap`}>{l.dueDate ? dayText(l.dueDate) : ''}</td>}
      <td className={`${TD} text-end`}><Amount value={l.debit} decimals={decimals} blankZero /></td>
      <td className={`${TD} text-end`}><Amount value={l.credit} decimals={decimals} blankZero /></td>
      <td className={`${TD} text-end`}><Amount value={l.balance} decimals={decimals} /></td>
      {isArAp && (
        <td className={`${TD} text-end`}>
          {l.fullyReconciled
            ? <span className="inline-flex items-center gap-1 text-[#2E7D32]"><CheckCircle2 size={13} />{tr('مطابَق')}</span>
            : <Amount value={l.residual} decimals={decimals} blankZero />}
        </td>
      )}
      {isArAp && (
        <td className={TD}>
          <span className="flex flex-col gap-0.5">
            {shown.map((m, i) => (
              <span key={`${m.lineId}:${i}`} className="inline-flex items-center gap-1 whitespace-nowrap">
                <MoveLink moveId={m.moveId} number={m.moveNumber} />
                <Amount value={m.amount} decimals={decimals} />
              </span>
            ))}
            {l.matches.length > MATCHES_SHOWN && <span className="text-[#9A8F7E]">+<bdi className="tabular-nums">{l.matches.length - MATCHES_SHOWN}</bdi></span>}
          </span>
        </td>
      )}
      <td className={TD}><SourceLink sourceType={l.sourceType} customerId={customerId} /></td>
      <td className={TD}>
        <AttachmentLinks sourceType={l.sourceType} sourceId={l.sourceId} moveId={l.moveId} count={l.attachments?.count ?? 0} />
      </td>
    </tr>
  );
}
