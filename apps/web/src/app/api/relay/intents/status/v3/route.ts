import { isCrossSite } from '@/app/api/index/upstream';
import { forward, isRequestId, refused, relayHeaders } from '../../../upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (isCrossSite(request)) return refused('This route answers this app only.', 403);

  const requestId = new URL(request.url).searchParams.get('requestId');
  if (!isRequestId(requestId)) return refused('requestId has to be the 32-byte id a quote returned.');

  return forward(`/intents/status/v3?requestId=${requestId}`, { method: 'GET', headers: relayHeaders() });
}
