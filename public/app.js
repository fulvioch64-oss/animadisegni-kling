import { i18n } from './i18n.js';
import { openCropper } from './cropper.js';

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadContent = document.getElementById('uploadContent');
const imagePreview = document.getElementById('imagePreview');
const changePhoto = document.getElementById('changePhoto');
const checkoutStatus = document.getElementById('checkoutStatus');
const offerCard = document.getElementById('offerCard');
const btnRetry = document.getElementById('btnRetry');
const btnBuyCredits = document.getElementById('btnBuyCredits');
const mainCreditsValue = document.getElementById('mainCreditsValue');
const retryCreditsValue = document.getElementById('retryCreditsValue');
const packagesModal = document.getElementById('packagesModal');
const packagesGrid = document.getElementById('packagesGrid');
const packagesStatus = document.getElementById('packagesStatus');
const btnTest = document.getElementById('btnTest');
const testStatus = document.getElementById('testStatus');
const generationProgress = document.getElementById('generationProgress');
const progressTrack = generationProgress.querySelector('.progress-track');
const progressFill = document.getElementById('progressFill');
const progressValue = document.getElementById('progressValue');
const progressMessage = document.getElementById('progressMessage');
const resultBox = document.getElementById('resultBox');
const resultVideo = document.getElementById('resultVideo');
const downloadVideo = document.getElementById('downloadVideo');
const motionPreset = document.getElementById('motionPreset');
const aspectInputs = [...document.querySelectorAll('input[name="aspectRatio"]')];
const renderStyleInputs = [...document.querySelectorAll('input[name="renderStyle"]')];
const selectedRenderStyle = () => renderStyleInputs.find((input) => input.checked)?.value || 'real_photo';
const backgroundInputs = [...document.querySelectorAll('input[name="background"]')];
const selectedBackground = () => backgroundInputs.find((input) => input.checked)?.value || 'none';
const selectedAspectRatio = () => aspectInputs.find((input) => input.checked)?.value || '9:16';
const languageSelect = document.getElementById('languageSelect');
const cardMessage = document.getElementById('cardMessage');
const cardFontInputs = [...document.querySelectorAll('input[name="cardFont"]')];
const cardTemplateInputs = [...document.querySelectorAll('input[name="cardTemplate"]')];
const cardPreview = document.getElementById('cardPreview');
const cardPreviewImage = document.getElementById('cardPreviewImage');
const cardPreviewEmpty = document.getElementById('cardPreviewEmpty');
const cardPreviewBanner = document.getElementById('cardPreviewBanner');
const checkedValue = (inputs, fallback) => inputs.find((input) => input.checked)?.value || fallback;

// Same wrapping and font sizing rules as api/_lib/card.js, so the preview matches the rendered video.
const CARD_FONT_METRICS = {
  playful: { width: 0.56, scale: 1 },
  handwritten: { width: 0.42, scale: 1.3 },
  party: { width: 0.55, scale: 1 },
  cute: { width: 0.46, scale: 1.2 }
};

const selectedCard = () => ({
  message: cardMessage.value.replace(/\s+/g, ' ').trim(),
  font: checkedValue(cardFontInputs, 'playful'),
  template: checkedValue(cardTemplateInputs, 'classic')
});

function wrapCardMessage(message, maxChars) {
  const lines = [];
  let current = '';
  for (const word of message.split(' ')) {
    if (current && `${current} ${word}`.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderCardPreview() {
  const card = selectedCard();
  const metrics = CARD_FONT_METRICS[card.font] || CARD_FONT_METRICS.playful;
  const lines = card.message ? wrapCardMessage(card.message, 20) : [];
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const fontSize = Math.min(96 * metrics.scale, (1080 - 220) / (longest * metrics.width));
  cardPreview.dataset.ratio = selectedAspectRatio();
  cardPreview.dataset.template = card.template;
  cardPreview.dataset.font = card.font;
  cardPreviewBanner.replaceChildren(...lines.map((line) => {
    const row = document.createElement('span');
    row.textContent = line;
    row.style.fontSize = `${(fontSize / 10.8).toFixed(2)}cqw`;
    row.style.lineHeight = '1.18';
    return row;
  }));
  cardPreviewBanner.classList.toggle('hidden', !lines.length);
  const hasPhoto = Boolean(selectedPhoto?.dataUrl);
  if (hasPhoto) cardPreviewImage.src = selectedPhoto.dataUrl;
  cardPreviewImage.classList.toggle('hidden', !hasPhoto);
  cardPreviewEmpty.classList.toggle('hidden', hasPhoto);
}

const STORAGE_KEY = 'animadisegniCustomization';
const TOKEN_KEY = 'animadisegniGenerationToken';
const VIDEO_KEY = 'animadisegniPreviewUrl';
const AUDIO_KEY = 'animadisegniPreviewAudioUrl';
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
let selectedPhoto = null;
let uploadGeneration = 0;
let generationToken = null;
let generationRunning = false;
let progressPercent = 0;
let messageRotationInterval = null;
let progressTickInterval = null;
const PROGRESS_TARGET_MS = 60000;

function clearProgressTimers() {
  if (messageRotationInterval !== null) window.clearInterval(messageRotationInterval);
  if (progressTickInterval !== null) window.clearInterval(progressTickInterval);
  messageRotationInterval = null;
  progressTickInterval = null;
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const t = (key, values) => i18n.t(key, values);

// Demo gallery: videos autoplay muted; the button unmutes one video at a time (a click is the user gesture browsers require).
const demoVideos = [...document.querySelectorAll('.demo-figure')].map((figure) => ({
  video: figure.querySelector('.demo-video'),
  button: figure.querySelector('.demo-sound')
}));

function renderDemoButton({ video, button }) {
  const soundOn = !video.muted;
  button.setAttribute('aria-pressed', String(soundOn));
  button.dataset.i18n = soundOn ? 'demoSoundOff' : 'demoSoundOn';
  button.textContent = t(button.dataset.i18n);
}

demoVideos.forEach((demo) => {
  demo.button.addEventListener('click', () => {
    const enable = demo.video.muted;
    demoVideos.forEach((other) => {
      other.video.muted = other !== demo || !enable;
      renderDemoButton(other);
    });
    if (enable) {
      demo.video.volume = 1;
      demo.video.play().catch((error) => console.warn('Unable to play the demo video with sound.', error));
    }
  });
});

function updateProgress(value) {
  progressPercent = Math.min(99, Math.max(progressPercent, value));
  const percent = `${Math.round(progressPercent)}%`;
  progressFill.style.width = percent;
  progressTrack.setAttribute('aria-valuenow', String(Math.round(progressPercent)));
  progressValue.textContent = percent;
}

function startProgress() {
  stopProgress();
  progressPercent = 0;
  progressFill.style.width = '0%';
  progressTrack.setAttribute('aria-valuenow', '0');
  progressValue.textContent = '0%';
  progressMessage.textContent = t('progressMessages')[0];
  generationProgress.classList.remove('hidden');
  let messageIndex = 0;
  messageRotationInterval = window.setInterval(() => {
    const messages = t('progressMessages');
    messageIndex = (messageIndex + 1) % messages.length;
    progressMessage.textContent = messages[messageIndex];
  }, 3000);
  // Ease towards ~90% over about a minute; 100% is only set on completion.
  const startedAt = Date.now();
  progressTickInterval = window.setInterval(() => {
    const elapsed = Date.now() - startedAt;
    updateProgress(90 * (1 - Math.exp((-2.2 * elapsed) / PROGRESS_TARGET_MS)));
  }, 500);
}

function stopProgress() {
  clearProgressTimers();
  progressPercent = 0;
  progressFill.style.width = '0%';
  progressTrack.setAttribute('aria-valuenow', '0');
  progressValue.textContent = '0%';
  generationProgress.classList.add('hidden');
}

async function completeProgress() {
  clearProgressTimers();
  progressPercent = 100;
  progressFill.style.width = '100%';
  progressTrack.setAttribute('aria-valuenow', '100');
  progressValue.textContent = '100%';
  await wait(450);
  generationProgress.classList.add('hidden');
}

async function waitForGeneration(token) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let polls = 0;
  while (Date.now() < deadline) {
    await wait(5000);
    const result = await callJsonApi(`/api/generate-dance?generationToken=${encodeURIComponent(token)}`);
    polls += 1;
    updateProgress(5 + polls * 4);
    if (result.status === 'COMPLETE') return result;
    if (result.status === 'ERROR' || result.status === 'FAILED') {
      throw new Error(result.error || t('errorGeneration'));
    }
    if (result.status !== 'PENDING') throw new Error(t('errorGenerationStatus'));
    if (!result.canPoll) return result;
    testStatus.textContent = t('statusGenerating');
  }
  throw new Error(t('errorGenerationTimeout'));
}

function validImageSource(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(value) ? value : null;
}

// The preview video is silent: the selected MP3 from /audio/ is played in sync with it and looped.
const resultAudio = new Audio();
resultAudio.loop = true;
resultAudio.preload = 'auto';
resultVideo.loop = true;
let lastVideoTime = 0;

function validAudioUrl(value) {
  return typeof value === 'string' && /^\/audio\/[^/\\]+\.mp3$/i.test(value) && !value.includes('..') ? value : null;
}

function setResultAudio(audioUrl) {
  const validUrl = validAudioUrl(audioUrl);
  resultAudio.pause();
  if (validUrl) {
    resultAudio.src = validUrl;
    sessionStorage.setItem(AUDIO_KEY, validUrl);
  } else {
    resultAudio.removeAttribute('src');
    sessionStorage.removeItem(AUDIO_KEY);
  }
}

function syncResultAudio() {
  if (!resultAudio.getAttribute('src')) return;
  try {
    const duration = resultAudio.duration;
    resultAudio.currentTime = Number.isFinite(duration) && duration > 0 ? resultVideo.currentTime % duration : 0;
  } catch (error) {
    console.warn('Unable to sync the music track with the video.', error);
  }
}

function playResultVideo() {
  resultVideo.play().catch(() => {});
}

resultVideo.addEventListener('play', () => {
  if (!resultAudio.getAttribute('src')) return;
  syncResultAudio();
  resultAudio.play().catch(() => {});
});
resultVideo.addEventListener('pause', () => resultAudio.pause());
resultVideo.addEventListener('seeked', syncResultAudio);
resultVideo.addEventListener('volumechange', () => {
  resultAudio.volume = resultVideo.volume;
  resultAudio.muted = resultVideo.muted;
});
resultVideo.addEventListener('timeupdate', () => {
  // The video wrapped around to the start: restart the music together with it.
  if (resultVideo.currentTime + 1 < lastVideoTime && resultAudio.getAttribute('src')) resultAudio.currentTime = 0;
  lastVideoTime = resultVideo.currentTime;
});

function validVideoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function saveCustomization() {
  renderCardPreview();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      photo: selectedPhoto,
      motionPreset: motionPreset.value,
      aspectRatio: selectedAspectRatio(),
      renderStyle: selectedRenderStyle(),
      background: selectedBackground(),
      card: selectedCard()
    }));
  } catch (error) {
    testStatus.textContent = t('errorSaveSession');
    console.error('Unable to save image and settings for this session.', error);
  }
}

motionPreset.addEventListener('change', saveCustomization);
aspectInputs.forEach((input) => input.addEventListener('change', saveCustomization));
renderStyleInputs.forEach((input) => input.addEventListener('change', saveCustomization));
backgroundInputs.forEach((input) => input.addEventListener('change', saveCustomization));
cardMessage.addEventListener('input', saveCustomization);
[...cardFontInputs, ...cardTemplateInputs].forEach((input) => input.addEventListener('change', saveCustomization));
languageSelect.addEventListener('change', async () => {
  try {
    await i18n.setLocale(languageSelect.value);
  } catch (error) {
    console.error('Unable to change the application language.', error);
    languageSelect.value = i18n.locale;
    testStatus.textContent = t('errorLanguageLoad');
    testStatus.classList.add('status-error');
  }
});

function setPhoto(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    testStatus.textContent = t('errorUnsupportedImage');
    return;
  }
  if (file.size > MAX_PHOTO_SIZE) {
    testStatus.textContent = t('errorImageTooLarge');
    return;
  }

  const currentGeneration = ++uploadGeneration;
  btnTest.disabled = true;
  generationToken = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VIDEO_KEY);
  offerCard.classList.add('hidden');
  downloadVideo.classList.add('hidden');
  resultBox.classList.add('hidden');
  testStatus.textContent = '';

  const reader = new FileReader();
  reader.onload = () => {
    if (currentGeneration !== uploadGeneration) return;
    if (typeof reader.result !== 'string') {
      testStatus.textContent = t('errorReadImage');
      return;
    }
    const image = new Image();
    image.onload = async () => {
      if (currentGeneration !== uploadGeneration) return;
      const cropped = await openCropper(image, selectedAspectRatio());
      if (currentGeneration !== uploadGeneration) return;
      if (!cropped) {
        btnTest.disabled = !selectedPhoto?.imageUrl;
        return;
      }
      const dataUrl = cropped;
      selectedPhoto = { name: file.name, type: 'image/jpeg', dataUrl, imageUrl: null };
      imagePreview.src = dataUrl;
      imagePreview.classList.remove('hidden');
      uploadContent.classList.add('hidden');
      changePhoto.classList.remove('hidden');
      saveCustomization();
      uploadPhoto(selectedPhoto, currentGeneration);
    };
    image.onerror = () => {
      if (currentGeneration !== uploadGeneration) return;
      testStatus.textContent = t('errorInvalidImage');
    };
    image.src = reader.result;
  };
  reader.onerror = () => {
    if (currentGeneration !== uploadGeneration) return;
    selectedPhoto = null;
    testStatus.textContent = t('errorReadFile');
    console.error('Unable to read the selected image file.', reader.error);
  };
  reader.readAsDataURL(file);
}

async function uploadPhoto(photo, currentGeneration) {
  btnTest.disabled = true;
  testStatus.classList.remove('status-error');
  testStatus.textContent = t('statusUploading');
  try {
    const result = await callJsonApi('/api/upload-image', {
      method: 'POST',
      body: { image: photo.dataUrl }
    });
    if (currentGeneration !== uploadGeneration || selectedPhoto !== photo) return;
    const imageUrl = validImageSource(result.imageUrl);
    if (!imageUrl) throw new Error(t('errorInvalidImageUrl'));
    photo.imageUrl = imageUrl;
    photo.imageUrlExpiresAt = null;
    saveCustomization();
    btnTest.disabled = false;
    testStatus.textContent = '';
    updateReadyMessage();
  } catch (error) {
    if (currentGeneration !== uploadGeneration || selectedPhoto !== photo) return;
    btnTest.disabled = true;
    testStatus.textContent = error instanceof Error ? error.message : t('errorUploadImage');
    testStatus.classList.add('status-error');
    console.error('Unable to upload the selected image.', error);
  }
}

uploadZone.addEventListener('click', (event) => {
  if (event.target === changePhoto) return;
  fileInput.click();
});
uploadZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
changePhoto.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  setPhoto(fileInput.files[0]);
  fileInput.value = '';
});
['dragenter', 'dragover'].forEach((eventName) => {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.add('drag-over');
  });
});
['dragleave', 'drop'].forEach((eventName) => {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.remove('drag-over');
  });
});
uploadZone.addEventListener('drop', (event) => setPhoto(event.dataTransfer.files[0]));

function restoreCustomization() {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const customization = JSON.parse(saved);
    if (typeof customization.motionPreset === 'string'
      && [...motionPreset.options].some((option) => option.value === customization.motionPreset)) {
      motionPreset.value = customization.motionPreset;
    }
    const savedAspect =  aspectInputs.find((input) => input.value === customization.aspectRatio);
    if (savedAspect) savedAspect.checked = true;
    const savedStyle = renderStyleInputs.find((input) => input.value === customization.renderStyle);
    if (savedStyle) savedStyle.checked = true;
    const savedBackground = backgroundInputs.find((input) => input.value === customization.background);
    if (savedBackground) savedBackground.checked = true;
    const savedCard = customization.card;
    if (savedCard && typeof savedCard === 'object') {
      if (typeof savedCard.message === 'string') cardMessage.value = savedCard.message.slice(0, 60);
      const savedFont = cardFontInputs.find((input) => input.value === savedCard.font);
      if (savedFont) savedFont.checked = true;
      const savedTemplate = cardTemplateInputs.find((input) => input.value === savedCard.template);
      if (savedTemplate) savedTemplate.checked = true;
    }
    if (customization.photo && typeof customization.photo.dataUrl === 'string') {
      selectedPhoto = customization.photo;
      imagePreview.src = selectedPhoto.dataUrl;
      imagePreview.classList.remove('hidden');
      uploadContent.classList.add('hidden');
      changePhoto.classList.remove('hidden');
      const savedImageUrl = validImageSource(selectedPhoto.imageUrl);
      if (savedImageUrl) {
        selectedPhoto.imageUrl = savedImageUrl;
        btnTest.disabled = false;
      } else {
        selectedPhoto.imageUrl = null;
        uploadPhoto(selectedPhoto, uploadGeneration);
      }
    }
  } catch (error) {
    console.error('Unable to restore saved image and settings.', error);
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

// ---- Credits and packages ----
// The wallet ID is a random UUID kept in localStorage; the server keeps the balances (main = new videos, retry = free retries).
const WALLET_KEY = 'littleMovesWalletId';
const CREDITS_KEY = 'littleMovesCredits';
const PENDING_PURCHASE_KEY = 'littleMovesPendingPurchase';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
let fallbackWalletId = null;
let packages = [];

function getWalletId() {
  try {
    const saved = localStorage.getItem(WALLET_KEY);
    if (UUID_PATTERN.test(saved || '')) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem(WALLET_KEY, created);
    return created;
  } catch (error) {
    console.error('Unable to persist the wallet ID; credits will only last for this tab.', error);
    fallbackWalletId ||= crypto.randomUUID();
    return fallbackWalletId;
  }
}

function readCachedCredits() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CREDITS_KEY) || 'null');
    if (Number.isInteger(cached?.mainCredits) && Number.isInteger(cached?.retryCredits)) return cached;
  } catch (error) {
    console.error('Unable to read the cached credit balance.', error);
  }
  return { mainCredits: 0, retryCredits: 0 };
}

let credits = readCachedCredits();

function updateReadyMessage() {
  if (generationRunning || !selectedPhoto || !selectedPhoto.imageUrl || credits.mainCredits > 0) return;
  testStatus.classList.remove('status-error');
  testStatus.textContent = t('readyPickPackage');
}

function setCredits(next) {
  credits = { mainCredits: next.mainCredits, retryCredits: next.retryCredits };
  try {
    sessionStorage.setItem(CREDITS_KEY, JSON.stringify(credits));
  } catch (error) {
    console.error('Unable to cache the credit balance.', error);
  }
  mainCreditsValue.textContent = String(credits.mainCredits);
  retryCreditsValue.textContent = String(credits.retryCredits);
  updateReadyMessage();
}
setCredits(credits);

async function refreshCredits() {
  const data = await callJsonApi(`/api/credits?walletId=${encodeURIComponent(getWalletId())}`);
  packages = Array.isArray(data.packages) ? data.packages : [];
  setCredits(data);
  renderPackages();
  return credits;
}

function formatPrice(cents, currency) {
  return new Intl.NumberFormat(i18n.locale, { style: 'currency', currency }).format(cents / 100);
}

function packageLine(className, text) {
  const item = document.createElement('li');
  item.className = className;
  item.textContent = text;
  return item;
}

function renderPackages() {
  packagesGrid.replaceChildren(...packages.map((pkg) => {
    const card = document.createElement('article');
    card.className = `package-card${pkg.popular ? ' package-popular' : ''}`;
    card.setAttribute('role', 'listitem');

    if (pkg.popular) {
      const badge = document.createElement('span');
      badge.className = 'package-badge';
      badge.textContent = t('packagePopular');
      card.append(badge);
    }
    const name = document.createElement('h3');
    name.textContent = t(`package_${pkg.id}`);
    const price = document.createElement('p');
    price.className = 'package-price';
    price.textContent = formatPrice(pkg.priceCents, pkg.currency);
    const perVideo = document.createElement('p');
    perVideo.className = 'package-per-video';
    perVideo.textContent = t('packagePerVideo', { price: formatPrice(Math.round(pkg.priceCents / pkg.mainCredits), pkg.currency) });

    const features = document.createElement('ul');
    features.append(
      packageLine('package-videos', t(pkg.mainCredits === 1 ? 'packageVideoOne' : 'packageVideos', { count: pkg.mainCredits })),
      packageLine('package-gift', t(pkg.retryCredits === 1 ? 'packageRetryOne' : 'packageRetries', { count: pkg.retryCredits }))
    );

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'btn-primary';
    choose.textContent = t('packageChoose');
    choose.addEventListener('click', () => buyPackage(pkg.id, choose));
    card.append(name, price, perVideo, features, choose);
    return card;
  }));
}
document.addEventListener('app:localechange', renderPackages);

function showPackagesStatus(message, isError = false) {
  packagesStatus.textContent = message;
  packagesStatus.classList.toggle('status-error', isError);
}

async function openPackages(message = '') {
  showPackagesStatus(message);
  if (!packages.length) {
    try {
      await refreshCredits();
    } catch (error) {
      showPackagesStatus(error instanceof Error ? error.message : t('errorUnexpected'), true);
    }
  }
  if (!packagesModal.open) packagesModal.showModal();
}

btnBuyCredits.addEventListener('click', () => openPackages());
packagesModal.addEventListener('click', (event) => {
  if (event.target === packagesModal) packagesModal.close();
});

async function buyPackage(packageId, button) {
  button.disabled = true;
  showPackagesStatus('');
  try {
    const data = await callJsonApi('/api/checkout', { method: 'POST', body: { walletId: getWalletId(), packageId } });
    const target = new URL(data.url);
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') throw new Error(t('errorCheckoutUrl'));
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ packageId, baseline: credits }));
    showPackagesStatus(t('statusRedirecting'));
    window.location.assign(target.href);
  } catch (error) {
    console.error('Checkout request failed.', error);
    showPackagesStatus(error instanceof Error ? error.message : t('errorUnexpected'), true);
    button.disabled = false;
  }
}

async function callJsonApi(url, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 600000);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(t('errorServiceTimeout'));
    }
    console.error(`[api] Network error calling ${method} ${new URL(url, window.location.href).href}:`, error);
    throw new Error(t('errorContactService', { url }));
  } finally {
    window.clearTimeout(timeoutId);
  }

  const responseText = await response.text();
  const requestUrl = new URL(url, window.location.href).href;
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    console.error(`[api] Non-JSON response from ${method} ${requestUrl} (status ${response.status}):`, responseText.slice(0, 500));
    throw new Error(t('errorInvalidResponse', { status: response.status }));
  }
  if (!response.ok) {
    console.error(`[api] ${method} ${requestUrl} failed with status ${response.status}:`, data);
    const codeKey = typeof data.code === 'string' ? `apiError_${data.code}` : null;
    const failure = new Error((codeKey && t(codeKey) !== codeKey ? t(codeKey) : '') || localizeApiError(data.error) || t('errorRequest', { status: response.status }));
    failure.code = data.code;
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function localizeApiError(message) {
  if (typeof message !== 'string') return '';
  const translations = [
    [message.startsWith('Carica un'), 'errorImageRequired'],
    [message.startsWith('L\u2019immagine deve essere un file'), 'errorUnsupportedImage'],
    [message.startsWith('L\u2019immagine deve avere'), 'errorImageTooLarge'],
    [message.startsWith('imageUrl deve essere'), 'errorInvalidImageUrl'],
    [message.startsWith('motionPreset deve'), 'errorInvalidMotionPreset'],
    [message.startsWith('Configura KLING_API_URL'), 'errorKlingConfiguration'],
    [message.startsWith('KLING_API_URL'), 'errorKlingEndpoint'],
    [message.startsWith('KLING_API_STATUS_URL'), 'errorKlingStatusEndpoint'],
    [message.startsWith('Il gateway Kling non ha restituito un URL video o un ID task'), 'errorKlingTaskResponse'],
    [message.startsWith('Il gateway Kling non ha restituito l\u2019URL MP4'), 'errorKlingVideoUrl'],
    [message.startsWith('Il gateway Kling non è riuscito'), 'errorGenerationService'],
    [message.startsWith('Impossibile contattare il gateway Kling'), 'errorGenerationService'],
    [message.startsWith('Hai raggiunto il limite'), 'errorGenerationQuota'],
    [message.startsWith('Corpo della richiesta non valido'), 'errorInvalidRequest'],
    [message.startsWith('Identificativo della richiesta non valido'), 'errorInvalidRequestId'],
    [message.startsWith('Il video non è pronto per il checkout') || message.startsWith('Video non trovato o non ancora pronto'), 'errorVideoNotReady'],
    [message.startsWith('Pagamento non ancora verificato'), 'errorPaymentPending'],
    [message.startsWith('Impossibile verificare il pagamento'), 'errorPaymentService']
  ];
  const match = translations.find(([matches]) => matches);
  return match ? t(match[1]) : message;
}

function callGenerateApi(payload) {
  return callJsonApi('/api/generate-dance', { method: 'POST', body: payload });
}

btnTest.addEventListener('click', () => startGeneration(false));

const retryModal = document.getElementById('retryModal');

function setRetryButton(labelKey, disabled) {
  btnRetry.dataset.i18n = labelKey;
  btnRetry.textContent = t(labelKey);
  btnRetry.disabled = disabled;
}

btnRetry.addEventListener('click', () => {
  if (!generationToken || btnRetry.disabled) return;
  retryModal.showModal();
});

retryModal.addEventListener('close', () => {
  if (retryModal.returnValue === 'confirm') runFreeRetry();
  retryModal.returnValue = '';
});
retryModal.addEventListener('click', (event) => {
  if (event.target === retryModal) retryModal.close('cancel');
});

// Free second try: replays the original order on the server with identical parameters.
async function runFreeRetry() {
  const orderId = generationToken;
  if (!orderId) return;
  generationRunning = true;
  btnTest.disabled = true;
  setRetryButton('retryRunning', true);
  checkoutStatus.classList.remove('status-error');
  checkoutStatus.textContent = t('retryRunning');
  try {
    const data = await callJsonApi('/api/retry', { method: 'POST', body: { order_id: orderId } });
    const videoUrl = validVideoUrl(data.video_url);
    if (!videoUrl) throw new Error(t('errorVideoUrl'));
    if (data.generation_token) {
      generationToken = data.generation_token;
      sessionStorage.setItem(TOKEN_KEY, generationToken);
      downloadVideo.href = `/api/download?id=${encodeURIComponent(generationToken)}`;
    }
    resultVideo.src = videoUrl;
    resultVideo.load();
    playResultVideo();
    checkoutStatus.textContent = t('retryDone');
    setRetryButton('retryUsedLabel', true);
  } catch (error) {
    console.error('Free retry failed.', error);
    checkoutStatus.classList.add('status-error');
    if (error?.status === 403) {
      checkoutStatus.textContent = t('retryErrorUsed');
      setRetryButton('retryUsedLabel', true);
    } else {
      checkoutStatus.textContent = t('retryErrorTemporary');
      setRetryButton('retryButton', false);
    }
  } finally {
    generationRunning = false;
    btnTest.disabled = !selectedPhoto;
  }
}

async function startGeneration(isRetry) {
  if (!selectedPhoto || btnTest.disabled) return;
  const retryOfToken = isRetry ? generationToken : null;
  if (isRetry && !retryOfToken) {
    testStatus.textContent = t('apiError_RETRY_MISMATCH');
    return;
  }
  if ((isRetry ? credits.retryCredits : credits.mainCredits) <= 0) {
    openPackages(t(isRetry ? 'apiError_NO_RETRY_CREDITS' : 'readyPickPackage'));
    return;
  }
  generationRunning = true;
  btnTest.disabled = true;
  setRetryButton('retryButton', true);
  testStatus.textContent = '';
  checkoutStatus.textContent = '';
  offerCard.classList.add('hidden');
  resultBox.classList.add('hidden');
  stopProgress();
  resultVideo.pause();
  resultVideo.removeAttribute('src');
  resultVideo.load();
  downloadVideo.classList.add('hidden');
  generationToken = null;
  testStatus.classList.remove('status-error');
  startProgress();

  try {
    if (!selectedPhoto.imageUrl) throw new Error(t('errorImageStillUploading'));
    let started = await callGenerateApi({
      imageUrl: selectedPhoto.imageUrl,
      motionPreset: motionPreset.value,
      aspectRatio: selectedAspectRatio(),
      renderStyle: selectedRenderStyle(),
      background: selectedBackground(),
      card: selectedCard(),
      walletId: getWalletId(),
      ...(retryOfToken ? { retryOfToken } : {})
    });
    if (!started.generationToken) throw new Error(t('errorMissingGenerationToken'));

    generationToken = started.generationToken;
    sessionStorage.setItem(TOKEN_KEY, generationToken);
    if (started.status === 'PENDING' && started.canPoll) {
      started = await waitForGeneration(generationToken);
    }
    if (started.status === 'ERROR') throw new Error(started.error || t('errorGeneration'));
    if (started.status !== 'COMPLETE' || !started.videoUrl) {
      stopProgress();
      testStatus.textContent = started.taskId
        ? t('statusTaskStarted', { taskId: started.taskId })
        : t('statusTaskSubmitted');
      return;
    }
    const data = started;
    const videoUrl = validVideoUrl(data.videoUrl);
    if (!videoUrl) throw new Error(t('errorVideoUrl'));

    await completeProgress();
    resultVideo.src = videoUrl;
    setResultAudio(data.audioUrl);
    resultVideo.load();
    playResultVideo();
    resultBox.classList.remove('hidden');
    offerCard.classList.remove('hidden');
    downloadVideo.href = `/api/download?id=${encodeURIComponent(generationToken)}`;
    downloadVideo.classList.remove('hidden');
    testStatus.textContent = t('statusVideoReady');
    if (data.credits) setCredits(data.credits);
    else await refreshCredits();
  } catch (error) {
    stopProgress();
    resultVideo.pause();
    resultVideo.removeAttribute('src');
    resultVideo.load();
    resultBox.classList.add('hidden');
    offerCard.classList.add('hidden');
    testStatus.textContent = error instanceof Error ? error.message : t('errorGenerationService');
    testStatus.classList.add('status-error');
    console.error('Animation generation failed.', error);
    if (error?.code === 'NO_CREDITS' || error?.code === 'NO_RETRY_CREDITS') {
      refreshCredits().catch(() => {});
      openPackages(testStatus.textContent);
    }
  } finally {
    generationRunning = false;
    btnTest.disabled = !selectedPhoto;
    btnRetry.disabled = false;
  }
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('purchase') !== 'success') return;
  window.history.replaceState({}, '', window.location.pathname);

  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) || 'null');
  } catch (error) {
    console.error('Unable to read the pending purchase.', error);
  }
  sessionStorage.removeItem(PENDING_PURCHASE_KEY);
  const total = (balance) => balance.mainCredits + balance.retryCredits;
  const baseline = pending?.baseline ? total(pending.baseline) : null;

  testStatus.classList.remove('status-error');
  testStatus.textContent = t('statusCreditsVerifying');
  try {
    // The webhook may arrive a few seconds after the redirect, so poll until the new credits show up.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await refreshCredits();
      if (baseline === null || total(current) > baseline) {
        testStatus.textContent = t('statusCreditsConfirmed', { main: current.mainCredits, retry: current.retryCredits });
        return;
      }
      await wait(3000);
    }
    testStatus.textContent = t('statusCreditsPending');
  } catch (error) {
    testStatus.textContent = error instanceof Error ? error.message : t('errorPaymentVerification');
    testStatus.classList.add('status-error');
    console.error('Unable to verify the purchase after checkout return.', error);
  }
}

// ---- Google sign-in (optional: anonymous use keeps working) ----
const authBox = document.getElementById('authBox');
const googleSignIn = document.getElementById('googleSignIn');
const authUser = document.getElementById('authUser');
const authAvatar = document.getElementById('authAvatar');
const btnLogout = document.getElementById('btnLogout');

function renderAuth(user) {
  authBox.hidden = false;
  googleSignIn.hidden = Boolean(user);
  authUser.hidden = !user;
  btnLogout.hidden = !user;
  authUser.textContent = user ? (user.name || user.email || '') : '';
  authUser.title = user?.email || '';
  const picture = typeof user?.picture === 'string' && user.picture.startsWith('https://') ? user.picture : '';
  authAvatar.hidden = !picture;
  if (picture) authAvatar.src = picture;
  else authAvatar.removeAttribute('src');
}

async function onGoogleCredential(response) {
  try {
    const data = await callJsonApi('/api/auth', { method: 'POST', body: { action: 'google', credential: response.credential, walletId: getWalletId() } });
    renderAuth(data.user);
    if (data.credits) setCredits(data.credits);
    if (data.claimError) testStatus.textContent = t('authClaimConflict');
    // Re-check the session from the server so header and credits reflect the new cookie without an F5.
    await checkAuth();
  } catch (error) {
    testStatus.textContent = error.message;
  }
}

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

let googleButtonReady = false;

async function ensureGoogleButton(clientId) {
  if (googleButtonReady) return;
  await loadGoogleScript();
  window.google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
  window.google.accounts.id.renderButton(googleSignIn, { theme: 'outline', size: 'medium', text: 'signin_with' });
  googleButtonReady = true;
}

// Reads the session from the server, re-renders the header and refreshes the balance.
async function checkAuth() {
  try {
    const state = await callJsonApi('/api/auth');
    if (!state.googleClientId) return null;
    renderAuth(state.user);
    if (state.user) await refreshCredits().catch(() => {});
    else await ensureGoogleButton(state.googleClientId);
    return state.user;
  } catch (error) {
    console.error('Google sign-in unavailable.', error);
    return null;
  }
}

btnLogout.addEventListener('click', async () => {
  try {
    await callJsonApi('/api/auth', { method: 'POST', body: { action: 'logout' } });
    window.google?.accounts?.id?.disableAutoSelect();
  } catch (error) {
    testStatus.textContent = error.message;
  }
  await checkAuth();
  await refreshCredits().catch(() => {});
});

i18n.applyTranslations();
restoreCustomization();
renderCardPreview();
checkAuth().finally(() => refreshCredits().catch((error) => console.error('Unable to load the credit balance.', error)));
handleCheckoutReturn();
