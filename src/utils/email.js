const nodemailer = require('nodemailer');
const templates = require('./emailTemplates');
require('dotenv').config();

let transporter = null;

function getTransporter() {
  if (!transporter && process.env.MAIL_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.MAIL_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
      }
    });
  }
  return transporter;
}

async function sendEmail(to, subject, html) {
  const t = getTransporter();
  if (!t) {
    console.log(`[EMAIL SKIPPED - no MAIL_USER configured] To: ${to}, Subject: ${subject}`);
    return;
  }
  try {
    await t.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'CodeWiz POS'}" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
      to,
      subject,
      html
    });
    console.log(`[EMAIL SENT] To: ${to}, Subject: ${subject}`);
  } catch (err) {
    console.error(`[EMAIL ERROR] To: ${to}`, err.message);
  }
}

// OTP verification email sent to registering user
async function sendVerificationEmail(email, recipientName, code) {
  const html = templates.otpVerification(recipientName, code, 'verify your email address');
  await sendEmail(email, 'Verify your email', html);
}

// Password reset OTP
async function sendPasswordResetEmail(email, recipientName, code) {
  const html = templates.passwordReset(recipientName, code);
  await sendEmail(email, 'Password reset code', html);
}

// Invited user credentials
async function sendInvitationEmail(email, recipientName, username, tempPassword) {
  const html = templates.accountCredentials(recipientName, username, tempPassword);
  await sendEmail(email, 'Your account credentials', html);
}

// Notify app owner when a new ADMIN/shop registers
async function sendShopRegistrationToAppOwner(shopKey, ownerName, ownerEmail, username, registeredAt) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || 'anushka.dmam@gmail.com';
  const html = templates.shopRegistrationNotification(shopKey, ownerName, ownerEmail, username, registeredAt);
  await sendEmail(appOwnerEmail, 'New shop registration', html);
}

// Notify shop admin when a new USER registers under their shop
async function sendStaffRegistrationToAdmin(adminEmail, adminName, registrantSummary) {
  const html = templates.staffRegistrationNotification(adminName, registrantSummary);
  await sendEmail(adminEmail, 'New user registered', html);
}

// Subscription OTP to app owner
async function sendSubscriptionOtpToAppOwner(shopKey, planLabel, code, requesterSummary) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || 'anushka.dmam@gmail.com';
  const html = templates.subscriptionActivationOtp(shopKey, planLabel, code, requesterSummary);
  await sendEmail(appOwnerEmail, `Subscription activation requested — shop ${shopKey} (${planLabel})`, html);
}

async function sendSubscriptionRotatedToAppOwner(shopKey, planLabel, newCode, requesterSummary) {
  const appOwnerEmail = process.env.APP_OWNER_EMAIL || 'anushka.dmam@gmail.com';
  const html = templates.subscriptionActivationRotated(shopKey, planLabel, newCode);
  await sendEmail(appOwnerEmail, `New subscription activation code — shop ${shopKey}`, html);
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInvitationEmail,
  sendShopRegistrationToAppOwner,
  sendStaffRegistrationToAdmin,
  sendSubscriptionOtpToAppOwner,
  sendSubscriptionRotatedToAppOwner
};
