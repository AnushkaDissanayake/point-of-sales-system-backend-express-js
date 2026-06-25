const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./pos_database.db');

console.log('--- USERS ---');
const users = db.prepare('SELECT id, user_name, email, role_type, shop_key, is_first_time_login, enabled FROM usr_user').all();
console.log(JSON.stringify(users, null, 2));

console.log('--- SUBSCRIPTIONS ---');
const subs = db.prepare('SELECT * FROM shop_subscription').all();
console.log(JSON.stringify(subs, null, 2));
