/** The Docker reviewer's user and hardening (#34): it reads exactly what the developer can, and never runs as root. */
import assert from 'node:assert/strict';
import { containerSpec, containerUser } from '../../backend/dockerBackend';
import type { UserContext } from '../../backend/dockerBackend';
import { isRecord } from '../../shared/guards';
import type { TestCase } from './harness';

const native = { OperatingSystem: 'Ubuntu 24.04.1 LTS', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'] };
const linux: UserContext = { platform: 'linux', uid: 1001, gid: 1002, engine: native };

export const tests: readonly TestCase[] = [
  {
    name: 'docker reviewer: on a native, rootful Linux engine it runs as the developer, otherwise as node',
    run: (): void => {
      assert.equal(containerUser(linux), '1001:1002', 'native Linux: the developer’s own UID and GID');
      const cases: readonly (readonly [string, UserContext])[] = [
        ['Docker Desktop maps file ownership itself', { ...linux, engine: { ...native, OperatingSystem: 'Docker Desktop' } }],
        ['rootless Docker maps container UIDs to other host IDs', { ...linux, engine: { ...native, SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] } }],
        ['never root, even when VS Code runs as root', { ...linux, uid: 0, gid: 0 }],
        ['never the root group', { ...linux, gid: 0 }],
        ['Windows', { ...linux, platform: 'win32', uid: undefined, gid: undefined }],
        ['macOS (Docker Desktop)', { ...linux, platform: 'darwin' }],
        ['an unreadable /info keeps the previous behavior', { ...linux, engine: undefined }],
        ['an /info without security options is not trusted to be rootful', { ...linux, engine: { OperatingSystem: 'Ubuntu 24.04.1 LTS' } }],
        ['a malformed security option is not trusted either', { ...linux, engine: { ...native, SecurityOptions: [42] } }],
      ];
      for (const [reason, context] of cases) {
        assert.equal(containerUser(context), 'node', reason);
      }
    },
  },
  {
    name: 'docker reviewer: the container keeps its hardening whichever user it runs as',
    run: (): void => {
      const spec = containerSpec('malt-reviewer:test', { workspaceRoot: '/home/dev/project', port: 4321, token: 't', env: {} }, '1001:1002');
      assert.equal(spec['User'], '1001:1002');
      const host = spec['HostConfig'];
      assert.ok(isRecord(host));
      assert.deepEqual(host['Tmpfs'], { '/tmp': 'rw,nosuid,size=128m,mode=1777', '/home/node': 'rw,nosuid,size=256m,mode=1777' },
        'home and temp are writable by any unprivileged user (the Claude CLI writes its config under HOME)');
      assert.equal(host['ReadonlyRootfs'], true);
      assert.deepEqual(host['CapDrop'], ['ALL']);
      assert.deepEqual(host['SecurityOpt'], ['no-new-privileges']);
      assert.deepEqual(host['Mounts'], [{ Type: 'bind', Source: '/home/dev/project', Target: '/workspace', ReadOnly: true }]);
      assert.deepEqual(host['PortBindings'], { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '4321' }] });
    },
  },
];
