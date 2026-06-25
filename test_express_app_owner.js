const sqlite3 = require('better-sqlite3');
const http = require('http');

async function req(urlStr, method, body) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  const db = new sqlite3('./pos_database.db');
  
  // Get current email
  const originalUser = db.prepare('SELECT email FROM usr_user WHERE id = 1').get();
  console.log(`Original email in SQLite: ${originalUser.email}`);
  
  // Set to app owner email
  db.prepare("UPDATE usr_user SET email = 'anushka.dmam@gmail.com' WHERE id = 1").run();
  console.log('Updated email to anushka.dmam@gmail.com in SQLite');
  
  try {
    // We need to run Express JS backend to test. But wait, Java is listening on 27182!
    // Since Java is listening on 27182, we can't query Express JS unless we start it on another port or stop Java.
    // Wait! Can we inspect the code of Express JS to verify instead of running it?
    // Actually, we can check if isAppOwner is correct.
  } finally {
    // Restore
    db.prepare('UPDATE usr_user SET email = ? WHERE id = 1').run(originalUser.email);
    console.log('Restored email in SQLite');
  }
}

run();
