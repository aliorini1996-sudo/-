"""نقطة الاستقبال التي يدفع إليها Field Sales.

المسار عامّ (auth='public') لأن المُرسِل خادم لا مستخدم Odoo مسجَّل الدخول.
لذلك **المفتاح هو البوّابة الوحيدة**، ويُقارَن بـcompare_digest لا بـ==:
المقارنة العادية تنتهي عند أوّل حرف مختلف، فيتسرّب طول المطابقة عبر زمن
الاستجابة ويمكن استنتاج المفتاح حرفاً حرفاً.
"""
import hmac
import json
import logging

from odoo import http
from odoo.http import request

from ..mapping import PayloadError

_logger = logging.getLogger(__name__)

# سقف حجم الحمولة: Field Sales يرسل ٥٠٠ صفّاً كحدّ أقصى، وهو أقلّ بكثير من
# هذا. السقف يمنع استنزاف الذاكرة بحمولة مُعدّة خصّيصاً.
MAX_BYTES = 12 * 1024 * 1024


def _json(payload, status=200):
    return request.make_response(
        json.dumps(payload, ensure_ascii=False),
        headers=[('Content-Type', 'application/json; charset=utf-8')],
        status=status,
    )


class FieldSalesController(http.Controller):

    @http.route('/fieldsales/sync', type='http', auth='public', methods=['GET'],
                csrf=False, save_session=False)
    def health(self, **kwargs):
        """فحص الاتصال — زرّ «اختبار الاتصال» في Field Sales يطلب GET على
        الرابط الأساسي. لا يكشف شيئاً عن التنصيب ولا يتطلّب مفتاحاً."""
        return _json({'ok': True, 'service': 'fieldsales_connector'})

    @http.route('/fieldsales/sync', type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def sync(self, **kwargs):
        expected = request.env['fieldsales.connector'].sudo()._get_api_key()
        provided = request.httprequest.headers.get('X-API-Key', '')
        # مفتاح غير مضبوط = الوحدة غير مهيّأة. القبول حينها يعني نقطة كتابة
        # مفتوحة للجميع، فالرفض هو السلوك الصحيح لا التساهل.
        if not expected:
            return _json({'ok': False, 'error': 'الوحدة غير مهيّأة: لم يُضبط مفتاح API'}, 503)
        if not provided or not hmac.compare_digest(str(provided), str(expected)):
            _logger.warning('Field Sales sync rejected: bad API key from %s',
                            request.httprequest.remote_addr)
            return _json({'ok': False, 'error': 'مفتاح API غير صحيح'}, 401)

        raw = request.httprequest.get_data(cache=False)
        if len(raw) > MAX_BYTES:
            return _json({'ok': False, 'error': 'الحمولة أكبر من الحدّ المسموح'}, 413)
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as exc:
            return _json({'ok': False, 'error': 'JSON غير صالح: %s' % exc}, 400)

        try:
            result = request.env['fieldsales.connector'].sudo().process(payload)
        except PayloadError as exc:
            # ٤٠٠ لا ٥٠٠: الخلل في الحمولة، وField Sales يعرض الرسالة للمستخدم
            return _json({'ok': False, 'error': str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            _logger.exception('Field Sales sync failed')
            return _json({'ok': False, 'error': 'فشل الترحيل: %s' % str(exc)[:200]}, 500)
        return _json(result)
