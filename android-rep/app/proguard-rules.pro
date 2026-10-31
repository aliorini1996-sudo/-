# قواعد R8 لنسخة الإصدار (minifyEnabled true).
#
# ═══ وحدة التحصيل بالبطاقة — NearPay Terminal SDK ═══
# توثيق NearPay لا يذكر قواعد ProGuard/R8 أصلاً، ولا اسم الحزمة (package) لأصنافها على أندرويد.
# نماذجها أصناف Kotlin بتعليقات kotlinx.serialization (@Serializable/@SerialName)، فالتسمية المضغوطة قد تكسر قراءة ردودها.
#
# تحقّق عند وصول الحزمة:
#  1. افتح terminalsdk-release-0.2.6.aar (ملف zip) وانظر:
#     - classes.jar: الحزمة الفعلية لأصنافها (TerminalSDK وأخواتها). القاعدة أدناه تفترض io.nearpay لأنه مجموعة Maven،
#       فإن اختلفت الحزمة فاستبدلها — قاعدةٌ لا تطابق شيئاً لا تحمي شيئاً ولا تُنبّه.
#     - proguard.txt: قواعد المستهلك إن شحنتها الوحدة (تُطبَّق تلقائياً، وقد تغني عمّا هنا).
#  2. جرّب نسخة إصدار مصغّرة على جهاز حقيقي من مسار الاختبار الداخلي قبل أي نشر.
# (class في ProGuard تطابق الأصناف والواجهات والتعدادات معاً)
-keep class io.nearpay.** { *; }

# السمات التي تحتاجها Kotlin والانعكاس (reflection) والأصناف الداخلية والمتداخلة (JWTLoginFailure.JWTLoginFailure وأمثالها)
-keepattributes Signature, InnerClasses, EnclosingMethod, Exceptions, *Annotation*, RuntimeVisibleAnnotations, AnnotationDefault

# kotlinx.serialization — القواعد الرسمية للمكتبة (تشحنها هي أيضاً منذ 1.5؛ تكرارها هنا لا يضر)
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    static ** Companion;
    *** Companion;
}
-if @kotlinx.serialization.Serializable class ** {
    static **$* *;
}
-keepclassmembers class <2>$<3> {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class ** {
    public static ** INSTANCE;
}
-keepclassmembers class <1> {
    public static <1> INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}

# أرقام الأسطر في تقارير الأعطال (Play Console) — تُفكّ بملف mapping.txt المرفوع مع الحزمة
-keepattributes SourceFile, LineNumberTable
