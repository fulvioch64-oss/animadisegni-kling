const { fal } = require('@fal-ai/client');
const { DEFAULT_ASPECT_RATIO } = require('./aspect-ratio.js');
const { TUNNEL_HELP } = require('./image-upload.js');

const DEFAULT_MODEL = 'v1.5-standard';
const FAL_TIMEOUT_MS = 8 * 60 * 1000;

// Each model declares how its payload is built. Fields not listed in the Fal schema (e.g. motion_strength,
// aspect_ratio for v3) are deliberately not sent, since Fal rejects unknown/invalid inputs.
// `motionVideoField` is the input name for a reference/guide dance video; null while no model supports it.
const MODELS = {
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

const QUALITY_CLAUSES = "without changing the character's appearance, preserving original crayon and marker texture, {BGQ}, smooth continuous motion, high frame rate, fluid animation";
const PHOTO_QUALITY_CLAUSES = "without changing the person's appearance or facial identity, {BGQ}, smooth continuous motion, high frame rate, fluid animation";
const INTROS = {
  faithful: "Animate this child's drawing as a 3D textured papercraft figurine with realistic depth, while strictly keeping 100% of the original felt-tip pen texture, crayon lines, and exact drawn face features. The character acts as a solid puppet painted with the original child's drawing, dancing smoothly {BG} without morphing.",
  real_photo: "Animate this real photo into a full-body 3D dancing avatar, strictly preserving 100% of the facial identity, skin tone, hair, and original features from the photo. The avatar dances smoothly {BG} with realistic lighting.",
  claymation: "Transform this child's drawing into a 3D claymation character, a clay figure with rounded volume, while keeping it faithful to the original child's artwork. Preserve the original shapes, asymmetrical hand-drawn lines, and original coloring. The character has rounded 3D depth and volume when turning, like an authentic handmade plasticine figurine crafted from a child's imagination. Placed {BG}, smooth 3D animation, happy dance movement."
};
const NEGATIVE_PROMPTS = {
  faithful: 'smooth plastic, claymation, redesigned features, realistic human face, 2D flat morphing, blurry, distorted',
  real_photo: 'drawing, crayon, marker lines, cartoon, claymation, papercraft, distorted face, extra limbs, background noise',
  claymation: 'flat 2D, flat paper cutout, thin 2D sheet, overly polished 3D render, smooth digital vector art, realistic human anatomy, background changes, blurry, jerky movement'
};
const DEFAULT_RENDER_STYLE = 'real_photo';

// Illustrated scenes (files in public/sfondi/). Fal image-to-video takes a single start image, so the scene is described in the prompt.
const BACKGROUNDS = {
  none: { bg: 'on a clean, pure white background', quality: 'white background', negative: '' },
  stanza_giochi: {
    bg: 'inside the colorful illustrated children\'s playroom already present in the input image, keeping that playroom background exactly as it is, static and unchanged, never fading to white and never showing the original photo background',
    quality: 'the illustrated playroom background stays unchanged throughout',
    negative: 'white background, changing background, original photo background, background dissolve'
  },
  palco_incantato: {
    bg: 'on the magical enchanted illustrated stage already present in the input image, keeping that stage background exactly as it is, static and unchanged, never fading to white and never showing the original photo background',
    quality: 'the illustrated enchanted stage background stays unchanged throughout',
    negative: 'white background, changing background, original photo background, background dissolve'
  },
  palco_neon: {
    bg: 'on the vibrant illustrated neon concert stage already present in the input image, keeping that stage background exactly as it is, static and unchanged, never fading to white and never showing the original photo background',
    quality: 'the illustrated neon stage background stays unchanged throughout',
    negative: 'white background, changing background, original photo background, background dissolve'
  }
};const DEFAULT_BACKGROUND = 'none';

function normalizeRenderStyle(value) {
  return value in INTROS ? value : DEFAULT_RENDER_STYLE;
}

function normalizeBackground(value) {
  return typeof value === 'string' && Object.hasOwn(BACKGROUNDS, value) ? value : DEFAULT_BACKGROUND;
}

// To add a music genre, add one entry here (key = motionPreset value sent by the client, normalized to lowercase letters/digits).
const DANCE_PROMPTS = {
  reggaeton: 'It dances reggaeton with a bouncy rhythmic groove: hip sways, shoulder rolls, playful steps and a happy spin.',
  disco: 'It dances to upbeat 1980s Italian-style disco pop: gentle side steps, clapping hands, bouncing on the feet, spinning once and waving to the audience.',
  hiphop: 'It dances hip-hop with playful bounce: rhythmic arm swings, small hops, a cheerful groove and a confident smile.',
  babydance: 'It does a cute baby dance: tiny bouncy steps, wobbling side to side, waving both hands and giggling with excitement.',
  salsa: 'It dances salsa with lively footwork: quick side steps, hip movement, a twirl and joyful arm gestures.',
  ballet: 'It dances an elegant, light ballet: graceful arm movements, tiptoe steps, a gentle pirouette and a happy bow.',
  waltz: 'It dances an elegant, graceful waltz in three-beat time: gliding turning steps, gentle swaying, arms held in a soft waltz pose, a slow twirl and a happy bow.',
  relax: 'It dances slowly and calmly to a gentle waltz: soft swaying from side to side, slow arm movements, a gentle turn and a peaceful smile.',
  sweet: 'It dances tenderly and emotionally: slow gentle sways, hands held to the heart, a soft twirl and a warm, loving smile.'
};
// Unified "style + music" ids (lowercase letters/digits after normalizeStyle) reuse the existing prompts.
const DANCE_ALIASES = {
  disco70: 'disco',
  claudiette: 'reggaeton',
  doodlecheerful: 'babydance',
  gentlewaltz: 'waltz'
};
Object.entries(DANCE_ALIASES).forEach(([alias, target]) => { DANCE_PROMPTS[alias] = DANCE_PROMPTS[target]; });
const DEFAULT_DANCE = 'It happily dances to an upbeat, joyful rhythm with cheerful family-party energy: gentle side steps, clapping hands, bouncing on the feet, spinning once, waving and smiling with excitement.';

function normalizeStyle(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function buildPrompt(motionPreset, renderStyle, background) {
  const dance = DANCE_PROMPTS[normalizeStyle(motionPreset)] || DEFAULT_DANCE;
  const style = normalizeRenderStyle(renderStyle);
  const scene = BACKGROUNDS[normalizeBackground(background)];
  const quality = (style === 'real_photo' ? PHOTO_QUALITY_CLAUSES : QUALITY_CLAUSES).replace('{BGQ}', scene.quality);
  return `${INTROS[style].replace('{BG}', scene.bg)} ${dance} The movements are smooth, rhythmic and full of happiness, ${quality}, high quality.`;
}

function buildNegativePrompt(renderStyle, background) {
  const scene = BACKGROUNDS[normalizeBackground(background)];
  return [NEGATIVE_PROMPTS[normalizeRenderStyle(renderStyle)], scene.negative].filter(Boolean).join(', ');
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

async function generateVideoFromImage(imageUrl, motionPreset, { referenceMotionVideoUrl = null, aspectRatio = DEFAULT_ASPECT_RATIO, renderStyle = DEFAULT_RENDER_STYLE, background = DEFAULT_BACKGROUND } = {}) {
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
      negative_prompt: buildNegativePrompt(renderStyle, background),
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

    return result.data.video.url;
  } catch (error) {
    console.error('[fal-video] generateVideoFromImage failed:', error?.status, error?.name, JSON.stringify(error?.body ?? error?.message));
    throw toFriendlyError(error);
  }
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

module.exports = { generateVideoFromImage, buildPrompt, DANCE_PROMPTS };
