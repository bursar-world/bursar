import { refusal } from '../src/chain/preflight';

/**
 * Read the network this build is pointed at before anything is compiled.
 *
 * The same conditions are enforced inside the bundle, in src/chain/rhc.ts, which is where they
 * belong and the wrong place to read a refusal from: the bundler repeats the throw once per page it
 * was collecting, minifies the frame it came from, and reports the page it gave up on. The
 * variable that caused it never appears. This runs first, names the variable and stops.
 */
const refused = refusal(process.env);

if (refused !== undefined) {
  process.stderr.write(refused);
  process.exit(1);
}
