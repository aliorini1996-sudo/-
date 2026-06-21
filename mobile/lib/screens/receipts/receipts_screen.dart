import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../utils/format.dart';
import 'create_receipt_screen.dart';

class ReceiptsScreen extends StatefulWidget {
  const ReceiptsScreen({super.key});

  @override
  State<ReceiptsScreen> createState() => _ReceiptsScreenState();
}

class _ReceiptsScreenState extends State<ReceiptsScreen> {
  List<Map<String, dynamic>> _receipts = [];
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final res = await ApiService.get('/receipts', params: {'limit': '30'});
      setState(() => _receipts = (res['data'] as List).cast<Map<String, dynamic>>());
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  static const _methodLabel = {'CASH': 'نقدي', 'BANK_TRANSFER': 'تحويل', 'POS': 'شبكة', 'CHEQUE': 'شيك'};
  static const _methodColor = {'CASH': Colors.green, 'BANK_TRANSFER': Colors.blue, 'POS': Colors.purple, 'CHEQUE': Colors.orange};

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const CreateReceiptScreen())); _load(); },
        icon: const Icon(Icons.add), label: const Text('سند جديد'),
        backgroundColor: Colors.green,
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _receipts.isEmpty
                ? const Center(child: Text('لا توجد سندات', style: TextStyle(color: Colors.grey)))
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _receipts.length,
                    itemBuilder: (ctx, i) {
                      final r = _receipts[i];
                      final method = r['paymentMethod'] as String;
                      return Card(
                        child: ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          leading: CircleAvatar(
                            backgroundColor: (_methodColor[method] ?? Colors.grey).withOpacity(0.15),
                            child: Icon(Icons.payments, color: _methodColor[method] ?? Colors.grey, size: 20),
                          ),
                          title: Row(children: [
                            Text(r['number'] as String, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: (_methodColor[method] ?? Colors.grey).withOpacity(0.1),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(_methodLabel[method] ?? method, style: TextStyle(fontSize: 11, color: _methodColor[method] ?? Colors.grey)),
                            ),
                          ]),
                          subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text((r['customer'] as Map)['name'] as String),
                            Text(formatDate(r['receiptDate'] as String?), style: const TextStyle(fontSize: 11, color: Colors.grey)),
                          ]),
                          trailing: Text(formatCurrency(r['amount']), style: const TextStyle(color: Colors.green, fontWeight: FontWeight.bold, fontSize: 15)),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
