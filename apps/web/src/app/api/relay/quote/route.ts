import { isCrossSite } from '@/app/api/index/upstream';
import { allowedQuote, forward, refused, relayHeaders } from '../upstream';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return refused('This route answers this app only.', 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refused('The quote has to be a JSON object.');
  }

  const checked = allowedQuote(body);
  if ('refused' in checked) return refused(checked.refused);

  return forward('/quote', {
    method: 'POST',
    headers: { ...relayHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(checked.body),
  });
}
