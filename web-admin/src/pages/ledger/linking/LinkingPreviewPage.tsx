import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useAuthStore } from '../../../store/authStore';
import { getActiveCurrency } from '../../../utils/format';
import { currencyDecimals } from '../../../i18n/countries';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import {
  DEFAULT_LINK_BASIS, ledgerLinkingApi, ledgerLinkingKeys, type LinkBasis, type PreviewStatus,
} from '../../../api/ledgerLinking';
import {
  isActivePreview, isLinkingOwner, linkBasisLabels, linkingErrorText, pickPreflight, pickPreviewId, previewListPollInterval,
  previewPollInterval, runDisabledReason,
} from '../../../lib/ledger/linking';
import { LinkingNotice } from '../../../components/ledger/linking/LinkingUi';
import { PreviewControls, PreviewProgressCard, RecentPreviews } from '../../../components/ledger/linking/PreviewControls';
import { SummarySection } from '../../../components/ledger/linking/SummarySection';
import { PreflightTable } from '../../../components/ledger/linking/PreflightTable';
import { OpeningMoveSection } from '../../../components/ledger/linking/OpeningMoveSection';
import { BalanceSheetSection, PnlSection, TrialBalanceSection, VatSection } from '../../../components/ledger/linking/ReportsSections';
import { ParitySection } from '../../../components/ledger/linking/ParitySection';
import { EtaStorageSection, HeldLinesSection, WarningsSection } from '../../../components/ledger/linking/HeldAndStorage';

/** حداثة الفحص الخفيف في الواجهة = مدّة حفظه في الخادم (PREFLIGHT_LIGHT_CACHE_MS في routes/ledger/linking.ts) */
const PREFLIGHT_STALE_MS = 5 * 60_000;

/**
 * «التهيئة ← ربط الدفاتر بالنظام (معاينة)» `/app/ledger/linking` (العقد l23 §15، الخطة L2) — **للقراءة فقط**.
 *
 * تعمل قبل التفعيل (الشركة غير المفعّلة وحدها، D7): تحسب في الخادم ما سيكون لو رُبطت الدفاتر بالمبيعات والتحصيل
 * والمخزون — القيد الافتتاحي المشتقّ، والترحيل التجريبي في الذاكرة، والمطابقة R1..R13، والفحوص P1..P14 — دون أي
 * كتابة في الدفاتر. الكتابة الوحيدة «تشغيل المعاينة» (صفّ gl_link_previews) لمالك الشركة؛ ولا زرّ اعتماد (L7).
 *
 * التدفّق: الفحوص LIGHT من GET /preflight فوراً ⇒ POST /preview ⇒ استطلاع GET /preview/:id كل ثانيتين ما دامت
 * QUEUED/RUNNING ⇒ النتيجة بأقسامها، والفحوص FULL منها. «آخر معاينة» من GET /previews (pickPreviewId).
 */
export default function LinkingPreviewPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user, impersonating } = useAuthStore();
  const owner = isLinkingOwner(user, impersonating);
  const [basis, setBasis] = useState<LinkBasis>(DEFAULT_LINK_BASIS);
  const [explicitId, setExplicitId] = useState<string | null>(null);

  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const activated = !!statusQ.data?.activatedAt;

  // المعاينة الجارية التي يستطلعها العرض الآن — القائمة لا تُستطلع لأجلها (طلب واحد كل ثانيتين يكفي القاعدة الصغيرة)
  const polledId = useRef<string | null>(null);
  const listQ = useQuery({
    queryKey: ledgerLinkingKeys.previews,
    queryFn: async () => (await ledgerLinkingApi.listPreviews(10)).data.data,
    enabled: owner,
    refetchInterval: q => previewListPollInterval(q.state.data, polledId.current),
  });
  const list = listQ.data ?? [];
  const selectedId = pickPreviewId(list, { explicitId, basis });

  const viewQ = useQuery({
    queryKey: ledgerLinkingKeys.preview(selectedId ?? ''),
    queryFn: async () => (await ledgerLinkingApi.getPreview(selectedId!)).data.data,
    enabled: owner && !!selectedId,
    refetchInterval: q => previewPollInterval(q.state.data?.status),
  });
  const view = viewQ.data && viewQ.data.id === selectedId ? viewQ.data : null;
  polledId.current = view && isActivePreview(view.status) ? view.id : null;

  const lightQ = useQuery({
    queryKey: ledgerLinkingKeys.preflight(basis),
    queryFn: async () => (await ledgerLinkingApi.preflight(basis)).data.data,
    enabled: owner,
    // الفحص الخفيف يمسح جداول كبيرة على قاعدةٍ صغيرة مشتركة: لا إعادة عند كل عودةٍ للنافذة، والخادم يحفظه بضع دقائق أيضاً
    staleTime: PREFLIGHT_STALE_MS,
    refetchOnWindowFocus: false,
  });

  // انتقال المعاينة نفسها من جارية إلى منتهية ⇒ تحديث القائمة وإشعار (لا عند التبديل بين معاينات)
  const prev = useRef<{ id: string; status: PreviewStatus } | null>(null);
  useEffect(() => {
    if (!view) return;
    const p = prev.current;
    if (p && p.id === view.id && isActivePreview(p.status) && !isActivePreview(view.status)) {
      qc.invalidateQueries({ queryKey: ledgerLinkingKeys.previews });
      if (view.status === 'DONE') toast.success(tr('اكتملت المعاينة'));
      else toast.error(tr('فشلت المعاينة'));
    }
    prev.current = { id: view.id, status: view.status };
  }, [view, qc, tr]);

  const start = useMutation({
    mutationFn: async () => (await ledgerLinkingApi.startPreview({ basis })).data.data,
    onSuccess: d => {
      setExplicitId(d.id);
      if (d.existing) toast(tr('معاينة جارية بالفعل، نعرض تقدمها'));
      else toast.success(tr('بدأت المعاينة'));
      qc.invalidateQueries({ queryKey: ledgerLinkingKeys.previews });
    },
    onError: e => {
      toast.error(linkingErrorText(tr, ledgerErrorOf(e)));
      qc.invalidateQueries({ queryKey: ledgerLinkingKeys.previews });
    },
  });

  const running = isActivePreview(view?.status) || list.some(p => isActivePreview(p.status));
  const disabledReason = runDisabledReason(tr, { owner, activated, running, pending: start.isPending });
  const result = view?.status === 'DONE' ? view.result : null;
  // منازل العملة: النتيجة، ثم الدفاتر، ثم عملة الشركة (قبل أي إعداد) — لا افتراض «2» لدينار بثلاث منازل
  const decimals = result?.currencyDecimals ?? statusQ.data?.currencyDecimals ?? currencyDecimals(getActiveCurrency());
  const preflight = pickPreflight(lightQ.data, view, basis);

  return (
    <div className="space-y-4 min-w-0">
      <div className="space-y-1">
        <h1 className="text-lg font-bold text-[#1F1A13] inline-flex items-center gap-2"><Link2 size={18} className="text-[#E15A30]" />{tr('ربط الدفاتر بالنظام (معاينة)')}</h1>
        <p className="text-sm text-[#6E6557] leading-relaxed max-w-3xl">
          {tr('معاينة للقراءة فقط لما سيحدث لو رُبطت الدفاتر بالمبيعات والتحصيل والمخزون: القيد الافتتاحي والترحيل التجريبي والمطابقة مع التشغيل، دون أي كتابة في الدفاتر. الاعتماد يأتي في مرحلة لاحقة')}
        </p>
      </div>

      {activated && (
        <LinkingNotice tone="warn">{tr('الدفاتر مفعّلة بالفعل، والمعاينة للشركات قبل التفعيل وحدها')}</LinkingNotice>
      )}

      <PreviewControls
        basis={basis}
        onBasis={b => { setBasis(b); setExplicitId(null); }}
        onRun={() => start.mutate()}
        disabledReason={disabledReason}
        pending={start.isPending}
      />

      {!owner ? (
        <div className="card text-center py-8 space-y-2">
          <ShieldAlert size={22} className="mx-auto text-[#E15A30]" />
          <p className="text-sm text-[#1F1A13] font-medium">{tr('ربط الدفاتر بالنظام لمالك الشركة وحده')}</p>
          <p className="text-xs text-[#6E6557]">{tr('يراجع المالك المعاينة ويقرر الربط، وتبقى الدفاتر اليدوية كما هي حتى ذلك')}</p>
        </div>
      ) : (
        <>
          {listQ.isError && <LinkingNotice tone="error">{linkingErrorText(tr, ledgerErrorOf(listQ.error))}</LinkingNotice>}
          {viewQ.isError && selectedId && <LinkingNotice tone="error">{linkingErrorText(tr, ledgerErrorOf(viewQ.error))}</LinkingNotice>}
          {view && <PreviewProgressCard view={view} />}
          {list.length > 1 && <RecentPreviews list={list} selectedId={selectedId} onSelect={setExplicitId} />}

          {view?.status === 'DONE' && !result && (
            <LinkingNotice>{tr('نتيجة هذه المعاينة لم تعد محفوظة (تُحفظ نتائج آخر خمس معاينات)، شغّل معاينة جديدة')}</LinkingNotice>
          )}
          {!selectedId && listQ.isSuccess && (
            <div className="card text-center py-8 text-sm text-[#6E6557]">{tr('لا معاينة بعد: اختر أساس الربط ثم شغّل المعاينة')}</div>
          )}
          {result && result.basis !== basis && (
            <LinkingNotice tone="warn">
              {tr('هذه النتيجة لأساس آخر')}: {linkBasisLabels(tr)[result.basis] ?? result.basis} — {tr('شغّل المعاينة لعرض الأساس المختار')}
            </LinkingNotice>
          )}
          {result && <SummarySection r={result} />}

          <PreflightTable
            report={preflight?.report ?? null}
            source={preflight?.source ?? null}
            decimals={decimals}
            loading={lightQ.isLoading}
            error={lightQ.isError && !preflight ? linkingErrorText(tr, ledgerErrorOf(lightQ.error)) : null}
          />

          {result && (
            <>
              <OpeningMoveSection opening={result.opening} decimals={result.currencyDecimals} />
              <TrialBalanceSection tb={result.trialBalanceByMonth} decimals={result.currencyDecimals} />
              <PnlSection pnl={result.pnlYtd} decimals={result.currencyDecimals} />
              <BalanceSheetSection bs={result.balanceSheet} decimals={result.currencyDecimals} />
              <VatSection rows={result.vatByPeriodBox} decimals={result.currencyDecimals} />
              <ParitySection checks={result.parity} decimals={result.currencyDecimals} />
              <HeldLinesSection lines={result.heldLines} truncated={result.heldTruncated} decimals={result.currencyDecimals} />
              <EtaStorageSection eta={result.eta} storage={result.storage} />
              <WarningsSection warnings={result.warnings} />
            </>
          )}
        </>
      )}
    </div>
  );
}
