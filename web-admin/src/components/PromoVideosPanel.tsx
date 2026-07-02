import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  X, Clapperboard, Sparkles, Play, Trash2, Pencil, Check,
  CheckCircle2, AlertTriangle, Loader2, Clock, Download, Layers, Music,
} from 'lucide-react';
import { promoVideoApi, VideoFeature, VideoJob, PromoStats, Voice } from '../api/promoVideoApi';

// روابط الوسائط مطلقة إلى الخادم — في الإنتاج الواجهة (fieldsa.net) والخادم (api.fieldsa.net) على نطاقين
// مختلفين، فالمسار النسبي /media يجب أن يشير للخادم. محلياً VITE_API_URL فارغ فيمرّره vite proxy.
const MEDIA_BASE = import.meta.env.VITE_API_URL || '';
const mediaUrl = (p?: string) => (p ? `${MEDIA_BASE}${p}` : undefined);

// لوحة صناعة الفيديوهات الترويجية — لمالك المنصّة
// سيناريو عربي → تعليق صوتي عربي (Edge/Google) → دمج مع تسجيل الشاشة
export default function PromoVideosPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<VideoFeature | null>(null);
  const [voiceId, setVoiceId] = useState<string>('');

  const { data: features } = useQuery({
    queryKey: ['promo-features'],
    queryFn: async () => (await promoVideoApi.features()).data.data as VideoFeature[],
  });

  const { data: voices } = useQuery({
    queryKey: ['promo-voices'],
    queryFn: async () => (await promoVideoApi.voices()).data.data as Voice[],
  });

  const { data: jobs } = useQuery({
    queryKey: ['promo-jobs'],
    queryFn: async () => (await promoVideoApi.jobs()).data.data as VideoJob[],
    // تحديث حيّ كل ثانيتين ما دامت هناك وظائف جارية، وإلا بلا استقصاء
    refetchInterval: (q) =>
      (q.state.data as VideoJob[] | undefined)?.some((j) => j.status === 'queued' || j.status === 'processing') ? 2000 : false,
  });

  const { data: stats } = useQuery({
    queryKey: ['promo-stats'],
    queryFn: async () => (await promoVideoApi.stats()).data.data as PromoStats,
    refetchInterval: 5000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['promo-jobs'] });
    qc.invalidateQueries({ queryKey: ['promo-stats'] });
  };

  const apiMsg = (e: unknown) =>
    (e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'حدث خطأ';

  const generateMutation = useMutation({
    mutationFn: (featureId: string) => promoVideoApi.generate(featureId, voiceId || undefined),
    onSuccess: () => { toast.success('بدأ إنتاج التعليق الصوتي'); refresh(); },
    onError: (e) => toast.error(apiMsg(e)),
  });

  const batchMutation = useMutation({
    mutationFn: (ids: string[]) => promoVideoApi.generateBatch(ids, voiceId || undefined),
    onSuccess: (res) => {
      const { created, skipped } = res.data.data as { created: VideoJob[]; skipped: unknown[] };
      toast.success(`بدأ إنتاج ${created.length}${skipped.length ? ` (تخطّي ${skipped.length})` : ''}`);
      refresh();
    },
    onError: (e) => toast.error(apiMsg(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => promoVideoApi.removeJob(id),
    onSuccess: () => { toast.success('حُذف الفيديو'); refresh(); },
    onError: (e) => toast.error(apiMsg(e)),
  });

  const saveScriptMutation = useMutation({
    mutationFn: ({ id, script }: { id: string; script: string }) => promoVideoApi.updateFeature(id, { script }),
    onSuccess: () => {
      toast.success('حُفظ السيناريو');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['promo-features'] });
    },
    onError: (e) => toast.error(apiMsg(e)),
  });

  const activeIds = new Set(
    (jobs || []).filter((j) => j.status === 'queued' || j.status === 'processing').map((j) => j.featureId),
  );
  // Edge TTS محرّك أساسي مجاني (متاح دائماً)؛ Google WaveNet وHeyGen ترقيتان اختياريتان
  const avatarReady = stats?.providers.avatar;
  const googleReady = stats?.providers.google;
  const produceWord = avatarReady ? 'فيديو' : 'التعليق الصوتي'; // نص الأزرار يتكيّف مع المحرّك المتاح

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Clapperboard size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">الفيديوهات الترويجية</h2>
              <p className="text-xs text-[#6E6557]">تعليق صوتي عربي احترافي لكل مميزة — تدمجه مع تسجيل شاشتك لفيديو 30–60 ثانية</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* مؤشّرات + حالة خدمات الإنتاج */}
          <div className="bg-[#FAF7F0] rounded-2xl border border-[#E9E1D3] p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi value={String(stats?.total ?? '—')} label="إجمالي المُنتَج" />
              <Kpi value={String(stats?.completed ?? '—')} label="جاهز" color="#1E7A52" />
              <Kpi value={String(stats?.processing ?? '—')} label="قيد الإنتاج" color="#E0A02C" />
              <Kpi value={String(stats?.failed ?? '—')} label="فشل" color="#C0392B" />
            </div>
            {stats && (
              <p className="mt-3 text-[11.5px] text-[#1E7A52] bg-green-50 rounded-lg px-3 py-2 leading-relaxed">
                التعليق الصوتي العربي مفعّل — Microsoft Edge ✓ (مجاني){googleReady ? ' + Google WaveNet ✓' : ''}{avatarReady ? ' + فيديو HeyGen ✓' : ''}. كل مميزة تُنتج ملف MP3 احترافياً جاهزاً للدمج مع تسجيل شاشتك.
              </p>
            )}
          </div>

          {/* دليل الدمج مع تسجيل الشاشة */}
          <div className="bg-white border border-[#E9E1D3] rounded-2xl p-4">
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2">
              <Clapperboard size={16} className="text-[#E15A30]" /> كيف تصنع الفيديو الترويجي؟
            </h3>
            <div className="grid sm:grid-cols-3 gap-2.5">
              <Step n={1} title="أنتج التعليق الصوتي" body="اختر مميزة واضغط الزر — يُنتَج ملف صوتي عربي احترافي وتحمّله." />
              <Step n={2} title="سجّل شاشتك" body="اعرض المميزة داخل النظام وسجّل الشاشة (Win+G في ويندوز، أو OBS مجاناً)." />
              <Step n={3} title="ادمجهما" body="ركّب الصوت على التسجيل في أي محرّر (CapCut/Clipchamp مجاني) وانشر." />
            </div>
          </div>

          {/* اختيار الصوت العربي */}
          <div className="flex items-center gap-2 bg-white border border-[#E9E1D3] rounded-xl px-3 py-2.5">
            <Music size={16} className="text-[#E15A30] shrink-0" />
            <label className="text-[12.5px] font-semibold text-[#1F1A13] shrink-0">الصوت:</label>
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="flex-1 text-[12.5px] bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#E15A30]"
            >
              {(voices || []).map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>

          {/* المميزات — بطاقة لكل مميزة مع سيناريوها */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[#1F1A13] flex items-center gap-2">
                <Sparkles size={16} className="text-[#E15A30]" /> مميزات النظام ({features?.length ?? 0})
              </h3>
              <button
                onClick={() => features && batchMutation.mutate(features.filter((f) => f.enabled && !activeIds.has(f.id)).map((f) => f.id))}
                disabled={batchMutation.isPending || !features?.length}
                className="flex items-center gap-1.5 text-[12px] font-semibold text-[#E15A30] bg-[#FBEBE2] hover:bg-[#F8DFD2] rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                <Layers size={14} /> إنتاج الكل دفعة واحدة
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {(features || []).map((f) => (
                <div key={f.id} className="bg-white border border-[#E9E1D3] rounded-xl p-3.5 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg leading-none">{f.icon}</span>
                      <p className="text-[13.5px] font-bold text-[#1F1A13] truncate">{f.nameAr}</p>
                    </div>
                    <span className="text-[10.5px] text-[#9A8F7E] bg-[#FAF7F0] rounded-full px-2 py-0.5 shrink-0 flex items-center gap-1">
                      <Clock size={10} /> {f.duration} ث
                    </span>
                  </div>
                  <p className="text-[11.5px] text-[#6E6557] leading-relaxed line-clamp-2 whitespace-pre-line">{f.script}</p>
                  <div className="flex gap-2 mt-auto">
                    <button
                      onClick={() => generateMutation.mutate(f.id)}
                      disabled={activeIds.has(f.id) || generateMutation.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white bg-[#E15A30] hover:bg-[#C94E28] rounded-lg py-1.5 transition-colors disabled:opacity-50"
                    >
                      {activeIds.has(f.id) ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      {activeIds.has(f.id) ? 'قيد الإنتاج…' : `إنتاج ${produceWord}`}
                    </button>
                    <button
                      onClick={() => setEditing(f)}
                      className="p-1.5 text-[#9A8F7E] hover:text-[#E15A30] hover:bg-[#FBEBE2] rounded-lg transition-colors"
                      title="تعديل السيناريو"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* الفيديوهات المُنتجة */}
          <div>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2">
              <Clapperboard size={16} className="text-[#E15A30]" /> سجلّ الإنتاج
            </h3>
            {!jobs?.length ? (
              <div className="text-center py-8 bg-[#FAF7F0] rounded-2xl border border-dashed border-[#E9E1D3]">
                <Clapperboard size={28} className="mx-auto text-[#C7BCA8] mb-2" />
                <p className="text-[13px] text-[#6E6557]">لم يُنتج أي فيديو بعد — اختر مميزة واضغط «إنتاج فيديو»</p>
              </div>
            ) : (
              <div className="space-y-2">
                {jobs.map((j) => <JobRow key={j.id} job={j} onDelete={() => deleteMutation.mutate(j.id)} />)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* محرّر السيناريو */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 z-[70] flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
              <h3 className="text-[15px] font-bold text-[#1F1A13]">سيناريو: {editing.nameAr}</h3>
              <button onClick={() => setEditing(null)} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={16} /></button>
            </div>
            <div className="p-4 space-y-3">
              <textarea
                value={editing.script}
                onChange={(e) => setEditing({ ...editing, script: e.target.value })}
                rows={6}
                dir="rtl"
                className="w-full text-[13px] leading-relaxed border border-[#E9E1D3] rounded-xl p-3 focus:outline-none focus:border-[#E15A30] resize-none"
              />
              <p className="text-[11px] text-[#9A8F7E]">
                {editing.script.trim().length} حرفاً — المثالي 100–300 حرف لفيديو {editing.duration} ثانية (مشكلة ← حل ← فائدة ← دعوة للتجربة)
              </p>
            </div>
            <div className="flex gap-2 p-4 pt-0">
              <button
                onClick={() => saveScriptMutation.mutate({ id: editing.id, script: editing.script })}
                disabled={saveScriptMutation.isPending}
                className="flex-1 flex items-center justify-center gap-1.5 text-[13px] font-semibold text-white bg-[#E15A30] hover:bg-[#C94E28] rounded-xl py-2 transition-colors disabled:opacity-50"
              >
                <Check size={15} /> حفظ السيناريو
              </button>
              <button onClick={() => setEditing(null)} className="text-[13px] text-[#6E6557] hover:bg-gray-100 rounded-xl px-4 py-2">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// صف فيديو في سجلّ الإنتاج — حالة، مرحلة جارية، وشريط تقدّم حي
function JobRow({ job, onDelete }: { job: VideoJob; onDelete: () => void }) {
  const busy = job.status === 'queued' || job.status === 'processing';
  const chip =
    job.status === 'completed' ? { label: 'مكتمل', cls: 'bg-green-100 text-green-700' } :
    job.status === 'failed' ? { label: 'فشل', cls: 'bg-red-100 text-red-700' } :
    job.status === 'processing' ? { label: 'قيد الإنتاج', cls: 'bg-amber-100 text-amber-700' } :
    { label: 'في الانتظار', cls: 'bg-gray-100 text-gray-600' };

  return (
    <div className="bg-white border border-[#E9E1D3] rounded-xl px-3.5 py-3">
      <div className="flex items-center gap-3">
        {job.status === 'completed' && <CheckCircle2 size={18} className="text-[#1E7A52] shrink-0" />}
        {job.status === 'failed' && <AlertTriangle size={18} className="text-[#C0392B] shrink-0" />}
        {busy && <Loader2 size={18} className="text-[#E0A02C] animate-spin shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-bold text-[#1F1A13]">{job.featureName}</p>
            <span className={`text-[10.5px] rounded-full px-2 py-0.5 font-medium ${chip.cls}`}>{chip.label}</span>
            {job.simulated && <span className="text-[10.5px] rounded-full px-2 py-0.5 bg-[#FBEBE2] text-[#C94E28] font-medium">محاكاة</span>}
          </div>
          <p className="text-[11px] text-[#9A8F7E] mt-0.5">
            {busy
              ? job.stageLabel
              : <>{job.voiceLabel && <span className="text-[#E15A30]">{job.voiceLabel}</span>}{job.voiceLabel && ' · '}{new Date(job.completedAt || job.createdAt).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' })}</>}
            {job.error && <span className="text-[#C0392B]"> — {job.error}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {job.outputUrl && (
            <a href={mediaUrl(job.outputUrl)} target="_blank" rel="noreferrer" className="p-1.5 text-[#1E7A52] hover:bg-green-50 rounded-lg" title="تحميل الفيديو">
              <Download size={15} />
            </a>
          )}
          {job.audioUrl && (
            <a href={mediaUrl(job.audioUrl)} target="_blank" rel="noreferrer" className="p-1.5 text-[#E15A30] hover:bg-[#FBEBE2] rounded-lg" title="الصوت العربي (MP3)">
              <Music size={15} />
            </a>
          )}
          {!busy && (
            <button onClick={onDelete} className="p-1.5 text-[#9A8F7E] hover:text-[#C0392B] hover:bg-red-50 rounded-lg" title="حذف">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
      {busy && (
        <div className="mt-2 h-1.5 bg-[#F0EADD] rounded-full overflow-hidden">
          <div className="h-full bg-[#E15A30] rounded-full transition-all duration-500" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {/* مشغّل الصوت مباشرةً داخل الصف — استماع فوري قبل التحميل */}
      {!busy && job.audioUrl && (
        <audio controls src={mediaUrl(job.audioUrl)} className="mt-2 w-full h-9" style={{ colorScheme: 'light' }} />
      )}
    </div>
  );
}

// خطوة في دليل الدمج مع تسجيل الشاشة
function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="bg-[#FAF7F0] rounded-xl border border-[#E9E1D3] p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 rounded-full bg-[#E15A30] text-white text-[11px] font-bold flex items-center justify-center shrink-0">{n}</span>
        <p className="text-[12.5px] font-bold text-[#1F1A13]">{title}</p>
      </div>
      <p className="text-[11px] text-[#6E6557] leading-relaxed">{body}</p>
    </div>
  );
}

function Kpi({ value, label, color = '#1F1A13' }: { value: string; label: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-[#E9E1D3] px-3 py-2.5 text-center">
      <p className="text-xl font-extrabold" style={{ color }}>{value}</p>
      <p className="text-[10.5px] text-[#9A8F7E] leading-tight mt-0.5">{label}</p>
    </div>
  );
}
