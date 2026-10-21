import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Trash2, Plus, Save, MapPin } from 'lucide-react';
import { attendanceAdminApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { activeLocale } from '../../utils/format';
import { mapsUrl } from '../../lib/workPeriods';

/**
 * تعديل بصمات يومٍ لمندوب (طلب المالك، ٢١ أكتوبر ٢٠٢٦): إغلاق نوبةٍ نسي انصرافها على وقتها الحقيقي، أو تصحيح وقت،
 * أو حذف بصمةٍ مكرّرة، أو إضافة فترةٍ لم يبصمها. كل عمليةٍ بسببٍ مكتوب، والخادم يرفض المستقبل والتداخل وما فوق
 * ٢٤ ساعة، ويدوّن كل شيءٍ في سجلّ التدقيق المعروض أسفل النافذة.
 */
interface AttRow {
  id: string; checkInAt: string; checkOutAt: string | null;
  checkInLat: number | null; checkInLng: number | null; checkOutLat: number | null; checkOutLng: number | null;
  checkInDevice: string | null; checkOutDevice: string | null;
  checkInOutside: boolean | null; checkInDistanceM: number | null; checkOutOutside: boolean | null; checkOutDistanceM: number | null;
  source: string; editedAt: string | null; editedBy: string | null;
}
interface AuditRow {
  id: string; action: string; reason: string | null; actorName: string | null; createdAt: string;
  before: { checkInAt?: string; checkOutAt?: string | null; deviceName?: string | null } | null;
  after: { checkInAt?: string; checkOutAt?: string | null; count?: number } | null;
}

/** ISO ⇒ قيمة datetime-local بتوقيت المتصفّح */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** قيمة datetime-local (توقيت المتصفّح) ⇒ ISO، أو null لفارغ */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

export default function AttendanceEditModal({ rep, date, onClose }: { rep: { id: string; name: string }; date: string; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const tz = -new Date().getTimezoneOffset();
  const key = ['attendance-admin-rows', rep.id, date];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => (await attendanceAdminApi.rows({ salesRepId: rep.id, from: date, to: date, tz })).data.data as { rows: AttRow[]; audit: AuditRow[] },
  });
  const [reason, setReason] = useState('');
  // الحقول التي لمسها المدير وحدها: غير الملموس يُرسل من الصفّ الحالي (قد يتغيّر بإعادة الجلب — انصرف المندوب في الأثناء)
  const [edits, setEdits] = useState<Record<string, { in?: string; out?: string }>>({});
  const [draft, setDraft] = useState<{ in: string; out: string }>({ in: `${date}T08:00`, out: `${date}T17:00` });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const reasonOk = reason.trim().length >= 3;

  const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleString(activeLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : tr('مفتوحة'));
  const refresh = async () => {
    setEdits({});
    await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['report-work-hours'] })]);
  };
  const run = async (id: string, fn: () => Promise<unknown>) => {
    if (!reasonOk) { setError(tr('اكتب سبب التعديل اولا')); return; }
    setBusy(id); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(errMsg(e, tr('تعذر الحفظ'))); }
    setBusy(null);
  };

  const rows = q.data?.rows ?? [];
  const audit = q.data?.audit ?? [];
  const valueOf = (r: AttRow) => ({ in: edits[r.id]?.in ?? toLocalInput(r.checkInAt), out: edits[r.id]?.out ?? toLocalInput(r.checkOutAt) });
  const touchedIn = (r: AttRow) => edits[r.id]?.in !== undefined && edits[r.id]?.in !== toLocalInput(r.checkInAt);
  const touchedOut = (r: AttRow) => edits[r.id]?.out !== undefined && edits[r.id]?.out !== toLocalInput(r.checkOutAt);
  // الحقل الذي لم يُلمس يُرسل بقيمته كما هي: الإدخال يقصّ الثواني، فحضورٌ 13:00:50 يصير 13:00:00 فيتداخل مع انصرافٍ
  // سابق 13:00:30 (409 لا يفهمه المدير) ويُدوَّن في التدقيق تعديلٌ لم يقع
  const keptOrEdited = (r: AttRow) => ({
    checkInAt: touchedIn(r) ? fromLocalInput(edits[r.id]!.in!) ?? '' : r.checkInAt,
    checkOutAt: touchedOut(r) ? fromLocalInput(edits[r.id]!.out!) : r.checkOutAt ?? null,
  });
  const changed = (r: AttRow) => touchedIn(r) || touchedOut(r);
  const placeTag = (outside: boolean | null, dist: number | null) => outside == null ? null
    : <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${outside ? 'bg-amber-100 text-amber-800' : 'bg-green-50 text-green-700'}`}>
        {outside ? tr('خارج النطاق') : tr('داخل النطاق')}{dist != null ? ` · ${dist} ${tr('م')}` : ''}
      </span>;
  const actionLabel = (a: string) => a === 'CREATE' ? tr('إضافة') : a === 'UPDATE' ? tr('تعديل') : a === 'DELETE' ? tr('حذف')
    : a === 'IMPORT' ? tr('رفع من Excel') : a === 'UNBIND_DEVICE' ? tr('فك ربط الجهاز') : a;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#E9E1D3]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1A13]">{tr('تعديل بصمات الحضور')}</h2>
            <p className="text-xs text-[#9A8F7E] mt-1">{rep.name} · <span dir="ltr">{date}</span></p>
          </div>
          <button onClick={onClose} aria-label={tr('إغلاق')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">{tr('سبب التعديل')} *</label>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
              placeholder={tr('مثال نسي تسجيل الانصراف وانصرف الساعة الخامسة')} />
            <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('كل تعديل يسجل باسمك وسببه وقيمه قبل وبعد في سجل التدقيق')}</p>
          </div>

          {q.isLoading ? <p className="text-sm text-gray-400 text-center py-6">{tr('جاري التحميل')}</p>
            : q.isError ? <p className="text-sm text-red-600 text-center py-6">{errMsg(q.error, tr('تعذر التحميل'))}</p>
            : (
              <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]">
                {rows.length === 0 && <p className="p-5 text-center text-sm text-gray-400">{tr('لا بصمات في هذا اليوم')}</p>}
                {rows.map((r) => {
                  const v = valueOf(r);
                  const inUrl = mapsUrl(r.checkInLat, r.checkInLng);
                  const outUrl = r.checkOutAt ? mapsUrl(r.checkOutLat, r.checkOutLng) : null;
                  return (
                    <div key={r.id} className="p-3 space-y-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="text-xs text-[#6E6557]">{tr('الحضور')}
                          <input type="datetime-local" dir="ltr" className="input py-1.5 mt-1" value={v.in}
                            onChange={(e) => setEdits((m) => ({ ...m, [r.id]: { ...m[r.id], in: e.target.value } }))} />
                        </label>
                        <label className="text-xs text-[#6E6557]">{tr('الانصراف')}
                          <input type="datetime-local" dir="ltr" className="input py-1.5 mt-1" value={v.out}
                            onChange={(e) => setEdits((m) => ({ ...m, [r.id]: { ...m[r.id], out: e.target.value } }))} />
                        </label>
                        <div className="flex gap-1 ms-auto">
                          {changed(r) && (
                            <button onClick={() => run(r.id, () => attendanceAdminApi.update(r.id, { ...keptOrEdited(r), reason: reason.trim() }))}
                              disabled={busy !== null} className="btn-primary py-1.5 px-3 text-xs disabled:opacity-50"><Save size={14} /> {tr('حفظ')}</button>
                          )}
                          <button onClick={() => { if (window.confirm(tr('حذف هذه البصمة نهائيا مع بقائها في سجل التدقيق'))) void run(r.id, () => attendanceAdminApi.remove(r.id, reason.trim())); }}
                            disabled={busy !== null} className="p-2 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50" title={tr('حذف')}><Trash2 size={15} /></button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#6E6557]">
                        {inUrl && <a href={inUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:underline"><MapPin size={11} /> {tr('موقع الحضور')}</a>}
                        {placeTag(r.checkInOutside, r.checkInDistanceM)}
                        {r.checkInDevice && <span>{tr('جهاز الحضور')}: <b dir="ltr">{r.checkInDevice}</b></span>}
                        {outUrl && <a href={outUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:underline"><MapPin size={11} /> {tr('موقع الانصراف')}</a>}
                        {placeTag(r.checkOutOutside, r.checkOutDistanceM)}
                        {r.checkOutDevice && r.checkOutDevice !== r.checkInDevice && <span>{tr('جهاز الانصراف')}: <b dir="ltr">{r.checkOutDevice}</b></span>}
                        {r.source !== 'APP' && <span className="rounded bg-blue-50 text-blue-700 px-1.5 py-0.5 font-bold">{r.source === 'IMPORT' ? tr('مرفوعة من Excel') : tr('إدخال إداري')}</span>}
                        {r.editedBy && <span>{tr('آخر تعديل')}: {r.editedBy}{r.editedAt ? ` · ${clock(r.editedAt)}` : ''}</span>}
                      </div>
                    </div>
                  );
                })}
                <div className="p-3 bg-[#FAF7F0] flex flex-wrap items-end gap-2">
                  <span className="text-xs font-bold text-[#1F1A13] w-full">{tr('إضافة فترة')}</span>
                  <label className="text-xs text-[#6E6557]">{tr('الحضور')}
                    <input type="datetime-local" dir="ltr" className="input py-1.5 mt-1" value={draft.in} onChange={(e) => setDraft((d) => ({ ...d, in: e.target.value }))} />
                  </label>
                  <label className="text-xs text-[#6E6557]">{tr('الانصراف')}
                    <input type="datetime-local" dir="ltr" className="input py-1.5 mt-1" value={draft.out} onChange={(e) => setDraft((d) => ({ ...d, out: e.target.value }))} />
                  </label>
                  <button onClick={() => run('new', () => attendanceAdminApi.create({ salesRepId: rep.id, checkInAt: fromLocalInput(draft.in) ?? '', checkOutAt: fromLocalInput(draft.out), reason: reason.trim() }))}
                    disabled={busy !== null || !draft.in} className="btn-secondary py-1.5 px-3 text-xs ms-auto disabled:opacity-50"><Plus size={14} /> {tr('إضافة')}</button>
                </div>
              </div>
            )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          {audit.length > 0 && (
            <div>
              <h3 className="text-xs font-bold text-[#6E6557] mb-2">{tr('سجل التدقيق')}</h3>
              <ul className="space-y-1.5 text-[11px] text-[#6E6557]">
                {audit.map((a) => (
                  <li key={a.id} className="rounded-lg bg-[#FAF7F0] px-3 py-2">
                    <b className="text-[#1F1A13]">{actionLabel(a.action)}</b> · {a.actorName || '—'} · {clock(a.createdAt)}
                    {a.before?.checkInAt && <> · {tr('قبل')}: <span dir="ltr">{clock(a.before.checkInAt)} – {clock(a.before.checkOutAt ?? null)}</span></>}
                    {a.after?.checkInAt && <> · {tr('بعد')}: <span dir="ltr">{clock(a.after.checkInAt)} – {clock(a.after.checkOutAt ?? null)}</span></>}
                    {a.after?.count != null && <> · {a.after.count} {tr('بصمة')}</>}
                    {a.before?.deviceName && <> · <span dir="ltr">{a.before.deviceName}</span></>}
                    {a.reason && <div className="text-[#9A8F7E]">{tr('السبب')}: {a.reason}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
