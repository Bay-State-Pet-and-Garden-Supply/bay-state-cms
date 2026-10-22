import { runArmBarrier } from './run-comparison';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const events: string[] = [];
await runArmBarrier(
  ['baseline', 'candidate'],
  async arm => { events.push(`preflight:${arm}`); return { prepared: arm }; },
  async arm => { events.push(`release:${arm}`); return arm; },
);
if (events.join(',') !== 'preflight:baseline,preflight:candidate,release:baseline,release:candidate') {
  throw new Error('Comparison runner released an arm before both-arm preflight completed.');
}
const script = path.resolve('scratch/comparison-arm.ts');
const result = spawnSync('bun', [script, '--arm', 'candidate'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
if (result.status !== 1 || !result.stderr.includes('Usage: bun scratch/comparison-arm.ts')) {
  throw new Error('Arm bootstrap CLI did not fail closed on incomplete disposable-runtime arguments.');
}
console.log(JSON.stringify({ smoke: 'arm-bootstrap-argument-denial', status: 'passed', external_credentials: false, runtime_dispatch: false }));
