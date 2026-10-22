import kling from '../../../api/_lib/kling.js';
import auth from '../../../api/_lib/auth.js';

const { createDance, getDanceStatus } = kling;
const { currentUser } = auth;

export const runtime = 'nodejs';

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request) {
  try {
    const user = await currentUser({ headers: { cookie: request.headers.get('cookie') || '' } });
    if (!user) return jsonResponse({ error: 'Sign in with Google to generate videos.', code: 'AUTH_REQUIRED' }, 401);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Corpo della richiesta non valido.' }, 400);
    }
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return jsonResponse(await createDance({ ...body, walletId: user.walletId }, clientIp));
  } catch (error) {
    const status = error instanceof SyntaxError ? 400
      : Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status >= 500) console.error('Errore API Kling:', error);
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Errore durante la generazione Kling.',
      ...(error.quota ? { quota: error.quota } : {})
    }, status);
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    return jsonResponse(await getDanceStatus(url.searchParams.get('generationToken')));
  } catch (error) {
    const status = error instanceof SyntaxError ? 400
      : Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status >= 500) console.error('Errore API Kling:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Errore durante la generazione Kling.' }, status);
  }
}
