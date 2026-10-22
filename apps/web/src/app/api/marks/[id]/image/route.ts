import { readEndowment, readMark } from '@/chain/endowments';

/** The mark's face: the agent it endows and whether the patron was among the first hundred. */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return new Response('A mark is a whole number.', { status: 400 });
  const mark = await readMark(BigInt(id));
  if (mark === undefined) return new Response('No such mark.', { status: 404 });
  const endowment = await readEndowment(mark.endowment).catch(() => undefined);
  const agent = endowment === undefined ? 'an agent' : `Agent #${endowment.state.agentId.toString()}`;
  const date = new Date(Number(mark.at) * 1000).toISOString().slice(0, 10);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#faf8f7"/>
  <rect x="60" y="60" width="880" height="880" fill="#ffffff" stroke="#ded8e0" stroke-width="2"/>
  <rect x="120" y="128" width="28" height="28" fill="#d99b89"/>
  <text x="168" y="152" font-family="ui-monospace, Menlo, monospace" font-size="30" letter-spacing="4" fill="#342440">BURSAR</text>
  <text x="120" y="420" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="600" fill="#342440">${mark.founding ? 'Founding' : ''}</text>
  <text x="120" y="530" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="600" fill="#342440">patron</text>
  <text x="120" y="620" font-family="Helvetica, Arial, sans-serif" font-size="44" fill="#675a6d">of ${escape(agent)}</text>
  <line x1="120" y1="800" x2="880" y2="800" stroke="#ded8e0" stroke-width="2"/>
  <text x="120" y="860" font-family="ui-monospace, Menlo, monospace" font-size="26" fill="#786b7d">MARK #${id} · ${date} · ROBINHOOD CHAIN</text>
</svg>`;

  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' } });
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
