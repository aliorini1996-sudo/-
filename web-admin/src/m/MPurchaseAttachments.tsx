import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ImagePlus, FileText, X, Paperclip, Trash2, Loader2, ExternalLink, Upload, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi } from '../api/client';
import { compressImage } from '../rep/imageCompress';
import { useTr } from '../i18n/strings';
import { NO_CAMERA_HINT, NO_CAMERA_MSG, cameraCaptureCrashes } from '../lib/appCamera';
import { useBackClose } from '../lib/useBackClose';
import { formatDate, formatNumber } from '../utils/format';
import {
  PURCHASE_ATT_MAX_PER_REQUEST, PURCHASE_ATT_MAX_PER_ENTRY, PURCHASE_ATT_COMPRESS, ATT_PROBLEM_KEYS,
  pickedFileKind, pdfFileProblem, normalizePdfDataUrl, checkAttachment, addProblem, problemText, attachmentsPayload,
  humanSize, totalBytes, slotsLeft, parseAttachmentData, safeImageSrc, pdfBytesOf, isPdf,
  type PickedAttachment, type AttachmentMeta, type AttProblem,
} from '../lib/purchaseAttachments';
import { MCard, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';

/**
 * «إرفاق فاتورة المشتريات» في مخزون الشركة على الجوال (طلب المالك ١٣ نوفمبر ٢٠٢٦): صورةٌ بالكاميرا، أو من الاستديو، أو ملف PDF —
 * تُرسل مع جسم الحركة نفسه (وارد أو تسوية) فتُحفظ معها في معاملةٍ واحدة، أو تُضاف لحركةٍ قائمة من سجلّها.
 *
 * الحدود والفحص كلّها من lib/purchaseAttachments.ts — المصدر نفسه الذي تقرؤه اللوحة، فلا يقبل الجوال ما ترفضه اللوحة ولا العكس.
 * والخادم هو الحَكَم: يفحص البايتات بتوقيعها ويردّ 400 ATTACHMENT_INVALID برسالةٍ عربية تُعرض كما هي.
 */

/** محاولةٌ ثانية أصغر لصورةٍ تجاوزت سقفها بعد الضغط الأوّل (صورةٌ ضخمة التفاصيل) — قبل أن يُقال للمستخدم «أكبر من المسموح» */
const PA_COMPRESS_SMALL = { maxDim: 1280, quality: 0.6 } as const;

const fail = (code: keyof typeof ATT_PROBLEM_KEYS): { ok: false; problem: AttProblem } =>
  ({ ok: false, problem: { code, key: ATT_PROBLEM_KEYS[code] } });

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read')));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(f);
  });
}

/**
 * ملفٌّ من الجهاز ⇒ مرفقٌ جاهز أو مشكلته. الصورة تُضغط دائماً (صورة الهاتف الخام أضعاف الحدّ، وHEIC الآيفون يصير JPEG يفهمه
 * الخادم)، وPDF يُرفض بحجمه قبل قراءته ثم يُحكم بتوقيعه `%PDF-` لا باسمه. `null` = تعذّرت القراءة نفسها.
 */
async function prepareFile(f: File, index: number, key: string): Promise<{ ok: true; att: PickedAttachment } | { ok: false; problem: AttProblem } | null> {
  const kind = pickedFileKind(f);
  if (!kind) return fail('TYPE');
  if (kind === 'pdf') {
    const big = pdfFileProblem(f.size);
    if (big) return { ok: false, problem: big };
    let raw: string;
    try { raw = await readDataUrl(f); } catch { return null; }
    const data = normalizePdfDataUrl(raw);
    return data ? checkAttachment({ name: f.name, data }, index, key) : fail('CORRUPT');
  }
  let data: string;
  try { data = await compressImage(f, PURCHASE_ATT_COMPRESS); } catch { return null; }
  const first = checkAttachment({ name: f.name, data }, index, key);
  if (first.ok || first.problem.code !== 'IMAGE_TOO_BIG') return first;
  try { data = await compressImage(f, PA_COMPRESS_SMALL); } catch { return null; }
  return checkAttachment({ name: f.name, data }, index, key);
}

let seq = 0;
const newKey = () => `pa-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** رسالة الخادم أولى — «ATTACHMENT_INVALID» يقول السبب بالعربية */
function errMsg(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

/* ═══════════════════════ منتقي المرفقات ═══════════════════════ */

/**
 * ثلاثة أزرار (تصوير، من الاستديو، ملف PDF) وشرائح المختار بحذفٍ لكلٍّ. الضغط غير متزامن: `onBusy` يعطّل «حفظ» الحاوية
 * حتى يجهز آخر ملف، وإلا حُفظت الحركة بلا الصورة التي لم تُضغط بعد.
 */
export function MPurchaseAttachPicker({ items, onChange, existing = 0, onBusy, disabled = false }: {
  items: PickedAttachment[];
  onChange: (items: PickedAttachment[]) => void;
  /** مرفقات الحركة المحفوظة (الإضافة اللاحقة) — تُحسب من سقف الحركة (١٠) */
  existing?: number;
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const tr = useTr();
  const [msg, setMsg] = useState('');
  const [working, setWorking] = useState(false);
  // القائمة الحيّة من المرجع لا من لقطة الرسم — ملفٌّ انتهى ضغطه لا يُعيد قائمةً قديمة فوق شريحةٍ حُذفت في أثنائه
  const live = useRef(items);
  live.current = items;
  const write = (next: PickedAttachment[]) => { live.current = next; onChange(next); };
  useEffect(() => { onBusy?.(working); }, [working, onBusy]);
  useEffect(() => () => { onBusy?.(false); }, [onBusy]);

  // سقف هذا المنتقي: الأقلّ من سقف الطلب (٥) وما بقي في الحركة
  const cap = Math.max(0, Math.min(PURCHASE_ATT_MAX_PER_REQUEST, PURCHASE_ATT_MAX_PER_ENTRY - existing));
  const full = slotsLeft(items.length, existing) === 0;
  const off = disabled || working || full;
  const total = totalBytes(items);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار الملف نفسه
    if (!files.length) return;
    setMsg(''); setWorking(true);
    try {
      for (const f of files) {
        // الامتلاء يُقال قبل ضغط ملفٍّ لن يُضاف
        if (slotsLeft(live.current.length, existing) === 0) {
          const p = addProblem(live.current, { mime: 'image/jpeg', size: 0 }, { existing });
          if (p) setMsg(problemText(p, tr));
          break;
        }
        const r = await prepareFile(f, existing + live.current.length + 1, newKey());
        if (!r) { setMsg(tr('تعذرت قراءة إحدى الصور')); continue; }
        if (!r.ok) { setMsg(problemText(r.problem, tr)); continue; }
        const p = addProblem(live.current, r.att, { existing });
        if (p) { setMsg(problemText(p, tr)); continue; }
        write([...live.current, r.att]);
      }
    } finally { setWorking(false); }
  };

  const remove = (key: string) => { setMsg(''); write(live.current.filter(a => a.key !== key)); };

  const btn = `min-h-[52px] rounded-xl border-2 border-dashed text-[12px] font-bold flex flex-col items-center justify-center gap-0.5 py-1.5 ${off ? 'border-[#E9E1D3] text-[#C9BFB0] pointer-events-none' : 'border-[#E9E1D3] text-[#6E6557] active:border-[#E15A30] active:text-[#E15A30] cursor-pointer'}`;

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map(a => (
            <div key={a.key} className="flex items-center gap-2 rounded-xl border border-[#F1EBDF] bg-[#FAF7F0] p-1.5">
              {isPdf(a) ? (
                <span className="w-10 h-10 rounded-lg bg-[#FDF2F0] text-[#C0392B] flex items-center justify-center flex-shrink-0">
                  <FileText size={18} />
                </span>
              ) : (
                <img src={safeImageSrc(a.data) ?? undefined} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0 bg-white" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold text-[#1F1A13] truncate" dir="auto">{a.name}</span>
                <span className="block text-[10px] text-[#9A8F7E] tabular-nums" dir="ltr">{humanSize(a.size)}</span>
              </span>
              <button type="button" onClick={() => remove(a.key)} aria-label={tr('حذف')} disabled={disabled}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#C0392B] active:bg-[#FDF2F0] flex-shrink-0">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {!full && (
        <div className="grid grid-cols-3 gap-2">
          {cameraCaptureCrashes() ? (
            // تطبيق «إدارة» 1.0.x على الآيفون بلا إذن كاميرا: فتحها يُغلق التطبيق (lib/appCamera.ts) — رسالةٌ بدل الكاميرا
            <button type="button" className={btn} onClick={() => setMsg(tr(NO_CAMERA_MSG))} disabled={off}>
              <Camera size={17} /> {tr('تصوير')}
            </button>
          ) : (
            <label className={btn}>
              <Camera size={17} /> {tr('تصوير')}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} disabled={off} />
            </label>
          )}
          <label className={btn}>
            <ImagePlus size={17} /> {tr('من الاستديو')}
            <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} disabled={off} />
          </label>
          <label className={btn}>
            <FileText size={17} /> {tr('ملف PDF')}
            <input type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={onPick} disabled={off} />
          </label>
        </div>
      )}
      {!full && cameraCaptureCrashes() && <p className="text-[10px] text-[#B4561F] px-0.5">{tr(NO_CAMERA_HINT)}</p>}
      <p className="text-[10px] text-[#9A8F7E] px-0.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 min-w-0">
          {working && <Loader2 size={11} className="animate-spin flex-shrink-0" />}
          <span className="truncate">{working ? tr('جاري تجهيز الصور') : tr('صورة الفاتورة أو ملف PDF')}</span>
        </span>
        <span className="tabular-nums flex-shrink-0" dir="ltr">
          {formatNumber(items.length)}/{formatNumber(cap)}{total > 0 ? ` · ${humanSize(total)}` : ''}
        </span>
      </p>
      {msg && <p className="text-[11px] text-[#C0392B] px-0.5">{msg}</p>}
    </div>
  );
}

/* ═══════════════════════ مرفقات حركةٍ قائمة ═══════════════════════ */

/** معاينةٌ مفتوحة: الصورة من data URL المفحوص نفسه، وPDF من رابط Blob يُفتح في لسانٍ جديد بلمسة المستخدم */
type Preview = { name: string; kind: 'image' | 'pdf'; src: string };

/**
 * طبقة مرفقات الحركة — ملء الشاشة كإشعار الحركة: القائمة، وفتح كلٍّ (الصورة داخل الشاشة، وPDF في لسانٍ جديد)، والحذف بلمستين،
 * والإضافة لاحقاً (فاتورةٌ وصلت بعد تسجيل الوارد) حتى سقف الحركة. والخادم يحرس الصلاحية والشركة في كل طلب.
 */
export function MEntryAttachments({ entryId, title, subtitle, onClose }: {
  entryId: string; title: string; subtitle?: string; onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // الحذف بلمستين: الأولى تسلّح، والثانية تحذف
  const [picked, setPicked] = useState<PickedAttachment[]>([]);
  const [busy, setBusy] = useState(false);

  // رابط PDF يُبطَل بعد مهلة لا فوراً: لسانٌ فُتح للتوّ قد يكون ما زال يقرؤه
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const releasePdf = () => {
    const p = previewRef.current;
    if (p?.kind === 'pdf') { const u = p.src; setTimeout(() => URL.revokeObjectURL(u), 60_000); }
  };
  const closePreview = () => { releasePdf(); setPreview(null); };
  useBackClose(!!preview, closePreview);
  // مغادرة الطبقة والمعاينة مفتوحة: رابطها لا يبقى معلّقاً
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => releasePdf, []);

  const listQ = useQuery({
    queryKey: ['m-wh-entry-atts', entryId],
    queryFn: async () => expectArray<AttachmentMeta>((await warehouseApi.attachments(entryId)).data?.data, tr('مرفقات')),
  });
  const list = listQ.data ?? [];

  // العدد على صفّ السجلّ في الجوال واللوحة معاً — الكاش مشترك
  const refresh = () => ['m-wh-entry-atts', 'm-wh-entries', 'warehouse-entries']
    .forEach(k => qc.invalidateQueries({ queryKey: [k] }));

  const add = useMutation({
    mutationFn: async () => warehouseApi.addAttachments(entryId, attachmentsPayload(picked).attachments ?? []),
    onSuccess: () => { setPicked([]); refresh(); toast.success(tr('تم رفع المرفق')); },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر رفع المرفق'))),
  });

  const del = useMutation({
    mutationFn: async (attId: string) => warehouseApi.removeAttachment(entryId, attId),
    onSuccess: () => { setArmed(null); refresh(); toast.success(tr('تم الحذف')); },
    onError: (e: unknown) => { setArmed(null); toast.error(errMsg(e, tr('تعذر الحذف'))); },
  });

  async function open(a: AttachmentMeta) {
    if (opening) return;
    setArmed(null);
    setOpening(a.id);
    try {
      const d = expectObject<{ name?: string; data?: unknown }>(
        (await warehouseApi.attachment(entryId, a.id)).data?.data, tr('مرفقات'));
      // يُفحص ما ردّه الخادم قبل عرضه (البنية والتوقيع): الصورة داخل الشاشة بصيغها الثلاث وحدها، وPDF من Blob — وغيرهما لا يُعرض
      const p = parseAttachmentData(d.data);
      const name = d.name || a.name;
      if (p && p.mime === 'application/pdf') {
        const bytes = pdfBytesOf(d.data);
        if (!bytes) throw new Error('bad');
        setPreview({ name, kind: 'pdf', src: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })) });
      } else {
        const src = p ? safeImageSrc(d.data) : null;
        if (!src) throw new Error('bad');
        setPreview({ name, kind: 'image', src });
      }
    } catch {
      toast.error(tr('تعذر فتح المرفق'));
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={title} subtitle={subtitle} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide flex items-center gap-1.5">
            <Paperclip size={13} /> {tr('مرفقات')}
            {list.length > 0 && <span className="tabular-nums" dir="ltr">({formatNumber(list.length)}/{formatNumber(PURCHASE_ATT_MAX_PER_ENTRY)})</span>}
          </h3>
          {listQ.isLoading ? (
            <MCard><div className="py-10"><MSpinner /></div></MCard>
          ) : listQ.isError ? (
            <MCard><div className="py-10">
              <MError onRetry={() => listQ.refetch()} text={errMsg(listQ.error, tr('تعذر تحميل المرفقات'))} />
            </div></MCard>
          ) : !list.length ? (
            <MCard><div className="py-10"><MEmpty icon={Paperclip} text={tr('لا توجد مرفقات')} /></div></MCard>
          ) : (
            <MCard>
              {list.map(a => {
                const pdf = isPdf(a);
                const sure = armed === a.id;
                return (
                  // زرّان متجاوران لا زرٌّ داخل زرّ: الفتح للصفّ، والحذف بجانبه بلمستين (الأولى تسلّح)
                  <div key={a.id} className="flex items-center gap-1 pe-2 border-b border-[#F1EBDF] last:border-0">
                    <button type="button" onClick={() => open(a)}
                      className="min-w-0 flex-1 flex items-center gap-3 px-3.5 py-3 min-h-[56px] text-start active:bg-[#FAF7F0]">
                      <span className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${pdf ? 'bg-[#FDF2F0] text-[#C0392B]' : 'bg-[#FDF0EB] text-[#E15A30]'}`}>
                        {opening === a.id ? <Loader2 size={17} className="animate-spin" /> : pdf ? <FileText size={18} /> : <ImageIcon size={18} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1F1A13] truncate" dir="auto">{a.name}</span>
                        <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">
                          {[humanSize(a.size), a.createdBy, formatDate(a.createdAt)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                    <button type="button" disabled={del.isPending}
                      onClick={() => (sure ? del.mutate(a.id) : setArmed(a.id))}
                      aria-label={sure ? tr('تأكيد الحذف') : tr('حذف المرفق')}
                      className={`h-10 rounded-xl flex items-center justify-center gap-1 flex-shrink-0 ${sure ? 'px-2.5 bg-[#C0392B] text-white text-[11px] font-bold' : 'w-10 text-[#C0392B] active:bg-[#FDF2F0]'}`}>
                      {del.isPending && del.variables === a.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      {sure && tr('تأكيد الحذف')}
                    </button>
                  </div>
                );
              })}
            </MCard>
          )}
        </section>

        {/* ─────────── إضافة لاحقة ─────────── */}
        {listQ.isSuccess && (
          <section className="space-y-2.5">
            {list.length < PURCHASE_ATT_MAX_PER_ENTRY ? (
              <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-2.5">
                <MPurchaseAttachPicker items={picked} onChange={setPicked} existing={list.length} onBusy={setBusy} disabled={add.isPending} />
                {picked.length > 0 && (
                  <button type="button" onClick={() => add.mutate()} disabled={busy || add.isPending}
                    className="w-full bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
                    {add.isPending ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    {tr('رفع')}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-[#9A8F7E] px-1">{problemText({ code: 'ENTRY_FULL', key: ATT_PROBLEM_KEYS.ENTRY_FULL, n: PURCHASE_ATT_MAX_PER_ENTRY }, tr)}</p>
            )}
          </section>
        )}

        <div className="h-2" />
      </div>

      {/* ─────────── المعاينة ─────────── */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" role="dialog" aria-modal="true">
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-3 text-white"
            style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
            <span className="min-w-0 flex-1 text-sm font-bold truncate" dir="auto">{preview.name}</span>
            <button type="button" onClick={closePreview} aria-label={tr('إغلاق')}
              className="w-10 h-10 rounded-xl flex items-center justify-center active:bg-white/10">
              <X size={20} />
            </button>
          </div>
          {preview.kind === 'image' ? (
            <div className="flex-1 min-h-0 flex items-center justify-center p-2">
              <img src={preview.src} alt={preview.name} className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="w-full max-w-xs bg-white rounded-2xl p-5 text-center space-y-4">
                <span className="mx-auto w-14 h-14 rounded-2xl bg-[#FDF2F0] text-[#C0392B] flex items-center justify-center">
                  <FileText size={26} />
                </span>
                <p className="text-sm font-semibold text-[#1F1A13] break-words" dir="auto">{preview.name}</p>
                {/* رابطٌ بلمسة المستخدم نفسها — نافذةٌ تُفتح برمجياً بعد انتظار الشبكة يحجبها المتصفّح */}
                <a href={preview.src} target="_blank" rel="noopener noreferrer"
                  className="w-full bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
                  <ExternalLink size={16} /> {tr('فتح الملف')}
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
