import { i18n } from './i18n.js';

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadContent = document.getElementById('uploadContent');
const imagePreview = document.getElementById('imagePreview');
const changePhoto = document.getElementById('changePhoto');
const btnCheckout = document.getElementById('btnCheckout');
const checkoutStatus = document.getElementById('checkoutStatus');
const offerCard = document.getElementById('offerCard');
const btnLocalPayment = document.getElementById('btnLocalPayment');
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
const languageSelect = document.getElementById('languageSelect');

const STORAGE_KEY = 'animadisegniCustomization';
const TOKEN_KEY = 'animadisegniGenerationToken';
const VIDEO_KEY = 'animadisegniPreviewUrl';
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
let selectedPhoto = null;
let uploadGeneration = 0;
let generationToken = null;
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

function validImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

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
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      photo: selectedPhoto,
      motionPreset: motionPreset.value
    }));
  } catch (error) {
    testStatus.textContent = t('errorSaveSession');
    console.error('Unable to save image and settings for this session.', error);
  }
}

motionPreset.addEventListener('change', saveCustomization);
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
  btnCheckout.classList.remove('hidden');
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
    image.onload = () => {
      if (currentGeneration !== uploadGeneration) return;
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        testStatus.textContent = t('errorProcessImage');
        return;
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
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
    const imageUrl = validImageUrl(result.imageUrl);
    if (!imageUrl) throw new Error(t('errorInvalidImageUrl'));
    photo.imageUrl = imageUrl;
    photo.imageUrlExpiresAt = Number.isFinite(result.expiresInSeconds)
      ? Date.now() + result.expiresInSeconds * 1000
      : null;
    saveCustomization();
    btnTest.disabled = false;
    testStatus.textContent = '';
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
    if (customization.photo && typeof customization.photo.dataUrl === 'string') {
      selectedPhoto = customization.photo;
      imagePreview.src = selectedPhoto.dataUrl;
      imagePreview.classList.remove('hidden');
      uploadContent.classList.add('hidden');
      changePhoto.classList.remove('hidden');
      const isExpired = Number.isFinite(selectedPhoto.imageUrlExpiresAt)
        && selectedPhoto.imageUrlExpiresAt <= Date.now();
      const savedImageUrl = isExpired ? null : validImageUrl(selectedPhoto.imageUrl);
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

function setCheckoutError(message, error) {
  if (error) console.error('Checkout request failed.', error);
  checkoutStatus.textContent = message;
  btnCheckout.disabled = false;
  btnCheckout.textContent = t('checkoutButton');
}

btnCheckout.addEventListener('click', async () => {
  if (!generationToken || btnCheckout.disabled) return;
  btnCheckout.disabled = true;
  btnCheckout.textContent = t('statusRedirecting');
  checkoutStatus.textContent = '';

  try {
    const data = await callJsonApi('/api/checkout', { method: 'POST', body: { generationToken } });
    const target = new URL(data.url);
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') throw new Error(t('errorCheckoutUrl'));
    window.location.assign(target.href);
  } catch (error) {
    const message = error instanceof Error ? error.message : t('errorUnexpected');
    setCheckoutError(message, error);
  }
});

async function callJsonApi(url, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 180000);
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
    throw new Error(localizeApiError(data.error) || t('errorRequest', { status: response.status }));
  }
  return data;
}

function localizeApiError(message) {
  if (typeof message !== 'string') return '';
  const translations = [
    [message.startsWith('Carica un'), 'errorImageRequired'],
    [message.startsWith('L\u2019immagine deve essere un file'), 'errorUnsupportedImage'],
    [message.startsWith('L\u2019immagine deve avere'), 'errorImageTooLarge'],
    [message.startsWith('Configura BLOB_READ_WRITE_TOKEN'), 'errorBlobConfiguration'],
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

btnTest.addEventListener('click', async () => {
  if (!selectedPhoto || btnTest.disabled) return;
  btnTest.disabled = true;
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
      motionPreset: motionPreset.value
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
    resultVideo.load();
    sessionStorage.setItem(VIDEO_KEY, videoUrl);
    resultBox.classList.remove('hidden');
    offerCard.classList.remove('hidden');
    testStatus.textContent = t('statusPreviewReady');
    await refreshPaymentStatus(generationToken, false);
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
  } finally {
    btnTest.disabled = !selectedPhoto;
  }
});

async function refreshPaymentStatus(token, showPendingMessage = true) {
  const data = await callJsonApi(`/api/payment-status?id=${encodeURIComponent(token)}`);
  btnLocalPayment.classList.toggle('hidden', !data.simulationAvailable);
  if (data.paid) {
    downloadVideo.href = `/api/download?id=${encodeURIComponent(token)}`;
    downloadVideo.classList.remove('hidden');
    btnCheckout.classList.add('hidden');
    checkoutStatus.textContent = t('statusPaymentVerified');
  } else {
    if (showPendingMessage) checkoutStatus.textContent = t('statusPaymentPending');
    downloadVideo.classList.add('hidden');
  }
  return data.paid;
}

btnLocalPayment.addEventListener('click', async () => {
  if (!generationToken) return;
  btnLocalPayment.disabled = true;
  try {
    await callJsonApi('/api/dev-payment', { method: 'POST', body: { generationToken } });
    await refreshPaymentStatus(generationToken, false);
  } catch (error) {
    checkoutStatus.textContent = error instanceof Error ? error.message : t('errorPaymentSimulation');
    console.error('Local payment simulation failed.', error);
  } finally {
    btnLocalPayment.disabled = false;
  }
});

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('purchase') !== 'success') return;
  const token = params.get('id');
  if (!token || !/^[\da-f-]{36}$/i.test(token)) {
    checkoutStatus.textContent = t('errorPurchaseReturn');
    return;
  }
  generationToken = token;
  sessionStorage.setItem(TOKEN_KEY, token);
  const videoUrl = sessionStorage.getItem(VIDEO_KEY);
  const validUrl = validVideoUrl(videoUrl);
  if (validUrl) {
    resultVideo.src = validUrl;
    resultVideo.load();
    resultBox.classList.remove('hidden');
    offerCard.classList.remove('hidden');
  } else {
    testStatus.textContent = t('statusPreviewUnavailable');
    testStatus.classList.add('status-error');
  }
  try {
    const paid = await refreshPaymentStatus(token);
    if (paid) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(3000);
      if (await refreshPaymentStatus(token)) return;
    }
  } catch (error) {
    checkoutStatus.textContent = error instanceof Error ? error.message : t('errorPaymentVerification');
    console.error('Unable to verify payment after checkout return.', error);
  }
}

i18n.applyTranslations();
restoreCustomization();
handleCheckoutReturn();
