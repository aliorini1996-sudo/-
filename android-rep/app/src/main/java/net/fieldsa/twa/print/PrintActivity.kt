package net.fieldsa.twa.print

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.ActivityNotFoundException
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
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
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
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * جسر الطباعة المباشرة: صفحة المندوب (أو أي صفحة من fieldsa.net في متصفح أندرويد بلا Web Serial) تفتح
 * intent://print?k=<المفتاح>&p=<الحمولة>#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end أي fieldsaprint://print?…،
 * فيطبع هذا النشاط بايتات الأمر نفسها التي كان Web Serial سيرسلها على طابعة البلوتوث المقترنة، ثم ينتهي فيعود المندوب إلى
 * صفحته كما تركها — لا إعادة تحميل ولا فتح لـLauncherActivity من هنا. fieldsaprint://printer يفتح اختيار الطابعة وحده.
 *
 * الرابط يطلقه أي موقع أو تطبيق، فهو مدخلٌ غير موثوق: ACTION_VIEW والمخطط والمضيف وحدها، لا extras ولا content:/file:،
 * والحمولة بحدودها ومجموعها وبنيتها (PrintPayload)، والطباعة الصامتة لا تكون إلا إن طابق k مفتاح هذا التثبيت (PrinterStore)
 * — وإلا شاشة تأكيد فيها اسم المستند والطابعة ونقرة «اطبع». أمرٌ واحد في كل مرة في العملية كلها (busy)، ولا طباعة تلقائية
 * بعد موت العملية أو من قائمة التطبيقات الأخيرة. المهمّة مستقلة ومستثناة من القائمة ولا تُحفظ على القرص (persistNever) فلا
 * يُكتب الرابط الكبير في أي مكان.
 *
 * لا بحث عن أجهزة: المقترنة وحدها (لا BLUETOOTH_SCAN ولا موقع). على أندرويد 12+ إذن «الأجهزة القريبة» (BLUETOOTH_CONNECT)
 * بعد شاشة إفصاح ونقرة «متابعة». الاتصال والكتابة على خيط io، والواجهة على الخيط الرئيسي وحده.
 */
class PrintActivity : AppCompatActivity() {

    private enum class Mode { PRINT, PICK_ONLY }

    private enum class State {
        IDLE, // لا شاشة ثابتة: proceed() يقرر
        DECODING,
        BAD_LINK,
        NO_BT,
        PERMISSION,
        BT_OFF,
        PICK,
        CONFIRM,
        CONNECTING,
        PRINTING,
        CANCELLING,
        DONE,
        FAILED,
        INTERRUPTED,
    }

    private sealed class Outcome {
        object Done : Outcome()
        object Cancelled : Outcome()
        class Failed(val failure: PrintFailure) : Outcome()
    }

    private class Action(val label: String, val run: () -> Unit)

    /** طابعةٌ مقترنة بما عُرف عنها لحظة القراءة (الاسم والصنف والخدمات تحتاج الإذن على 12+ فتُقرأ مرةً هنا) */
    private class PrinterRow(val device: BluetoothDevice, val name: String?, val likelyPrinter: Boolean) {
        val address: String = device.address
    }

    /**
     * يوصل نتائج خيط io إلى الواجهة دون أن يمسك النشاط: مرجعٌ ضعيف، ويُهمل ما وصل بعد انتهاء النشاط أو لأمرٍ أقدم (generation)
     */
    private class UiSink(activity: PrintActivity, private val main: Handler, private val generation: Int) {
        private val ref = WeakReference(activity)

        fun post(block: (PrintActivity) -> Unit) {
            main.post {
                val a = ref.get() ?: return@post
                if (!a.isDestroyed && !a.isFinishing && a.generation == generation) block(a)
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var mode = Mode.PRINT
    private var state = State.IDLE
    private var generation = 0 // يزيد مع كل رابط: نتيجةٌ لرابطٍ أقدم تُهمل
    private var job: PrintJob? = null
    private var trusted = false
    private var confirmed = false
    private var forcePicker = false
    private var restored = false // أُعيد إنشاء النشاط (موت العملية أو تغيّر إعداد): لا طباعة صامتة
    private var permissionAsked = false
    private var started = false // بدأت طباعةٌ في هذه النسخة ولم تكتمل
    private var printer: BluetoothPrinter? = null
    private var cancelFlag: AtomicBoolean? = null
    private var cancelStalled = false // طُلب الإلغاء ولم تتقدم الكتابة مدةً: «رجوع» يقطع الاتصال
    private var printerName: String? = null

    private lateinit var labelView: TextView
    private lateinit var printerView: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var bar: ProgressBar
    private lateinit var statusView: TextView
    private lateinit var pickerBox: LinearLayout
    private lateinit var primaryButton: MaterialButton
    private lateinit var secondaryButton: MaterialButton
    private lateinit var tertiaryButton: MaterialButton

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
            permissionAsked = true
            proceed()
        }

    private val enableBluetoothLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            proceed()
            // بعض الجوالات تعيد الحوار قبل أن يكتمل التشغيل: نظرةٌ ثانية بعد لحظة بدل أن يبقى «البلوتوث مطفأ»
            if (r.resultCode == RESULT_OK && state == State.BT_OFF) main.postDelayed(bluetoothRecheck, BT_RECHECK_MS)
        }

    private val bluetoothRecheck = Runnable { if (state == State.BT_OFF) proceed() }

    // ‏connect() ينتهي وحده بعد نحو ١٢ ثانية؛ هذا حدٌّ أعلى لا يُترك بعده المندوب أمام «جارٍ الاتصال»
    private val connectWatchdog = Runnable {
        if (state == State.CONNECTING) printer?.abort()
    }

    // طابعةٌ تتوقف عن الاستقبال (ورقٌ نفد، غطاءٌ مفتوح) تُعلّق write() فلا تبلغ الكتابة نقطة الإلغاء أبداً: بعد مهلةٍ بلا تقدّم
    // يظهر «رجوع» فيقطع الاتصال — وإلا بقي المندوب أمام «جارٍ إلغاء الطباعة…» بلا مخرج والطابعة محجوزة حتى موت العملية
    private val cancelStall = Runnable {
        if (state == State.CANCELLING && !cancelStalled) {
            cancelStalled = true
            renderCancelling()
        }
    }

    private val autoFinish = Runnable { if (!isFinishing) finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        // أندرويد 15+ يفرض العرض من الحافة إلى الحافة — كشاشة التحصيل بالبطاقة
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, NAV_SCRIM_DARK),
        )
        super.onCreate(savedInstanceState)
        // من قائمة التطبيقات الأخيرة يعيد أندرويد تسليم الرابط القديم: لا يُطبع ثانية
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            finish()
            return
        }
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })
        if (savedInstanceState != null) {
            restored = true
            permissionAsked = savedInstanceState.getBoolean(KEY_PERMISSION_ASKED)
            if (savedInstanceState.getBoolean(KEY_STARTED)) {
                showInterrupted()
                return
            }
        }
        handle(intent, consented = false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (state == State.CONNECTING || state == State.PRINTING || state == State.CANCELLING) {
            toast("طباعة جارية — انتظر حتى تنتهي ثم أعد الطباعة")
            return
        }
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
        setIntent(intent)
        restored = false
        handle(intent, consented = false)
    }

    override fun onResume() {
        super.onResume()
        // رجوعٌ من حوار الإذن أو الإعدادات أو إقران طابعة: تُعاد القراءة. الشاشات الأخرى لا تتحرك وحدها
        if (state == State.PERMISSION || state == State.BT_OFF || state == State.PICK) proceed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // أعلامٌ وحدها: لا حمولة ولا مفتاح (الحزمة قد تُكتب على القرص)
        outState.putBoolean(KEY_STARTED, started)
        outState.putBoolean(KEY_PERMISSION_ASKED, permissionAsked)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        // اتصالٌ لا شاشة له يُقطع؛ أما أمرٌ بدأت كتابته فيكمل على io حتى نهايته (لا ورقة مبتورة) وتُهمل نتيجته
        if (state == State.CONNECTING) printer?.abort()
        // shutdown لا shutdownNow: لا مقاطعة في منتصف الكتابة
        io.shutdown()
        super.onDestroy()
    }

    // ═══ ١. الرابط ═══

    private fun handle(i: Intent?, consented: Boolean) {
        generation++
        main.removeCallbacks(autoFinish)
        main.removeCallbacks(connectWatchdog)
        main.removeCallbacks(cancelStall)
        main.removeCallbacks(bluetoothRecheck)
        cancelStalled = false
        job = null
        trusted = false
        confirmed = consented
        forcePicker = false
        started = false
        printerName = null
        state = State.IDLE

        val u = if (i?.action == Intent.ACTION_VIEW) i.data else null
        if (u == null || u.scheme != BridgeContract.SCHEME || !u.isHierarchical) return showBadLink()
        when (u.host) {
            BridgeContract.HOST_PRINTER -> {
                mode = Mode.PICK_ONLY
                proceed()
            }
            BridgeContract.HOST_PRINT -> {
                mode = Mode.PRINT
                val payload = query(u, BridgeContract.PARAM_PAYLOAD) ?: return showBadLink()
                val key = query(u, BridgeContract.PARAM_KEY)
                state = State.DECODING
                render("جارٍ تجهيز الطباعة…", busy = true, secondary = Action("رجوع") { finish() })
                decode(payload, key)
            }
            else -> showBadLink()
        }
    }

    private fun query(u: Uri, name: String): String? = try {
        u.getQueryParameter(name)
    } catch (e: UnsupportedOperationException) {
        null
    }

    /** الفكّ (حتى ٥ م.ب) وقراءة المفتاح المحفوظ على io — لا شيء من النشاط يُمسك هناك */
    private fun decode(payload: String, key: String?) {
        val sink = UiSink(this, main, generation)
        val app = applicationContext
        val allowSilent = !restored
        try {
            io.execute {
                val decoded = try {
                    PrintPayload.decode(payload)
                } catch (e: PayloadException) {
                    null
                } catch (e: RuntimeException) {
                    null
                } catch (e: OutOfMemoryError) {
                    null // حتى ٩ م.ب على جوالٍ ضعيف: «تعذرت القراءة» لا انهيار التطبيق من خيط io
                }
                val silent = allowSilent && decoded != null && PrinterStore.keyMatches(app, key)
                sink.post { it.onDecoded(decoded, silent) }
            }
        } catch (e: RejectedExecutionException) {
            showBadLink()
        }
    }

    private fun onDecoded(decoded: PrintJob?, silent: Boolean) {
        if (state != State.DECODING) return
        if (decoded == null) return showBadLink()
        job = decoded
        trusted = silent
        state = State.IDLE
        proceed()
    }

    // ═══ ٢. القرار — كل نداءٍ (إذن، تشغيل البلوتوث، رجوع إلى الواجهة، اختيار، تأكيد، إعادة) يمرّ من هنا ═══

    private fun proceed() {
        when (state) {
            State.DECODING, State.CONNECTING, State.PRINTING, State.CANCELLING,
            State.DONE, State.BAD_LINK, State.INTERRUPTED,
            -> return
            else -> Unit
        }
        if (mode == Mode.PRINT && job == null) return showBadLink()
        val adapter = bluetoothAdapter() ?: return showNoBluetooth()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
            return showPermission()
        }
        if (!isEnabled(adapter)) return showBluetoothOff()
        val rows = bondedPrinters(adapter) ?: return showPermission()
        val savedAddress = PrinterStore.savedAddress(this)
        val saved = rows.firstOrNull { it.address == savedAddress }
        if (mode == Mode.PICK_ONLY || forcePicker || saved == null) return showPicker(rows)
        val j = job ?: return showBadLink()
        printerName = displayName(saved)
        if (!trusted && !confirmed) return showConfirm()
        startPrint(saved.device, j)
    }

    private fun bluetoothAdapter(): BluetoothAdapter? =
        // BluetoothManager لا getDefaultAdapter (مُهمَل على 31+)؛ null ⇒ الجوال بلا بلوتوث
        ContextCompat.getSystemService(this, BluetoothManager::class.java)?.adapter

    // isEnabled لا يحتاج إذناً على 12+، ويكفيه BLUETOOTH (مثبَّت مع التطبيق) على 11 فأقدم
    @SuppressLint("MissingPermission")
    private fun isEnabled(adapter: BluetoothAdapter): Boolean = try {
        adapter.isEnabled
    } catch (e: SecurityException) {
        false
    }

    /**
     * الأجهزة المقترنة بترتيبٍ يُقدّم الطابعات (خدمة SPP أو صنف «تصوير») ثم بالاسم. null ⇒ SecurityException (الإذن سُحب).
     * يُستدعى بعد فحص BLUETOOTH_CONNECT على 12+ في proceed()
     */
    @SuppressLint("MissingPermission")
    private fun bondedPrinters(adapter: BluetoothAdapter): List<PrinterRow>? = try {
        val spp = UUID.fromString(BridgeContract.SPP_UUID)
        adapter.bondedDevices.orEmpty()
            .filter { it.type != BluetoothDevice.DEVICE_TYPE_LE } // الطابعات هنا كلاسيكية (RFCOMM)؛ BLE وحده لا يُطبع عليه
            .map { d ->
                val hasSpp = d.uuids?.any { it?.uuid == spp } == true
                val imaging = d.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.IMAGING
                PrinterRow(d, d.name?.takeIf { it.isNotBlank() }, hasSpp || imaging)
            }
            .sortedWith(compareBy<PrinterRow>({ !it.likelyPrinter }, { it.name == null }, { it.name.orEmpty() }))
    } catch (e: SecurityException) {
        null
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun displayName(row: PrinterRow): String = row.name ?: "طابعة بلا اسم"

    // ═══ ٣. الشاشات ═══

    private fun showBadLink() {
        state = State.BAD_LINK
        render("تعذرت قراءة أمر الطباعة — أعد الطباعة من التطبيق", secondary = Action("رجوع") { finish() })
    }

    private fun showNoBluetooth() {
        state = State.NO_BT
        render("هذا الجوال لا يدعم البلوتوث", secondary = Action("رجوع") { finish() })
    }

    /**
     * إفصاحٌ ظاهر قبل حوار النظام: الحوار لا يُطلب إلا من نقرة «متابعة». بعد رفضٍ: «منح الإذن»، أو الإعدادات إن صار الرفض
     * نهائياً (لا يُظهر النظام الحوار ثانية)
     */
    private fun showPermission() {
        state = State.PERMISSION
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // لا إذن يُطلب قبل 12: BLUETOOTH مثبَّت مع التطبيق، فـSecurityException هنا لا علاج له من الشاشة
            render("لا يمكن الطباعة دون إذن «الأجهزة القريبة».", secondary = Action("رجوع") { finish() })
            return
        }
        if (!permissionAsked) {
            render(
                PERMISSION_DISCLOSURE,
                primary = Action("متابعة") { requestConnectPermission() },
                secondary = Action("رجوع") { finish() },
            )
            return
        }
        val blocked = !shouldShowRequestPermissionRationale(Manifest.permission.BLUETOOTH_CONNECT)
        render(
            "لا يمكن الطباعة دون إذن «الأجهزة القريبة».\n$PERMISSION_DISCLOSURE",
            primary = if (blocked) Action("فتح إعدادات التطبيق") { openAppSettings() }
            else Action("منح الإذن") { requestConnectPermission() },
            secondary = Action("رجوع") { finish() },
        )
    }

    private fun requestConnectPermission() {
        if (state != State.PERMISSION || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
    }

    private fun showBluetoothOff() {
        state = State.BT_OFF
        render(
            "البلوتوث مطفأ — شغله للطباعة",
            primary = Action("تشغيل البلوتوث") { requestEnableBluetooth() },
            secondary = Action("رجوع") { finish() },
        )
    }

    // ACTION_REQUEST_ENABLE يشترط BLUETOOTH_CONNECT على 12+ — لا تصل هذه الشاشة إلا بعد منحه (proceed)
    @SuppressLint("MissingPermission")
    private fun requestEnableBluetooth() {
        try {
            enableBluetoothLauncher.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
        } catch (e: ActivityNotFoundException) {
            openBluetoothSettings()
        } catch (e: SecurityException) {
            proceed()
        }
    }

    private fun showPicker(rows: List<PrinterRow>) {
        state = State.PICK
        render(
            if (rows.isEmpty()) "لا توجد أجهزة مقترنة بهذا الجوال — اقرن الطابعة من إعدادات البلوتوث ثم ارجع"
            else "اختر الطابعة\nتظهر هنا الأجهزة المقترنة بالجوال. إن لم تجد طابعتك فاقرنها من إعدادات البلوتوث ثم ارجع",
            doc = mode == Mode.PRINT,
            primary = Action("إقران طابعة من الإعدادات") { openBluetoothSettings() },
            secondary = Action("رجوع") { finish() },
        )
        for (row in rows) {
            val b = outlinedButton().apply {
                // outlinedButton() يبدأ مخفيّاً (لأزرار bind) — كان صفّ الطابعة لا يظهر في 1.2.0 فبدت القائمة فارغة
                visibility = View.VISIBLE
                text = "${displayName(row)} …${row.address.takeLast(5)}"
                setOnClickListener { onPicked(row) }
            }
            pickerBox.addView(b, params(top = dp(8)))
        }
        pickerBox.visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun onPicked(row: PrinterRow) {
        if (state != State.PICK) return
        PrinterStore.savePrinter(this, row.address, row.name)
        if (mode == Mode.PICK_ONLY) {
            state = State.DONE
            render("تم اختيار الطابعة: ${displayName(row)}")
            main.postDelayed(autoFinish, AUTO_FINISH_MS)
            return
        }
        forcePicker = false
        state = State.IDLE
        proceed()
    }

    private fun showConfirm() {
        state = State.CONFIRM
        render(
            "تأكيد الطباعة",
            doc = true,
            primary = Action("اطبع") {
                if (state == State.CONFIRM) {
                    confirmed = true
                    state = State.IDLE
                    proceed()
                }
            },
            secondary = Action("تغيير الطابعة") { changePrinter() },
            tertiary = Action("إلغاء") { finish() },
        )
    }

    private fun changePrinter() {
        forcePicker = true
        state = State.IDLE
        proceed()
    }

    private fun showInterrupted() {
        state = State.INTERRUPTED
        render(
            "توقفت الطباعة قبل أن تكتمل",
            primary = Action("إعادة الطباعة") {
                // النقرة موافقةٌ صريحة: الرابط نفسه بالمسار العادي بلا شاشة تأكيد ثانية
                if (state == State.INTERRUPTED) handle(intent, consented = true)
            },
            secondary = Action("رجوع") { finish() },
        )
    }

    // ═══ ٤. الطباعة ═══

    private fun startPrint(device: BluetoothDevice, j: PrintJob) {
        if (!busy.compareAndSet(false, true)) {
            // أمرٌ آخر يُكتب الآن (نسخةٌ سابقة من الشاشة): لا مقبسان على طابعة واحدة
            state = State.FAILED
            renderFailed("طباعة جارية — انتظر حتى تنتهي ثم أعد الطباعة")
            return
        }
        state = State.CONNECTING
        started = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        render(
            "جارٍ الاتصال بالطابعة…",
            busy = true,
            doc = true,
            secondary = Action("إلغاء") { onBack() },
        )
        val p = BluetoothPrinter()
        val cancel = AtomicBoolean(false)
        printer = p
        cancelFlag = cancel
        val sink = UiSink(this, main, generation)
        main.postDelayed(connectWatchdog, CONNECT_TIMEOUT_MS)
        try {
            io.execute {
                var lastPct = -1
                val outcome = try {
                    val cancelled = p.print(device, j, { cancel.get() }) { sent, total ->
                        if (sent == 0) {
                            sink.post { it.onConnected() }
                        } else {
                            val pct = (sent * 100L / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                sink.post { it.onProgress(pct) }
                            }
                        }
                    }
                    if (cancelled) Outcome.Cancelled else Outcome.Done
                } catch (e: PrintException) {
                    Outcome.Failed(e.failure)
                } catch (e: RuntimeException) {
                    Outcome.Failed(PrintFailure.DISCONNECTED)
                } finally {
                    busy.set(false)
                }
                sink.post { it.onFinished(outcome) }
            }
        } catch (e: RejectedExecutionException) {
            busy.set(false)
            onFinished(Outcome.Failed(PrintFailure.CONNECT))
        }
    }

    private fun onConnected() {
        if (state != State.CONNECTING) return
        main.removeCallbacks(connectWatchdog)
        state = State.PRINTING
        renderPrinting(0)
    }

    private fun onProgress(pct: Int) {
        when (state) {
            State.PRINTING -> renderPrinting(pct)
            State.CANCELLING -> {
                bar.progress = pct
                // الكتابة تتقدم نحو نقطة الإلغاء: مهلة التعليق تبدأ من جديد
                if (!cancelStalled) {
                    main.removeCallbacks(cancelStall)
                    main.postDelayed(cancelStall, CANCEL_STALL_MS)
                }
            }
            else -> Unit
        }
    }

    private fun renderPrinting(pct: Int) {
        render(
            String.format(Locale.US, "جارٍ الطباعة %d%%", pct),
            percent = pct,
            doc = true,
            secondary = Action("إلغاء الطباعة") { onBack() },
        )
    }

    private fun onFinished(outcome: Outcome) {
        main.removeCallbacks(connectWatchdog)
        main.removeCallbacks(cancelStall)
        cancelStalled = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        printer = null
        cancelFlag = null
        when (outcome) {
            Outcome.Done, Outcome.Cancelled -> {
                started = false
                state = State.DONE
                render(if (outcome == Outcome.Done) "تمت الطباعة" else "ألغيت الطباعة", doc = true)
                main.postDelayed(autoFinish, AUTO_FINISH_MS)
            }
            is Outcome.Failed -> when (outcome.failure) {
                // سُحب الإذن أثناء الطباعة ⇒ شاشة الإذن. وإن بقي ممنوحاً فلا إعادة تلقائية (لا حلقة): المندوب يعيد بنقرة
                PrintFailure.PERMISSION ->
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
                        state = State.IDLE
                        proceed()
                    } else {
                        state = State.FAILED
                        renderFailed("تعذر الاتصال بالطابعة — تأكد أنها مشغلة وقريبة وغير متصلة بجهاز آخر")
                    }
                PrintFailure.CONNECT -> {
                    state = State.FAILED
                    renderFailed("تعذر الاتصال بالطابعة — تأكد أنها مشغلة وقريبة وغير متصلة بجهاز آخر")
                }
                PrintFailure.DISCONNECTED -> {
                    state = State.FAILED
                    renderFailed("انقطع الاتصال بالطابعة — أعد تشغيل الطابعة وحاول")
                }
            }
        }
    }

    private fun renderFailed(message: String) {
        render(
            message,
            doc = true,
            primary = Action("إعادة المحاولة") {
                if (state == State.FAILED) {
                    state = State.IDLE
                    proceed()
                }
            },
            secondary = Action("تغيير الطابعة") { if (state == State.FAILED) changePrinter() },
            tertiary = Action("رجوع") { finish() },
        )
    }

    /**
     * الرجوع: الاتصال يُقطع ويُغلق، والكتابة تتوقف عند نقطةٍ آمنة (لا ورقة نصف مطبوعة بلا أمر إلغاء)، والإلغاء لا يُقاطع —
     * إلا إن عُلّقت الكتابة (cancelStall) فيقطعها «رجوع»
     */
    private fun onBack() {
        when (state) {
            State.CONNECTING -> {
                printer?.abort()
                finish()
            }
            State.PRINTING -> {
                cancelFlag?.set(true)
                state = State.CANCELLING
                cancelStalled = false
                renderCancelling()
                main.postDelayed(cancelStall, CANCEL_STALL_MS)
            }
            State.CANCELLING -> if (cancelStalled) forceStop()
            else -> finish()
        }
    }

    private fun renderCancelling() {
        render(
            "جارٍ إلغاء الطباعة…",
            percent = bar.progress,
            doc = true,
            secondary = if (cancelStalled) Action("رجوع") { forceStop() } else null,
        )
    }

    /** الكتابة معلّقة بعد طلب الإلغاء: يُغلق المقبس فتنتهي write() بخطأ ويتحرر الجسر لأمرٍ تالٍ، وتُغلق الشاشة */
    private fun forceStop() {
        if (state != State.CANCELLING || !cancelStalled) return
        printer?.abort()
        finish()
    }

    // ═══ ٥. الإعدادات ═══

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (e: ActivityNotFoundException) {
            toast("افتح إعدادات الجوال ← التطبيقات ← FieldSales ← الأذونات")
        }
    }

    private fun openBluetoothSettings() {
        try {
            startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            toast("افتح إعدادات الجوال ← البلوتوث")
        }
    }

    // ═══ ٦. الواجهة (مبنية بالكود كشاشة التحصيل بالبطاقة) ═══

    private fun buildUi() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        column.addView(label(22f, INK, bold = true).apply { text = "الطباعة" }, params())

        labelView = label(17f, INK, bold = true).apply { visibility = View.GONE }
        column.addView(labelView, params(top = dp(16)))
        printerView = label(15f, MUTED).apply { visibility = View.GONE }
        column.addView(printerView, params(top = dp(6)))

        spinner = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(CORAL)
            visibility = View.GONE
        }
        column.addView(spinner, params(width = ViewGroup.LayoutParams.WRAP_CONTENT, top = dp(24)))
        bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = false
            max = 100
            progressTintList = ColorStateList.valueOf(CORAL)
            visibility = View.GONE
        }
        column.addView(bar, params(top = dp(24)))

        statusView = label(16f, INK)
        column.addView(statusView, params(top = dp(16)))

        pickerBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        column.addView(pickerBox, params(top = dp(12)))

        primaryButton = MaterialButton(this).apply {
            minHeight = dp(56)
            textSize = 17f
            cornerRadius = dp(14)
            visibility = View.GONE
        }
        column.addView(primaryButton, params(top = dp(28)))
        secondaryButton = outlinedButton()
        column.addView(secondaryButton, params(top = dp(10)))
        tertiaryButton = outlinedButton()
        column.addView(tertiaryButton, params(top = dp(10)))

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

    /**
     * busy ⇒ دوّارة؛ percent ⇒ شريط محدد؛ doc ⇒ اسم المستند (إن وُجد) والطابعة (إن عُرفت). قائمة الطابعات تُفرَّغ مع كل رسم
     */
    private fun render(
        status: String,
        busy: Boolean = false,
        percent: Int? = null,
        doc: Boolean = false,
        primary: Action? = null,
        secondary: Action? = null,
        tertiary: Action? = null,
    ) {
        statusView.text = status
        val docLabel = job?.label.orEmpty()
        labelView.text = docLabel
        labelView.visibility = if (doc && docLabel.isNotEmpty()) View.VISIBLE else View.GONE
        val name = printerName
        printerView.text = if (name != null) "الطابعة: $name" else ""
        printerView.visibility = if (doc && name != null) View.VISIBLE else View.GONE
        spinner.visibility = if (busy && percent == null) View.VISIBLE else View.GONE
        bar.visibility = if (percent != null) View.VISIBLE else View.GONE
        if (percent != null) bar.progress = percent
        pickerBox.removeAllViews()
        pickerBox.visibility = View.GONE
        bind(primaryButton, primary)
        bind(secondaryButton, secondary)
        bind(tertiaryButton, tertiary)
    }

    private fun bind(button: MaterialButton, action: Action?) {
        if (action == null) {
            button.visibility = View.GONE
            button.setOnClickListener(null)
            return
        }
        button.visibility = View.VISIBLE
        button.text = action.label
        button.isEnabled = true
        button.setOnClickListener { action.run() }
    }

    private fun outlinedButton() =
        MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            minHeight = dp(52)
            textSize = 16f
            cornerRadius = dp(14)
            visibility = View.GONE
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

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private companion object {
        const val KEY_STARTED = "print.started"
        const val KEY_PERMISSION_ASKED = "print.permissionAsked"

        const val CONNECT_TIMEOUT_MS = 15_000L
        const val AUTO_FINISH_MS = 1_000L
        const val CANCEL_STALL_MS = 10_000L // أطول أمرٍ واحد (صورة نقطية كاملة) يبلغ نهايته عادةً في ثوانٍ
        const val BT_RECHECK_MS = 1_500L

        // أمرٌ واحد على الطابعة في العملية كلها، ولو أُنشئت الشاشة مرتين
        val busy = AtomicBoolean(false)

        const val PERMISSION_DISCLOSURE =
            "للطباعة على طابعة البلوتوث المقترنة بهذا الجوال يحتاج التطبيق إذن «الأجهزة القريبة». " +
                "لا يبحث التطبيق عن أجهزة جديدة ولا يستعمل موقعك. اضغط «متابعة» ثم اسمح بالإذن."

        // هوية فيلد سيلز: مرجاني وحبر
        val CORAL = Color.rgb(0xE1, 0x5A, 0x30)
        val INK = Color.rgb(0x1F, 0x1B, 0x18)
        val MUTED = Color.rgb(0x6F, 0x68, 0x62)
        val NAV_SCRIM_DARK = Color.argb(0x80, 0x1B, 0x1B, 0x1B)
    }
}
