import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, FileDown, Search, X, Truck, Save, Ban } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { repStockRequestApi } from '../api/client';
import { formatDateTime } from '../utils/format';
import DocumentModal from './DocumentModal';
import type { Company, StockRequestDoc } from '../rep/RepDocuments';
import {
  stockRequestLines, stockRequestTotalText, stockRequestRef, stockRequestToLabel, isInvalidRequestQty, isShort,
  repItemQty, repRequestDirty, repRequestTotals, withRequestedProducts, requestedFirst, parseRequestQty,
  requestUnitOf, defaultRequestUnit, prefillInUnit, repLineUnitId, repItemUnit, repEditItems, convertRepQty, isStaleUnitsError,
  type StockRequestTo, type StockRequestSourceRow, type RepStockRequest, type RepRequestItem, type RepUnitEdits,
} from '../lib/stockRequest';
import { baseQtyText, hasBigUnit, productUnitLabel } from '../lib/adminUnits';
import { unitChoices } from '../rep/repUnits';
import { primaryUnitOf } from '../lib/units';

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');
/** قيمة خيار «وحدة سطر المندوب كما هي» في المنتقي — وحدةٌ لم تعد بين النشطة (أُوقفت أو تغيّر معاملها) */
const LINE_UNIT = '__line';
/** معامل وحدة سطر المندوب كما في لقطته */
const factorText = (i: RepRequestItem) => String(Number(i.unitFactor ?? 1) || 1);
const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

/** اليوم بتوقيت الجهاز YYYY-MM-DD — حدٌّ أدنى لخانة «مطلوب قبل» */
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * طلب مخزون من صفحة مخزون الشركة: يكتب المسؤول الكمية المطلوبة أمام كل صنف ويختار
 * الجهة، ثم يصدر ورقة PDF يرسلها لإدارة المشتريات أو الإنتاج — انظر `lib/stockRequest.ts`.
 *
 * وفي أسفلها «طلبات المناديب» المعلّقة (من «طلب بضاعة» في تطبيق المندوب): يعدّل الإداري
 * الكمية المعتمدة لكل مندوب، ومجموع المشمول منها يملأ مبدئياً خانة كل صنف في الطلب العام
 * ما لم يكتب فيها بنفسه. والإصدار يحفظ التعديلات ثم يعلّم المشمولة «أُرسلت» في الخادم.
 *
 * والورقة تُفتح فوق النموذج لا مكانه: «تم» تعيد إلى الكميات كما كُتبت — إلا بعد إرسال
 * طلبات مناديب، فحينها تُغلق النافذة كلها: ما أُرسل لا يُعاد إرساله.
 *
 * الوحدات المتعددة: الرصيد بالأساس مفكَّكاً، والطلب العام لكل صنف بوحدةٍ تُختار (الأكبر افتراضاً) — ومجموع المناديب
 * بالأساس يُعبَّر عنه بها. وبند المندوب بوحدة سطره، ويختار الإداري له وحدةً أخرى إن شاء: تبديلها يحفظ الكمية نفسها
 * («٢ كرتون» ⇒ «٤٨ حبة»)، والحفظ يرسل `unitId` حين تغيّرت وحدها (غيابه = وحدة السطر، null = الأساس).
 *
 * «الوحدة الرئيسية» (القاعدة ١٢): لصنفٍ لها الرصيد ومجموع المناديب بها («52 كرتون و2 قارورة»)، ووسمه «الوحدة الرئيسية
 * كرتون (24 قارورة)» بلا كلمة «الأساس» (D21)، والطلب العام بها افتراضاً (defaultRequestUnit)، ورقاقتها موسومة «رئيسية».
 * وحفظ التعديل يحمل `baseUnitName` (repEditItems): ردّ «وحدات الصنف تغيّرت» يُسقط تعديلات ذلك الطلب ويعيد جلبه.
 * صنفٌ بلا رئيسية: كل نصٍّ كما كان حرفاً (I1).
 */
export default function StockRequestModal({ rows, company, by, onClose }: {
  rows: StockRequestSourceRow[]; company: Company | null; by?: string; onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [to, setTo] = useState<StockRequestTo>('PURCHASING');
  const [neededBy, setNeededBy] = useState('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [shortOnly, setShortOnly] = useState(false);
  const [doc, setDoc] = useState<StockRequestDoc | null>(null);
  const [sent, setSent] = useState(false);

  // طلبات المناديب المعلّقة، وتعديلات الإداري عليها قبل الحفظ، والمستبعَد من هذا الإرسال
  const reqQ = useQuery({
    queryKey: ['rep-stock-requests'],
    queryFn: async () => (await repStockRequestApi.pending()).data.data as RepStockRequest[],
  });
  const reqs = useMemo(() => reqQ.data ?? [], [reqQ.data]);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  // وحدة بنود المناديب التي بدّلها الإداري (غيابها = وحدة سطر المندوب، null = الأساس)
  const [unitEdits, setUnitEdits] = useState<RepUnitEdits>({});
  // وحدة الطلب العام لكل صنف اختارها الإداري — غيابها ⇒ defaultRequestUnit (الأكبر، أو ما ينقسم عليه مجموع المناديب)
  const [reqUnit, setReqUnit] = useState<Record<string, string | null>>({});
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null); // 'send' أو معرّف الطلب الجاري حفظه/رفضه
  const [error, setError] = useState('');

  const included = reqs.filter(r => !excluded[r.id]);
  // بالأساس: «٥ كرتون» من مندوب و«٣ حبة» من آخر = ١٢٣ حبة، لا «٨»
  const repSum = repRequestTotals(included, edits, unitEdits);
  // ما طلبوه أصلاً — يثبّت الترتيب فلا يقفز الصنف حين يُصفّر الإداري كميّته
  const requested = useMemo(() => new Set(reqs.flatMap(r => r.items.filter(i => i.requestedQty > 0).map(i => i.productId))), [reqs]);
  const ordered = useMemo(() => requestedFirst(withRequestedProducts(rows, reqs), requested), [rows, reqs, requested]);

  // وحدة الطلب العام لكل صنف — المختارة، وإلا الافتراضية من مجموع مناديبه
  const unitById: Record<string, string | null> = {};
  for (const r of ordered) unitById[r.productId] = r.productId in reqUnit ? reqUnit[r.productId] : defaultRequestUnit(r, repSum.get(r.productId) ?? 0);
  const unitOfRow = (r: StockRequestSourceRow) => requestUnitOf(r, unitById[r.productId] ?? null);

  // خانة الصنف: ما كتبه الإداري، وإلا مجموع المناديب المشمولين **بوحدة الطلب** (المجموع بالأساس ÷ معاملها)
  const effective: Record<string, string> = {};
  for (const r of ordered) {
    const base = repSum.get(r.productId);
    if (base != null) { const c = unitOfRow(r); effective[r.productId] = prefillInUnit(base, c.id ? c.factor : 1); }
  }
  Object.assign(effective, qty);

  const q = search.trim().toLowerCase();
  const visible = ordered.filter(r => (!shortOnly || isShort(r))
    && (!q || r.name.toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q)));
  // الأسطر من كل الأصناف لا المعروضة وحدها: البحث يُخفي صنفاً من الشاشة لا من الطلب
  const lines = stockRequestLines(ordered, effective, unitById);
  const anyInvalid = Object.values(qty).some(isInvalidRequestQty)
    || included.some(r => Object.values(edits[r.id] ?? {}).some(isInvalidRequestQty));

  const setEdit = (reqId: string, pid: string, v: string) => setEdits(m => ({ ...m, [reqId]: { ...m[reqId], [pid]: v } }));
  const dropEdits = (reqId: string) => {
    setEdits(m => { const n = { ...m }; delete n[reqId]; return n; });
    setUnitEdits(m => { const n = { ...m }; delete n[reqId]; return n; });
  };
  /**
   * تبديل وحدة بند مندوب: الكمية نفسها بالأساس تُعبَّر بالوحدة الجديدة (لا الرقم نفسه بوحدةٍ أخرى — «٢ حبة» بدل «٢
   * كرتون» خطأٌ صامت ٢٤ ضعفاً). و`LINE_UNIT` يعيد البند إلى وحدة سطره كما هي.
   */
  const setItemUnit = (r: RepStockRequest, i: RepRequestItem, value: string) => {
    const cur = unitEdits[r.id]?.[i.productId];
    const from = repItemUnit(i, cur).factor;
    const next = value === LINE_UNIT ? undefined : (value || null);
    const to = repItemUnit(i, next).factor;
    setEdit(r.id, i.productId, convertRepQty(repItemQty(i.qty, edits[r.id]?.[i.productId]), from, to));
    setUnitEdits(m => {
      const own = { ...m[r.id] };
      if (next === undefined) delete own[i.productId]; else own[i.productId] = next;
      return { ...m, [r.id]: own };
    });
  };
  /** وحدة الطلب العام لصنف: الكمية التي كتبها الإداري تبقى رقمها (يراه بجانب الوحدة)، والمجموع المبدئي يتبع الوحدة */
  const setRowUnit = (pid: string, value: string) => setReqUnit(m => ({ ...m, [pid]: value || null }));
  const replaceReq = (saved: RepStockRequest) => qc.setQueryData<RepStockRequest[]>(['rep-stock-requests'],
    list => (list ?? []).map(x => (x.id === saved.id ? { ...x, ...saved } : x)));

  /** يحفظ تعديل طلبٍ ويعيد نسخته الجديدة — الإرسال يُرسل ما في الخادم لا ما في الشاشة وحدها */
  const saveReq = async (r: RepStockRequest): Promise<string> => {
    // ما تغيّرت كميته أو وحدته — و`unitId` لما تغيّرت وحدته وحدها (repEditItems)
    const items = repEditItems(r, edits[r.id], unitEdits[r.id]);
    const { data } = await repStockRequestApi.update(r.id, { updatedAt: r.updatedAt, items });
    const saved = data.data as RepStockRequest;
    replaceReq(saved);
    dropEdits(r.id);
    return saved.updatedAt;
  };

  const save = async (r: RepStockRequest) => {
    setError(''); setBusy(r.id);
    try { await saveReq(r); } catch (e) {
      setError(errMsg(e, tr('تعذر الحفظ')));
      // وحدات الصنف تغيّرت منذ فُتحت النافذة: كميات الإداري مكتوبةٌ على وحدةٍ لم تعد كما رآها — تُسقط ويُعاد الطلب من الخادم
      if (isStaleUnitsError(e)) dropEdits(r.id);
      qc.invalidateQueries({ queryKey: ['rep-stock-requests'] });
    }
    setBusy(null);
  };

  const reject = async (r: RepStockRequest) => {
    if (!window.confirm(`${tr('رفض طلب المندوب')} ${r.repName}؟`)) return;
    setError(''); setBusy(r.id);
    try {
      await repStockRequestApi.reject(r.id, r.updatedAt);
      dropEdits(r.id);
    } catch (e) { setError(errMsg(e, tr('تعذر الحفظ'))); }
    await qc.invalidateQueries({ queryKey: ['rep-stock-requests'] });
    setBusy(null);
  };

  const issue = async () => {
    setError('');
    const now = new Date();
    const ref = stockRequestRef(now);
    const sending = included;
    if (sending.length) {
      setBusy('send');
      try {
        const versions: { id: string; updatedAt: string }[] = [];
        for (const r of sending) versions.push({ id: r.id, updatedAt: repRequestDirty(r, edits[r.id], unitEdits[r.id]) ? await saveReq(r) : r.updatedAt });
        await repStockRequestApi.send({ ref, requests: versions });
      } catch (e) {
        setError(errMsg(e, tr('تعذر إرسال طلبات المناديب')));
        // كالحفظ: تعديلاتٌ على وحداتٍ تغيّرت لا تُعاد كما هي — يُعاد جلب الطلبات بوحداتها الآن
        if (isStaleUnitsError(e)) { setEdits({}); setUnitEdits({}); }
        qc.invalidateQueries({ queryKey: ['rep-stock-requests'] });
        setBusy(null);
        return;
      }
      setBusy(null);
      setSent(true);
    }
    setDoc({
      kind: 'stockRequest', company, ref, date: now.toISOString(),
      to, neededBy: neededBy || undefined, note: note.trim() || undefined, by: by || undefined, items: lines,
      // كل بند بوحدته الآن (المختارة، وإلا وحدة سطر المندوب) — «٥» وحدها لا تقول أكراتين أم حبّات
      reps: sending.length ? sending.map(r => ({
        name: r.repName,
        items: r.items.map(i => ({ name: i.name, unit: repItemUnit(i, unitEdits[r.id]?.[i.productId]).name || i.unit, qty: repItemQty(i.qty, edits[r.id]?.[i.productId]) })).filter(i => i.qty > 0),
      })) : undefined,
    });
    if (sending.length) qc.invalidateQueries({ queryKey: ['rep-stock-requests'] });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          <div className="flex items-start justify-between gap-3 p-5 border-b border-[#E9E1D3]">
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><ClipboardList size={20} className="text-[#E15A30]" /> {tr('طلب مخزون')}</h2>
              <p className="text-xs text-[#9A8F7E] mt-1">{tr('اكتب الكمية المطلوبة أمام كل صنف ثم أصدر الملف وأرسله للجهة المختصة')}</p>
            </div>
            <button onClick={onClose} aria-label={tr('إلغاء')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto">
            {/* الجهة الموجَّه إليها الطلب */}
            <div>
              <label className="label">{tr('موجه إلى')}</label>
              <div className="grid grid-cols-2 gap-2">
                {(['PURCHASING', 'PRODUCTION'] as const).map(t => (
                  <button key={t} type="button" onClick={() => setTo(t)}
                    className={`py-2.5 rounded-xl border text-sm font-semibold ${to === t ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                    {tr(stockRequestToLabel(t))}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">{tr('مطلوب قبل اختياري')}</label>
                <input type="date" className="input" value={neededBy} min={todayLocal()} onChange={e => setNeededBy(e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('ملاحظة اختياري')}</label>
                <input className="input" value={note} onChange={e => setNote(e.target.value)} />
              </div>
            </div>

            {/* البحث وتصفية الناقص */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[180px]">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 text-[#9A8F7E] pointer-events-none" style={{ insetInlineStart: 10 }} />
                <input className="input" style={{ paddingInlineStart: 32 }} value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('بحث بالاسم أو الكود')} />
              </div>
              <label className="flex items-center gap-2 text-xs text-[#6E6557] cursor-pointer">
                <input type="checkbox" checked={shortOnly} onChange={e => setShortOnly(e.target.checked)} className="accent-[#E15A30]" />
                {tr('الأصناف الناقصة فقط')}
              </label>
            </div>

            <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
                <span className="min-w-0 flex-1">{tr('الصنف')}</span>
                <span className="w-14 sm:w-20 text-center">{tr('الرصيد الحالي')}</span>
                <span className="w-20 sm:w-28 text-center">{tr('الكمية المطلوبة')}</span>
              </div>
              {visible.length === 0 ? (
                <p className="p-6 text-center text-sm text-gray-400">{tr('لا أصناف مطابقة')}</p>
              ) : (
                <div className="divide-y divide-[#F1EBDF] max-h-[42vh] overflow-y-auto">
                  {visible.map(r => {
                    const raw = effective[r.productId] ?? '';
                    const bad = isInvalidRequestQty(qty[r.productId]);
                    const fromReps = repSum.get(r.productId) ?? 0; // بالأساس
                    const multi = hasBigUnit(r.units);
                    const reqU = unitOfRow(r);
                    const choices = multi ? unitChoices({ unit: r.unit ?? '', units: r.units ?? [] }) : [];
                    // «الوحدة الرئيسية» الصالحة (primaryUnitOf) — غيابها كل نصٍّ هنا كما كان
                    const prim = primaryUnitOf(r);
                    // الإداري كتب غير ما جمعه المناديب — يبقى المجموع ظاهراً للمقارنة. والمقارنة بالأساس: «٢ كرتون» = ٤٨ حبة
                    const overridden = qty[r.productId] !== undefined
                      && Math.abs((parseRequestQty(qty[r.productId]) ?? 0) * (reqU.id ? reqU.factor : 1) - fromReps) > 1e-6;
                    return (
                      <div key={r.productId} className="flex items-center gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                          <p className="text-[11px] text-[#9A8F7E]">{[r.code, prim ? `${tr('الوحدة الرئيسية')} ${productUnitLabel(r)}` : multi ? `${tr('وحدة الأساس')} ${r.unit}` : r.unit].filter(Boolean).join(' · ')}</p>
                          {fromReps > 0 && (
                            <p className={`text-[11px] font-semibold flex items-center gap-1 ${overridden ? 'text-amber-700' : 'text-[#1E7A52]'}`}>
                              <Truck size={11} /> {tr('طلبات المناديب')}: <span dir={multi ? undefined : 'ltr'}>{baseQtyText(fromReps, r, fmtQty)}</span>
                            </p>
                          )}
                        </div>
                        {/* الرصيد بالأساس مفكَّكاً «٢ كرتون و٣ حبة» لصنفٍ له وحدات — رقمٌ بجانب خانة طلبٍ بالكرتون يُقرأ كراتين */}
                        <span dir={multi ? undefined : 'ltr'} className={`w-14 sm:w-20 shrink-0 text-center ${multi ? 'text-[11px]' : 'text-sm'} font-bold ${r.onHand < 0 ? 'text-red-600' : r.onHand === 0 ? 'text-amber-600' : 'text-[#6E6557]'}`}>{baseQtyText(r.onHand, r, fmtQty)}</span>
                        <div className="w-20 sm:w-28 shrink-0 flex flex-col gap-1">
                          <input type="number" step="any" min="0" inputMode="decimal" value={raw}
                            onChange={e => setQty(m => ({ ...m, [r.productId]: e.target.value }))}
                            aria-label={`${tr('الكمية المطلوبة')} ${r.name}`}
                            className={`input w-full py-1.5 text-center ${bad ? 'border-red-400 bg-red-50' : ''}`} placeholder="0" />
                          {choices.length > 1 && (
                            <select className="input w-full py-0.5 text-[11px]" value={reqU.id ?? ''} aria-label={`${tr('الوحدة')} ${r.name}`}
                              onChange={e => setRowUnit(r.productId, e.target.value)}>
                              {choices.map(c => <option key={c.id ?? 'base'} value={c.id ?? ''}>{c.name}{c.factor > 1 ? ` (${c.factor})` : ''}{prim && c.id === prim.id ? ` · ${tr('رئيسية')}` : ''}</option>)}
                            </select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* طلبات المناديب المعلّقة: لكل مندوب أصنافه بكمية معتمدة قابلة للتعديل */}
            {reqs.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h3 className="text-sm font-bold text-[#1F1A13] flex items-center gap-1.5"><Truck size={16} className="text-[#E15A30]" /> {tr('طلبات المناديب')} ({reqs.length})</h3>
                  <span className="text-[11px] text-[#9A8F7E]">{tr('المشمول منها يضاف للطلب العام ويعلم مرسلا عند الإصدار')}</span>
                </div>
                <div className="space-y-2">
                  {reqs.map(r => {
                    const isIn = !excluded[r.id];
                    const dirty = repRequestDirty(r, edits[r.id], unitEdits[r.id]);
                    return (
                      <div key={r.id} className={`border rounded-xl ${isIn ? 'border-[#E9E1D3]' : 'border-dashed border-gray-300 opacity-60'}`}>
                        <div className="flex items-center gap-2 px-3 py-2 bg-[#FAF7F0] rounded-t-xl flex-wrap">
                          <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
                            <input type="checkbox" checked={isIn} onChange={e => setExcluded(m => ({ ...m, [r.id]: !e.target.checked }))} className="accent-[#E15A30]" />
                            <span className="text-sm font-bold text-[#1F1A13] truncate">{r.repName}</span>
                            <span className="text-[11px] text-[#9A8F7E] shrink-0">{formatDateTime(r.updatedAt)}</span>
                          </label>
                          {dirty && (
                            <button onClick={() => save(r)} disabled={busy !== null} className="text-xs font-semibold text-[#1E7A52] flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-green-50 disabled:opacity-50">
                              <Save size={13} /> {tr('حفظ التعديل')}
                            </button>
                          )}
                          <button onClick={() => reject(r)} disabled={busy !== null} className="text-xs font-semibold text-red-600 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-50 disabled:opacity-50">
                            <Ban size={13} /> {tr('رفض')}
                          </button>
                        </div>
                        {r.note && <p className="px-3 pt-2 text-xs text-[#6E6557]">{tr('ملاحظة')}: {r.note}</p>}
                        <div className="divide-y divide-[#F1EBDF]">
                          {r.items.map(i => {
                            const raw = edits[r.id]?.[i.productId] ?? String(i.qty);
                            const bad = isInvalidRequestQty(edits[r.id]?.[i.productId]);
                            // وحدة البند: المختارة (unitEdits)، وإلا وحدة سطر المندوب — ووحدةٌ لم تعد نشطة خيارٌ باسمها
                            const choices = unitChoices({ unit: String(i.baseUnit ?? i.unit ?? ''), units: i.units ?? [] });
                            const iPrim = primaryUnitOf(i);
                            const lineId = repLineUnitId(i);
                            const ue = unitEdits[r.id]?.[i.productId];
                            const value = ue !== undefined ? (ue ?? '') : (lineId === undefined ? LINE_UNIT : (lineId ?? ''));
                            return (
                              <div key={i.productId} className="flex items-center gap-2 px-3 py-1.5">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-[#1F1A13] truncate">{i.name}</p>
                                  <p className="text-[11px] text-[#9A8F7E]">{tr('طلب المندوب')}: <span dir="ltr">{fmtQty(i.requestedQty)}</span> {i.unit || ''}</p>
                                </div>
                                <div className="w-20 sm:w-28 shrink-0 flex flex-col gap-1">
                                  <input type="number" step="any" min="0" inputMode="decimal" value={raw} disabled={!isIn}
                                    onChange={e => setEdit(r.id, i.productId, e.target.value)}
                                    aria-label={`${tr('الكمية المعتمدة')} ${r.repName} ${i.name}`}
                                    className={`input w-full py-1 text-center ${bad ? 'border-red-400 bg-red-50' : ''}`} />
                                  {choices.length > 1 && (
                                    <select className="input w-full py-0.5 text-[11px]" value={value} disabled={!isIn}
                                      aria-label={`${tr('الوحدة')} ${r.repName} ${i.name}`}
                                      onChange={e => setItemUnit(r, i, e.target.value)}>
                                      {lineId === undefined && <option value={LINE_UNIT}>{i.unit} ({factorText(i)})</option>}
                                      {choices.map(c => <option key={c.id ?? 'base'} value={c.id ?? ''}>{c.name}{c.factor > 1 ? ` (${c.factor})` : ''}{iPrim && c.id === iPrim.id ? ` · ${tr('رئيسية')}` : ''}</option>)}
                                    </select>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {reqQ.isError && <p className="text-xs text-amber-700">{tr('تعذر تحميل طلبات المناديب')}</p>}
          </div>

          <div className="p-5 border-t border-[#E9E1D3] space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#6E6557]">{tr('عدد الأصناف')}: <b className="text-[#1F1A13]">{lines.length}</b></span>
              {/* كورقة الطلب: لكل وحدة حين تختلط («٢ كرتون · ٥ حبة») — وإلا الرقم كما كان */}
              <span className="text-[#6E6557]">{tr('إجمالي الكميات')}: <b className="text-[#1F1A13]">{stockRequestTotalText(lines, fmtQty)}</b></span>
            </div>
            {anyInvalid && <p className="text-xs text-red-600">{tr('الكمية يجب أن تكون رقما موجبا')}</p>}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-3">
              <button onClick={issue} disabled={lines.length === 0 || anyInvalid || busy !== null}
                className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
                {busy === 'send'
                  ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <FileDown size={16} />}
                {' '}{included.length ? tr('إصدار PDF وإرسال طلبات المناديب') : tr('إصدار PDF')}
              </button>
              <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
            </div>
          </div>
        </div>
      </div>

      {/* الورقة فوق النموذج — طبقةٌ أعلى من z-[60] — و«تم» تعيد إليه بكمياته، أو تغلقه بعد إرسال طلبات المناديب */}
      {doc && (
        <div className="relative z-[70]">
          <DocumentModal doc={doc} onClose={() => { setDoc(null); if (sent) onClose(); }} />
        </div>
      )}
    </>
  );
}
