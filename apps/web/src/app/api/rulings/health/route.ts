import { forward } from '../../resolver';

/**
 * Whether the ruling service is polling the chain. An uptime check points here, because the
 * service itself has no public address and the daily heartbeat going quiet is the other signal.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return forward('/health');
}
