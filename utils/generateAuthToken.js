// tokenUtil.js
const crypto = require("crypto");

const generatePublicAuthToken = (userId) => {
  const secret = process.env.USER_TOKEN_SECRET;
  if (!secret) {
    throw new Error("USER_TOKEN_SECRET is not set in environment variables");
  }
  const splitIndex = Math.floor(secret.length / 2);
  const secretFirst = secret.slice(0, splitIndex);
  const secretSecond = secret.slice(splitIndex);
  const merged = secretFirst + userId + secretSecond;
  const encodedMerged = Buffer.from(merged).toString("base64");
  // Create a random prefix (20 hex characters) and suffix (16 hex characters)
  const prefix = crypto.randomBytes(10).toString("hex");
  const suffix = crypto.randomBytes(8).toString("hex");
  return prefix + encodedMerged + suffix;
};

module.exports = { generatePublicAuthToken };
