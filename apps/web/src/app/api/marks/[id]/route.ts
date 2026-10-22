import { NextResponse } from 'next/server';

import { readEndowment, readMark } from '@/chain/endowments';
import { siteOrigin } from '@/chain/erc8004';

/**
 * A patron mark's metadata, for wallets and marketplaces. Read from the mark and its endowment on
 * every request, so nothing here can drift from the chain.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'A mark is a whole number.' }, { status: 400 });

  const mark = await readMark(BigInt(id));
  if (mark === undefined) return NextResponse.json({ error: 'No such mark.' }, { status: 404 });
  const endowment = await readEndowment(mark.endowment).catch(() => undefined);
  const agent = endowment === undefined ? 'an agent' : `Agent #${endowment.state.agentId.toString()}`;
  const origin = siteOrigin();

  return NextResponse.json(
    {
      name: `${mark.founding ? 'Founding patron' : 'Patron'} of ${agent}`,
      description: `${mark.founding ? 'A founding patron' : 'A patron'} of the endowment of ${agent} on Bursar. The principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it.`,
      image: `${origin}/api/marks/${id}/image`,
      external_url: `${origin}/endowments/${mark.endowment}`,
      attributes: [
        { trait_type: 'Agent', value: agent },
        { trait_type: 'Founding', value: mark.founding ? 'Yes' : 'No' },
        { trait_type: 'Endowment', value: mark.endowment },
        { display_type: 'date', trait_type: 'Became a patron', value: Number(mark.at) },
      ],
    },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
