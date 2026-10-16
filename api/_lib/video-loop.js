const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_SOURCE_VIDEO_BYTES = 100 * 1024 * 1024;
const SOURCE_DURATION_SECONDS = 5;
const PING_PONG_CYCLES = 2;
const OUTPUT_DURATION_SECONDS = SOURCE_DURATION_SECONDS * 2 * PING_PONG_CYCLES;
const OUTPUT_DIRECTORY = path.resolve(__dirname, '..', '..', '.generated-videos');
const VIDEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const activeRenders = new Map();

function validateVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Kling returned an invalid source video URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Kling source video URLs must use HTTP or HTTPS without credentials.');
  }
  return url;
}

async function cleanupExpiredVideos() {
  await fs.promises.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const files = await fs.promises.readdir(OUTPUT_DIRECTORY, { withFileTypes: true });
  const now = Date.now();
  await Promise.all(files.map(async (file) => {
    if (!file.isFile() || !/^[\da-f-]{36}\.mp4$/i.test(file.name)) return;
    const filePath = path.join(OUTPUT_DIRECTORY, file.name);
    const stats = await fs.promises.stat(filePath);
    if (now - stats.mtimeMs > VIDEO_TTL_MS) await fs.promises.unlink(filePath);
  }));
}

async function downloadSourceVideo(videoUrl, destination, token) {
  const sourceUrl = validateVideoUrl(videoUrl);
  console.info(`[video:${token}] Downloading Kling output.`);
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download Kling output (HTTP ${response.status}).`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_VIDEO_BYTES) {
    throw new Error('Kling output exceeds the 100 MB processing limit.');
  }

  let bytesDownloaded = 0;
  const enforceSizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      bytesDownloaded += chunk.length;
      if (bytesDownloaded > MAX_SOURCE_VIDEO_BYTES) {
        callback(new Error('Kling output exceeds the 100 MB processing limit.'));
        return;
      }
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), enforceSizeLimit, fs.createWriteStream(destination, { flags: 'wx' }));
  console.info(`[video:${token}] Download complete (${bytesDownloaded} bytes).`);
}

function renderPingPong(sourcePath, outputPath, token) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath) {
      reject(new Error('FFmpeg binary is unavailable for this platform.'));
      return;
    }

    const filter = [
      `[0:v]trim=duration=${SOURCE_DURATION_SECONDS},setpts=PTS-STARTPTS,split=2[forward][reverse_input]`,
      '[reverse_input]reverse[reversed]',
      '[forward][reversed]concat=n=2:v=1:a=0,setpts=PTS-STARTPTS,split=2[cycle_a][cycle_b]',
      `[cycle_a][cycle_b]concat=n=${PING_PONG_CYCLES}:v=1:a=0,trim=duration=${OUTPUT_DURATION_SECONDS},setpts=PTS-STARTPTS[loop]`
    ].join(';');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-stream_loop', '-1',
      '-i', sourcePath,
      '-filter_complex', filter,
      '-map', '[loop]',
      '-an',
      '-t', String(OUTPUT_DURATION_SECONDS),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ];

    console.info(`[video:${token}] Rendering ${OUTPUT_DURATION_SECONDS}-second ping-pong loop with FFmpeg.`);
    const process = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    const timeout = setTimeout(() => process.kill(), 5 * 60 * 1000);
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-6000);
    });
    process.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start FFmpeg: ${error.message}`));
    });
    process.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.info(`[video:${token}] FFmpeg render complete.`);
        resolve();
      } else {
        reject(new Error(`FFmpeg failed with exit code ${code}: ${stderr.trim() || 'no details available'}`));
      }
    });
  });
}

async function renderVideoOnce(token, videoUrl) {
  const finalPath = path.join(OUTPUT_DIRECTORY, `${token}.mp4`);
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'little-moves-'));
  const sourcePath = path.join(temporaryDirectory, 'kling-source.mp4');
  const outputPath = path.join(temporaryDirectory, 'ping-pong.mp4');
  const startedAt = Date.now();

  try {
    await cleanupExpiredVideos();
    try {
      const existing = await fs.promises.stat(finalPath);
      if (existing.isFile()) return finalPath;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await downloadSourceVideo(videoUrl, sourcePath, token);
    await renderPingPong(sourcePath, outputPath, token);
    const outputInfo = await fs.promises.stat(outputPath);
    if (!outputInfo.isFile() || outputInfo.size === 0) throw new Error('FFmpeg produced an empty video file.');
    await fs.promises.rename(outputPath, finalPath);
    console.info(`[video:${token}] Saved ${OUTPUT_DURATION_SECONDS}-second preview (${outputInfo.size} bytes) in ${Date.now() - startedAt} ms.`);
    return finalPath;
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function renderLoopVideo(token, videoUrl) {
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) {
    throw new Error('Invalid generation ID for video rendering.');
  }
  if (activeRenders.has(token)) return activeRenders.get(token);
  const job = renderVideoOnce(token, videoUrl);
  activeRenders.set(token, job);
  try {
    return await job;
  } finally {
    activeRenders.delete(token);
  }
}

module.exports = { OUTPUT_DURATION_SECONDS, OUTPUT_DIRECTORY, renderLoopVideo };
