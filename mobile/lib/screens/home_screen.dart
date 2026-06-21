import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_service.dart';
import '../services/storage_service.dart';
import '../services/sync_service.dart';
import '../utils/format.dart';
import 'customers/customers_screen.dart';
import 'invoices/invoices_screen.dart';
import 'receipts/receipts_screen.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  int _selectedIndex = 0;
  Map<String, dynamic>? _stats;
  bool _syncing = false;

  final _user = StorageService.getUser();

  @override
  void initState() {
    super.initState();
    ApiService.init();
    _loadStats();
    _syncData();
  }

  Future<void> _loadStats() async {
    try {
      final res = await ApiService.get('/dashboard');
      if (mounted) setState(() => _stats = res['data'] as Map<String, dynamic>?);
    } catch (_) {}
  }

  Future<void> _syncData() async {
    setState(() => _syncing = true);
    try {
      final customersRes = await ApiService.get('/customers', params: {'limit': '200'});
      final customers = (customersRes['data'] as List).cast<Map<String, dynamic>>();
      await LocalDatabase.cacheCustomers(customers);

      final productsRes = await ApiService.get('/products', params: {'limit': '200', 'status': 'ACTIVE'});
      final products = (productsRes['data'] as List).cast<Map<String, dynamic>>();
      await LocalDatabase.cacheProducts(products);
    } catch (_) {}
    if (mounted) setState(() => _syncing = false);
  }

  Widget _buildStatCard(String label, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withOpacity(0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(height: 8),
          Text(value, style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: color)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(fontSize: 12, color: Colors.black54)),
        ],
      ),
    );
  }

  Widget _buildHome() {
    final today = _stats?['today'] as Map<String, dynamic>?;
    final month = _stats?['month'] as Map<String, dynamic>?;

    return RefreshIndicator(
      onRefresh: () async { await _loadStats(); await _syncData(); },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Greeting
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Color(0xFF1E3A8A), Color(0xFF2563EB)]),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('مرحباً،', style: TextStyle(color: Colors.white70, fontSize: 14)),
                        Text(_user?['name'] ?? 'مندوب', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold)),
                        if (_syncing) const Row(children: [
                          SizedBox(width: 12, height: 12, child: CircularProgressIndicator(color: Colors.white70, strokeWidth: 1.5)),
                          SizedBox(width: 6),
                          Text('مزامنة...', style: TextStyle(color: Colors.white70, fontSize: 12)),
                        ]),
                      ],
                    ),
                  ),
                  Container(
                    width: 48, height: 48,
                    decoration: BoxDecoration(color: Colors.white.withOpacity(0.2), shape: BoxShape.circle),
                    child: const Icon(Icons.person, color: Colors.white),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Today Stats
            const Text('إحصائيات اليوم', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF1E3A8A))),
            const SizedBox(height: 12),
            GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: 2,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.4,
              children: [
                _buildStatCard('المبيعات', formatCurrency(today?['salesTotal'] ?? 0), Icons.trending_up, Colors.blue),
                _buildStatCard('التحصيل', formatCurrency(today?['collectionsTotal'] ?? 0), Icons.payments, Colors.green),
                _buildStatCard('الفواتير', '${today?['invoicesCount'] ?? 0}', Icons.receipt_long, Colors.orange),
                _buildStatCard('سندات القبض', '${today?['receiptsCount'] ?? 0}', Icons.credit_card, Colors.purple),
              ],
            ),
            const SizedBox(height: 20),

            // Quick Actions
            const Text('الإجراءات السريعة', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF1E3A8A))),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(child: _quickAction('فاتورة جديدة', Icons.add_box, Colors.blue, () {
                  setState(() => _selectedIndex = 1);
                })),
                const SizedBox(width: 12),
                Expanded(child: _quickAction('سند قبض', Icons.payment, Colors.green, () {
                  setState(() => _selectedIndex = 2);
                })),
                const SizedBox(width: 12),
                Expanded(child: _quickAction('البحث', Icons.search, Colors.orange, () {
                  setState(() => _selectedIndex = 3);
                })),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _quickAction(String label, IconData icon, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          color: color.withOpacity(0.1),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withOpacity(0.2)),
        ),
        child: Column(
          children: [
            Icon(icon, color: color, size: 28),
            const SizedBox(height: 6),
            Text(label, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  final _pages = [null, null, null, null]; // lazy init

  @override
  Widget build(BuildContext context) {
    final pages = [
      _buildHome(),
      const InvoicesScreen(),
      const ReceiptsScreen(),
      const CustomersScreen(),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('نظام المبيعات الميداني'),
        actions: [
          IconButton(
            icon: const Icon(Icons.sync),
            onPressed: _syncData,
            tooltip: 'مزامنة',
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await StorageService.clear();
              if (mounted) Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const Scaffold(body: Center(child: Text('تسجيل الخروج...')))));
            },
          ),
        ],
      ),
      body: pages[_selectedIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (i) => setState(() => _selectedIndex = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'الرئيسية'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'الفواتير'),
          NavigationDestination(icon: Icon(Icons.payments_outlined), selectedIcon: Icon(Icons.payments), label: 'التحصيل'),
          NavigationDestination(icon: Icon(Icons.people_outline), selectedIcon: Icon(Icons.people), label: 'العملاء'),
        ],
      ),
    );
  }
}
