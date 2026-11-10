/**
 * Tools installed from GitHub releases: the shell (see `ShellConfig` in
 * src/config.ts) can be a repository and a semver range, rather than a
 * command found on PATH. The release's archives (or bare binaries) for this
 * platform are downloaded and unpacked under
 *
 *   ~/.local/share/buche/tools/OWNER/REPO/VERSION/   (or $XDG_DATA_HOME)
 *     files/ASSET/...   what the archives held
 *     bin/              links to the executables in them
 *
 * and bin/ goes first on PATH. A version installed and in the range is used
 * as is, without going online; `update` looks for a newer one first.
 *
 * Bundled into the Electron main process (electron/main.ts): plain Node, no
 * Bun APIs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import semver from "semver";
import type { ShellConfig } from "../src/config.ts";

/** Where the tools are installed. */
export function toolsDir(): string {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "buche", "tools");
}

/** `~/…` (or `~` alone) at the start of a command line, as the home directory. */
export function expandHome(command: string): string {
    return command.replace(/^~(?=$|\/)/, homedir());
}

export interface ResolvedShell {
    /** The command line to run. */
    command: string;
    /** The directory to put first on PATH (installed tools), if any. */
    binDir?: string;
    /** The installed version, if any. */
    version?: string;
}

/**
 * The shell to run, its tools installed if it has some (see the top of this
 * module). Throws if they can't be installed and none is (if a version in the
 * range is installed, it is used, with a warning through `log`).
 */
export async function resolveShellCommand(
    shell: ShellConfig,
    options: { update?: boolean; log?: (message: string) => void } = {},
): Promise<ResolvedShell> {
    const command = expandHome(shell.command);
    if (!shell.github) {
        return { command };
    }
    const log = options.log ?? ((m: string) => console.error(`buche: ${m}`));
    const range = shell.version ?? "*";
    if (!semver.validRange(range)) {
        throw new Error(`shell: ${shell.github}: invalid version range: ${range}`);
    }
    const repoDir = join(toolsDir(), ...shell.github.split("/"));
    const installed = semver.maxSatisfying(installedVersions(repoDir), range);
    const at = (version: string): ResolvedShell => ({
        command,
        binDir: join(repoDir, version, "bin"),
        version,
    });
    if (installed && !options.update) {
        return at(installed);
    }
    try {
        const release = await findRelease(shell.github, range);
        if (installed && !semver.gt(release.version, installed)) {
            return at(installed);
        }
        log(`installing ${shell.github} ${release.version} (${release.tag})...`);
        await install(release, join(repoDir, release.version), shell.assets);
        log(`installed ${shell.github} ${release.version} in ${join(repoDir, release.version)}`);
        return at(release.version);
    } catch (e) {
        if (installed) {
            log(`${shell.github}: ${(e as Error).message} (using ${installed})`);
            return at(installed);
        }
        throw e;
    }
}

/** Put a directory first on a PATH (process.env's, by default). */
export function prependPath(dir: string, env: NodeJS.ProcessEnv = process.env): void {
    const parts = (env.PATH ?? "").split(delimiter).filter((p) => p && p !== dir);
    env.PATH = [dir, ...parts].join(delimiter);
}

/** The versions installed in a repository's directory (complete ones only). */
function installedVersions(repoDir: string): string[] {
    if (!existsSync(repoDir)) {
        return [];
    }
    return readdirSync(repoDir).filter(
        (name) => semver.valid(name) === name && existsSync(join(repoDir, name, "bin")),
    );
}

// ── Releases ────────────────────────────────────────────────────────────────

interface Asset {
    name: string;
    /** The API URL (works for private repositories, with a token). */
    url: string;
    browser_download_url: string;
}

interface Release {
    repo: string;
    tag: string;
    version: string;
    assets: Asset[];
}

function githubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    return {
        Accept: accept,
        "User-Agent": "buche",
        ...(token && { Authorization: `Bearer ${token}` }),
    };
}

/** The version a release tag names (v1.2.3, name/1.2.3, name-v1.2.3...), or null. */
export function tagVersion(tag: string): string | null {
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
    return match ? semver.valid(match[1]) : null;
}

/** The repository's latest release (not a draft) in the range. */
async function findRelease(repo: string, range: string): Promise<Release> {
    const releases: Release[] = [];
    for (let page = 1; page <= 10; page++) {
        const response = await fetch(
            `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
            { headers: githubHeaders() },
        );
        if (!response.ok) {
            throw new Error(
                `could not list the releases (${response.status} ${response.statusText})`,
            );
        }
        const batch = (await response.json()) as {
            tag_name: string;
            draft: boolean;
            assets: Asset[];
        }[];
        for (const r of batch) {
            const version = tagVersion(r.tag_name);
            if (version && !r.draft) {
                releases.push({ repo, tag: r.tag_name, version, assets: r.assets });
            }
        }
        if (batch.length < 100) {
            break;
        }
    }
    const best = semver.maxSatisfying(
        releases.map((r) => r.version),
        range,
    );
    const release = best && releases.find((r) => r.version === best);
    if (!release) {
        throw new Error(`no release in ${range}`);
    }
    return release;
}

// ── Platforms ───────────────────────────────────────────────────────────────

const OS_TOKENS: Record<string, string[]> = {
    darwin: ["apple-darwin", "darwin", "macos", "osx", "mac"],
    linux: ["unknown-linux-musl", "unknown-linux-gnu", "linux-musl", "linux-gnu", "linux"],
    win32: ["pc-windows-msvc", "pc-windows-gnu", "windows", "win64", "win"],
};

const ARCH_TOKENS: Record<string, string[]> = {
    arm64: ["aarch64", "arm64"],
    x64: ["x86_64", "x86-64", "amd64", "x64"],
};

const SKIP = /\.(sha256|sha512|sig|asc|pem|sbom|json|txt|sum|msi|pkg|dmg|deb|rpm|apk)$/i;
const ARCHIVE = /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|tar|zip)$/i;

function findToken(name: string, tokens: string[]): number {
    let found = -1;
    for (const token of tokens) {
        const re = new RegExp(`(^|[-_.])${token.replace(/[.-]/g, "[-_.]")}(?=$|[-_.])`, "i");
        const m = re.exec(name);
        if (m && (found < 0 || m.index < found)) {
            found = m.index + m[1].length;
        }
    }
    return found;
}

export interface PlatformAsset {
    /** The name before the platform (e.g. "coquille"). */
    base: string;
    /** How well it fits (higher is better). */
    score: number;
}

/**
 * Whether a release asset is for a platform, and its base name; null if it
 * is not (or is not a binary or an archive: checksums, signatures...).
 */
export function matchAsset(
    name: string,
    platform: string = process.platform,
    arch: string = process.arch,
): PlatformAsset | null {
    if (SKIP.test(name)) {
        return null;
    }
    const osAt = findToken(name, OS_TOKENS[platform] ?? []);
    if (osAt < 0) {
        return null;
    }
    // No other platform named in it (e.g. "linux" and "darwin").
    for (const [other, tokens] of Object.entries(OS_TOKENS)) {
        if (other !== platform && findToken(name, tokens) >= 0) {
            return null;
        }
    }
    const archAt = findToken(name, ARCH_TOKENS[arch] ?? []);
    let score: number;
    let start: number;
    if (archAt >= 0) {
        score = 2;
        start = Math.min(osAt, archAt);
    } else {
        const others = Object.entries(ARCH_TOKENS)
            .filter(([a]) => a !== arch)
            .some(([, tokens]) => findToken(name, tokens) >= 0);
        if (others) {
            return null;
        }
        // Universal (macOS), or no architecture named: maybe.
        score = platform === "darwin" && /universal/i.test(name) ? 1 : 0;
        const universalAt = findToken(name, ["universal", "universal2"]);
        start = universalAt >= 0 ? Math.min(osAt, universalAt) : osAt;
    }
    // Static (musl) builds run anywhere.
    if (/musl/i.test(name)) {
        score += 0.5;
    }
    const base = name.slice(0, start).replace(/[-_.]+$/, "");
    return { base: base || name, score };
}

/** Of a release's assets, the ones to install here: the best fit for each base name. */
export function pickAssets<A extends { name: string }>(
    assets: A[],
    wanted?: string[],
    platform: string = process.platform,
    arch: string = process.arch,
): A[] {
    const best = new Map<string, { asset: A; score: number }>();
    for (const asset of assets) {
        const match = matchAsset(asset.name, platform, arch);
        if (!match || (wanted && !wanted.includes(match.base))) {
            continue;
        }
        const current = best.get(match.base);
        if (!current || match.score > current.score) {
            best.set(match.base, { asset, score: match.score });
        }
    }
    return [...best.values()].map((b) => b.asset);
}

// ── Installing ──────────────────────────────────────────────────────────────

async function download(asset: Asset): Promise<Buffer> {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const response = token
        ? await fetch(asset.url, { headers: githubHeaders("application/octet-stream") })
        : await fetch(asset.browser_download_url, { headers: { "User-Agent": "buche" } });
    if (!response.ok) {
        throw new Error(
            `${asset.name}: download failed (${response.status} ${response.statusText})`,
        );
    }
    return Buffer.from(await response.arrayBuffer());
}

/**
 * The asset's SHA-256, if the release has one for it (NAME.sha256, or a
 * line of a sha256.sum / SHA256SUMS / checksums.txt), else null.
 */
async function expectedHash(release: Release, asset: Asset): Promise<string | null> {
    const own = release.assets.find((a) => a.name === `${asset.name}.sha256`);
    const sums = release.assets.find((a) => /^(sha256\.?sums?|checksums?)(\.txt)?$/i.test(a.name));
    for (const source of [own, sums]) {
        if (!source) {
            continue;
        }
        const text = (await download(source)).toString("utf8");
        for (const line of text.split("\n")) {
            const [hash, file] = line.trim().split(/\s+\*?/);
            if (/^[0-9a-f]{64}$/i.test(hash) && (source === own || file === asset.name)) {
                return hash.toLowerCase();
            }
        }
    }
    return null;
}

/** The executable files under a directory (recursively). */
function executables(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...executables(path));
        } else if (entry.isFile()) {
            const exe =
                process.platform === "win32"
                    ? /\.(exe|cmd|bat)$/i.test(entry.name)
                    : (statSync(path).mode & 0o111) !== 0;
            if (exe) {
                found.push(path);
            }
        }
    }
    return found;
}

/**
 * Install a release's assets for this platform in `target` (made in a
 * temporary directory next to it, then renamed: a version directory is
 * complete or missing).
 */
async function install(release: Release, target: string, wanted?: string[]): Promise<void> {
    const assets = pickAssets(release.assets, wanted);
    if (!assets.length) {
        throw new Error(
            `${release.tag} has nothing for ${process.platform}/${process.arch}` +
                (wanted ? ` among ${wanted.join(", ")}` : ""),
        );
    }
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    rmSync(tmp, { recursive: true, force: true });
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    try {
        for (const asset of assets) {
            const data = await download(asset);
            const hash = await expectedHash(release, asset);
            const actual = createHash("sha256").update(data).digest("hex");
            if (hash && hash !== actual) {
                throw new Error(`${asset.name}: checksum mismatch`);
            }
            const files = join(tmp, "files", asset.name.replace(ARCHIVE, ""));
            mkdirSync(files, { recursive: true });
            if (ARCHIVE.test(asset.name)) {
                const archive = join(tmp, asset.name);
                writeFileSync(archive, data);
                if (/\.zip$/i.test(asset.name)) {
                    execFileSync("unzip", ["-q", "-o", archive, "-d", files]);
                } else {
                    execFileSync("tar", ["-xf", archive, "-C", files]);
                }
                rmSync(archive);
            } else {
                // A bare binary, named after its base name.
                const base = matchAsset(asset.name)?.base ?? asset.name;
                const ext = /\.exe$/i.test(asset.name) ? ".exe" : "";
                const path = join(files, base + ext);
                writeFileSync(path, data);
                chmodSync(path, 0o755);
            }
            for (const exe of executables(files)) {
                const name = exe.split(/[\\/]/).pop() as string;
                const link = join(bin, name);
                if (existsSync(link)) {
                    continue;
                }
                if (process.platform === "win32") {
                    copyFileSync(exe, link);
                } else {
                    symlinkSync(relative(bin, exe), link);
                }
            }
        }
        if (!readdirSync(bin).length) {
            throw new Error(
                `${release.tag}: no executables in ${assets.map((a) => a.name).join(", ")}`,
            );
        }
        try {
            renameSync(tmp, target);
        } catch (e) {
            // Installed meanwhile (by another window)?
            if (!existsSync(join(target, "bin"))) {
                throw e;
            }
            rmSync(tmp, { recursive: true, force: true });
        }
    } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
    }
}
