/**
 * Pretty-print a replay file (JSONL of tagged messages, as produced by
 * scripts/sim.ts).
 *
 * Usage:
 *   node scripts/format.ts [REPLAY_FILE] [-v]
 *
 * With no REPLAY_FILE, reads JSONL from stdin (so `sim.ts ... | format.ts` works).
 *
 * Each message is printed with a direction triangle (◀ incoming, ▶ outgoing) and
 * its `type` in a bold color:
 *   - green  for driver messages    (bright = outgoing, normal = incoming)
 *   - blue   for interface messages (bright = outgoing, normal = incoming)
 *   - red    for errors
 * followed by its fields (bold keys), indented. A `cell_command`'s command type
 * is folded into the header (e.g. `cell_command:text`) and its subfields shown
 * one indent deeper. Field values are cut off to the terminal width unless the
 * -v/--verbose flag is given, in which case each value is shown in full and any
 * JSON — including JSON held in a string — is pretty-printed with indentation.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const PINK = "\x1b[38;5;213m";

/** ANSI foreground color for a message, from its `$role` (or red for errors). */
function colorCode(message: any): number {
    if (message.type === "error") {
        return 31; // red
    }
    switch (message.$role) {
        case "driverIn":
            return 32; // green
        case "driverOut":
            return 92; // bright green
        case "interfaceIn":
            return 34; // blue
        case "interfaceOut":
            return 94; // bright blue
        default:
            return 37; // white
    }
}

export interface FormatOptions {
    verbose?: boolean;
    width?: number;
    color?: boolean;
}

/** Direction glyph: ◀ for incoming messages, ▶ for outgoing. */
function arrow(role: string): string {
    if (role.endsWith("Out")) {
        return "▶ ";
    }
    if (role.endsWith("In")) {
        return "◀ ";
    }
    return "• ";
}

/** Format an address like ["cq", 2] as "cq.2" (empty for []/missing). */
function fmtAddr(addr: unknown): string {
    return Array.isArray(addr) ? addr.join(".") : "";
}

/** Format the from→to routing, e.g. "cq.2 → $term" (empty if neither exists). */
function fmtRoute(message: any): string {
    const from = fmtAddr(message.from);
    const to = fmtAddr(message.to);
    if (from && to) {
        return `${from} → ${to}`;
    }
    if (to) {
        return `→ ${to}`;
    }
    if (from) {
        return `${from} →`;
    }
    return "";
}

/**
 * Pretty-print a value as indented JSON. A string whose content is itself a
 * JSON object or array is parsed first, so embedded JSON is expanded too rather
 * than shown as one escaped line.
 */
function prettyValue(value: unknown): string {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed !== null && typeof parsed === "object") {
                    return JSON.stringify(parsed, null, 2);
                }
            } catch {
                // Not valid JSON; fall through and render the raw string.
            }
        }
    }
    return JSON.stringify(value, null, 2);
}

/** Whether a value is a plain object carrying a string `type` (foldable). */
function isTyped(value: any): boolean {
    return (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.type === "string"
    );
}

/** Render a single tagged message as a multi-line, colored, indented string. */
export function formatMessage(message: any, options: FormatOptions = {}): string {
    const { verbose = false, width = 80, color = true } = options;

    const paint = (text: string, ...codes: string[]) =>
        color ? `${codes.join("")}${text}${RESET}` : text;

    const code = `\x1b[${colorCode(message)}m`;
    let type = message.type ?? "?";
    const role = message.$role ?? "";

    // Fold the command's own type into the header, e.g. `cell_command:text`.
    const foldCommand = isTyped(message.command);
    if (foldCommand) {
        type = `${type}:${message.command.type}`;
    }

    const route = fmtRoute(message);
    const header =
        paint(`${arrow(role)}${type}`, BOLD, code) +
        (route ? ` ${paint(`[${route}]`, PINK)}` : "");
    const lines = [header];

    const renderField = (key: string, value: unknown, indent: string) => {
        const label = paint(`${key}:`, BOLD, YELLOW);
        if (verbose) {
            // Full value, pretty-printed (expanding JSON held in strings);
            // align continuation lines under it.
            const rendered = prettyValue(value).replaceAll("\n", `\n${indent}  `);
            lines.push(`${indent}${label} ${rendered}`);
        } else {
            // Single line, truncated to the terminal width.
            const rendered = JSON.stringify(value);
            const avail = width - indent.length - key.length - 2;
            const cut =
                rendered && rendered.length > avail
                    ? `${rendered.slice(0, Math.max(0, avail - 1))}…`
                    : rendered;
            lines.push(`${indent}${label} ${cut}`);
        }
    };

    for (const [key, value] of Object.entries(message)) {
        if (key === "type" || key === "$role" || key === "from" || key === "to") {
            continue;
        }
        if (key === "command" && foldCommand) {
            // Show the folded command's subfields under the header, one deeper.
            for (const [k, v] of Object.entries(value as object)) {
                if (k === "type") {
                    continue;
                }
                renderField(k, v, "    ");
            }
        } else {
            renderField(key, value, "  ");
        }
    }
    return lines.join("\n");
}

function readJsonl(text: string): any[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

// --- CLI ------------------------------------------------------------------
// Only run when invoked directly, not when imported (e.g. by sim.ts).
if (import.meta.main) {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            verbose: { type: "boolean", short: "v" },
        },
    });

    const source = positionals[0] ? readFileSync(positionals[0], "utf8") : readFileSync(0, "utf8");
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const width = process.stdout.columns || 80;

    for (const message of readJsonl(source)) {
        console.log(formatMessage(message, { verbose: values.verbose, width, color }));
    }
}
