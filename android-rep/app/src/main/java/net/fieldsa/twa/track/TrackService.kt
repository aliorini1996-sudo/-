package net.fieldsa.twa.track

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import net.fieldsa.twa.BuildConfig
import net.fieldsa.twa.LauncherActivity
import net.fieldsa.twa.R
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * التتبّع الخلفي (طلب المالك، ٤ نوفمبر ٢٠٢٦): خدمة مقدّمة من نوع «الموقع» بإشعارٍ ثابت ظاهر ما دامت تعمل. تقرأ الموقع كل ٥ ثوانٍ،
 * وتحفظ ما يمرّ من مرشّح العقد (TrackLogic.shouldKeep: نقطةٌ كل ١٥ ثانية للمتحرّك، ونبضٌ كل ٣٠ ثانية للثابت) في طابورٍ على
 * القرص (TrackQueue)، وترفعه كل ٣٠ ثانية إلى /api/track-device/ping برمز التتبّع (TrackStore) لا بجلسة المندوب.
 * موعد الرفع تقيسه قراءات الموقع بالساعة المنقضية (uploadIfDue)، والمعالج مستيقظٌ بقفلٍ قصير حتى تكتمل الدفعة (executeAwake):
 * الشاشة مقفلة تُنيم المعالج بين القراءات، فمؤقّتٌ وحده كان يؤخّر الرفع دقائق ويُظهر المندوب «موقعه متوقف» على خريطة المدير.
 *
 * تبدأ من TrackActivity وحده (بعد إفصاح المندوب وموافقته وإذن الموقع الدقيق)، وتتوقف: بالإيقاف الصريح (الخروج من الحساب)،
 * أو انتهاء الرمز، أو تبدّل يوم الجوال، أو رفض الخادم للرمز (401/403 بـTRACK_TOKEN_INVALID)، أو ردّ الخادم stop (الشركة أطفأت التتبّع)، أو سحب إذن الموقع.
 * START_NOT_STICKY: أندرويد 14+ يمنع تشغيل خدمة موقعٍ مقدّمة من الخلفية، والبدء التالي يأتي من فتح المندوب للتطبيق.
 *
 * الموقع والحالة على الخيط الرئيسي؛ القرص والشبكة على خيط io واحد بالترتيب.
 */
class TrackService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var queue: TrackQueue

    private var fused: FusedLocationProviderClient? = null
    private var manager: LocationManager? = null
    private var running = false
    private var destroyed = false
    private var lastKept: TrackFix? = null
    private var uploadOnNextKeep = false

    /** الرمز الجاري — يقرؤه خيط io */
    @Volatile private var token: String? = null
    /**
     * عنوان الرفع لهذا التشغيل: يُلتقط مرةً في onStartCommand مع الرمز (endpoint)، وكل POST يقرؤه، ورفع الهدم معه. إيقاف
     * TrackActivity يمسح TrackStore (ومعه عنوان التطوير) قبل stopService، فقراءته من جديد في onDestroy أرسلت الدفعة الأخيرة لبناء
     * التطوير إلى الإنتاج بدل عنوانه (مثبت بالمحاكي، ٤ نوفمبر). في الإصدار هو PING_URL دائماً
     */
    @Volatile private var uploadUrl: String = TrackContract.PING_URL
    /** لا رفعٌ أخير عند الهدم: الخادم رفض الرمز أو أوقف التتبّع */
    @Volatile private var noFinalFlush = false

    // حالة الرفع: يكتبها خيط io وحده. retryAtElapsed وlastUploadAttemptElapsed يقرؤهما الخيط الرئيسي أيضاً (uploadIfDue)
    private var backoffMs = 0L
    @Volatile private var retryAtElapsed = 0L
    /** لحظة آخر POST (elapsedRealtime) — لا يحرّكها طلبٌ وجد الطابور فارغاً، فأول نقطةٍ بعده لا تنتظر ٣٠ ثانية أخرى */
    @Volatile private var lastUploadAttemptElapsed = 0L
    private val uploadQueued = AtomicBoolean(false)

    /** قفل يقظةٍ جزئي لدفعة الرفع: بلا عدّ مراجع، فإمساكٌ ثانٍ يمدّ المهلة وإفلاتٌ واحد يكفي ولا يرمي استثناءً */
    private var wakeLock: PowerManager.WakeLock? = null

    /**
     * احتياطٌ إن غابت قراءات الموقع (مبنى يحجب الإشارة) وطابورٌ ينتظر، وفحصٌ دوري لصلاحية الرمز واليوم. لا يقيس موعد الرفع:
     * Handler يعدّ وقت يقظة المعالج وحده (uptimeMillis)، فيتمدّد ٣٠ ثانية إلى دقائق والشاشة مقفلة
     */
    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            if (!stillValid()) {
                stopTracking(clearToken = true)
                return
            }
            uploadIfDue()
            main.postDelayed(this, TrackContract.UPLOAD_INTERVAL_MS)
        }
    }

    private val fusedCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            for (l in result.locations) onFix(l)
        }
    }

    private val platformListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(location)
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        queue = TrackQueue(File(filesDir, TrackQueue.FILE_NAME))
        wakeLock = try {
            ContextCompat.getSystemService(this, PowerManager::class.java)
                ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
                ?.apply { setReferenceCounted(false) }
        } catch (e: RuntimeException) {
            // بلا قفل يمضي الرفع كما كان: يتأخّر والشاشة مقفلة ولا يضيع
            null
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground أولاً وفي كل حال: startForegroundService بلا startForeground خلال ثوانٍ ينهي العملية
        if (!enterForeground()) {
            stopTracking(clearToken = false)
            return START_NOT_STICKY
        }
        if (!hasLocationPermission()) {
            stopTracking(clearToken = false)
            return START_NOT_STICKY
        }
        val t = TrackStore.token(this)
        val identity = TrackLogic.tokenIdentity(t)
        if (t == null || identity == null || !stillValid(t)) {
            stopTracking(clearToken = true)
            return START_NOT_STICKY
        }
        // العنوان قبل الرمز: خيط io لا يرى الرمز الجديد بعنوان التشغيل السابق
        uploadUrl = endpoint()
        token = t
        noFinalFlush = false
        // أول نقطةٍ بعد البدء تُحفظ وتُرفع فوراً
        lastKept = null
        uploadOnNextKeep = true
        val app = applicationContext
        execute {
            // نقاط مندوبٍ آخر (خرج ودخل غيره على الجوال نفسه) لا تُرفع برمز هذا
            if (TrackStore.queueOwner(app) != identity.key()) {
                queue.clear()
                TrackStore.setQueueOwner(app, identity.key())
            }
            backoffMs = 0L
            retryAtElapsed = 0L
        }
        if (!running) startLocationUpdates()
        if (running) {
            main.removeCallbacks(tick)
            main.postDelayed(tick, TrackContract.UPLOAD_INTERVAL_MS)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        destroyed = true
        main.removeCallbacksAndMessages(null)
        removeLocationUpdates()
        running = false
        // رفعٌ أخير لما في الطابور (الخروج من الحساب): نقاطٌ التُقطت قبله. وما لم يُرفع يبقى للبدء التالي بالهوية نفسها.
        // يحمل ترويسة «الأخير» فينسى الخادم أن التطبيق يرفع: دخولٌ سريع بعد الخروج يطلب بدءاً جديداً ولا يظنّ الخدمة الميتة حيّة.
        // الرمز والعنوان (uploadUrl) كما التُقطا عند البدء: الإيقاف مسح TrackStore قبل هذه اللحظة
        val t = token
        if (t != null && !noFinalFlush) executeAwake { uploadRounds(t, maxRounds = 2, closing = true) }
        io.shutdown()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // حدّ وقت الخدمات المقدّمة (أندرويد 15+ لأنواعٍ بعينها): يُوقف بنظافة، والفتح التالي للتطبيق يبدأ من جديد
        stopTracking(clearToken = false)
    }

    // ── المقدّمة والإشعار ─────────────────────────────────────────────────────────────────────────

    private fun enterForeground(): Boolean = try {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
        true
    } catch (e: SecurityException) {
        // أندرويد 14+: إذن الموقع غير ممنوح أو التطبيق لم يكن في المقدّمة
        Log.w(TAG, "startForeground refused", e)
        false
    } catch (e: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException (أندرويد 12+)
        Log.w(TAG, "startForeground not allowed", e)
        false
    }

    private fun notification(): Notification {
        val nm = ContextCompat.getSystemService(this, NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null &&
            nm.getNotificationChannel(TrackContract.CHANNEL_ID) == null
        ) {
            nm.createNotificationChannel(
                NotificationChannel(TrackContract.CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val open = (packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, LauncherActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val pending = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, TrackContract.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_icon)
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(NOTIFICATION_TEXT))
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            // الإشعار يظهر فوراً لا بعد مهلة الأنظمة الحديثة: المندوب يرى أن التسجيل بدأ
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    // ── الموقع (الخيط الرئيسي) ───────────────────────────────────────────────────────────────────

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasLocationPermission(): Boolean =
        granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun startLocationUpdates() {
        running = true
        if (isPlayServicesAvailable()) {
            try {
                val client = fused ?: LocationServices.getFusedLocationProviderClient(this).also { fused = it }
                val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, TrackContract.SAMPLE_INTERVAL_MS)
                    .setMinUpdateIntervalMillis(TrackContract.SAMPLE_INTERVAL_MS)
                    .setWaitForAccurateLocation(false)
                    .build()
                client.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                    .addOnFailureListener { e ->
                        Log.w(TAG, "fused requestLocationUpdates failed", e)
                        if (running) {
                            fused?.removeLocationUpdates(fusedCallback)
                            fused = null
                            if (!startPlatform()) stopTracking(clearToken = false)
                        }
                    }
                return
            } catch (e: SecurityException) {
                // الإذن سُحب
                stopTracking(clearToken = false)
                return
            } catch (e: RuntimeException) {
                Log.w(TAG, "fused unavailable", e)
                fused = null
            }
        }
        if (!startPlatform()) stopTracking(clearToken = false)
    }

    /** بلا خدمات Google (هواوي مثلاً): GPS والشبكة معاً — كمعالج تفويض الموقع (LocationDelegation) */
    private fun startPlatform(): Boolean {
        val lm = manager ?: (getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.also { manager = it }
            ?: return false
        var any = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (provider == LocationManager.GPS_PROVIDER && !granted(Manifest.permission.ACCESS_FINE_LOCATION)) continue
            try {
                if (!lm.allProviders.contains(provider)) continue
                lm.requestLocationUpdates(provider, TrackContract.SAMPLE_INTERVAL_MS, 0f, platformListener, Looper.getMainLooper())
                any = true
            } catch (e: SecurityException) {
                Log.w(TAG, "platform provider $provider refused", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "platform provider $provider failed", e)
            }
        }
        return any
    }

    private fun removeLocationUpdates() {
        try {
            fused?.removeLocationUpdates(fusedCallback)
        } catch (e: RuntimeException) {
            // لا شيء
        }
        try {
            manager?.removeUpdates(platformListener)
        } catch (e: RuntimeException) {
            // لا شيء
        }
    }

    private fun isPlayServicesAvailable(): Boolean = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) == ConnectionResult.SUCCESS
    } catch (e: RuntimeException) {
        false
    }

    private fun onFix(location: Location?) {
        if (location == null || !running) return
        if (!stillValid()) {
            stopTracking(clearToken = true)
            return
        }
        val now = System.currentTimeMillis()
        val fix = TrackFix(
            lat = location.latitude,
            lng = location.longitude,
            // بلا دقّة معروفة ⇒ تُسقط في المرشّح
            accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else Double.NaN,
            speed = if (location.hasSpeed()) location.speed.toDouble() else null,
            timeMs = location.time.takeIf { it > 0 } ?: now,
        )
        val keep = TrackLogic.shouldKeep(fix, lastKept)
        if (keep) {
            lastKept = fix
            // قبل طلب الرفع: خيط io واحد بالترتيب، فالنقطة في الطابور حين تُقرأ الدفعة
            execute { queue.add(fix) }
        }
        if (keep && uploadOnNextKeep) {
            uploadOnNextKeep = false
            requestUpload()
        } else {
            // كل قراءةٍ (محفوظةً أو لا) يقظةٌ حقيقية للمعالج والشاشة مقفلة — فيها يُقاس موعد الرفع لا في مؤقّتٍ ينام معه.
            // قراءات المحفوظة وحدها كانت تُفوّت الموعد بأجزاء ثانية فيصير الرفع كل دقيقة للثابت
            uploadIfDue()
        }
    }

    /** الرمز ما زال صالحاً وفي يوم البدء نفسه */
    private fun stillValid(t: String? = token): Boolean {
        val now = System.currentTimeMillis()
        return t != null && !TrackLogic.tokenExpired(t, now) &&
            TrackStore.startedDay(this) == TrackLogic.dayKey(now)
    }

    /** الإيقاف من داخل الخدمة. clearToken: الرمز لم يعد صالحاً لهذا اليوم (لا يمسّ رمزاً أحدث وضعه بدءٌ جديد) */
    private fun stopTracking(clearToken: Boolean, usedToken: String? = token) {
        if (clearToken && usedToken != null && TrackStore.token(this) == usedToken) TrackStore.clearToken(this)
        running = false
        main.removeCallbacks(tick)
        removeLocationUpdates()
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: RuntimeException) {
            // لا شيء
        }
        stopSelf()
    }

    // ── الرفع (خيط io) ───────────────────────────────────────────────────────────────────────────

    /** false: الخدمة تُهدم ولم يُقبل العمل */
    private fun execute(block: () -> Unit): Boolean = try {
        io.execute(block)
        true
    } catch (e: RejectedExecutionException) {
        false
    }

    /**
     * عمل رفعٍ على io والمعالج مستيقظ. القفل يُمسك هنا قبل التسليم وفي نداء الموقع نفسه: بعد عودة النداء يُفلت النظام قفله،
     * وقد ينام المعالج قبل أن يبدأ خيط io. ويُفلت في finally على io في كل حال، ومهلته حدٌّ إن علق شيء
     */
    private fun executeAwake(block: () -> Unit) {
        holdAwake()
        val queued = execute {
            try {
                block()
            } finally {
                letSleep()
            }
        }
        if (!queued) letSleep()
    }

    /** يمسك القفل أو يمدّ مهلته — يُستدعى قبل كل POST، فدفعاتٌ متتالية لا تنقطع بانتهاء مهلة الأولى */
    private fun holdAwake() {
        try {
            wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (e: RuntimeException) {
            // بلا إذن WAKE_LOCK (SecurityException): الرفع يمضي بلا قفل
        }
    }

    private fun letSleep() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: RuntimeException) {
            // لا شيء
        }
    }

    /**
     * يرفع إن مضت ٣٠ ثانية منذ آخر POST بالساعة المنقضية (تحسب نوم المعالج) ولم يكن في تراجعٍ بعد خطأ. يُستدعى من كل قراءة
     * موقع ومن المؤقّت الاحتياطي، وطلبٌ مكرّر وهو في الطريق لا يُضاف (uploadQueued)
     */
    private fun uploadIfDue() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastUploadAttemptElapsed < TrackContract.UPLOAD_INTERVAL_MS) return
        if (now < retryAtElapsed) return
        requestUpload()
    }

    private fun requestUpload() {
        val t = token ?: return
        if (!uploadQueued.compareAndSet(false, true)) return
        executeAwake {
            uploadQueued.set(false)
            // يُعاد الفحص هنا: التراجع قد يتغيّر بين الطلب والتنفيذ
            if (SystemClock.elapsedRealtime() < retryAtElapsed) return@executeAwake
            uploadRounds(t, maxRounds = 5)
        }
    }

    /**
     * دفعاتٌ متتالية حتى يفرغ الطابور أو يقع خطأ — كلها على io، داخل executeAwake وحده.
     * closing: الرفع الأخير عند هدم الخدمة وحده (onDestroy) — يحمل ترويسة «الأخير» فينسى الخادم أن التطبيق يرفع
     */
    private fun uploadRounds(t: String, maxRounds: Int, closing: Boolean = false) {
        repeat(maxRounds) { round ->
            val batch = queue.peek(TrackContract.MAX_BATCH)
            if (batch.isEmpty()) {
                // الطابور فارغ لحظة الهدم (الغالب: آخر رفعٍ قبل ثوانٍ): POST بلا نقاط يحمل الترويسة وحدها — الخادم يقبله بها
                // فارغاً — وإلا بقي «التطبيق يرفع» ٩٠ ثانية عن خدمةٍ ميتة. ردّه لا يغيّر شيئاً: الخدمة انتهت
                if (closing && round == 0) {
                    holdAwake()
                    post(t, TrackQueue.bodyOf(emptyList()), closing)
                }
                return
            }
            holdAwake()
            lastUploadAttemptElapsed = SystemClock.elapsedRealtime()
            val (code, body) = post(t, TrackQueue.bodyOf(batch), closing)
            when (TrackLogic.classify(code, body)) {
                TrackLogic.Reply.OK -> {
                    queue.remove(batch.size)
                    backoffMs = 0L
                    retryAtElapsed = 0L
                    if (TrackLogic.replySaysStop(body)) {
                        // الشركة أطفأت التتبّع أو استُثني المندوب: لا يُرفع ما بقي، ولا يُحفظ جديد
                        queue.clear()
                        noFinalFlush = true
                        main.post { if (!destroyed && token == t) stopTracking(clearToken = true, usedToken = t) }
                        return
                    }
                }
                TrackLogic.Reply.STOP_AUTH -> {
                    // الرمز مرفوض (انتهى، أو المندوب عُطّل، أو الشركة موقوفة): يُمسح ويتوقف التسجيل. النقاط تبقى لبدءٍ جديد بالهوية نفسها
                    noFinalFlush = true
                    main.post { if (!destroyed && token == t) stopTracking(clearToken = true, usedToken = t) }
                    return
                }
                TrackLogic.Reply.DROP_BATCH -> {
                    Log.w(TAG, "batch rejected ($code), dropped ${batch.size}")
                    queue.remove(batch.size)
                }
                TrackLogic.Reply.RETRY -> {
                    backoffMs = TrackLogic.nextBackoffMs(backoffMs)
                    retryAtElapsed = SystemClock.elapsedRealtime() + backoffMs
                    return
                }
            }
        }
    }

    /**
     * عنوان الرفع: الثابت في الإصدار؛ وفي بناء التطوير وحده بديلٌ https أو http محلّي إن حُفظ. يُقرأ في onStartCommand وحده
     * (uploadUrl): TrackStore يُمسح عند الإيقاف قبل رفع الهدم
     */
    private fun endpoint(): String {
        if (BuildConfig.DEBUG) {
            val u = TrackStore.debugUrl(this)
            if (u != null && TrackLogic.acceptableDebugUrl(u)) return u
        }
        return TrackContract.PING_URL
    }

    /** POST واحد؛ رمز الحالة (-1 لخطأ الشبكة) وجسم الردّ — الرمز لا يُسجَّل */
    private fun post(t: String, json: String, closing: Boolean): Pair<Int, String?> {
        val conn = try {
            URL(uploadUrl).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            return -1 to null
        }
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = TrackContract.HTTP_TIMEOUT_MS
            conn.readTimeout = TrackContract.HTTP_TIMEOUT_MS
            // الرمز لا يذهب إلا إلى هذا العنوان: لا تتبُّع لتحويلٍ إلى مضيفٍ آخر
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $t")
            conn.setRequestProperty(TrackContract.DEVICE_NOW_HEADER, TrackLogic.isoUtc(System.currentTimeMillis()))
            // في رفع الهدم وحده: رفعٌ دوري بها كان سيمحو علامة «التطبيق يرفع» والخدمة حيّة، فتُخزَّن نقاط الصفحة مكرّرةً على الخريطة
            if (closing) conn.setRequestProperty(TrackContract.FINAL_HEADER, TrackContract.FINAL_VALUE)
            conn.setRequestProperty(
                "User-Agent",
                "FieldSales-Rep/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${BuildConfig.APPLICATION_ID})",
            )
            val bytes = json.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { r ->
                val buf = CharArray(MAX_REPLY_CHARS)
                val sb = StringBuilder()
                while (sb.length < MAX_REPLY_CHARS) {
                    val n = r.read(buf, 0, MAX_REPLY_CHARS - sb.length)
                    if (n < 0) break
                    sb.append(buf, 0, n)
                }
                sb.toString()
            }
            code to text
        } catch (e: IOException) {
            -1 to null
        } catch (e: RuntimeException) {
            -1 to null
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "FsTrack"
        private const val NOTIFICATION_ID = 4301
        private const val MAX_REPLY_CHARS = 16 * 1024
        /** الوسم يظهر في إحصاءات البطارية — بلا هوية المندوب */
        private const val WAKE_LOCK_TAG = "FieldSales:TrackUpload"
        /**
         * مهلة قفل اليقظة لـPOST واحد: مهلة الاتصال ومهلة القراءة (HTTP_TIMEOUT_MS لكلٍّ) وهامش. تُجدَّد قبل كل دفعة، وحدُّها يمنع
         * شبكةً عالقة من إبقاء المعالج مستيقظاً يستنزف البطارية
         */
        internal const val WAKE_LOCK_TIMEOUT_MS = 2L * TrackContract.HTTP_TIMEOUT_MS + 5_000L
        const val CHANNEL_NAME = "تسجيل الموقع"
        const val NOTIFICATION_TITLE = "فيلد سيلز: يُسجَّل موقعك اليوم"
        const val NOTIFICATION_TEXT = "يتوقف التسجيل عند تسجيل الخروج أو في نهاية اليوم. اضغط لفتح التطبيق."

        /** يُستدعى من نشاطٍ ظاهر (TrackActivity) وحده — أندرويد 12+ يمنع البدء من الخلفية */
        fun start(context: Context): Boolean = try {
            ContextCompat.startForegroundService(context, Intent(context, TrackService::class.java))
            true
        } catch (e: RuntimeException) {
            Log.w(TAG, "start refused", e)
            false
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, TrackService::class.java))
            } catch (e: RuntimeException) {
                // لا شيء
            }
        }
    }
}
