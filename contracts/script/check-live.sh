#!/usr/bin/env bash
# Checks the deployment that is live on Robinhood Chain against its record. It needs Foundry, Node
# and the Solidity dependencies the contracts README installs. It reads no key and sends nothing.
#
#   script/check-live.sh            # from contracts/
#
# It finds the one record under deployments/ whose status is live, asks the first endpoint that
# answers for chain 4663 (RHC_RPC_URL when set, then the two public ones), and runs every verify
# script over the record with BURSAR_VERIFY_STRICT=1, pinned to one block. The verify scripts print
# each value they read, so the report lists every contract address, every admin, owner and role
# holder, the timelock's delay and signers, each quorum, cap and limit, the verifiers and the
# wiring, next to anything that disagrees with the record or is still owed. Then it asks Sourcify
# for the match status of every contract in verification/manifest.json the record names.
#
# The report goes to stdout and to deployments/checks/<network>.md, with the block and its time.
# The exit status is 0 when the chain matches the record with nothing owed and Sourcify knows every
# contract, 1 when anything disagrees, and 2 when the check could not run or a verify script
# stopped partway, which a record from before a read it makes does; the report then holds what was
# read up to there.
set -euo pipefail
cd "$(dirname "$0")/.."

chain=4663
endpoints=(${RHC_RPC_URL:+"$RHC_RPC_URL"} https://rpc.mainnet.chain.robinhood.com https://robinhood.drpc.org)

stop() {
  echo "$1" >&2
  exit 2
}

for tool in forge cast node; do
  command -v "$tool" >/dev/null || stop "$tool is not installed: see \"Build and test\" in README.md"
done
[ -d lib/forge-std ] || stop "lib/ is empty: run the forge install command under \"Build and test\" in README.md"

# A shell set up for a rehearsal or a deployment carries variables the verify scripts would read.
unset BURSAR_LOCAL BURSAR_ENV_PREFIX BURSAR_CHAIN_ID BURSAR_SETTLEMENT_ASSET BURSAR_PREVIOUS_RECORD

record="$(node -e '
  const fs = require("fs");
  const live = fs.readdirSync("deployments").filter((file) => {
    if (!file.endsWith(".json") || file === "schema.json") return false;
    const record = JSON.parse(fs.readFileSync(`deployments/${file}`, "utf8"));
    return record.status === "live" && !record.local;
  });
  if (live.length !== 1) {
    console.error(`deployments/ holds ${live.length} live records, and the check needs exactly one`);
    process.exit(1);
  }
  console.log(`deployments/${live[0]}`);
')" || exit 2
field() {
  node -e 'const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value !== undefined) console.log(value);' "$record" "$1"
}
network="$(field network)"
# The record this one replaced, which the verify scripts read to tell what a carried contract
# still owes the previous set, and to check that set's shielded pool takes no more deposits.
previous="deployments/$(field supersedes).json"
if [ -f "$previous" ]; then export BURSAR_PREVIOUS_RECORD="$previous"; fi

rpc=""
tried=()
for url in "${endpoints[@]}"; do
  if [ "$(cast chain-id --rpc-url "$url" --rpc-timeout 20 2>/dev/null || true)" = "$chain" ]; then
    rpc="$url"
    tried+=("$url answered")
    break
  fi
  tried+=("$url did not answer as chain $chain")
done
if [ -z "$rpc" ]; then
  printf '%s\n' "${tried[@]}" >&2
  stop "no endpoint answered for chain $chain"
fi

block="$(cast block-number --rpc-url "$rpc")"
stamp="$(cast block "$block" --field timestamp --rpc-url "$rpc")"
when="$(node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"))' "$stamp")"
echo "checking $network at block $block through $rpc" >&2

set +e
output="$(BURSAR_RECORD="$record" BURSAR_VERIFY_STRICT=1 forge script script/Verify.s.sol \
  --rpc-url "$rpc" --fork-block-number "$block" 2>&1)"
set -e
summary="$(sed -n 's/^ *\(deployment: [0-9]* mismatched, [0-9]* owed\)$/\1/p' <<<"$output" | tail -1)"
# A verify script that reverts, on a record from before a read it makes, leaves no summary. The
# report then carries what was read up to there and the refusal.
stopped=""
if [ -z "$summary" ]; then
  stopped="$(sed -n 's/^Error: script failed: //p' <<<"$output" | tail -1)"
  if [ -z "$stopped" ]; then
    tail -n 25 <<<"$output" >&2
    stop "the verify run did not reach its summary"
  fi
  summary="stopped: $stopped"
fi
# The wiring check reads some of what the staking check read; each value is listed once.
facts="$(sed -n 's/^ *fact      \(.*\) = \(.*\)$/| \1 | \2 |/p' <<<"$output" | awk '!seen[$0]++')"
findings="$(sed -n -e 's/^ *MISMATCH  /- mismatch: /p' -e 's/^ *owed      /- owed: /p' <<<"$output")"
if [ -n "$stopped" ]; then
  findings="- the verify run stopped before its summary: $stopped${findings:+$'\n'$findings}"
fi

# Every manifest entry whose address the record names, in the manifest's order.
sourcify="$(node - "$record" verification/manifest.json "$chain" <<'EOF'
const fs = require('fs');
const [recordPath, manifestPath, chain] = process.argv.slice(2);
const named = new Set();
(function collect(value) {
  if (typeof value === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) named.add(value.toLowerCase());
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(collect);
  }
})(JSON.parse(fs.readFileSync(recordPath, 'utf8')));

(async () => {
  for (const [name, entry] of Object.entries(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))) {
    if (!named.has(entry.address.toLowerCase())) continue;
    let match;
    try {
      const answer = await fetch(`https://sourcify.dev/server/v2/contract/${chain}/${entry.address}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (answer.status === 200) match = (await answer.json()).match ?? 'not verified';
      else if (answer.status === 404) match = 'not verified';
      else match = `no answer (HTTP ${answer.status})`;
    } catch {
      match = 'no answer';
    }
    console.log(`| ${name} | ${entry.address} | ${match} |`);
  }
})();
EOF
)"
unverified="$(grep -c '| not verified |$' <<<"$sourcify" || true)"
unanswered="$(grep -c '| no answer' <<<"$sourcify" || true)"
if [ "$unverified" -ne 0 ]; then
  findings="$findings${findings:+$'\n'}$(sed -n 's/^| \(.*\) | \(.*\) | not verified |$/- not verified on Sourcify: \1 \2/p' <<<"$sourcify")"
fi

result=PASS
if [ "$summary" != "deployment: 0 mismatched, 0 owed" ] || [ "$unverified" -ne 0 ]; then result=FAIL; fi
if [ -n "$stopped" ]; then result=STOPPED; fi

report="deployments/checks/$network.md"
mkdir -p deployments/checks
{
  echo "# Live deployment check: $network"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Result | $result |"
  echo "| Record | \`$record\` |"
  echo "| Chain | $chain |"
  echo "| Block | $block |"
  echo "| Time | $when |"
  echo "| Endpoint | $rpc |"
  echo "| Strict verify | $summary |"
  echo "| Sourcify | $(grep -c . <<<"$sourcify" || true) contracts asked, $unverified not verified, $unanswered unanswered |"
  echo
  echo "## Findings"
  echo
  if [ -n "$findings" ]; then echo "$findings"; else echo "None: every value read matches the record, and nothing is owed."; fi
  echo
  echo "## What the chain answers"
  echo
  echo "Every value the verify scripts read at block $block, in the order they read it${stopped:+, up to where the run stopped}."
  echo
  echo "| Read | Value |"
  echo "|---|---|"
  echo "$facts"
  echo
  echo "## Source verification on Sourcify"
  echo
  echo "| Contract | Address | Match |"
  echo "|---|---|---|"
  echo "$sourcify"
  echo
  echo "## Endpoints tried"
  echo
  printf -- '- %s\n' "${tried[@]}"
} >"$report"
cat "$report"

[ -z "$stopped" ] || exit 2
[ "$result" = PASS ]
