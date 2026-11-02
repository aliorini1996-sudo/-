package net.fieldsa.twa.print

/** عقد جسر الطباعة مع الويب — كل قيمةٍ هنا نظيرُها حرفياً في web-admin/src/lib/print/transport/bridgeContract.ts (يحرسها bridgeContract.test.ts) */
object BridgeContract {
    const val SCHEME = "fieldsaprint"
    const val HOST_PRINT = "print"
    const val HOST_PRINTER = "printer"
    const val PARAM_PAYLOAD = "p"
    const val PARAM_KEY = "k"
    const val LAUNCH_PARAM = "fsbridge"
    /** 2 منذ 1.2.1: شاشة الاختيار تُظهر الطابعات المقترنة، فتُقدّمها الصفحة على نافذة Chrome (platform.ts) */
    const val PROTOCOL_VERSION = 2
    const val PACKAGE = "net.fieldsa.twa"
    const val FORMAT_VERSION = 1
    const val HEADER_BYTES = 14
    const val MAX_PAYLOAD_CHARS = 196_608
    const val MAX_INNER_BYTES = 5_242_880
    const val MAX_JOB_BYTES = 4_194_304
    const val MAX_MARKS = 65_535
    const val MAX_LABEL_BYTES = 160
    const val MAX_CANCEL_BYTES = 16
    const val KEY_LENGTH = 22
    const val SPP_UUID = "00001101-0000-1000-8000-00805F9B34FB"
}
