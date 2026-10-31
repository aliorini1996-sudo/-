package net.fieldsa.twa.cardpay

import android.os.Build
import net.fieldsa.twa.BuildConfig
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * تفاصيل العملية كما يعيدها POST /card-payments/launch (LaunchPayload في backend/src/services/cardPayment.ts).
 * الخادم هو مصدر المبلغ والمرجع ونقطة البيع — الرابط لا يحمل إلا رمز التسليم.
 */
internal data class LaunchPayload(
    val intentId: String, // = CardPayment.id = intentUUID لدى NearPay؛ به يتحقق الخادم من العملية
    val amountHalalas: Long, // ما يُمرَّر إلى purchase() — الخادم يطابقه بالهللة
    val reference: String, // رقم الفاتورة ← customerReferenceNumber
    val tid: String,
    val production: Boolean,
    val jwt: String?, // سرّ عمره ٣٠٠ ثانية: يُستعمل مرة لدخول نقطة البيع ولا يُسجَّل ولا يُحفظ. الخادم لا يستبدل الرمز بلا JWT
    val gcpProjectNumber: Long?,
    val customerName: String,
    val invoiceNumber: String,
    val companyName: String,
    // يراه المندوب فوق المبلغ: رمزٌ أصدره حسابٌ آخر (شركةٌ أخرى على المنصة) يُظهر اسماً غير اسمه قبل أي خصم.
    // اختياري: خادمٌ أقدم لا يرسله فيُترك فارغاً
    val repName: String,
) {
    // لا JWT في أي نصٍّ قد يُطبع أو يُرسل في تقرير عطل
    override fun toString(): String = "LaunchPayload(intentId=$intentId)"
}

internal sealed class LaunchResult {
    data class Ok(val payload: LaunchPayload) : LaunchResult()

    /** retryable: الرمز لم يُستهلك على الأرجح (لم يصل الطلب، أو 429، أو 5xx — الخادم يوقّع قبل أن يستهلك الرمز) */
    data class Failed(val message: String, val retryable: Boolean) : LaunchResult()
}

/** استبدال رمز التسليم بتفاصيل العملية — طلبٌ واحد بلا إعادة تلقائية: إعادةٌ بعد استهلاكٍ ضاع ردّه تعود 410 */
internal object LaunchApi {
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_BODY_CHARS = 64 * 1024
    // أقصى مبلغ يقبله الخادم مليون ريال (MAX_AMOUNT) = ١٠٠ مليون هللة
    private const val MAX_HALALAS = 100_000_000L
    private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    private const val NET_ERROR = "تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة"
    private const val BAD_REPLY = "ردّ غير متوقع من الخادم — ارجع وتحقق من حالة العملية"

    /** يُستدعى على خيطٍ خلفي */
    fun redeem(token: String): LaunchResult {
        val conn = try {
            URL("${BuildConfig.API_BASE}/card-payments/launch").openConnection() as HttpURLConnection
        } catch (e: IOException) {
            return LaunchResult.Failed(NET_ERROR, true)
        }
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            // الرمز لا يذهب إلا إلى هذا العنوان: لا تتبُّع لتحويلٍ إلى مضيفٍ آخر
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", userAgent())
            val body = JSONObject().put("token", token).toString().toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { r ->
                val buf = CharArray(MAX_BODY_CHARS)
                val sb = StringBuilder()
                while (sb.length < MAX_BODY_CHARS) {
                    val n = r.read(buf, 0, MAX_BODY_CHARS - sb.length)
                    if (n < 0) break
                    sb.append(buf, 0, n)
                }
                sb.toString()
            }
            interpret(code, text)
        } catch (e: IOException) {
            LaunchResult.Failed(NET_ERROR, true)
        } finally {
            conn.disconnect()
        }
    }

    private fun interpret(code: Int, text: String?): LaunchResult {
        val json = try {
            text?.let { JSONObject(it) }
        } catch (e: JSONException) {
            null
        }
        if (code == 200 && json != null && json.optBoolean("success")) {
            val payload = json.optJSONObject("data")?.let { parsePayload(it) }
            return if (payload != null) LaunchResult.Ok(payload) else LaunchResult.Failed(BAD_REPLY, false)
        }
        // رسائل أخطاء التحصيل بالبطاقة عربية جاهزة للعرض (cardPayments.ts: sendError)
        val serverMessage = json?.let { str(it, "message") }
        return when {
            code == 429 -> LaunchResult.Failed(serverMessage ?: "محاولات كثيرة — حاول بعد قليل", true)
            code >= 500 -> LaunchResult.Failed("تعذر على الخادم بدء العملية — أعد المحاولة بعد لحظات", true)
            // 400 = رمز بشكلٍ غير مقبول؛ رسالة zod فيه تقنية لا تفيد المندوب
            code == 400 -> LaunchResult.Failed("رابط الدفع غير صالح — ابدأ التحصيل من جديد من صفحة العميل", false)
            code == 410 || code == 409 -> LaunchResult.Failed(
                serverMessage ?: "رمز الدفع غير صالح أو مستخدم أو منتهٍ — ابدأ التحصيل من جديد", false,
            )
            else -> LaunchResult.Failed(serverMessage ?: "تعذر بدء عملية الدفع (رمز $code)", false)
        }
    }

    /** تفشل مغلقة: حقلٌ لازم غائب أو بشكلٍ غير متوقع ⇒ لا عملية (null) */
    private fun parsePayload(d: JSONObject): LaunchPayload? {
        val intentId = str(d, "intentId") ?: return null
        if (!UUID_RE.matches(intentId)) return null
        val rawHalalas = d.opt("amountHalalas") as? Number ?: return null
        val halalas = rawHalalas.toLong()
        if (rawHalalas.toDouble() != halalas.toDouble() || halalas <= 0 || halalas > MAX_HALALAS) return null
        // المبلغ بالريال للعرض فقط، لكن اختلافه عن الهللات علامة خلل — لا يُدفع مبلغٌ مشكوك فيه
        val sar = (d.opt("amount") as? Number)?.toDouble() ?: return null
        if (Math.round(sar * 100) != halalas) return null
        val production = when (str(d, "environment")) {
            "PRODUCTION" -> true
            "SANDBOX" -> false
            else -> return null
        }
        val gcp = when (val v = d.opt("googleCloudProjectNumber")) {
            is Number -> v.toLong()
            is String -> v.trim().toLongOrNull()
            else -> null
        }?.takeIf { it > 0 }
        return LaunchPayload(
            intentId = intentId,
            amountHalalas = halalas,
            reference = str(d, "reference") ?: return null,
            tid = str(d, "tid") ?: return null,
            production = production,
            jwt = str(d, "jwt"),
            gcpProjectNumber = gcp,
            customerName = str(d, "customerName") ?: "",
            invoiceNumber = str(d, "invoiceNumber") ?: "",
            companyName = str(d, "companyName") ?: "",
            repName = str(d, "repName") ?: "",
        )
    }

    // optString يعيد "null" نصّاً لقيمة JSON null — فيُفحص isNull أولاً
    private fun str(o: JSONObject, key: String): String? =
        if (!o.has(key) || o.isNull(key)) null else o.optString(key).trim().takeIf { it.isNotEmpty() }

    private fun userAgent(): String =
        "FieldSales-Rep/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${BuildConfig.APPLICATION_ID})"
}
