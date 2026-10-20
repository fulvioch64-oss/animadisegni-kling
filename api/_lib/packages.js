// Credit packages. To add one, add an entry here and its LEMONSQUEEZY_VARIANT_ID_<ID> env var.
// mainCredits: new HD videos from scratch. retryCredits: free regenerations of the same drawing.
const PACKAGES = {
  starter: { id: 'starter', priceCents: 349, mainCredits: 1, retryCredits: 1 },
  family: { id: 'family', priceCents: 999, mainCredits: 4, retryCredits: 2, popular: true },
  party: { id: 'party', priceCents: 1999, mainCredits: 10, retryCredits: 5 },
  school: { id: 'school', priceCents: 3999, mainCredits: 20, retryCredits: 8 }
};
const CURRENCY = 'EUR';

function getPackage(id) {
  return typeof id === 'string' && Object.hasOwn(PACKAGES, id) ? PACKAGES[id] : null;
}

function envName(prefix, id) {
  return `${prefix}_${id.toUpperCase()}`;
}

function variantIdFor(id) {
  return (process.env[envName('LEMONSQUEEZY_VARIANT_ID', id)] || '').trim();
}

function publicPackages() {
  return Object.values(PACKAGES).map((pkg) => ({
    id: pkg.id,
    priceCents: pkg.priceCents,
    currency: CURRENCY,
    mainCredits: pkg.mainCredits,
    retryCredits: pkg.retryCredits,
    popular: pkg.popular === true
  }));
}

module.exports = { PACKAGES, CURRENCY, getPackage, variantIdFor, publicPackages };
