// ============================================================================
// صورة «نموذج الشركة المطبوع مسبقاً» للطباعة (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — الخلفية الاختيارية تحت القيم (ورقٌ أبيض أو تجربة).
//
// · البايتات في جدولٍ مستقل يقدّمها الخادم على GET /company/print-forms/:id بتوكن الجلسة — فلا <img src="/api/…"> (لا يحمل التوكن):
//   تُجلب بعميل الواجهة (المندوب repApi، واللوحة و/m عميل api — **الجالب محقون**) وتصير data URL تحمله الورقة إلى إطار الطباعة.
// · الذاكرة المؤقتة بالبصمة (v = sha256): المندوب في IndexedDB (rep/offlineDb: cacheSet/cacheGet بمفتاح «formimg:<v>») فتُطبع
//   الخلفية أوف‑لاين بعد أول جلب، واللوحة في الذاكرة وحدها. والبصمة ثابتة لكل صورة فلا تُجلب مرّتين.
// · التعذّر (شبكة، 404 بعد الحذف، ردٌّ ليس صورة) لا يمنع الطباعة أبداً: الورقة تُطبع بالقيم وحدها بلا خلفية، والحالة «failed»
//   علمٌ يقرؤه القالب (data-form-bg) وشاشة النتيجة (تنبيه). ولا يُحفظ الفشل: المحاولة التالية تجلب من جديد.
// · الصورة دليلٌ لا مستند: لا تُفحص هنا أبعادها (يحفظها الخادم)، بل نوعها بالبايتات (JPEG/PNG/WebP) وحجمها.
// ============================================================================

import { createContext, useContext, useEffect, useState } from 'react';
import { FORM_IMAGE_ID_RE, FORM_IMAGE_V_RE, type FormImageRef } from './printSettingsCore';

/** ما يعيده الجالب: Blob من axios (responseType: 'blob') أو بايتات */
export type FormImageBytes = Blob | ArrayBuffer | Uint8Array;
/** جلب صورة النموذج بمعرّفها — يرمي عند التعذّر */
export type FormImageFetch = (id: string) => Promise<FormImageBytes>;
/** ذاكرةٌ دائمة لنصّ data URL بمفتاحه (المندوب: IndexedDB) — قراءةٌ لا ترمي (null) وكتابةٌ قد ترمي فتُتجاهل */
export interface FormImageStore {
  get(key: string): Promise<string | null>;
  set(key: string, dataUrl: string): Promise<void>;
}

/** سقف ما يُقبل من الخادم (يحفظ الخادم 1.5 ميغابايت على الأكثر) */
export const FORM_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** مفتاح الذاكرة الدائمة: البصمة وحدها (المعرّف قد يتغيّر لصورةٍ رُفعت ثانيةً بالبايتات نفسها) */
export const formImageCacheKey = (v: string): string => `formimg:${v}`;
/** مسار الصورة على الواجهة البرمجية (بعد /api) */
export const formImagePath = (id: string): string => `/company/print-forms/${encodeURIComponent(id)}`;

export type FormImageStatus = 'none' | 'loading' | 'ready' | 'failed';
export interface FormImageState {
  status: FormImageStatus;
  /** data URL للصورة متى status = 'ready' */
  src: string | null;
}
const NONE: FormImageState = { status: 'none', src: null };
const LOADING: FormImageState = { status: 'loading', src: null };
const FAILED: FormImageState = { status: 'failed', src: null };

/** مرجعٌ صالح بقواعد النواة (معرّف uuid وبصمة سداسية) — وغيره لا يُجلب أبداً */
export function formImageRefOk(ref: FormImageRef | null | undefined): ref is FormImageRef {
  return !!ref && typeof ref.id === 'string' && FORM_IMAGE_ID_RE.test(ref.id) && typeof ref.v === 'string' && FORM_IMAGE_V_RE.test(ref.v);
}

export type FormImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** نوع الصورة من بايتاتها الأولى (لا من الترويسة): JPEG FF D8 FF، PNG 89 50 4E 47، WebP RIFF….WEBP — وغيرها null */
export function sniffFormImageMime(b: Uint8Array): FormImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 بلا btoa ولا FileReader (يعمل في المتصفّح والاختبار) */
export function bytesToBase64(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
}

const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
/** نصّ data URL لصورةٍ من الأنواع الثلاثة (ما يُقبل من الذاكرة الدائمة) */
export const isFormImageDataUrl = (v: unknown): v is string => typeof v === 'string' && v.length < FORM_IMAGE_MAX_BYTES * 2 && DATA_URL_RE.test(v);

async function bytesOf(x: FormImageBytes): Promise<Uint8Array> {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x && typeof (x as Blob).arrayBuffer === 'function') return new Uint8Array(await (x as Blob).arrayBuffer());
  throw new Error('form image: not bytes');
}

/** بايتات الصورة ⇒ data URL بنوعها المفحوص — يرمي لما ليس صورةً أو تجاوز السقف أو كان فارغاً */
export async function formImageDataUrl(x: FormImageBytes): Promise<string> {
  const b = await bytesOf(x);
  if (b.length === 0 || b.length > FORM_IMAGE_MAX_BYTES) throw new Error('form image: size');
  const mime = sniffFormImageMime(b);
  if (!mime) throw new Error('form image: type');
  return `data:${mime};base64,${bytesToBase64(b)}`;
}

export interface FormImageLoader {
  /** الحالة الآن بلا جلب: جاهزة من الذاكرة، أو قيد الجلب، أو فشل آخر جلب، أو لا شيء */
  peek(ref: FormImageRef | null | undefined): FormImageState;
  /** data URL للصورة أو null عند التعذّر — لا يرمي أبداً؛ والجلب الواحد يُشارَك بين الطالبين */
  load(ref: FormImageRef | null | undefined): Promise<string | null>;
}

export interface FormImageLoaderOptions {
  fetch: FormImageFetch;
  /** الذاكرة الدائمة (المندوب) — null/غياب: الذاكرة وحدها (اللوحة) */
  store?: FormImageStore | null;
}

/** مُحمِّل صور النموذج بجالبٍ محقون — ذاكرةٌ بالبصمة، وجلبٌ واحد مشترك، وذاكرةٌ دائمة اختيارية، والفشل لا يُحفظ */
export function createFormImageLoader(opts: FormImageLoaderOptions): FormImageLoader {
  const ready = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const failed = new Set<string>();
  const store = opts.store ?? null;

  const fromStore = async (v: string): Promise<string | null> => {
    if (!store) return null;
    try {
      const s = await store.get(formImageCacheKey(v));
      return isFormImageDataUrl(s) ? s : null;
    } catch {
      return null;
    }
  };

  const run = async (ref: FormImageRef): Promise<string | null> => {
    try {
      const cached = await fromStore(ref.v);
      if (cached) return cached;
      const url = await formImageDataUrl(await opts.fetch(ref.id));
      if (store) {
        try { await store.set(formImageCacheKey(ref.v), url); } catch { /* الذاكرة الدائمة تحسينٌ لا شرط */ }
      }
      return url;
    } catch {
      return null;
    }
  };

  return {
    peek(ref) {
      if (!formImageRefOk(ref)) return ref ? FAILED : NONE;
      const src = ready.get(ref.v);
      if (src) return { status: 'ready', src };
      if (inflight.has(ref.v)) return LOADING;
      return failed.has(ref.v) ? FAILED : NONE;
    },
    load(ref) {
      if (!formImageRefOk(ref)) return Promise.resolve(null);
      const v = ref.v;
      const hit = ready.get(v);
      if (hit) return Promise.resolve(hit);
      const cur = inflight.get(v);
      if (cur) return cur;
      const p = run(ref).then((url) => {
        inflight.delete(v);
        if (url) { ready.set(v, url); failed.delete(v); } else failed.add(v);
        return url;
      });
      inflight.set(v, p);
      return p;
    },
  };
}

// ─── المُحمِّل الافتراضي لكل مساحة: المندوب (/rep) بعميله وIndexedDB، وغيره (اللوحة و/m) بعميل api وذاكرةٍ وحدها ───

type Space = 'rep' | 'admin';
const loaders: Partial<Record<Space, FormImageLoader>> = {};

/** مساحة الجلسة من المسار (مرآة printIdentityFrom/sessionSpace بلا استيراد المتجر) */
export function formImageSpaceOf(pathname: string): Space {
  return pathname === '/rep' || pathname.startsWith('/rep/') ? 'rep' : 'admin';
}

/* العميلان والذاكرة يُحمَّلون عند أول جلبٍ فعليّ وحده (استيرادٌ متأخّر): هذا الملف يدخل حزمة القوالب فلا يجرّ متجر الجلسة ولا عميلاً
 * إلى من لا يطبع بالخلفية — ولا يُستورد في الاختبار ولا في تصيير الخادم */
const repFetch: FormImageFetch = async (id) => {
  const { default: repApi } = await import('../../rep/repApi');
  // طلبٌ خلفيّ: فشله (401 عابر) لا يُخرج المندوب
  const r = await repApi.get(formImagePath(id), { responseType: 'blob', background: true });
  return r.data as Blob;
};
const adminFetch: FormImageFetch = async (id) => {
  const { default: api } = await import('../../api/client');
  const r = await api.get(formImagePath(id), { responseType: 'blob' });
  return r.data as Blob;
};
const repStore: FormImageStore = {
  async get(key) {
    const { cacheGet } = await import('../../rep/offlineDb');
    const row = await cacheGet<unknown>(key);
    return typeof row?.data === 'string' ? row.data : null;
  },
  async set(key, dataUrl) {
    const { cacheSet } = await import('../../rep/offlineDb');
    await cacheSet(key, dataUrl);
  },
};

/** المُحمِّل الافتراضي لمساحة الصفحة الحالية — واحدٌ لكل مساحة طوال الجلسة */
export function defaultFormImageLoader(pathname?: string): FormImageLoader {
  const path = pathname ?? (typeof window !== 'undefined' && window.location ? window.location.pathname : '/');
  const space = formImageSpaceOf(path);
  const hit = loaders[space];
  if (hit) return hit;
  const made = space === 'rep' ? createFormImageLoader({ fetch: repFetch, store: repStore }) : createFormImageLoader({ fetch: adminFetch });
  loaders[space] = made;
  return made;
}

/** حقن مُحمِّلٍ غير الافتراضي (معاينة المصمّم، الاختبار) — null: الافتراضي */
export const FormImageLoaderContext = createContext<FormImageLoader | null>(null);

export function useFormImageLoader(): FormImageLoader {
  return useContext(FormImageLoaderContext) ?? defaultFormImageLoader();
}

/**
 * حالة صورة النموذج للعرض والطباعة: ref = null (لا خلفية مطلوبة أو لا صورة) ⇒ 'none'. الجاهزة في الذاكرة تُرسم من أول تصيير (peek)،
 * وغيرها تُجلب بعد التركيب — والفشل 'failed' (تُطبع الورقة بلا خلفية).
 */
export function useFormImage(ref: FormImageRef | null | undefined): FormImageState {
  const loader = useFormImageLoader();
  const id = ref?.id ?? null;
  const v = ref?.v ?? null;
  const [state, setState] = useState<FormImageState>(() => (ref ? loader.peek(ref) : NONE));
  useEffect(() => {
    if (!ref) { setState(NONE); return undefined; }
    const now = loader.peek(ref);
    if (now.status === 'ready') { setState(now); return undefined; }
    let alive = true;
    setState(LOADING);
    void loader.load(ref).then((src) => { if (alive) setState(src ? { status: 'ready', src } : FAILED); });
    return () => { alive = false; };
    // المرجع يتجدّد كائناً مع كل تصيير — المعرّف والبصمة هما الهوية
  }, [loader, id, v]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref ? state : NONE;
}

/** مرجع صورة الخلفية المطلوب طباعتها من نموذج — null بلا خلفية أو بلا صورة */
export function formBackgroundRef(form: { background?: boolean; image?: FormImageRef | null } | null | undefined): FormImageRef | null {
  return form?.background === true && form.image ? form.image : null;
}

/** جلب صور الخلفية مسبقاً (تطبيق المندوب بعد تحميل إعدادات الشركة) لتُطبع أوف‑لاين — بلا انتظارٍ ولا رمي */
export function prefetchFormImages(loader: FormImageLoader, refs: ReadonlyArray<FormImageRef | null | undefined>): Promise<void> {
  return Promise.all(refs.filter(formImageRefOk).map((r) => loader.load(r))).then(() => undefined, () => undefined);
}

/**
 * مراجع صور الخلفية في إعدادات الطباعة الخام (company.printSettings): كل قالبٍ بتصميم النموذج المطبوع مسبقاً وخلفيته مفعّلة — بلا تكرار.
 * قراءةٌ دفاعية لا تتحقّق من الإعداد كله (يتحقّق منه normalizePrintSettings).
 */
export function formBackgroundRefsOf(rawSettings: unknown): FormImageRef[] {
  const profiles = (rawSettings as { profiles?: unknown } | null | undefined)?.profiles;
  if (!Array.isArray(profiles)) return [];
  const out: FormImageRef[] = [];
  const seen = new Set<string>();
  for (const p of profiles) {
    const l = (p as { options?: { layout?: { design?: unknown; form?: unknown } } } | null)?.options?.layout;
    if (!l || l.design !== 'preprinted') continue;
    const ref = formBackgroundRef(l.form as { background?: boolean; image?: FormImageRef | null } | null);
    if (formImageRefOk(ref) && !seen.has(ref.v)) { seen.add(ref.v); out.push(ref); }
  }
  return out;
}
