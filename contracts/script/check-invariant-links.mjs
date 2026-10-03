#!/usr/bin/env node
// Checks docs/INVARIANTS.md against the invariant suites under contracts/test.
//
// Every statement on that page is a bullet, and under each bullet is a link to the test that
// checks it, of the form [`invariant_name`](../contracts/test/File.t.sol#L123). This script reads
// both sides and fails when they disagree: a bullet with no link, a link to a line that does not
// define the function it names, or an invariant_ function in the suites that no bullet links to.
//
//   node contracts/script/check-invariant-links.mjs          from the repository root
//
// It needs nothing but Node. The counts it prints are the two directions of the check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDir = join(root, 'contracts', 'test');
const docPath = join(root, 'docs', 'INVARIANTS.md');

// Every invariant_ function, afterInvariant hook and unit test in the suites, with the file it is
// in, relative to contracts/test, and the line that declares it. Only the invariant_ functions
// have to be linked; the others may be, and a link to one is checked the same way.
function* solidityFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* solidityFiles(path);
    else if (name.endsWith('.sol')) yield path;
  }
}

const declared = [];
for (const path of solidityFiles(testDir)) {
  const file = relative(testDir, path).split(sep).join('/');
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      const match = text.match(/^\s*function\s+(invariant_\w+|afterInvariant|test\w*)\s*\(/);
      if (match) declared.push({ name: match[1], file, line: index + 1 });
    });
}

// The page: bullets, and the links inside each bullet.
const doc = readFileSync(docPath, 'utf8').split('\n');
const linkPattern = /\[`?(\w+)`?\]\(\.\.\/contracts\/test\/([^)#]+)#L(\d+)\)/g;

const bullets = [];
let current = null;
doc.forEach((text, index) => {
  if (/^- /.test(text)) {
    current = { line: index + 1, text: text.slice(2), links: [] };
    bullets.push(current);
  } else if (current && /^\s+\S/.test(text)) {
    current.text += ' ' + text.trim();
  } else {
    current = null;
  }
});

const links = [];
for (const bullet of bullets) {
  for (const match of bullet.text.matchAll(linkPattern)) {
    const link = { name: match[1], file: match[2], line: Number(match[3]), bullet };
    bullet.links.push(link);
    links.push(link);
  }
}

// Direction one: every bullet has a link, and every link lands on the function it names.
const problems = [];
for (const bullet of bullets) {
  if (bullet.links.length === 0) {
    problems.push(`docs/INVARIANTS.md:${bullet.line}: no test linked under '${bullet.text.slice(0, 60)}...'`);
  }
}

const key = ({ name, file, line }) => `${file}#L${line} ${name}`;
const declaredByKey = new Map(declared.map((d) => [key(d), d]));
let landed = 0;
for (const link of links) {
  if (declaredByKey.has(key(link))) {
    landed += 1;
    continue;
  }
  const elsewhere = declared.filter((d) => d.name === link.name && d.file === link.file);
  const hint = elsewhere.length
    ? `the function is at line ${elsewhere.map((d) => d.line).join(', ')}`
    : 'no such function in that file';
  problems.push(
    `docs/INVARIANTS.md:${link.bullet.line}: ${link.file}#L${link.line} does not declare ${link.name}; ${hint}`,
  );
}

// Direction two: every invariant_ function in the suites is linked from the page.
const linkedKeys = new Set(links.map(key));
const invariants = declared.filter((d) => d.name.startsWith('invariant_'));
const unlinked = invariants.filter((d) => !linkedKeys.has(key(d)));
for (const d of unlinked) {
  problems.push(`${d.file}:${d.line}: ${d.name} is not linked from docs/INVARIANTS.md`);
}

const hooks = declared.filter((d) => d.name === 'afterInvariant');
const linkedHooks = hooks.filter((d) => linkedKeys.has(key(d)));
const linkedTests = links.filter((l) => l.name.startsWith('test')).length;

console.log(
  `${bullets.length} statements, ${bullets.filter((b) => b.links.length).length} with a test linked; ` +
    `${links.length} links, ${landed} land on the function they name`,
);
console.log(
  `${invariants.length} invariant_ functions in contracts/test, ${invariants.length - unlinked.length} linked; ` +
    `${hooks.length} afterInvariant hooks, ${linkedHooks.length} linked; ${linkedTests} links to unit tests`,
);

if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
