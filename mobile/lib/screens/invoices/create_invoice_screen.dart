import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../services/sync_service.dart';
import '../../utils/format.dart';

class InvoiceLineItem {
  final String productId;
  final String name;
  final String unit;
  double qty;
  double unitPrice;
  double discountPct;
  double taxPct;
  InvoiceLineItem({required this.productId, required this.name, required this.unit,
    this.qty = 1, required this.unitPrice, this.discountPct = 0, this.taxPct = 15});

  double get lineTotal {
    final base = qty * unitPrice;
    final afterDisc = base * (1 - discountPct / 100);
    return afterDisc * (1 + taxPct / 100);
  }
}

class CreateInvoiceScreen extends StatefulWidget {
  final Map<String, dynamic>? customer;
  const CreateInvoiceScreen({super.key, this.customer});

  @override
  State<CreateInvoiceScreen> createState() => _CreateInvoiceScreenState();
}

class _CreateInvoiceScreenState extends State<CreateInvoiceScreen> {
  Map<String, dynamic>? _customer;
  String _type = 'CREDIT';
  List<InvoiceLineItem> _lines = [];
  double _globalDiscountPct = 0;
  bool _loading = false;
  final _productSearchCtrl = TextEditingController();
  List<Map<String, dynamic>> _productResults = [];

  @override
  void initState() {
    super.initState();
    _customer = widget.customer;
  }

  Future<void> _searchProduct(String q) async {
    if (q.isEmpty) { setState(() => _productResults = []); return; }
    try {
      final res = await ApiService.get('/products', params: {'search': q, 'status': 'ACTIVE', 'limit': '10'});
      setState(() => _productResults = (res['data'] as List).cast<Map<String, dynamic>>());
    } catch (_) {
      final local = await LocalDatabase.searchProducts(q);
      setState(() => _productResults = local);
    }
  }

  void _addProduct(Map<String, dynamic> p) {
    final existing = _lines.indexWhere((l) => l.productId == p['id']);
    if (existing >= 0) {
      setState(() => _lines[existing].qty++);
    } else {
      setState(() => _lines.add(InvoiceLineItem(
        productId: p['id'] as String,
        name: p['name'] as String,
        unit: p['unit'] as String,
        unitPrice: (p['basePrice'] as num).toDouble(),
        taxPct: (p['taxPct'] as num?)?.toDouble() ?? 15,
      )));
    }
    _productSearchCtrl.clear();
    setState(() => _productResults = []);
  }

  double get _subtotal => _lines.fold(0, (s, l) => s + l.qty * l.unitPrice);
  double get _taxTotal => _lines.fold(0, (s, l) => s + l.qty * l.unitPrice * (1 - l.discountPct / 100) * l.taxPct / 100);
  double get _discountTotal => _lines.fold(0, (s, l) => s + l.qty * l.unitPrice * l.discountPct / 100) + _subtotal * _globalDiscountPct / 100;
  double get _total => (_subtotal - _discountTotal + _taxTotal).clamp(0, double.infinity);

  Future<void> _submit() async {
    if (_customer == null) { _showError('اختر العميل أولاً'); return; }
    if (_lines.isEmpty) { _showError('أضف صنفاً على الأقل'); return; }
    setState(() => _loading = true);
    try {
      await ApiService.post('/invoices', {
        'customerId': _customer!['id'],
        'type': _type,
        'discountPct': _globalDiscountPct,
        'items': _lines.map((l) => {
          'productId': l.productId, 'qty': l.qty, 'unitPrice': l.unitPrice,
          'discountPct': l.discountPct, 'taxPct': l.taxPct,
        }).toList(),
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم إنشاء الفاتورة'), backgroundColor: Colors.green));
        Navigator.pop(context);
      }
    } catch (e) { _showError('خطأ في إنشاء الفاتورة'); }
    if (mounted) setState(() => _loading = false);
  }

  void _showError(String msg) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: Colors.red));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('فاتورة جديدة')),
      body: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Customer
                  if (_customer != null)
                    Card(
                      color: Colors.blue.shade50,
                      child: ListTile(
                        leading: const Icon(Icons.person, color: Color(0xFF2563EB)),
                        title: Text(_customer!['name'] as String, style: const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle: Text(_customer!['phone'] as String),
                        trailing: TextButton(onPressed: () => setState(() => _customer = null), child: const Text('تغيير')),
                      ),
                    )
                  else
                    OutlinedButton.icon(
                      onPressed: () {},
                      icon: const Icon(Icons.person_search),
                      label: const Text('اختر العميل'),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(double.infinity, 48)),
                    ),
                  const SizedBox(height: 12),

                  // Type
                  Row(children: [
                    const Text('نوع الفاتورة: ', style: TextStyle(fontWeight: FontWeight.w600)),
                    ChoiceChip(label: const Text('آجل'), selected: _type == 'CREDIT', onSelected: (_) => setState(() => _type = 'CREDIT')),
                    const SizedBox(width: 8),
                    ChoiceChip(label: const Text('نقدي'), selected: _type == 'CASH', onSelected: (_) => setState(() => _type = 'CASH')),
                  ]),
                  const SizedBox(height: 12),

                  // Product Search
                  TextField(
                    controller: _productSearchCtrl,
                    onChanged: _searchProduct,
                    decoration: const InputDecoration(hintText: 'ابحث عن صنف...', prefixIcon: Icon(Icons.search), isDense: true),
                  ),
                  if (_productResults.isNotEmpty)
                    Container(
                      decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade200), borderRadius: BorderRadius.circular(8)),
                      child: Column(
                        children: _productResults.map((p) => ListTile(
                          dense: true,
                          title: Text(p['name'] as String),
                          subtitle: Text('${p['code']} • ${formatCurrency(p['basePrice'])}'),
                          onTap: () => _addProduct(p),
                        )).toList(),
                      ),
                    ),
                  const SizedBox(height: 12),

                  // Lines
                  ..._lines.asMap().entries.map((entry) {
                    final i = entry.key;
                    final l = entry.value;
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(child: Text(l.name, style: const TextStyle(fontWeight: FontWeight.bold))),
                                IconButton(icon: const Icon(Icons.delete_outline, color: Colors.red, size: 20), onPressed: () => setState(() => _lines.removeAt(i))),
                              ],
                            ),
                            Row(children: [
                              Expanded(child: Column(children: [
                                const Text('الكمية', style: TextStyle(fontSize: 11, color: Colors.grey)),
                                TextField(
                                  keyboardType: TextInputType.number,
                                  controller: TextEditingController(text: l.qty.toString()),
                                  onChanged: (v) => setState(() => l.qty = double.tryParse(v) ?? 1),
                                  decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                                  textAlign: TextAlign.center,
                                ),
                              ])),
                              const SizedBox(width: 8),
                              Expanded(child: Column(children: [
                                const Text('السعر', style: TextStyle(fontSize: 11, color: Colors.grey)),
                                TextField(
                                  keyboardType: TextInputType.number,
                                  controller: TextEditingController(text: l.unitPrice.toString()),
                                  onChanged: (v) => setState(() => l.unitPrice = double.tryParse(v) ?? 0),
                                  decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                                  textAlign: TextAlign.center,
                                ),
                              ])),
                              const SizedBox(width: 8),
                              Expanded(child: Column(children: [
                                const Text('خصم%', style: TextStyle(fontSize: 11, color: Colors.grey)),
                                TextField(
                                  keyboardType: TextInputType.number,
                                  controller: TextEditingController(text: l.discountPct.toString()),
                                  onChanged: (v) => setState(() => l.discountPct = double.tryParse(v) ?? 0),
                                  decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                                  textAlign: TextAlign.center,
                                ),
                              ])),
                            ]),
                            const SizedBox(height: 4),
                            Text('الإجمالي: ${formatCurrency(l.lineTotal)}', style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF2563EB))),
                          ],
                        ),
                      ),
                    );
                  }),

                  if (_lines.isNotEmpty) ...[
                    const Divider(),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      const Text('خصم عام %:'),
                      SizedBox(width: 80, child: TextField(
                        keyboardType: TextInputType.number,
                        onChanged: (v) => setState(() => _globalDiscountPct = double.tryParse(v) ?? 0),
                        decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                        textAlign: TextAlign.center,
                      )),
                    ]),
                    const SizedBox(height: 8),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      const Text('قبل الخصم:'), Text(formatCurrency(_subtotal)),
                    ]),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      const Text('الخصم:', style: TextStyle(color: Colors.red)), Text('- ${formatCurrency(_discountTotal)}', style: const TextStyle(color: Colors.red)),
                    ]),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      const Text('الضريبة:', style: TextStyle(color: Colors.blue)), Text(formatCurrency(_taxTotal), style: const TextStyle(color: Colors.blue)),
                    ]),
                    const Divider(),
                    Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                      const Text('الإجمالي النهائي:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      Text(formatCurrency(_total), style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF1E3A8A))),
                    ]),
                  ],
                ],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _loading ? null : _submit,
                  child: _loading
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                      : const Text('إصدار الفاتورة', style: TextStyle(fontSize: 16)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
