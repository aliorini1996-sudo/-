import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Settings, Save, X, ExternalLink, RotateCcw, MessageSquare } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../i18n/strings';
import { useDir } from '../../i18n/lang';
import { useAuthStore } from '../../store/authStore';
import { canLedger, type LedgerKey } from '../../lib/ledgerPerms';
import { formatDateTime } from '../../utils/format';
import ConfirmDialog from '../ConfirmDialog';
import { ledgerMovesApi, ledgerMoveKeys } from '../../api/ledgerMoves';
import { findLedgerRoute } from '../../pages/ledger/routes';
import { LedgerLoadingToast, type LedgerRecordNavState } from './LedgerListView';
import { AttachmentPane } from './AttachmentPane';

/**
 * نموذج الدفاتر الموحّد (§8.3): مسار التنقّل، وعدّاد السجلات «16 / 80» بترتيب القائمة وفلاترها،
 * وقائمة الترس، والحفظ أو الإهمال اليدوي، وشريط الحالة، وتبويبات، وقسم ملاحظات وتتبّع بجانب النموذج.
 *
 * على القيد المملوك لمصدر (I7): الصفحة لا تمرّر «عكس» و«إعادة إلى مسودة»، ويعرض النموذج رابط
 * «المصدر: <المستند>» وزر «إعادة الترحيل من المصدر» لمن يملك canConfigureLedger (M3).
 * «حذف المسودة» في الترس بخطوة تأكيد (JE‑05b)؛ وزر الإهمال (x) يُسقط التعديلات غير المحفوظة فقط.
 */

export interface LedgerFormGearItem {
  label: string;
  perm: LedgerKey;
  run: () => void | Promise<unknown>;
  danger?: boolean;
  /** نص تأكيد قبل التنفيذ */
  confirm?: string;
}

export interface LedgerFormTab { key: string; label: string; content: ReactNode }

export function LedgerForm({
  breadcrumb, title, recordPath, status, statusSteps, headerActions, gearItems = [], dirty = false, saving = false, canSave = true,
  onSave, onDiscard, onDeleteDraft, deletePerm = 'canPostJournals', tabs, children, loading, banner, source, onRepostFromSource,
  audit, chatter,
}: {
  /** [{label, to}] — الأخير عنوان السجل الحالي */
  breadcrumb: { label: string; to?: string }[];
  title?: ReactNode;
  /** لعدّاد السجلات: مسار سجل بمعرّفه */
  recordPath?: (id: string) => string;
  status?: string;
  statusSteps?: { key: string; label: string }[];
  headerActions?: ReactNode;
  gearItems?: LedgerFormGearItem[];
  dirty?: boolean;
  saving?: boolean;
  canSave?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  /** المسودة اليدوية غير المملوكة لمستند فقط */
  onDeleteDraft?: () => void | Promise<unknown>;
  deletePerm?: LedgerKey;
  tabs?: LedgerFormTab[];
  children: ReactNode;
  loading?: boolean;
  banner?: ReactNode;
  /** قيد مملوك لمصدر (I7) */
  source?: { label: string; href?: string; origin?: 'MANUAL' | 'AUTO' } | null;
  onRepostFromSource?: () => void;
  /** «عرض سجل التدقيق» */
  audit?: { entityType: string; entityId: string };
  /** قسم الملاحظات والتتبّع والمرفقات (القيود) */
  chatter?: { moveId: string; attachments?: boolean };
}) {
  const tr = useTr();
  const dir = useDir();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const [gearOpen, setGearOpen] = useState(false);
  const [confirm, setConfirm] = useState<LedgerFormGearItem | null>(null);
  const [tab, setTab] = useState(tabs?.[0]?.key);
  const gearRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gearOpen) return;
    const h = (e: MouseEvent) => { if (gearRef.current && !gearRef.current.contains(e.target as Node)) setGearOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [gearOpen]);

  // تحذير مغادرة الصفحة بتعديلات غير محفوظة
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ═══ عدّاد السجلات ═══
  const nav = location.state as Partial<LedgerRecordNavState> | null;
  const ids = nav?.ledgerIds ?? [];
  const currentId = location.pathname.split('/').pop() ?? '';
  const idx = ids.indexOf(currentId);
  const go = (delta: number) => {
    if (idx < 0 || !recordPath || ids.length === 0) return;
    if (dirty && !window.confirm(tr('توجد تعديلات غير محفوظة — المتابعة تُسقطها'))) return;
    const nextId = ids[(idx + delta + ids.length) % ids.length];
    navigate(recordPath(nextId), { state: nav });
  };

  // عناصر الترس المسموحة: ما لا يملك المستخدم صلاحيته لا يُعرض
  const auditRoute = findLedgerRoute('review/audit');
  const items: LedgerFormGearItem[] = [
    ...gearItems,
    ...(onDeleteDraft ? [{ label: tr('حذف المسودة'), perm: deletePerm, run: onDeleteDraft, danger: true, confirm: tr('حذف هذه المسودة نهائيا؟ لا يترك الحذف فجوة في الترقيم') }] : []),
    ...(audit && auditRoute ? [{ label: tr('عرض سجل التدقيق'), perm: auditRoute.view, run: () => navigate(`/app/ledger/review/audit?entityType=${encodeURIComponent(audit.entityType)}&entityId=${encodeURIComponent(audit.entityId)}`) }] : []),
  ].filter(i => canLedger(user, i.perm));

  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const activeTab = tabs?.find(t => t.key === tab) ?? tabs?.[0];

  return (
    <div className="space-y-3">
      <LedgerLoadingToast show={!!loading} />

      {/* مسار التنقّل والترس والحفظ والعدّاد */}
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex items-center gap-1 text-sm min-w-0" aria-label={tr('مسار التنقل')}>
          {breadcrumb.map((b, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-[#9A8F7E]">/</span>}
              {b.to ? <Link to={nav?.ledgerListPath && i === 0 ? nav.ledgerListPath : b.to} className="text-[#E15A30] hover:underline truncate">{b.label}</Link>
                : <span className="font-bold text-[#1F1A13] truncate">{b.label}</span>}
            </span>
          ))}
        </nav>
        {items.length > 0 && (
          <div ref={gearRef} className="relative">
            <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF] text-[#6E6557]" aria-label={tr('الإجراءات')} onClick={() => setGearOpen(o => !o)}><Settings size={16} /></button>
            {gearOpen && (
              <div className="absolute z-30 mt-1 start-0 w-56 bg-white rounded-xl shadow-xl border border-[#E8E0D2] py-1">
                {items.map(i => (
                  <button key={i.label} type="button" className={`w-full text-start px-3 py-2 text-sm hover:bg-[#FBF7F0] ${i.danger ? 'text-[#C0392B]' : ''}`}
                    onClick={() => { setGearOpen(false); if (i.confirm) setConfirm(i); else void i.run(); }}>{i.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {onSave && (
          <>
            <button type="button" className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2] disabled:opacity-40" disabled={!dirty || saving || !canSave} onClick={onSave} aria-label={tr('حفظ')} title={tr('حفظ')}>
              <Save size={17} />
            </button>
            {dirty && onDiscard && (
              <button type="button" className="p-1.5 rounded-lg text-[#6E6557] hover:bg-[#F1EBDF]" onClick={onDiscard} aria-label={tr('إهمال التعديلات')} title={tr('إهمال التعديلات')}>
                <X size={17} />
              </button>
            )}
          </>
        )}
        <span className="flex-1" />
        {idx >= 0 && ids.length > 1 && (
          <div className="flex items-center gap-1 text-sm text-[#6E6557]">
            <span className="tabular-nums">{idx + 1} / {ids.length}</span>
            <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF]" onClick={() => go(-1)} aria-label={tr('السابق')}><Prev size={16} /></button>
            <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF]" onClick={() => go(1)} aria-label={tr('التالي')}><Next size={16} /></button>
          </div>
        )}
      </div>

      <div className={`grid gap-4 ${chatter ? 'xl:grid-cols-[1fr_22rem]' : ''}`}>
        <div className="card !p-0 overflow-hidden">
          {/* شريط الأزرار والحالة */}
          {(headerActions || statusSteps) && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[#F1EBDF] bg-[#FBF7F0]">
              <div className="flex flex-wrap gap-2">{headerActions}</div>
              <span className="flex-1" />
              {statusSteps && (
                <ol className="flex items-center text-xs" aria-label={tr('الحالة')}>
                  {statusSteps.map((s, i) => (
                    <li key={s.key} className={`px-3 py-1 border border-[#E8E0D2] ${i === 0 ? 'rounded-s-full' : '-ms-px'} ${i === statusSteps.length - 1 ? 'rounded-e-full' : ''} ${s.key === status ? 'bg-[#E15A30] text-white border-[#E15A30] font-semibold' : 'bg-white text-[#6E6557]'}`}
                      aria-current={s.key === status ? 'step' : undefined}>{s.label}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {banner}
          {source && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm bg-[#F1EBDF]/60 border-b border-[#F1EBDF]">
              <span className="text-[#6E6557]">{tr('المصدر')}:</span>
              {source.href ? <Link to={source.href} className="text-[#E15A30] hover:underline inline-flex items-center gap-1">{source.label}<ExternalLink size={12} /></Link> : <span>{source.label}</span>}
              {source.origin === 'AUTO' && onRepostFromSource && canLedger(user, 'canConfigureLedger') && (
                <button type="button" className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1 ms-auto" onClick={onRepostFromSource}>
                  <RotateCcw size={12} />{tr('إعادة الترحيل من المصدر')}
                </button>
              )}
            </div>
          )}
          <div className="p-4 space-y-4">
            {title && <div className="text-2xl font-bold text-[#1F1A13]">{title}</div>}
            {children}
            {tabs && tabs.length > 0 && (
              <div>
                <div className="flex gap-1 border-b border-[#E8E0D2]" role="tablist">
                  {tabs.map(t => (
                    <button key={t.key} type="button" role="tab" aria-selected={activeTab?.key === t.key}
                      className={`px-3 py-2 text-sm -mb-px border-b-2 ${activeTab?.key === t.key ? 'border-[#E15A30] text-[#1F1A13] font-semibold' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'}`}
                      onClick={() => setTab(t.key)}>{t.label}</button>
                  ))}
                </div>
                <div className="pt-3">{activeTab?.content}</div>
              </div>
            )}
          </div>
        </div>

        {chatter && <MoveChatter moveId={chatter.moveId} attachments={chatter.attachments !== false} />}
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.label}
          message={confirm.confirm ?? ''}
          danger={confirm.danger}
          confirmLabel={confirm.label}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); void c.run(); }}
        />
      )}
    </div>
  );
}

/** الملاحظات والتتبّع والمرفقات بجانب النموذج (قيود اليومية). */
function MoveChatter({ moveId, attachments }: { moveId: string; attachments: boolean }) {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [body, setBody] = useState('');
  const canNote = canLedger(user, 'canPostJournals');
  const q = useQuery({
    queryKey: ledgerMoveKeys.notes(moveId),
    queryFn: async () => { const r = (await ledgerMovesApi.notes.list(moveId)).data; return { notes: r.data, tracking: r.tracking ?? [] }; },
    enabled: !!moveId,
  });
  const add = useMutation({
    mutationFn: (text: string) => ledgerMovesApi.notes.create(moveId, text),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ledgerMoveKeys.notes(moveId) }); },
    onError: () => toast.error(tr('تعذر إضافة الملاحظة')),
  });

  const feed = [
    ...(q.data?.notes ?? []).map(n => ({ at: n.createdAt, who: n.authorName, text: n.body, kind: 'note' as const })),
    ...(q.data?.tracking ?? []).map(t => ({ at: t.at, who: t.actorName, text: t.summary, kind: 'track' as const })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <aside className="card space-y-4 h-fit">
      {canNote && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()); }}>
          <p className="flex items-center gap-1.5 text-sm font-semibold"><MessageSquare size={14} />{tr('ملاحظة داخلية')}</p>
          <textarea className="input text-sm min-h-[4rem]" value={body} onChange={e => setBody(e.target.value)} placeholder={tr('اكتب ملاحظة...')} />
          <button type="submit" className="btn-primary !py-1 !px-3 text-xs disabled:opacity-50" disabled={!body.trim() || add.isPending}>{tr('إضافة')}</button>
        </form>
      )}
      {attachments && <AttachmentPane entityType="MOVE" entityId={moveId} />}
      <div className="space-y-2">
        <p className="text-sm font-semibold">{tr('الملاحظات والتتبع')}</p>
        {q.isLoading && <p className="text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
        {!q.isLoading && feed.length === 0 && <p className="text-xs text-[#9A8F7E]">{tr('لا توجد ملاحظات')}</p>}
        <ul className="space-y-2">
          {feed.map((f, i) => (
            <li key={i} className={`text-sm rounded-lg px-2 py-1.5 ${f.kind === 'note' ? 'bg-[#FBF7F0]' : ''}`}>
              <div className="flex items-center gap-2 text-[11px] text-[#9A8F7E]">
                <span className="font-semibold text-[#6E6557]">{f.who ?? tr('النظام')}</span>
                <span>{formatDateTime(f.at)}</span>
              </div>
              <p className={`whitespace-pre-wrap ${f.kind === 'track' ? 'text-[#6E6557] text-xs' : ''}`}>{f.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export default LedgerForm;
