// Matches Spring Boot PendingOtpService behavior
const emailOtpStore = new Map();       // key -> { code, expiresAt, attempts }
const subscriptionOtpStore = new Map(); // shopKey -> { code, expiresAt, attempts }
const otpCooldowns = new Map();         // key -> lastRequestTime

const EMAIL_OTP_TTL = 30 * 60 * 1000;           // 30 minutes
const SUBSCRIPTION_OTP_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOLDOWN_TTL = 5 * 60 * 1000;             // 5 minutes
const MAX_ATTEMPTS = 3;

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- Email OTP ---

function setEmailOtp(email, code) {
  emailOtpStore.set(email, { code, expiresAt: Date.now() + EMAIL_OTP_TTL, attempts: 0 });
}

function verifyEmailOtp(email, code) {
  const entry = emailOtpStore.get(email);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { emailOtpStore.delete(email); return false; }
  return entry.code === code;
}

function clearEmailOtp(email) {
  emailOtpStore.delete(email);
}

// --- Subscription OTP (with max attempts + auto-rotation) ---

function setSubscriptionOtp(shopKey, code, plan) {
  subscriptionOtpStore.set(shopKey, { code, plan: plan || null, expiresAt: Date.now() + SUBSCRIPTION_OTP_TTL, attempts: 0 });
}

// Returns: 'valid:<plan>' | 'invalid' | 'expired' | 'rotated:<newCode>:<plan>'
// plan is the plan stored with the OTP (matches Spring Boot SubscriptionVerifyResult.plan())
function verifySubscriptionOtp(shopKey, code) {
  const entry = subscriptionOtpStore.get(shopKey);
  if (!entry) return 'invalid';
  if (Date.now() > entry.expiresAt) { subscriptionOtpStore.delete(shopKey); return 'expired'; }
  if (entry.code === code) { return 'valid:' + (entry.plan || 'MONTHLY'); }

  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    // Auto-rotate: generate new code, carry over plan
    const newCode = generateOtp();
    subscriptionOtpStore.set(shopKey, { code: newCode, plan: entry.plan, expiresAt: Date.now() + SUBSCRIPTION_OTP_TTL, attempts: 0 });
    return 'rotated:' + newCode + ':' + (entry.plan || 'MONTHLY');
  }
  return 'invalid';
}

function clearSubscriptionOtp(shopKey) {
  subscriptionOtpStore.delete(shopKey);
}

function getSubscriptionOtp(shopKey) {
  return subscriptionOtpStore.get(shopKey) || null;
}

// Matches Spring Boot PendingOtpService.hasActiveSubscriptionActivationCodes()
function hasActiveSubscriptionActivationCodes(shopKey) {
  const entry = subscriptionOtpStore.get(shopKey);
  return !!(entry && Date.now() <= entry.expiresAt);
}

// --- Cooldown ---

function isOnCooldown(key) {
  const last = otpCooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_TTL;
}

function setCooldown(key) {
  otpCooldowns.set(key, Date.now());
}

module.exports = {
  generateOtp,
  setEmailOtp, verifyEmailOtp, clearEmailOtp,
  setSubscriptionOtp, verifySubscriptionOtp, clearSubscriptionOtp, getSubscriptionOtp,
  hasActiveSubscriptionActivationCodes,
  isOnCooldown, setCooldown,
  MAX_ATTEMPTS
};
