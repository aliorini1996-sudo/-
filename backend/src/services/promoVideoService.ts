// خدمة الفيديوهات الترويجية — لمالك المنصّة
// خطّ الإنتاج: سيناريو عربي → صوت (Google TTS) → فيديو Avatar (HeyGen) → ملف نهائي
//
// التفعيل عبر متغيّرات البيئة في backend/.env:
//   HEYGEN_API_KEY     (أساسي)  يُنتج فيديو Avatar الحقيقي — heygen.com → Settings → API
//   GOOGLE_TTS_KEY     (اختياري) مفتاح API لـ Cloud Text-to-Speech — يولّد MP3 عربي مستقل (للريلز الصوتية)
//   HEYGEN_AVATAR_ID   (اختياري) يُحدَّد تلقائياً من حسابك إن تُرك فارغاً
//   HEYGEN_VOICE_ID    (اختياري) يُحدَّد تلقائياً (أول صوت عربي في حسابك) إن تُرك فارغاً
// بدون HEYGEN_API_KEY يعمل الخط في وضع المحاكاة (شارة «محاكاة» في اللوحة).

import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type JobStage = 'script' | 'tts' | 'avatar' | 'merge' | 'done';

export interface VideoFeature {
  id: string;
  nameAr: string;
  duration: number;
  script: string;
  icon: string;
  enabled: boolean;
}

export interface VideoJob {
  id: string;
  featureId: string;
  featureName: string;
  status: JobStatus;
  stage: JobStage;
  stageLabel: string;
  progress: number;      // 0..100
  simulated: boolean;    // true = لا محرّك حقيقي (لا يحدث الآن — Edge متاح دائماً)
  voiceLabel: string;    // الصوت المستخدم (يظهر في اللوحة)
  createdAt: string;
  completedAt?: string;
  outputUrl?: string;    // فيديو MP4 (عند تفعيل HeyGen)
  audioUrl?: string;     // التعليق الصوتي MP3 — المُنتَج الأساسي
  error?: string;
}

// أصوات التعليق الصوتي العربي
// Edge = Microsoft Neural (مجاني بلا مفتاح) · Google = WaveNet (يتطلب GOOGLE_TTS_KEY)
export interface Voice { id: string; label: string; engine: 'edge' | 'google'; name: string; }
const VOICES: Voice[] = [
  { id: 'hamed',    label: 'حمد — ذكر (سعودي)',     engine: 'edge',   name: 'ar-SA-HamedNeural' },
  { id: 'zariyah',  label: 'زارية — أنثى (سعودية)', engine: 'edge',   name: 'ar-SA-ZariyahNeural' },
  { id: 'shakir',   label: 'شاكر — ذكر (مصري)',     engine: 'edge',   name: 'ar-EG-ShakirNeural' },
  { id: 'salma',    label: 'سلمى — أنثى (مصرية)',   engine: 'edge',   name: 'ar-EG-SalmaNeural' },
  { id: 'g-male',   label: 'Google WaveNet — ذكر',  engine: 'google', name: 'ar-XA-Wavenet-C' },
  { id: 'g-female', label: 'Google WaveNet — أنثى', engine: 'google', name: 'ar-XA-Wavenet-A' },
];
const DEFAULT_VOICE = VOICES[0];

export function listVoices(): Voice[] {
  const googleOn = Boolean(process.env.GOOGLE_TTS_KEY);
  return VOICES.filter((v) => v.engine === 'edge' || googleOn);
}

// مجلد الوسائط المُنتجة — يُقدَّم statically على /media
export const MEDIA_DIR = path.join(process.cwd(), 'media', 'promo');
mkdirSync(MEDIA_DIR, { recursive: true });

// المميزات الافتراضية — سيناريوهات جاهزة قابلة للتعديل من اللوحة
const defaultFeatures: VideoFeature[] = [
  {
    id: 'invoice', nameAr: 'الفاتورة الإلكترونية', duration: 30, icon: '🧾', enabled: true,
    script: 'هل تتعب من إصدار الفواتير يدوياً؟\nمع Field Sales تُنشأ الفاتورة الإلكترونية بنقرة واحدة.\nسجلّ كامل، PDF فوري، وتوافق ضريبي.\nجرّب الآن وسهّل عملك!',
  },
  {
    id: 'reports', nameAr: 'التقارير والإحصائيات', duration: 35, icon: '📊', enabled: true,
    script: 'هل تريد فهم أداء فريقك لحظة بلحظة؟\nتقارير Field Sales توضّح كل شيء بصرياً وفوراً.\nمبيعات اليوم، أداء المناديب، والتحصيل.\nكل المعلومات في لوحة واحدة.',
  },
  {
    id: 'tracking', nameAr: 'تتبع المناديب', duration: 30, icon: '📍', enabled: true,
    script: 'شاهد فريقك الميداني على الخريطة الحيّة.\nكل مندوب، موقعه، وزياراته لحظياً.\nشفافية كاملة وإدارة أذكى.\nField Sales: نظامك للمبيعات الميدانية.',
  },
  {
    id: 'customers', nameAr: 'إدارة العملاء', duration: 35, icon: '👥', enabled: true,
    script: 'قاعدة عملاء موحّدة ومنظّمة.\nسجلّ كامل لكل عميل: فواتيره، مدفوعاته، وكشف حسابه.\nمتابعة سهلة من أي جهاز.\nField Sales يجعل إدارة العملاء احترافية.',
  },
  {
    id: 'vanstock', nameAr: 'مخزون السيارة', duration: 30, icon: '🚚', enabled: true,
    script: 'كم بضاعة في سيارة كل مندوب الآن؟\nField Sales يتتبّع تحميل وتصريف مخزون السيارات.\nتسوية يومية دقيقة بلا ورق.\nتحكّم كامل في بضاعتك الميدانية.',
  },
  {
    id: 'mobile', nameAr: 'تطبيق المندوب', duration: 30, icon: '📱', enabled: true,
    script: 'تطبيق قوي في جيب كل مندوب.\nفواتير، تحصيل، وعملاء — حتى بدون إنترنت.\nيتزامن تلقائياً عند عودة الاتصال.\nحمّل تطبيق Field Sales اليوم!',
  },
];

const features = new Map<string, VideoFeature>(defaultFeatures.map((f) => [f.id, f]));
const jobs = new Map<string, VideoJob>();
const MAX_JOBS = 100;

export function providersStatus() {
  return {
    edge: true,                                  // Edge TTS — مجاني بلا مفتاح (متاح دائماً)
    google: Boolean(process.env.GOOGLE_TTS_KEY), // WaveNet — يتطلب مفتاحاً
    avatar: Boolean(process.env.HEYGEN_API_KEY), // HeyGen — يتطلب رصيد API مدفوع
    tts: true,                                   // تعليق صوتي متاح دائماً (Edge على الأقل)
  };
}

export function listFeatures(): VideoFeature[] {
  return [...features.values()];
}

export function updateFeature(id: string, updates: { script?: string; duration?: number; enabled?: boolean }): VideoFeature {
  const f = features.get(id);
  if (!f) throw Object.assign(new Error('المميزة غير موجودة'), { status: 404 });
  if (updates.script !== undefined) {
    const s = updates.script.trim();
    if (s.length < 20) throw Object.assign(new Error('السيناريو قصير جداً (20 حرفاً على الأقل)'), { status: 400 });
    if (s.length > 600) throw Object.assign(new Error('السيناريو طويل جداً (600 حرف كحد أقصى)'), { status: 400 });
    f.script = s;
  }
  if (updates.duration !== undefined) f.duration = Math.min(90, Math.max(15, updates.duration));
  if (updates.enabled !== undefined) f.enabled = updates.enabled;
  return f;
}

export function listJobs(): VideoJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): VideoJob | undefined {
  return jobs.get(id);
}

export function deleteJob(id: string): void {
  const job = jobs.get(id);
  if (!job) throw Object.assign(new Error('الفيديو غير موجود'), { status: 404 });
  if (job.status === 'processing') throw Object.assign(new Error('لا يمكن حذف فيديو قيد المعالجة'), { status: 409 });
  jobs.delete(id);
}

export function getStats() {
  const all = [...jobs.values()];
  return {
    total: all.length,
    completed: all.filter((j) => j.status === 'completed').length,
    processing: all.filter((j) => j.status === 'processing' || j.status === 'queued').length,
    failed: all.filter((j) => j.status === 'failed').length,
    providers: providersStatus(),
  };
}

function resolveVoice(voiceId?: string): Voice {
  const v = voiceId ? VOICES.find((x) => x.id === voiceId) : undefined;
  if (voiceId && !v) throw Object.assign(new Error('الصوت غير موجود'), { status: 400 });
  const voice = v || DEFAULT_VOICE;
  if (voice.engine === 'google' && !process.env.GOOGLE_TTS_KEY) {
    throw Object.assign(new Error('صوت Google يتطلب إضافة GOOGLE_TTS_KEY'), { status: 400 });
  }
  return voice;
}

export function createJob(featureId: string, voiceId?: string): VideoJob {
  const feature = features.get(featureId);
  if (!feature) throw Object.assign(new Error('المميزة غير موجودة'), { status: 404 });
  if (!feature.enabled) throw Object.assign(new Error('المميزة معطّلة'), { status: 400 });

  const active = [...jobs.values()].find((j) => j.featureId === featureId && (j.status === 'queued' || j.status === 'processing'));
  if (active) throw Object.assign(new Error('يوجد إنتاج جارٍ لهذه المميزة بالفعل'), { status: 409 });

  const voice = resolveVoice(voiceId);
  const job: VideoJob = {
    id: randomUUID(),
    featureId,
    featureName: feature.nameAr,
    status: 'queued',
    stage: 'script',
    stageLabel: 'في قائمة الانتظار',
    progress: 0,
    simulated: false,               // Edge TTS متاح دائماً — كل إنتاج حقيقي
    voiceLabel: voice.label,
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  trimJobs();
  void runPipeline(job, feature, voice);
  return job;
}

export function createBatch(featureIds: string[], voiceId?: string): { created: VideoJob[]; skipped: { featureId: string; reason: string }[] } {
  const created: VideoJob[] = [];
  const skipped: { featureId: string; reason: string }[] = [];
  for (const id of featureIds) {
    try { created.push(createJob(id, voiceId)); }
    catch (e) { skipped.push({ featureId: id, reason: (e as Error).message }); }
  }
  return { created, skipped };
}

// ————————————————— خط الإنتاج —————————————————

async function runPipeline(job: VideoJob, feature: VideoFeature, voice: Voice): Promise<void> {
  const p = providersStatus();
  try {
    job.status = 'processing';

    // 1) تجهيز السيناريو
    setStage(job, 'script', 'تجهيز السيناريو', 5);
    await sleep(400);
    job.progress = 10;

    // 2) التعليق الصوتي العربي — المُنتَج الأساسي (Edge افتراضياً، أو Google)
    setStage(job, 'tts', `توليد التعليق الصوتي (${voice.label})`, 20);
    await progressTo(job, 55, 1200);
    job.audioUrl = voice.engine === 'google'
      ? await googleTts(feature.script, job.id, voice.name)
      : await edgeTts(feature.script, job.id, voice.name);
    job.progress = Math.max(job.progress, 70);

    // 3) فيديو Avatar — ترقية اختيارية (HeyGen، عند توفّر رصيد API مدفوع)
    if (p.avatar) {
      setStage(job, 'avatar', 'إنشاء فيديو المتحدّث (HeyGen) — قد يستغرق دقائق', 72);
      job.outputUrl = await heygenVideo(feature.script, job);
      job.progress = 95;
    }

    // 4) الإنهاء
    setStage(job, 'merge', p.avatar ? 'الإنهاء والتجهيز للنشر' : 'تجهيز التعليق الصوتي للتحميل', 95);
    await sleep(400);

    job.stage = 'done';
    job.stageLabel = 'اكتمل';
    job.progress = 100;
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
  } catch (e) {
    job.status = 'failed';
    job.stageLabel = 'فشل';
    job.error = (e as Error).message;
  }
}

// ————— Microsoft Edge Neural TTS (مجاني، بلا مفتاح) —————
// أصوات عربية عصبية عالية الجودة؛ يُحفظ MP3 في /media/promo/<jobId>.mp3
async function edgeTts(text: string, jobId: string, voiceName: string): Promise<string> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on('data', (c: Buffer) => chunks.push(c));
    audioStream.on('end', () => resolve());
    audioStream.on('error', reject);
    setTimeout(() => reject(new Error('انتهت مهلة Edge TTS (30 ثانية)')), 30000);
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('Edge TTS لم يُرجع صوتاً');
  writeFileSync(path.join(MEDIA_DIR, `${jobId}.mp3`), buf);
  return `/media/promo/${jobId}.mp3`;
}

// ————— Google Cloud Text-to-Speech (REST بمفتاح API) —————
// صوت WaveNet احترافي؛ يُحفظ MP3 في /media/promo/<jobId>.mp3
async function googleTts(text: string, jobId: string, voiceName: string): Promise<string> {
  const key = process.env.GOOGLE_TTS_KEY!;
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ar-XA', name: voiceName },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google TTS رفض الطلب (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) throw new Error('Google TTS لم يُرجع صوتاً');
  const file = path.join(MEDIA_DIR, `${jobId}.mp3`);
  writeFileSync(file, Buffer.from(data.audioContent, 'base64'));
  return `/media/promo/${jobId}.mp3`;
}

// ————— HeyGen: توليد فيديو Avatar من النص —————
// يُحدّد Avatar وصوتاً عربياً تلقائياً من الحساب إن لم يُضبطا في البيئة، ثم يولّد
// الفيديو (عمودي 720×1280 مناسب لـ Shorts/Reels/TikTok) ويستقصي الحالة حتى الاكتمال.
const HEYGEN = 'https://api.heygen.com';
let heygenDefaults: { avatarId: string; voiceId: string } | null = null;

async function heygenHeaders() {
  return { 'X-Api-Key': process.env.HEYGEN_API_KEY!, 'Content-Type': 'application/json' };
}

async function resolveHeygenDefaults(): Promise<{ avatarId: string; voiceId: string }> {
  const envAvatar = process.env.HEYGEN_AVATAR_ID;
  const envVoice = process.env.HEYGEN_VOICE_ID;
  if (envAvatar && envVoice) return { avatarId: envAvatar, voiceId: envVoice };
  if (heygenDefaults) return {
    avatarId: envAvatar || heygenDefaults.avatarId,
    voiceId: envVoice || heygenDefaults.voiceId,
  };

  const headers = await heygenHeaders();
  let avatarId = envAvatar || '';
  let voiceId = envVoice || '';

  if (!avatarId) {
    const r = await fetch(`${HEYGEN}/v2/avatars`, { headers });
    if (!r.ok) throw new Error(`HeyGen: تعذّر جلب قائمة الـAvatars (${r.status}) — تأكد من صحة المفتاح`);
    const d = (await r.json()) as { data?: { avatars?: { avatar_id: string }[] } };
    avatarId = d.data?.avatars?.[0]?.avatar_id || '';
    if (!avatarId) throw new Error('HeyGen: لا يوجد Avatar في حسابك — أضف واحداً من heygen.com أو اضبط HEYGEN_AVATAR_ID');
  }

  if (!voiceId) {
    const r = await fetch(`${HEYGEN}/v2/voices`, { headers });
    if (!r.ok) throw new Error(`HeyGen: تعذّر جلب قائمة الأصوات (${r.status})`);
    const d = (await r.json()) as { data?: { voices?: { voice_id: string; language?: string }[] } };
    const voices = d.data?.voices || [];
    // أول صوت عربي؛ وإلا أول صوت متاح
    voiceId = (voices.find((v) => /arabic|العربية/i.test(v.language || '')) || voices[0])?.voice_id || '';
    if (!voiceId) throw new Error('HeyGen: لا توجد أصوات متاحة في حسابك');
  }

  heygenDefaults = { avatarId, voiceId };
  return heygenDefaults;
}

async function heygenVideo(script: string, job: VideoJob): Promise<string> {
  const headers = await heygenHeaders();
  const { avatarId, voiceId } = await resolveHeygenDefaults();

  // إنشاء الطلب
  const createRes = await fetch(`${HEYGEN}/v2/video/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: voiceId },
        background: { type: 'color', value: '#FAF7F0' },
      }],
      dimension: { width: 720, height: 1280 },
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`HeyGen رفض إنشاء الفيديو (${createRes.status}): ${body.slice(0, 300)}`);
  }
  const created = (await createRes.json()) as { data?: { video_id?: string }; error?: { message?: string } };
  const videoId = created.data?.video_id;
  if (!videoId) throw new Error(`HeyGen لم يُرجع معرّف فيديو${created.error?.message ? `: ${created.error.message}` : ''}`);

  // استقصاء الحالة حتى الاكتمال (حد أقصى ~12 دقيقة) مع تقدّم حي في اللوحة
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    // تقدّم تدريجي 40→88 أثناء المعالجة لدى HeyGen
    if (job.progress < 88) job.progress = Math.min(88, job.progress + 2);

    const st = await fetch(`${HEYGEN}/v1/video_status.get?video_id=${videoId}`, { headers });
    if (!st.ok) continue; // تعثّر مؤقت في الاستقصاء — نُعيد المحاولة
    const s = (await st.json()) as { data?: { status?: string; video_url?: string; error?: { message?: string } | null } };
    const status = s.data?.status;

    if (status === 'completed' && s.data?.video_url) {
      // تنزيل الملف محلياً (روابط HeyGen مؤقتة الصلاحية)
      job.stageLabel = 'تنزيل الفيديو النهائي';
      const dl = await fetch(s.data.video_url);
      if (!dl.ok) throw new Error('تعذّر تنزيل الفيديو من HeyGen');
      const buf = Buffer.from(await dl.arrayBuffer());
      const file = path.join(MEDIA_DIR, `${job.id}.mp4`);
      writeFileSync(file, buf);
      return `/media/promo/${job.id}.mp4`;
    }
    if (status === 'failed') {
      throw new Error(`HeyGen فشل في توليد الفيديو${s.data?.error?.message ? `: ${s.data.error.message}` : ''}`);
    }
  }
  throw new Error('انتهت مهلة انتظار HeyGen (12 دقيقة) — أعد المحاولة');
}

// ————— أدوات مساعدة —————

function setStage(job: VideoJob, stage: JobStage, label: string, progress: number) {
  job.stage = stage;
  job.stageLabel = label;
  job.progress = Math.max(job.progress, progress);
}

// تقدّم تدريجي سلس حتى نسبة مستهدفة خلال مدة معيّنة (للمراحل المحاكاة)
async function progressTo(job: VideoJob, target: number, durationMs: number) {
  const start = job.progress;
  const steps = Math.max(2, Math.round(durationMs / 400));
  for (let i = 1; i <= steps; i++) {
    await sleep(durationMs / steps);
    job.progress = Math.round(start + ((target - start) * i) / steps);
  }
}

function trimJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const oldest = [...jobs.values()]
    .filter((j) => j.status === 'completed' || j.status === 'failed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const j of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
