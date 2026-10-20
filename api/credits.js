const { publicPackages } = require('./_lib/packages.js');
const { walletGet } = require('./_lib/store.js');
const { parseWalletId } = require('./_lib/wallet.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const walletId = parseWalletId(req.query?.walletId);
    const balance = await walletGet(walletId);
    return sendJson(res, 200, { ...balance, packages: publicPackages() });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    if (status >= 500) console.error('Unable to read credit balance:', error);
    return sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
