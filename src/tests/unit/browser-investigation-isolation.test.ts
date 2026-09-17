// T3 (#227) — investigation isolation posture + fail-closed gating (Vitest, pure).
//
// Container posture enforced: no host networking or privileged mode, no
// Docker socket, no credentials or host-profile mounts, non-root with
// dropped capabilities and no-new-privileges, retained browser and container
// sandboxes, read-only root with narrow bounded exceptions, explicit
// CPU/memory/process limits, fresh state per run with deterministic teardown.
// Missing isolation fails closed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  INVESTIGATION_CONTAINER_IMAGE,
  IsolationError,
  assertContainerPosture,
  buildInvestigationContainerSpec,
  checkIsolationAvailable,
  containerNameForRun,
  containerSpecToDockerArgs,
  isInvestigationSlotHeld,
  releaseInvestigationSlot,
  tryAcquireInvestigationSlot,
  withIsolatedRun,
  type ContainerLimitOverrides,
  type InvestigationContainerSpec,
  type IsolationStatus,
} from '../../onboarding/browser-investigation/isolation';

const ENV_KEY = 'BAYSTATE_INVESTIGATION_ISOLATION';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  releaseInvestigationSlot();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  releaseInvestigationSlot();
});

describe('container posture (deny by default)', () => {
  it('builds a deny-by-default spec', () => {
    const spec = buildInvestigationContainerSpec('binvrun_1');
    expect(spec.image).toBe(INVESTIGATION_CONTAINER_IMAGE);
    expect(spec.networkMode).toBe('none');
    expect(spec.privileged).toBe(false);
    expect(spec.capDrop).toContain('ALL');
    expect(spec.capAdd).toEqual([]);
    expect(spec.securityOpt).toContain('no-new-privileges');
    expect(spec.user).not.toMatch(/^(root|0)/);
    expect(spec.readOnlyRootFilesystem).toBe(true);
    expect(Object.keys(spec.tmpfs).length).toBeGreaterThan(0);
    expect(spec.mounts).toEqual([]);
    expect(spec.env).toEqual({});
    expect(spec.cpus).toBeGreaterThan(0);
    expect(spec.memory).toMatch(/^\d+[mg]$/i);
    expect(spec.pidsLimit).toBeGreaterThan(0);
    expect(spec.browserArgs).not.toContain('--no-sandbox');
    expect(spec.teardown).toBe('always-remove');
    expect(() => assertContainerPosture(spec)).not.toThrow();
  });

  it.each([
    ['host networking', (s) => ({ ...s, networkMode: 'host' })],
    ['bridge networking', (s) => ({ ...s, networkMode: 'bridge' })],
    ['privileged mode', (s) => ({ ...s, privileged: true })],
    ['retained capabilities', (s) => ({ ...s, capDrop: [] })],
    ['added capabilities', (s) => ({ ...s, capAdd: ['NET_RAW'] })],
    ['missing no-new-privileges', (s) => ({ ...s, securityOpt: [] })],
    ['root user', (s) => ({ ...s, user: 'root' })],
    ['uid-zero user', (s) => ({ ...s, user: '0:0' })],
    ['writable root', (s) => ({ ...s, readOnlyRootFilesystem: false })],
    ['no tmpfs scratch', (s) => ({ ...s, tmpfs: {} })],
    ['unbounded tmpfs', (s) => ({ ...s, tmpfs: { '/tmp': 'mode=1777' } })],
    ['docker socket mount', (s) => ({ ...s, mounts: ['/var/run/docker.sock:/var/run/docker.sock'] })],
    ['host profile mount', (s) => ({ ...s, mounts: ['/home/op/.config:/home/browser/.config'] })],
    ['secret env', (s) => ({ ...s, env: { BAYSTATE_API_TOKEN: 's3cret' } })],
    ['provider key env', (s) => ({ ...s, env: { BROWSER_USE_API_KEY: 'x' } })],
    ['missing cpu limit', (s) => ({ ...s, cpus: 0 })],
    ['missing memory limit', (s) => ({ ...s, memory: '' })],
    ['missing process limit', (s) => ({ ...s, pidsLimit: 0 })],
    ['sandbox disabled', (s) => ({ ...s, browserArgs: [...s.browserArgs, '--no-sandbox'] })],
    ['substitute image', (s) => ({ ...s, image: 'evil/browser:latest' })],
    ['empty image', (s) => ({ ...s, image: '' })],
    ['oversized single tmpfs', (s) => ({ ...s, tmpfs: { '/tmp': 'size=2048m,mode=1777' } })],
    [
      'oversized total tmpfs',
      (s) => ({ ...s, tmpfs: { '/a': 'size=1024m', '/b': 'size=1024m', '/c': 'size=1024m' } }),
    ],
    ['no run identity', (s) => ({ ...s, runId: '' })],
    ['no teardown', (s) => ({ ...s, teardown: 'never' })],
  ] as Array<[string, (s: InvestigationContainerSpec) => InvestigationContainerSpec]>)(
    'rejects %s',
    (_label, mutate) => {
      const spec = mutate(buildInvestigationContainerSpec('binvrun_1'));
      expect(() => assertContainerPosture(spec)).toThrowError(IsolationError);
      expect(() => assertContainerPosture(spec)).toThrowError(/isolation_unavailable/);
    },
  );

  it('requires a scoped runId for fresh per-run state', () => {
    expect(() => buildInvestigationContainerSpec('')).toThrowError(IsolationError);
    expect(() => buildInvestigationContainerSpec('../../evil')).toThrowError(IsolationError);
  });

  it('derives deterministic container names shared by launch and teardown', () => {
    expect(containerNameForRun('binvrun_abc-123_X')).toBe('binv-binvrun_abc-123_X');
    expect(() => containerNameForRun('')).toThrowError(IsolationError);
    expect(() => containerNameForRun('!!!')).toThrowError(IsolationError);
  });
});

describe('docker argv (auditable denial flags)', () => {
  it('translates posture to deny-by-default docker run flags', () => {
    const limits: ContainerLimitOverrides = { cpus: 1, memory: '1g', pidsLimit: 128 };
    const args = containerSpecToDockerArgs(buildInvestigationContainerSpec('binvrun_9', limits));
    const joined = args.join(' ');
    expect(args[0]).toBe('run');
    expect(joined).toContain('--network=none');
    expect(joined).toContain('--cap-drop=ALL');
    expect(joined).toContain('--security-opt=no-new-privileges');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--user=');
    expect(joined).toContain('--cpus=');
    expect(joined).toContain('--memory=');
    expect(joined).toContain('--pids-limit=');
    expect(joined).toContain('--rm');
    expect(joined).not.toContain('--privileged');
    expect(joined).not.toContain('--network=host');
    expect(joined).not.toContain('--no-sandbox');
    expect(joined).not.toContain('docker.sock');
  });

  it('refuses to render argv for a violated spec', () => {
    const bad = { ...buildInvestigationContainerSpec('x'), privileged: true };
    expect(() => containerSpecToDockerArgs(bad)).toThrowError(IsolationError);
  });
});

describe('isolation availability gating', () => {
  it('fails closed without explicit enablement (no subprocess spawned)', async () => {
    delete process.env[ENV_KEY];
    let probed = false;
    const status = await checkIsolationAvailable({
      dockerReachable: async () => {
        probed = true;
        return true;
      },
    });
    expect(status.available).toBe(false);
    expect(probed).toBe(false);
  });

  it('fails closed when the runtime is unreachable despite enablement', async () => {
    process.env[ENV_KEY] = 'ready';
    const status = await checkIsolationAvailable({ dockerReachable: async () => false });
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/unreachable/);
  });

  it('fails closed when the probe throws', async () => {
    process.env[ENV_KEY] = 'ready';
    const status = await checkIsolationAvailable({
      dockerReachable: async () => {
        throw new Error('daemon gone');
      },
    });
    expect(status.available).toBe(false);
  });

  it('reports available only with enablement AND a reachable runtime', async () => {
    process.env[ENV_KEY] = 'ready';
    const status: IsolationStatus = await checkIsolationAvailable({ dockerReachable: async () => true });
    expect(status.available).toBe(true);
  });

  it('carries a stable machine-readable code on posture violations', () => {
    try {
      assertContainerPosture({ ...buildInvestigationContainerSpec('binvrun_1'), privileged: true });
      expect.unreachable('privileged spec must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(IsolationError);
      expect((err as IsolationError).code).toBe('isolation_unavailable');
    }
  });
});

describe('serialization + deterministic teardown', () => {
  it('serializes local investigations (one at a time)', () => {
    expect(tryAcquireInvestigationSlot()).toBe(true);
    expect(isInvestigationSlotHeld()).toBe(true);
    expect(tryAcquireInvestigationSlot()).toBe(false);
    releaseInvestigationSlot();
    expect(isInvestigationSlotHeld()).toBe(false);
    expect(tryAcquireInvestigationSlot()).toBe(true);
  });

  it('tears down on success, failure, and cancellation alike', async () => {
    const tornDown: string[] = [];
    const runner = { teardown: async (runId: string) => void tornDown.push(runId) };
    await withIsolatedRun('run_ok', runner, async () => 'done');
    expect(tornDown).toEqual(['run_ok']);
    await expect(
      withIsolatedRun('run_fail', runner, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrowError('boom');
    expect(tornDown).toEqual(['run_ok', 'run_fail']);
  });

  it('never lets teardown mask the run outcome', async () => {
    const runner = {
      teardown: async () => {
        throw new Error('teardown exploded');
      },
    };
    await expect(withIsolatedRun('run_x', runner, async () => 'fine')).resolves.toBe('fine');
    await expect(
      withIsolatedRun('run_y', runner, async () => {
        throw new Error('original');
      }),
    ).rejects.toThrowError('original');
  });
});
