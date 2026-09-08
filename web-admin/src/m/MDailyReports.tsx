import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, CheckCircle2, RotateCcw, MessageSquare, AlertTriangle, UserRound } from 'lucide-react';
import { dailyReportApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { MCard, MRow, MEmpty, MError, MSpinner, MHeader, MScreen } from './mobileUi';
import { useBackClose } from '../lib/useBackClose';

/**
 * التقارير اليومية في تطبيق الإدارة على الجوال.
 *
 * يستقبل المستخدم هنا **ما يقف عند مستواه هو** لا كل تقارير الشركة: الخادم
 * يشتقّ الصندوق من مِلكيّة العُقد (`/daily-reports/admin/inbox`)، فمشرفٌ يرى
 * تقارير مناديبه، ومحاسبٌ لا يرى شيئاً حتى يمرّ التقرير بالمشرف قبله.
 *
 * وهي شاشةٌ أون‑لاين مثل باقي تطبيق الإدارة: الاعتماد توقيعٌ على مستند،
 * وتخزينُه محلياً ليُرفع لاحقاً يعني توقيعاً على أرقامٍ قد تكون تغيّرت.
 */

interface Row {
  reportId: string; levelSeq: number; round: number;
  reportDate: string; status: string;
  salesRepId: string; salesRepName: string; submittedAt: string;
}

const STATUS: Record<string, string> = {
  SUBMITTED: 'مرفوع', IN_REVIEW: 'قيد المراجعة', RETURNED: 'أعيد للتصحيح', APPROVED: 'معتمد',
};

export default function MDailyReports() {
  const tr = useTr();
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['m-dr-inbox'],
    queryFn: async () => (await dailyReportApi.inbox()).data.data as Row[],
  });

  useBackClose(!!openId, () => setOpenId(null));

  if (openId) return <Detail id={openId} onBack={() => { setOpenId(null); q.refetch(); }} />;

  return (
    <MScreen header={
      <div className="px-4 py-3 border-b border-gray-100 bg-white">
        <p className="font-bold text-[#1F1A13] text-sm flex items-center gap-1.5">
          <ClipboardCheck size={16} className="text-[#E15A30]" /> {tr('التقارير اليومية')}
        </p>
        <p className="text-[11px] text-[#6E6557] mt-0.5">{tr('ما ينتظر اعتمادك أنت')}</p>
      </div>
    }>
      {q.isLoading ? <MSpinner />
        : q.isError ? <MError onRetry={() => q.refetch()} />
        : !q.data?.length ? <MEmpty text={tr('لا تقارير بانتظارك')} icon={ClipboardCheck} />
        : q.data.map(r => (
          <MRow
            key={r.reportId}
            leading={<Initial name={r.salesRepName} />}
            title={r.salesRepName}
            subtitle={`${r.reportDate} · ${tr(STATUS[r.status] || r.status)}${r.round > 1 ? ` · ${tr('جولة')} ${r.round}` : ''}`}
            onClick={() => setOpenId(r.reportId)}
          />
        ))}
    </MScreen>
  );
}

function Initial({ name }: { name: string }) {
  const ch = (name || '').trim().charAt(0);
  return (
    <div className="w-9 h-9 rounded-full bg-[#FFF1EA] text-[#E15A30] flex items-center justify-center font-bold text-sm">
      {ch || <UserRound size={16} />}
    </div>
  );
}

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [comment, setComment] = useState<Record<string, string>>({});
  const [mine, setMine] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState('');

  const q = useQuery({
    queryKey: ['m-dr', id],
    queryFn: async () => (await dailyReportApi.get(id)).data.data,
  });
  const after = () => { setErr(''); q.refetch(); qc.invalidateQueries({ queryKey: ['m-dr-inbox'] }); };
  const fail = (e: unknown) => setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر التنفيذ'));

  const mComment = useMutation({
    mutationFn: (b: { fieldId: string | null; body: string }) => dailyReportApi.comment(id, b),
    onSuccess: () => { setComment({}); after(); }, onError: fail,
  });
  const mVals = useMutation({
    mutationFn: (v: unknown[]) => dailyReportApi.saveValues(id, v), onSuccess: after, onError: fail,
  });
  const mApprove = useMutation({ mutationFn: () => dailyReportApi.approve(id), onSuccess: onBack, onError: fail });
  const mReturn = useMutation({ mutationFn: () => dailyReportApi.sendBack(id, reason), onSuccess: onBack, onError: fail });

  if (q.isLoading) return <MSpinner />;
  if (q.isError) return <MError onRetry={() => q.refetch()} />;

  const d = q.data as {
    salesRep: { id: string; name: string }; reportDate: string; status: string; round: number; note: string | null;
    values: { fieldId: string; levelSeq: number; declaredNum: number | null; declaredText: string | null; labelSnapshot: string }[];
    comments: { id: string; fieldId: string | null; authorAdminName: string; body: string }[];
    steps: { id: string; action: string; actorAdminName: string; reason: string | null; levelSeq: number }[];
    canAct: boolean; actLevelName: string | null; actLevelKind: string | null;
    myFields: { id: string; label: string; kind: string; required: boolean }[];
    distinctApproversNow: number;
  };
  const repVals = d.values.filter(v => v.levelSeq === 0);
  const show = (v: { declaredNum: number | null; declaredText: string | null }) =>
    v.declaredText ?? (v.declaredNum === null ? '—' : String(v.declaredNum));

  return (
    <MScreen header={<MHeader title={d.salesRep.name} subtitle={`${d.reportDate} · ${tr(STATUS[d.status] || d.status)}`} onBack={onBack} />}>
      {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</p>}

      {d.canAct && d.actLevelName && (
        <p className="text-xs text-[#6E6557] bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl px-3 py-2">
          {tr('يقف عند مستواك')}: <span className="font-semibold">{d.actLevelName}</span>
        </p>
      )}

      {/* ما أقرّ به المندوب */}
      <MCard>
        <p className="font-bold text-sm mb-2">{tr('ما أقر به المندوب')}</p>
        {!repVals.length ? <p className="text-xs text-gray-400">{tr('لا خانات')}</p> : repVals.map(v => {
          const cs = d.comments.filter(c => c.fieldId === v.fieldId);
          return (
            <div key={v.fieldId} className="border-t border-[#F5F0E6] py-2 first:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[#6E6557]">{v.labelSnapshot}</span>
                <span className="text-sm font-bold text-[#1F1A13]">{show(v)}</span>
              </div>
              {cs.map(c => (
                <p key={c.id} className="text-[11px] text-[#6E6557] mt-1 bg-[#FAF7F0] rounded-lg px-2 py-1">
                  <span className="font-semibold">{c.authorAdminName}:</span> {c.body}
                </p>
              ))}
              {d.canAct && (
                <div className="flex gap-1.5 mt-1.5">
                  <input
                    className="input flex-1 text-xs" placeholder={tr('تعليق على هذه الخانة')}
                    value={comment[v.fieldId] || ''}
                    onChange={e => setComment(c => ({ ...c, [v.fieldId]: e.target.value }))}
                  />
                  <button
                    className="btn-secondary text-xs px-2" disabled={!(comment[v.fieldId] || '').trim()}
                    onClick={() => mComment.mutate({ fieldId: v.fieldId, body: comment[v.fieldId].trim() })}
                  ><MessageSquare size={13} /></button>
                </div>
              )}
            </div>
          );
        })}
        {d.note && <p className="text-xs text-[#6E6557] mt-2 border-t border-[#F5F0E6] pt-2">{tr('ملاحظته')}: {d.note}</p>}
      </MCard>

      {/* خانات يملؤها هذا المستوى */}
      {d.canAct && d.actLevelKind === 'ENTER' && d.myFields.length > 0 && (
        <MCard>
          <p className="font-bold text-sm mb-2">{tr('بياناتك أنت')}</p>
          {d.myFields.map(f => (
            <div key={f.id} className="flex items-center gap-2 py-1.5">
              <span className="text-xs text-[#6E6557] flex-1">{f.label}{f.required && ' *'}</span>
              <input
                className="input w-28 text-sm" inputMode={f.kind === 'TEXT' ? 'text' : 'decimal'}
                value={mine[f.id] ?? ''} onChange={e => setMine(m => ({ ...m, [f.id]: e.target.value }))}
              />
            </div>
          ))}
          <button
            className="btn-secondary text-xs w-full mt-2"
            onClick={() => mVals.mutate(d.myFields
              .filter(f => (mine[f.id] ?? '').trim() !== '')
              .map(f => ({ fieldId: f.id, ...(f.kind === 'TEXT' ? { declaredText: mine[f.id] } : { declaredNum: Number(mine[f.id]) }) })))}
          >{tr('حفظ بياناتي')}</button>
        </MCard>
      )}

      {/* المسار */}
      <MCard>
        <p className="font-bold text-sm mb-2">{tr('مسار التقرير')}</p>
        {d.steps.map(s => (
          <p key={s.id} className="text-[11px] text-[#6E6557] py-0.5">
            {s.actorAdminName} — {tr(s.action === 'SUBMIT' ? 'رفع' : s.action === 'APPROVE' ? 'اعتمد'
              : s.action === 'RETURN' ? 'أعاد' : s.action === 'ENTER' ? 'سجل بياناته' : 'حوّل')}
            {s.reason ? ` · ${s.reason}` : ''}
          </p>
        ))}
        {d.distinctApproversNow === 1 && d.steps.some(s => s.action === 'APPROVE') && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1.5 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {tr('وقعه شخص واحد حتى الآن')}
          </p>
        )}
      </MCard>

      {/* الفعل */}
      {d.canAct && (
        asking ? (
          <MCard>
            <p className="font-bold text-sm mb-2">{tr('سبب الإعادة')}</p>
            <textarea
              className="input w-full text-sm" rows={3} value={reason} autoFocus
              onChange={e => setReason(e.target.value)} placeholder={tr('اكتب ما يجب تصحيحه')}
            />
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 text-sm" disabled={!reason.trim() || mReturn.isPending} onClick={() => mReturn.mutate()}>
                {tr('إعادة للمندوب')}
              </button>
              <button className="btn-secondary text-sm" onClick={() => setAsking(false)}>{tr('إلغاء')}</button>
            </div>
          </MCard>
        ) : (
          <div className="flex gap-2">
            <button className="btn-primary flex-1 text-sm min-h-[44px]" disabled={mApprove.isPending} onClick={() => mApprove.mutate()}>
              <CheckCircle2 size={16} /> {tr('اعتماد')}
            </button>
            <button className="btn-secondary text-sm min-h-[44px]" onClick={() => setAsking(true)}>
              <RotateCcw size={15} /> {tr('إعادة')}
            </button>
          </div>
        )
      )}
    </MScreen>
  );
}
