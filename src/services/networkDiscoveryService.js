const os = require('os');
const dgram = require('dgram');
const { getDb } = require('../config/database');

const DISCOVERY_PORT = 27188;
const DISCOVER_REQUEST_MSG = 'DISCOVER_AD_SMARTPOS_REQUEST';

let udpSocket = null;
let mdnsInstances = [];

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function getIPPrefix(ip) {
  const lastDot = ip.lastIndexOf('.');
  return lastDot > 0 ? ip.substring(0, lastDot) : ip;
}

function selectBestIp(clientIp, serverIps) {
  const clientPrefix = getIPPrefix(clientIp);
  for (const ip of serverIps) {
    if (getIPPrefix(ip) === clientPrefix) {
      return ip;
    }
  }
  return serverIps.length > 0 ? serverIps[0] : '127.0.0.1';
}

function getShopName() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT shop_name FROM shop_detail LIMIT 1').get();
    if (row && row.shop_name) {
      return row.shop_name;
    }
  } catch (err) {
    // Ignore db errors
  }
  return 'AD SmartPOS Server';
}

function startDiscovery(serverPort) {
  const localIps = getLocalIps();

  // 1. Start mDNS Responder for adsmartpos.local on each active IP interface
  mdnsInstances = localIps.map((ip) => {
    try {
      const mdns = require('multicast-dns')({ interface: ip });
      
      mdns.on('query', (query) => {
        const questions = query.questions || [];
        const hasMatch = questions.some(
          (q) => q.name === 'adsmartpos.local' && (q.type === 'A' || q.type === 'ANY')
        );

        if (hasMatch) {
          mdns.respond({
            answers: [
              {
                name: 'adsmartpos.local',
                type: 'A',
                ttl: 120,
                data: ip,
              }
            ],
          });
        }
      });

      mdns.on('error', (err) => {
        console.error(`mDNS error on interface ${ip}:`, err);
      });

      return mdns;
    } catch (err) {
      console.error(`Failed to start mDNS responder on interface ${ip}:`, err);
      return null;
    }
  }).filter(Boolean);

  // 2. Start UDP Broadcast Listener
  udpSocket = dgram.createSocket('udp4');

  udpSocket.on('message', (msg, rinfo) => {
    const requestData = msg.toString('utf8').trim();
    if (requestData.startsWith(DISCOVER_REQUEST_MSG)) {
      const serverIps = getLocalIps();
      const bestIp = selectBestIp(rinfo.address, serverIps);
      const shopName = getShopName();

      const jsonResponse = JSON.stringify({
        serverIp: bestIp,
        port: serverPort,
        name: shopName,
      });

      const responseBytes = Buffer.from(jsonResponse, 'utf8');
      udpSocket.send(responseBytes, 0, responseBytes.length, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error('Error sending UDP discovery response:', err);
        }
      });
    }
  });

  udpSocket.on('error', (err) => {
    console.error('UDP discovery socket error:', err);
  });

  udpSocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    udpSocket.setBroadcast(true);
    console.log(`UDP Discovery listener started on port ${DISCOVERY_PORT}`);
  });
}

function stopDiscovery() {
  if (mdnsInstances && mdnsInstances.length > 0) {
    for (const mdns of mdnsInstances) {
      try {
        mdns.destroy();
      } catch (e) {
        // Ignore
      }
    }
    mdnsInstances = [];
  }
  if (udpSocket) {
    try {
      udpSocket.close();
    } catch (e) {
      // Ignore
    }
  }
}

module.exports = {
  startDiscovery,
  stopDiscovery,
};
