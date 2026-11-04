package net.fieldsa.twa.track

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.button.MaterialButton
import net.fieldsa.twa.BuildConfig
import kotlin.math.roundToInt

/**
 * بدء التتبّع الخلفي وإيقافه من صفحة المندوب (web-admin/src/rep/nativeTracking.ts):
 *   fieldsatrack://start?t=<رمز التتبّع>   ·   fieldsatrack://stop
 *
 * الرابط يطلقه أي موقع أو تطبيق، فهو مدخلٌ غير موثوق: ACTION_VIEW والمخطط والمضيف وحدها، لا extras، والرمز بشكل JWT (ثلاثة أجزاء
 * base64url، ≤ ٤٠٩٦ حرفاً) وغير منتهٍ وبهويةٍ مقروءة. والموافقة على الإفصاح مربوطةٌ بهوية الرمز (المندوب والشركة): رمزٌ لحسابٍ آخر
 * يعرض الإفصاح من جديد بتنبيهٍ صريح ولا يستبدل الرمز الجاري بصمت — فلا يستطيع موقعٌ غريب أن يحوّل موقع المندوب إلى شركةٍ أخرى
 * بموافقةٍ أعطاها لشركته (مراجعة ٤ نوفمبر).
 *
 * الشاشة غير شفافة عمداً (Theme.FieldSales.Track)، كشاشة جسر الطباعة: تغطي المتصفح فيتوقف ويطلق visibilitychange، وبه تعرف
 * الصفحة أن البدء سُلِّم (launchIntent في appBridge.ts) — نشاطٌ شفاف يُبقي الصفحة «ظاهرة» فتعيد المحاولة مع كل فتح. ثم تقول
 * للمندوب لحظةً إن التسجيل بدأ أو توقف وتنتهي، فيعود إلى صفحته كما تركها (مهمّةٌ مستقلة بنسخةٍ واحدة، خارج القائمة الأخيرة).
 */
class TrackActivity : AppCompatActivity() {

    private enum class State { IDLE, DISCLOSURE, PERMISSION, NOTIFY, DONE }

    private val main = Handler(Looper.getMainLooper())
    private var state = State.IDLE
    private var pendingToken: String? = null
    private var pendingIdentity: TrackIdentity? = null
    private var pendingDebugUrl: String? = null
    private var dialog: AlertDialog? = null

    private lateinit var spinner: ProgressBar
    private lateinit var statusView: TextView
    private lateinit var backButton: MaterialButton

    private val locationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ -> onLocationAnswer() }

    // جواب إذن الإشعارات لا يغيّر شيئاً: الخدمة بدأت قبله
    private val notifyLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> finishSoon(AUTO_FINISH_MS) }

    private val autoFinish = Runnable { if (!isFinishing) finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, NAV_SCRIM_DARK),
        )
        super.onCreate(savedInstanceState)
        // من قائمة التطبيقات الأخيرة يعيد أندرويد تسليم الرابط القديم، وبعد موت العملية لا رمز محفوظ في الحزمة: لا بدء تلقائي
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0 || savedInstanceState != null) {
            finish()
            return
        }
        buildUi()
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // حوارٌ أو سؤال إذنٍ مفتوح: الرابط الثاني يُهمل (الصفحة تعيد المحاولة في الفتح التالي)
        if (state == State.DISCLOSURE || state == State.PERMISSION || state == State.NOTIFY) return
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
        setIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        dialog?.dismiss()
        dialog = null
        super.onDestroy()
    }

    // ═══ ١. الرابط ═══

    private fun handle(i: Intent?) {
        main.removeCallbacks(autoFinish)
        state = State.IDLE
        pendingToken = null
        pendingIdentity = null
        pendingDebugUrl = null
        val u = if (i?.action == Intent.ACTION_VIEW) i.data else null
        if (u == null || u.scheme != TrackContract.SCHEME || !u.isHierarchical) return showBadLink()
        when (u.host) {
            TrackContract.HOST_STOP -> stopTracking()
            TrackContract.HOST_START -> startRequested(u)
            else -> showBadLink()
        }
    }

    private fun query(u: Uri, name: String): String? = try {
        u.getQueryParameter(name)
    } catch (e: UnsupportedOperationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    private fun stopTracking() {
        state = State.DONE
        TrackStore.clearToken(this)
        TrackService.stop(this)
        render("توقّف تسجيل الموقع")
        finishSoon(AUTO_FINISH_MS)
    }

    private fun startRequested(u: Uri) {
        val token = query(u, TrackContract.PARAM_TOKEN)
        if (!TrackLogic.looksLikeToken(token)) return showBadLink()
        val identity = TrackLogic.tokenIdentity(token) ?: return showBadLink()
        if (TrackLogic.tokenExpired(token, System.currentTimeMillis())) return showBadLink()
        pendingToken = token
        pendingIdentity = identity
        // عنوان الرفع البديل لبناء التطوير وحده؛ الإصدار يُهمل المعامل كلياً
        pendingDebugUrl = if (BuildConfig.DEBUG) query(u, TrackContract.PARAM_DEBUG_URL)?.takeIf { TrackLogic.acceptableDebugUrl(it) } else null
        if (TrackStore.consentedTo(this, identity)) afterConsent() else showDisclosure(identity)
    }

    // ═══ ٢. الإفصاح والموافقة ═══

    private fun showDisclosure(identity: TrackIdentity) {
        state = State.DISCLOSURE
        render("تسجيل الموقع", busy = false)
        // وافق من قبل لحسابٍ آخر: الطلب لحسابٍ غير الذي وافق له — يقال ذلك صراحةً قبل أي تسجيل
        val otherAccount = TrackStore.everConsented(this)
        val message = if (otherAccount) "$DISCLOSURE_BODY\n\n$OTHER_ACCOUNT_NOTE" else DISCLOSURE_BODY
        dialog = AlertDialog.Builder(this)
            .setTitle(DISCLOSURE_TITLE)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("موافق") { _, _ ->
                dialog = null
                TrackStore.saveConsent(this, identity)
                afterConsent()
            }
            .setNegativeButton("ليس الآن") { _, _ ->
                dialog = null
                declined()
            }
            .show()
    }

    private fun declined() {
        state = State.DONE
        render("لم يبدأ تسجيل الموقع")
        finishSoon(AUTO_FINISH_MS)
    }

    // ═══ ٣. إذن الموقع ═══

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun afterConsent() {
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) return begin()
        state = State.PERMISSION
        render("يحتاج تسجيل الموقع إذن الموقع الدقيق", busy = true)
        // FINE وCOARSE معاً: أندرويد 12+ يشترطهما في الطلب نفسه
        try {
            locationLauncher.launch(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            )
        } catch (e: RuntimeException) {
            onLocationAnswer()
        }
    }

    private fun onLocationAnswer() {
        if (state != State.PERMISSION) return
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) return begin()
        state = State.DONE
        render("لم يبدأ تسجيل الموقع: يحتاج إذن الموقع الدقيق. يمكنك السماح به من إعدادات التطبيق ثم فتح التطبيق من جديد.")
        finishSoon(MESSAGE_FINISH_MS)
    }

    // ═══ ٤. البدء ═══

    private fun begin() {
        val token = pendingToken
        val identity = pendingIdentity
        if (token == null || identity == null || !TrackStore.consentedTo(this, identity)) return showBadLink()
        val now = System.currentTimeMillis()
        TrackStore.saveStart(this, token, TrackLogic.dayKey(now), pendingDebugUrl)
        pendingToken = null
        if (!TrackService.start(this)) {
            state = State.DONE
            render("تعذّر بدء تسجيل الموقع — افتح التطبيق من جديد")
            finishSoon(MESSAGE_FINISH_MS)
            return
        }
        state = State.DONE
        render("بدأ تسجيل موقعك لهذا اليوم — يظهر إشعارٌ ثابت ما دام يعمل")
        // أندرويد 13+: إذن الإشعارات يُطلب ولا يُنتظر — الخدمة تعمل بلا إذنه، والإشعار يظهر في «مدير المهام» على الأقل
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !granted(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            state = State.NOTIFY
            try {
                notifyLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            } catch (e: RuntimeException) {
                // يكمل إلى الإنهاء
            }
        }
        state = State.DONE
        finishSoon(AUTO_FINISH_MS)
    }

    private fun showBadLink() {
        state = State.DONE
        pendingToken = null
        render("تعذّر بدء تسجيل الموقع — افتح التطبيق من جديد")
        finishSoon(MESSAGE_FINISH_MS)
    }

    private fun finishSoon(delayMs: Long) {
        main.removeCallbacks(autoFinish)
        main.postDelayed(autoFinish, delayMs)
    }

    // ═══ ٥. الواجهة (مبنية بالكود كشاشة الطباعة) ═══

    private fun buildUi() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        column.addView(label(22f, INK, bold = true).apply { text = "تسجيل الموقع" }, params())
        spinner = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(CORAL)
            visibility = View.GONE
        }
        column.addView(spinner, params(width = ViewGroup.LayoutParams.WRAP_CONTENT, top = dp(24)))
        statusView = label(16f, INK)
        column.addView(statusView, params(top = dp(16)))
        backButton = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            minHeight = dp(52)
            textSize = 16f
            cornerRadius = dp(14)
            text = "رجوع"
            setOnClickListener { finish() }
        }
        column.addView(backButton, params(top = dp(28)))
        setContentView(column)

        val pad = dp(24)
        column.setPadding(pad, pad, pad, pad)
        ViewCompat.setOnApplyWindowInsetsListener(column) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            column.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun render(status: String, busy: Boolean = false) {
        statusView.text = status
        spinner.visibility = if (busy) View.VISIBLE else View.GONE
        // لا «رجوع» أثناء حوار الإفصاح أو سؤال الإذن: الجواب يقرّر
        backButton.visibility = if (state == State.DISCLOSURE || state == State.PERMISSION) View.GONE else View.VISIBLE
    }

    private fun label(sizeSp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textAlignment = View.TEXT_ALIGNMENT_CENTER
        setLineSpacing(0f, 1.2f)
    }

    private fun params(width: Int = ViewGroup.LayoutParams.MATCH_PARENT, top: Int = 0) =
        LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = top }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    companion object {
        const val AUTO_FINISH_MS = 1_200L
        const val MESSAGE_FINISH_MS = 3_500L

        const val DISCLOSURE_TITLE = "تسجيل موقعك أثناء اليوم"
        const val DISCLOSURE_BODY =
            "يسجّل فيلد سيلز موقعك أثناء يوم العمل حتى لو خرجت من التطبيق أو أقفلت الشاشة، ليظهر لمديرك على خريطة التتبّع. " +
                "يتوقف التسجيل عند تسجيل الخروج أو في نهاية اليوم، ويظهر إشعار ثابت ما دام يعمل."
        const val OTHER_ACCOUNT_NOTE =
            "تنبيه: هذا الطلب لحسابٍ غير الحساب الذي وافقت له من قبل على هذا الجوال. لا توافق إلا إن كنت سجّلت الدخول الآن " +
                "بحسابك في تطبيق فيلد سيلز."

        // هوية فيلد سيلز: مرجاني وحبر — كشاشة الطباعة
        private val CORAL = Color.rgb(0xE1, 0x5A, 0x30)
        private val INK = Color.rgb(0x1F, 0x1B, 0x18)
        private val NAV_SCRIM_DARK = Color.argb(0x80, 0x1B, 0x1B, 0x1B)
    }
}
