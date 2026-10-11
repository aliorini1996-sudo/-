import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Copy, Check, ShieldAlert, Ban, BookOpen, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiKeysApi } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { formatDateTime } from '../utils/format';
import { useTr } from '../i18n/strings';
import ApiDocs from '../components/ApiDocs';

interface ApiKeyRow {
  id: string; name: string; prefix: string; readOnly: boolean;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null; active: boolean;
  owner: { id: string; name: string; email: string }; issuedByOwner: boolean;
}
interface ListData { keys: ApiKeyRow[]; ratePerMinute: number; maxActive: number }

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

/**
 * «الربط البرمجي API» — مفاتيح يعمل بها نظام الشركة الخاص على حسابها كما يعمل مديرها في اللوحة
 * (backend/src/services/apiKeys.ts). المفتاح يظهر كاملاً مرة واحدة عند إصداره، ويُلغى بضغطة.
 */
export default function ApiKeysPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeyRow | null>(null);
  const [tab, setTab] = useState<'keys' | 'docs'>('keys');

  const q = useQuery({ queryKey: ['api-keys'], queryFn: async () => (await apiKeysApi.list()).data.data as ListData });
  // الإصدار لمدير الشركة (والخادم يحكم بالدور من القاعدة) — غيره يرى المفاتيح ويلغيها ولا يصدر
  const role = useAuthStore(s => s.user?.role);
  const impersonating = useAuthStore(s => s.impersonating);
  const canIssue = role === 'ADMIN' || !!impersonating;

  const create = useMutation({
    mutationFn: () => apiKeysApi.create({ name: name.trim(), readOnly }),
    onSuccess: (res) => {
      const d = res.data.data as ApiKeyRow & { key: string };
      setFresh({ key: d.key, name: d.name });
      setCopied(false);
      setName(''); setReadOnly(false);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر إصدار المفتاح'))),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: () => { toast.success(tr('تم إلغاء المفتاح')); setConfirmRevoke(null); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر إلغاء المفتاح'))),
  });

  const copyKey = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh.key); setCopied(true); } catch { toast.error(tr('تعذر النسخ انسخه يدويا')); }
  };

  const keys = q.data?.keys ?? [];
  const activeCount = keys.filter(k => k.active).length;

  return (
    <div className="space-y-5" dir="rtl">
      <div>
        <h1 className="text-xl font-bold text-[#1F1A13] flex items-center gap-2"><KeyRound size={22} className="text-[#E15A30]" /> {tr('الربط البرمجي API')}</h1>
        <p className="text-xs text-[#9A8F7E] mt-1">{tr('مفاتيح يعمل بها نظامكم الخاص على بيانات الشركة قراءة وكتابة كما يعمل صاحب المفتاح في لوحة التحكم')}</p>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTab('keys')} className={tab === 'keys' ? 'btn-primary' : 'btn-secondary'}><KeyRound size={16} /> {tr('المفاتيح')}</button>
        <button onClick={() => setTab('docs')} className={tab === 'docs' ? 'btn-primary' : 'btn-secondary'}><BookOpen size={16} /> {tr('مستند API للمبرمج')}</button>
      </div>

      {tab === 'docs' ? <ApiDocs ratePerMinute={q.data?.ratePerMinute ?? 120} /> : (
        <>
          {/* إصدار مفتاح */}
          {canIssue ? <div className="card p-5 space-y-3">
            <h2 className="font-bold text-[#1F1A13] text-sm flex items-center gap-2"><Plus size={16} className="text-[#E15A30]" /> {tr('إصدار مفتاح جديد')}</h2>
            <div className="grid sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
              <div>
                <label className="label">{tr('اسم المفتاح')}</label>
                <input className="input" value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder={tr('مثال نظام المحاسبة الداخلي')} />
              </div>
              <label className="flex items-center gap-2 text-sm text-[#6E6557] cursor-pointer select-none pb-2.5">
                <input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} className="accent-[#E15A30]" />
                {tr('قراءة فقط')}
              </label>
              <button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending || (q.data ? activeCount >= q.data.maxActive : false)}
                className="btn-primary justify-center disabled:opacity-60">
                <KeyRound size={16} /> {tr('إصدار المفتاح')}
              </button>
            </div>
            <p className="text-[11px] text-[#9A8F7E] leading-relaxed">
              {tr('المفتاح يعمل بصلاحياتك أنت فما تستطيعه في اللوحة يستطيعه المفتاح ولا يستطيع إدارة المفاتيح ولا كلمات المرور ولا مستخدمي الشركة')}
            </p>
          </div> : (
            <div className="card p-4 text-sm text-[#6E6557]">{tr('إصدار مفاتيح API لمدير الشركة فقط')}</div>
          )}

          {/* قائمة المفاتيح */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center justify-between gap-2">
              <span>{tr('مفاتيح الشركة')}</span>
              {q.data && <span className="text-[11px] font-normal text-[#9A8F7E]">{activeCount} / {q.data.maxActive} · {q.data.ratePerMinute} {tr('طلب في الدقيقة لكل مفتاح')}</span>}
            </div>
            {q.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
            ) : q.isError ? (
              <div className="p-8 text-center text-red-600 text-sm">{errMsg(q.error, tr('تعذر التحميل'))}</div>
            ) : keys.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد مفاتيح بعد')}</div>
            ) : (
              <div className="divide-y divide-[#F1EBDF]">
                {keys.map(k => (
                  <div key={k.id} className={`px-5 py-3 flex items-center gap-3 flex-wrap ${k.active ? '' : 'opacity-60'}`}>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#1F1A13] text-sm flex items-center gap-2 flex-wrap">
                        {k.name}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${k.readOnly ? 'bg-blue-50 text-blue-700' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>
                          {k.readOnly ? tr('قراءة فقط') : tr('قراءة وكتابة')}
                        </span>
                        {!k.active && <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-gray-100 text-gray-600">{tr('ملغى')}</span>}
                        {/* وعد اتفاقية البيانات: ما يصدره الدعم الفني ظاهرٌ للشركة باسمه */}
                        {k.issuedByOwner && <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-purple-50 text-purple-700">{tr('أصدره الدعم الفني')}</span>}
                      </p>
                      <p className="text-[11px] text-[#9A8F7E] mt-0.5" dir="ltr" style={{ textAlign: 'right' }}>{k.prefix}••••••••</p>
                      <p className="text-[11px] text-[#9A8F7E] mt-0.5">
                        {tr('بصلاحيات')}: {k.owner.name} · {tr('أصدر في')} {formatDateTime(k.createdAt)}
                        {' · '}{k.lastUsedAt ? `${tr('آخر استعمال')} ${formatDateTime(k.lastUsedAt)}` : tr('لم يستعمل بعد')}
                        {k.revokedAt && ` · ${tr('ألغي في')} ${formatDateTime(k.revokedAt)}`}
                      </p>
                    </div>
                    {k.active && (
                      <button onClick={() => setConfirmRevoke(k)} className="btn-secondary text-red-600"><Ban size={15} /> {tr('إلغاء المفتاح')}</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* المفتاح الجديد — يظهر مرة واحدة */}
      {fresh && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5 space-y-4">
            <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><KeyRound size={20} className="text-[#E15A30]" /> {tr('المفتاح الجديد')} — {fresh.name}</h2>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800 flex gap-2">
              <ShieldAlert size={16} className="shrink-0" />
              <span>{tr('انسخ المفتاح الآن واحفظه في مكان آمن لن يظهر مرة أخرى ومن يملكه يعمل على بيانات شركتك')}</span>
            </div>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="flex-1 min-w-0 break-all text-xs bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5 font-mono select-all">{fresh.key}</code>
              <button onClick={copyKey} className="btn-secondary shrink-0">{copied ? <Check size={16} className="text-[#1E7A52]" /> : <Copy size={16} />} {copied ? tr('تم النسخ') : tr('نسخ')}</button>
            </div>
            <button onClick={() => setFresh(null)} className="btn-primary w-full justify-center py-2.5"><Eye size={16} /> {tr('نسخته وحفظته')}</button>
          </div>
        </div>
      )}

      {/* تأكيد الإلغاء */}
      {confirmRevoke && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-4">
            <h2 className="text-lg font-bold text-[#1F1A13]">{tr('إلغاء المفتاح')} — {confirmRevoke.name}</h2>
            <p className="text-sm text-[#6E6557]">{tr('سيتوقف كل نظام يستعمل هذا المفتاح فورا ولا يمكن التراجع')}</p>
            <div className="flex gap-3">
              <button onClick={() => revoke.mutate(confirmRevoke.id)} disabled={revoke.isPending} className="btn-danger flex-1 justify-center disabled:opacity-60"><Ban size={16} /> {tr('إلغاء المفتاح')}</button>
              <button onClick={() => setConfirmRevoke(null)} className="btn-secondary">{tr('تراجع')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
