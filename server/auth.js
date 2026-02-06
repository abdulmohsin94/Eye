const crypto = require("crypto");

const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Secret derived from the password itself (no external config needed)
function getSecret() {
  const password = process.env.EYE_PASSWORD || "eye-admin";
  return crypto.createHash("sha256").update("eye-secret:" + password).digest();
}

function getPassword() {
  return process.env.EYE_PASSWORD || "eye-admin";
}

// Generate a self-contained signed token: expiry.signature
// Any serverless instance can verify it without shared state.
function generateToken() {
  const expiry = Date.now() + TOKEN_TTL;
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(String(expiry))
    .digest("hex");
  return expiry + "." + sig;
}

function isValidToken(token) {
  if (!token || !token.includes(".")) return false;
  const [expiryStr, sig] = token.split(".");
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return false;

  const expectedSig = crypto
    .createHmac("sha256", getSecret())
    .update(String(expiry))
    .digest("hex");

  // Constant-time comparison
  if (sig.length !== expectedSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
}

function verifyPassword(input) {
  const password = getPassword();
  const a = Buffer.from(input);
  const b = Buffer.from(password);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, isValidToken, verifyPassword };
