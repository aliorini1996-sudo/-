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
        assertTrue("DelegationService لا يسجّل LocationDelegationExtraCommandHandler",
            src.contains("registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());"))
        // الدقة العالية تُفحص بإذن التطبيق لا بإذن Chrome (المتّصل على خيط Binder)
        assertTrue("onExtraCommand لا يمحو هوية المتّصل", src.contains("Binder.clearCallingIdentity()"))
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
