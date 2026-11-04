/**
 * The small part of the GitHub REST API MALT uses to review a pull request: list open PRs, read one, and list its
 * changed files with GitHub's own per-file patches. Plain `node:https`, no packages. Only ever talks to
 * api.github.com, with a token from VS Code's built-in GitHub sign-in that is never logged or passed to the reviewer.
 * Every response is untrusted and validated; sizes and page counts are capped.
 */
import { request as httpsRequest } from 'node:https';
import { isNonNegativeInteger, isRecord, isString, parseArray } from '../shared/guards';

const HOST = 'api.github.com';
const MAX_RESPONSE_BYTES = 20_000_000;
const MAX_FILE_PAGES = 30;
const TIMEOUT_MS = 30_000;

/** `owner/repo` of a GitHub repository, as parsed from a git remote. */
export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly htmlUrl: string;
}

export interface PullRequestFile {
  readonly filename: string;
  /** `added`, `modified`, `removed`, `renamed`, … */
  readonly status: string;
  /** GitHub's unified-diff hunks for the file; absent for binary or very large files. */
  readonly patch: string | undefined;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const SHA = /^[0-9a-f]{40}$/u;

/** `owner/repo` from an https or ssh github.com remote URL; undefined for anything else. */
export const parseGitHubRemote = (url: string): GitHubRepo | undefined => {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  return owner !== undefined && repo !== undefined && NAME.test(owner) && NAME.test(repo) && repo !== '.' && repo !== '..' ? { owner, repo } : undefined;
};

/** A string field of a nested object (e.g. `head.sha`), or undefined. */
const nested = (value: unknown, key: string): string | undefined => {
  const field = isRecord(value) ? value[key] : undefined;
  return isString(field) ? field : undefined;
};

const parseSummary = (value: unknown): PullRequestSummary | undefined => {
  if (!isRecord(value) || !isNonNegativeInteger(value['number']) || !isString(value['title']) || !isString(value['html_url'])) {
    return undefined;
  }
  const headSha = nested(value['head'], 'sha');
  const headRef = nested(value['head'], 'ref');
  const baseRef = nested(value['base'], 'ref');
  const author = nested(value['user'], 'login');
  if (headSha === undefined || !SHA.test(headSha) || headRef === undefined || baseRef === undefined || author === undefined) {
    return undefined;
  }
  return { number: value['number'], title: value['title'], author, headSha, headRef, baseRef, htmlUrl: value['html_url'] };
};

const parseFile = (value: unknown): PullRequestFile | undefined => {
  if (!isRecord(value) || !isString(value['filename']) || !isString(value['status'])) {
    return undefined;
  }
  const patch = value['patch'];
  return { filename: value['filename'], status: value['status'], patch: isString(patch) ? patch : undefined };
};

export class GitHubClient {
  private readonly token: string;
  private readonly repo: GitHubRepo;

  public constructor(repo: GitHubRepo, token: string) {
    this.repo = repo;
    this.token = token;
  }

  public async openPullRequests(): Promise<PullRequestSummary[]> {
    const pulls = parseArray(await this.get(`/repos/${this.path()}/pulls?state=open&per_page=50`), parseSummary);
    if (pulls === undefined) {
      throw new Error('GitHub returned an unexpected pull request list');
    }
    return pulls;
  }

  public async pullRequest(number: number): Promise<PullRequestSummary> {
    const pull = parseSummary(await this.get(`/repos/${this.path()}/pulls/${String(number)}`));
    if (pull?.number !== number) {
      throw new Error(`GitHub returned an unexpected answer for pull request #${String(number)}`);
    }
    return pull;
  }

  /** Every changed file with its patch (GitHub lists at most 3,000 files per pull request). */
  public async files(number: number): Promise<PullRequestFile[]> {
    const all: PullRequestFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
      const files = parseArray(await this.get(`/repos/${this.path()}/pulls/${String(number)}/files?per_page=100&page=${String(page)}`), parseFile);
      if (files === undefined) {
        throw new Error('GitHub returned an unexpected file list');
      }
      all.push(...files);
      if (files.length < 100) {
        break;
      }
    }
    return all;
  }

  private path(): string {
    return `${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`;
  }

  private async get(path: string): Promise<unknown> {
    return await new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        {
          host: HOST,
          path,
          method: 'GET',
          timeout: TIMEOUT_MS,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.token}`,
            'user-agent': 'MALT-VSCode',
            'x-github-api-version': '2022-11-28',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('GitHub response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status !== 200) {
              reject(new Error(`GitHub API ${String(status)} for ${path.split('?')[0] ?? path}`));
              return;
            }
            try {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolvePromise(parsed);
            } catch {
              reject(new Error('GitHub returned invalid JSON'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('GitHub API timed out')));
      req.on('error', reject);
      req.end();
    });
  }
}
