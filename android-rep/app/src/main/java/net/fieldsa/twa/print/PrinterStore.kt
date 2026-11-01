package net.fieldsa.twa.print

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * ما يحفظه جسر الطباعة على الجوال (SharedPreferences خاصة بالتطبيق): الطابعة المختارة، ومفتاح الثقة لهذا التثبيت.
 * المفتاح يصل إلى الصفحة في عنوان الإطلاق (LauncherActivity ← fsbridge) وتحذفه الصفحة من العنوان فوراً؛ أمرٌ يحمله ⇒ طباعة
 * بلا نقرة تأكيد، وما سواه (أي موقعٍ آخر أو تبويب متصفح) ⇒ شاشة تأكيد. لا أمر طباعة ولا بايتات تُحفظ هنا.
 */
object PrinterStore {
    private const val PREFS = "fieldsa_print"
    private const val KEY_ADDRESS = "printer_address"
    private const val KEY_NAME = "printer_name"
    private const val KEY_BRIDGE = "bridge_key"
    private const val KEY_BYTES = 16 // ١٢٨ بتّاً ⇒ ٢٢ حرف base64url بلا حشو = BridgeContract.KEY_LENGTH

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** مفتاح الثقة؛ يُنشأ عند أول طلب ويُكتب فوراً (commit لا apply) قبل أن يغادر إلى الصفحة — مرةً واحدة في عمر التثبيت */
    @SuppressLint("ApplySharedPref")
    @JvmStatic
    @Synchronized
    fun bridgeKey(context: Context): String {
        val p = prefs(context)
        val stored = p.getString(KEY_BRIDGE, null)
        if (stored != null && stored.length == BridgeContract.KEY_LENGTH) return stored
        val raw = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }
        val key = Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
        p.edit().putString(KEY_BRIDGE, key).commit()
        return key
    }

    /** هل الأمر من صفحتنا؟ لا يُنشئ مفتاحاً؛ مقارنة بزمنٍ ثابت، ولا تطابق بلا مفتاحٍ محفوظ */
    fun keyMatches(context: Context, candidate: String?): Boolean {
        if (candidate == null || candidate.length != BridgeContract.KEY_LENGTH) return false
        val stored = prefs(context).getString(KEY_BRIDGE, null) ?: return false
        if (stored.length != BridgeContract.KEY_LENGTH) return false
        return MessageDigest.isEqual(stored.toByteArray(Charsets.UTF_8), candidate.toByteArray(Charsets.UTF_8))
    }

    fun savedAddress(context: Context): String? =
        prefs(context).getString(KEY_ADDRESS, null)?.takeIf { BluetoothAdapter.checkBluetoothAddress(it) }

    fun savedName(context: Context): String? = prefs(context).getString(KEY_NAME, null)

    fun savePrinter(context: Context, address: String, name: String?) {
        if (!BluetoothAdapter.checkBluetoothAddress(address)) return
        prefs(context).edit()
            .putString(KEY_ADDRESS, address)
            .putString(KEY_NAME, name)
            .apply()
    }
}
