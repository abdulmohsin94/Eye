const crypto = require("crypto");

const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

// In-memory token store (survives for the lifetime of the process)
const validTokens = new Map();

function getPassword() {
  return process.env.EYE_PASSWORD || "eye-admin";
}

function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.set(token, Date.now() + TOKEN_TTL);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const expiry = validTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    validTokens.delete(token);
    return false;
  }
  return true;
}

function verifyPassword(input) {
  const password = getPassword();
  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(input);
  const b = Buffer.from(password);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, isValidToken, verifyPassword };
