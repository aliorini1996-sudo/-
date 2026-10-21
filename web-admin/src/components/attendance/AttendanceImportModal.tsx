import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Upload, Download } from 'lucide-react';
import { attendanceAdminApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { activeLocale } from '../../utils/format';
import { shareOrDownloadExcel } from '../../utils/excel';
import { parseAttendanceSheet, sheetFromFile, IMPORT_MAX_ROWS, TEMPLATE_HEADERS, type ImportRep, type ParsedRow, type DateCode } from '../../lib/attendanceImport';

/**
 * رفع بصمات الحضور من Excel (طلب المالك، ٢١ أكتوبر ٢٠٢٦): قالبٌ بأربعة أعمدة (اسم المستخدم، التاريخ، وقت الحضور، وقت
 * الانصراف)، ومعاينةٌ بكل سطرٍ وخطئه قبل الرفع، وسببٌ إلزامي يُدوَّن في سجلّ التدقيق. الخادم يحكم على كل صفٍّ ويعيد
 * المرفوض برقمه وسببه (تداخلٌ مع بصمةٍ قائمة، مستقبل، مندوبٌ خارج النطاق).
 */
const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

export default function AttendanceImportModal({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const reps = useQuery({
    queryKey: ['attendance-import-reps'],
    queryFn: async () => (await attendanceAdminApi.reps()).data.data as ImportRep[],
  });
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  // تواريخ الملف كلّها بأيامٍ ≤ ١٢ بشرطةٍ مائلة: يوم/شهر أم شهر/يوم؟ قُرئت يوم/شهر ويُنبَّه المستخدم ليتحقق
  const [ambiguousDates, setAmbiguousDates] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; rejected: { line: number; message: string }[] } | null>(null);
  const [error, setError] = useState('');

  const good = (parsed ?? []).filter((r) => !r.error);
  const tooMany = good.length > IMPORT_MAX_ROWS;
  const bad = (parsed ?? []).filter((r) => r.error);
  const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(activeLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : tr('مفتوحة'));

  const template = () => shareOrDownloadExcel([{
    name: tr('البصمات'),
    rows: [Object.fromEntries(TEMPLATE_HEADERS.map((h, i) => [h, ['ahmad', '2026-10-21', '08:00', '17:00'][i]]))],
    colWidths: [18, 14, 12, 12],
  }], tr('قالب رفع البصمات'));

  const onFile = async (file: File | undefined) => {
    setResult(null); setError(''); setParsed(null); setMissing(null); setAmbiguousDates(false);
    if (!file) return;
    setFileName(file.name);
    try {
      const XLSX = await import('xlsx');
      const { matrix, lineOffset } = sheetFromFile(XLSX, await file.arrayBuffer(), file.name);
      const code = (n: number): DateCode => { const c = XLSX.SSF.parse_date_code(n); return c ? { y: c.y, m: c.m, d: c.d, H: c.H, M: c.M } : null; };
      const out = parseAttendanceSheet(matrix, reps.data ?? [], code, { lineOffset });
      if ('missing' in out) setMissing(out.missing); else { setParsed(out.rows); setAmbiguousDates(out.ambiguousDates); }
    } catch { setError(tr('تعذر قراءة الملف')); }
  };

  const upload = async () => {
    if (reason.trim().length < 3) { setError(tr('اكتب سبب الرفع')); return; }
    setBusy(true); setError('');
    try {
      const { data } = await attendanceAdminApi.import({
        reason: reason.trim(),
        rows: good.map((r) => ({ salesRepId: r.salesRepId!, checkInAt: r.checkInAt!, checkOutAt: r.checkOutAt ?? null })),
      });
      const d = data.data as { created: number; rejected: { index: number; message: string }[] };
      setResult({ created: d.created, rejected: d.rejected.map((x) => ({ line: good[x.index]?.line ?? 0, message: x.message })) });
      await qc.invalidateQueries({ queryKey: ['report-work-hours'] });
    } catch (e) { setError(errMsg(e, tr('تعذر الرفع'))); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#E9E1D3]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1A13]">{tr('رفع بصمات من Excel')}</h2>
            <p className="text-xs text-[#9A8F7E] mt-1">{tr('اسم المستخدم والتاريخ ووقت الحضور ووقت الانصراف بتوقيت جهازك')}</p>
          </div>
          <button onClick={onClose} aria-label={tr('إغلاق')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void template()} className="btn-secondary text-xs"><Download size={14} /> {tr('تنزيل القالب')}</button>
            <label className="btn-primary text-xs cursor-pointer">
              <Upload size={14} /> {tr('اختيار ملف')}
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={reps.isLoading || reps.isError}
                onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {fileName && <span className="text-xs text-[#6E6557]" dir="ltr">{fileName}</span>}
          </div>
          <p className="text-[11px] text-[#9A8F7E]">{tr('الانصراف قبل الحضور يعد دواما ليليا ينتهي في اليوم التالي، والانصراف الفارغ فترة مفتوحة، والبصمة التي تتداخل مع بصمة قائمة ترفض')}</p>

          {reps.isError && <p className="text-sm text-red-600">{errMsg(reps.error, tr('تعذر تحميل قائمة المناديب'))}</p>}
          {missing && <p className="text-sm text-red-600">{tr('اعمدة ناقصة في الملف')}: {missing.map((m) => tr(m)).join('، ')}</p>}

          {parsed && (
            <>
              {ambiguousDates && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{tr('تواريخ الملف تحتمل يوم شهر وشهر يوم وقرئت يوم شهر سنة تحقق من التواريخ في المعاينة قبل الرفع')}</p>}
              {tooMany && <p className="text-sm text-red-600">{tr('الحد 2000 بصمة في الرفع الواحد قسم الملف')}</p>}
              <div className="text-sm text-[#6E6557]">
                {tr('صالح للرفع')}: <b className="text-[#1E7A52]">{good.length}</b>
                {bad.length > 0 && <> · {tr('فيه خطأ')}: <b className="text-red-600">{bad.length}</b></>}
              </div>
              <div className="border border-[#E9E1D3] rounded-xl max-h-[38vh] overflow-y-auto">
                <table className="table text-xs">
                  <thead><tr><th>#</th><th>{tr('المندوب')}</th><th>{tr('الحضور')}</th><th>{tr('الانصراف')}</th><th>{tr('الحالة')}</th></tr></thead>
                  <tbody>
                    {parsed.map((r) => (
                      <tr key={r.line} className={r.error ? 'bg-red-50' : ''}>
                        <td className="tabular-nums">{r.line}</td>
                        <td>{r.repName ?? <span dir="ltr">{r.username}</span>}</td>
                        <td dir="ltr">{r.checkInAt ? clock(r.checkInAt) : '—'}</td>
                        <td dir="ltr">{r.checkInAt ? clock(r.checkOutAt) : '—'}</td>
                        <td className={r.error ? 'text-red-600' : 'text-[#1E7A52]'}>{r.error ? tr(r.error) : tr('جاهز')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <label className="label">{tr('سبب الرفع')} *</label>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={tr('مثال كشف حضور شهر اكتوبر من جهاز البصمة')} />
              </div>
            </>
          )}

          {result && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800 space-y-1">
              <p>{tr('رفعت')} <b>{result.created}</b> {tr('بصمة')}</p>
              {result.rejected.map((x, i) => <p key={i} className="text-red-700 text-xs">{tr('السطر')} {x.line}: {x.message}</p>)}
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="p-5 border-t border-[#E9E1D3] flex gap-3">
          <button onClick={upload} disabled={busy || !parsed || good.length === 0 || tooMany || result != null} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Upload size={16} />}
            {' '}{tr('رفع')} {good.length} {tr('بصمة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{result ? tr('تم') : tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
