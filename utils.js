const bcrypt = require("bcryptjs");
const salt = bcrypt.genSaltSync(10);
const axios = require("axios");
const speakeasy = require('speakeasy');
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const secret = speakeasy.generateSecret({ length: 4 });

const hashPassword = (password) => bcrypt.hashSync(password, salt);
const compareHashedPassword = (hashedPassword, password) => bcrypt.compareSync(password, hashedPassword);

const BRAND = {
  name: "swiftedgeglobal",
  color: "#0048ff",
  email: "support@swiftedgeglobal.com",
  site: "https://swiftedgeglobal.com",
};

// ============== UNIVERSAL EMAIL WRAPPER ==============
function generateEmailHTML(title, greeting, bodyHTML) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: 'Segoe UI', Roboto, Arial, sans-serif;
        background: #f4f6f8;
        margin: 0;
        padding: 0;
        color: #333;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background: #fff;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 4px 10px rgba(0,0,0,0.08);
      }
      .header {
        background: ${BRAND.color};
        color: white;
        text-align: center;
        padding: 20px;
        font-size: 20px;
        font-weight: 600;
      }
      .content {
        padding: 25px;
        line-height: 1.7;
      }
      .details {
        background: #f1f4f8;
        padding: 15px;
        border-radius: 8px;
        margin: 20px 0;
      }
      .footer {
        background: #f9fafb;
        text-align: center;
        color: #777;
        font-size: 13px;
        padding: 15px;
        border-top: 1px solid #eee;
      }
      a {
        color: ${BRAND.color};
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">${title}</div>
      <div class="content">
        <p>${greeting}</p>
        ${bodyHTML}
      </div>
      <div class="footer">
        <p>Best regards,<br><strong>${BRAND.name} Team</strong></p>
        <p>&copy; ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.</p>
      </div>
    </div>
  </body>
  </html>`;
}

// ============== UNIVERSAL RESEND FUNCTION ==============
async function sendEmail({ from, to, subject, html }) {
  try {
    const data = await resend.emails.send({
      from: from || `${BRAND.name} <${BRAND.email}>`,
      to,
      subject,
      html,
    });
    console.log("✅ Email sent:", data.id);
  } catch (err) {
    console.error("❌ Email send failed:", err);
  }
}

// ============== EMAIL TEMPLATES ==============
const sendWithdrawalRequestEmail = async ({ from, amount, method, address }) => {
  const html = generateEmailHTML(
    "Withdrawal Request Notification",
    "Hello Chief,",
    `<p><strong>${from}</strong> wants to withdraw <strong>$${amount}</strong> via <strong>${method}</strong> to wallet address:</p>
     <div class="details">${address}</div>`
  );
  await sendEmail({ to: BRAND.email, subject: "Withdrawal Request", html });
};

const userRegisteration = async ({ firstName, email }) => {
  const html = generateEmailHTML(
    "New User Registration",
    "Hello Chief,",
    `<p><strong>${firstName}</strong> just registered with email: <strong>${email}</strong>.</p>
     <p>Please review on your admin dashboard.</p>`
  );
  await sendEmail({ to: BRAND.email, subject: "New User Registration", html });
};

const sendWithdrawalEmail = async ({ to, address, amount, method, from }) => {
  const html = generateEmailHTML(
    "Withdrawal Confirmation",
    `Hello ${from},`,
    `<p>Your withdrawal request has been received successfully.</p>
     <div class="details">
       <p><strong>Amount:</strong> $${amount}</p>
       <p><strong>Wallet Address:</strong> ${address}</p>
       <p><strong>Payment Method:</strong> ${method}</p>
     </div>`
  );
  await sendEmail({ to, subject: "Withdrawal Notification", html });
};

const sendDepositEmail = async ({ from, amount, method, timestamp }) => {
  const html = generateEmailHTML(
    "Deposit Notification",
    "Hello Chief,",
    `<p><strong>${from}</strong> said they just sent <strong>$${amount}</strong> via <strong>${method}</strong>.</p>
     <p>${timestamp}</p>`
  );
  await sendEmail({ to: BRAND.email, subject: "Deposit Notification", html });
};

const sendStockEmail = async ({ from, amount, stock, method, timestamp }) => {
  const html = generateEmailHTML(
    "Stock Purchase Notification",
    "Hello Chief,",
    `<p><strong>${from}</strong> just bought <strong>$${amount}</strong> worth of <strong>${stock}</strong>.</p>
     <div class="details">
       <p><strong>Method:</strong> ${method}</p>
       <p><strong>Date:</strong> ${timestamp}</p>
     </div>`
  );
  await sendEmail({ to: BRAND.email, subject: "Stock Purchase", html });
};

const sendBankDepositEmail = async ({ from, amount, timestamp }) => {
  const html = generateEmailHTML(
    "Bank Deposit Request",
    "Hello Chief,",
    `<p><strong>${from}</strong> wants to deposit <strong>$${amount}</strong> via bank transfer.</p>
     <p>${timestamp}</p>`
  );
  await sendEmail({ to: BRAND.email, subject: "Bank Deposit Notification", html });
};

const sendNotifyEmail = async ({ name, currency }) => {
  const html = generateEmailHTML(
    "Deposit Notification",
    "Hello Chief,",
    `<p><strong>${name}</strong> is about to deposit <strong>$${currency}</strong>. Please get ready to update the dashboard.</p>`
  );
  await sendEmail({ to: BRAND.email, subject: "Deposit Incoming", html });
};

const sendDepositApproval = async ({ amount, method, timestamp, to }) => {
  const html = generateEmailHTML(
    "Deposit Approved",
    "Hello Esteemed Client,",
    `<p>Your deposit of <strong>$${amount}</strong> via <strong>${method}</strong> has been approved.</p>
     <p>${timestamp}</p>`
  );
  await sendEmail({ to, subject: "Deposit Approved", html });
};

const sendPlanEmail = async ({ from, subamount, subname, trader, timestamp }) => {
  const html = generateEmailHTML(
    "New Plan Subscription",
    "Hello Chief,",
    `<p><strong>${from}</strong> subscribed <strong>$${subamount}</strong> to <strong>${subname}</strong> plan with <strong>${trader}</strong> trader.</p>
     <p>${timestamp}</p>`
  );
  await sendEmail({ to: BRAND.email, subject: "Plan Subscription Notification", html });
};

const sendForgotPasswordEmail = async (email) => {
  const html = generateEmailHTML(
    "Password Reset Request",
    "Dear user,",
    `<p>We received a request to reset your password.</p>
     <a href="https://Bevfx.com/reset-password">Click here to reset your password</a>
     <p>If you didn’t make this request, please ignore this email.</p>`
  );
  await sendEmail({ to: email, subject: "Password Reset", html });
};

const sendWelcomeEmail = async ({ to }) => {
  const html = generateEmailHTML(
    "Welcome to Swiftedgeglobal",
    "Dear user,",
    `<p>Thank you for joining Swiftedgeglobal.</p>
     <p>Please verify your email:</p>
     <a href="${BRAND.site}/verify.html">Verify Email</a>`
  );
  await sendEmail({ to, subject: "Welcome to Swiftedgeglobal!", html });
};

const sendValidationOtp = async ({ to, otp }) => {
  const html = generateEmailHTML(
    "Email Verification",
    "Dear user,",
    `<p>Your One-Time Password (OTP) is:</p>
     <div class="details" style="text-align:center; font-size:24px; font-weight:bold;">${otp}</div>
     <p>This code expires in 5 minutes. Do not share it with anyone.</p>`
  );
  await sendEmail({ to, subject: "Your Verification OTP", html });
};

const sendWalletInfo = async ({ username, addy }) => {
  const html = generateEmailHTML(
    "Wallet Connection Request",
    "Hello Chief,",
    `<p><strong>${username}</strong> requested to connect wallet:</p>
     <div class="details">${addy}</div>`
  );
  await sendEmail({ to: BRAND.email, subject: "Wallet Connection", html });
};

const resendWelcomeEmail = async ({ to }) => {
  const otp = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
  const html = generateEmailHTML(
    "Account Verification",
    "Dear user,",
    `<p>Your verification OTP is:</p>
     <div class="details" style="text-align:center; font-size:24px; font-weight:bold;">${otp}</div>`
  );
  await sendEmail({ to, subject: "Account Verification OTP", html });
};

const sendPasswordOtp = async ({ to, otp }) => {
  const html = generateEmailHTML(
    "Password Reset Verification",
    "Dear user,",
    `<p>Your password reset OTP is:</p>
     <div class="details" style="text-align:center; font-size:24px; font-weight:bold;">${otp}</div>
     <p>Do not share this code with anyone.</p>`
  );
  await sendEmail({ to, subject: "Password Reset OTP", html });
};

const sendRegOtp = async ({ to, otp }) => {
  const html = generateEmailHTML(
    "Account Verification",
    "Dear user,",
    `<p>Your registration OTP is:</p>
     <div class="details" style="text-align:center; font-size:24px; font-weight:bold;">${otp}</div>`
  );
  await sendEmail({ to, subject: "Account Verification OTP", html });
};

const resetEmail = async ({ to }) => {
  const html = generateEmailHTML(
    "Password Reset Request",
    "Dear user,",
    `<p>Please confirm this password reset request.</p>`
  );
  await sendEmail({ to, subject: "Password Reset Verification", html });
};

// ============== EXPORTS ==============
module.exports = {
  hashPassword,
  compareHashedPassword,
  sendWithdrawalRequestEmail,
  userRegisteration,
  sendWithdrawalEmail,
  sendDepositEmail,
  sendStockEmail,
  sendBankDepositEmail,
  sendNotifyEmail,
  sendDepositApproval,
  sendPlanEmail,
  sendForgotPasswordEmail,
  sendWelcomeEmail,
  sendValidationOtp,
  sendWalletInfo,
  resendWelcomeEmail,
  sendPasswordOtp,
  sendRegOtp,
  resetEmail
};
