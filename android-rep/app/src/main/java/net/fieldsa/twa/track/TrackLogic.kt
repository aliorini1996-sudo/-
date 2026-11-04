package net.fieldsa.twa.track

import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.time.Instant
import java.time.ZoneId
import java.util.Base64
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** قراءة موقعٍ واحدة كما تُحفظ وتُرسل — الوقت بالملّي‌ثانية منذ ١٩٧٠ (ساعة الجهاز) */
data class TrackFix(
    val lat: Double,
    val lng: Double,
    val accuracy: Double,
    val speed: Double?,
    val timeMs: Long,
)

/** هوية رمز التتبّع كما يقولها الرمز نفسه (sub = المندوب، tid = الشركة) — للموافقة وحدها، والخادم يتحقق من التوقيع */
data class TrackIdentity(val repId: String, val tenantId: String) {
    fun key(): String = "$tenantId|$repId"
}

/**
 * منطق التتبّع الخالص (بلا أندرويد) — يختبره TrackLogicTest، والآيفون يطبّق المرشّح نفسه حرفياً (TrackService.swift).
 */
object TrackLogic {
    private const val EARTH_RADIUS_M = 6_371_000.0
    private val TOKEN_RE = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
    /** أقصى طول لجزء الحمولة يُفكّ (الرمز كله ≤ ٤٠٩٦) */
    private const val MAX_PAYLOAD_CHARS = TrackContract.TOKEN_MAX_CHARS

    /**
     * مرشّح الحفظ: دقّةٌ مقبولة، ثم أول نقطة، أو نبضٌ بعد ٣٠ ثانية، أو حركةٌ ≥ ٢٠ م بعد ١٥ ثانية على الأقل من آخر محفوظة.
     *   keep(fix) := fix.accuracy <= 500 && (lastKept == null
     *      || fix.time - lastKept.time >= 30000
     *      || (fix.time - lastKept.time >= 15000 && distanceMeters(fix, lastKept) >= 20))
     */
    fun shouldKeep(fix: TrackFix, lastKept: TrackFix?): Boolean {
        if (!fix.accuracy.isFinite() || fix.accuracy < 0 || fix.accuracy > TrackContract.MAX_ACCURACY_M) return false
        if (!validCoordinates(fix.lat, fix.lng)) return false
        if (lastKept == null) return true
        val dt = fix.timeMs - lastKept.timeMs
        if (dt >= TrackContract.STATIONARY_HEARTBEAT_MS) return true
        return dt >= TrackContract.MOVING_KEEP_MS && distanceMeters(fix, lastKept) >= TrackContract.MOVE_THRESHOLD_M
    }

    fun validCoordinates(lat: Double, lng: Double): Boolean =
        lat.isFinite() && lng.isFinite() && lat >= -90.0 && lat <= 90.0 && lng >= -180.0 && lng <= 180.0

    fun distanceMeters(a: TrackFix, b: TrackFix): Double = distanceMeters(a.lat, a.lng, b.lat, b.lng)

    /** المسافة على سطح الأرض (هافرساين) */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dp = Math.toRadians(lat2 - lat1)
        val dl = Math.toRadians(lng2 - lng1)
        val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /** شكل JWT: ثلاثة أجزاء base64url وطولٌ محدود — الرابط يطلقه أي موقع، فهذا أول حارس */
    fun looksLikeToken(token: String?): Boolean =
        token != null && token.length <= TrackContract.TOKEN_MAX_CHARS && TOKEN_RE.matches(token)

    /** حمولة الرمز (الجزء الأوسط) كائن JSON — بلا تحقق من التوقيع: الجوال لا يملك المفتاح، والخادم يتحقق في كل رفع */
    private fun payloadOf(token: String?): JSONObject? {
        if (!looksLikeToken(token)) return null
        val part = token!!.split('.')[1]
        if (part.length > MAX_PAYLOAD_CHARS) return null
        return try {
            val text = String(Base64.getUrlDecoder().decode(part.trimEnd('=')), Charsets.UTF_8)
            JSONObject(text)
        } catch (e: IllegalArgumentException) {
            null
        } catch (e: JSONException) {
            null
        }
    }

    /** exp بالثواني من حمولة الرمز، أو null إن غاب أو لم يكن عدداً صحيحاً موجباً */
    fun jwtExpSeconds(token: String?): Long? {
        val p = payloadOf(token) ?: return null
        val v = p.opt("exp") as? Number ?: return null
        val d = v.toDouble()
        if (!d.isFinite() || d <= 0 || d != Math.floor(d)) return null
        return v.toLong()
    }

    /** الرمز منتهٍ (أو بلا exp مقروء) عند nowMs */
    fun tokenExpired(token: String?, nowMs: Long): Boolean {
        val exp = jwtExpSeconds(token) ?: return true
        return nowMs >= exp * 1000L
    }

    /** هوية الرمز (sub وtid نصّين غير فارغين، وtyp = fs-track) — وإلا null */
    fun tokenIdentity(token: String?): TrackIdentity? {
        val p = payloadOf(token) ?: return null
        if (p.opt("typ") != "fs-track") return null
        val sub = p.opt("sub") as? String ?: return null
        val tid = p.opt("tid") as? String ?: return null
        if (sub.isBlank() || tid.isBlank() || sub.length > 128 || tid.length > 128) return null
        return TrackIdentity(sub, tid)
    }

    /** التراجع التالي: ٠ ← ٣٠ث ← ٦٠ ← ١٢٠ ← ٣٠٠ ثم يبقى ٣٠٠ */
    fun nextBackoffMs(prevMs: Long): Long = when {
        prevMs < TrackContract.BACKOFF_FIRST_MS -> TrackContract.BACKOFF_FIRST_MS
        prevMs < TrackContract.BACKOFF_FIRST_MS * 2 -> TrackContract.BACKOFF_FIRST_MS * 2
        prevMs < TrackContract.BACKOFF_FIRST_MS * 4 -> TrackContract.BACKOFF_FIRST_MS * 4
        else -> TrackContract.BACKOFF_MAX_MS
    }

    /** يوم الجهاز المحلي «yyyy-MM-dd» — كيوم الصفحة (web-admin/src/rep/deviceDay.ts) */
    fun dayKey(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()

    fun sameLocalDay(aMs: Long, bMs: Long, zone: ZoneId = ZoneId.systemDefault()): Boolean =
        dayKey(aMs, zone) == dayKey(bMs, zone)

    /** لحظةٌ بصيغة ISO-8601 UTC (2026-11-04T09:15:02.120Z) */
    fun isoUtc(ms: Long): String = Instant.ofEpochMilli(ms).toString()

    /** النقطة كما يقرؤها pingSchema في الخادم: { lat, lng, accuracy, speed|null, capturedAt } */
    fun pointJson(fix: TrackFix): JSONObject = JSONObject()
        .put("lat", fix.lat)
        .put("lng", fix.lng)
        .put("accuracy", fix.accuracy)
        .put("speed", if (fix.speed != null && fix.speed.isFinite() && fix.speed >= 0) fix.speed else JSONObject.NULL)
        .put("capturedAt", isoUtc(fix.timeMs))

    /** ردّ الرفع: data.stop === true ⇒ التتبّع أُطفئ للشركة أو استُثني المندوب */
    fun replySaysStop(body: String?): Boolean {
        if (body.isNullOrEmpty()) return false
        return try {
            JSONObject(body).optJSONObject("data")?.opt("stop") == true
        } catch (e: JSONException) {
            false
        }
    }

    /** عنوان رفعٍ بديل لبناء التطوير وحده: https، أو http إلى المحاكي/الجهاز نفسه */
    fun acceptableDebugUrl(raw: String): Boolean {
        if (raw.length > 512) return false
        return try {
            val u = URI(raw)
            val host = u.host ?: return false
            when (u.scheme) {
                "https" -> true
                "http" -> host == "10.0.2.2" || host == "localhost" || host == "127.0.0.1"
                else -> false
            }
        } catch (e: URISyntaxException) {
            false
        }
    }

    /** ردّ الخادم برفض الرمز نفسه: { success:false, code:"TRACK_TOKEN_INVALID" } */
    fun replySaysTokenInvalid(body: String?): Boolean {
        if (body.isNullOrEmpty()) return false
        return try {
            JSONObject(body).optString("code") == TrackContract.TOKEN_INVALID_CODE
        } catch (e: JSONException) {
            false
        }
    }

    /** ما يفعله الرافع بردّ الخادم */
    enum class Reply { OK, STOP_AUTH, RETRY, DROP_BATCH }

    /**
     * 401/403 يوقف التسجيل فقط إن قال خادمنا إن الرمز مرفوض (TRACK_TOKEN_INVALID). 401/403 بلا هذا الرمز من وسيطٍ
     * أمام الخادم (جدار حماية، بوابة شبكة فندق) عابرٌ — يُعاد بالتراجع ولا يُنهي يوم المندوب.
     */
    fun classify(code: Int, body: String? = null): Reply = when {
        code in 200..299 -> Reply.OK
        code == 401 || code == 403 -> if (replySaysTokenInvalid(body)) Reply.STOP_AUTH else Reply.RETRY
        code == 429 || code >= 500 -> Reply.RETRY
        // 400/413/422…: الدفعة نفسها مرفوضة، وإعادتها تعلق الطابور خلفها إلى الأبد
        code in 400..499 -> Reply.DROP_BATCH
        else -> Reply.RETRY
    }
}
