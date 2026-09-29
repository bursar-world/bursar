import { forward, json } from '../resolver';

/**
 * A published ruling, by dispute id.
 *
 * Before the resolvers reveal, the service answers that the score is sealed and says nothing else,
 * which is what keeps a vote from being copied. Nothing is cached here for the same reason: a
 * sealed answer held by a cache would outlive the reveal.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const asked = new URL(request.url).searchParams;
  const dispute = asked.get('dispute') ?? '';
  if (!/^\d{1,20}$/.test(dispute) || dispute === '0') {
    return json({ error: 'dispute_invalid', detail: 'dispute is the registry\'s dispute id, a whole number from 1.' }, 400);
  }

  const registry = asked.get('registry');
  if (registry !== null && !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    return json({ error: 'registry_invalid', detail: 'registry is a 20-byte hex address.' }, 400);
  }

  const answer = await forward(`/rulings/${dispute}${registry === null ? '' : `?registry=${registry}`}`);
  // No ruling published for this dispute is an answer, not a failed request. Passed through as a
  // 404 it lands in every reader's console as an error on each load of a desk with an old dispute.
  if (answer.status === 404) return json({ status: 'none' }, 200);
  return answer;
}
