package net.fieldsa.twa.track

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * حارس التتبّع الخلفي (طلب المالك، ٤ نوفمبر ٢٠٢٦): البيان (الأذونات والخدمة والنشاط وإزالتها من بناء الطباعة وحده)،
 * وSTART_NOT_STICKY، وعلامة fstrack في LauncherActivity دون مسّ جسر الطباعة والتحصيل، وربط الموافقة بهوية الرمز، وأن الإصدار لم
 * يتغيّر (التتبّع يُضاف إلى التحديث التالي مع ميزات الجلسات الأخرى — لا رفع للإصدار من هنا).
 */
class TrackGuardTest {

    private val manifest by lazy { file("src/main/AndroidManifest.xml") }

    /** عنصرٌ من البيان باسمه (activity أو service) بنصّه كاملاً */
    private fun element(xml: String, tag: String, name: String): String {
        val re = Regex("<$tag\\b[^>]*android:name=\"${Regex.escape(name)}\"[^>]*?(/>|>[\\s\\S]*?</$tag>)")
        return re.find(xml)?.value ?: error("<$tag $name> غائب")
    }

    @Test
    fun manifestDeclaresTheLocationServiceAndPermissions() {
        assertTrue(manifest.contains("<uses-permission android:name=\"android.permission.FOREGROUND_SERVICE\"/>"))
        assertTrue(manifest.contains("<uses-permission android:name=\"android.permission.FOREGROUND_SERVICE_LOCATION\"/>"))
        val service = element(manifest, "service", "net.fieldsa.twa.track.TrackService")
        assertTrue("الخدمة مُصدَّرة", service.contains("android:exported=\"false\""))
        assertTrue("نوع الخدمة ليس الموقع", service.contains("android:foregroundServiceType=\"location\""))
    }

    @Test
    fun manifestDeclaresTheOpaqueTrackActivity() {
        val activity = element(manifest, "activity", "net.fieldsa.twa.track.TrackActivity")
        assertTrue(activity.contains("android:exported=\"true\""))
        assertTrue(activity.contains("android:taskAffinity=\"net.fieldsa.twa.track\""))
        assertTrue(activity.contains("android:excludeFromRecents=\"true\""))
        assertTrue(activity.contains("android:persistableMode=\"persistNever\""))
        for (s in listOf("android.intent.action.VIEW", "android.intent.category.DEFAULT", "android.intent.category.BROWSABLE")) {
            assertTrue("$s غائب عن مرشّح TrackActivity", activity.contains(s))
        }
        assertTrue(activity.contains("<data android:scheme=\"${TrackContract.SCHEME}\" android:host=\"${TrackContract.HOST_START}\" />"))
        assertTrue(activity.contains("<data android:scheme=\"${TrackContract.SCHEME}\" android:host=\"${TrackContract.HOST_STOP}\" />"))
        // بلا تاريخ لا يصل جواب سؤال الإذن
        assertFalse("noHistory يُضيّع جواب إذن الموقع", activity.contains("noHistory"))
        // غير شفافة: الصفحة تعرف التسليم بتوقّف المتصفح خلفها (launchIntent في appBridge.ts) — شفافةٌ تُبقيها «ظاهرة»
        assertTrue(activity.contains("android:theme=\"@style/Theme.FieldSales.Track\""))
        val styles = file("src/main/res/values/styles.xml")
        val style = Regex("<style name=\"Theme\\.FieldSales\\.Track\"[^>]*>[\\s\\S]*?</style>").find(styles)?.value
            ?: error("Theme.FieldSales.Track غائبة")
        assertTrue(style.contains("parent=\"Theme.MaterialComponents.Light.NoActionBar\""))
        assertFalse("السمة شفافة", style.contains("Translucent") || style.contains("windowIsTranslucent"))
    }

    @Test
    fun printOnlyBuildRemovesTracking() {
        val printOnly = file("src/printonly/AndroidManifest.xml")
        for (line in listOf(
            "<uses-permission android:name=\"android.permission.FOREGROUND_SERVICE\" tools:node=\"remove\"/>",
            "<uses-permission android:name=\"android.permission.FOREGROUND_SERVICE_LOCATION\" tools:node=\"remove\"/>",
            "<activity android:name=\"net.fieldsa.twa.track.TrackActivity\" tools:node=\"remove\"/>",
            "<service android:name=\"net.fieldsa.twa.track.TrackService\" tools:node=\"remove\"/>",
            "<uses-permission android:name=\"android.permission.ACCESS_FINE_LOCATION\" tools:node=\"remove\"/>",
        )) {
            assertTrue("بناء الطباعة لا يزيل: $line", printOnly.contains(line))
        }
    }

    @Test
    fun serviceIsNotStickyAndTypedLocation() {
        val src = file("src/main/java/net/fieldsa/twa/track/TrackService.kt")
        // أندرويد 14+ يمنع إعادة تشغيل خدمة موقعٍ مقدّمة من الخلفية
        assertTrue(src.contains("return START_NOT_STICKY"))
        assertFalse(Regex("\\bSTART_STICKY\\b|START_REDELIVER_INTENT").containsMatchIn(src))
        assertTrue(src.contains("ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION"))
        assertTrue(src.contains("ServiceCompat.startForeground("))
        assertTrue("الرمز يُرسل إلى عنوانٍ لا يتبع التحويل", src.contains("instanceFollowRedirects = false"))
        assertTrue(src.contains("TrackContract.DEVICE_NOW_HEADER"))
        // عنوان التطوير البديل في بناء التطوير وحده
        assertTrue(src.contains("if (BuildConfig.DEBUG)") && src.contains("TrackStore.debugUrl("))
    }

    @Test
    fun consentIsBoundToTheTokenIdentity() {
        // موقعٌ غريب برمز شركةٍ أخرى لا يمرّ بموافقةٍ أُعطيت لشركة المندوب (مراجعة ٤ نوفمبر)
        val activity = file("src/main/java/net/fieldsa/twa/track/TrackActivity.kt")
        assertTrue(activity.contains("if (TrackStore.consentedTo(this, identity)) afterConsent() else showDisclosure(identity)"))
        assertTrue(activity.contains("TrackStore.saveConsent(this, identity)"))
        assertFalse("موافقةٌ عامة بلا هوية", activity.contains("disclosureAccepted("))
        val store = file("src/main/java/net/fieldsa/twa/track/TrackStore.kt")
        assertTrue(store.contains("p.getString(KEY_CONSENT_IDENTITY, null) == identity.key()"))
        // نقاط مندوبٍ لا تُرفع برمز غيره
        val service = file("src/main/java/net/fieldsa/twa/track/TrackService.kt")
        assertTrue(service.contains("if (TrackStore.queueOwner(app) != identity.key())"))
    }

    @Test
    fun launcherAddsTrackCapabilityWithoutTouchingTheOtherBridges() {
        val src = file("src/main/java/net/fieldsa/twa/LauncherActivity.java")
        assertTrue(src.contains("return appendTrackCapability(appendPrintBridge(stripStaleCardPay(uri)));"))
        val helper = src.substringAfter("private Uri appendTrackCapability(Uri uri) {").substringBefore("\n    }\n")
        assertTrue("على https لمضيفنا وحدها", helper.contains("\"https\".equals(uri.getScheme())") && helper.contains("R.string.hostName"))
        assertTrue("بشرط إعلان الموقع الدقيق", helper.contains("declaresPermission(Manifest.permission.ACCESS_FINE_LOCATION)"))
        assertTrue(helper.contains("TrackContract.LAUNCH_PARAM") && helper.contains("TrackContract.LAUNCH_VALUE"))
    }

    @Test
    fun versionIsUnchanged() {
        // يُرفع الإصدار مرةً واحدة عند تجميع ميزات التحديث التالي — لا من هذا الفرع
        val gradle = file("build.gradle")
        assertEquals("9", Regex("versionCode\\s+(\\d+)").find(gradle)?.groupValues?.get(1))
        assertEquals("1.2.3", Regex("versionName\\s+\"([^\"]+)\"").find(gradle)?.groupValues?.get(1))
    }

    /** العقد نفسه في صفحة المندوب — إن وُجد مستودع الويب بجانب المشروع (nativeTracking.test.ts يحرسه من الجهة الأخرى) */
    @Test
    fun webContractMatches() {
        val web = listOf(File("../../web-admin/src/rep/nativeTracking.ts"), File("../web-admin/src/rep/nativeTracking.ts"))
            .firstOrNull { it.isFile }
        assumeTrue("web-admin غير موجود بجانب android-rep", web != null)
        val ts = web!!.readText(Charsets.UTF_8)
        fun tsConst(name: String): String? = Regex("export const $name = '([^']*)';").find(ts)?.groupValues?.get(1)
        assertEquals(TrackContract.SCHEME, tsConst("TRACK_SCHEME"))
        assertEquals(TrackContract.HOST_START, tsConst("TRACK_HOST_START"))
        assertEquals(TrackContract.HOST_STOP, tsConst("TRACK_HOST_STOP"))
        assertEquals(TrackContract.PARAM_TOKEN, tsConst("TRACK_PARAM_TOKEN"))
        assertEquals(TrackContract.PARAM_DEBUG_URL, tsConst("TRACK_PARAM_DEBUG_URL"))
        assertEquals(TrackContract.LAUNCH_PARAM, tsConst("TRACK_LAUNCH_PARAM"))
        assertEquals(TrackContract.LAUNCH_VALUE, tsConst("TRACK_LAUNCH_VALUE"))
        assertEquals(TrackContract.PING_URL, tsConst("TRACK_PING_URL"))
        assertTrue(ts.contains("export const TRACK_TOKEN_MAX_CHARS = ${TrackContract.TOKEN_MAX_CHARS};"))
    }

    private fun file(rel: String): String =
        (listOf(File(rel), File("app/$rel")).firstOrNull { it.isFile } ?: error("لم يُعثر على $rel من ${File(".").absolutePath}"))
            .readText(Charsets.UTF_8)
            .replace("\r\n", "\n")
}
