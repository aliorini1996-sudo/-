package net.fieldsa.twa.track

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Base64

/** منطق التتبّع الخالص: مرشّح الحفظ والمسافة والرمز والتراجع واليوم وشكل النقطة — كما في العقد حرفياً */
class TrackLogicTest {

    private val t0 = 1_793_000_000_000L

    private fun fix(lat: Double, lng: Double, atMs: Long, accuracy: Double = 10.0, speed: Double? = null) =
        TrackFix(lat, lng, accuracy, speed, atMs)

    /** إزاحة شمالاً بالأمتار (درجة العرض ≈ ١١١١٩٥ م بنصف القطر ٦٣٧١ كم) */
    private fun north(base: TrackFix, meters: Double, atMs: Long) =
        fix(base.lat + meters / 111_194.93, base.lng, atMs)

    private fun token(payload: String, header: String = """{"alg":"HS256","typ":"JWT"}"""): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString(header.toByteArray()) + "." + enc.encodeToString(payload.toByteArray()) + ".c2lnbmF0dXJl"
    }

    // ── المرشّح ──

    @Test
    fun firstFixIsKeptWhenAccurateEnough() {
        assertTrue(TrackLogic.shouldKeep(fix(24.7, 46.7, t0), null))
        assertTrue(TrackLogic.shouldKeep(fix(24.7, 46.7, t0, accuracy = 500.0), null))
        assertFalse("أسوأ من ٥٠٠ م تُسقط", TrackLogic.shouldKeep(fix(24.7, 46.7, t0, accuracy = 500.1), null))
        assertFalse("بلا دقّة معروفة تُسقط", TrackLogic.shouldKeep(fix(24.7, 46.7, t0, accuracy = Double.NaN), null))
        assertFalse(TrackLogic.shouldKeep(fix(91.0, 46.7, t0), null))
        assertFalse(TrackLogic.shouldKeep(fix(24.7, Double.NaN, t0), null))
    }

    @Test
    fun stationaryKeepsAHeartbeatEveryThirtySeconds() {
        val last = fix(24.7, 46.7, t0)
        assertFalse(TrackLogic.shouldKeep(fix(24.7, 46.7, t0 + 29_999), last))
        assertTrue(TrackLogic.shouldKeep(fix(24.7, 46.7, t0 + 30_000), last))
        // النبض لا يتجاوز حدّ الدقّة
        assertFalse(TrackLogic.shouldKeep(fix(24.7, 46.7, t0 + 600_000, accuracy = 900.0), last))
    }

    @Test
    fun movingKeepsAPointEveryFifteenSecondsAfterTwentyMeters() {
        val last = fix(24.7, 46.7, t0)
        assertTrue(TrackLogic.shouldKeep(north(last, 25.0, t0 + 15_000), last))
        assertFalse("قبل ١٥ ثانية لا تُحفظ ولو ابتعد", TrackLogic.shouldKeep(north(last, 300.0, t0 + 14_999), last))
        assertFalse("أقل من ٢٠ م (قبل النبض)", TrackLogic.shouldKeep(north(last, 19.0, t0 + 29_000), last))
        assertTrue(TrackLogic.shouldKeep(north(last, 20.5, t0 + 15_000), last))
    }

    @Test
    fun haversineDistance() {
        assertEquals(111_194.93, TrackLogic.distanceMeters(0.0, 0.0, 1.0, 0.0), 0.5)
        assertEquals(0.0, TrackLogic.distanceMeters(24.7, 46.7, 24.7, 46.7), 1e-9)
        // الرياض ← جدة نحو ٨٤٦ كم
        val d = TrackLogic.distanceMeters(24.7136, 46.6753, 21.4858, 39.1925)
        assertTrue("الرياض-جدة = $d", d in 840_000.0..855_000.0)
        val a = fix(24.7, 46.7, t0)
        assertEquals(25.0, TrackLogic.distanceMeters(a, north(a, 25.0, t0)), 0.01)
    }

    // ── الرمز ──

    @Test
    fun tokenShape() {
        assertTrue(TrackLogic.looksLikeToken("aa.bb.cc"))
        assertTrue(TrackLogic.looksLikeToken("a-_A9.b.c"))
        assertFalse(TrackLogic.looksLikeToken(null))
        assertFalse(TrackLogic.looksLikeToken(""))
        assertFalse(TrackLogic.looksLikeToken("aa.bb"))
        assertFalse(TrackLogic.looksLikeToken("aa.bb.cc.dd"))
        assertFalse(TrackLogic.looksLikeToken("aa.b+b.cc"))
        assertFalse(TrackLogic.looksLikeToken("aa.bb.cc\n"))
        val big = "a".repeat(TrackContract.TOKEN_MAX_CHARS - 4) + ".b.c"
        assertTrue(TrackLogic.looksLikeToken(big))
        assertFalse("أطول من ٤٠٩٦", TrackLogic.looksLikeToken("a$big"))
    }

    @Test
    fun jwtExpAndIdentity() {
        val good = token("""{"sub":"rep-1","tid":"ten-1","typ":"fs-track","iat":1793000000,"exp":1793072000}""")
        assertEquals(1_793_072_000L, TrackLogic.jwtExpSeconds(good))
        assertEquals(TrackIdentity("rep-1", "ten-1"), TrackLogic.tokenIdentity(good))
        assertEquals("ten-1|rep-1", TrackLogic.tokenIdentity(good)!!.key())
        assertFalse(TrackLogic.tokenExpired(good, 1_793_071_999_000L))
        assertTrue(TrackLogic.tokenExpired(good, 1_793_072_000_000L))

        // رمز الجلسة (بلا typ) أو نوعٌ آخر: لا هوية تتبّع
        assertNull(TrackLogic.tokenIdentity(token("""{"id":"rep-1","tenantId":"ten-1","exp":1793072000}""")))
        assertNull(TrackLogic.tokenIdentity(token("""{"sub":"rep-1","tid":"ten-1","typ":"session","exp":1793072000}""")))
        assertNull(TrackLogic.tokenIdentity(token("""{"sub":"","tid":"ten-1","typ":"fs-track"}""")))
        assertNull(TrackLogic.tokenIdentity(token("""{"sub":5,"tid":"ten-1","typ":"fs-track"}""")))

        // exp غائب أو نصّ أو كسر ⇒ لا exp ⇒ منتهٍ
        val noExp = token("""{"sub":"r","tid":"t","typ":"fs-track"}""")
        assertNull(TrackLogic.jwtExpSeconds(noExp))
        assertTrue(TrackLogic.tokenExpired(noExp, 0))
        assertNull(TrackLogic.jwtExpSeconds(token("""{"exp":"1793072000"}""")))
        assertNull(TrackLogic.jwtExpSeconds(token("""{"exp":1793072000.5}""")))
        assertNull(TrackLogic.jwtExpSeconds(token("""{"exp":-1}""")))
        // حمولةٌ ليست JSON أو ليست base64url
        assertNull(TrackLogic.jwtExpSeconds("aa.bm90LWpzb24.cc"))
        assertNull(TrackLogic.jwtExpSeconds("aa.b.cc"))
        assertNull(TrackLogic.jwtExpSeconds(null))
    }

    // ── التراجع واليوم ──

    @Test
    fun backoffSteps() {
        var b = 0L
        val seen = mutableListOf<Long>()
        repeat(6) {
            b = TrackLogic.nextBackoffMs(b)
            seen += b
        }
        assertEquals(listOf(30_000L, 60_000L, 120_000L, 300_000L, 300_000L, 300_000L), seen)
    }

    @Test
    fun localDayFollowsTheDeviceZone() {
        val riyadh = ZoneId.of("Asia/Riyadh")
        val lastSecond = Instant.parse("2026-11-04T20:59:59Z").toEpochMilli() // ٢٣:٥٩:٥٩ بتوقيت الرياض
        assertEquals("2026-11-04", TrackLogic.dayKey(lastSecond, riyadh))
        assertEquals("2026-11-05", TrackLogic.dayKey(lastSecond + 1_000, riyadh))
        assertFalse(TrackLogic.sameLocalDay(lastSecond, lastSecond + 1_000, riyadh))
        assertTrue(TrackLogic.sameLocalDay(lastSecond - 3_600_000, lastSecond, riyadh))
        // اليوم نفسه بتوقيت غرينتش
        assertTrue(TrackLogic.sameLocalDay(lastSecond, lastSecond + 1_000, ZoneId.of("UTC")))
    }

    // ── النقطة والردّ ──

    @Test
    fun pointJsonMatchesTheServerSchema() {
        val at = Instant.parse("2026-11-04T09:15:02.120Z").toEpochMilli()
        val p = TrackLogic.pointJson(TrackFix(24.5, 46.25, 12.5, 3.0, at))
        assertEquals(setOf("lat", "lng", "accuracy", "speed", "capturedAt"), p.keys().asSequence().toSet())
        assertEquals(24.5, p.getDouble("lat"), 0.0)
        assertEquals(46.25, p.getDouble("lng"), 0.0)
        assertEquals(12.5, p.getDouble("accuracy"), 0.0)
        assertEquals(3.0, p.getDouble("speed"), 0.0)
        assertEquals("2026-11-04T09:15:02.120Z", p.getString("capturedAt"))
        val still = TrackLogic.pointJson(TrackFix(24.5, 46.25, 12.5, null, at))
        assertTrue("speed غائب ⇒ null صريح", still.isNull("speed"))
        assertTrue(TrackLogic.pointJson(TrackFix(24.5, 46.25, 12.5, Double.NaN, at)).isNull("speed"))
        assertEquals("2026-11-04T09:15:02Z", TrackLogic.isoUtc(Instant.parse("2026-11-04T09:15:02Z").toEpochMilli()))
    }

    @Test
    fun replyStopAndStatusClasses() {
        assertTrue(TrackLogic.replySaysStop("""{"success":true,"data":{"stored":0,"stop":true}}"""))
        assertFalse(TrackLogic.replySaysStop("""{"success":true,"data":{"stored":3}}"""))
        assertFalse(TrackLogic.replySaysStop("""{"success":true,"data":{"stop":"true"}}"""))
        assertFalse(TrackLogic.replySaysStop("not json"))
        assertFalse(TrackLogic.replySaysStop(null))

        assertEquals(TrackLogic.Reply.OK, TrackLogic.classify(200))
        assertEquals(TrackLogic.Reply.OK, TrackLogic.classify(204))
        val invalid = """{"success":false,"code":"TRACK_TOKEN_INVALID","message":"x"}"""
        assertEquals(TrackLogic.Reply.STOP_AUTH, TrackLogic.classify(401, invalid))
        assertEquals(TrackLogic.Reply.STOP_AUTH, TrackLogic.classify(403, invalid))
        // 401/403 من وسيطٍ أمام الخادم (بلا رمز الرفض) عابرٌ: يُعاد ولا يُنهي اليوم
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(401))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(403, "<html>Forbidden</html>"))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(401, """{"code":"OTHER"}"""))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(429))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(500))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(503))
        assertEquals(TrackLogic.Reply.RETRY, TrackLogic.classify(-1))
        assertEquals(TrackLogic.Reply.DROP_BATCH, TrackLogic.classify(400))
        assertEquals(TrackLogic.Reply.DROP_BATCH, TrackLogic.classify(413))
    }

    /** قيم العقد المشتركة (TRACK_CONTRACT: الويب والآيفون يحملانها حرفياً) */
    @Test
    fun contractValues() {
        assertEquals("fieldsatrack", TrackContract.SCHEME)
        assertEquals("start", TrackContract.HOST_START)
        assertEquals("stop", TrackContract.HOST_STOP)
        assertEquals("t", TrackContract.PARAM_TOKEN)
        assertEquals("u", TrackContract.PARAM_DEBUG_URL)
        assertEquals("fstrack", TrackContract.LAUNCH_PARAM)
        assertEquals("1", TrackContract.LAUNCH_VALUE)
        assertEquals("https://api.fieldsa.net/api/track-device/ping", TrackContract.PING_URL)
        assertEquals("x-fs-device-now", TrackContract.DEVICE_NOW_HEADER)
        // رفع الهدم (الخادم ينسى «التطبيق يرفع» بها، deviceTrack.ts TRACK_FINAL_HEADER وisTrackFinal يقبل '1' حرفياً)
        assertEquals("x-fs-track-final", TrackContract.FINAL_HEADER)
        assertEquals("1", TrackContract.FINAL_VALUE)
        assertEquals(5_000L, TrackContract.SAMPLE_INTERVAL_MS)
        assertEquals(15_000L, TrackContract.MOVING_KEEP_MS)
        assertEquals(20.0, TrackContract.MOVE_THRESHOLD_M, 0.0)
        assertEquals(30_000L, TrackContract.STATIONARY_HEARTBEAT_MS)
        assertEquals("TRACK_TOKEN_INVALID", TrackContract.TOKEN_INVALID_CODE)
        assertEquals(500.0, TrackContract.MAX_ACCURACY_M, 0.0)
        assertEquals(30_000L, TrackContract.UPLOAD_INTERVAL_MS)
        // كل قراءةٍ تفحص موعد الرفع (TrackService.uploadIfDue): فاصل القراءة أقصر منه، فيُدرَك الموعد بتأخّر قراءةٍ واحدة على الأكثر
        assertTrue(TrackContract.SAMPLE_INTERVAL_MS < TrackContract.UPLOAD_INTERVAL_MS)
        assertEquals(200, TrackContract.MAX_BATCH)
        assertEquals(3_000, TrackContract.MAX_QUEUED)
        assertEquals(4_096, TrackContract.TOKEN_MAX_CHARS)
        assertEquals(15_000, TrackContract.HTTP_TIMEOUT_MS)
        assertEquals("fs_track", TrackContract.CHANNEL_ID)
    }

    @Test
    fun debugUrlIsHttpsOrLocalOnly() {
        assertTrue(TrackLogic.acceptableDebugUrl("https://staging.example.test/api/track-device/ping"))
        assertTrue(TrackLogic.acceptableDebugUrl("http://10.0.2.2:4000/api/track-device/ping"))
        assertFalse(TrackLogic.acceptableDebugUrl("http://evil.example/api"))
        assertFalse(TrackLogic.acceptableDebugUrl("file:///sdcard/x"))
        assertFalse(TrackLogic.acceptableDebugUrl("not a url"))
    }

    @Test
    fun jsonIsTheRealLibrary() {
        // org.json في android.jar بذورٌ فارغة: الاختبارات تحتاج المكتبة الحقيقية (testImplementation)
        assertEquals(1, JSONObject("""{"a":1}""").getInt("a"))
    }
}
