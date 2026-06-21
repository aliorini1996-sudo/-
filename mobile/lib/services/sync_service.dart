import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';

class LocalDatabase {
  static Database? _db;

  static Future<void> init() async {
    final path = join(await getDatabasesPath(), 'dsd_local.db');
    _db = await openDatabase(
      path,
      version: 1,
      onCreate: _onCreate,
    );
  }

  static Database get db {
    if (_db == null) throw Exception('Database not initialized');
    return _db!;
  }

  static Future<void> _onCreate(Database db, int version) async {
    await db.execute('''
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        businessName TEXT,
        phone TEXT NOT NULL,
        city TEXT,
        balance REAL DEFAULT 0,
        creditLimit REAL DEFAULT 0,
        paymentDays INTEGER DEFAULT 30,
        status TEXT DEFAULT 'ACTIVE',
        syncedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        unit TEXT,
        basePrice REAL,
        taxPct REAL DEFAULT 15,
        status TEXT DEFAULT 'ACTIVE',
        syncedAt TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE pending_invoices (
        localId TEXT PRIMARY KEY,
        customerId TEXT,
        type TEXT,
        discountPct REAL DEFAULT 0,
        notes TEXT,
        items TEXT,
        createdAt TEXT,
        synced INTEGER DEFAULT 0,
        serverResponse TEXT
      )
    ''');

    await db.execute('''
      CREATE TABLE pending_receipts (
        localId TEXT PRIMARY KEY,
        customerId TEXT,
        amount REAL,
        paymentMethod TEXT,
        notes TEXT,
        createdAt TEXT,
        synced INTEGER DEFAULT 0
      )
    ''');

    await db.execute('''
      CREATE TABLE sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        attempts INTEGER DEFAULT 0
      )
    ''');
  }

  static Future<void> cacheCustomers(List<Map<String, dynamic>> customers) async {
    final batch = db.batch();
    for (final c in customers) {
      batch.insert('customers', {
        'id': c['id'], 'code': c['code'], 'name': c['name'],
        'businessName': c['businessName'], 'phone': c['phone'],
        'city': c['city'], 'balance': c['balance'], 'creditLimit': c['creditLimit'],
        'paymentDays': c['paymentDays'], 'status': c['status'],
        'syncedAt': DateTime.now().toIso8601String(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  static Future<void> cacheProducts(List<Map<String, dynamic>> products) async {
    final batch = db.batch();
    for (final p in products) {
      batch.insert('products', {
        'id': p['id'], 'code': p['code'], 'name': p['name'],
        'unit': p['unit'], 'basePrice': p['basePrice'], 'taxPct': p['taxPct'],
        'status': p['status'], 'syncedAt': DateTime.now().toIso8601String(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  static Future<List<Map<String, dynamic>>> searchCustomers(String query) async {
    return db.query(
      'customers',
      where: "name LIKE ? OR phone LIKE ? OR code LIKE ?",
      whereArgs: ['%$query%', '%$query%', '%$query%'],
      limit: 20,
    );
  }

  static Future<List<Map<String, dynamic>>> searchProducts(String query) async {
    return db.query(
      'products',
      where: "(name LIKE ? OR code LIKE ?) AND status = 'ACTIVE'",
      whereArgs: ['%$query%', '%$query%'],
      limit: 30,
    );
  }

  static Future<void> addToSyncQueue(String type, Map<String, dynamic> payload) async {
    await db.insert('sync_queue', {
      'type': type,
      'payload': jsonEncode(payload),
      'createdAt': DateTime.now().toIso8601String(),
    });
  }
}
