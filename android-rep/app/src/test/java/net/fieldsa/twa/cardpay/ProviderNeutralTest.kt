package net.fieldsa.twa.cardpay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * سطر الدعم الفني في شاشة التحصيل: نص الوحدة الخام بلا اسم مزوّد الدفع (طلب المالك، ١ نوفمبر). في حزمة cardpay عمداً:
 * يُبنى مع رمز المزوّد وحده كبقية الحزمة (البناء بلا الرمز يستثنيها من الترجمة).
 */
class ProviderNeutralTest {
    private val brand = Regex("near\\s*[-_]?\\s*pay|نير\\s*با[يى]", RegexOption.IGNORE_CASE)

    @Test
    fun stripsThePackagePrefixAndTheName() {
        assertEquals(
            "LoginFailure: bad jwt (4038)",
            providerNeutral("io.nearpay.terminalsdk.listeners.failures.LoginFailure: bad jwt (4038)"),
        )
        for (s in listOf("NearPay error 5002", "Near Pay host", "NEAR-PAY", "near_pay", "نيرباي", "نير باي", "NearpayException: x")) {
            assertFalse(s, brand.containsMatchIn(providerNeutral(s)))
        }
        // نصٌّ بلا الاسم لا يُمسّ
        assertEquals("تعذر الدفع 5002", providerNeutral("تعذر الدفع 5002"))
    }

    @Test
    fun theHintStillReadsTheRawCode() {
        // التلميح يقرأ النص الخام، والحذف للعرض وحده — والتلميح نفسه بلا الاسم
        val raw = "io.nearpay.terminalsdk.Failure: terminal bound to another device 4035"
        val hint = nearpayHint(raw)
        assertNotNull(hint)
        assertEquals(hint, nearpayHint(providerNeutral(raw)))
        assertFalse(brand.containsMatchIn(hint!!))
    }
}
