package net.fieldsa.twa.cardpay

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.nfc.NfcAdapter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.button.MaterialButton
import net.fieldsa.twa.BuildConfig
import net.fieldsa.twa.LauncherActivity
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * وحدة «التحصيل بالبطاقة» داخل تطبيق المندوب: العميل يلمس بطاقته بجوال المندوب عبر NearPay (SoftPOS).
 *
 * المسار: صفحة المندوب في TWA تفتح fieldsapay://cardpay?t=<رمز> ← فحص شكل الرمز ← أذونات المنصة ← وجود NFC وتشغيله
 * ← استبدال الرمز بتفاصيل العملية (POST /card-payments/launch) ← تهيئة NearPay ← دخول نقطة البيع بـJWT ← نقرة المندوب
 * ← purchase ← رجوع إلى /rep?cardpay=<المعرّف>.
 * ما لا يحتاج الحمولة (الأذونات وNFC) يسبق الاستبدال: الاستبدال يستهلك الرمز ويحجز الفاتورة عشر دقائق على الخادم
 * (IN_PROGRESS_MS)، ويبدأ عمر JWT (٣٠٠ ثانية) — فلا يُحرق الرمز على جوالٍ بلا NFC أو مندوبٍ يتردد في الإعدادات.
 *
 * الجوال ليس مصدر الحقيقة: أياً كانت النتيجة هنا (موافقة، رفض، فشل، إلغاء، رجوع) يعود المندوب إلى الويب، والخادم يسأل
 * NearPay بمفتاحه ويُصدر السند (backend/src/services/cardPayment.ts). لا يرسل الجوال نتيجةً ولا يُصدَّق.
 *
 * الرابط يطلقه أي موقع، فهو مدخلٌ غير موثوق: الرمز يُفحص شكله، ويُستبدل مرة واحدة فقط ولو أُعيد إنشاء النشاط،
 * ولا تبدأ عملية دفع إلا بنقرة المندوب بعد أن يرى اسمه والشركة والعميل والمبلغ القادمة من خادمنا، وفي مهلةٍ من الاستبدال.
 * نسخةٌ واحدة من النشاط في العملية (live): رابطٌ ثانٍ أثناء عمليةٍ قائمة لا يُستبدل رمزه.
 * الرمز وJWT في الذاكرة وحدها: لا سجلّ ولا تخزين ولا savedInstanceState.
 */
class CardPayActivity : AppCompatActivity() {

    private enum class Stage {
        PERMISSIONS, // أذونات المنصة قبل الاستبدال وقبل build() — التهيئة تفشل بلا إذن الموقع
        NEED_NFC, // NFC مطفأ: قبل الاستبدال، أو بعد الدخول إن أُطفئ بين الشاشتين
        REDEEMING, // POST /launch جارٍ
        REDEEM_FAILED, // لا حمولة: لا معرّف عملية
        STARTING, // تهيئة الوحدة ثم دخول نقطة البيع (ومعه ما تراه الوحدة ناقصاً من الأذونات)
        READY, // ينتظر نقرة المندوب
        PAYING, // القارئ حيّ ولم تُقرأ البطاقة
        CAPTURED, // بدأت قراءة البطاقة أو انتهت أو بدأ الرقم السري — قد يتحرك المال: لا خروج إلا بالنتيجة أو بعد المهلة
        RETRYABLE, // أُغلق القارئ ولم تُلمس بطاقة قط في هذا النشاط
        FAILED, // خطأ لا يُستأنف هنا
        SETTLED, // وصلت النتيجة أو حُوّل الحكم إلى الخادم — الرجوع بعد لحظة
        RETURNING,
    }

    private enum class PermissionStep { NONE, PLATFORM, SDK }

    private class Action(val label: String, val run: () -> Unit)

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var stage = Stage.PERMISSIONS
    private var token: String? = null // سرّ: يُمحى بعد استهلاكه
    private var jwt: String? = null // سرّ: يُستعمل مرةً للدخول ثم يُمحى
    private var payload: LaunchPayload? = null // بلا JWT
    private var redeemSent = false
    private var redeemSentAt = 0L // SystemClock.elapsedRealtime() لآخر إرسالٍ للرمز ≈ launchedAt لدى الخادم أو قبله
    private var redeemInFlight = false
    private var session: NearpaySession? = null
    private var permissionStep = PermissionStep.NONE
    private var awaitingSettings = false

    // الثلاثة لا تُصفَّر أبداً في هذا النشاط: ما رآه القارئ مرةً يبقى حكماً على كل محاولةٍ بعده على النيّة نفسها
    private var purchaseStarted = false // نُودي purchase() مرةً على الأقل
    private var cardTouched = false // حدثٌ بعد «معروض/ينتظر/أعد التقريب»: قراءة أو فشل قراءة أو رقم سري أو انتهاء — لا إعادة هنا
    private var cardCaptured = false // بدأت القراءة أو انتهت أو بدأ الرقم السري: قد يتحرك المال — لا خروج إلا بالنتيجة أو المهلة
    private var escapeAllowed = false
    private var returned = false

    private lateinit var detailsCard: LinearLayout
    private lateinit var repView: TextView
    private lateinit var amountView: TextView
    private lateinit var linesView: TextView
    private lateinit var envView: TextView
    private lateinit var progress: ProgressBar
    private lateinit var statusView: TextView
    private lateinit var detailView: TextView
    private lateinit var primaryButton: MaterialButton
    private lateinit var secondaryButton: MaterialButton

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
            val step = permissionStep
            permissionStep = PermissionStep.NONE
            when (step) {
                PermissionStep.PLATFORM -> afterPlatformPermissions()
                // ما طلبته الوحدة يُطلب مرةً ثم يُكمَل الدخول: إن احتاجته فعلاً فشلت هي برسالتها
                PermissionStep.SDK -> login()
                PermissionStep.NONE -> Unit
            }
        }

    // مهلةٌ بعد آخر حدثٍ من القارئ: لا واجهة برمجية موثّقة لإلغاء عملية جارية، فإن سكت القارئ لا يُحبس المندوب هنا
    private val watchdog = Runnable {
        if (stage == Stage.PAYING || stage == Stage.CAPTURED) {
            escapeAllowed = true
            renderPaying(
                if (cardCaptured) "لم تصل نتيجة العملية بعد. إن أُغلق القارئ فارجع ليتحقق الخادم منها"
                else "لم يصل ردّ من القارئ. إن أُغلق فارجع ليتحقق الخادم من العملية",
            )
        }
    }

    // مهلة بدء الدفع بعد الاستبدال (PURCHASE_WINDOW_MS) — موقّتٌ احتياطي؛ الفحص الحاسم في startPurchase وonResume بساعةٍ لا تتوقف
    // في نوم الجوال (elapsedRealtime)، أما Handler فيعدّ uptime فقد يتأخر
    private val deadlineCheck = Runnable { if (deadlineDue()) expire() }

    override fun onCreate(savedInstanceState: Bundle?) {
        // أندرويد 15+ يفرض العرض من الحافة إلى الحافة: الأشرطة شفافة بأيقونات داكنة على الخلفية الكريمية، والحواف بالـinsets
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, NAV_SCRIM_DARK),
        )
        // null عمداً: لا تُستعاد أجزاء واجهة NearPay (fragments) بعد موت العملية — لا جلسة وراءها، والحقيقة لدى الخادم.
        // حالتنا نحن تُقرأ من savedInstanceState مباشرة أدناه
        super.onCreate(null)

        // نسخةٌ واحدة في العملية (process). singleTop لا يحرس إلا والنشاط في قمة المهمّة، وفوقه قد يكون الإعدادات أو حوار الأذونات
        // أو TWA نفسها (رابط fieldsa.net يفتح LauncherActivity فوقه): رابط دفعٍ ثانٍ حينها يُنشئ نسخةً تستبدل رمزاً آخر وتبني وحدةً
        // ثانية على نقطة البيع نفسها، ثم يمحو رجوعها (CLEAR_TASK) الأولى ولو في منتصف الدفع. الثانية لا تقرأ رمزها:
        // تُظهر الأولى (onNewIntent فيها يُعلم المندوب) وتنتهي. EXTRA_FOCUS يمنع الدوران إن لم تجد الأولى في هذه المهمّة
        val other = live?.get()
        if (other != null && other !== this && !other.returned && !other.isFinishing && !other.isDestroyed) {
            if (!intent.getBooleanExtra(EXTRA_FOCUS, false)) {
                try {
                    startActivity(
                        Intent(this, CardPayActivity::class.java)
                            .putExtra(EXTRA_FOCUS, true)
                            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                    )
                } catch (e: ActivityNotFoundException) {
                    // لا يقع: النشاط في التطبيق نفسه
                }
            }
            finish()
            return
        }
        if (intent.getBooleanExtra(EXTRA_FOCUS, false)) {
            finish() // طلب إظهارٍ وصل بعد أن انتهت الأولى: لا شيء يُظهر
            return
        }
        live = WeakReference(this)

        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onLeaveRequested()
        })

        if (savedInstanceState?.getBoolean(KEY_REDEEM_SENT) == true) {
            // عودةٌ بعد موت العملية: الرمز استُهلك أو ربما — لا يُعاد استبداله أبداً، وJWT لم يُحفظ عمداً فلا دخول ثانٍ.
            // الحكم للخادم: يعود المندوب إلى صفحته بمعرّف العملية إن عُرف
            returnToWeb(savedInstanceState.getString(KEY_INTENT_ID))
            return
        }
        // من قائمة التطبيقات الأخيرة يعيد أندرويد تسليم الرابط الأصلي برمزه القديم — لا يُستبدل ثانية
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            returnToWeb(null)
            return
        }
        val t = readToken(intent)
        if (t == null) {
            abortBeforeRedeem("رابط الدفع غير صالح — ابدأ التحصيل من جديد من صفحة العميل")
            return
        }
        token = t
        ensurePlatformPermissions()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleTop، أو نسخةٌ ثانية أظهرت هذه (EXTRA_FOCUS): رابط دفعٍ آخر لا يُستبدل رمزه — عمليةٌ واحدة في كل مرة
        if (!returned) toast("عملية تحصيل جارية — أكملها أو ارجع أولاً")
    }

    override fun onResume() {
        super.onResume()
        if (deadlineDue()) return expire()
        when (stage) {
            Stage.NEED_NFC -> if (payload == null) checkNfcBeforeRedeem() else checkNfc()
            Stage.PERMISSIONS -> if (awaitingSettings) {
                awaitingSettings = false
                afterPlatformPermissions()
            }
            else -> Unit
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // هذه الحزمة قد تُكتب على القرص: لا رمز ولا JWT — يكفي أن الرمز أُرسل، ومعرّف العملية للرجوع
        outState.putBoolean(KEY_REDEEM_SENT, redeemSent)
        payload?.let { outState.putString(KEY_INTENT_ID, it.intentId) }
    }

    override fun onDestroy() {
        if (live?.get() === this) live = null
        main.removeCallbacksAndMessages(null)
        session?.close()
        // shutdown لا shutdownNow: طلبٌ وصل الخادم يكمل ويُهمل ردّه، ولا يُقطع في منتصف الكتابة
        io.shutdown()
        super.onDestroy()
    }

    // ═══ ١. الرمز ═══

    private fun readToken(i: Intent?): String? {
        if (i?.action != Intent.ACTION_VIEW) return null
        val u = i.data ?: return null
        if (u.scheme != SCHEME || u.host != HOST) return null
        val t = try {
            u.getQueryParameter("t")
        } catch (e: UnsupportedOperationException) {
            null
        }
        return t?.takeIf { TOKEN_RE.matches(it) }
    }

    // ═══ ٢. الأذونات — قبل الاستبدال ═══
    // التوثيق: الوحدة تفشل عند التهيئة إن رُفض إذن الموقع، وcheckRequiredPermissions لا يُستدعى إلا بعد build() —
    // فتُطلب أذونات المنصة الخطرة أولاً بواجهة أندرويد نفسها، ثم ما تراه الوحدة ناقصاً بعد تهيئتها.
    // لا تحتاج الحمولة، فتسبق الاستبدال: التردد هنا أو في الإعدادات لا يأكل عمر الرمز ولا JWT

    /**
     * إفصاحٌ ظاهر قبل حوار النظام (سياسة «بيانات المستخدم» في Play): الحوار لا يُطلب إلا من نقرة «متابعة» على شاشةٍ تقول
     * ما يُجمع ولمن ولماذا — لا يُرسم النص والحوار معاً فيغطيه الحوار فوراً
     */
    private fun ensurePlatformPermissions() {
        stage = Stage.PERMISSIONS
        if (PLATFORM_PERMISSIONS.all(::granted)) return checkNfcBeforeRedeem()
        render(
            PERMISSION_DISCLOSURE,
            primary = Action("متابعة") { requestPlatformPermissions() },
            secondary = Action("رجوع") { onLeaveRequested() },
        )
    }

    private fun requestPlatformPermissions() {
        if (stage != Stage.PERMISSIONS || permissionStep != PermissionStep.NONE) return
        val missing = PLATFORM_PERMISSIONS.filterNot(::granted)
        if (missing.isEmpty()) return checkNfcBeforeRedeem()
        permissionStep = PermissionStep.PLATFORM
        permissionLauncher.launch(missing.toTypedArray())
    }

    private fun afterPlatformPermissions() {
        if (stage != Stage.PERMISSIONS) return
        val missing = REQUIRED_PLATFORM_PERMISSIONS.filterNot(::granted)
        if (missing.isEmpty()) return checkNfcBeforeRedeem()
        // رفضٌ نهائي («لا تسأل مجدداً») لا يُظهر الحوار ثانية — الإعدادات وحدها
        val blocked = missing.none { shouldShowRequestPermissionRationale(it) }
        val coarseOnly = granted(Manifest.permission.ACCESS_COARSE_LOCATION) &&
            !granted(Manifest.permission.ACCESS_FINE_LOCATION)
        val message = buildString {
            append("لا يمكن قبول البطاقة دون إذن ")
            append(missing.joinToString(" و") { permissionLabel(it) })
            append(".")
            if (coarseOnly) append(" اختر «الموقع الدقيق» لا «التقريبي».")
            append("\n")
            append(PERMISSION_DISCLOSURE)
        }
        render(
            message,
            // الإفصاح على الشاشة نفسها، والنقرة موافقةٌ صريحة — فيُطلب الحوار مباشرة
            primary = if (blocked) Action("فتح إعدادات التطبيق") { openAppSettings() }
            else Action("منح الأذونات") { requestPlatformPermissions() },
            secondary = Action("رجوع") { onLeaveRequested() },
        )
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun permissionLabel(permission: String): String = when (permission) {
        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION -> "الموقع الدقيق"
        Manifest.permission.READ_PHONE_STATE -> "حالة الهاتف"
        else -> permission.substringAfterLast('.')
    }

    private fun openAppSettings() {
        awaitingSettings = true
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (e: ActivityNotFoundException) {
            awaitingSettings = false
            toast("افتح إعدادات الجوال ← التطبيقات ← FieldSales ← الأذونات")
        }
    }

    // ═══ ٣. NFC — قبل الاستبدال ═══
    // جوالٌ بلا NFC أو NFC مطفأ يعرفه أندرويد نفسه بلا وحدة الدفع: لا يُستهلك الرمز على جوالٍ لن يقرأ بطاقة.
    // بعد الدخول يُعاد الفحص بدالة الوحدة (checkNfc) — قد يُطفأ بين الشاشتين

    private fun checkNfcBeforeRedeem() {
        if (payload != null || redeemSent) return
        val adapter = NfcAdapter.getDefaultAdapter(this)
            ?: return abortBeforeRedeem("هذا الجوال لا يدعم NFC — لا يستطيع قراءة البطاقات اللاتلامسية")
        if (!adapter.isEnabled) return needNfc()
        redeem()
    }

    private fun needNfc() {
        stage = Stage.NEED_NFC
        render(
            "شغّل NFC ليقرأ الجوال بطاقة العميل، ثم ارجع إلى هذه الشاشة",
            primary = Action("فتح إعدادات NFC") { openNfcSettings() },
            secondary = Action("رجوع") { onLeaveRequested() },
        )
    }

    /**
     * قبل إرسال الرمز: لم تُفتح العملية على الخادم (الرمز لم يُستهلك ولا يحجز الفاتورة)، فيعود المندوب بـ?cardpay=aborted
     * فتمحو الصفحة العملية المحفوظة عندها — لا نتيجة تُنتظر
     */
    private fun abortBeforeRedeem(message: String) {
        stage = Stage.FAILED
        token = null
        render(message, secondary = Action("رجوع إلى التطبيق") { returnToWeb(null, aborted = true) })
    }

    // ═══ ٤. الاستبدال ═══

    private fun redeem() {
        val t = token ?: return
        if (redeemInFlight) return
        redeemInFlight = true
        redeemSent = true
        redeemSentAt = SystemClock.elapsedRealtime()
        stage = Stage.REDEEMING
        render("جارٍ تجهيز عملية الدفع…", busy = true, secondary = Action("رجوع") { onLeaveRequested() })
        io.execute {
            val result = LaunchApi.redeem(t)
            main.post {
                redeemInFlight = false
                if (!returned && !isDestroyed) onRedeemed(result)
            }
        }
    }

    private fun onRedeemed(r: LaunchResult) {
        when (r) {
            is LaunchResult.Ok -> {
                token = null
                onPayload(r.payload)
            }
            is LaunchResult.Failed -> if (r.retryable) {
                // لم يصل الطلب أو رُفض قبل استهلاك الرمز (429 و5xx) — الإعادة بنقرة المندوب لا تلقائياً
                stage = Stage.REDEEM_FAILED
                render(
                    r.message,
                    primary = Action("إعادة المحاولة") { redeem() },
                    secondary = Action("رجوع") { returnToWeb(null) },
                )
            } else {
                token = null
                failWithoutPayload(r.message)
            }
        }
    }

    /**
     * أُرسل الرمز ولا حمولة: قد يكون استُهلك (ضاع ردّه ثم عادت الإعادة 410) فلا معرّف عملية. الرجوع إلى /rep بلا وسيط،
     * والصفحة تفتح عند تحميلها العملية المحفوظة عندها وتسأل الخادم عن حالتها (RepApp: readPendingCardPay عند التركيب)
     */
    private fun failWithoutPayload(message: String) {
        stage = Stage.REDEEM_FAILED
        render(message, secondary = Action("رجوع إلى التطبيق") { returnToWeb(null) })
    }

    private fun onPayload(p: LaunchPayload) {
        jwt = p.jwt
        payload = p.copy(jwt = null)
        showDetails(p)
        // من هنا الخادم يحجز الفاتورة عشر دقائق ويبقى تحققه عند الاستبدال وحده — فللدفع مهلة (PURCHASE_WINDOW_MS)
        main.postDelayed(deadlineCheck, (PURCHASE_WINDOW_MS - (SystemClock.elapsedRealtime() - redeemSentAt)).coerceAtLeast(0L))
        if (p.jwt == null || p.gcpProjectNumber == null) {
            // الخادم لا يستبدل الرمز بلا مفتاح JWT ورقم مشروع Google Cloud (503 قبل الاستهلاك)؛ هذا حارسٌ لخادمٍ أقدم.
            // دخول OTP (بديل NearPay حين لا JWT) غير منفَّذ هنا عمداً
            jwt = null
            failBeforePurchase("وحدة الدفع غير مهيأة على الخادم — أبلغ مدير النظام", null)
            return
        }
        startSdk()
    }

    // ═══ ٥. التهيئة والدخول ═══

    private fun startSdk() {
        val p = payload ?: return
        val gcp = p.gcpProjectNumber ?: return failBeforePurchase("وحدة الدفع غير مهيأة على الخادم — أبلغ مدير النظام", null)
        if (session != null) return
        stage = Stage.STARTING
        render(
            "جارٍ تشغيل وحدة الدفع…",
            busy = true,
            secondary = Action("رجوع") { onLeaveRequested() },
        )
        session = NearpaySession(this, ::onPayEvent).also { it.initialize(p.production, gcp) }
    }

    private fun onPayEvent(e: PayEvent) {
        if (returned) return
        when (e) {
            // أحداث التهيئة والدخول لا تُقبل إلا في مرحلتها: مهلةٌ انقضت أو خطأٌ سبق لا يعود إلى «جاهز»
            is PayEvent.Initialized -> afterInit()
            is PayEvent.InitFailed -> if (stage == Stage.STARTING) failBeforePurchase("تعذر تشغيل وحدة الدفع على هذا الجوال", e.detail)
            is PayEvent.LoggedIn -> if (stage == Stage.STARTING) checkNfc()
            is PayEvent.LoginFailed -> if (stage == Stage.STARTING) failBeforePurchase("تعذر دخول نقطة البيع", e.detail)
            is PayEvent.Reader -> onReaderStage(e.stage)
            is PayEvent.ReadFailed -> onReadFailed(e.detail)
            is PayEvent.ReaderError -> onReaderProblem(e.detail)
            is PayEvent.Dismissed -> onReaderDismissed()
            is PayEvent.Completed -> onCompleted(e.status)
            is PayEvent.Failed -> onSendFailed(e.detail)
        }
    }

    private fun afterInit() {
        if (stage != Stage.STARTING) return
        val missing = session?.missingPermissions().orEmpty().filterNot(::granted)
        if (missing.isNotEmpty()) {
            permissionStep = PermissionStep.SDK
            permissionLauncher.launch(missing.toTypedArray())
            return
        }
        login()
    }

    private fun login() {
        if (returned || stage != Stage.STARTING) return
        val s = session ?: return
        // JWT عمره ٣٠٠ ثانية من توقيعه على الخادم، ويُستعمل مرةً واحدة
        val j = jwt ?: return failBeforePurchase("انتهت صلاحية دخول نقطة البيع", null)
        jwt = null
        render("جارٍ دخول نقطة البيع…", busy = true, secondary = Action("رجوع") { onLeaveRequested() })
        s.login(j)
    }

    /** بعد الدخول: بدالة الوحدة نفسها — وجود NFC فُحص قبل الاستبدال، وتشغيله قد يتغير بين الشاشتين */
    private fun checkNfc() {
        val s = session ?: return
        if (s.nfcEnabled()) return ready()
        if (NfcAdapter.getDefaultAdapter(this) == null) {
            return failBeforePurchase("هذا الجوال لا يدعم NFC — لا يستطيع قراءة البطاقات اللاتلامسية", null)
        }
        needNfc()
    }

    private fun openNfcSettings() {
        try {
            startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
            } catch (e2: ActivityNotFoundException) {
                toast("افتح إعدادات الجوال وشغّل NFC")
            }
        }
    }

    private fun ready() {
        if (deadlinePassed()) return expire()
        stage = Stage.READY
        // نقرة المندوب شرطٌ قبل أي خصم: الرابط يطلقه أي موقع، والمندوب يرى هنا اسمه والشركة والعميل والمبلغ من خادمنا
        render(
            "نقطة البيع جاهزة. تأكد أن اسم المندوب اسمك وراجع المبلغ، ثم اضغط «ابدأ التحصيل» واطلب من العميل تقريب بطاقته من ظهر الجوال",
            primary = Action("ابدأ التحصيل") { startPurchase() },
            secondary = Action("رجوع") { onLeaveRequested() },
        )
    }

    // ═══ ٦. مهلة بدء الدفع ═══
    // الاستبدال آخر تحققٍ للخادم قبل أن يتحرك المال (الفاتورة قائمة، والمتبقّي يتسع، ونقطة البيع للمندوب)، وحجزه للفاتورة عشر
    // دقائق (IN_PROGRESS_MS). شراءٌ يبدأ بعدها قد يخصم لفاتورةٍ سُدّدت أو أُلغيت، أو بجوار تحصيلٍ جديد أُتيح على الفاتورة نفسها.
    // فلا يبدأ purchase بعد PURCHASE_WINDOW_MS من إرسال الرمز، ويعود المندوب تلقائياً ليسأل الخادم

    private fun deadlinePassed(): Boolean =
        redeemSent && SystemClock.elapsedRealtime() - redeemSentAt >= PURCHASE_WINDOW_MS

    /** المهلة تحكم ما قبل purchase وحده — القارئ الحيّ والنتيجة المنتظرة لا يُقطعان */
    private fun deadlineDue(): Boolean =
        payload != null && !returned && deadlinePassed() &&
            (stage == Stage.STARTING || stage == Stage.NEED_NFC || stage == Stage.READY || stage == Stage.RETRYABLE)

    private fun expire() {
        settle("انتهت مهلة بدء الدفع على هذه الشاشة — يعود التطبيق لعرض حالة العملية من الخادم", null)
    }

    // ═══ ٧. الدفع ═══

    private fun startPurchase() {
        val p = payload ?: return
        val s = session ?: return
        if (stage != Stage.READY && stage != Stage.RETRYABLE) return
        if (cardTouched) return // لا يقع: لمس البطاقة يُخرج من READY وRETRYABLE — حارسٌ احتياطي لنيّةٍ لمسها قارئ
        if (deadlinePassed()) return expire()
        if (!s.nfcEnabled()) return checkNfc() // قد يُطفأ NFC بين الشاشتين
        stage = Stage.PAYING
        // قبل النداء: حدثٌ يصل من وحدةٍ رمت بعد أن بدأت يُعامَل كأي حدث قارئ
        purchaseStarted = true
        armWatchdog()
        renderPaying("جارٍ فتح القارئ…")
        if (!s.purchase(p.amountHalalas, p.intentId, p.reference)) {
            fail("رفضت وحدة الدفع بدء العملية — لم تُقرأ أي بطاقة", null)
        }
    }

    /**
     * أحداث القارئ تُقبل في كل مرحلةٍ غير نهائية بعد أول purchase — ومنها RETRYABLE وما بعدها: حدثٌ متأخر من محاولةٍ سابقة
     * دليلٌ لا يُرمى. والقارئ الحيّ يُخفي «إعادة المحاولة» فلا يبدأ شراءٌ ثانٍ فوق قارئٍ مفتوح
     */
    private fun purchaseLive(): Boolean =
        purchaseStarted && !returned && stage != Stage.SETTLED && stage != Stage.RETURNING

    private fun onReaderStage(st: ReaderStage) {
        // onReaderClosed: معناه غير موثّق («Reading Closed») — لا يُبنى عليه شيء
        if (!purchaseLive() || st == ReaderStage.CLOSED) return
        when (st) {
            // التوثيق: onReadingStarted «Card read started»، وonReaderReading «Reading card in progress»،
            // وonReaderFinished «Card read completed» — كلها قد تسبق إرسال المعاملة، فكلها لمسٌ يحبس الخروج
            ReaderStage.READING, ReaderStage.PIN, ReaderStage.CARD_READ, ReaderStage.FINISHED -> capture()
            else -> if (stage != Stage.CAPTURED) stage = Stage.PAYING
        }
        armWatchdog()
        renderPaying(
            when (st) {
                ReaderStage.DISPLAYED, ReaderStage.WAITING -> "قرّب البطاقة من ظهر الجوال وأبقِها حتى تُقرأ"
                ReaderStage.READING -> "جارٍ قراءة البطاقة — لا تُبعدها"
                ReaderStage.RETRY -> "لم تُقرأ البطاقة — قرّبها مرة أخرى"
                ReaderStage.PIN -> "العميل يُدخل الرقم السري"
                ReaderStage.CARD_READ -> "قُرئت البطاقة — جارٍ إرسال العملية، لا تغلق الشاشة"
                else -> "جارٍ إرسال العملية — لا تغلق الشاشة"
            },
        )
    }

    /** من هنا قد يتحرك المال: لا إعادة محاولة داخل الوحدة ولا خروج إلا بالنتيجة أو بعد المهلة — والخادم يحسم */
    private fun capture() {
        cardTouched = true
        cardCaptured = true
        stage = Stage.CAPTURED
    }

    private fun onReadFailed(detail: String?) {
        if (!purchaseLive()) return
        // البطاقة لُمست ولم تُقرأ: القارئ ما زال ينتظر تقريبها ثانية، لكن الإعادة على النيّة نفسها لم تعد بأيدينا
        cardTouched = true
        if (stage != Stage.CAPTURED) stage = Stage.PAYING
        armWatchdog()
        renderPaying("تعذرت قراءة البطاقة — اطلب من العميل تقريبها مرة أخرى", detail)
    }

    private fun onReaderProblem(detail: String?) {
        if (!purchaseLive()) return
        when {
            cardCaptured -> {
                stage = Stage.CAPTURED
                armWatchdog()
                renderPaying("خلل في القارئ — بانتظار نتيجة العملية…", detail)
            }
            cardTouched -> settle("خلل في القارئ بعد لمس البطاقة — يتحقق الخادم من العملية لدى NearPay", detail)
            else -> retryable("تعذر تشغيل قارئ البطاقة", detail)
        }
    }

    private fun onReaderDismissed() {
        if (!purchaseLive()) return
        when {
            cardCaptured -> {
                stage = Stage.CAPTURED
                armWatchdog()
                renderPaying("أُغلق القارئ — بانتظار نتيجة العملية…")
            }
            cardTouched -> settle("أُغلق القارئ بعد لمس البطاقة — يتحقق الخادم من العملية لدى NearPay", null)
            else -> retryable("أُغلق القارئ قبل قراءة البطاقة", null)
        }
    }

    /**
     * أُغلق القارئ أو تعطّل ولم يُرَ منه في هذا النشاط قط إلا «معروض/ينتظر/أعد التقريب»: إعادة purchase على النيّة نفسها
     * بنقرة المندوب، وفي مهلة بدء الدفع وحدها. الرجوع إلى الويب الآن يحجز الفاتورة عشر دقائق عن تحصيلٍ جديد (IN_PROGRESS_MS
     * في cardPayment.ts) لأن الرمز استُهلك.
     *
     * تحقّق عند وصول الحزمة — سؤالٌ لـNearPay في README: التوثيق يقول «the intent UUID should be unique for each transaction»،
     * ويقول أيضاً إن PurchaseResponse يعيد كل معاملات النيّة الواحدة (أي أن للنيّة معاملات)، ولا يقول ما يفعله purchase ثانٍ
     * بالنيّة نفسها بعد إغلاق القارئ. النيّة نفسها لا جديدة عمداً: خصمٌ ثانٍ لا تراه أعيننا يقع حينها على النيّة نفسها، فيراه
     * الخادم (effectiveCount > 1) ويوقف السند للمراجعة؛ أما نيّةٌ جديدة فكانت ستُقيَّد سنداً ثانياً.
     * إن رفضت الوحدة الإعادة (نيّةٌ أُلغيت، 5012) وصل onSendTransactionFailure فيعود المندوب ويحسم الخادم — لا يُحبس هنا
     */
    private fun retryable(message: String, detail: String?) {
        if (deadlinePassed()) return expire() // موقّت المهلة قد مرّ والقارئ مفتوح فلم يُعِد جدولة نفسه
        stage = Stage.RETRYABLE
        cancelWatchdog()
        render(
            message,
            detail = detail,
            primary = Action("إعادة المحاولة") { startPurchase() },
            secondary = Action("رجوع إلى التطبيق") { returnToWeb(payload?.intentId) },
        )
    }

    private fun onCompleted(status: String?) {
        if (!purchaseLive()) return
        // تلميحٌ للمندوب فقط — القرار والسند من الخادم بعد سؤاله NearPay
        settle(
            when {
                status.equals("approved", ignoreCase = true) -> "وافقت NearPay على العملية — يتحقق الخادم منها الآن ويُصدر السند"
                status.equals("declined", ignoreCase = true) -> "رُفضت البطاقة — لم يتم التحصيل"
                else -> "انتهت العملية — يتحقق الخادم من نتيجتها"
            },
            null,
        )
    }

    /**
     * كل فشل إرسالٍ قد يكون بعد أن بلغت المعاملة المضيف: SendTransactionFailure نموذجٌ واحد TransactionFailure(message) بلا
     * رمز ولا مرحلة (MOD)، فلا يُعرف أقبل الإرسال كان أم بعده. لا إعادة محاولة هنا أبداً — يعود المندوب والخادم يسأل NearPay
     */
    private fun onSendFailed(detail: String?) {
        if (!purchaseLive()) return
        settle("تعذر إكمال العملية على الجوال — يتحقق الخادم منها لدى NearPay", detail)
    }

    private fun settle(message: String, detail: String?) {
        stage = Stage.SETTLED
        cancelWatchdog()
        render(message, busy = true, detail = detail)
        val id = payload?.intentId
        main.postDelayed({ returnToWeb(id) }, RETURN_DELAY_MS)
    }

    private fun fail(message: String, detail: String?) {
        stage = Stage.FAILED
        cancelWatchdog()
        render(message, detail = detail, secondary = Action("رجوع إلى التطبيق") { returnToWeb(payload?.intentId) })
    }

    /**
     * بعد الاستبدال وقبل أي purchase: لم يُخصم شيء، لكن الرمز استُهلك فالخادم يرفض تحصيلاً جديداً على الفاتورة عشر دقائق من
     * فتح هذه الشاشة (409 «عملية جارية» ومعه «اعرض حالة العملية السابقة») — فلا يُقال للمندوب «ابدأ من جديد»
     */
    private fun failBeforePurchase(message: String, detail: String?) {
        fail("$message\nلم يُخصم شيء. تُتاح محاولة جديدة على هذه الفاتورة بعد دقائق", detail)
    }

    private fun armWatchdog() {
        escapeAllowed = false
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, WATCHDOG_MS)
    }

    private fun cancelWatchdog() {
        escapeAllowed = false
        main.removeCallbacks(watchdog)
    }

    // ═══ ٨. الرجوع ═══

    private fun onLeaveRequested() {
        when (stage) {
            // لا إلغاء برمجياً موثّقاً لعملية جارية: الإلغاء من نافذة القارئ نفسها، أو الرجوع بعد المهلة
            Stage.PAYING, Stage.CAPTURED ->
                if (escapeAllowed) returnToWeb(payload?.intentId)
                else toast(if (cardCaptured) "العملية قيد الإرسال — انتظر نتيجتها" else "للإلغاء استعمل زر الإلغاء في نافذة القارئ")
            Stage.RETURNING -> Unit
            // قبل إرسال الرمز لا عملية على الخادم (aborted)؛ بعده بلا حمولة قد يكون استُهلك (بلا وسيط: الصفحة تعرض المحفوظة)
            else -> returnToWeb(payload?.intentId, aborted = !redeemSent)
        }
    }

    /**
     * يعيد فتح TWA على صفحة المندوب:
     *  - بعد الحمولة دائماً /rep?cardpay=<المعرّف> — الصفحة تسأل الخادم والخادم يسأل NearPay.
     *  - قبل إرسال الرمز /rep?cardpay=aborted — لم تُفتح العملية على الخادم فتمحو الصفحة المحفوظة عندها.
     *  - بعد إرساله بلا حمولة /rep وحدها — الصفحة تفتح عند تحميلها العملية المحفوظة عندها وتسأل الخادم.
     *  (لا يُستعمل ?cardpay=unsupported: تلك لـChrome حين لا تكون الوحدة مثبّتة.)
     * LauncherActivity صراحةً (لا متصفح آخر ولا قائمة اختيار). NEW_TASK|CLEAR_TASK: تُفرَّغ مهمّة التطبيق (TWA القديمة وهذه
     * الشاشة) ويبدأ LauncherActivity جذراً جديداً يفتح TWA على العنوان — مهمّةٌ واحدة ونسخة TWA واحدة بلا تكدّس. الصفحة تُحمَّل
     * من جديد فتقرأ cardpay عند تركيبها، والمندوب يبقى داخلاً (جلسته في تخزين الموقع لدى Chrome لا في هذه المهمّة).
     * هذا العنوان يصير «النيّة الأساس» للمهمّة: فتحها لاحقاً من قائمة التطبيقات الأخيرة يُسقط cardpay منه (LauncherActivity).
     */
    private fun returnToWeb(intentId: String?, aborted: Boolean = false) {
        if (returned) return
        returned = true
        if (live?.get() === this) live = null
        stage = Stage.RETURNING
        main.removeCallbacksAndMessages(null)
        token = null
        jwt = null
        val result = intentId ?: if (aborted) ABORTED else null
        val uri = Uri.parse(BuildConfig.WEB_BASE).buildUpon()
            .appendPath("rep")
            .apply { if (result != null) appendQueryParameter("cardpay", result) }
            .build()
        val back = Intent(Intent.ACTION_VIEW, uri, this, LauncherActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        try {
            startActivity(back)
        } catch (e: ActivityNotFoundException) {
            // لا يقع: النشاط في التطبيق نفسه
        }
        finish()
    }

    // ═══ ٩. الواجهة (برمجية بلا XML) ═══

    private fun buildUi() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        column.addView(label(22f, INK, bold = true).apply { text = "التحصيل بالبطاقة" }, params())

        detailsCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(16).toFloat()
            }
            setPadding(dp(20), dp(16), dp(20), dp(16))
        }
        // فوق المبلغ: رمزٌ من حسابٍ آخر يظهر باسمٍ غير اسم المندوب قبل أن يضغط «ابدأ التحصيل»
        repView = label(16f, INK, bold = true)
        amountView = label(30f, CORAL, bold = true)
        linesView = label(15f, INK, center = false)
        envView = label(13f, AMBER).apply { visibility = View.GONE }
        detailsCard.addView(repView, params())
        detailsCard.addView(amountView, params(top = dp(8)))
        detailsCard.addView(linesView, params(top = dp(10)))
        detailsCard.addView(envView, params(top = dp(10)))
        column.addView(detailsCard, params(top = dp(20)))

        progress = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(CORAL)
        }
        column.addView(progress, params(width = ViewGroup.LayoutParams.WRAP_CONTENT, top = dp(24)))

        statusView = label(16f, INK)
        column.addView(statusView, params(top = dp(16)))
        detailView = label(12f, MUTED).apply { visibility = View.GONE }
        column.addView(detailView, params(top = dp(8)))

        primaryButton = MaterialButton(this).apply {
            minHeight = dp(56)
            textSize = 17f
            cornerRadius = dp(14)
            visibility = View.GONE
        }
        column.addView(primaryButton, params(top = dp(28)))
        secondaryButton = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            minHeight = dp(52)
            textSize = 16f
            cornerRadius = dp(14)
            visibility = View.GONE
        }
        column.addView(secondaryButton, params(top = dp(10)))

        val scroll = ScrollView(this).apply { isFillViewport = true }
        scroll.addView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)

        val pad = dp(24)
        column.setPadding(pad, pad, pad, pad)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            column.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun showDetails(p: LaunchPayload) {
        // الرابط عامّ والرمز بلا هوية: لا شيء يربطه بالمندوب الداخل على هذا الجوال إلا أن يقرأ اسمه هنا
        repView.text = buildString {
            if (p.repName.isNotEmpty()) append("المندوب: ${p.repName}")
            if (p.tid.length >= 4) {
                if (isNotEmpty()) append("\n")
                append("نقطة البيع: …${p.tid.takeLast(4)}")
            }
        }
        repView.visibility = if (repView.text.isNullOrEmpty()) View.GONE else View.VISIBLE
        amountView.text = sar(p.amountHalalas)
        linesView.text = buildString {
            if (p.companyName.isNotEmpty()) appendLine("الشركة: ${p.companyName}")
            if (p.customerName.isNotEmpty()) appendLine("العميل: ${p.customerName}")
            append("الفاتورة: ${p.invoiceNumber.ifEmpty { p.reference }}")
        }
        if (!p.production) {
            envView.text = "بيئة اختبار NearPay — لا يُخصم مال حقيقي"
            envView.visibility = View.VISIBLE
        }
        detailsCard.visibility = View.VISIBLE
    }

    private fun renderPaying(status: String, detail: String? = null) {
        render(
            status,
            busy = true,
            detail = detail,
            secondary = Action(if (escapeAllowed) "رجوع والتحقق من الخادم" else "رجوع") { onLeaveRequested() },
            secondaryEnabled = escapeAllowed,
        )
    }

    private fun render(
        status: String,
        busy: Boolean = false,
        detail: String? = null,
        primary: Action? = null,
        secondary: Action? = null,
        secondaryEnabled: Boolean = true,
    ) {
        val hint = nearpayHint(detail)
        statusView.text = if (hint != null) "$status\n$hint" else status
        // نص الوحدة الخام صغيراً للدعم الفني — لا سرّ فيه (الرمز وJWT لا يمرّان بالوحدة نصّاً معروضاً)
        detailView.text = detail?.take(300).orEmpty()
        detailView.visibility = if (detail.isNullOrBlank()) View.GONE else View.VISIBLE
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        bind(primaryButton, primary, true)
        bind(secondaryButton, secondary, secondaryEnabled)
    }

    private fun bind(button: MaterialButton, action: Action?, enabled: Boolean) {
        if (action == null) {
            button.visibility = View.GONE
            button.setOnClickListener(null)
            return
        }
        button.visibility = View.VISIBLE
        button.text = action.label
        button.isEnabled = enabled
        button.setOnClickListener { action.run() }
    }

    private fun label(sizeSp: Float, color: Int, bold: Boolean = false, center: Boolean = true) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textAlignment = if (center) View.TEXT_ALIGNMENT_CENTER else View.TEXT_ALIGNMENT_VIEW_START
        setLineSpacing(0f, 1.2f)
    }

    private fun params(width: Int = ViewGroup.LayoutParams.MATCH_PARENT, top: Int = 0) =
        LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = top }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    private fun sar(halalas: Long): String =
        String.format(Locale.US, "%,d.%02d ر.س", halalas / 100, halalas % 100)

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private companion object {
        const val SCHEME = "fieldsapay"
        const val HOST = "cardpay"

        // الخادم يولّد randomBytes(24) بـbase64url (٣٢ حرفاً) ويقبل ٢٠–١٠٠ (zod) — نقبل ما يقبله بأحرف base64url وحدها
        val TOKEN_RE = Regex("^[A-Za-z0-9_-]{20,100}$")

        const val KEY_REDEEM_SENT = "cardpay.redeemSent"
        const val KEY_INTENT_ID = "cardpay.intentId"
        const val EXTRA_FOCUS = "net.fieldsa.twa.cardpay.FOCUS"

        // النشاط الحيّ في هذه العملية — يُضبط بعد حارس onCreate ويُمحى في returnToWeb وonDestroy. الخيط الرئيسي وحده يلمسه
        @Volatile
        var live: WeakReference<CardPayActivity>? = null

        const val WATCHDOG_MS = 120_000L
        const val RETURN_DELAY_MS = 2_000L

        // مهلة بدء purchase بعد إرسال الرمز: دون IN_PROGRESS_MS على الخادم (عشر دقائق من launchedAt) بهامشٍ لساعتي الجهازين
        // ولزمن الطلب — فلا يبدأ خصمٌ بعد أن يُتيح الخادم تحصيلاً جديداً على الفاتورة نفسها
        const val PURCHASE_WINDOW_MS = 8 * 60_000L

        // يقرؤه الويب (RepApp): العملية لم تُفتح على الخادم، فتُمحى المحفوظة ولا تُنتظر نتيجة
        const val ABORTED = "aborted"

        val PLATFORM_PERMISSIONS = arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            // أندرويد 12+ يشترط طلب التقريبي مع الدقيق في الطلب نفسه
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_PHONE_STATE,
        )
        val REQUIRED_PLATFORM_PERMISSIONS = arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.READ_PHONE_STATE,
        )
        // الإفصاح الظاهر قبل حوار الأذونات: ما يُجمع، ومن يجمعه (طرفٌ ثالث)، ولماذا. لا غاية أبعد مما في توثيق NearPay
        // (الوحدة تشترط الإذنين وتفشل تهيئتها بلا إذن الموقع) — فلا يُدّعى هنا «منع احتيال» لم يوثَّق
        const val PERMISSION_DISCLOSURE =
            "لقبول البطاقة تشترط NearPay، مزوّد خدمة الدفع، إذنَي الموقع الدقيق وحالة الهاتف. حين تمنحهما تصل وحدة NearPay " +
                "داخل هذا التطبيق إلى موقع الجوال وبيانات الجهاز والشريحة أثناء التحصيل بالبطاقة لتشغيل الدفع. " +
                "اضغط «متابعة» ثم اسمح بالإذنين، واختر «الموقع الدقيق»."

        // هوية فيلد سيلز: مرجاني وحبر
        val CORAL = Color.rgb(0xE1, 0x5A, 0x30)
        val INK = Color.rgb(0x1F, 0x1B, 0x18)
        val MUTED = Color.rgb(0x6F, 0x68, 0x62)
        val AMBER = Color.rgb(0xB4, 0x53, 0x09)
        val NAV_SCRIM_DARK = Color.argb(0x80, 0x1B, 0x1B, 0x1B)
    }
}
