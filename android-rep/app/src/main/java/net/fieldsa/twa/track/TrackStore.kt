package net.fieldsa.twa.track

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences

/**
 * ما يحفظه التتبّع الخلفي على الجوال (SharedPreferences خاصة بالتطبيق): رمز التتبّع ويوم البدء، والموافقة على الإفصاح وهوية من
 * وافق (المندوب والشركة كما في الرمز)، ومالك نقاط الطابور. الرمز لا يُطبع ولا يُسجَّل ولا يغادر إلا إلى نقطة الرفع.
 */
object TrackStore {
    private const val PREFS = "fieldsa_track"
    private const val KEY_TOKEN = "token"
    private const val KEY_STARTED_DAY = "started_day"
    private const val KEY_DISCLOSURE = "disclosure_accepted"
    private const val KEY_CONSENT_IDENTITY = "consent_identity"
    private const val KEY_QUEUE_OWNER = "queue_owner"
    private const val KEY_DEBUG_URL = "debug_url"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun token(context: Context): String? = prefs(context).getString(KEY_TOKEN, null)

    fun startedDay(context: Context): String? = prefs(context).getString(KEY_STARTED_DAY, null)

    /** يُكتب فوراً (commit) قبل تشغيل الخدمة: موت العملية بينهما لا يترك خدمةً بلا رمز */
    @SuppressLint("ApplySharedPref")
    fun saveStart(context: Context, token: String, day: String, debugUrl: String?) {
        val e = prefs(context).edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_STARTED_DAY, day)
        if (debugUrl != null) e.putString(KEY_DEBUG_URL, debugUrl) else e.remove(KEY_DEBUG_URL)
        e.commit()
    }

    /** الإيقاف (الخروج، انتهاء الرمز، 401/403، إيقاف الشركة، نهاية اليوم): الرمز ويوم البدء يُمحيان، والموافقة تبقى */
    @SuppressLint("ApplySharedPref")
    fun clearToken(context: Context) {
        prefs(context).edit()
            .remove(KEY_TOKEN)
            .remove(KEY_STARTED_DAY)
            .remove(KEY_DEBUG_URL)
            .commit()
    }

    /**
     * وافق المندوب على الإفصاح لهذه الهوية نفسها؟ الموافقة مربوطة بالمندوب والشركة اللذين في الرمز: رابط البدء يطلقه أي موقع،
     * فرمزٌ لحسابٍ آخر (شركةٍ أخرى) لا يمرّ بموافقةٍ سابقة — يُعرض الإفصاح من جديد ولا يُستبدل الرمز الجاري بصمت
     */
    fun consentedTo(context: Context, identity: TrackIdentity): Boolean {
        val p = prefs(context)
        return p.getBoolean(KEY_DISCLOSURE, false) && p.getString(KEY_CONSENT_IDENTITY, null) == identity.key()
    }

    /** وُوفق على الإفصاح مرةً من قبل (لأي هوية) — لنصّ الحوار وحده */
    fun everConsented(context: Context): Boolean = prefs(context).getBoolean(KEY_DISCLOSURE, false)

    @SuppressLint("ApplySharedPref")
    fun saveConsent(context: Context, identity: TrackIdentity) {
        prefs(context).edit()
            .putBoolean(KEY_DISCLOSURE, true)
            .putString(KEY_CONSENT_IDENTITY, identity.key())
            .commit()
    }

    /** مالك النقاط المنتظرة في الطابور: نقاط مندوبٍ لا تُرفع برمز غيره (خرج ودخل غيره على الجوال نفسه) */
    fun queueOwner(context: Context): String? = prefs(context).getString(KEY_QUEUE_OWNER, null)

    @SuppressLint("ApplySharedPref")
    fun setQueueOwner(context: Context, owner: String) {
        prefs(context).edit().putString(KEY_QUEUE_OWNER, owner).commit()
    }

    /** عنوان الرفع البديل — يُحفظ في بناء التطوير وحده (TrackActivity)، والخدمة لا تقرؤه إلا فيه */
    fun debugUrl(context: Context): String? = prefs(context).getString(KEY_DEBUG_URL, null)
}
