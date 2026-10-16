const supportedLocales = new Set(['en', 'it']);
const localeCache = new Map();
const localeStorageKey = 'littleMovesLocale';

function readSavedLocale() {
  try {
    const savedLocale = localStorage.getItem(localeStorageKey);
    return supportedLocales.has(savedLocale) ? savedLocale : 'en';
  } catch (error) {
    console.error('Unable to read saved language preference.', error);
    return 'en';
  }
}

async function loadMessages(locale) {
  if (!localeCache.has(locale)) {
    const request = fetch(`./locales/${locale}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${locale} translations (HTTP ${response.status}).`);
        return response.json();
      });
    localeCache.set(locale, request);
  }
  return localeCache.get(locale);
}

const englishMessages = await loadMessages('en');
let currentLocale = readSavedLocale();
let currentMessages = currentLocale === 'en' ? englishMessages : await loadMessages(currentLocale);

function translate(key, values = {}) {
  const message = currentMessages[key] ?? englishMessages[key] ?? key;
  if (typeof message !== 'string') return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  ));
}

function applyTranslations() {
  document.documentElement.lang = currentLocale;
  document.title = translate('pageTitle');
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = translate('pageDescription');

  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    const translation = translate(key);
    if (typeof translation === 'string') element.textContent = translation;
  });
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-i18n-')) continue;
      const targetAttribute = attribute.name.slice('data-i18n-'.length);
      element.setAttribute(targetAttribute, translate(attribute.value));
    }
  });

  const languageSelect = document.getElementById('languageSelect');
  if (languageSelect) languageSelect.value = currentLocale;
  document.dispatchEvent(new CustomEvent('app:localechange', { detail: { locale: currentLocale } }));
}

async function setLocale(locale) {
  if (!supportedLocales.has(locale)) throw new Error(`Unsupported language: ${locale}`);
  const messages = await loadMessages(locale);
  currentLocale = locale;
  currentMessages = messages;
  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch (error) {
    console.error('Unable to save language preference.', error);
  }
  applyTranslations();
}

export const i18n = {
  get locale() {
    return currentLocale;
  },
  t: translate,
  setLocale,
  applyTranslations
};
