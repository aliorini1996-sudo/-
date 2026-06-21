import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

class StorageService {
  static late SharedPreferences _prefs;

  static Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
  }

  static Future<void> saveToken(String token) async => _prefs.setString('token', token);
  static String? getToken() => _prefs.getString('token');

  static Future<void> saveUser(Map<String, dynamic> user) async =>
      _prefs.setString('user', jsonEncode(user));
  static Map<String, dynamic>? getUser() {
    final s = _prefs.getString('user');
    if (s == null) return null;
    return jsonDecode(s) as Map<String, dynamic>;
  }

  static Future<void> clear() async => _prefs.clear();
}
