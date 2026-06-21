import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../utils/format.dart';

class CreateReceiptScreen extends StatefulWidget {
  final Map<String, dynamic>? customer;
  const CreateReceiptScreen({super.key, this.customer});

  @override
  State<CreateReceiptScreen> createState() => _CreateReceiptScreenState();
}

class _CreateReceiptScreenState extends State<CreateReceiptScreen> {
  Map<String, dynamic>? _customer;
  final _amountCtrl = TextEditingController();
  String _paymentMethod = 'CASH';
  final _notesCtrl = TextEditingController();
  final _chequeCtrl = TextEditingController();
  bool _loading = false;

  @override
  void initState() { super.initState(); _customer = widget.customer; }

  Future<void> _submit() async {
    if (_customer == null) { _err('اختر العميل'); return; }
    final amount = double.tryParse(_amountCtrl.text);
    if (amount == null || amount <= 0) { _err('أدخل مبلغاً صحيحاً'); return; }

    setState(() => _loading = true);
    try {
      await ApiService.post('/receipts', {
        'customerId': _customer!['id'],
        'amount': amount,
        'paymentMethod': _paymentMethod,
        if (_chequeCtrl.text.isNotEmpty) 'chequeNumber': _chequeCtrl.text,
        if (_notesCtrl.text.isNotEmpty) 'notes': _notesCtrl.text,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم إصدار السند'), backgroundColor: Colors.green));
        Navigator.pop(context);
      }
    } catch (_) { _err('خطأ في إصدار السند'); }
    if (mounted) setState(() => _loading = false);
  }

  void _err(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: Colors.red));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('إصدار سند قبض')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Customer
            if (_customer != null)
              Card(
                color: Colors.green.shade50,
                child: ListTile(
                  leading: const Icon(Icons.person, color: Colors.green),
                  title: Text(_customer!['name'] as String, style: const TextStyle(fontWeight: FontWeight.bold)),
                  subtitle: Text('رصيد: ${formatCurrency(_customer!['balance'])}'),
                ),
              )
            else
              OutlinedButton.icon(
                onPressed: () {},
                icon: const Icon(Icons.person_search),
                label: const Text('اختر العميل'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(double.infinity, 48)),
              ),
            const SizedBox(height: 16),

            TextField(
              controller: _amountCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'المبلغ المحصل *', prefixIcon: Icon(Icons.payments), prefixText: 'ر.س '),
            ),
            const SizedBox(height: 16),

            const Text('طريقة الدفع:', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'].map((m) {
                final labels = {'CASH': 'نقدي', 'BANK_TRANSFER': 'تحويل بنكي', 'POS': 'شبكة', 'CHEQUE': 'شيك'};
                return ChoiceChip(
                  label: Text(labels[m]!),
                  selected: _paymentMethod == m,
                  onSelected: (_) => setState(() => _paymentMethod = m),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),

            if (_paymentMethod == 'CHEQUE') ...[
              TextField(controller: _chequeCtrl, decoration: const InputDecoration(labelText: 'رقم الشيك')),
              const SizedBox(height: 12),
            ],

            TextField(controller: _notesCtrl, decoration: const InputDecoration(labelText: 'ملاحظات'), maxLines: 2),
            const SizedBox(height: 24),

            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: Colors.green, minimumSize: const Size(double.infinity, 52)),
              onPressed: _loading ? null : _submit,
              child: _loading
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                  : const Text('إصدار السند', style: TextStyle(fontSize: 16)),
            ),
          ],
        ),
      ),
    );
  }
}
