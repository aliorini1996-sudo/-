import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, RotateCcw, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { paymentMethodMapReasonLabels } from '../../../lib/ledger/labels';
import { methodAccountCandidates, methodJournalCandidates, methodMapRowLabel, opsErrorMessage } from '../../../lib/ledger/sync';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys, isLedgerAccessError } from '../../../api/ledgerConfig';
import { ledgerOpsApi, ledgerOpsKeys, type AccountBrief, type PaymentMethodMapRow, type PaymentMethodMapView } from '../../../api/ledgerOps';
import { Badge } from '../../../components/ledger/SyncBadges';
import { AccountSelect, ConfigHeader, WriteButton, useAllAccounts, useLedgerCan } from './parts/configUi';

/**
 * «التهيئة ← المحاسبة ← طرق الدفع والحسابات» (L5 من «ربط الدفاتر»، العقد §5.9 وD3، OD4/OD14، C2/C10).
 *
 * لكل طريقة دفع (الست الأساسية ثم المخصّصة c_…) الحساب الذي يقيّد عليه سند القبض في الدفاتر المربوطة:
 * صفّ المفتاح المخصّص ⇐ صفّ الأساس ⇐ الافتراضي (النقد 111001، التحويل 111101، نقطة البيع 112004، الشيك 112003، البطاقة
 * 112007، توريد الأمانات 111101). «الحساب الفعلي» يحسبه الخادم بـlinkedMethodAccount نفسه الذي يبني به السندُ قيدَه.
 * المنتقي يعرض ما يقبله PUT وحده (نقد أو أصل متداول، نشط، غير رئيسي، وليس 911001 ولا 112005)، والخادم يحسم الباقي (422).
 * الدفاتر غير المربوطة: العرض للاطلاع والتعديل معطّل (409 LEDGER_BOOKS_NOT_LINKED في الخادم لليدوية).
 */

type RowDraft = { accountId: string | null; journalId: string | null };

export default function PaymentMethodMapPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const lang = useLang(s => s.lang);
  const canWrite = useLedgerCan('canConfigureLedger');
  const [draft, setDraft] = useState<Record<string, RowDraft>>({});

  const q = useQuery({ queryKey: ledgerOpsKeys.paymentMethods, queryFn: async () => (await ledgerOpsApi.paymentMethods.list()).data.data });
  const accountsQ = useAllAccounts();
  const journalsQ = useQuery({ queryKey: ledgerKeys.journals, queryFn: async () => (await ledgerConfigApi.journals.list()).data.data });
  useEffect(() => setDraft({}), [q.data]);

  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const candidates = useMemo(() => methodAccountCandidates(accounts), [accounts]);
  const journals = useMemo(() => methodJournalCandidates(journalsQ.data ?? []), [journalsQ.data]);
  const linked = q.data?.linked === true;
  const editable = canWrite && linked;
  const errorText = (e: unknown) => opsErrorMessage(tr, ledgerErrorOf(e), paymentMethodMapReasonLabels(tr));

  const onSaved = (data: PaymentMethodMapView) => {
    qc.setQueryData(ledgerOpsKeys.paymentMethods, data);
    toast.success(tr('تم الحفظ'));
  };
  const save = useMutation({
    mutationFn: async ({ key, d }: { key: string; d: RowDraft }) =>
      (await ledgerOpsApi.paymentMethods.set(key, { accountId: d.accountId!, journalId: d.journalId })).data.data,
    onSuccess: onSaved,
    onError: e => toast.error(errorText(e)),
  });
  const reset = useMutation({
    mutationFn: async (key: string) => (await ledgerOpsApi.paymentMethods.reset(key)).data.data,
    onSuccess: onSaved,
    onError: e => toast.error(errorText(e)),
  });

  const valueOf = (m: PaymentMethodMapRow): RowDraft => draft[m.methodKey] ?? { accountId: m.accountId, journalId: m.journalId };
  const dirtyOf = (m: PaymentMethodMapRow): boolean => {
    const d = draft[m.methodKey];
    return !!d && !!d.accountId && (d.accountId !== m.accountId || (d.journalId ?? null) !== (m.journalId ?? null));
  };
  const patch = (key: string, base: RowDraft, p: Partial<RowDraft>) => setDraft(s => ({ ...s, [key]: { ...base, ...(s[key] ?? {}), ...p } }));
  const busyKey = save.isPending ? save.variables?.key : reset.isPending ? reset.variables : null;

  const brief = (a: AccountBrief | null) => (a ? <span className="truncate"><bdi className="tabular-nums text-[#6E6557]">{a.code}</bdi> {a.name}</span> : <span className="text-[#9A8F7E]">—</span>);

  if (q.isError) {
    return <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : errorText(q.error)}</p>;
  }

  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('طرق الدفع والحسابات')} subtitle={tr('الحساب الذي يقيّد عليه سند القبض لكل طريقة دفع في الدفاتر المربوطة بالنظام')} />
      {q.data && !linked && (
        <p className="flex items-start gap-2 rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] px-3 py-2 text-sm text-[#1F1A13]" role="status">
          <Info size={15} className="shrink-0 mt-0.5 text-[#9A8F7E]" />
          {tr('خريطة طرق الدفع تسري على الدفاتر المربوطة بالنظام وحدها')}
        </p>
      )}
      <p className="text-xs text-[#9A8F7E] leading-relaxed flex items-start gap-1">
        <Info size={13} className="shrink-0 mt-0.5" />
        {tr('الطريقة المضافة بلا حساب خاص تتبع حساب أساسها. الدفع الإلكتروني برابط الدفع يُقيَّد على أمانات الدفع الإلكتروني دائماً فلا يظهر هنا. التعديل يسري على السندات المرحّلة بعده ولا يعيد ترحيل ما سبق')}
      </p>
      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-6 text-center">{tr('جاري التحميل...')}</p>}
      {q.data && (
        <div className="card !p-0 overflow-visible">
          <div className="hidden lg:grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(14rem,1.3fr)_minmax(10rem,0.9fr)_minmax(10rem,1fr)_auto] gap-2 px-4 py-2 text-[11px] text-[#9A8F7E] border-b border-[#F1EBDF] bg-[#FBF7F0] rounded-t-2xl">
            <span>{tr('طريقة الدفع')}</span>
            <span>{tr('الحساب الافتراضي')}</span>
            <span>{tr('الحساب المربوط')}</span>
            <span>{tr('دفتر القيد')}</span>
            <span>{tr('الحساب الفعلي')}</span>
            <span />
          </div>
          <div className="divide-y divide-[#F1EBDF]">
            {q.data.methods.map(m => {
              const v = valueOf(m);
              const dirty = dirtyOf(m);
              const busy = busyKey === m.methodKey;
              // صفّ يتيم (طريقة حُذفت من الإعداد): لا يُعدَّل (404 في الخادم)، ويُعاد إلى الافتراضي فقط
              const orphan = m.custom && !m.base;
              // الحساب المربوط حالياً يبقى ظاهراً في المنتقي ولو خرج من المرشّحين (أُرشف بعد الربط)
              const current = m.accountId ? accounts.find(a => a.id === m.accountId) : undefined;
              const options = current && !candidates.includes(current) ? [current, ...candidates] : candidates;
              return (
                <div key={m.methodKey} className={`grid gap-2 px-4 py-2.5 lg:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(14rem,1.3fr)_minmax(10rem,0.9fr)_minmax(10rem,1fr)_auto] items-center ${dirty ? 'bg-[#FBEBE2]/40' : ''}`}>
                  <div className="min-w-0">
                    <p className="text-sm text-[#1F1A13] truncate">{methodMapRowLabel(m, tr)}</p>
                    <p className="text-[11px] text-[#9A8F7E] flex flex-wrap items-center gap-1">
                      <bdi dir="ltr" className="font-mono">{m.methodKey}</bdi>
                      {m.custom && m.base && <span>· {tr('أساسها')}: {methodMapRowLabel({ methodKey: m.base, label: '', custom: false }, tr)}</span>}
                      {m.custom && <Badge tone="blue">{tr('مضافة')}</Badge>}
                      {m.archived && <Badge tone="gray">{tr('مؤرشفة')}</Badge>}
                    </p>
                  </div>
                  <div className="min-w-0 text-sm">
                    <span className="lg:hidden text-[11px] text-[#9A8F7E] block">{tr('الحساب الافتراضي')}</span>
                    {brief(m.defaultAccount)}
                  </div>
                  <div className="min-w-0">
                    <span className="lg:hidden text-[11px] text-[#9A8F7E] block">{tr('الحساب المربوط')}</span>
                    <AccountSelect accounts={options} value={v.accountId} disabled={!editable || busy || orphan}
                      placeholder={m.defaultAccount ? `${tr('الافتراضي')}: ${m.defaultAccount.code} ${m.defaultAccount.name}` : tr('الافتراضي')}
                      onChange={id => id && patch(m.methodKey, v, { accountId: id })} />
                  </div>
                  <div className="min-w-0">
                    <span className="lg:hidden text-[11px] text-[#9A8F7E] block">{tr('دفتر القيد')}</span>
                    <select className="input w-full" value={v.journalId ?? ''} disabled={!editable || busy || orphan || !v.accountId}
                      onChange={e => patch(m.methodKey, v, { journalId: e.target.value || null })}>
                      <option value="">{tr('الافتراضي')}</option>
                      {journals.map(j => <option key={j.id} value={j.id}>{j.code} · {ledgerName(j, lang)}</option>)}
                    </select>
                  </div>
                  <div className="min-w-0 text-sm">
                    <span className="lg:hidden text-[11px] text-[#9A8F7E] block">{tr('الحساب الفعلي')}</span>
                    {brief(m.effective)}
                  </div>
                  <div className="flex items-center gap-1.5 justify-end">
                    {dirty && (
                      <>
                        <button type="button" className="btn-secondary !py-1 !px-2 text-xs" disabled={busy}
                          onClick={() => setDraft(s => { const n = { ...s }; delete n[m.methodKey]; return n; })}>{tr('إهمال')}</button>
                        <WriteButton allowed={editable} busy={busy} className="btn-primary !py-1 !px-2 text-xs inline-flex items-center gap-1"
                          onClick={() => save.mutate({ key: m.methodKey, d: v })}>
                          <Save size={12} />{tr('حفظ')}
                        </WriteButton>
                      </>
                    )}
                    {!dirty && m.accountId && (
                      <WriteButton allowed={editable} busy={busy} className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1"
                        onClick={() => reset.mutate(m.methodKey)}>
                        <RotateCcw size={12} />{tr('إعادة الافتراضي')}
                      </WriteButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
