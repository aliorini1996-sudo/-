import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { formatDateTime } from '../../../utils/format';
import { backdropClose } from '../../../lib/backdropClose';
import {
  LedgerListView, initialLedgerListState, type LedgerColumn, type LedgerFilterDef, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { Badge } from '../../../components/ledger/SyncBadges';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerReviewApi, ledgerReviewKeys, type AuditListParams, type AuditLogRow } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { ledgerHref } from '../routes';

/**
 * «مراجعة ← سجل التدقيق» (M3، §9.3، canConfigureLedger، للقراءة): GlAuditLog بترتيب التسلسل تنازلياً، بفلاتر المنفّذ
 * ومجموعات الإجراءات والكيان (`?entityType=&entityId=` من «عرض سجل التدقيق» في LedgerForm). لا حذف ولا تعديل.
 * الملخص عربي كما دوّنه الخادم؛ الإجراء والكيان رموز ثابتة.
 */

const ACTION_GROUPS: Record<string, string[]> = {
  moves: ['MOVE_CREATE', 'MOVE_UPDATE_DRAFT', 'MOVE_DELETE_DRAFT', 'MOVE_POST', 'MOVE_REVERSE', 'MOVE_RESET_DRAFT', 'MOVE_REPOST', 'MOVE_REVIEW', 'MOVE_NOTE', 'MOVE_CONTROL_ADJUST'],
  auto: ['AUTO_POST', 'EVENT_RETRY', 'EVENT_SKIP', 'EVENT_HOLD_RELEASE'],
  config: ['SETUP_START', 'SETUP_COMMIT', 'FLAG_TOGGLE', 'SETTINGS_CHANGE', 'MAPPING_CHANGE', 'LOCK_DATE_CHANGE', 'ACCOUNT_CREATE', 'ACCOUNT_UPDATE', 'ACCOUNT_ARCHIVE', 'ACCOUNT_IMPORT', 'LEDGER_RESET'],
  export: ['EXPORT'],
};

export default function AuditLogPage() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const [sp, setSp] = useSearchParams();
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState({ limit: 50 }));
  const [entity, setEntity] = useState<{ entityType?: string; entityId?: string }>(() => ({
    entityType: sp.get('entityType') ?? undefined, entityId: sp.get('entityId') ?? undefined,
  }));
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const params: AuditListParams = useMemo(() => ({
    ...entity,
    action: state.filters.filter(f => f.startsWith('group:')).flatMap(f => ACTION_GROUPS[f.slice(6)] ?? []),
    actorType: state.filters.filter(f => f.startsWith('actor:')).map(f => f.slice(6)),
    q: state.search || undefined, offset: state.offset, limit: state.limit,
  }), [state, entity]);

  const q = useQuery({
    queryKey: ledgerReviewKeys.audit(params),
    queryFn: async () => (await ledgerReviewApi.audit.list(params)).data.data,
    placeholderData: keepPreviousData,
  });

  const filters: LedgerFilterDef[] = [
    { key: 'group:moves', label: tr('القيود'), group: 'action' },
    { key: 'group:auto', label: tr('الترحيل الآلي'), group: 'action' },
    { key: 'group:config', label: tr('الإعداد والتهيئة'), group: 'action' },
    { key: 'group:export', label: tr('التصدير'), group: 'action' },
    { key: 'actor:ADMIN', label: tr('مستخدم'), group: 'actor' },
    { key: 'actor:IMPERSONATION', label: tr('بانتحال'), group: 'actor' },
    { key: 'actor:SYSTEM', label: tr('النظام'), group: 'actor' },
    { key: 'actor:OWNER', label: tr('مالك المنصة'), group: 'actor' },
  ];

  const actorLabel = (r: AuditLogRow) => (r.actorType === 'SYSTEM' ? tr('النظام') : r.actorType === 'OWNER' ? tr('مالك المنصة') : r.actorName ?? '—');

  const columns: LedgerColumn<AuditLogRow>[] = [
    { key: 'seq', label: '#', render: r => <bdi className="tabular-nums text-[#9A8F7E]">{r.seq}</bdi> },
    { key: 'at', label: tr('الوقت'), render: r => <span className="whitespace-nowrap">{formatDateTime(r.at)}</span> },
    {
      key: 'actor', label: tr('المنفّذ'),
      render: r => <span className="inline-flex items-center gap-1 whitespace-nowrap">{actorLabel(r)}{r.impersonated && <Badge tone="amber">{tr('بانتحال')}</Badge>}</span>,
    },
    { key: 'action', label: tr('الإجراء'), render: r => <bdi className="font-mono text-[11px]">{r.action}</bdi> },
    {
      key: 'entity', label: tr('الكيان'),
      render: r => (r.entityType === 'MOVE' && r.entityId
        ? <Link onClick={e => e.stopPropagation()} to={ledgerHref(`entries/${r.entityId}`)} className="text-[#E15A30] hover:underline font-mono text-[11px]">MOVE</Link>
        : <bdi className="font-mono text-[11px]">{r.entityType}</bdi>),
    },
    {
      key: 'summary', label: tr('الملخص'),
      render: r => <span className="block max-w-[28rem] truncate" title={r.summary} dir={lang === 'ar' ? undefined : 'rtl'}>{r.summary}</span>,
    },
    { key: 'ip', label: 'IP', optional: true, render: r => <bdi className="font-mono text-[11px]">{r.requestIp ?? ''}</bdi> },
  ];

  const clearEntity = () => {
    setEntity({});
    const next = new URLSearchParams(sp);
    next.delete('entityType'); next.delete('entityId');
    setSp(next, { replace: true });
  };

  return (
    <div className="space-y-3">
      {(entity.entityType || entity.entityId) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[#6E6557]">{tr('فلاتر من الرابط')}:</span>
          <span className="rounded-md bg-[#F1EBDF] px-1.5 py-0.5"><bdi>{entity.entityType} {entity.entityId}</bdi></span>
          <button type="button" onClick={clearEntity} className="inline-flex items-center gap-0.5 text-[#E15A30] hover:underline"><X size={12} />{tr('مسح')}</button>
        </div>
      )}
      <LedgerListView<AuditLogRow>
        title={tr('سجل التدقيق')}
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={setState}
        filters={filters}
        onRowClick={r => setDetail(r)}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا سجلات')}
      />
      {detail && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" {...backdropClose(() => setDetail(null))}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
              <h2 id="audit-detail-title" className="text-lg font-bold text-[#1F1A13] flex-1"><bdi className="font-mono">{detail.action}</bdi> · #{detail.seq}</h2>
              <button type="button" onClick={() => setDetail(null)} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-3 text-sm">
              <p>{detail.summary}</p>
              <p className="text-xs text-[#6E6557]">{formatDateTime(detail.at)} · {actorLabel(detail)} · <bdi className="font-mono">{detail.entityType} {detail.entityId ?? ''}</bdi></p>
              {detail.beforeJson != null && (
                <div><p className="text-xs font-semibold text-[#9A8F7E] mb-1">{tr('قبل')}</p><pre dir="ltr" className="text-[11px] bg-[#FBF7F0] rounded-lg p-2 overflow-auto max-h-60">{JSON.stringify(detail.beforeJson, null, 2)}</pre></div>
              )}
              {detail.afterJson != null && (
                <div><p className="text-xs font-semibold text-[#9A8F7E] mb-1">{tr('بعد')}</p><pre dir="ltr" className="text-[11px] bg-[#FBF7F0] rounded-lg p-2 overflow-auto max-h-60">{JSON.stringify(detail.afterJson, null, 2)}</pre></div>
              )}
              <p dir="ltr" className="text-[10px] font-mono text-[#9A8F7E] break-all">hash {detail.hash}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
