/**
 * The user's configuration file: ~/.config/buche/config.yaml (or under
 * $XDG_CONFIG_HOME). It goes over the defaults (config/default.yaml): made, if
 * it does not exist, as a copy of them commented out. Read by the launchers
 * (scripts/electron.ts, scripts/view.ts), which hand it to the page with the
 * defaults (see src/page.ts); what it means is src/config.ts's.
 *
 * Bun only (`Bun.YAML`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BucheConfig, resolveBindings } from "../src/config.ts";

const root = join(dirname(new URL(import.meta.url).pathname), "..");

/** The default configuration, in this repository. */
export const defaultConfigPath = join(root, "config/default.yaml");

/** Where the user's configuration is. */
export function userConfigPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "buche", "config.yaml");
}

/** YAML lines, commented out (the comments in them left as they are). */
function commentOut(lines: string[]): string[] {
    return lines.map((line) => (/^\s*(#|$)/.test(line) ? line : `# ${line}`));
}

const USER_HEADER = `\
# Your buche configuration: it goes over the defaults, which are below,
# commented out. What you set here wins; the rest is the default's. Uncomment
# what you change (and its section's header: modifiers:, bindings:), or add
# your own entries; \`~\` removes a default (e.g. \`Nav+k: ~\`).
#
`;

/** The user's configuration file, made (the defaults, commented out) if it was missing. */
export function ensureUserConfig(): string {
    const path = userConfigPath();
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const defaults = readFileSync(defaultConfigPath, "utf8").split("\n");
        writeFileSync(path, USER_HEADER + commentOut(defaults).join("\n"));
        console.log(`buche: created ${path} (the defaults, commented out)`);
    }
    return path;
}

/** The sections `--reset-bindings` resets. */
const BINDING_SECTIONS = ["modifiers", "bindings"];

/**
 * The lines of a YAML document's top-level section (e.g. `bindings`): [start,
 * end) (null if there is none). It ends at the next top-level key; comments
 * right before that key are left to it.
 */
function sectionBlock(lines: string[], section: string): [number, number] | null {
    const start = lines.findIndex((line) => new RegExp(`^${section}\\s*:`).test(line));
    if (start < 0) {
        return null;
    }
    let end = lines.findIndex((line, i) => i > start && /^[^\s#]/.test(line));
    if (end < 0) {
        end = lines.length;
    }
    while (end > start + 1 && /^(#.*)?\s*$/.test(lines[end - 1])) {
        end--;
    }
    return [start, end];
}

/**
 * Back to the default modifiers and bindings: the `modifiers` and `bindings`
 * sections of the user's configuration are replaced with the default ones,
 * commented out — as text: the rest of the file (comments included) is kept.
 * Returns the file's path, and whether anything changed.
 */
export function resetBindings(): { path: string; changed: boolean } {
    const path = userConfigPath();
    if (!existsSync(path)) {
        return { path: ensureUserConfig(), changed: true };
    }
    const defaults = readFileSync(defaultConfigPath, "utf8").split("\n");
    const lines = readFileSync(path, "utf8").split("\n");
    let changed = false;
    for (const section of BINDING_SECTIONS) {
        const block = sectionBlock(lines, section);
        const defaultBlock = sectionBlock(defaults, section);
        if (!block) {
            continue;
        }
        if (!defaultBlock) {
            throw new Error(`${defaultConfigPath} has no ${section} section`);
        }
        lines.splice(
            block[0],
            block[1] - block[0],
            ...commentOut(defaults.slice(...defaultBlock)),
        );
        changed = true;
    }
    if (changed) {
        writeFileSync(path, lines.join("\n"));
    }
    return { path, changed };
}

function parseConfig(path: string): BucheConfig {
    const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || parsed === undefined) {
        return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a table at the top level");
    }
    return parsed as BucheConfig;
}

/**
 * The user's configuration (made if missing), and the defaults it goes over.
 * If it can't be read: the defaults only, with a warning. Problems with the
 * bindings are reported on stderr too (the page shows them as well).
 */
export function loadUserConfig(): { user: BucheConfig; defaults: BucheConfig } {
    const defaults = parseConfig(defaultConfigPath);
    const path = ensureUserConfig();
    let user: BucheConfig;
    try {
        user = parseConfig(path);
    } catch (e) {
        console.error(`buche: ${path}: ${(e as Error).message}`);
        console.error("buche: using the default configuration");
        return { user: {}, defaults };
    }
    const { errors } = resolveBindings([defaults, user], process.platform === "darwin");
    for (const error of errors) {
        console.error(`buche: ${path}: ${error}`);
    }
    return { user, defaults };
}
