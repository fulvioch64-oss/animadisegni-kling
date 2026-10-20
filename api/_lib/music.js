const fs = require('node:fs');
const path = require('node:path');

const AUDIO_DIRECTORY = path.resolve(__dirname, '..', '..', 'public', 'audio');

// Selectable soundtracks: id sent by the client -> MP3 file in public/audio/. To add one, add an entry here and a UI option.
const MUSIC_TRACKS = {
  disco70: 'Disco70.mp3',
  claudiette: 'Claudiette.MP3',
  doodle_cheerful: 'doodle cheerful.mp3',
  gentle_waltz: 'A Gentle Waltz.mp3'
};
const DEFAULT_MUSIC = 'disco70';
// Legacy dance-style ids (old clients, saved sessions) -> unified id.
const LEGACY_STYLES = {
  disco: 'disco70', reggaeton: 'claudiette', salsa: 'claudiette',
  hiphop: 'doodle_cheerful', babydance: 'doodle_cheerful',
  waltz: 'gentle_waltz', ballet: 'gentle_waltz', relax: 'gentle_waltz', sweet: 'gentle_waltz'
};

function pickTrack(musicId) {
  const key = typeof musicId === 'string' ? musicId : '';
  const legacy = LEGACY_STYLES[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
  const requested = Object.hasOwn(MUSIC_TRACKS, key) ? key : legacy;
  const id = requested || DEFAULT_MUSIC;
  const exists = (trackId) => fs.existsSync(path.join(AUDIO_DIRECTORY, MUSIC_TRACKS[trackId]));
  const finalId = exists(id) ? id : DEFAULT_MUSIC;
  return { id: finalId, file: MUSIC_TRACKS[finalId] };
}

// Only files declared above can be resolved, so user input can never select an arbitrary path.
function resolveTrackPath(file) {
  if (!Object.values(MUSIC_TRACKS).includes(file)) return null;
  const filePath = path.join(AUDIO_DIRECTORY, file);
  return fs.existsSync(filePath) ? filePath : null;
}

function trackUrl(file) {
  return file ? `/audio/${encodeURIComponent(file)}` : null;
}

module.exports = { MUSIC_TRACKS, DEFAULT_MUSIC, pickTrack, resolveTrackPath, trackUrl };
