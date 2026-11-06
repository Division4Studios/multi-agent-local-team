# TypeScript 7 toolchain

MALT compiles and type-checks with **TypeScript 7.0.2**. Strict ESLint rules still use the TypeScript 6 API through Microsoft's compatibility package. This follows Microsoft's [side-by-side migration guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0):

| Dependency name | Exact npm alias | Role |
|---|---|---|
| `@typescript/native` | `npm:typescript@7.0.2` | Native compiler and editor SDK |
| `typescript` | `npm:@typescript/typescript6@6.0.2` | Compatibility API for TypeScript ESLint |

The compatibility package delegates to its locked TypeScript 6 dependency. The regression suite checks the API ESLint actually resolves, rather than assuming the wrapper's version describes the implementation. Do not replace the `typescript` alias with version 7 or use `--force` / `--legacy-peer-deps`; TypeScript ESLint does not yet support that API. The dependency guard allows only these two alias targets with stable exact versions. All other direct dependencies still require ordinary exact versions.

## Build and debug

Install Node.js 24+, VS Code 1.144+, and Docker with a running **Linux** engine. On Windows/macOS, Docker Desktop provides this engine. Run the launcher as a non-root user with permission to use Docker. Keep the Docker engine and host OS patched.

```sh
npm ci
npm run verify
npm run vsix
```

`compile`, `check-types`, and `watch` launch the native compiler inside Docker. F5 uses `watch`; start Docker first. An unavailable Docker engine causes the build to fail; there is no automatic host-compiler fallback. The reviewer backend selection is independent: using a host reviewer does not change compiler isolation.

The first build downloads the digest-pinned Node image and installs dependencies from the lockfile. Install scripts remain disabled, and the image build checks advisories and registry signatures. Subsequent invocations reuse Docker's build cache. Dependency or Dockerfile changes rebuild the relevant layers. The build context contains only `package.json`, `package-lock.json`, `.npmrc`, and the compiler Dockerfile; source code and Git metadata are not uploaded as build context.

Each compiler invocation has no external network, a read-only root filesystem, no Linux capabilities, no privilege escalation, and CPU, memory, and process limits. Only `src/`, `scripts/`, and the root TypeScript configurations are mounted read-only. Compilation/watch additionally mount `out/` writable; type-checking does not. The compiler has bounded temporary storage inside its container. Credentials, Git metadata, the Docker socket, and `.malt/` are not mounted. The launcher rejects linked mount roots and paths containing Docker mount delimiters.

`npm run test:compiler-sandbox` actively checks denied writes, network interfaces, dropped capabilities, and absence of host credential forwarding. The container is removed on completion or interruption; cached compiler images remain available for subsequent builds.

Do not run `npx tsc` as a substitute for the npm scripts: it invokes the native compiler on the host, outside the build container. `npm run test:compiled` deliberately skips compilation and tests the existing `out/`; use it only with output just built for the current source. Normal `npm test` always compiles first.

## Editor

Install Microsoft's [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=typescriptteam.native-preview), which the workspace recommends. Workspace settings enable TypeScript 7 and point to `node_modules/@typescript/native`. Keep the ESLint extension enabled: compiler diagnostics and lint diagnostics are complementary.

The language server runs under VS Code's normal host permissions. It is separate from the containerized build. Only trust workspaces whose tools you intend to execute; the build sandbox does not sandbox VS Code or its extensions.

## CI and dependency updates

The Linux compile job runs the native compiler and the sandbox checks, then uploads its JavaScript output. Windows, Linux, and macOS jobs download that artifact from the **same workflow run**, run the unchanged strict ESLint rules and dependency checks, and test it in real VS Code hosts. Linux also runs the architecture-publication browser check, and every job checks the VSIX contents with `vsce ls`. No job falls back to TypeScript 6 compilation, and no privileged follow-up workflow executes artifacts from another run.

Dependabot remains enabled for the npm aliases and actions. Review compiler, compatibility-package and TypeScript ESLint updates together; retain exact pins and refresh the lockfile. Run `npm ci`, `npm run verify`, `npm run audit`, and `npm run vsix`. Check `node scripts/compiler.mts version` to confirm the container's compiler version. Keep the reviewed minimatch overrides until each upstream dependency supports a patched release, as described in [SECURITY.md](../SECURITY.md).
