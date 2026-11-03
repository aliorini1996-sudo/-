package net.fieldsa.twa

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * حارس «تفويض الموقع» (بلاغ المالك ٣ نوفمبر ٢٠٢٦: «الموقع متوقف» في 1.2.0 و1.2.1): التطبيق يعلن إذنَي الموقع (وحدة التحصيل)،
 * وChrome حينها يسلّم موقع الصفحة كله إلى التطبيق — فبلا معالج التفويض في DelegationService يُرفض كل navigator.geolocation.
 * يفحص المصدر والبيان والتبعية معاً، فلا يُحذف أحدها وحده.
 */
class LocationDelegationGuardTest {

    @Test
    fun delegationServiceRegistersTheLocationHandler() {
        val src = file("src/main/java/net/fieldsa/twa/DelegationService.java")
        // معالجنا لا معالج المكتبة: ذاك أوقف التتبّع عند أول انقطاع إشارة وأرسل الخطأ باسمٍ لا يسمعه Chrome (1.2.2)
        assertTrue("DelegationService لا يسجّل LocationDelegation",
            src.contains("registerExtraCommandHandler(mLocation);") && src.contains("new LocationDelegation(this)"))
        assertTrue("معالج المكتبة عاد إلى DelegationService", !src.contains("LocationDelegationExtraCommandHandler"))
        // الدقة العالية تُفحص بإذن التطبيق لا بإذن Chrome (المتّصل على خيط Binder)
        assertTrue("onExtraCommand لا يمحو هوية المتّصل", src.contains("Binder.clearCallingIdentity()"))
    }

    @Test
    fun handlerSpeaksChromesCallbackNamesAndNeverStopsOnUnavailable() {
        val src = file("src/main/java/net/fieldsa/twa/LocationDelegation.java")
        // الأسماء كما في Chrome (InstalledWebappGeolocationBridge وTrustedWebActivityClient) حرفياً
        for (name in listOf("\"checkAndroidLocationPermission\"", "\"startLocation\"", "\"stopLocation\"",
                "\"onNewLocationAvailable\"", "\"onNewLocationError\"", "\"locationPermissionResult\"")) {
            assertTrue("الاسم $name غائب عن LocationDelegation", src.contains(name))
        }
        assertTrue("اسم الخطأ القديم onNewErrorAvailable لا يسمعه Chrome", !src.contains("\"onNewErrorAvailable\""))
        // «غير متاح» عابر: لا إيقاف ولا إزالة طلب داخل onLocationAvailability
        val availability = src.substringAfter("public void onLocationAvailability").substringBefore("};")
        assertTrue("onLocationAvailability يوقف التحديثات", !availability.contains("stop") && !availability.contains("remove"))
    }

    @Test
    fun launcherAsksEveryLaunchUntilPreciseIsGranted() {
        // 1.2.2 كتب علامةً دائمة بعد رفضٍ واحد فلا يُسأل المندوب ثانيةً، ونشاط الإذن من الخلفية يُمنع على أندرويد 14+
        val src = file("src/main/java/net/fieldsa/twa/LauncherActivity.java")
        assertTrue("علامة locationAsked الدائمة عادت إلى LauncherActivity", !src.contains("locationAsked"))
        // stopLocation بلا هوية جسر: لا يُنفَّذ والصفحة ظاهرة
        val handler = file("src/main/java/net/fieldsa/twa/LocationDelegation.java")
        assertTrue("الإيقاف لا يفحص الظهور", handler.contains("this::stopIfHidden") && handler.contains("IMPORTANCE_VISIBLE"))
    }

    @Test
    fun dependencyAndPermissionActivityArePresent() {
        assertTrue("تبعية locationdelegation غائبة عن app/build.gradle",
            file("build.gradle").contains("com.google.androidbrowserhelper:locationdelegation:"))
        assertTrue("PermissionRequestActivity لتفويض الموقع غائبٌ عن البيان",
            file("src/main/AndroidManifest.xml").contains("com.google.androidbrowserhelper.locationdelegation.PermissionRequestActivity"))
    }

    private fun file(rel: String): String =
        (listOf(File(rel), File("app/$rel")).firstOrNull { it.isFile } ?: error("لم يُعثر على $rel من ${File(".").absolutePath}"))
            .readText(Charsets.UTF_8)
}
