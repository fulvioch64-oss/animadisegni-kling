import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import store from '../../../api/_lib/store.js';
import videoLoop from '../../../api/_lib/video-loop.js';

const { getVideo } = store;
const { OUTPUT_DIRECTORY } = videoLoop;

export const runtime = 'nodejs';

function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('id');
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) {
    return jsonError('Invalid video ID.', 400);
  }

  try {
    const video = await getVideo(token);
    const expectedPath = path.join(OUTPUT_DIRECTORY, `${token}.mp4`);
    if (!video?.generatedVideoPath || path.resolve(video.generatedVideoPath) !== expectedPath) {
      return jsonError('Video not found or not ready yet.', 404);
    }
    const stats = await fs.promises.stat(expectedPath);
    if (!stats.isFile()) return jsonError('Video not found.', 404);

    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'inline; filename="little-moves-preview.mp4"'
    });
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!range || (!range[1] && !range[2])) {
        headers.set('Content-Range', `bytes */${stats.size}`);
        return new Response(null, { status: 416, headers });
      }
      const start = range[1] ? Number(range[1]) : Math.max(0, stats.size - Number(range[2]));
      const end = range[2] && range[1] ? Math.min(Number(range[2]), stats.size - 1) : stats.size - 1;
      if (start >= stats.size || end < start) {
        headers.set('Content-Range', `bytes */${stats.size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      headers.set('Content-Length', String(end - start + 1));
      const body = Readable.toWeb(fs.createReadStream(expectedPath, { start, end }));
      return new Response(body, { status: 206, headers });
    }

    headers.set('Content-Length', String(stats.size));
    const body = Readable.toWeb(fs.createReadStream(expectedPath));
    return new Response(body, { headers });
  } catch (error) {
    if (error.code === 'ENOENT') return jsonError('Video not found or expired.', 404);
    console.error('Unable to serve generated preview:', error);
    return jsonError('Preview is temporarily unavailable.', 503);
  }
}
