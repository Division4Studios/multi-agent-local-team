/** The Docker reviewer's identity and hardening (#34): it reads exactly what the developer can, and never runs as root. */
import assert from 'node:assert/strict';
import { containerIdentity, containerLimits, containerSpec } from '../../backend/dockerBackend';
import type { UserContext } from '../../backend/dockerBackend';
import { isRecord } from '../../shared/guards';
import type { TestCase } from './harness';

const native = { OperatingSystem: 'Ubuntu 24.04.1 LTS', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'] };
const linux: UserContext = { platform: 'linux', uid: 1001, gid: 1002, groups: [1002, 1000, 27, 1000], engine: native };
const node = { user: 'node', groups: [] };

export const tests: readonly TestCase[] = [
  {
    name: 'docker reviewer: on a native, rootful Linux engine it runs as the developer with their groups, otherwise as node',
    run: (): void => {
      assert.deepEqual(containerIdentity(linux), { user: '1001:1002', groups: ['1000', '27'] },
        'the developer’s UID and GID, plus each supplementary group once (the primary group is already the GID)');
      assert.deepEqual(containerIdentity({ ...linux, groups: [0, 1002, 1000] }), { user: '1001:1002', groups: ['1000'] }, 'never the root group');
      assert.deepEqual(containerIdentity({ ...linux, groups: [] }), { user: '1001:1002', groups: [] });
      const cases: readonly (readonly [string, UserContext])[] = [
        ['Docker Desktop maps file ownership itself', { ...linux, engine: { ...native, OperatingSystem: 'Docker Desktop' } }],
        ['rootless Docker maps container IDs to other host IDs', { ...linux, engine: { ...native, SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] } }],
        ['never root, even when VS Code runs as root', { ...linux, uid: 0, gid: 0 }],
        ['never the root group as primary group', { ...linux, gid: 0 }],
        ['Windows', { ...linux, platform: 'win32', uid: undefined, gid: undefined, groups: [] }],
        ['macOS (Docker Desktop)', { ...linux, platform: 'darwin' }],
        ['an unreadable /info keeps the previous behavior', { ...linux, engine: undefined }],
        ['an /info without security options is not trusted to be rootful', { ...linux, engine: { OperatingSystem: 'Ubuntu 24.04.1 LTS' } }],
        ['a malformed security option is not trusted either', { ...linux, engine: { ...native, SecurityOptions: [42] } }],
      ];
      for (const [reason, context] of cases) {
        assert.deepEqual(containerIdentity(context), node, `${reason}: node, and no extra groups`);
      }
    },
  },
  {
    name: 'docker reviewer: the container keeps its hardening whichever identity it runs as',
    run: (): void => {
      const options = { workspaceRoot: '/home/dev/project', port: 4321, token: 't', env: {}, agents: 2 };
      const spec = containerSpec('malt-reviewer:test', options, { user: '1001:1002', groups: ['1000'] });
      assert.equal(spec['User'], '1001:1002');
      const host = spec['HostConfig'];
      assert.ok(isRecord(host));
      assert.deepEqual(host['GroupAdd'], ['1000'], 'supplementary groups keep group-shared workspaces readable');
      assert.deepEqual(host['Tmpfs'], { '/tmp': 'rw,nosuid,size=128m,mode=1777', '/home/node': 'rw,nosuid,size=256m,mode=1777' },
        'home and temp are writable by any unprivileged user (the Claude CLI writes its config under HOME)');
      assert.equal(host['ReadonlyRootfs'], true);
      assert.deepEqual(host['CapDrop'], ['ALL']);
      assert.deepEqual(host['SecurityOpt'], ['no-new-privileges']);
      assert.deepEqual(host['Mounts'], [{ Type: 'bind', Source: '/home/dev/project', Target: '/workspace', ReadOnly: true }]);
      assert.deepEqual(host['PortBindings'], { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '4321' }] });
      const plain = containerSpec('malt-reviewer:test', options, node)['HostConfig'];
      assert.ok(isRecord(plain) && !('GroupAdd' in plain), 'no GroupAdd when there are no extra groups');
      assert.equal(host['Memory'], 1_073_741_824, 'two agents keep the 1 GiB the reviewer always had');
      assert.equal(host['PidsLimit'], 256);
      assert.equal(host['MemorySwap'], host['Memory'], 'no swap beyond the limit');
    },
  },
  {
    name: 'docker reviewer: memory and process limits grow with the agents, so more agents are not starved',
    run: (): void => {
      assert.deepEqual(containerLimits(8), { Memory: 3_489_660_928, MemorySwap: 3_489_660_928, PidsLimit: 448 });
      for (const agents of [1, 2, 3, 16, 64]) {
        const limits = containerLimits(agents);
        const next = containerLimits(agents + 1);
        assert.ok(next.Memory - limits.Memory >= 384 * 1_048_576 && next.PidsLimit > limits.PidsLimit, `room for agent ${String(agents + 1)}`);
      }
      const options = { workspaceRoot: '/w', port: 1, token: 't', env: {}, agents: 8 };
      const host = containerSpec('malt-reviewer:test', options, node)['HostConfig'];
      assert.ok(isRecord(host) && host['Memory'] === containerLimits(8).Memory && host['PidsLimit'] === 448);
    },
  },
];
