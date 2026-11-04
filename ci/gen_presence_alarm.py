#!/usr/bin/env python3
# صوت «أثبت تواجدك» لإشعار الآيفون: ٢٨ ثانية (آبل: أقلّ من ٣٠ وإلا يُشغَّل الصوت الافتراضي)، Linear PCM 16-bit أحادي
# 22050 هرتز في ملف WAV. حسابٌ صحيح بلا فاصلة عائمة: نفس البايتات على أي جهاز (ويندوز أو ماك أو لينكس)،
# فالفحص في CI يعيد التوليد ويقارن بالملف المحفوظ بايتاً ببايت.
#
#   python3 ci/gen_presence_alarm.py FieldSales/presence-alarm.wav
import sys
import wave

RATE = 22050
SECONDS = 28
FRAMES = RATE * SECONDS

# دورة ثانيتين: أربع نقرات قصيرة (١٢٠ م.ث، بينها ٨٠ م.ث) ثمّ صمت — والدورات تتناوب بين نغمتين (إلحاح لا رتابة)
CYCLE_MS = 2000
BEEP_MS = 120
GAP_MS = 80
BEEPS = 4
FREQS = (1568, 2093)          # G6 / C7: الأوضح على سمّاعة الجوال
RAMP = RATE * 5 // 1000       # ٥ م.ث صعوداً وهبوطاً: بلا طقطقة
GAIN_NUM, GAIN_DEN = 7, 10    # ٧٠٪ من أقصى الشدّة: بلا تشبّع


def ms_to_frames(ms: int) -> int:
    return RATE * ms // 1000


def tri(phase: int) -> int:
    """موجة مثلّثة من مُراكِم طور ٣٢ بت ⇒ −32767..32767 (أنعم من المربّعة، وتبقى «منبّهاً»)"""
    p = (phase >> 16) & 0xFFFF
    t = p if p < 32768 else 65535 - p      # 0..32767
    return t * 2 - 32767


def render() -> bytes:
    out = bytearray()
    cycle = ms_to_frames(CYCLE_MS)
    beep = ms_to_frames(BEEP_MS)
    step = ms_to_frames(BEEP_MS + GAP_MS)
    phase = 0
    for n in range(FRAMES):
        c, pos = divmod(n, cycle)
        freq = FREQS[c % 2]
        inc = (freq << 32) // RATE
        k, within = divmod(pos, step)
        s = 0
        if k < BEEPS and within < beep:
            env = 32768
            if within < RAMP:
                env = within * 32768 // RAMP
            elif beep - within <= RAMP:
                env = (beep - within) * 32768 // RAMP
            s = tri(phase) * env // 32768 * GAIN_NUM // GAIN_DEN
            phase = (phase + inc) & 0xFFFFFFFF
        else:
            phase = 0
        out += int(s).to_bytes(2, "little", signed=True)
    return bytes(out)


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "presence-alarm.wav"
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(render())


if __name__ == "__main__":
    main()
