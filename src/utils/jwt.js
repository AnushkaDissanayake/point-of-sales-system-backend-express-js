const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'pos-secret-key-change-in-production';
const JWT_EXPIRATION = parseInt(process.env.JWT_EXPIRATION || '600000000');

function generateToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, {
    expiresIn: Math.floor(JWT_EXPIRATION / 1000)
  });
}

function validateToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function getUsernameFromToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.sub;
  } catch {
    return null;
  }
}

module.exports = { generateToken, validateToken, getUsernameFromToken };
