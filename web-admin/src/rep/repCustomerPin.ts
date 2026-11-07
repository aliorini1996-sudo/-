/**
 * دبوس العميل في تطبيق المندوب — «التقاط موقعي الحالي عند العميل» في إضافة العميل وتعديله (RepApp.tsx)
 * (تدقيق «لا يعمل إلا بـ٣٠٠» البنود R2 وPIN-2 وPIN-3، ٧ نوفمبر ٢٠٢٦ — قرار المالك «أصلح الخلل فقط»).
 *
 * كان الزرّ يقرأ getCurrentPosition بقراءةٍ مخبّأة عمرها حتى ٣٠ ثانية، ويأخذ أوّل ما يصل ويرمي دقّته — فيُحفظ دبوسٌ من
 * الشارع أو من الواي‑فاي، وتُرفض بعده بصمة المندوب الصادقة عند الباب بنطاق ٥٠ وتُقبل بـ٣٠٠. وفي الإضافة كان الرابط
 * الملصوق يُرسَل مع الالتقاط فيطغى عليه في الخادم.
 * الآن:
 *  • القراءة من المراقبة الدقيقة المشتركة (precisePinFix في punchFix.ts): بلا مخبّأ وأدقّ ما وصل ومعه دقّته.
 *  • الدقّة تُعرض «±N م»، وما أضعف من PIN_WARN_M يُنبَّه عليه مع «أعد الالتقاط» — تنبيهٌ لا منع. والتقريبي (بالكيلومتر)
 *    يُقال له «فعّل الموقع الدقيق».
 *  • الالتقاط والرابط لا يجتمعان: الالتقاط يمحو الرابط، ولصق رابطٍ يمحو الالتقاط ويُبطل التقاطاً جارياً — فما يراه
 *    المندوب هو ما يُرسَل وحده. وحرفٌ عابر ليس رابطاً لا يمحو التقاطاً (looksLikeLocationLink)، وتحت الخانة تنبيهٌ بذلك.
 *  • لا شيء هنا يغيّر ما يقبله الخادم أو يرفضه، ولا يُرسَل موقعٌ لم يغيّره المندوب (تعديل الحقول الأخرى لا يحرّك الدبوس).
 *
 * صرفٌ بلا DOM ولا شبكة — والتنفيذ في RepApp.tsx عبر useReducer.
 */

import { pinAccuracyLevel, PIN_WARN_M, type PinFix, type PunchFixReason } from './punchFix';

/** idle = لا التقاط · getting = جارٍ · ok = التُقط · denied = الإذن مرفوض أو لا تحديد موقع · failed = لا قراءة في المهلة */
export type PinGps = 'idle' | 'getting' | 'ok' | 'denied' | 'failed';

export interface RepPinState {
  /** الإحداثيات المرسلة — من الالتقاط (بدقّته) أو المعبّأة من خريطة Google (بلا دقّة) */
  coords: PinFix | null;
  /** الرابط الملصوق — لا يجتمع مع coords */
  locUrl: string;
  gps: PinGps;
  /** رقم الالتقاط الجاري: لصق رابطٍ يرفعه فتُهمَل قراءةٌ وصلت بعده */
  seq: number;
  /** الموقع معبّأ من خريطة Google (المندوب ليس عند الباب) — يزول الوسم بأول التقاط */
  fromMap: boolean;
  /** coords من التقاطٍ في هذه الشاشة (فدقّته تُعرض ويُنبَّه عليها) — لا المعبّأ من المندوب الذكي */
  captured: boolean;
}

export type RepPinAction =
  | { type: 'start' }
  | { type: 'done'; seq: number; fix: PinFix | null; reason: PunchFixReason }
  | { type: 'link'; url: string };

/** الحالة الأولى — prefill من المندوب الذكي (موقعٌ من الخريطة) أو لا شيء */
export function initialRepPin(prefill?: { lat?: number | null; lng?: number | null; pinFromMap?: boolean } | null): RepPinState {
  const has = prefill?.lat != null && prefill?.lng != null;
  return {
    coords: has ? { lat: prefill!.lat as number, lng: prefill!.lng as number, accuracy: null } : null,
    locUrl: '',
    gps: has ? 'ok' : 'idle',
    seq: 0,
    fromMap: has && !!prefill?.pinFromMap,
    captured: false,
  };
}

/**
 * نصٌّ يصلح موقعاً يحلّه الخادم (services/geoLink.ts): رابطٌ (http(s):// أو www. أو نطاق خرائط) أو «lat,lng» ملصوقة —
 * فهو وحده ما يحلّ محلّ الالتقاط
 */
export function looksLikeLocationLink(text: string): boolean {
  const t = text.trim();
  return /^(https?:\/\/|www\.)/i.test(t)
    || /(^|[\s/.])(maps\.app\.goo\.gl|goo\.gl|maps\.google\.|google\.[a-z.]+\/maps|maps\.apple\.com)/i.test(t)
    || /^-?\d{1,3}(\.\d+)?\s*[,،]\s*-?\d{1,3}(\.\d+)?$/.test(t);
}

export function repPinReducer(s: RepPinState, a: RepPinAction): RepPinState {
  switch (a.type) {
    case 'start':
      // ضغطةٌ ثانية أثناء الالتقاط لا تفتح مراقبةً ثانية
      if (s.gps === 'getting') return s;
      return { ...s, gps: 'getting', seq: s.seq + 1 };
    case 'done':
      // قراءةٌ لالتقاطٍ أبطله رابطٌ لُصق بعده (أو التقاطٌ أحدث): لا تمحو ما اختاره المندوب
      if (a.seq !== s.seq || s.gps !== 'getting') return s;
      if (a.fix) return { ...s, coords: a.fix, locUrl: '', gps: 'ok', fromMap: false, captured: true };
      // فشلٌ يُبقي الالتقاط السابق إن وُجد — إعادة الالتقاط لا تمحو دبوساً جيّداً
      return { ...s, gps: a.reason === 'denied' || a.reason === 'no-geo' ? 'denied' : 'failed' };
    case 'link': {
      if (!a.url.trim()) return { ...s, locUrl: a.url };
      // حرفٌ عابر في الخانة (لمسةٌ خاطئة) ليس رابطاً: لا يمحو التقاطاً دقيقاً أخذ نصف دقيقة ولا يُبطل التقاطاً جارياً —
      // والحمولة تبقى الإحداثيات (repPinPayload)، وما ليس رابطاً لا يحلّه الخادم أصلاً
      if ((s.coords || s.gps === 'getting') && !looksLikeLocationLink(a.url)) return { ...s, locUrl: a.url };
      // رابطٌ ملصوق يحلّ محلّ الالتقاط ويُبطل التقاطاً جارياً — الخادم كان يقدّم الرابط على الإحداثيات بصمت
      return { ...s, locUrl: a.url, coords: null, fromMap: false, captured: false, gps: 'idle', seq: s.seq + 1 };
    }
  }
}

/** حقول الموقع في الحمولة: الإحداثيات أو الرابط — لا يجتمعان، ولا شيء بلا اختيار (فيبقى المحفوظ كما هو) */
export function repPinPayload(s: Pick<RepPinState, 'coords' | 'locUrl'>): { lat?: number; lng?: number; locationUrl?: string } {
  if (s.coords) return { lat: s.coords.lat, lng: s.coords.lng };
  const url = s.locUrl.trim();
  return url ? { locationUrl: url } : {};
}

/**
 * ما يُعرض تحت الدبوس الملتقط:
 *  - accM: الدقّة «±N م» مقرّبةً لا تقلّ عن ١ — null إن لم تُعرف (أو الموقع من الخريطة).
 *  - notice: none = دقيق · weak = أضعف من PIN_WARN_M · unknown = التقاطٌ بلا دقّة معلومة · coarse = تقريبي (فعّل الدقيق).
 *  ما لم يُلتقط في هذه الشاشة (المعبّأ من المندوب الذكي: من الخريطة بوسمه الخاص، أو من GPS الباب) لا يُنبَّه عليه هنا.
 */
export type RepPinNotice = 'none' | 'weak' | 'unknown' | 'coarse';
export function repPinView(s: Pick<RepPinState, 'coords' | 'captured'>): { accM: number | null; notice: RepPinNotice } {
  if (!s.coords || !s.captured) return { accM: null, notice: 'none' };
  const acc = s.coords.accuracy;
  if (acc == null || !Number.isFinite(acc) || acc < 0) return { accM: null, notice: 'unknown' };
  // الدرجة على الرقم المعروض نفسه (كـmPinLevel في /m): لا «±30 م» بجانب «أضعف من 30 م»، ولا «±1000 م» بغير نصّ التقريبي
  const accM = Math.max(1, Math.round(acc));
  const level = pinAccuracyLevel(accM);
  if (level === 'coarse') return { accM, notice: 'coarse' };
  return { accM, notice: level === 'poor' ? 'weak' : 'none' };
}

/**
 * نصوص الدبوس (مفاتيح tr) — {m} يُستبدل بـPIN_WARN_M. مشتركةٌ مع تطبيق الإدارة /m (m/mCustomerPin.ts): التنبيه نفسه بالصياغة
 * نفسها في الشاشتين، ونصّ التقريبي لا يسمّي تطبيقاً (المندوب قد يعمل من Chrome أو سفاري والإعداد للمتصفّح).
 */
export const REP_PIN_TEXTS = {
  weak: 'دقة الموقع أضعف من {m} م وقد يزاح دبوس العميل — قف عند باب المحل في مكان مكشوف ثم أعد الالتقاط',
  unknown: 'لم يعط جوالك دقة هذا الموقع وقد يزاح دبوس العميل — قف عند باب المحل في مكان مكشوف ثم أعد الالتقاط',
  coarse: 'موقع جوالك تقريبي لا دقيق — فعّل الموقع الدقيق من إعدادات الموقع في جوالك ثم أعد الالتقاط',
  retake: 'أعد الالتقاط',
  denied: 'تعذر الوصول للموقع الصق الرابط أدناه بدلا منه',
  // فشل إعادة الالتقاط والدبوس السابق باقٍ: لا يُنصح بلصق رابطٍ يمحوه
  deniedKept: 'تعذر تحديد الموقع فعل الإذن',
  failed: 'تعذر تحديد موقعك اقترب من نافذة او مكان مفتوح ثم اعد المحاولة',
  // تحت خانة الرابط ما دام للعميل التقاطٌ في الشاشة
  linkReplaces: 'لصق رابط يلغي الموقع الملتقط',
} as const;

export const REP_PIN_WARN_M = PIN_WARN_M;
