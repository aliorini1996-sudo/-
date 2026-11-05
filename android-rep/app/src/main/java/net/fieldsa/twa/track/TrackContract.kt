package net.fieldsa.twa.track

/**
 * عقد التتبّع الخلفي مع الويب والآيفون (طلب المالك، ٤ نوفمبر ٢٠٢٦) — كل قيمةٍ مشتركة هنا نظيرُها حرفياً في
 * web-admin/src/rep/nativeTracking.ts (يحرسها nativeTracking.test.ts) وفي FieldSales/TrackService.swift وTrackBridge.swift.
 * تغيير قيمةٍ دون الأخرى يوقف التتبّع بصمت.
 *
 *   البدء:   intent://start?t=<رمز التتبّع>#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end
 *   الإيقاف: intent://stop#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end
 */
object TrackContract {
    const val SCHEME = "fieldsatrack"
    const val HOST_START = "start"
    const val HOST_STOP = "stop"
    /** رمز التتبّع (JWT عمره ٢٠ ساعة من POST /api/tracking/device-token) */
    const val PARAM_TOKEN = "t"
    /** تبديل عنوان الرفع — في بناء التطوير وحده (BuildConfig.DEBUG)، ويُهمل في الإصدار */
    const val PARAM_DEBUG_URL = "u"
    /** يضيفه LauncherActivity لعنوان الإقلاع: «هذه النسخة تحمل خدمة التتبّع» — الصفحة تحفظه وتحذفه (captureTrackLaunch) */
    const val LAUNCH_PARAM = "fstrack"
    const val LAUNCH_VALUE = "1"
    const val PACKAGE = "net.fieldsa.twa"

    /** نقطة رفع التطبيقين (backend/src/routes/trackDevice.ts) — بلا جلسة، برمز التتبّع في Authorization: Bearer */
    const val PING_URL = "https://api.fieldsa.net/api/track-device/ping"
    /** ساعة الجهاز لحظة الإرسال (ISO-8601 UTC) — الترويسة نفسها التي ترسلها الصفحة (backend/src/services/liveLocation.ts) */
    const val DEVICE_NOW_HEADER = "x-fs-device-now"
    /**
     * الرفع الأخير حين تتوقف الخدمة (onDestroy في أندرويد، send(closing: true) في الآيفون) وحده يحمل هذه الترويسة بالقيمة
     * FINAL_VALUE: الخادم (backend/src/routes/trackDevice.ts) يخزّن نقاطه ثم ينسى علامة «التطبيق يرفع» بدل تجديدها. بدونها
     * يبقى المندوب «يرفع من التطبيق» ٩٠ ثانية بعد خروجه، فإن دخل ثانيةً خلالها لم تطلب الصفحة بدءاً جديداً بقية اليوم.
     */
    const val FINAL_HEADER = "x-fs-track-final"
    const val FINAL_VALUE = "1"

    /** فاصل القراءة من مزوّد الموقع */
    const val SAMPLE_INTERVAL_MS = 5_000L
    /** المتحرّك: نقطةٌ كل ١٥ ثانية متى ابتعد ٢٠ متراً عن آخر نقطة محفوظة */
    const val MOVING_KEEP_MS = 15_000L
    const val MOVE_THRESHOLD_M = 20.0
    /**
     * الثابت: نقطة نبضٍ كل ٣٠ ثانية — فاصل الساكن نفسه في الصفحة (web-admin/src/rep/trackUpload.ts IDLE_GAP_MS).
     * «موقع مباشر» في خريطة المدير نافذته دقيقتان (liveRepStatus.ts LOCATION_FRESH_MS)، ونقاط الصفحة لا تُخزَّن ما دام
     * التطبيق يرفع: نبضٌ أبطأ كان يقلب المندوب الواقف عند عميلٍ «موقعه متوقف» بين نبضتين.
     */
    const val STATIONARY_HEARTBEAT_MS = 30_000L
    /** قراءةٌ أسوأ دقّةً من هذا تُسقط */
    const val MAX_ACCURACY_M = 500.0

    /**
     * الرفع كل ٣٠ ثانية بالساعة المنقضية (elapsedRealtime، تحسب نوم المعالج)، وأول نقطةٍ بعد البدء فوراً. في أندرويد تقيسه
     * قراءات الموقع نفسها لا مؤقّتٌ: الشاشة مقفلة تُنيم المعالج بين القراءات، ومؤقّت Handler يعدّ وقت اليقظة وحده فيتمدّد لدقائق
     */
    const val UPLOAD_INTERVAL_MS = 30_000L
    /** سقف الدفعة عند الخادم (pingSchema: max 200) */
    const val MAX_BATCH = 200
    /** سقف الطابور المحفوظ على الجوال: الأقدم يُسقط */
    const val MAX_QUEUED = 3_000

    /**
     * التراجع بعد خطأ الشبكة أو 5xx أو 429 أو 401/403 من وسيط: ٣٠ ← ٦٠ ← ١٢٠ ثانية ثم يبقى ١٢٠ — حدّ الصفحة نفسه
     * (web-admin/src/rep/trackUpload.ts RETRY_MAX_MS). حدّ ٣٠٠ ثانية أبقى المندوب «موقعه متوقف» على خريطة المدير حتى خمس دقائق
     * بعد عودة الخادم من انقطاع (مثبت بالمحاكي، ٤ نوفمبر)، ونافذة «موقع مباشر» دقيقتان (liveRepStatus.ts LOCATION_FRESH_MS)
     */
    const val BACKOFF_FIRST_MS = 30_000L
    const val BACKOFF_MAX_MS = 120_000L

    /** نظير حدّ الصفحة (TRACK_TOKEN_MAX_CHARS) — رمزٌ أطول مدخلٌ غير موثوق يُرفض */
    const val TOKEN_MAX_CHARS = 4_096

    const val HTTP_TIMEOUT_MS = 15_000

    /** رمز رفض الخادم للرمز (backend/src/services/deviceTrack.ts TRACK_TOKEN_INVALID) — به وحده يتوقف التسجيل على 401/403 */
    const val TOKEN_INVALID_CODE = "TRACK_TOKEN_INVALID"

    /** قناة الإشعار الثابت */
    const val CHANNEL_ID = "fs_track"
}
