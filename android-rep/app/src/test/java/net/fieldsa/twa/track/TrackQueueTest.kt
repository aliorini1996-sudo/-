package net.fieldsa.twa.track

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** طابور النقاط على القرص: الترتيب والسقف والدفعة والحذف بعد 2xx والبقاء بعد موت العملية والأسطر المبتورة */
class TrackQueueTest {

    @get:Rule
    val tmp = TemporaryFolder()

    // lng = i/2: قيمٌ دقيقة في الثنائي فتُقارن حرفياً
    private fun fix(i: Int) = TrackFix(24.5, i * 0.5, 10.0, null, 1_793_000_000_000L + i * 15_000L)

    private fun idOf(line: String) = JSONObject(line).getDouble("lng")

    @Test
    fun addPeekRemoveKeepsOrderAndPersists() {
        val file = File(tmp.root, TrackQueue.FILE_NAME)
        val q = TrackQueue(file)
        for (i in 1..5) q.add(fix(i))
        assertEquals(5, q.size())
        assertEquals(listOf(0.5, 1.0, 1.5), q.peek(3).map { idOf(it) })
        q.remove(2)
        assertEquals(3, q.size())
        assertEquals(1.5, idOf(q.peek(1)[0]), 0.0)
        // نسخةٌ جديدة (موت العملية) تقرأ الملف نفسه
        val again = TrackQueue(file)
        assertEquals(listOf(1.5, 2.0, 2.5), again.peek(10).map { idOf(it) })
        again.remove(10)
        assertEquals(0, again.size())
        assertFalse("طابورٌ فارغ بلا ملف", file.exists())
    }

    @Test
    fun capDropsTheOldest() {
        val file = File(tmp.root, TrackQueue.FILE_NAME)
        val q = TrackQueue(file, cap = 5)
        for (i in 1..8) q.add(fix(i))
        assertEquals(5, q.size())
        assertEquals(2.0, idOf(q.peek(1)[0]), 0.0)
        assertEquals(5, TrackQueue(file, cap = 5).size())
        assertEquals(5, file.readText().trim().split('\n').size)
    }

    @Test
    fun batchIsCappedAtTheServerMax() {
        val q = TrackQueue(File(tmp.root, TrackQueue.FILE_NAME))
        for (i in 1..250) q.add(fix(i))
        assertEquals(TrackContract.MAX_BATCH, q.peek().size)
        val body = JSONObject(TrackQueue.bodyOf(q.peek()))
        assertEquals(setOf("points"), body.keys().asSequence().toSet())
        val points = body.getJSONArray("points")
        assertEquals(200, points.length())
        assertEquals(setOf("lat", "lng", "accuracy", "speed", "capturedAt"), points.getJSONObject(0).keys().asSequence().toSet())
        assertTrue(points.getJSONObject(0).isNull("speed"))
    }

    @Test
    fun corruptOrTruncatedLinesAreSkipped() {
        val file = File(tmp.root, TrackQueue.FILE_NAME)
        val good = TrackQueue.encodeLine(fix(1))
        file.writeText("$good\n{\"lat\":24.1,\"lng\"\nnot json\n{\"lat\":200,\"lng\":46}\n\n${TrackQueue.encodeLine(fix(2))}\n")
        val q = TrackQueue(file)
        assertEquals(2, q.size())
        q.add(fix(3))
        assertEquals(3, TrackQueue(file).size())
        // آخر سطرين سليمين من الملف
        assertEquals(listOf(1.0, 1.5), TrackQueue.parseLines(file.readText(), cap = 2).map { idOf(it) })
    }

    @Test
    fun clearRemovesEverything() {
        val file = File(tmp.root, TrackQueue.FILE_NAME)
        val q = TrackQueue(file)
        q.add(fix(1))
        q.clear()
        assertEquals(0, q.size())
        assertFalse(file.exists())
        assertEquals(0, TrackQueue(file).size())
    }
}
