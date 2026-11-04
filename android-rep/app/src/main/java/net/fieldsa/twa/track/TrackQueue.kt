package net.fieldsa.twa.track

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * طابور النقاط المنتظرة للرفع — ملف JSON-lines في filesDir (سطرٌ لكل نقطة كما يقرؤها الخادم)، فلا تضيع نقاط النفق أو انقطاع
 * الشبكة ولا موت العملية. السقف ٣٠٠٠ نقطة (الأقدم يُسقط)، والدفعة ≤ ٢٠٠، ولا يُحذف من الطابور إلا ما ردّ عليه الخادم بـ2xx.
 * java.io وحده (بلا أندرويد): TrackQueueTest يختبره كما هو على ملفٍ مؤقت. كل العمليات متزامنة على الكائن.
 */
class TrackQueue(private val file: File, private val cap: Int = TrackContract.MAX_QUEUED) {
    private var lines: ArrayDeque<String>? = null

    @Synchronized
    fun add(fix: TrackFix) {
        val q = load()
        val line = encodeLine(fix)
        q.addLast(line)
        if (q.size > cap) {
            while (q.size > cap) q.removeFirst()
            rewrite(q)
        } else {
            append(line)
        }
    }

    /** أقدم max نقطة (بلا حذف) */
    @Synchronized
    fun peek(max: Int = TrackContract.MAX_BATCH): List<String> = load().take(max.coerceAtLeast(0))

    /** يحذف أقدم n نقطة — بعد ردّ 2xx على الدفعة نفسها (أو رفضها نهائياً) */
    @Synchronized
    fun remove(n: Int) {
        val q = load()
        if (n <= 0 || q.isEmpty()) return
        repeat(minOf(n, q.size)) { q.removeFirst() }
        rewrite(q)
    }

    @Synchronized
    fun size(): Int = load().size

    @Synchronized
    fun clear() {
        lines = ArrayDeque()
        try {
            if (file.exists()) file.delete()
        } catch (e: SecurityException) {
            // لا شيء
        }
    }

    private fun load(): ArrayDeque<String> {
        lines?.let { return it }
        val text = try {
            if (file.isFile) file.readText(Charsets.UTF_8) else ""
        } catch (e: IOException) {
            ""
        }
        val q = ArrayDeque(parseLines(text, cap))
        lines = q
        // سطرٌ مبتور في آخر الملف (موتٌ أثناء الكتابة) كان سيلتصق به السطر التالي: يُعاد كتابة الملف سليماً مرةً واحدة
        if (text.isNotEmpty() && (!text.endsWith("\n") || text.count { it == '\n' } != q.size)) rewrite(q)
        return q
    }

    private fun append(line: String) {
        try {
            file.parentFile?.mkdirs()
            FileOutputStream(file, true).use { it.write((line + "\n").toByteArray(Charsets.UTF_8)) }
        } catch (e: IOException) {
            // القرص ممتلئ: النقطة في الذاكرة تُرفع ما دامت العملية حيّة
        }
    }

    /** كتابةٌ كاملة عبر ملفٍ مؤقت ثم إعادة تسمية: انقطاعٌ في منتصفها يُبقي النسخة السابقة كاملة */
    private fun rewrite(q: ArrayDeque<String>) {
        try {
            file.parentFile?.mkdirs()
            if (q.isEmpty()) {
                if (file.exists()) file.delete()
                return
            }
            val tmp = File(file.path + ".tmp")
            FileOutputStream(tmp, false).use { out ->
                val sb = StringBuilder()
                for (l in q) sb.append(l).append('\n')
                out.write(sb.toString().toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) {
                file.delete()
                tmp.renameTo(file)
            }
        } catch (e: IOException) {
            // يبقى الطابور في الذاكرة صحيحاً، والكتابة التالية تحاول ثانية
        }
    }

    companion object {
        const val FILE_NAME = "fs_track_queue.jsonl"

        fun encodeLine(fix: TrackFix): String = TrackLogic.pointJson(fix).toString()

        /**
         * أسطر الملف السليمة وحدها (سطرٌ مبتور بموتٍ أثناء الكتابة يُسقط)، آخر cap منها
         */
        fun parseLines(text: String, cap: Int = TrackContract.MAX_QUEUED): List<String> {
            val ok = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() && validLine(it) }
            return if (ok.size > cap) ok.subList(ok.size - cap, ok.size) else ok
        }

        private fun validLine(line: String): Boolean = try {
            val o = JSONObject(line)
            val lat = (o.opt("lat") as? Number)?.toDouble()
            val lng = (o.opt("lng") as? Number)?.toDouble()
            lat != null && lng != null && TrackLogic.validCoordinates(lat, lng)
        } catch (e: JSONException) {
            false
        }

        /** جسم الطلب { "points": [...] } من أسطر الطابور */
        fun bodyOf(lines: List<String>): String {
            val arr = JSONArray()
            for (l in lines) {
                try {
                    arr.put(JSONObject(l))
                } catch (e: JSONException) {
                    // parseLines أسقطه سلفاً
                }
            }
            return JSONObject().put("points", arr).toString()
        }
    }
}
