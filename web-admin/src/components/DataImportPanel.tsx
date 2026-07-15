import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { importApi } from '../api/client';
import { parseExcelFile, IMPORT_TYPES, ImportKind } from '../lib/importData';
import { useTr } from '../i18n/strings';
import { formatDate } from '../utils/format';
import ConfirmDialog from './ConfirmDialog';
import { Users, Package, Wallet, BookOpen, Tags, Upload, X, Check, AlertTriangle, Loader2, FileUp, RotateCcw, Clock } from 'lucide-react';
import toast from 'react-hot-toast';

type Rows = Record<string, unknown>[];
interface Preview { kind: ImportKind; fileName: string; valid: Rows; errors: { row: number; message: string }[] }
interface ImportResult { created: number; skipped: number; total: number; errors: { row: number; message: string }[] }
interface Batch { id: string; kind: string; count: number; createdBy?: string | null; createdAt: string }

// قسم استيراد بيانات الشركة السابقة — أيقونة رفع لكل نوع بيانات (في إعدادات الشركة)
export default function DataImportPanel() {
  const tr = useTr();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<ImportKind | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{ kind: ImportKind; res: ImportResult } | null>(null);
  const [revertId, setRevertId] = useState<string | null>(null);

  const { data: batches } = useQuery({
    queryKey: ['import-batches'],
    queryFn: async () => (await importApi.batches()).data.data as Batch[],
  });
  const revertMut = useMutation({
    mutationFn: (id: string) => importApi.revert(id),
    onSuccess: (res) => {
      const d = res.data.data as { removed: number; blocked: number };
      toast.success(`${tr('تمت الإزالة')}: ${d.removed}${d.blocked ? ` · ${tr('محميّ (له معاملات)')}: ${d.blocked}` : ''}`);
      qc.invalidateQueries({ queryKey: ['import-batches'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      setRevertId(null);
    },
    onError: (e) => { toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر التراجع')); setRevertId(null); },
  });

  const onFile = async (kind: ImportKind, file?: File) => {
    if (!file) return;
    setBusy(kind); setResult(null);
    try {
      const rows = await parseExcelFile(file);
      if (!rows.length) { toast.error(tr('الملف فارغ أو بلا صفوف بيانات')); setBusy(null); return; }
      const { valid, errors } = IMPORT_TYPES[kind].transform(rows);
      setPreview({ kind, fileName: file.name, valid, errors });
    } catch { toast.error(tr('تعذّر قراءة الملف — تأكّد أنه Excel/CSV صالح')); }
    setBusy(null);
  };

  const doImport = async () => {
    if (!preview) return;
    const kind = preview.kind;
    setBusy(kind);
    try {
      const res = await importApi.run(IMPORT_TYPES[kind].endpoint, preview.valid);
      setResult({ kind, res: res.data.data as ImportResult });
      setPreview(null);
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['import-batches'] });
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الاستيراد'));
    }
    setBusy(null);
  };

  const active: { kind: ImportKind; icon: React.ElementType }[] = [
    { kind: 'customers', icon: Users },
    { kind: 'products', icon: Package },
    { kind: 'balances', icon: Wallet },
    { kind: 'ledger', icon: BookOpen },
    { kind: 'prices', icon: Tags },
  ];

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center"><FileUp size={20} className="text-[#E15A30]" /></div>
        <div>
          <h3 className="font-bold text-gray-800">{tr('استيراد البيانات من نظامك السابق')}</h3>
          <p className="text-xs text-gray-500">{tr('ارفع ملف Excel مُصدَّراً من نظامك السابق (بأي تنسيق) — يفهم النظام الأعمدة تلقائياً ويضيف البيانات مباشرةً، بلا قالب ولا إدخال يدوي.')}</p>
        </div>
      </div>
      <p className="text-[11px] text-amber-700 bg-amber-50/70 border border-amber-100 rounded-lg px-3 py-2 mt-3">
        {tr('الترتيب المُوصى به: العملاء والمنتجات أولاً، ثم الأرصدة الافتتاحية أو دفتر الأستاذ، ثم قوائم الأسعار (لأنها تربط بالعملاء والأصناف بالكود أو الجوال).')}
      </p>

      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        {active.map(({ kind, icon: Icon }) => (
          <div key={kind} className="border border-[#E9E1D3] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Icon size={18} className="text-[#E15A30]" />
              <span className="font-semibold text-gray-800">{tr(IMPORT_TYPES[kind].label)}</span>
            </div>
            <label className={`btn-primary w-full justify-center text-xs py-2 cursor-pointer ${busy === kind ? 'opacity-60 pointer-events-none' : ''}`}>
              {busy === kind ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {tr('رفع الملف')}
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={(e) => { onFile(kind, e.target.files?.[0]); e.currentTarget.value = ''; }} />
            </label>
          </div>
        ))}
      </div>

      {/* سجلّ الاستيرادات — تراجع/إزالة أي دفعة بها مشكلة */}
      {batches && batches.length > 0 && (
        <div className="mt-5 border-t border-[#E9E1D3] pt-4">
          <h4 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2"><Clock size={15} className="text-[#E15A30]" /> {tr('سجلّ الاستيرادات (يمكن التراجع عن أيّ دفعة)')}</h4>
          <div className="space-y-2">
            {batches.map((b) => (
              <div key={b.id} className="flex items-center justify-between bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold text-gray-800">{tr(IMPORT_TYPES[b.kind as ImportKind]?.label || b.kind)}</span>
                  <span className="text-gray-500 text-xs mr-2">· {b.count} {tr('سجل')} · {formatDate(b.createdAt)}{b.createdBy ? ` · ${b.createdBy}` : ''}</span>
                </div>
                <button onClick={() => setRevertId(b.id)} disabled={revertMut.isPending}
                  className="text-red-600 hover:bg-red-50 rounded-lg px-2.5 py-1 text-xs flex items-center gap-1 shrink-0">
                  <RotateCcw size={13} /> {tr('تراجع / إزالة')}
                </button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-2">{tr('التراجع يزيل ما أُضيف في تلك الدفعة ويعيد حساب الأرصدة، ولا يحذف العملاء الذين لديهم فواتير أو سندات حقيقية.')}</p>
        </div>
      )}

      {revertId && (
        <ConfirmDialog
          danger
          title={tr('التراجع عن الاستيراد')}
          message={tr('سيُزال ما أُضيف في هذه الدفعة نهائياً وتُعاد الأرصدة إلى ما قبلها. متابعة؟')}
          confirmLabel={tr('نعم، أزِل')}
          loading={revertMut.isPending}
          onConfirm={() => revertMut.mutate(revertId)}
          onClose={() => setRevertId(null)}
        />
      )}

      {/* معاينة قبل الاستيراد */}
      {preview && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
              <h3 className="font-bold text-gray-800">{tr('معاينة الاستيراد')} — {tr(IMPORT_TYPES[preview.kind].label)}</h3>
              <button onClick={() => setPreview(null)} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">{tr('الملف')}: <span className="font-mono">{preview.fileName}</span></p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-green-700">{preview.valid.length}</p>
                  <p className="text-xs text-green-600">{tr('صفّ صالح للاستيراد')}</p>
                </div>
                <div className={`rounded-xl p-3 text-center ${preview.errors.length ? 'bg-amber-50' : 'bg-gray-50'}`}>
                  <p className={`text-2xl font-bold ${preview.errors.length ? 'text-amber-700' : 'text-gray-400'}`}>{preview.errors.length}</p>
                  <p className="text-xs text-gray-500">{tr('صفّ به خطأ (يُتجاهَل)')}</p>
                </div>
              </div>
              {preview.errors.length > 0 && (
                <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 max-h-40 overflow-y-auto">
                  <p className="text-xs font-semibold text-amber-800 flex items-center gap-1 mb-2"><AlertTriangle size={13} /> {tr('صفوف بها أخطاء')}</p>
                  {preview.errors.slice(0, 20).map((er, i) => (
                    <p key={i} className="text-[11px] text-amber-700">{tr('صفّ')} {er.row}: {tr(er.message)}</p>
                  ))}
                  {preview.errors.length > 20 && <p className="text-[11px] text-amber-600 mt-1">+{preview.errors.length - 20} …</p>}
                </div>
              )}
              <div className="flex gap-3 pt-1">
                <button onClick={doImport} disabled={busy !== null || preview.valid.length === 0}
                  className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-50">
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {tr('استيراد')} {preview.valid.length} {tr('صفّ')}
                </button>
                <button onClick={() => setPreview(null)} className="btn-secondary">{tr('إلغاء')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* نتيجة الاستيراد */}
      {result && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={() => setResult(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 text-center">
              <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-3"><Check size={30} className="text-green-600" /></div>
              <h3 className="font-bold text-gray-800 mb-1">{tr('تم الاستيراد')} — {tr(IMPORT_TYPES[result.kind].label)}</h3>
              <div className="flex justify-center gap-6 mt-4 text-sm">
                <div><p className="text-xl font-bold text-green-700">{result.res.created}</p><p className="text-xs text-gray-500">{tr('أُضيف')}</p></div>
                <div><p className="text-xl font-bold text-gray-500">{result.res.skipped}</p><p className="text-xs text-gray-500">{tr('مكرّر (تُخطّي)')}</p></div>
                <div><p className="text-xl font-bold text-amber-600">{result.res.errors.length}</p><p className="text-xs text-gray-500">{tr('خطأ')}</p></div>
              </div>
              {result.res.errors.length > 0 && (
                <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-3 mt-4 max-h-32 overflow-y-auto text-right">
                  {result.res.errors.slice(0, 15).map((er, i) => (
                    <p key={i} className="text-[11px] text-amber-700">{tr('صفّ')} {er.row}: {er.message}</p>
                  ))}
                </div>
              )}
              <button onClick={() => setResult(null)} className="btn-primary w-full justify-center py-2.5 mt-5">{tr('تم')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
