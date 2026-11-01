package net.fieldsa.twa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * حارس مصدر (طلب المالك، ١ نوفمبر): اسم مزوّد الدفع لا يظهر للمندوب أبداً — لا يعرف المستخدم أن التحصيل عبر NearPay.
 * يفحص نصوص ملفات Kotlin في الحزمتين cardpay وprint الحرفية (لا التعليقات ولا المعرّفات): نصٌّ فيه عربية واسم المزوّد بأي كتابة
 * (NearPay، Near Pay، nearpay، نيرباي، نير باي) يُفشل الاختبار. العبارات المحايدة: «مزوّد الدفع»، «نقطة البيع»، «البنك المحصّل».
 * شاشات حزمة المزوّد نفسها خارج سيطرتنا ولا يغطيها هذا الحارس.
 * خارج حزمة cardpay عمداً: البناء بلا رمز المزوّد يستثني net/fieldsa/twa/cardpay من كل ترجمة Kotlin (والاختبارات منها)،
 * والحارس يقرأ الملفات من القرص فيعمل في البناءين.
 */
class ProviderNameGuardTest {

    @Test
    fun noArabicUiLiteralNamesTheProvider() {
        val files = PACKAGES.flatMap { pkg ->
            sourceDir(pkg).listFiles { f -> f.isFile && f.name.endsWith(".kt") }.orEmpty().sortedBy { it.name }
        }
        assertTrue("لا ملفات Kotlin في ${PACKAGES.joinToString()} — الحارس لا يفحص شيئاً", files.size >= 3)
        var scanned = 0
        val offenders = mutableListOf<String>()
        for (f in files) {
            for ((line, text) in stringLiterals(f.readText(Charsets.UTF_8))) {
                scanned++
                if (namesProvider(text)) offenders += "${f.name}:$line  \"$text\""
            }
        }
        // ما يقارب مئتي نصٍّ عربي في الوحدتين: عددٌ صغير يعني أن المحلّل لم يعد يرى النصوص
        assertTrue("المحلّل لم يجد إلا $scanned نصاً — تحقّق منه", scanned >= 100)
        if (offenders.isNotEmpty()) {
            fail("اسم مزوّد الدفع في نصوص تظهر للمندوب — استعمل «مزوّد الدفع» أو «نقطة البيع»:\n" + offenders.joinToString("\n"))
        }
    }

    /**
     * سطر الدعم الفني يعرض نص الوحدة الخام (toString لأخطاء الحزمة: io.nearpay.terminalsdk.…) — الحارس أعلاه يفحص نصوصنا
     * لا نصوص الحزمة، فكل إسنادٍ لذلك السطر يمرّ بـproviderNeutral (مراجعة ١ نوفمبر). سلوك الدالة نفسها في
     * cardpay/ProviderNeutralTest (يُبنى مع رمز المزوّد كبقية الحزمة)
     */
    @Test
    fun rawSdkDetailIsNeutralizedBeforeDisplay() {
        val src = File(sourceDir("cardpay"), "CardPayActivity.kt").readText(Charsets.UTF_8)
        val assigns = Regex("detailView\\.text\\s*=\\s*([^\\n]+)").findAll(src).map { it.groupValues[1] }.toList()
        assertTrue("لا إسناد لسطر الدعم الفني — تحقّق من الحارس", assigns.isNotEmpty())
        for (a in assigns) assertTrue("سطر الدعم الفني بلا providerNeutral: $a", a.contains("providerNeutral"))
    }

    /** المحلّل نفسه: التعليقات لا تُعدّ، والنص الحرفي يُعدّ أينما كان */
    @Test
    fun lexerSkipsCommentsAndCatchesLiterals() {
        val src = """
            // تعليق: يتحقق الخادم لدى NearPay
            /* كتلة /* متداخلة */ لدى NearPay */
            val c = '"'
            val ok = "تعذر الدفع — لدى مزوّد الدفع"
            val bad = "يتحقق الخادم لدى NearPay"
            val bad2 = "حالة ${'$'}{x.ifEmpty { "y" }} نير باي"
            val tag = "NearpaySession"
        """.trimIndent()
        val hits = stringLiterals(src).filter { namesProvider(it.second) }.map { it.first }
        assertEquals(listOf(5, 6), hits)
    }

    private fun sourceDir(pkg: String): File {
        val rel = "src/main/java/net/fieldsa/twa/$pkg"
        // Gradle يشغّل الاختبار من مجلد الوحدة (app)؛ والبديل للتشغيل من جذر المشروع
        return listOf(File(rel), File("app/$rel")).firstOrNull { it.isDirectory }
            ?: error("لم يُعثر على $rel من ${File(".").absolutePath}")
    }

    private companion object {
        val PACKAGES = listOf("cardpay", "print")
        val ARABIC = Regex("[؀-ۿ]")
        val LATIN_NAME = Regex("near\\s*[-_]?\\s*pay", RegexOption.IGNORE_CASE)
        val ARABIC_NAME = Regex("نير\\s*[-_]?\\s*با[يى]")

        fun namesProvider(text: String): Boolean =
            ARABIC_NAME.containsMatchIn(text) || (LATIN_NAME.containsMatchIn(text) && ARABIC.containsMatchIn(text))

        /** النصوص الحرفية في مصدر Kotlin مع رقم سطرها — يتخطّى التعليقات (والمتداخلة منها) وحروف '…' */
        fun stringLiterals(src: String): List<Pair<Int, String>> {
            val out = mutableListOf<Pair<Int, String>>()
            val n = src.length
            fun lineAt(at: Int) = 1 + (0 until at).count { src[it] == '\n' }
            var i = 0
            while (i < n) {
                when {
                    src.startsWith("//", i) -> i = src.indexOf('\n', i).let { if (it < 0) n else it }
                    src.startsWith("/*", i) -> {
                        var depth = 0
                        while (i < n) {
                            if (src.startsWith("/*", i)) {
                                depth++
                                i += 2
                            } else if (src.startsWith("*/", i)) {
                                depth--
                                i += 2
                                if (depth == 0) break
                            } else {
                                i++
                            }
                        }
                    }
                    src.startsWith("\"\"\"", i) -> {
                        val end = src.indexOf("\"\"\"", i + 3).let { if (it < 0) n else it }
                        out += lineAt(i) to src.substring(i + 3, end)
                        i = end + 3
                    }
                    src[i] == '"' -> {
                        val start = i
                        val sb = StringBuilder()
                        i++
                        while (i < n && src[i] != '"' && src[i] != '\n') {
                            when {
                                src[i] == '\\' && i + 1 < n -> {
                                    sb.append(src, i, i + 2)
                                    i += 2
                                }
                                src.startsWith("\${", i) -> {
                                    val close = matchBrace(src, i + 1)
                                    sb.append(src, i, close + 1)
                                    i = close + 1
                                }
                                else -> sb.append(src[i++])
                            }
                        }
                        out += lineAt(start) to sb.toString()
                        i++
                    }
                    // حرفٌ مفرد: '"' أو '\'' أو 'A' لا يفتح نصاً
                    src[i] == '\'' -> i = (if (src.startsWith("\\", i + 1)) src.indexOf('\'', i + 3) else i + 2) + 1
                    else -> i++
                }
            }
            return out
        }

        private fun matchBrace(src: String, open: Int): Int {
            var depth = 0
            for (j in open until src.length) {
                when (src[j]) {
                    '{' -> depth++
                    '}' -> if (--depth == 0) return j
                }
            }
            return src.length - 1
        }
    }
}
