package net.fieldsa.twa.cardpay

import android.nfc.NfcAdapter
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity

// ═══ تحقّق عند وصول الحزمة: أسطر الاستيراد ═══
// توثيق NearPay لا يذكر حزمة (package) أي صنفٍ على أندرويد: مجموعة Maven هي io.nearpay، وهذا لا يعني أنها حزمة الأصناف.
// عند وصول الرمز افتح terminalsdk-release-0.2.6.aar ← classes.jar، واكتب هنا import لكل اسمٍ مما يلي
// (في Android Studio: ضع المؤشر على الاسم الأحمر ثم Alt+Enter ← Import):
//   TerminalSDK, SdkEnvironment, Country, TerminalSDKInitializationListener, PermissionStatus,
//   JWTLoginData, JWTLoginListener, JWTLoginFailure, Terminal,
//   ReadCardListener, ReadCardFailure, SendTransactionListener, SendTransactionFailure, PurchaseResponse
// لم تُخمَّن الحزمة عمداً: ملفٌ لا يُترجَم حتى تُكتب الأسطر أوضحُ من استيرادٍ مخمَّن.
// هذا الملف وحده يمسّ رموز NearPay؛ كل رمزٍ فيه منقول من أمثلة التوثيق (Kotlin/Java) ومشار إلى موضعه.

/** أحداث وحدة NearPay بلغتنا — تصل دائماً على الخيط الرئيسي، ولا يصل شيء بعد close() */
internal sealed class PayEvent {
    data object Initialized : PayEvent()
    data class InitFailed(val detail: String?) : PayEvent()
    data object LoggedIn : PayEvent()
    data class LoginFailed(val detail: String?) : PayEvent()
    data class Reader(val stage: ReaderStage) : PayEvent()
    data class ReadFailed(val detail: String?) : PayEvent()
    data class ReaderError(val detail: String?) : PayEvent()
    data object Dismissed : PayEvent()

    /** status: «approved» أو «declined» لآخر معاملة على النيّة — تلميحٌ للعرض فقط، والخادم يحسم */
    data class Completed(val status: String?) : PayEvent()
    data class Failed(val detail: String?) : PayEvent()
}

internal enum class ReaderStage { DISPLAYED, WAITING, READING, RETRY, PIN, CARD_READ, FINISHED, CLOSED }

/**
 * جلسة دفعٍ واحدة: تهيئة الوحدة ← دخول نقطة البيع بـJWT ← purchase. نسخة لكل نشاط دفع: الباني يربط الوحدة بنشاطٍ
 * واحد (activity).
 *
 * انحرافٌ معلَن عن التوثيق — تحقّق عند وصول الحزمة: البدء السريع يقول «create a single instance of TerminalSDK»، ونحن نبني
 * نسخةً جديدة لكل نشاط دفع ولا نحررها (لا دالة إغلاق أو تحرير موثّقة؛ close() هنا يُسكت ردودنا فقط). ما يحدث لـbuild() وjwtLogin
 * ثانيين في العملية نفسها غير موثّق، والوحدة تركّب خطافاتٍ على مستوى العملية (سجل التغييرات 0.0.157: سلسلة معالج الاستثناءات
 * غير الملتقطة). التوثيق يُظهر ربطاً بنشاطٍ لكل نداء في موضعٍ آخر (getTerminal(activity, uuid)) دون أن يقول إنه يغني عن
 * إعادة البناء. السؤال لـNearPay في README (البند ٥)، والتجربة إلزامية قبل الإنتاج: ثلاث عمليات متتالية في عمليةٍ واحدة
 * دون إغلاق التطبيق (البند ٨). إن فشلت التهيئة أو الدخول في الثانية فالنسخة تُرفع إلى نطاق التطبيق بما تقوله NearPay.
 */
internal class NearpaySession(
    private val activity: AppCompatActivity,
    private val onEvent: (PayEvent) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private var sdk: TerminalSDK? = null
    private var terminal: Terminal? = null

    @Volatile
    private var closed = false

    /** من onDestroy: أي ردٍّ متأخر من الوحدة بعده يُهمل */
    fun close() {
        closed = true
        main.removeCallbacksAndMessages(null)
    }

    // التوثيق لا يحدد خيط الردود (مثال الإلغاء العكسي بـKotlin ينتقل إلى Dispatchers.Main داخل الردّ — CODE L1750) فننقلها كلها
    private fun emit(e: PayEvent) {
        main.post { if (!closed) onEvent(e) }
    }

    /**
     * SDK L147-171 وCODE L246-271 (Kotlin) وL276-300 (Java): الباني داخل try/catch لأن التهيئة قد ترمي.
     * المهيأ هنا: activity وenvironment وgoogleCloudProjectNumber وcountry وinitializationListener — والاختياري متروك
     * لافتراضه (huaweiSafetyDetectApiKey وnetworkConfiguration وuiDockPosition وإعدادات الشاشة الثانية).
     */
    fun initialize(production: Boolean, gcpProjectNumber: Long) {
        try {
            sdk = TerminalSDK.Builder()
                .activity(activity) // CODE L248
                // CODE L249: SANDBOX أو PRODUCTION أو INTERNAL — البيئة من الخادم (NEARPAY_ENV) لا من التطبيق
                .environment(if (production) SdkEnvironment.PRODUCTION else SdkEnvironment.SANDBOX)
                // CODE L280: Long في Java (12345678L)؛ مثال Kotlin (L250) يمرر عدداً حرفياً فيتحوّل ضمناً
                .googleCloudProjectNumber(gcpProjectNumber)
                .country(Country.SA) // CODE L252: SA, TR, USA, KEN
                .initializationListener(object : TerminalSDKInitializationListener {
                    // SDK L708-718: نجاحٌ مرةً حين تجهز الوحدة؛ والفشل يشمل رفض إذن الموقع.
                    // onNearpayException اختياري (مثالا Kotlin وJava لا ينفّذانه) فلا يُنفَّذ هنا
                    override fun onInitializationSuccess() {
                        emit(PayEvent.Initialized)
                    }

                    override fun onInitializationFailure(error: Throwable) {
                        emit(PayEvent.InitFailed(error.localizedMessage ?: error.toString()))
                    }
                })
                .build()
        } catch (t: Throwable) {
            emit(PayEvent.InitFailed(t.localizedMessage ?: t.toString()))
        }
    }

    /** CODE L411-421 (Kotlin): الأذونات التي تراها الوحدة ناقصة — بعد build() وحده لأنها دالة على النسخة */
    fun missingPermissions(): List<String> {
        val s = sdk ?: return emptyList()
        return try {
            s.checkRequiredPermissions().filter { !it.isGranted }.map { it.permission }
        } catch (t: Throwable) {
            emptyList() // أذونات المنصة طُلبت قبل build()؛ والوحدة ستفشل بنفسها إن نقصها شيء
        }
    }

    /** CODE L423 وL454: isNfcEnabled(activity) — نوع وسيطها غير موثّق، والأمثلة تمرّر النشاط */
    fun nfcEnabled(): Boolean {
        val s = sdk ?: return false
        return try {
            s.isNfcEnabled(activity)
        } catch (t: Throwable) {
            NfcAdapter.getDefaultAdapter(activity)?.isEnabled == true
        }
    }

    /**
     * CODE L733-745 (Kotlin) وL750-763 (Java): jwtLogin(JWTLoginData, JWTLoginListener) ← Terminal.
     * الوسيط بالموضع (كمثال Java) لا بالاسم: يصحّ أياً كان اسم وسيط JWTLoginData.
     * لا يُحفظ terminalUUID ولا يُستعاد بـgetTerminal: كل دفعة تحمل JWT جديداً من الخادم.
     */
    fun login(jwt: String) {
        val s = sdk ?: return emit(PayEvent.LoginFailed(null))
        try {
            s.jwtLogin(JWTLoginData(jwt), object : JWTLoginListener {
                override fun onJWTLoginSuccess(terminal: Terminal) {
                    main.post {
                        if (!closed) {
                            this@NearpaySession.terminal = terminal
                            onEvent(PayEvent.LoggedIn)
                        }
                    }
                }

                // MOD «JWT Login Failure»: رسالة فقط بلا رمز — toString كما في مثال التوثيق (CODE L743)
                override fun onJWTLoginFailure(jwtLoginFailure: JWTLoginFailure) {
                    emit(PayEvent.LoginFailed(jwtLoginFailure.toString()))
                }
            })
        } catch (t: Throwable) {
            emit(PayEvent.LoginFailed(t.localizedMessage ?: t.toString()))
        }
    }

    /**
     * مثال Kotlin في الدليل السعودي (SDK L378-383، CODE L1145-1150) بالوسائط المسمّاة:
     * purchase(amount=, scheme=, intentUUID=, customerReferenceNumber=, readCardListener=, sendTransactionListener=).
     * false ⇒ لم تبدأ عملية (لا نقطة بيع بعد، أو رمت الوحدة فوراً).
     */
    fun purchase(amountHalalas: Long, intentId: String, reference: String): Boolean {
        val t = terminal ?: return false
        return try {
            // بالأسماء لا بالموضع: الدليل الأمريكي للحزمة نفسها 0.2.6 يُظهر وسيطاً بقيمة افتراضية بين customerReferenceNumber
            // وreadCardListener (withTokenization = false، «للتجار المسموح لهم»)، ويذكر taxPercentage وsurchargeAmount مدخلاتٍ
            // للشراء. نداءٌ بالموضع كان يضع readCardListener في خانة Boolean فلا يُترجَم؛ مثال Java ذو الوسائط الست يدل على
            // نسخةٍ لـJava فقط (كـ@JvmOverloads) لا تراها Kotlin. الاختياري كله متروك لافتراضه (لا ترميز، لا ضريبة ولا رسوم:
            // المبلغ هو متبقّي الفاتورة شاملاً ضريبتها). الأسماء تشترط أن تكون الدالة Kotlin، وهي كذلك في أمثلة Kotlin كلها.
            //
            // تحقّق عند وصول الحزمة — نوع amount: التوثيق متناقض. مثال Kotlin يمرّر متغيراً Int (SDK L375 «var amount = 100»،
            // وKotlin لا توسّعه إلى Long)، ومثال Java يمرّر Long (CODE L1246 «Long amount = 100L»، وJava لا تضيّقه إلى int)؛
            // فأحدهما لا يُترجَم على التوقيع الفعلي. سجل التغييرات 0.0.119 لا يحسم: غيّر مبلغ capture وincrement وحدهما من Double
            // إلى Long، لا مبلغ purchase. Long هنا اتباعاً لمثال Java وأمثلة الاسترداد والتفويض (1000L و500L). إن قال المترجم
            // «type mismatch» فمرّر amountHalalas.toInt(): آمنٌ لأن LaunchApi يرفض ما فوق MAX_HALALAS = 100_000_000
            // (مليون ريال، حدّ الخادم) وهو دون Int.MAX_VALUE.
            t.purchase(
                amount = amountHalalas, // بالهللات (CODE L1445/L1562: الوحدة الصغرى؛ 100 = ١٫٠٠ ر.س)
                scheme = null, // null = كل الشبكات (SDK L380)
                intentUUID = intentId, // = معرّف العملية لدى الخادم، به يجدها fetchIntent
                customerReferenceNumber = reference, // = رقم الفاتورة
                readCardListener = readCardListener,
                sendTransactionListener = sendTransactionListener,
            )
            true
        } catch (e: Throwable) {
            false
        }
    }

    // CODE L1150-1210 (Kotlin): الطرائق الاثنتا عشرة كلها كما في المثال — طريقةٌ ناقصة أو زائدة عن الواجهة الفعلية
    // خطأ ترجمة يكشف الفرق فور وصول الحزمة
    private val readCardListener = object : ReadCardListener {
        override fun onReaderDismissed() {
            emit(PayEvent.Dismissed) // المستخدم أغلق القارئ (سجل التغييرات 0.0.128)
        }

        override fun onReadCardSuccess() {
            emit(PayEvent.Reader(ReaderStage.CARD_READ))
        }

        // مشكلة في البطاقة نفسها (أُبعدت سريعاً، لا تُقرأ)؛ نموذج ReadCardFailure غير موثّق فيُعرض نصّه فقط
        override fun onReadCardFailure(readCardFailure: ReadCardFailure) {
            emit(PayEvent.ReadFailed(readCardFailure.toString()))
        }

        override fun onReaderDisplayed() {
            emit(PayEvent.Reader(ReaderStage.DISPLAYED))
        }

        override fun onReaderClosed() {
            emit(PayEvent.Reader(ReaderStage.CLOSED))
        }

        override fun onReaderWaiting() {
            emit(PayEvent.Reader(ReaderStage.WAITING))
        }

        override fun onReaderReading() {
            emit(PayEvent.Reader(ReaderStage.READING))
        }

        override fun onReaderRetry() {
            emit(PayEvent.Reader(ReaderStage.RETRY))
        }

        override fun onPinEntering() {
            emit(PayEvent.Reader(ReaderStage.PIN))
        }

        override fun onReaderFinished() {
            emit(PayEvent.Reader(ReaderStage.FINISHED))
        }

        override fun onReadingStarted() {
            emit(PayEvent.Reader(ReaderStage.READING))
        }

        // خطأ في جهاز القراءة نفسه؛ String? في Kotlin (CODE L1207) وString في Java
        override fun onReaderError(error: String?) {
            emit(PayEvent.ReaderError(error))
        }
    }

    private val sendTransactionListener = object : SendTransactionListener {
        // تحقّق عند وصول الحزمة: كل الأمثلة (L1213 وL1329) تجعل الوسيط PurchaseResponse، وجدول الردود (SDK L784-787)
        // يقول TransactionResponse. يصل للموافَق والمرفوض كليهما (سجل التغييرات 0.0.75)
        override fun onSendTransactionCompleted(purchaseResponse: PurchaseResponse) {
            // purchaseResponse.status: نصّ «approved»/«declined» لآخر معاملة على النيّة (CODE L1218-1222، MOD PurchaseResponse).
            // لا يُقرأ getLastReceipt().getMadaReceipt(): نوع ما يعيده غير موثّق، والجوال ليس مصدر الحقيقة أصلاً
            val status = try {
                purchaseResponse.status
            } catch (t: Throwable) {
                null
            }
            emit(PayEvent.Completed(status))
        }

        // MOD: SendTransactionFailure.TransactionFailure(message) — رسالة بلا رمز رقمي؛ toString كما في المثال (CODE L1237)
        override fun onSendTransactionFailure(failure: SendTransactionFailure) {
            emit(PayEvent.Failed(failure.toString()))
        }
    }
}

/**
 * تلميحٌ عربي لرموز صفحة «رموز الأخطاء» لدى NearPay إن ظهرت في نص الفشل.
 * ظهور الرمز الرقمي داخل الرسالة استنتاج — التوثيق لا يربط الرموز بكائنات الفشل.
 */
internal fun nearpayHint(detail: String?): String? {
    val d = detail ?: return null
    fun has(vararg codes: String) = codes.any { Regex("\\b$it\\b").containsMatchIn(d) }
    return when {
        has("4035", "5010") -> "نقطة البيع مربوطة بجوالٍ آخر — تُفصل من لوحة NearPay (الطرفية ← الوصول ← فصل الجهاز)"
        // الرمز استُهلك: الخادم يحجز الفاتورة عشر دقائق من فتح هذه الشاشة (IN_PROGRESS_MS) — «ابدأ من جديد» الآن يُرفض بـ409
        has("4031") -> "انتهت صلاحية دخول نقطة البيع — ارجع إلى التطبيق، وتُتاح محاولة جديدة على الفاتورة بعد دقائق"
        has("4036", "4037", "4038") -> "بيانات دخول نقطة البيع على الخادم غير صحيحة — أبلغ مدير النظام"
        has("4012") -> "التطبيق غير مسجّل لدى NearPay بعد"
        has("4029", "4030") -> "هذا الجوال محجوب أو غير مسجّل لدى NearPay"
        has("5002") -> "انقطع الاتصال بالإنترنت"
        has("5012") -> "أُلغيت العملية"
        has("5017") -> "نسخة وحدة الدفع لم تعد مدعومة — حدّث التطبيق"
        else -> null
    }
}
