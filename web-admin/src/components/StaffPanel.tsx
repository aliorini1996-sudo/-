import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Check, Copy, Info, KeyRound, Loader2, Lock, LogOut, Pencil, Plus, Power, RefreshCw, ScrollText,
  ShieldAlert, Trash2, UserCog, Users, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { platformStaffApi } from '../api/client';
import { backdropClose } from '../lib/backdropClose';
import { usePlatformAccess } from '../lib/platformAccess';
import { useTr } from '../i18n/strings';
import { formatDateTime } from '../utils/format';

/**
 * «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦) — نافذة المالك وحده: يفتح لكل موظف حساباً ويختار من قدرات لوحته ما يمنحه،
 * ويراجع سجل نشاطهم (ونشاطه الحساس). الإدارة المالية وإدارة الموظفين لا تُمنحان — لا مفتاح لهما في الكتالوج أصلاً.
 *
 * الكتالوج والحماية في الخادم (backend/src/services/platformAccess.ts وroutes/platformStaff.ts)؛ هذه النافذة تعرض وتطلب فقط.
 * كلمة المرور المؤقتة (بعد الإنشاء أو الإعادة) تُعرض هنا مرة واحدة ولا تُحفظ في أي مكان.
 */

interface StaffRow {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  permissions: string[];
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

interface CatalogItem { key: string; group: string; label: string }

interface AuditRow {
  id: string;
  at: string;
  actorType: 'OWNER' | 'STAFF';
  actorId: string;
  actorName: string | null;
  action: string;
  method: string | null;
  path: string | null;
  status: number | null;
  targetId: string | null;
  ip: string | null;
}

/** كلمة مرور مؤقتة تُعرض مرة واحدة */
interface Secret { name: string; email: string; password: string; reset: boolean }

const LOGIN_PATH = '/staff/login';
/** حجم صفحة السجل في الخادم — صفحةٌ أقصر منه هي الأخيرة */
const AUDIT_PAGE = 100;
const STAFF_KEY = ['platform-staff'] as const;
const CATALOG_KEY = ['platform-staff-catalog'] as const;
const AUDIT_KEY = 'platform-staff-audit';

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

const loginLink = () => `${window.location.origin}${LOGIN_PATH}`;

// ───────────────────────────── تبعيات الصلاحيات ─────────────────────────────

/**
 * مفاتيح العرض التي يتطلّبها مفتاح فعل: فعلٌ بلا عرض قسمه لا يُرى زرّه أصلاً في لوحة الموظف.
 * تفعيل الفعل يفعّلها، وإطفاء أيٍّ منها يطفئ الأفعال المعلّقة عليه.
 */
function requiresOf(key: string): string[] {
  if (key.startsWith('tenants.') && key !== 'tenants.view') return ['tenants.view'];
  // الإرسال من جسر واتساب بلا عرض جلسته لا معنى له
  if (key === 'waBridge.send') return ['waBridge.view', 'leads.view'];
  if ((key.startsWith('leads.') || key.startsWith('waBridge.')) && key !== 'leads.view') return ['leads.view'];
  if (key.startsWith('affiliates.') && key !== 'affiliates.view') return ['affiliates.view'];
  if (key === 'payments.manage') return ['payments.view'];
  if (key === 'quotes.delete') return ['quotes.view'];
  if (key === 'live.requests') return ['live.view'];
  return [];
}

function withPermission(cur: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(cur);
  if (on) {
    next.add(key);
    for (const r of requiresOf(key)) next.add(r);
    return next;
  }
  next.delete(key);
  // كل ما فقد أحد متطلّباته يسقط معه — حتى الثبات
  for (let changed = true; changed;) {
    changed = false;
    for (const k of [...next]) {
      if (requiresOf(k).some((r) => !next.has(r))) { next.delete(k); changed = true; }
    }
  }
  return next;
}

/** الكتالوج مجمّعاً بالمجموعة بترتيب الخادم */
function groupCatalog(catalog: CatalogItem[]): Array<{ group: string; items: CatalogItem[] }> {
  const out: Array<{ group: string; items: CatalogItem[] }> = [];
  for (const it of catalog) {
    const g = out.find((x) => x.group === it.group);
    if (g) g.items.push(it); else out.push({ group: it.group, items: [it] });
  }
  return out;
}

// ───────────────────────────── النافذة ─────────────────────────────

export default function StaffPanel({ onClose }: { onClose: () => void }) {
  // للمالك وحده — والخادم يردّ غيره ٤٠٣؛ فلا رسم ولا طلب لغيره
  const { isOwner } = usePlatformAccess();
  if (!isOwner) return null;
  return <StaffPanelBody onClose={onClose} />;
}

type TabKey = 'staff' | 'audit';

function StaffPanelBody({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const [tab, setTab] = useState<TabKey>('staff');
  const [secret, setSecret] = useState<Secret | null>(null);

  const staffQ = useQuery({
    queryKey: STAFF_KEY,
    queryFn: async () => (await platformStaffApi.list()).data.data as StaffRow[],
  });
  const catalogQ = useQuery({
    queryKey: CATALOG_KEY,
    queryFn: async () => (await platformStaffApi.catalog()).data.data as CatalogItem[],
    staleTime: Infinity,
  });

  const tabs: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
    { key: 'staff', label: tr('حسابات الموظفين'), icon: Users },
    { key: 'audit', label: tr('سجل النشاط'), icon: ScrollText },
  ];

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-[#FAF7F0] rounded-2xl w-full max-w-5xl shadow-xl my-4 flex flex-col min-h-[80vh]">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-[#E7DECD] sticky top-0 bg-[#FAF7F0] rounded-t-2xl z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center flex-shrink-0"><UserCog className="w-5 h-5 text-[#E15A30]" /></div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('موظفو المنصة')}</h2>
              <p className="text-[11.5px] text-[#6E6557]">{tr('كل موظف يرى من لوحتك ما تمنحه فقط وكل فعل يسجل باسمه')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 flex-shrink-0" aria-label={tr('إغلاق')}><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="px-3 sm:px-5 pt-3 border-b border-[#E7DECD] overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key} onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold rounded-t-lg border-b-2 -mb-px transition-colors ${
                  tab === key ? 'border-[#E15A30] text-[#E15A30] bg-white' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'
                }`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 sm:p-5 flex-1">
          {tab === 'staff' && (
            <StaffTab
              rows={staffQ.data} loading={staffQ.isLoading} failed={staffQ.isError}
              catalog={catalogQ.data} catalogFailed={catalogQ.isError} onSecret={setSecret}
            />
          )}
          {tab === 'audit' && <AuditTab staff={staffQ.data ?? []} catalog={catalogQ.data ?? []} />}
        </div>
      </div>

      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

// ───────────────────────────── تبويب الموظفين ─────────────────────────────

function StaffTab({ rows, loading, failed, catalog, catalogFailed, onSecret }: {
  rows: StaffRow[] | undefined;
  loading: boolean;
  failed: boolean;
  catalog: CatalogItem[] | undefined;
  catalogFailed: boolean;
  onSecret: (s: Secret) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  // null: مغلق — 'new': موظف جديد — صفّ: تعديله
  const [editing, setEditing] = useState<StaffRow | 'new' | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: STAFF_KEY });
    qc.invalidateQueries({ queryKey: [AUDIT_KEY] });
  };
  const fail = (e: unknown) => toast.error(errMsg(e, tr('تعذر تنفيذ العملية')));

  const toggle = useMutation({
    mutationFn: (s: StaffRow) => platformStaffApi.update(s.id, { isActive: !s.isActive }),
    onSuccess: (_r, s) => { refresh(); toast.success(s.isActive ? tr('تم تعطيل الموظف') : tr('تم تفعيل الموظف')); },
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: (s: StaffRow) => platformStaffApi.resetPassword(s.id),
    onSuccess: (res, s) => { refresh(); onSecret({ name: s.name, email: s.email, password: res.data.data.password, reset: true }); },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (s: StaffRow) => platformStaffApi.revokeSessions(s.id),
    onSuccess: () => { refresh(); toast.success(tr('تم اخراج الموظف من كل الاجهزة')); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (s: StaffRow) => platformStaffApi.remove(s.id),
    onSuccess: () => { refresh(); toast.success(tr('تم حذف الموظف')); },
    onError: fail,
  });

  const busyId = [toggle, reset, revoke, remove].find((m) => m.isPending)?.variables?.id ?? null;

  const askToggle = (s: StaffRow) => {
    if (!s.isActive || window.confirm(`${tr('تعطيل الموظف')}: ${s.name}\n${tr('يخرج من كل الاجهزة فورا ولا يدخل حتى تفعله')}`)) toggle.mutate(s);
  };
  const askReset = (s: StaffRow) => {
    if (window.confirm(`${tr('اعادة كلمة المرور')}: ${s.name}\n${tr('تبطل كلمة مروره الحالية ويخرج من كل الاجهزة ويغير المؤقتة عند دخوله')}`)) reset.mutate(s);
  };
  const askRevoke = (s: StaffRow) => {
    if (window.confirm(`${tr('اخراج من كل الاجهزة')}: ${s.name}\n${tr('تسقط كل جلساته ومعها دخوله الى حسابات الشركات')}`)) revoke.mutate(s);
  };
  const askRemove = (s: StaffRow) => {
    if (window.confirm(`${tr('حذف الموظف نهائيا')}: ${s.name}\n${tr('سطور سجل النشاط تبقى باسمه')}`)) remove.mutate(s);
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(loginLink())
      .then(() => toast.success(tr('تم النسخ')))
      .catch(() => toast.error(tr('تعذر النسخ')));
  };

  const catalogKeys = useMemo(() => new Set((catalog ?? []).map((c) => c.key)), [catalog]);
  const total = catalogKeys.size;
  const now = Date.now();

  return (
    <div className="space-y-4">
      {/* رابط الدخول + ما لا يُمنح */}
      <div className="bg-white border border-[#E9E1D3] rounded-xl p-3 sm:p-4 space-y-2.5">
        <p className="text-[12.5px] text-[#44403a]">{tr('يدخل الموظف من هذا الرابط بالبريد وكلمة المرور المؤقتة ثم يغيرها')}</p>
        <div className="flex items-center gap-2 bg-[#FAF7F0] rounded-xl px-3 py-2 text-[12px]">
          <span className="font-mono text-[#1F1A13] truncate flex-1 text-left" dir="ltr">{loginLink().replace(/^https?:\/\//, '')}</span>
          <button onClick={copyLink} className="p-1.5 rounded-lg hover:bg-white text-[#6E6557]" title={tr('نسخ')} aria-label={tr('نسخ')}><Copy size={14} /></button>
        </div>
        <p className="text-[11.5px] text-[#6E6557] flex items-start gap-1.5">
          <Lock size={13} className="mt-0.5 flex-shrink-0 text-[#9A8F7E]" />
          {tr('الادارة المالية وادارة الموظفين للمالك وحده ولا تمنح لاحد')}
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-[#1F1A13] text-sm">{tr('حسابات الموظفين')}{rows ? ` (${rows.length})` : ''}</h3>
        <button onClick={() => setEditing('new')} disabled={!catalog} className="btn-primary disabled:opacity-60">
          <Plus size={15} /> {tr('اضافة موظف')}
        </button>
      </div>
      {catalogFailed && <p className="text-[12px] text-[#C0392B]">{tr('تعذر تحميل قائمة الصلاحيات')}</p>}

      {loading ? (
        <p className="text-center text-gray-400 py-10">{tr('جار التحميل')}</p>
      ) : failed ? (
        <p className="text-center text-red-500 py-10">{tr('تعذر تحميل الموظفين')}</p>
      ) : !rows || rows.length === 0 ? (
        <p className="text-center text-[#9A8F7E] py-10 text-sm">{tr('لا موظفين بعد — اضف اول موظف وامنحه ما يلزم عمله فقط')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => {
            const locked = !!s.lockedUntil && new Date(s.lockedUntil).getTime() > now;
            const granted = s.permissions.filter((k) => catalogKeys.has(k)).length;
            const busy = busyId === s.id;
            return (
              <li key={s.id} className={`bg-white border border-[#E9E1D3] rounded-xl p-3 sm:p-4 ${busy ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold flex-shrink-0 ${s.isActive ? 'bg-[#FBEBE2] text-[#E15A30]' : 'bg-[#F1EBDF] text-[#9A8F7E]'}`}>
                    {s.name.trim().charAt(0) || '·'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold text-[#1F1A13]">{s.name}</span>
                      {s.isActive ? <span className="badge-active">{tr('نشط')}</span> : <span className="badge-inactive">{tr('معطل')}</span>}
                      {locked && (
                        <span className="badge-blocked gap-1"><Lock size={11} /> {tr('مقفل حتى')} {formatDateTime(s.lockedUntil as string)}</span>
                      )}
                      {s.mustChangePassword && (
                        <span className="badge bg-[#FAEFD8] text-[#B8860B]">{tr('لم يغير كلمة المرور المؤقتة بعد')}</span>
                      )}
                    </div>
                    <div className="text-[12px] text-[#6E6557] mt-0.5 truncate"><span dir="ltr">{s.email}</span></div>
                    <div className="text-[11px] text-[#9A8F7E] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>{tr('اخر دخول')}: {s.lastLoginAt ? formatDateTime(s.lastLoginAt) : tr('لم يدخل بعد')}</span>
                      {s.lastSeenAt && <span>{tr('اخر ظهور')}: {formatDateTime(s.lastSeenAt)}</span>}
                      <span className="tabular-nums">{tr('الصلاحيات')}: {granted} / {total || '—'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {busy && <Loader2 size={15} className="animate-spin text-[#9A8F7E] mx-1" />}
                    <RowAction title={tr('تعديل')} onClick={() => setEditing(s)} disabled={busy || !catalog}><Pencil size={15} /></RowAction>
                    <RowAction title={s.isActive ? tr('تعطيل') : tr('تفعيل')} onClick={() => askToggle(s)} disabled={busy}
                      tone={s.isActive ? 'neutral' : 'good'}><Power size={15} /></RowAction>
                    <RowAction title={tr('اعادة كلمة المرور')} onClick={() => askReset(s)} disabled={busy}><KeyRound size={15} /></RowAction>
                    <RowAction title={tr('اخراج من كل الاجهزة')} onClick={() => askRevoke(s)} disabled={busy}><LogOut size={15} /></RowAction>
                    <RowAction title={tr('حذف')} onClick={() => askRemove(s)} disabled={busy} tone="danger"><Trash2 size={15} /></RowAction>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && catalog && (
        <StaffEditor
          initial={editing === 'new' ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onCreated={(staff, password) => {
            setEditing(null);
            refresh();
            onSecret({ name: staff.name, email: staff.email, password, reset: false });
          }}
          onSaved={() => { setEditing(null); refresh(); toast.success(tr('تم حفظ الموظف')); }}
        />
      )}
    </div>
  );
}

function RowAction({ title, onClick, disabled, tone = 'neutral', children }: {
  title: string; onClick: () => void; disabled?: boolean; tone?: 'neutral' | 'good' | 'danger'; children: React.ReactNode;
}) {
  const color = tone === 'danger' ? 'text-[#C0392B] hover:bg-red-50' : tone === 'good' ? 'text-[#1E7A52] hover:bg-[#E4F1EA]' : 'text-[#6E6557] hover:bg-[#FAF7F0]';
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title}
      className={`p-2 rounded-lg disabled:opacity-40 ${color}`}>
      {children}
    </button>
  );
}

// ───────────────────────────── نموذج الإضافة والتعديل ─────────────────────────────

function StaffEditor({ initial, catalog, onClose, onCreated, onSaved }: {
  initial: StaffRow | null;
  catalog: CatalogItem[];
  onClose: () => void;
  onCreated: (staff: StaffRow, password: string) => void;
  onSaved: () => void;
}) {
  const tr = useTr();
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [perms, setPerms] = useState<Set<string>>(() => new Set(initial?.permissions ?? []));
  const groups = useMemo(() => groupCatalog(catalog), [catalog]);
  const known = useMemo(() => new Set(catalog.map((c) => c.key)), [catalog]);

  const save = useMutation({
    mutationFn: async () => {
      // مفتاحٌ لم يعد في الكتالوج يرفضه الخادم — لا يُرسل
      const permissions = [...perms].filter((k) => known.has(k));
      const body = { name: name.trim(), email: email.trim(), permissions };
      if (initial) { await platformStaffApi.update(initial.id, body); return null; }
      return (await platformStaffApi.create(body)).data.data as { staff: StaffRow; password: string };
    },
    onSuccess: (created) => { if (created) onCreated(created.staff, created.password); else onSaved(); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) { toast.error(tr('الاسم حرفان على الاقل')); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { toast.error(tr('البريد الالكتروني غير صحيح')); return; }
    save.mutate();
  };

  const toggleKey = (key: string, on: boolean) => setPerms((cur) => withPermission(cur, key, on));
  const toggleGroup = (items: CatalogItem[], allOn: boolean) => setPerms((cur) => {
    let next: Set<string> = new Set(cur);
    for (const it of items) next = withPermission(next, it.key, !allOn);
    return next;
  });

  const grantedCount = [...perms].filter((k) => known.has(k)).length;

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" dir="rtl" {...backdropClose(onClose)}>
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-4 flex flex-col">
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2">
            <UserCog size={18} className="text-[#E15A30]" /> {initial ? tr('تعديل الموظف') : tr('اضافة موظف')}
          </h2>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{tr('الاسم')}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" />
            </div>
            <div>
              <label className="label">{tr('البريد الإلكتروني')}</label>
              <input className="input" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" />
            </div>
          </div>
          {!initial && (
            <p className="text-[11.5px] text-[#6E6557] bg-[#FAF7F0] rounded-lg px-3 py-2">
              {tr('تنشأ له كلمة مرور مؤقتة تظهر لك مرة واحدة ويغيرها عند اول دخول')}
            </p>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="label mb-0">{tr('الصلاحيات')}</span>
              <span className="text-[11px] text-[#9A8F7E] tabular-nums">{grantedCount} / {known.size}</span>
            </div>
            {grantedCount === 0 && <p className="text-[11.5px] text-[#9A8F7E] mb-2">{tr('بلا صلاحيات لا يرى الموظف اي قسم')}</p>}

            <div className="space-y-2.5">
              {groups.map(({ group, items }) => {
                const on = items.filter((it) => perms.has(it.key)).length;
                const allOn = on === items.length;
                return (
                  <div key={group} className="border border-[#E9E1D3] rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#FAF7F0]">
                      <span className="font-semibold text-[13px] text-[#1F1A13]">
                        {tr(group)} <span className="text-[11px] font-normal text-[#9A8F7E] tabular-nums">{on} / {items.length}</span>
                      </span>
                      <button type="button" onClick={() => toggleGroup(items, allOn)}
                        className="text-[11.5px] font-semibold text-[#E15A30] hover:text-[#C94E28] px-2 py-0.5 rounded-md hover:bg-white">
                        {allOn ? tr('الغاء الكل') : tr('تحديد الكل')}
                      </button>
                    </div>
                    <div className="divide-y divide-[#F1EBDF]">
                      {items.map((it) => {
                        const checked = perms.has(it.key);
                        return (
                          <div key={it.key} className="px-3 py-2">
                            <label className="flex items-start gap-2.5 cursor-pointer">
                              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#E15A30] flex-shrink-0" checked={checked}
                                onChange={(e) => toggleKey(it.key, e.target.checked)} />
                              <span className="text-[13px] text-[#44403a] leading-snug">{tr(it.label)}</span>
                            </label>
                            {checked && it.key === 'tenants.impersonate' && (
                              <p className="mt-2 text-[11.5px] leading-relaxed text-[#9A3412] bg-[#FDECE4] border border-[#F6C9B5] rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                                <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
                                {tr('الدخول الى حساب الشركة يتجاوز صلاحياتها ويخالف وعد الاتفاقية لا يدخل حسابك الا مديره ما لم تعدلها — داخل الشركة لا ينشئ الموظف حسابات ولا كلمات مرور ولا مفاتيح ربط وكل ما يكتبه يسجل باسمه')}
                              </p>
                            )}
                            {/* نزع «الدخول» يرفع نسخة جلسة الموظف في الخادم (tokenVersion) — فيخرج من كل جلساته لا من دخوله الشركات وحده */}
                            {!checked && it.key === 'tenants.impersonate' && initial?.permissions.includes('tenants.impersonate') && (
                              <p className="mt-2 text-[11.5px] leading-relaxed text-[#6E6557] bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                                <LogOut size={14} className="mt-0.5 flex-shrink-0 text-[#9A8F7E]" />
                                {tr('نزع الدخول يخرج الموظف من كل جلساته عند الحفظ ومنها دخوله الى الشركات فيدخل من جديد')}
                              </p>
                            )}
                            {checked && it.key === 'tenants.resetPassword' && (
                              <p className="mt-2 text-[11.5px] leading-relaxed text-[#6E6557] bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                                <Info size={14} className="mt-0.5 flex-shrink-0 text-[#9A8F7E]" />
                                {tr('ترسل كلمة مرور مؤقتة الى بريد مدير الشركة ولا يراها الموظف')}
                              </p>
                            )}
                            {checked && it.key === 'content.edit' && (
                              <p className="mt-2 text-[11.5px] leading-relaxed text-[#6E6557] bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                                <Info size={14} className="mt-0.5 flex-shrink-0 text-[#9A8F7E]" />
                                {tr('الموظف يكتب نصوصا وروابط فقط بلا اكواد')}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-[11.5px] text-[#6E6557] flex items-start gap-1.5">
              <Lock size={13} className="mt-0.5 flex-shrink-0 text-[#9A8F7E]" />
              {tr('الادارة المالية وادارة الموظفين للمالك وحده ولا تمنح لاحد')}
            </p>
          </div>
        </div>

        <div className="flex gap-3 p-4 sm:p-5 pt-0">
          <button type="submit" disabled={save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            {initial ? tr('حفظ') : tr('انشاء الحساب')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </form>
    </div>
  );
}

// ───────────────────────────── كلمة المرور المؤقتة (مرة واحدة) ─────────────────────────────

/** لا تُغلق بالنقر على الخلفية: إغلاقها يُضيّع كلمة المرور إلى الأبد */
function SecretModal({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const tr = useTr();
  const [copied, setCopied] = useState<'all' | 'pass' | null>(null);
  const copy = (text: string, which: 'all' | 'pass') => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500); })
      .catch(() => toast.error(tr('تعذر النسخ')));
  };
  const all = `${tr('رابط الدخول')}: ${loginLink()}\n${tr('البريد الإلكتروني')}: ${secret.email}\n${tr('كلمة المرور المؤقتة')}: ${secret.password}`;

  return (
    <div className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 text-center border-b border-gray-100">
          <div className="w-14 h-14 bg-[#FBEBE2] rounded-2xl flex items-center justify-center mx-auto mb-3">
            <KeyRound size={26} className="text-[#E15A30]" />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13]">{secret.reset ? tr('كلمة مرور مؤقتة جديدة') : tr('تم انشاء حساب الموظف')}</h2>
          <p className="text-sm text-[#6E6557] mt-1">{secret.name}</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-xs text-[#C94E28] bg-[#FBEBE2] rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span><b>{tr('لن تظهر مرة اخرى')}</b> — {tr('انسخها الان وسلمها للموظف ويغيرها عند اول دخول')}</span>
          </p>
          <SecretRow label={tr('رابط الدخول')} value={loginLink()} />
          <SecretRow label={tr('البريد الإلكتروني')} value={secret.email} />
          <div className="bg-[#FAF7F0] rounded-lg px-3 py-2.5 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[#9A8F7E]">{tr('كلمة المرور المؤقتة')}</p>
              <p className="font-mono font-semibold text-[#1F1A13] text-lg tracking-wide select-all" dir="ltr">{secret.password}</p>
            </div>
            <button type="button" onClick={() => copy(secret.password, 'pass')} className="p-2 rounded-lg hover:bg-white text-[#6E6557]"
              title={tr('نسخ')} aria-label={tr('نسخ')}>
              {copied === 'pass' ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
            </button>
          </div>
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button type="button" onClick={() => copy(all, 'all')} className="btn-secondary flex-1 justify-center">
            {copied === 'all' ? <Check size={15} className="text-green-600" /> : <Copy size={15} />} {tr('نسخ البيانات')}
          </button>
          <button type="button" onClick={onClose} className="btn-primary flex-1 justify-center">{tr('تم')}</button>
        </div>
      </div>
    </div>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#FAF7F0] rounded-lg px-3 py-2.5">
      <p className="text-[11px] text-[#9A8F7E]">{label}</p>
      <p className="font-mono text-[13px] text-[#1F1A13] break-all" dir="ltr">{value}</p>
    </div>
  );
}

// ───────────────────────────── سجل النشاط ─────────────────────────────

type AuditParams = { actorId?: string; actorType?: 'OWNER' | 'STAFF'; from?: string; to?: string; tz?: number };

/** المسار بلا /api ومعرّفاته مختصرة — النص الكامل في التلميح */
const shortPath = (p: string) => p.replace(/^\/api/, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…');

function AuditTab({ staff, catalog }: { staff: StaffRow[]; catalog: CatalogItem[] }) {
  const tr = useTr();
  // '' الكل — OWNER المالك — STAFF كل الموظفين — وإلا معرّف موظف
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const badRange = !!from && !!to && from > to;

  const params = useMemo<AuditParams>(() => {
    const p: AuditParams = {};
    if (actor === 'OWNER' || actor === 'STAFF') p.actorType = actor;
    else if (actor) { p.actorType = 'STAFF'; p.actorId = actor; }
    if (from) p.from = from;
    if (to) p.to = to;
    // أيام المرشّح بتوقيت هذا الجهاز لا بأيام UTC
    if (from || to) p.tz = -new Date().getTimezoneOffset();
    return p;
  }, [actor, from, to]);

  const q = useInfiniteQuery({
    queryKey: [AUDIT_KEY, params],
    // مؤشّر الصفحة التالية: لحظة آخر سطر ومعرّفه (سطران في الملّي ثانية نفسها لا يسقط أحدهما)
    queryFn: async ({ pageParam }) => {
      const [before, beforeId] = pageParam ? pageParam.split('|') : [];
      return (await platformStaffApi.audit({ ...params, ...(before ? { before, beforeId } : {}) })).data.data as AuditRow[];
    },
    initialPageParam: '',
    getNextPageParam: (last: AuditRow[]) => (last.length >= AUDIT_PAGE ? `${last[last.length - 1].at}|${last[last.length - 1].id}` : undefined),
    enabled: !badRange,
  });
  const rows = q.data?.pages.flat() ?? [];

  const labels = useMemo(() => new Map(catalog.map((c) => [c.key, c.label])), [catalog]);
  const staffName = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);

  const actionLabel = (action: string): string => {
    switch (action) {
      case 'staff.login': return tr('دخول الموظف');
      case 'staff.changePassword': return tr('تغيير كلمة المرور');
      case 'staff.create': return tr('اضافة موظف');
      case 'staff.update': return tr('تعديل موظف');
      case 'staff.resetPassword': return tr('اعادة كلمة مرور موظف');
      case 'staff.revokeSessions': return tr('اخراج موظف من كل الاجهزة');
      case 'staff.delete': return tr('حذف موظف');
      case 'tenants.impersonate.write': return tr('كتابة داخل حساب شركة');
      case 'tenants.resetPassword.admin': return tr('ارسال كلمة مرور مؤقتة لمدير الشركة');
      default: {
        const l = labels.get(action);
        return l ? tr(l) : action;
      }
    }
  };

  const statusClass = (s: number) =>
    s < 300 ? 'bg-[#E4F1EA] text-[#1E7A52]' : s < 500 ? 'bg-[#FAEFD8] text-[#B8860B]' : 'bg-[#FBE3DF] text-[#C0392B]';

  return (
    <div className="space-y-3">
      <div className="bg-white border border-[#E9E1D3] rounded-xl p-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label className="label text-[12px]">{tr('الفاعل')}</label>
          <select className="input" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{tr('الكل')}</option>
            <option value="OWNER">{tr('المالك')}</option>
            <option value="STAFF">{tr('كل الموظفين')}</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-[12px]">{tr('من')}</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
        </div>
        <div>
          <label className="label text-[12px]">{tr('إلى')}</label>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
        </div>
        <button type="button" onClick={() => q.refetch()} disabled={q.isFetching || badRange} className="btn-secondary">
          <RefreshCw size={14} className={q.isFetching ? 'animate-spin' : ''} /> {tr('تحديث')}
        </button>
      </div>
      {badRange && <p className="text-[12px] text-[#C0392B]">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}

      {!badRange && (q.isLoading ? (
        <p className="text-center text-gray-400 py-10">{tr('جار التحميل')}</p>
      ) : q.isError ? (
        <p className="text-center text-red-500 py-10">{tr('تعذر تحميل سجل النشاط')}</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-[#9A8F7E] py-10 text-sm">{tr('لا نشاط في هذا النطاق')}</p>
      ) : (
        <div className="bg-white border border-[#E9E1D3] rounded-xl overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-[#FAF7F0] text-[#6E6557] text-[11.5px]">
                <th className="text-start font-semibold px-3 py-2 whitespace-nowrap">{tr('الوقت')}</th>
                <th className="text-start font-semibold px-3 py-2">{tr('الفاعل')}</th>
                <th className="text-start font-semibold px-3 py-2">{tr('الفعل')}</th>
                <th className="text-start font-semibold px-3 py-2">{tr('الطلب')}</th>
                <th className="text-start font-semibold px-3 py-2">{tr('النتيجة')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const target = r.action.startsWith('staff.') && r.targetId ? staffName.get(r.targetId) : undefined;
                return (
                  <tr key={r.id} className="border-t border-[#F1EBDF] align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-[#44403a] tabular-nums">{formatDateTime(r.at)}</td>
                    <td className="px-3 py-2" title={r.ip ?? undefined}>
                      <div className="font-semibold text-[#1F1A13]">{r.actorName || '—'}</div>
                      <span className={`badge mt-0.5 ${r.actorType === 'OWNER' ? 'bg-[#1F1A13] text-[#FAF7F0]' : 'bg-[#FBEBE2] text-[#E15A30]'}`}>
                        {r.actorType === 'OWNER' ? tr('المالك') : tr('موظف')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[#1F1A13] min-w-[160px]">
                      {actionLabel(r.action)}
                      {target && <span className="text-[#9A8F7E]"> — {target}</span>}
                    </td>
                    <td className="px-3 py-2 text-[#6E6557] max-w-[240px]">
                      {r.path ? (
                        <span className="font-mono text-[11px] block truncate" dir="ltr" title={`${r.method ?? ''} ${r.path}`}>
                          {r.method ? `${r.method} ` : ''}{shortPath(r.path)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {r.status == null ? <span className="text-[#9A8F7E]">—</span>
                        : <span className={`badge tabular-nums ${statusClass(r.status)}`}>{r.status}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {!badRange && q.hasNextPage && (
        <div className="text-center">
          <button type="button" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} className="btn-secondary mx-auto">
            {q.isFetchingNextPage && <Loader2 size={14} className="animate-spin" />} {tr('المزيد')}
          </button>
        </div>
      )}
    </div>
  );
}
