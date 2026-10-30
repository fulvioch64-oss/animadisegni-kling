const { fal } = require('@fal-ai/client');
const { DEFAULT_ASPECT_RATIO } = require('./aspect-ratio.js');
const { TUNNEL_HELP } = require('./image-upload.js');

const DEFAULT_MODEL = 'v2.5-turbo-standard';
const FAL_TIMEOUT_MS = 8 * 60 * 1000;

// Each model declares how its payload is built. Fields not listed in the Fal schema (e.g. motion_strength,
// aspect_ratio for v3) are deliberately not sent, since Fal rejects unknown/invalid inputs.
// `motionVideoField` is the input name for a reference/guide dance video; null while no model supports it.
const MODELS = {
  'v2.5-turbo-standard': {
    id: 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video',
    imageField: 'image_url',
    motionVideoField: null,
    aspectRatioField: 'aspect_ratio',
    extraInput: { cfg_scale: 0.5 }
  },
  'v1.5-standard': {
    id: 'fal-ai/kling-video/v1.5/standard/image-to-video',
    imageField: 'image_url',
    motionVideoField: null,
    aspectRatioField: 'aspect_ratio',
    extraInput: { cfg_scale: 0.5 }
  },
  'v3-pro': {
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    imageField: 'start_image_url',
    motionVideoField: null,
    aspectRatioField: null,
    extraInput: { generate_audio: false, cfg_scale: 0.5 }
  },
  'v2.5-turbo-pro': {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    imageField: 'image_url',
    motionVideoField: null,
    extraInput: { cfg_scale: 0.5 }
  }
};

// Prompts per render style. 'real_photo' is the "Real Draw" option of the UI; 'faithful' is accepted as an alias.
// {DANCE} is replaced with the dance action of the selected music track.
const INTROS = {
  real_photo: "2D character animation of a children's drawing on a clean paper background. The character performs a {DANCE}. Keep the original illustration lines intact, smooth motion, no background generation, no extra scene elements, no warping.",
  claymation: "3D claymation character animation of a children's illustration, bringing the character into a vibrant 3D animated style. The character performs a {DANCE}. Smooth motion, clean environment, high quality render."
};
INTROS.faithful = INTROS.real_photo;
const NEGATIVE_PROMPT = 'text, letters, watermark, extra limbs, page splitting, card opening, frame morphing, camera movement, blurry, low resolution, distortion, background generation, turning around, 360 rotation, showing back, profile view, turning back to camera, spin, revolving, delayed motion, static opening';
const DEFAULT_RENDER_STYLE = 'real_photo';
// Appended to every prompt: immediate motion and strictly frontal dancing.
const MOTION_RULES = 'The character starts dancing dynamically from frame 1, instant rhythmic action with zero delay, no static pause at start. Strictly face-forward dance only: the character must remain 100% facing front towards the viewer at all times, with side-to-side steps, arm waving, bouncing up and down, no body rotations, no spinning.';

// Dance action per music style (key = motionPreset sent by the client, normalized to lowercase letters/digits).
// To add a music genre, add one entry here.
const DANCE_PROMPTS = {
  reggaeton: 'bouncy reggaeton dance with a rhythmic groove: hip sways, shoulder rolls, playful side steps and a happy smile',
  disco: 'classic upbeat 1980s Italian-style disco pop dance: gentle side steps, clapping hands, bouncing on the feet and waving to the audience',
  hiphop: 'playful hip-hop dance with bounce: rhythmic arm swings, small hops, a cheerful groove and a confident smile',
  pop: 'catchy pop dance: energetic side steps, arm waves, bouncing up and down and a bright smile',
  latin: 'lively latin dance with quick footwork: side steps, hip movement and joyful arm gestures',
  babydance: 'cute baby dance: tiny bouncy steps, wobbling side to side, waving both hands and giggling with excitement',
  salsa: 'lively salsa dance with quick footwork: side steps, hip movement and joyful arm gestures',
  ballet: 'elegant, light ballet dance: graceful arm movements, tiptoe steps, gentle swaying and a happy bow',
  waltz: 'graceful waltz in three-beat time: gliding side steps, gentle swaying, arms held in a soft waltz pose and a happy bow',
  relax: 'slow, calm dance to a gentle waltz: soft swaying from side to side, slow arm movements and a peaceful smile',
  sweet: 'tender, emotional dance: slow gentle sways, hands held to the heart and a warm, loving smile'
};
// Unified "style + music" ids (lowercase letters/digits after normalizeStyle) reuse the existing prompts.
const DANCE_ALIASES = {
  disco70: 'disco',
  claudiette: 'reggaeton',
  doodlecheerful: 'babydance',
  gentlewaltz: 'waltz'
};
Object.entries(DANCE_ALIASES).forEach(([alias, target]) => { DANCE_PROMPTS[alias] = DANCE_PROMPTS[target]; });
const DEFAULT_DANCE = 'joyful dance to an upbeat rhythm with cheerful family-party energy: gentle side steps, clapping hands, bouncing on the feet, waving and smiling with excitement';

function normalizeStyle(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function normalizeRenderStyle(value) {
  return typeof value === 'string' && Object.hasOwn(INTROS, value) ? value : DEFAULT_RENDER_STYLE;
}

function buildPrompt(motionPreset, renderStyle, background) {
  const dance = DANCE_PROMPTS[normalizeStyle(motionPreset)] || DEFAULT_DANCE;
  const prompt = INTROS[normalizeRenderStyle(renderStyle)].replace('{DANCE}', dance) + ' ' + MOTION_RULES;
  if (!background || background === 'original') return prompt;
  // The scene is already part of the source image: keep it instead of forbidding background content.
  return prompt
    .replace(' on a clean paper background', ' on an illustrated scene')
    .replace('no background generation, no extra scene elements, ', '')
    + ' Keep the illustrated scene behind the character exactly as in the image.';
}

function buildNegativePrompt(background) {
  return background && background !== 'original'
    ? NEGATIVE_PROMPT.replace(', background generation', ', background change')
    : NEGATIVE_PROMPT;
}

function resolveModel() {
  const key = process.env.FAL_MODEL || DEFAULT_MODEL;
  const model = MODELS[key];
  if (!model) throw new Error(`FAL_MODEL non valido: usa ${Object.keys(MODELS).join(' o ')}.`);
  return model;
}

function getFalKey() {
  // Strip whitespace, line breaks, BOM/zero-width characters and wrapping quotes.
  return (process.env.FAL_KEY || '')
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .replace(/^["']|["']$/g, '');
}

async function assertImageReachable(imageUrl) {
  let response;
  try {
    response = await fetch(imageUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    response = null;
    console.error('[fal-video] Image URL preflight failed:', error.message);
  }
  const type = response?.headers.get('content-type') || '';
  if (!response || !response.ok || !type.startsWith('image/')) {
    const detail = response ? `HTTP ${response.status}` : 'nessuna risposta';
    const hint = response?.status === 404 || response?.status === 530 || response?.status === 502 || !response
      ? 'Il tunnel temporaneo è probabilmente scaduto o spento: riavvialo, copia il nuovo URL in PUBLIC_BASE_URL (.env.local) e riavvia il server.'
      : 'Controlla che il tunnel di PUBLIC_BASE_URL sia attivo e punti a questo server.';
    console.error(TUNNEL_HELP(`L’immagine ${imageUrl} non è raggiungibile (${detail})`));
    const error = new Error(`L’immagine non è raggiungibile pubblicamente (${detail}). ${hint}`);
    error.statusCode = 502;
    throw error;
  }
}

async function generateVideoFromImage(imageUrl, motionPreset, { referenceMotionVideoUrl = null, aspectRatio = DEFAULT_ASPECT_RATIO, renderStyle = DEFAULT_RENDER_STYLE, background = 'original' } = {}) {
  try {
    const falKey = getFalKey();
    console.log('FAL_KEY caricata:', falKey ? 'Presente' : 'Mancante');
    if (!falKey) {
      const error = new Error('Configura FAL_KEY in .env.local per usare Fal.ai.');
      error.statusCode = 503;
      throw error;
    }
    // The client sends "Authorization: Key <FAL_KEY>" on every request.
    fal.config({ credentials: falKey });
    console.log('[fal-video] Final image URL sent to Fal.ai:', imageUrl);
    // Images uploaded to Fal storage are already reachable by Fal: the tunnel preflight only applies to self-hosted URLs.
    if (!/^https:\/\/[^/]*\.(?:fal\.media|fal\.run|fal\.ai)\//i.test(imageUrl)) await assertImageReachable(imageUrl);
    const model = resolveModel();
    const input = {
      [model.imageField]: imageUrl,
      prompt: buildPrompt(motionPreset, renderStyle, background),
      negative_prompt: buildNegativePrompt(background),
      duration: '5',
      ...model.extraInput
    };
    // Kling image-to-video takes its format from the source image (already fitted to the chosen ratio),
    // so the field is only sent for models that declare one.
    if (model.aspectRatioField) input[model.aspectRatioField] = aspectRatio;
    // Future: guide video for dance steps, only sent when the selected model supports it.
    if (referenceMotionVideoUrl && model.motionVideoField) input[model.motionVideoField] = referenceMotionVideoUrl;
    console.info(`[fal-video] Calling ${model.id} with payload:`, JSON.stringify({ input }));
    const result = await fal.subscribe(model.id, { input, logs: true, abortSignal: AbortSignal.timeout(FAL_TIMEOUT_MS) });

    return extractVideoUrl(result);
  } catch (error) {
    console.error('[fal-video] generateVideoFromImage failed:', error?.status, error?.name, JSON.stringify(error?.body ?? error?.message));
    throw toFriendlyError(error);
  }
}

// Fal models return the video in slightly different shapes: check them in order and accept only a valid http(s) URL.
function extractVideoUrl(result) {
  const candidates = [result?.data?.video?.url, result?.data?.video_url, result?.data?.videos?.[0]?.url];
  const url = candidates.find((value) => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim()));
  if (!url) {
    console.error('[fal-video] No valid video URL in the Fal.ai response:', JSON.stringify(result?.data));
    const error = new Error('Fal.ai ha risposto senza un URL video valido. Nessun credito è stato scalato: riprova.');
    error.statusCode = 502;
    error.code = 'GENERATION_FAILED';
    throw error;
  }
  return url.trim();
}

// Turns Fal/network failures into explicit messages for the frontend, keeping the original as `cause`.
function toFriendlyError(error) {
  if (error?.statusCode && error.message) return error;
  const status = error?.status;
  const detail = JSON.stringify(error?.body?.detail ?? error?.body ?? '') || '';
  let message;
  let statusCode = 502;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    message = `Fal.ai non ha completato il video entro ${Math.round(FAL_TIMEOUT_MS / 60000)} minuti (timeout). Riprova tra poco.`;
    statusCode = 504;
  } else if (status === 401 || status === 403) {
    message = 'FAL_KEY non valida o senza permessi: controlla la chiave in .env.local.';
    statusCode = 503;
  } else if (status === 402 || /balance|exhausted|credit/i.test(detail)) {
    message = 'Credito Fal.ai esaurito: ricarica il saldo su fal.ai.';
    statusCode = 503;
  } else if (status === 422 || /image|format|unsupported/i.test(detail)) {
    message = `Fal.ai ha rifiutato l’immagine o i parametri (formato non supportato?): ${detail.slice(0, 200)}`;
    statusCode = 422;
  } else if (status === 429) {
    message = 'Troppe richieste a Fal.ai: attendi un momento e riprova.';
    statusCode = 429;
  } else if (error?.cause?.code || /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(error?.message || '')) {
    message = 'Impossibile contattare Fal.ai (errore di rete): controlla la connessione internet.';
    statusCode = 503;
  } else {
    message = `Errore Fal.ai${status ? ` (HTTP ${status})` : ''}: ${error?.message || 'errore sconosciuto'}`;
  }
  const friendly = new Error(message, { cause: error });
  friendly.statusCode = statusCode;
  return friendly;
}

module.exports = { generateVideoFromImage, buildPrompt, buildNegativePrompt };
