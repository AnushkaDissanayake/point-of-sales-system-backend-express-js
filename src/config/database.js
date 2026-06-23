const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../pos_database.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT UNIQUE NOT NULL,
      shop_name TEXT,
      address TEXT,
      mobile TEXT,
      shop_logo TEXT,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shop_subscription (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT UNIQUE NOT NULL,
      plan TEXT DEFAULT 'MONTHLY',
      status TEXT DEFAULT 'ACTIVE',
      valid_from TEXT,
      valid_until TEXT,
      offline_grace_days INTEGER DEFAULT 7,
      license_version INTEGER DEFAULT 0,
      license_token TEXT,
      notes TEXT,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS usr_user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      shop_key TEXT,
      role_type TEXT NOT NULL DEFAULT 'USER',
      enabled INTEGER DEFAULT 1,
      is_first_time_login INTEGER DEFAULT 0,
      is_email_verified INTEGER DEFAULT 0,
      must_change_password INTEGER DEFAULT 0,
      failed_attempts INTEGER DEFAULT 0,
      email_verification_code TEXT,
      verification_code TEXT,
      forgot_password_requested INTEGER DEFAULT 0,
      admin_created INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS user_permission (
      user_id INTEGER NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (user_id, permission),
      FOREIGN KEY (user_id) REFERENCES usr_user(id)
    );

    CREATE TABLE IF NOT EXISTS user_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      address TEXT,
      nic TEXT,
      mobile TEXT,
      image BLOB,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES usr_user(id)
    );

    CREATE TABLE IF NOT EXISTS user_token (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expired INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES usr_user(id)
    );

    CREATE TABLE IF NOT EXISTS user_setting (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT,
      last_updated_by INTEGER,
      last_updated_date TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, setting_key),
      FOREIGN KEY (user_id) REFERENCES usr_user(id)
    );

    CREATE TABLE IF NOT EXISTS shop_setting (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT,
      last_updated_by INTEGER,
      last_updated_date TEXT DEFAULT (datetime('now')),
      UNIQUE(shop_key, setting_key),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS category (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      shop_id INTEGER,
      shop_key TEXT,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS vendor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_number TEXT,
      email TEXT,
      address TEXT,
      description TEXT,
      last_arrived_date TEXT,
      next_arrival_date TEXT,
      shop_id INTEGER,
      shop_key TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS vendor_category (
      vendor_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (vendor_id, category_id),
      FOREIGN KEY (vendor_id) REFERENCES vendor(id),
      FOREIGN KEY (category_id) REFERENCES category(id)
    );

    CREATE TABLE IF NOT EXISTS vendor_image (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER UNIQUE NOT NULL,
      image BLOB,
      FOREIGN KEY (vendor_id) REFERENCES vendor(id)
    );

    CREATE TABLE IF NOT EXISTS item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL DEFAULT 0,
      quantity REAL DEFAULT 0,
      buying_price REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      category_id INTEGER,
      vendor_id INTEGER,
      shop_id INTEGER,
      shop_key TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES category(id),
      FOREIGN KEY (vendor_id) REFERENCES vendor(id),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_code_shop ON item(item_code, shop_key) WHERE item_code IS NOT NULL;

    CREATE TABLE IF NOT EXISTS item_image (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER UNIQUE NOT NULL,
      image BLOB,
      FOREIGN KEY (item_id) REFERENCES item(id)
    );

    CREATE TABLE IF NOT EXISTS customer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_number TEXT,
      address TEXT,
      email TEXT,
      description TEXT,
      shop_id INTEGER,
      shop_key TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE TABLE IF NOT EXISTS customer_image (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER UNIQUE NOT NULL,
      image BLOB,
      FOREIGN KEY (customer_id) REFERENCES customer(id)
    );

    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      shop_id INTEGER,
      shop_key TEXT,
      sold_by INTEGER,
      created_by INTEGER,
      updated_by INTEGER,
      status INTEGER DEFAULT 0,
      payment_method TEXT,
      amount_paid REAL DEFAULT 0,
      notes TEXT,
      created_date TEXT DEFAULT (datetime('now')),
      last_updated_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customer(id),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    CREATE INDEX IF NOT EXISTS idx_cart_shop_status ON cart(shop_key, status, last_updated_date);

    CREATE TABLE IF NOT EXISTS cart_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity REAL DEFAULT 0,
      sold_price REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      FOREIGN KEY (cart_id) REFERENCES cart(id),
      FOREIGN KEY (item_id) REFERENCES item(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cart_item_cart ON cart_item(cart_id);
    CREATE INDEX IF NOT EXISTS idx_cart_item_item ON cart_item(item_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT,
      actor_user_id INTEGER,
      actor_username TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      entity_reference TEXT,
      status TEXT DEFAULT 'SUCCESS',
      summary TEXT,
      fail_reason TEXT,
      http_method TEXT,
      request_path TEXT,
      request_details TEXT,
      client_ip TEXT,
      user_agent TEXT,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_key TEXT,
      title TEXT,
      description TEXT,
      type TEXT,
      reference_type TEXT,
      reference_id INTEGER,
      status INTEGER DEFAULT 0,
      user_id INTEGER,
      date_and_time TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shop_key) REFERENCES shop_detail(shop_key)
    );

    -- Performance index: token lookup on every authenticated request
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_token_token ON user_token(token);
    CREATE INDEX IF NOT EXISTS idx_user_token_user ON user_token(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_shop_date ON audit_log(shop_key, created_date);
    CREATE INDEX IF NOT EXISTS idx_cart_shop_status_date ON cart(shop_key, status, last_updated_date);
    CREATE INDEX IF NOT EXISTS idx_notification_shop ON notification(shop_key, status);
  `);

  console.log('Database initialized successfully');
}

module.exports = { getDb, initializeDatabase };
