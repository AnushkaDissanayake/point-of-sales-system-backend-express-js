const BRAND = 'CodeWiz POS';
const ACCENT = '#198754';

function escape(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function otpBlock(code) {
  return `
    <div style="text-align:center;padding:24px 16px;background:#ecfdf5;border:1px dashed ${ACCENT};border-radius:12px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#047857;margin-bottom:8px;">Verification code</div>
      <div style="font-size:32px;font-weight:700;letter-spacing:0.35em;color:#065f46;">${escape(code)}</div>
    </div>`;
}

function layout(headline, innerHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escape(headline)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
          <tr>
            <td style="padding:28px 32px 16px;background:linear-gradient(135deg,#065f46 0%,#198754 100%);color:#ffffff;">
              <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">${BRAND}</div>
              <div style="font-size:24px;font-weight:700;margin-top:8px;">${escape(headline)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 12px;">${innerHtml}</td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <div style="height:1px;background:#e2e8f0;"></div>
              <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">This is an automated message from ${BRAND}. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function otpVerification(recipientName, code, purpose) {
  const greeting = recipientName ? `Hello ${escape(recipientName)},` : 'Hello,';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${greeting}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">Use the verification code below to ${escape(purpose)}.</p>
    ${otpBlock(code)}
    <p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#64748b;">This code expires soon. If you did not request it, you can safely ignore this email.</p>`;
  return layout('Verification code', body);
}

function passwordReset(recipientName, code) {
  const greeting = recipientName ? `Hello ${escape(recipientName)},` : 'Hello,';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${greeting}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">We received a request to reset your password. Enter this code to continue:</p>
    ${otpBlock(code)}
    <p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#64748b;">If you did not request a password reset, you can ignore this email.</p>`;
  return layout('Password reset', body);
}

function accountCredentials(recipientName, username, tempPassword) {
  const greeting = recipientName ? `Hello ${escape(recipientName)},` : 'Hello,';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${greeting}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">An administrator created an account for you. Sign in with the temporary credentials below, then choose your own username and password.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:420px;margin:0 0 20px;border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
      <tr>
        <td style="padding:14px 16px;font-size:13px;color:#64748b;width:38%;">Username</td>
        <td style="padding:14px 16px;font-size:15px;font-weight:600;color:#0f172a;">${escape(username)}</td>
      </tr>
      <tr>
        <td style="padding:14px 16px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0;">Temporary password</td>
        <td style="padding:14px 16px;font-size:15px;font-weight:600;color:#0f172a;border-top:1px solid #e2e8f0;">${escape(tempPassword)}</td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">For security, change your password immediately after signing in.</p>`;
  return layout('Your account credentials', body);
}

function shopRegistrationNotification(shopKey, ownerName, ownerEmail, username, registeredAt) {
  const details = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 0 20px;border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:13px;color:#64748b;width:38%;">Shop ID</td><td style="padding:12px 16px;font-size:15px;font-weight:600;color:#0f172a;">${escape(shopKey)}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0;">Owner</td><td style="padding:12px 16px;font-size:14px;color:#0f172a;border-top:1px solid #e2e8f0;">${escape(ownerName)}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0;">Email</td><td style="padding:12px 16px;font-size:14px;color:#0f172a;border-top:1px solid #e2e8f0;">${escape(ownerEmail)}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0;">Username</td><td style="padding:12px 16px;font-size:14px;color:#0f172a;border-top:1px solid #e2e8f0;">${escape(username)}</td></tr>
      <tr><td style="padding:12px 16px;font-size:13px;color:#64748b;border-top:1px solid #e2e8f0;">Registered</td><td style="padding:12px 16px;font-size:14px;color:#0f172a;border-top:1px solid #e2e8f0;">${escape(registeredAt)}</td></tr>
    </table>`;
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">A new shop has registered on ${BRAND}.</p>
    ${details}
    <p style="margin:0;font-size:15px;line-height:1.6;color:#334155;">After they verify email and sign in, they will choose a subscription plan and request a <strong>single activation code</strong> from the subscription screen. You will receive that code by email — share it only if you approve their plan.</p>`;
  return layout('New shop registration', body);
}

function staffRegistrationNotification(adminName, registrantSummary) {
  const greeting = adminName ? `Hello ${escape(adminName)},` : 'Hello,';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${greeting}</p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#334155;">A new user registered for your shop:</p>
    <p style="margin:0 0 20px;padding:12px 16px;background:#f8fafc;border-radius:8px;font-size:14px;color:#475569;">${escape(registrantSummary)}</p>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#334155;">They can sign in after verifying their email. No separate approval code is required.</p>`;
  return layout('New user registered', body);
}

function subscriptionActivationOtp(shopKey, planLabel, code, recipientRole) {
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">Subscription activation for <strong>${escape(planLabel)}</strong> plan.</p>
    <p style="margin:0 0 20px;padding:12px 16px;background:#f8fafc;border-radius:8px;font-size:14px;color:#475569;">
      Shop ID: <strong>${escape(shopKey)}</strong><br/>
      Plan requested: <strong>${escape(planLabel)}</strong><br/>
      Contact: <strong>${escape(recipientRole)}</strong>
    </p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#334155;">Share this code with the shop only if you approve this plan:</p>
    ${otpBlock(code)}
    <p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#64748b;">Valid for a limited time. After three wrong attempts a new code must be requested.</p>`;
  return layout('Subscription activation code', body);
}

function subscriptionActivationRotated(shopKey, planLabel, newCode) {
  const body = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">Subscription activation was locked after too many failed attempts for shop <strong>${escape(shopKey)}</strong>.</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">New <strong>${escape(planLabel)}</strong> activation code:</p>
    ${otpBlock(newCode)}`;
  return layout('New subscription activation code', body);
}

module.exports = {
  otpVerification,
  passwordReset,
  accountCredentials,
  shopRegistrationNotification,
  staffRegistrationNotification,
  subscriptionActivationOtp,
  subscriptionActivationRotated
};
