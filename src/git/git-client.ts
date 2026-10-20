import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class GitClient {
  private gitDir: string;

  constructor(private repoPath: string) {
    this.gitDir = path.join(repoPath, '.git');
  }

  // fallow-ignore-next-line unused-class-member
  get repoDir(): string {
    return this.repoPath;
  }

  // fallow-ignore-next-line unused-class-member
  isInstalled(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  isRepo(): boolean {
    return fs.existsSync(this.gitDir);
  }

  init(): string {
    const output = execFileSync('git', ['init', '-b', 'main'], { cwd: this.repoPath, encoding: 'utf-8' });
    this.ensureConfig('user.name', 'Bay State CMS');
    this.ensureConfig('user.email', 'cms@shopsite.local');
    return output.trim();
  }

  add(paths: string[]): void {
    const chunkSize = 500;
    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize);
      execFileSync('git', ['add', '--', ...chunk], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    }
  }

  commit(message: string): string {
    const output = execFileSync('git', ['commit', '-m', message], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    });
    return output.trim();
  }

  /**
   * Commit ONLY the given pathspecs (P2 #22): pre-staged unrelated files
   * stay in the index and out of the new commit. Empty paths throws
   * WITHOUT invoking git (`git commit -m … --` with no paths would commit
   * the whole staged index); the caller maps it to no-commit.
   */
  commitPaths(message: string, paths: string[]): string {
    if (paths.length === 0) {
      throw new Error('commitPaths requires at least one pathspec; refusing to commit the staged index');
    }
    const output = execFileSync('git', ['commit', '-m', message, '--', ...paths], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    });
    return output.trim();
  }

  getHeadHash(): string {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.repoPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      return '';
    }
  }

  status(): string {
    return execFileSync('git', ['status', '--short'], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    }).trim();
  }

  // fallow-ignore-next-line unused-class-member
  readFileAtHead(filePath: string): string | null {
    try {
      return execFileSync('git', ['show', `HEAD:${filePath}`], {
        cwd: this.repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  }

  /**
   * Read a tracked file's bytes at a specific commit (issue #363 immutable
   * export binding). Returns null when the commit/file does not resolve.
   */
  readFileAtCommit(commitHash: string, filePath: string): string | null {
    if (!/^[0-9a-fA-F]{4,64}$/.test(commitHash)) return null;
    if (!filePath || filePath.includes('\0')) return null;
    try {
      return execFileSync('git', ['show', `${commitHash}:${filePath}`], {
        cwd: this.repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  }

  /** True when the hash resolves to a commit object in this repo. */
  commitExists(commitHash: string): boolean {
    if (!/^[0-9a-fA-F]{4,64}$/.test(commitHash)) return false;
    try {
      execFileSync('git', ['cat-file', '-e', `${commitHash}^{commit}`], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Porcelain status scoped to exact pathspecs (issue #363 owned-file
   * freshness). Throws on git failure so callers fail closed.
   */
  statusForPaths(paths: string[]): string {
    return execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    }).trim();
  }
  /**
   * Staged path names (`git diff --cached --name-only`) in this repo.
   * Issue #363 owned-write seam: approval snapshot/restore inspects only
   * index state through here instead of shelling out at the call site.
   * Returns an empty set when git is unavailable (callers treat absence as
   * "nothing staged" and stay best-effort, exactly as before).
   */
  listStagedNames(): Set<string> {
    try {
      const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: this.repoPath,
        encoding: 'utf-8',
      }).trim();
      return new Set(out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []);
    } catch {
      return new Set<string>();
    }
  }

  /**
   * Unstage exactly the given paths (issue #363 owned-only restore).
   * Unrelated staged entries are never touched. Best-effort: throws on
   * git failure so callers can report honestly.
   */
  resetPaths(paths: string[]): void {
    if (paths.length === 0) return;
    execFileSync('git', ['reset', 'HEAD', '--', ...paths], {
      cwd: this.repoPath,
      stdio: 'pipe',
    });
  }

  /**
   * Exact staged index entries for the given paths (issue #363 exact-index
   * restore). Returns mode+blob hash per path that has a staged entry, null
   * for paths with no entry. Best-effort: throws on git failure so callers
   * can fail closed or fall back explicitly.
   */
  readStagedEntries(paths: string[]): Map<string, { mode: string; hash: string } | null> {
    const result = new Map<string, { mode: string; hash: string } | null>();
    for (const p of paths) result.set(p, null);
    if (paths.length === 0) return result;
    const out = execFileSync('git', ['ls-files', '--stage', '--', ...paths], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    }).trim();
    if (!out) return result;
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const file = line.slice(tab + 1).trim();
      if (meta.length < 3 || !file) continue;
      const [mode, hash] = meta;
      if (!mode || !hash || !/^[0-9a-fA-F]{4,64}$/.test(hash)) continue;
      if (result.has(file)) result.set(file, { mode, hash });
    }
    return result;
  }

  /**
   * Restore exact staged index entries (issue #363 exact-index restore).
   * Paths mapped to null had no entry before the operation and are unstaged
   * without touching the worktree. Unrelated staged entries are never
   * touched. Best-effort per path: throws on git failure so callers can
   * report honestly.
   */
  restoreStagedEntries(entries: Array<[string, { mode: string; hash: string } | null]>): void {
    const present = entries.filter((e): e is [string, { mode: string; hash: string }] => e[1] !== null);
    const absent = entries.filter((e) => e[1] === null).map((e) => e[0]);
    for (let i = 0; i < present.length; i += 100) {
      const chunk = present.slice(i, i + 100);
      execFileSync('git', ['update-index', '--cacheinfo', ...chunk.flatMap(([p, e]) => [`${e.mode},${e.hash},${p}`])], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    }
    for (let i = 0; i < absent.length; i += 100) {
      const chunk = absent.slice(i, i + 100);
      try {
        execFileSync('git', ['rm', '--cached', '--quiet', '--', ...chunk], {
          cwd: this.repoPath,
          stdio: 'pipe',
        });
      } catch {
        // A path already absent from the index is the desired end state.
      }
    }
  }

  /**
   * Commit subject line for an operation-specific landed-commit check
   * (issue #363 crash-window commit identification). Null when unresolvable.
   */
  readCommitSubject(commitHash: string): string | null {
    if (!/^[0-9a-fA-F]{4,64}$/.test(commitHash)) return null;
    try {
      return execFileSync('git', ['log', '-1', '--format=%s', commitHash], {
        cwd: this.repoPath,
        encoding: 'utf-8',
      }).trim() || null;
    } catch {
      return null;
    }
  }

  private ensureConfig(key: string, value: string): void {
    try {
      execFileSync('git', ['config', key], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    } catch {
      execFileSync('git', ['config', key, value], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    }
  }
}
