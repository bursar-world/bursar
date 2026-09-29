// Ops entry: recompute a posted solvency epoch from public chain data and compare it with the log.
//   tsx services/solvency/scripts/solvency-verify.ts [epoch]
import process from 'node:process';

process.argv.splice(2, 0, 'verify');
await import('../src/main.js');
