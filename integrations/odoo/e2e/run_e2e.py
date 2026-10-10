"""الاختبار الحيّ لوحدة fieldsales_connector على Odoo حقيقي (يشغّله .github/workflows/odoo-connector.yml).

يدفع حمولات بنتها المنصة بدوالّها نفسها (backend/scripts/odoo-e2e-payloads.ts) إلى /fieldsales/sync كما يدفعها
الخادم، ثم يقرأ Odoo عبر XML-RPC ويتحقّق أن العملاء والمنتجات والفواتير والسندات انعكست بلا مشاكل:
الإنشاء، والتحديث بلا تكرار، والمؤرشف، والضريبة، ومطابقة إجمالي كل فاتورة بإجمالي المنصة حرفياً، والإلغاء،
وحماية الفاتورة المرحّلة، وربط السند بعميله وفواتيره، والمفتاح.

    python3 run_e2e.py <مجلد الحمولات> [URL] [DB]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xmlrpc.client

PAYLOADS = sys.argv[1] if len(sys.argv) > 1 else 'e2e-payloads'
URL = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:8069'
DB = sys.argv[3] if len(sys.argv) > 3 else 'fs_e2e'
KEY = os.environ.get('FS_E2E_KEY', 'e2e-test-key')
SYNC = URL + '/fieldsales/sync'

failures = []
passes = 0


def check(cond, label, detail=''):
    global passes
    if cond:
        passes += 1
        print('  ✔ ' + label)
    else:
        failures.append('%s %s' % (label, detail))
        print('  ✖ %s %s' % (label, detail))


def load(name):
    with open(os.path.join(PAYLOADS, name + '.json'), encoding='utf-8') as f:
        return json.load(f)


def post(body, key=KEY):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(SYNC, data=data, method='POST',
                                 headers={'Content-Type': 'application/json', 'X-API-Key': key})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'raw': raw[:300]}


def wait_up(timeout=240):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(SYNC, timeout=10) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(3)
    return False


print('▶ انتظار Odoo على', URL)
if not wait_up():
    print('✖ Odoo لم يقم')
    sys.exit(2)

common = xmlrpc.client.ServerProxy(URL + '/xmlrpc/2/common')
uid = common.authenticate(DB, 'admin', 'admin', {})
models = xmlrpc.client.ServerProxy(URL + '/xmlrpc/2/object', allow_none=True)
version = common.version().get('server_version')
print('▶ Odoo', version, '— قاعدة', DB, 'المستخدم', uid)

ALL = {'context': {'active_test': False}}


def sr(model, domain, fields, **kw):
    return models.execute_kw(DB, uid, 'admin', model, 'search_read', [domain], dict({'fields': fields}, **kw))


def by_fs(model, fields):
    return {r['fs_id']: r for r in sr(model, [('fs_id', '!=', False)], ['fs_id'] + fields, **ALL)}


exp = load('expected')

# ═══ المفتاح والاتصال ═══
print('\n▶ المفتاح')
st, body = post({'source': 'field-sales', 'resource': 'ping', 'count': 0, 'data': []})
check(st == 200 and body.get('ok') is True, 'ping بالمفتاح الصحيح ⇒ 200', '%s %s' % (st, body))
st, body = post({'source': 'field-sales', 'resource': 'ping', 'count': 0, 'data': []}, key='wrong-key')
check(st == 401, 'مفتاح خاطئ ⇒ 401', str(st))
check(exp['maxPayloadBytes'] < 12 * 1024 * 1024, 'الحمولة تحت سقف ١٢ ميغابايت (صور المنتجات منزوعة)', str(exp['maxPayloadBytes']))

# ═══ الجولة الأولى ═══
print('\n▶ الجولة الأولى')
res = {}
for resource in ('customers', 'products', 'invoices', 'receipts'):
    st, body = post(load('round1_' + resource))
    res[resource] = body
    print('   %s ⇒ %s %s' % (resource, st, {k: body.get(k) for k in ('created', 'updated', 'errors')}))
    if body.get('error_details'):
        print('     أخطاء:', body['error_details'])
check(res['customers'].get('created') == 3 and res['customers'].get('errors') == 0, 'العملاء: ٣ أُنشئوا بلا أخطاء', str(res['customers']))
check(res['products'].get('created') == 4 and res['products'].get('errors') == 0, 'المنتجات: ٤ أُنشئت بلا أخطاء', str(res['products']))
N_INV = len(exp['invoices'])
check(res['invoices'].get('created') == N_INV and res['invoices'].get('errors') == 0,
      'الفواتير: %d أُنشئت (نقدية وآجلة ومرتجع) بلا أخطاء، والملغاة لم تُنشأ' % N_INV, str(res['invoices']))
rec_err_ids = [e.get('id') for e in res['receipts'].get('error_details') or []]
check(res['receipts'].get('created') == 3 and res['receipts'].get('errors') == 1 and rec_err_ids == [exp['unsyncedReceipt']],
      'السندات: ٣ أُنشئت، وسند عميلٍ لم يُزامَن مرفوضٌ بخطأ ظاهر', str(res['receipts']))

# ═══ التحقق داخل Odoo ═══
print('\n▶ داخل Odoo')
partners = by_fs('res.partner', ['name', 'active', 'vat'])
for fs_id, e in exp['customers'].items():
    p = partners.get(fs_id)
    check(bool(p) and p['name'] == e['name'] and p['active'] == e['active'],
          'العميل %s (%s)' % (fs_id, 'نشط' if e['active'] else 'مؤرشف'), str(p))
check(partners.get('c1', {}).get('vat') == '300000000000003', 'الرقم الضريبي للعميل')

templates = by_fs('product.template', ['name', 'active', 'taxes_id', 'list_price'])
taxes = {t['id']: t['amount'] for t in sr('account.tax', [], ['amount'])}
for fs_id, e in exp['products'].items():
    t = templates.get(fs_id)
    tax_amounts = sorted(taxes.get(i) for i in (t or {}).get('taxes_id', []))
    want = [float(e['tax'])] if e['tax'] else []
    check(bool(t) and t['active'] == e['active'] and tax_amounts == want,
          'المنتج %s: %s، ضريبته %s' % (fs_id, 'نشط' if e['active'] else 'مؤرشف', e['tax']), str((t, tax_amounts)))

MOVE_FIELDS = ['move_type', 'state', 'amount_total', 'amount_tax', 'fs_total', 'fs_total_diff', 'fs_tax_diff',
               'invoice_date', 'partner_id', 'ref', 'narration']
moves = by_fs('account.move', MOVE_FIELDS)
company_id = sr('res.users', [('id', '=', uid)], ['company_id'])[0]['company_id'][0]
rounding = sr('res.company', [('id', '=', company_id)], ['tax_calculation_rounding_method'])[0]['tax_calculation_rounding_method']
print('   طريقة تقريب الضريبة في الشركة:', rounding)
for fs_id, e in exp['invoices'].items():
    m = moves.get(fs_id)
    if not m:
        check(False, 'الفاتورة %s موجودة' % e['number'])
        continue
    check(m['move_type'] == e['moveType'] and m['state'] == 'draft', 'الفاتورة %s: %s مسودّة' % (e['number'], e['moveType']), str(m['move_type']))
    check(abs(m['amount_total'] - e['total']) < 0.005 and abs(m['fs_total_diff']) < 0.005,
          'الفاتورة %s: إجمالي Odoo %.2f = إجمالي المنصة %.2f' % (e['number'], m['amount_total'], e['total']),
          'ضريبة Odoo %.2f والمنصة %.2f' % (m['amount_tax'], e['tax']))
    # INV-0008: تقريب Odoo لكل بند يعطيها ٠٫٦٠ والمنصة ٠٫٥٩ — تُضبط على ضريبة المنصة بالآلية الرسمية (tax_totals)
    check(abs(m['amount_tax'] - e['tax']) < 0.005 and abs(m['fs_tax_diff']) < 0.005,
          'الفاتورة %s: الضريبة %.2f = %.2f حرفياً%s' % (e['number'], m['amount_tax'], e['tax'],
                                                       ' (بتقريب Odoo لكل بند)' if fs_id in exp['roundingSensitive'] else ''),
          'fs_tax_diff=%s' % m['fs_tax_diff'])
included = sr('account.tax', [('name', 'ilike', 'Field Sales')], ['amount', 'type_tax_use'])
check(len(included) == 1 and included[0]['amount'] == 15 and included[0]['type_tax_use'] == 'sale',
      'ضريبة ١٥٪ «شاملة في السعر» أُنشئت مرةً واحدة للفواتير الشاملة', str(included))
for fs_id in exp['neverCreated']:
    check(fs_id not in moves, 'الفاتورة الملغاة قبل وصولها (%s) لم تُنشأ' % fs_id)
check(moves.get('i2', {}).get('invoice_date') == exp['i2LocalDate'], 'تاريخ الفاتورة المحلي (بعد منتصف الليل بالرياض)',
      str(moves.get('i2', {}).get('invoice_date')))
check('uuid-e2e-0002' in (moves.get('i2', {}).get('narration') or ''), 'الفاتورة المُبلَّغة للهيئة موسومة بمعرّفها')
check('INV-0002' in (moves.get('i4', {}).get('narration') or ''), 'الإشعار الدائن يحمل مرجع الفاتورة الأصلية')

receipts = by_fs('fieldsales.receipt', ['payment_method', 'partner_id', 'invoice_ids', 'state', 'amount'])
for fs_id, e in exp['receipts'].items():
    r = receipts.get(fs_id)
    partner_ok = bool(r) and r['partner_id'] and r['partner_id'][0] == partners[e['customer']]['id']
    check(bool(r) and r['payment_method'] == e['method'] and partner_ok, 'السند %s: %s ومرتبط بعميله' % (fs_id, e['method']), str(r))
    if e.get('invoices'):
        want = sorted(moves[i]['id'] for i in e['invoices'])
        check(bool(r) and sorted(r['invoice_ids']) == want, 'السند %s مرتبط بفواتيره' % fs_id, str(r and r['invoice_ids']))

# فواتير يرحّلها المحاسب في Odoo — يجب ألا تمسّها المزامنة بعدها
posted_ids = [moves[f]['id'] for f in exp['postedInOdoo']]
models.execute_kw(DB, uid, 'admin', 'account.move', 'action_post', [posted_ids])
posted = {r['fs_id']: r for r in sr('account.move', [('id', 'in', posted_ids)], ['fs_id', 'amount_total', 'state'])}
posted_total = posted['i2']
check(all(r['state'] == 'posted' for r in posted.values()) and len(posted) == len(posted_ids),
      'ترحيل %d فواتير في Odoo (محاسب)' % len(posted_ids), str(posted))

# الإعداد الموصى به: «تقريب إجمالي» للضريبة (كالمنصة والهيئة) — وإعادة الإرسال تطابق الحساسة للتقريب حرفياً
models.execute_kw(DB, uid, 'admin', 'res.company', 'write', [[company_id], {'tax_calculation_rounding_method': 'round_globally'}])

# ═══ الجولة الثانية: إعادة الإرسال + إلغاءات ═══
print('\n▶ الجولة الثانية')
res2 = {}
for resource in ('customers', 'products', 'invoices', 'receipts'):
    st, body = post(load('round2_' + resource))
    res2[resource] = body
    print('   %s ⇒ %s %s' % (resource, st, {k: body.get(k) for k in ('created', 'updated', 'errors')}))
check(res2['customers'].get('created') == 0 and res2['customers'].get('updated') == 3, 'العملاء: لا تكرار (٣ حُدّثت)', str(res2['customers']))
check(res2['products'].get('created') == 0 and res2['products'].get('updated') == 4, 'المنتجات: لا تكرار حتى المؤرشف (٤ حُدّثت)', str(res2['products']))
inv_err = {e.get('id'): e.get('error') for e in res2['invoices'].get('error_details') or []}
check(res2['invoices'].get('created') == 0 and sorted(inv_err) == exp['round2Errors'],
      'الفواتير: لا تكرار، والخطأ للفرق الحقيقي وحده (تغيّرت بعد ترحيلها، وأُلغيت ولم تُعكس)', str(res2['invoices']))
check('تغيّرت' in (inv_err.get('i2') or '') and 'اعكسها' in (inv_err.get('i9') or ''),
      'رسالتا الخطأ تقولان للمحاسب ماذا يفعل', str(inv_err))
check(res2['invoices'].get('unchanged') == len(exp['round2Unchanged']),
      'إعادة إرسال فاتورة مُرحَّلة لم تتغيّر: «بلا تغيير» لا خطأ', str(res2['invoices']))
check(res2['receipts'].get('created') == 0, 'السندات: لا تكرار', str(res2['receipts']))

moves2 = by_fs('account.move', ['state', 'amount_total', 'amount_tax', 'fs_total_diff', 'fs_tax_diff'])
check(len(moves2) == N_INV, 'عدد الفواتير ما زال %d' % N_INV, str(len(moves2)))
for fs_id in exp['roundingSensitive']:
    e, m = exp['invoices'][fs_id], moves2[fs_id]
    check(abs(m['amount_tax'] - e['tax']) < 0.005 and abs(m['fs_tax_diff']) < 0.005
          and abs(m['amount_total'] - e['total']) < 0.005,
          'بالتقريب الإجمالي: الفاتورة %s ضريبتها %.2f = %.2f حرفياً' % (e['number'], m['amount_tax'], e['tax']), str(m))
check(len(sr('account.tax', [('name', 'ilike', 'Field Sales')], ['id'])) == 1, 'الضريبة الشاملة لم تتكرّر في الجولة الثانية')
check(moves2['i6']['state'] == 'cancel', 'الفاتورة الملغاة في المنصة أُلغيت مسودّتها في Odoo', moves2['i6']['state'])
check(moves2['i2']['state'] == 'posted' and abs(moves2['i2']['amount_total'] - posted_total['amount_total']) < 0.005,
      'الفاتورة المرحّلة بقيت كما هي')
check(abs(moves2['i1']['amount_total'] - exp['invoices']['i1']['total']) < 0.005 and abs(moves2['i1']['fs_total_diff']) < 0.005,
      'إعادة إرسال فاتورة مسودّة تبقي إجماليها مطابقاً')
check(len(by_fs('res.partner', ['id'])) == 3 and len(by_fs('product.template', ['id'])) == 4, 'لا عملاء ولا منتجات مكرّرة')
receipts2 = by_fs('fieldsales.receipt', ['state'])
check(len(receipts2) == 3 and receipts2['r3']['state'] == 'ملغى', 'السند الملغى في المنصة: حالته «ملغى» ولا تكرار', str(receipts2.get('r3')))

# ═══ الجولة الثالثة: المحاسب يعكس الفاتورة الملغاة بإشعار دائن ═══
print('\n▶ الجولة الثالثة')
ctx = {'context': {'active_model': 'account.move', 'active_ids': [moves['i9']['id']]}}
journal_id = sr('account.move', [('id', '=', moves['i9']['id'])], ['journal_id'])[0]['journal_id'][0]
wiz = models.execute_kw(DB, uid, 'admin', 'account.move.reversal', 'create', [{
    'reason': 'ملغاة في Field Sales', 'journal_id': journal_id, 'move_ids': [(6, 0, [moves['i9']['id']])],
}], ctx)
models.execute_kw(DB, uid, 'admin', 'account.move.reversal', 'reverse_moves', [[wiz]], ctx)
refunds = sr('account.move', [('reversed_entry_id', '=', moves['i9']['id'])], ['state'])
drafts = [r['id'] for r in refunds if r['state'] == 'draft']
if drafts:
    models.execute_kw(DB, uid, 'admin', 'account.move', 'action_post', [drafts])
check(len(refunds) == 1, 'المحاسب عكس INV-0009 بإشعار دائن مُرحَّل', str(refunds))
st, body = post(load('round3_invoices'))
print('   invoices ⇒ %s %s' % (st, {k: body.get(k) for k in ('created', 'updated', 'unchanged', 'errors')}))
i9 = sr('account.move', [('id', '=', moves['i9']['id'])], ['state', 'fs_status'])[0]
check(body.get('errors') == 0 and body.get('unchanged') == 1 and i9['state'] == 'posted' and i9['fs_status'] == 'CANCELLED',
      'بعد العكس: لا خطأ، والفاتورة الأصلية باقية مُرحَّلة وموسومة «ملغاة في المنصة»', str((body, i9)))

logs = sr('fieldsales.sync.log', [], ['resource', 'received', 'error_count'])
check(len(logs) >= 9, 'سجلّ المزامنة في Odoo يحفظ كل دفعة', str(len(logs)))

print('\n══ النتيجة: %d نجحت، %d فشلت — Odoo %s ══' % (passes, len(failures), version))
for f in failures:
    print('  ✖', f)
sys.exit(1 if failures else 0)
