import imageUpload from '../../../api/_lib/image-upload.js';

const { uploadImage } = imageUpload;

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Corpo della richiesta non valido.' }, { status: 400 });
    }
    return Response.json(await uploadImage(body.image, request), { status: 201 });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400
      : Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status >= 500) console.error('Errore durante il caricamento dell’immagine:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Caricamento dell’immagine non riuscito.' }, { status });
  }
}
