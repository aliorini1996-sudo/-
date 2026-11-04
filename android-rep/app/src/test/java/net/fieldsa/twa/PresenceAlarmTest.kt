package net.fieldsa.twa

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * إنذار «أثبت تواجدك» (PresenceAlarm، طلب المالك ٤ نوفمبر ٢٠٢٦): الدوال الخالصة على JVM (لا استدعاء أندرويد — بلا
 * returnDefaultValues يرمي كلّ استدعاءٍ له)، وحرّاس مصدر في أسلوب LocationDelegationGuardTest: التفويض لـsuper في كل ما عدا
 * الإنذار، وعناصر الإنذار نفسها، وبلا أذونات جديدة.
 * النسخة (versionCode/versionName) لا تُثبَّت هنا عمداً: يرفعها بناء الإصدار وحده.
 */
class PresenceAlarmTest {

    @Test
    fun tagMatchesOnlyThePresenceWebTag() {
        // صيغة Chrome: p[b]#<الأصل>#1<الوسم> (NotificationIdGenerator)، والأصل من GURL بشرطةٍ مائلة في آخره
        for (t in listOf("p#https://fieldsa.net/#1presence", "pb#https://fieldsa.net/#1presence", "presence")) {
            assertTrue("لم يُعرف إشعار التواجد: $t", PresenceAlarm.isPresenceTag(t))
        }
        val others = listOf(
            null, "", "#1presence", "1presence", "p##1presence",
            "p#https://fieldsa.net/#0430",              // بلا وسم: رقم الإشعار الدائم
            "p#https://fieldsa.net/#presence",          // بلا علامة «1»
            "p#https://fieldsa.net/#1presence2",
            "p#https://fieldsa.net/#1xpresence",
            "p#https://fieldsa.net/#1x#1presence",       // وسمٌ آخر ينتهي بـ«#1presence»
            "p#https://fieldsa.net/#1other",
            "p#https://fieldsa.net/#1att-in",            // تنبيهات البصمة (attendanceAlerts) تبقى عادية
            "n#https://fieldsa.net/#1presence",          // ليس إشعاراً دائماً (persistent)
            "Presence",
        )
        for (t in others) assertFalse("عُدّ إشعار تواجد خطأً: $t", PresenceAlarm.isPresenceTag(t))
    }

    @Test
    fun silentRequestIsNotAnAlarm() {
        // القيم من Notification: GROUP_ALERT_ALL=0، GROUP_ALERT_SUMMARY=1، GROUP_ALERT_CHILDREN=2، FLAG_GROUP_SUMMARY=0x200
        assertTrue(PresenceAlarm.isSilentRequest(1, 0))
        assertTrue(PresenceAlarm.isSilentRequest(1, 0x10))
        assertFalse("الملخّص نفسه ليس طلب صمت", PresenceAlarm.isSilentRequest(1, 0x200))
        assertFalse(PresenceAlarm.isSilentRequest(0, 0))
        assertFalse(PresenceAlarm.isSilentRequest(2, 0))
    }

    @Test
    fun channelIdIsVersionedAndRetiresTheOlderOnes() {
        assertEquals(PresenceAlarm.CHANNEL_PREFIX + PresenceAlarm.CHANNEL_VERSION, PresenceAlarm.CHANNEL_ID)
        assertTrue(PresenceAlarm.CHANNEL_ID, Regex("presence_alarm_v[1-9][0-9]*").matches(PresenceAlarm.CHANNEL_ID))
        val retired = (1 until PresenceAlarm.CHANNEL_VERSION).map { PresenceAlarm.CHANNEL_PREFIX + it }.toTypedArray()
        assertArrayEquals(retired, PresenceAlarm.retiredChannelIds())
        assertFalse(PresenceAlarm.retiredChannelIds().contains(PresenceAlarm.CHANNEL_ID))
        // ليست قناة المكتبة («General»/«عام» ⇒ <الاسم>_channel_id) التي تبقى لكل إشعارٍ آخر
        assertFalse(PresenceAlarm.CHANNEL_ID.endsWith("_channel_id"))
    }

    @Test
    fun ringingIsCappedAndVibrationRepeatsCleanly() {
        assertEquals("presence", PresenceAlarm.WEB_TAG)
        assertEquals("سقف الرنين ثلاث دقائق", 180_000L, PresenceAlarm.TIMEOUT_MS)
        val p = PresenceAlarm.VIBRATION
        assertEquals("يبدأ الاهتزاز فوراً", 0L, p[0])
        // سكون/هزّة بالتناوب؛ طولٌ فردي ⇒ آخره سكون يفصل الدورة عن تاليتها (FLAG_INSISTENT يكرّر من أوله)
        assertTrue("النمط ينتهي بسكون", p.size % 2 == 1)
        assertTrue("مدّة صفرية أو سالبة في النمط", p.drop(1).all { it > 0 })
        assertTrue("أقل من ثلاث هزّات", p.size / 2 >= 3)
        assertTrue("دورة الاهتزاز ${p.sum()}ms خارج ٢–٦ ثوانٍ", p.sum() in 2_000L..6_000L)
    }

    @Test
    fun delegationServiceHandsOnlyThePresenceTagToTheAlarm() {
        val src = file("src/main/java/net/fieldsa/twa/DelegationService.java")
        assertTrue("لا تجاوز لـonNotifyNotificationWithChannel", src.contains("public boolean onNotifyNotificationWithChannel("))
        // جسم التجاوز كله بمسافاتٍ حرّة: وجود العبارات وحده يمرّ بشرطٍ معكوس (كل إشعارٍ إنذار) أو بـ|| (التواجد يضيع بلا نشر)
        val routing = Regex("""onNotifyNotificationWithChannel\([^)]*\)\s*\{\s*if\s*\(\s*PresenceAlarm\.isPresenceTag\(platformTag\)\s*&&\s*PresenceAlarm\.notify\(this,\s*platformTag,\s*platformId,\s*notification\)\s*\)\s*\{\s*return\s+true;\s*\}\s*return\s+super\.onNotifyNotificationWithChannel\(platformTag,\s*platformId,\s*notification,\s*channelName\);\s*\}""")
        assertTrue("توجيه إشعار التواجد تغيّر (شرطٌ معكوس أو || أو super مفقود)", routing.containsMatchIn(src))
        // والحارس نفسه يرفض الطفرات المعروفة
        for ((from, to) in listOf(
            "if (PresenceAlarm.isPresenceTag(platformTag)" to "if (!PresenceAlarm.isPresenceTag(platformTag)",
            "&& PresenceAlarm.notify(" to "|| PresenceAlarm.notify(",
            "return super.onNotifyNotificationWithChannel(" to "return false; // super.onNotifyNotificationWithChannel(",
        )) {
            val mutant = src.replace(from, to)
            assertTrue("الطفرة لم تُطبَّق (تغيّر شكل الكود؟): $from", mutant != src)
            assertFalse("الحارس يقبل الطفرة: $to", routing.containsMatchIn(mutant))
        }
        // الإلغاء بالوسم والمعرّف من المكتبة أيّاً كانت القناة: تجاوزه يكسر إسكات الرنين من الصفحة
        assertFalse("onCancelNotification متجاوَز", Regex("void\\s+onCancelNotification\\s*\\(").containsMatchIn(src))
    }

    @Test
    fun alarmChannelAndNotificationCarryTheAlarmTraits() {
        val src = file("src/main/java/net/fieldsa/twa/PresenceAlarm.java")
        for (s in listOf("AudioAttributes.USAGE_ALARM", "Settings.System.DEFAULT_ALARM_ALERT_URI", "NotificationManager.IMPORTANCE_HIGH",
                "setVibrationPattern(VIBRATION)", "Notification.CATEGORY_ALARM", "n.flags |= Notification.FLAG_INSISTENT",
                "setTimeoutAfter(TIMEOUT_MS)", "setChannelId(CHANNEL_ID)", "original.clone()",
                "IMPORTANCE_NONE) return false", "catch (RuntimeException",
                // الوسم والمعرّف نفسهما: cancelNotification(tag, -1) من Chrome يسكت الرنين
                "nm.notify(platformTag, platformId, n)",
                // بلا نغمة منبّه يسكت الإنذار: الرنين ثم صوت الإشعار (صوت قناة «عام»)
                "RingtoneManager.TYPE_ALARM", "Settings.System.DEFAULT_RINGTONE_URI", "Settings.System.DEFAULT_NOTIFICATION_URI")) {
            assertTrue("$s غائب عن PresenceAlarm", src.contains(s))
        }
        // ما يحتاج إذناً أو لا يملكه تطبيقٌ عادي
        for (s in listOf("setFullScreenIntent", "setBypassDnd", "setLockscreenVisibility")) {
            assertFalse("$s في PresenceAlarm", src.contains(s))
        }
    }

    @Test
    fun noNewPermissionsInEitherManifest() {
        for (rel in listOf("src/main/AndroidManifest.xml", "src/printonly/AndroidManifest.xml")) {
            val m = file(rel)
            for (p in listOf("USE_FULL_SCREEN_INTENT", "ACCESS_NOTIFICATION_POLICY", "android.permission.VIBRATE")) {
                assertFalse("$p في $rel", m.contains(p))
            }
        }
    }

    @Test
    fun channelStringsAreArabicAndNeutral() {
        val xml = file("src/main/res/values/strings.xml")
        for (name in listOf("presence_alarm_channel_name", "presence_alarm_channel_description")) {
            val text = Regex("<string name=\"$name\">([^<]*)</string>").find(xml)?.groupValues?.get(1)
            assertTrue("النص $name غائب عن strings.xml", text != null && Regex("[؀-ۿ]").containsMatchIn(text))
            // لا اسم مزوّد الدفع في أي نصٍّ يراه المندوب (كحارس ProviderNameGuardTest)
            assertFalse("اسم مزوّد الدفع في $name",
                Regex("near\\s*[-_]?\\s*pay", RegexOption.IGNORE_CASE).containsMatchIn(text!!) ||
                    Regex("نير\\s*[-_]?\\s*با[يى]").containsMatchIn(text))
        }
    }

    /** الوسم نفسه في الخادم وعامل الخدمة — يُتخطّى حين يُبنى المجلد وحده بلا بقية المستودع */
    @Test
    fun webTagMatchesServerAndServiceWorker() {
        val server = repoFile("backend/src/services/presenceChecks.ts")
        val sw = repoFile("web-admin/public/sw.js")
        assumeTrue("بقية المستودع غير موجودة بجانب android-rep", server != null && sw != null)
        assertTrue("الخادم لم يعد يرسل tag: 'presence'", server!!.contains("tag: '${PresenceAlarm.WEB_TAG}'"))
        assertTrue("sw.js لم يعد يعرف data.tag === 'presence'", sw!!.contains("data.tag === '${PresenceAlarm.WEB_TAG}'"))
    }

    private fun file(rel: String): String =
        (listOf(File(rel), File("app/$rel")).firstOrNull { it.isFile } ?: error("لم يُعثر على $rel من ${File(".").absolutePath}"))
            .readText(Charsets.UTF_8)

    /** من مجلد الوحدة (app) أو من جذر android-rep */
    private fun repoFile(rel: String): String? =
        listOf(File("../../$rel"), File("../$rel")).firstOrNull { it.isFile }?.readText(Charsets.UTF_8)
}
