const fs = require('node:fs');
const path = require('node:path');

const VIDEO_DIRECTORY = path.resolve(__dirname, '..', '..', '.generated-videos');

module.exports = async function sendVideoFile(req, res, filePath, download = false) {
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(`${VIDEO_DIRECTORY}${path.sep}`)) {
    return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato.' }));
  }

  let fileInfo;
  try {
    fileInfo = await fs.promises.stat(resolvedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato o scaduto.' }));
    }
    throw error;
  }
  if (!fileInfo.isFile()) {
    return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato.' }));
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="animadisegni-video.mp4"`);

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${fileInfo.size}`);
      return res.status(416).end();
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, fileInfo.size - Number(match[2]));
    let end = match[2] && match[1] ? Number(match[2]) : fileInfo.size - 1;
    if (start >= fileInfo.size || end < start) {
      res.setHeader('Content-Range', `bytes */${fileInfo.size}`);
      return res.status(416).end();
    }
    end = Math.min(end, fileInfo.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileInfo.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(resolvedPath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', fileInfo.size);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(resolvedPath).pipe(res);
};
