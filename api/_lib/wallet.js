const { getPackage } = require('./packages.js');
const { walletAdjust } = require('./store.js');

const WALLET_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function apiError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// The wallet ID is an unguessable random UUID created by the browser; it acts as the secret that identifies the credit balance.
function parseWalletId(value) {
  if (typeof value !== 'string' || !WALLET_ID_PATTERN.test(value)) {
    throw apiError('walletId must be a valid UUID.', 400, 'INVALID_WALLET');
  }
  return value.toLowerCase();
}

function requirePackage(packageId) {
  const pkg = getPackage(packageId);
  if (!pkg) throw apiError('Unknown credit package.', 400, 'INVALID_PACKAGE');
  return pkg;
}

// Idempotent per order: a webhook retry or a double click never grants credits twice.
function grantPackage(walletId, packageId, orderId) {
  const pkg = requirePackage(packageId);
  return walletAdjust(walletId, `order:${orderId}`, pkg.mainCredits, pkg.retryCredits);
}

function revokePackage(walletId, packageId, orderId) {
  const pkg = requirePackage(packageId);
  return walletAdjust(walletId, `refund:${orderId}`, -pkg.mainCredits, -pkg.retryCredits);
}

module.exports = { apiError, parseWalletId, requirePackage, grantPackage, revokePackage };
