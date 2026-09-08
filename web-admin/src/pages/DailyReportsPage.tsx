import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardCheck, Inbox, Settings, BarChart3, Plus, Trash2, Archive, ArrowUp, ArrowDown,
  CheckCircle2, RotateCcw, MessageSquare, AlertTriangle, Play, UserCog,
} from 'lucide-react';
import { dailyReportApi } from '../api/client';
import { useTr } from '../i18n/strings';
import DailyReportCanvas, { CanvasNode } from './DailyReportCanvas';
import { useAuthStore } from '../store/authStore';
import { formatDate } from '../utils/format';

/**
 * التقرير اليومي — لوحة الإدارة بثلاثة تبويبات:
 *   • بانتظارك — التقارير الواقفة عند مستوىً أملكه، للتعليق والاعتماد والإعادة
 *   • الإعداد   — الخانات والمستويات وملّاكها وتوجيه المناديب (التشعّب)
 *   • الشامل    — إجماليات الفريق لمدّة
 */

type Tab = 'inbox' | 'config' | 'team';

interface InboxRow {
  reportId: string; levelSeq: number; round: number;
  reportDate: string; status: string;
  salesRepId: string; salesRepName: string; submittedAt: string;
}

interface Field { id: string; label: string; kind: string; required: boolean; isActive: boolean; seq: number; fillLevelSeq: number | null }
interface Level { id: string; seq: number; name: string; kind: string; quorum: string; color: string | null; posX: number | null; posY: number | null }
interface Owner { id: string; levelId: string; adminId: string; adminName: string; isDefault: boolean; repIds: string[] }
interface Named { id: string; name: string; role?: string }

const KIND_LABEL: Record<string, string> = { NUMBER: 'رقم', MONEY: 'مبلغ', COUNT: 'عدد', TEXT: 'نص' };
const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'مرفوع', IN_REVIEW: 'قيد المراجعة', RETURNED: 'أعيد للتصحيح', APPROVED: 'معتمد',
};

export default function DailyReportsPage() {
  const tr = useTr();
  const { user } = useAuthStore();
  // صلاحيةٌ مستقلّة اسمها «إعدادات التقرير اليومي» يمنحها المالك في صفحة
  // مستخدمي الشركة. الخادم يحرسها، وهذا إخفاءٌ ليطابق ما تراه العين ما يقبله.
  const canConfig = user?.canManageDailyReport !== false;
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2">
          <ClipboardCheck size={26} className="text-[#E15A30]" /> {tr('التقرير اليومي')}
        </h1>
        <p className="text-[#6E6557] text-sm mt-1">{tr('إقرار المندوب اليومي وسلسلة اعتماده حتى التقرير الشامل')}</p>
      </div>

      <div className="flex gap-2 border-b border-[#F1EBDF]">
        {([['inbox', 'بانتظارك', Inbox], ['config', 'الإعداد', Settings], ['team', 'التقرير الشامل', BarChart3]] as const)
          .filter(([id]) => id !== 'config' || canConfig)
          .map(([id, label, Icon]) => (
          <button
            key={id} onClick={() => setTab(id as Tab)}
            className={`px-4 py-2.5 text-sm font-semibold flex items-center gap-1.5 border-b-2 -mb-px ${tab === id ? 'border-[#E15A30] text-[#E15A30]' : 'border-transparent text-[#6E6557]'}`}
          >
            <Icon size={16} /> {tr(label)}
          </button>
        ))}
      </div>

      {tab === 'inbox' && <InboxTab />}
      {tab === 'config' && canConfig && <ConfigTab />}
      {tab === 'team' && <TeamTab />}
    </div>
  );
}

// ════════════════════════ بانتظارك ════════════════════════

function InboxTab() {
  const tr = useTr();
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['dr-inbox'],
    queryFn: async () => (await dailyReportApi.inbox()).data.data as InboxRow[],
  });

  if (openId) return <ReportDetail id={openId} onBack={() => { setOpenId(null); q.refetch(); }} />;

  return (
    <div className="card overflow-hidden p-0">
      {q.isLoading ? (
        <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
      ) : !q.data?.length ? (
        <div className="p-8 text-center text-gray-400 text-sm">{tr('لا تقارير بانتظارك')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                <th className="text-right font-semibold px-5 py-2.5">{tr('المندوب')}</th>
                <th className="text-center font-semibold px-3 py-2.5">{tr('اليوم')}</th>
                <th className="text-center font-semibold px-3 py-2.5">{tr('الحالة')}</th>
                <th className="text-center font-semibold px-3 py-2.5">{tr('الجولة')}</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {q.data.map(r => (
                <tr key={r.reportId} className="border-t border-[#F5F0E6]">
                  <td className="px-5 py-3 font-semibold text-[#1F1A13]">{r.salesRepName}</td>
                  <td className="px-3 py-3 text-center">{r.reportDate}</td>
                  <td className="px-3 py-3 text-center">{tr(STATUS_LABEL[r.status] || r.status)}</td>
                  <td className="px-3 py-3 text-center">{r.round > 1 ? r.round : '—'}</td>
                  <td className="px-3 py-3 text-left">
                    <button onClick={() => setOpenId(r.reportId)} className="btn-secondary text-xs">{tr('فتح')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReportDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [comment, setComment] = useState<Record<string, string>>({});
  const [myVals, setMyVals] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [err, setErr] = useState('');

  const q = useQuery({
    queryKey: ['dr-report', id],
    queryFn: async () => (await dailyReportApi.get(id)).data.data,
  });
  const refresh = () => { q.refetch(); qc.invalidateQueries({ queryKey: ['dr-inbox'] }); };
  const fail = (e: unknown) => setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر التنفيذ'));

  const addComment = useMutation({
    mutationFn: ({ fieldId, body }: { fieldId: string | null; body: string }) => dailyReportApi.comment(id, { fieldId, body }),
    onSuccess: () => { setComment({}); setErr(''); refresh(); }, onError: fail,
  });
  const saveVals = useMutation({
    mutationFn: (values: unknown[]) => dailyReportApi.saveValues(id, values),
    onSuccess: () => { setErr(''); refresh(); }, onError: fail,
  });
  const approve = useMutation({
    mutationFn: () => dailyReportApi.approve(id),
    onSuccess: () => { setErr(''); onBack(); }, onError: fail,
  });
  const sendBack = useMutation({
    mutationFn: () => dailyReportApi.sendBack(id, reason),
    onSuccess: () => { setErr(''); onBack(); }, onError: fail,
  });

  if (q.isLoading) return <div className="card p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>;
  const d = q.data as {


    salesRep: Named; reportDate: string; status: string; round: number; note: string | null;
    values: { fieldId: string; levelSeq: number; declaredNum: number | null; declaredText: string | null; labelSnapshot: string }[];
    comments: { id: string; fieldId: string | null; authorAdminName: string; body: string; createdAt: string }[];
    steps: { id: string; action: string; actorAdminName: string; reason: string | null; createdAt: string; levelSeq: number }[];
    canAct: boolean; actLevelName: string | null; actLevelKind: string | null;
    myFields: Field[]; distinctApproversNow: number;
  };
  const repValues = d.values.filter(v => v.levelSeq === 0);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="btn-secondary text-xs">{tr('رجوع')}</button>

      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="font-bold text-[#1F1A13]">{d.salesRep.name}</p>
            <p className="text-xs text-[#6E6557]">{d.reportDate} · {tr(STATUS_LABEL[d.status] || d.status)}{d.round > 1 ? ` · ${tr('الجولة')} ${d.round}` : ''}</p>
          </div>
          {d.canAct && d.actLevelName && (
            <span className="text-xs bg-[#FBEBE2] text-[#E15A30] rounded-lg px-3 py-1.5 font-semibold">{tr('عندك الآن')}: {d.actLevelName}</span>
          )}
        </div>
      </div>

      {/* ما أقرّ به المندوب — التعليق على كل خانة */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-[#F1EBDF] font-bold text-sm">{tr('ما أقر به المندوب')}</div>
        <table className="w-full text-sm">
          <tbody>
            {repValues.map(v => {
              const cs = d.comments.filter(c => c.fieldId === v.fieldId);
              return (
                <tr key={v.fieldId} className="border-t border-[#F5F0E6] align-top">
                  <td className="px-5 py-3 text-[#6E6557] w-1/3">{v.labelSnapshot}</td>
                  <td className="px-3 py-3 font-semibold">{v.declaredText ?? (v.declaredNum ?? '—')}</td>
                  <td className="px-5 py-3 w-1/2">
                    {cs.map(c => (
                      <p key={c.id} className="text-xs bg-[#FAF7F0] rounded-lg px-2.5 py-1.5 mb-1">
                        <span className="font-semibold">{c.authorAdminName}:</span> {c.body}
                      </p>
                    ))}
                    {d.canAct && (
                      <div className="flex gap-1.5">
                        <input
                          className="input text-xs flex-1" placeholder={tr('تعليق على هذه الخانة')}
                          value={comment[v.fieldId] ?? ''} onChange={e => setComment(c => ({ ...c, [v.fieldId]: e.target.value }))}
                        />
                        <button
                          className="btn-secondary text-xs shrink-0" disabled={!String(comment[v.fieldId] ?? '').trim()}
                          onClick={() => addComment.mutate({ fieldId: v.fieldId, body: comment[v.fieldId] })}
                        ><MessageSquare size={14} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {d.note && <p className="px-5 py-3 text-xs text-[#6E6557] border-t border-[#F5F0E6]">{tr('ملاحظة')}: {d.note}</p>}
      </div>

      {/* مستوى ENTER: بياناتي أنا — صفوف مستقلّة لا تمسّ إقرار المندوب */}
      {d.canAct && d.actLevelKind === 'ENTER' && d.myFields.length > 0 && (
        <div className="card">
          <p className="font-bold text-sm mb-3">{tr('بياناتك')}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {d.myFields.map(f => (
              <div key={f.id}>
                <label className="label text-xs">{f.label}{f.required && <span className="text-red-500"> *</span>}</label>
                {f.kind === 'TEXT'
                  ? <textarea rows={2} className="input" value={myVals[f.id] ?? ''} onChange={e => setMyVals(v => ({ ...v, [f.id]: e.target.value }))} />
                  : <input type="number" className="input" value={myVals[f.id] ?? ''} onChange={e => setMyVals(v => ({ ...v, [f.id]: e.target.value }))} />}
              </div>
            ))}
          </div>
          <button
            className="btn-secondary mt-3 text-xs"
            onClick={() => saveVals.mutate(d.myFields.map(f => {
              const raw = String(myVals[f.id] ?? '').trim();
              return f.kind === 'TEXT' ? { fieldId: f.id, text: raw || null, num: null } : { fieldId: f.id, num: raw === '' ? null : Number(raw), text: null };
            }))}
          >{tr('حفظ بياناتك')}</button>
        </div>
      )}

      {/* سجلّ الخطوات — من فعل ماذا ومتى */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-[#F1EBDF] font-bold text-sm flex items-center justify-between">
          <span>{tr('سجل الخطوات')}</span>
          {d.distinctApproversNow <= 1 && d.steps.some(s => s.action === 'APPROVE') && (
            <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">{tr('وقعه شخص واحد')}</span>
          )}
        </div>
        <ul className="divide-y divide-[#F5F0E6]">
          {d.steps.map(s => (
            <li key={s.id} className="px-5 py-2.5 text-xs flex justify-between gap-3">
              <span>
                <span className="font-semibold">{s.actorAdminName}</span> — {tr(
                  s.action === 'SUBMIT' ? 'رفع' : s.action === 'APPROVE' ? 'اعتمد' : s.action === 'RETURN' ? 'أعاد' : s.action === 'ENTER' ? 'سجل بياناته' : s.action
                )}
                {s.reason && <span className="text-red-700"> — {s.reason}</span>}
              </span>
              <span className="text-gray-400 shrink-0">{formatDate(s.createdAt)}</span>
            </li>
          ))}
        </ul>
      </div>

      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">{err}</p>}

      {d.canAct && (
        <div className="card flex flex-wrap gap-2">
          <button onClick={() => approve.mutate()} disabled={approve.isPending} className="btn-primary">
            <CheckCircle2 size={16} /> {tr('اعتماد')}
          </button>
          <button onClick={() => setShowReturn(v => !v)} className="btn-secondary">
            <RotateCcw size={16} /> {tr('إعادة للمندوب')}
          </button>
          {showReturn && (
            <div className="basis-full flex gap-2 mt-2">
              <input className="input flex-1" placeholder={tr('سبب الإعادة مطلوب')} value={reason} onChange={e => setReason(e.target.value)} />
              <button className="btn-primary shrink-0" disabled={reason.trim().length < 3 || sendBack.isPending} onClick={() => sendBack.mutate()}>
                {tr('تأكيد الإعادة')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ════════════════════════ الإعداد ════════════════════════

function ConfigTab() {
  const tr = useTr();
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [newField, setNewField] = useState({ label: '', kind: 'NUMBER', required: false, fillLevelSeq: '' });
  const [previewRep, setPreviewRep] = useState('');
  const [preview, setPreview] = useState<string[] | null>(null);

  const q = useQuery({ queryKey: ['dr-config'], queryFn: async () => (await dailyReportApi.config()).data.data });
  const done = () => { setErr(''); qc.invalidateQueries({ queryKey: ['dr-config'] }); };
  const fail = (e: unknown) => setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر التنفيذ'));

  const mAddField = useMutation({ mutationFn: () => dailyReportApi.addField({ ...newField, fillLevelSeq: newField.fillLevelSeq ? Number(newField.fillLevelSeq) : null }), onSuccess: () => { setNewField({ label: '', kind: 'NUMBER', required: false, fillLevelSeq: '' }); done(); }, onError: fail });
  const mArchive = useMutation({ mutationFn: ({ id, restore }: { id: string; restore: boolean }) => dailyReportApi.archiveField(id, restore), onSuccess: done, onError: fail });
  const mDelField = useMutation({ mutationFn: (id: string) => dailyReportApi.deleteField(id), onSuccess: done, onError: fail });
  const mReorder = useMutation({ mutationFn: (ids: string[]) => dailyReportApi.reorderFields(ids), onSuccess: done, onError: fail });
  const mAddLevel = useMutation({ mutationFn: (b: Record<string, unknown>) => dailyReportApi.addLevel(b), onSuccess: done, onError: fail });
  const mUpdLevel = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => dailyReportApi.updateLevel(id, patch), onSuccess: done, onError: fail });
  const mDelLevel = useMutation({ mutationFn: (id: string) => dailyReportApi.deleteLevel(id), onSuccess: done, onError: fail });
  const mOwners = useMutation({ mutationFn: ({ id, owners }: { id: string; owners: unknown[] }) => dailyReportApi.setOwners(id, owners), onSuccess: done, onError: fail });

  if (q.isLoading) return <div className="card p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>;
  const d = q.data as { fields: Field[]; levels: Level[]; owners: Owner[]; admins: Named[]; reps: Named[]; issues: string[]; configLog: { id: string; summary: string; actorAdminName: string; createdAt: string }[] };

  // العقدة على اللوحة = مستوىً + صاحبه الواحد. والمخطّط يحتمل أكثر من صاحب
  // للمستوى (تغطية الإجازة في م٦)، فنأخذ الأول ونُبقي الباقي في البيانات.
  const canvasNodes: CanvasNode[] = (d?.levels ?? []).map(l => {
    const own = (d?.owners ?? []).find(o => o.levelId === l.id);
    return {
      id: l.id, seq: l.seq, name: l.name, kind: l.kind, color: l.color,
      posX: l.posX, posY: l.posY,
      ownerName: own?.adminName ?? null,
      ownerAdminId: own?.adminId ?? null,
      repIds: own?.repIds ?? [],
    };
  });
  const active = d.fields.filter(f => f.isActive);

  return (
    <div className="space-y-5">
      {/* بانر التعثّر: يقول صراحةً أين ستعلق التقارير قبل أن تعلق */}
      {d.issues.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-800 text-sm">
          <p className="font-semibold flex items-center gap-1.5"><AlertTriangle size={16} /> {tr('سلسلة الاعتماد غير مكتملة')}</p>
          <ul className="mt-1.5 text-xs list-disc pr-5 space-y-0.5">{d.issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
          <p className="text-xs mt-2">{tr('لن يستطيع المناديب رفع تقاريرهم حتى تكتمل')}</p>
        </div>
      )}
      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">{err}</p>}

      {/* مسار الاعتماد — رسم العُقد */}
      <DailyReportCanvas
        nodes={canvasNodes} people={d.admins} reps={d.reps}
        onAdd={(afterSeq, adminId, name, color, pos) =>
          mAddLevel.mutate({ afterSeq, adminId, name, color, posX: pos.x, posY: pos.y })}
        onUpdate={(id, patch) => mUpdLevel.mutate({ id, patch })}
        onDelete={id => mDelLevel.mutate(id)}
        onMove={(id, pos) => mUpdLevel.mutate({ id, patch: { posX: pos.x, posY: pos.y } })}
        onOwner={(id, adminId, repIds) => mOwners.mutate({ id, owners: [{ adminId, isDefault: repIds.length === 0, repIds }] })}
      />

      {/* المحاكي */}
      <div className="card">
        <p className="font-bold text-sm mb-3 flex items-center gap-1.5"><Play size={15} className="text-[#E15A30]" /> {tr('جرب: من يستقبل تقرير هذا المندوب')}</p>
        <div className="flex gap-2 flex-wrap items-end">
          <select className="input w-56" value={previewRep} onChange={e => setPreviewRep(e.target.value)}>
            <option value="">{tr('اختر مندوبا')}</option>
            {d.reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button
            className="btn-secondary" disabled={!previewRep}
            onClick={async () => { const res = await dailyReportApi.preview(previewRep); setPreview(res.data.data.lines); }}
          >{tr('جرب')}</button>
        </div>
        {preview && (
          <ol className="mt-3 text-sm space-y-1">
            {preview.map((l, i) => (
              <li key={i} className={`flex gap-2 ${l.includes('يعلق') ? 'text-red-700 font-semibold' : 'text-[#1F1A13]'}`}>
                <span className="text-[#E15A30] font-bold">{i + 1}.</span>{l}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* الخانات */}
      <div className="card">
        <p className="font-bold text-sm mb-3">{tr('خانات النموذج')}</p>
        <div className="space-y-2">
          {active.map((f, i) => (
            <div key={f.id} className="flex items-center gap-2 bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2">
              <span className="flex-1 text-sm font-semibold">{f.label}</span>
              <span className="text-xs text-[#6E6557]">{tr(KIND_LABEL[f.kind] || f.kind)}</span>
              {f.required && <span className="text-[11px] text-red-600">{tr('مطلوبة')}</span>}
              {f.fillLevelSeq && <span className="text-[11px] text-indigo-700 bg-indigo-50 rounded px-1.5">{tr('يملؤها المستوى')} {f.fillLevelSeq}</span>}
              <button disabled={i === 0} onClick={() => { const ids = active.map(x => x.id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; mReorder.mutate(ids); }} className="p-1 disabled:opacity-30"><ArrowUp size={14} /></button>
              <button disabled={i === active.length - 1} onClick={() => { const ids = active.map(x => x.id); [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]]; mReorder.mutate(ids); }} className="p-1 disabled:opacity-30"><ArrowDown size={14} /></button>
              <button onClick={() => mArchive.mutate({ id: f.id, restore: false })} className="p-1 text-amber-700" title={tr('أرشفة')}><Archive size={14} /></button>
              <button onClick={() => mDelField.mutate(f.id)} className="p-1 text-red-600" title={tr('حذف')}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        {d.fields.some(f => !f.isActive) && (
          <details className="mt-3">
            <summary className="text-xs text-[#6E6557] cursor-pointer">{tr('خانات مؤرشفة')}</summary>
            <div className="space-y-1.5 mt-2">
              {d.fields.filter(f => !f.isActive).map(f => (
                <div key={f.id} className="flex items-center gap-2 text-xs text-gray-500 px-3 py-1.5">
                  <span className="flex-1">{f.label}</span>
                  <button onClick={() => mArchive.mutate({ id: f.id, restore: true })} className="underline">{tr('إعادة تفعيل')}</button>
                </div>
              ))}
            </div>
          </details>
        )}
        <div className="flex gap-2 mt-4 flex-wrap items-end">
          <div><label className="label text-xs">{tr('اسم الخانة')}</label><input className="input w-48" value={newField.label} onChange={e => setNewField(v => ({ ...v, label: e.target.value }))} placeholder={tr('مصروفات اليوم')} /></div>
          <div>
            <label className="label text-xs">{tr('نوعها')}</label>
            <select className="input w-32" value={newField.kind} onChange={e => setNewField(v => ({ ...v, kind: e.target.value }))}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}
            </select>
          </div>
          <div>
            <label className="label text-xs">{tr('من يملؤها')}</label>
            <select className="input w-44" value={newField.fillLevelSeq} onChange={e => setNewField(v => ({ ...v, fillLevelSeq: e.target.value }))}>
              <option value="">{tr('المندوب')}</option>
              {d.levels.map(l => <option key={l.id} value={l.seq}>{l.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-xs mb-2"><input type="checkbox" checked={newField.required} onChange={e => setNewField(v => ({ ...v, required: e.target.checked }))} /> {tr('مطلوبة')}</label>
          <button className="btn-primary" disabled={!newField.label.trim()} onClick={() => mAddField.mutate()}><Plus size={16} /> {tr('إضافة خانة')}</button>
        </div>
      </div>

      {/* أثر التدقيق على التهيئة */}
      {d.configLog.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-[#F1EBDF] font-bold text-sm">{tr('سجل تغييرات الإعداد')}</div>
          <ul className="divide-y divide-[#F5F0E6] max-h-64 overflow-y-auto">
            {d.configLog.map(l => (
              <li key={l.id} className="px-5 py-2 text-xs flex justify-between gap-3">
                <span><span className="font-semibold">{l.actorAdminName}</span> {l.summary}</span>
                <span className="text-gray-400 shrink-0">{formatDate(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ════════════════════════ التقرير الشامل ════════════════════════

function TeamTab() {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery({
    queryKey: ['dr-team', from, to],
    queryFn: async () => (await dailyReportApi.team(from, to)).data.data,
    enabled: !!(from && to),
  });

  const d = q.data as {
    fields: Field[];
    rows: { salesRepId: string; salesRepName: string; days: number; approved: number; soloApproved: number; totals: Record<string, number> }[];
    meta: { cappedNote: string | null; scopedNote: string | null };
  } | undefined;

  return (
    <div className="space-y-4">
      <div className="card flex gap-3 flex-wrap items-end">
        <div><label className="label text-xs">{tr('من تاريخ')}</label><input type="date" className="input w-40" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="label text-xs">{tr('إلى تاريخ')}</label><input type="date" className="input w-40" value={to} onChange={e => setTo(e.target.value)} /></div>
      </div>

      {!from || !to ? (
        <div className="card p-8 text-center text-gray-400 text-sm">{tr('حدد المدة لعرض التقرير الشامل')}</div>
      ) : q.isLoading ? (
        <div className="card p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
      ) : (
        <>
          {/* ما قُصّ وما قُيّد يُقال صراحةً — لا قصّ صامت */}
          {d?.meta.cappedNote && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{d.meta.cappedNote}</p>}
          {d?.meta.scopedNote && <p className="text-xs text-[#6E6557] bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl px-3 py-2">{d.meta.scopedNote}</p>}

          <div className="card overflow-hidden p-0">
            {!d?.rows.length ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا تقارير في هذه المدة')}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                      <th className="text-right font-semibold px-5 py-2.5">{tr('المندوب')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('أيام')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('معتمدة')}</th>
                      {d.fields.map(f => <th key={f.id} className="text-center font-semibold px-3 py-2.5">{f.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map(r => (
                      <tr key={r.salesRepId} className="border-t border-[#F5F0E6]">
                        <td className="px-5 py-3 font-semibold text-[#1F1A13]">
                          {r.salesRepName}
                          {r.soloApproved > 0 && (
                            <span className="block text-[10px] text-amber-700 font-normal mt-0.5">{r.soloApproved} {tr('اعتمدها شخص واحد')}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-center">{r.days}</td>
                        <td className="px-3 py-3 text-center">{r.approved}</td>
                        {d.fields.map(f => <td key={f.id} className="px-3 py-3 text-center">{r.totals[f.id] !== undefined ? r.totals[f.id].toLocaleString('ar-EG') : '—'}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * رسم سلسلة الاعتماد — طبقاتٌ متّصلة أفقياً على نسق أنظمة العُقد.
 *
 * لماذا رسمٌ لا قائمة: السلسلة **مسارٌ** لا مجموعة. والقائمة الرأسية تُخفي
 * أهمّ ما يريد المالك رؤيته: إلى أين يمضي التقرير بعد كلٍّ، وأين ينقطع الخيط.
 * العُقدة المعطوبة (بلا مستقبِل) تظهر هنا مقطوعةً من الوصلة بصرياً، لا سطراً
 * أحمر في قائمة.
 *
 * العُقدة الأولى «المندوب» ثابتة ولا تُحذف: هي المستوى 0 الضمنيّ الذي يبدأ
 * منه كل تقرير، وليست صفّاً في الجدول.
 */

/** لوحة ألوان الطبقات — الأحمر محجوزٌ للمندوب فلا يتكرّر */
const LAYER_COLORS = ['#F5C400', '#1E5FE0', '#FFFFFF', '#22C55E', '#A855F7', '#06B6D4', '#F97316', '#EC4899'];
const REP_COLOR = '#EF4444';
const colorOf = (l: Level, i: number) => l.color || LAYER_COLORS[i % LAYER_COLORS.length];

/** كتلة اللون في العُقدة — الشكل العضويّ نفسه في كل عُقدة، يميّزها اللون وحده */
function Blob({ color, size = 46 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path
        d="M50 8c14 0 22 8 30 16s12 14 12 26-6 20-14 27-18 15-28 15-21-6-30-14S6 62 6 50s7-20 15-27S36 8 50 8z"
        fill={color}
        stroke={color === '#FFFFFF' ? '#D8D0C0' : 'none'}
        strokeWidth={color === '#FFFFFF' ? 3 : 0}
      />
    </svg>
  );
}

/** الوصلة بين عقدتين — مقطوعةٌ ومنقّطة حين تكون العُقدة التالية بلا مستقبِل */
function Link({ broken }: { broken?: boolean }) {
  return (
    <div className="flex items-center shrink-0 px-1" aria-hidden="true">
      <span className={`w-1.5 h-1.5 rounded-full ${broken ? 'bg-red-400' : 'bg-[#C9C0AE]'}`} />
      <span
        className={`h-px w-7 ${broken ? 'bg-transparent border-t border-dashed border-red-400' : 'bg-[#C9C0AE]'}`}
      />
      <svg width="9" height="9" viewBox="0 0 10 10" className={broken ? 'text-red-400' : 'text-[#C9C0AE]'}>
        <path d="M1 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** عُقدةٌ في الرسم */
function Node({ color, title, subtitle, badge, selected, broken, onClick, fixed }: {
  color: string; title: string; subtitle?: string; badge?: string;
  selected?: boolean; broken?: boolean; onClick?: () => void; fixed?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={!onClick}
      className={`shrink-0 w-[7.5rem] rounded-2xl border-2 p-2.5 text-center transition
        ${selected ? 'border-[#E15A30] bg-[#FFF6F1]' : broken ? 'border-red-300 bg-red-50' : 'border-[#E9E1D3] bg-white'}
        ${onClick ? 'hover:border-[#E15A30] cursor-pointer' : 'cursor-default'}`}
    >
      <div className="flex justify-center"><Blob color={color} /></div>
      <p className="text-xs font-bold text-[#1F1A13] mt-1.5 truncate" title={title}>{title}</p>
      <p className={`text-[10px] mt-0.5 truncate ${broken ? 'text-red-600 font-semibold' : 'text-[#6E6557]'}`} title={subtitle}>
        {subtitle || (fixed ? '' : '—')}
      </p>
      {badge && <span className="inline-block mt-1 text-[9px] bg-[#FAF7F0] border border-[#E9E1D3] rounded px-1.5 py-0.5 text-[#6E6557]">{badge}</span>}
    </button>
  );
}

/** زرّ إدراج طبقة بين عقدتين */
function InsertBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button" onClick={onClick} title={label}
      className="shrink-0 w-6 h-6 rounded-full border border-dashed border-[#C9C0AE] text-[#6E6557]
                 flex items-center justify-center hover:border-[#E15A30] hover:text-[#E15A30] hover:bg-[#FFF6F1] transition"
    >
      <Plus size={13} />
    </button>
  );
}

