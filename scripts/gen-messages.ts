/**
 * Generates, from the `_xxx.ts` files in src/driver-exchange:
 *   - src/driver-exchange/incoming.ts          — imports + `handlers` registry + `Message` union
 *   - src/driver-exchange/incoming.schema.json — JSON Schema for `Message`, for
 *     cross-language clients. JSDoc comments become `description` fields.
 *
 * Each `_xxx.ts` file must export:
 *   - an interface `XxxMessage` (snake_case -> PascalCase) whose `type`
 *     property is the string literal "xxx" (underscores preserved), and
 *   - a function `handle$xxx`.
 *
 * It also generates, from the hand-written `outgoing.ts` file in each exchange
 * directory:
 *   - src/<exchange>/outgoing.schema.json — JSON Schema for the outgoing union.
 *
 * Finally, it generates src/message-directory.ts, which lists the message
 * `type` names for each of the four exchanges (driver/interface x
 * incoming/outgoing). A warning is printed if any `type` appears in more than
 * one of the four sets.
 *
 * Run with: bun run gen
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import { Project, SyntaxKind } from "ts-morph";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TSCONFIG = join(ROOT, "tsconfig.json");

/** snake_case -> PascalCase, e.g. "foo_bar" -> "FooBar" */
function toPascal(name: string): string {
    return name
        .split("_")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
        .join("");
}

/** Emit a JSON Schema file for `type` declared in `path`. */
function writeSchema(path: string, type: string, schemaFile: string) {
    const generator = createGenerator({
        path,
        tsconfig: TSCONFIG,
        type,
        jsDoc: "extended", // carry JSDoc comments into `description` fields
        additionalProperties: false, // reject unknown properties
        topRef: true,
    });

    const schema = generator.createSchema(type);
    writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
}

/** The set of message `type` names generated for one exchange direction. */
interface DirectionResult {
    /** Human-readable label used in warnings, e.g. "driver incoming". */
    label: string;
    /** The message `type` string literals. */
    types: string[];
}

class Generator {
    directory: string;
    exchange: string;
    dest: string;
    schemaFile: string;
    incomingClassName: string;
    outgoingClassName: string;

    constructor(exchange: string, incomingClassName: string, outgoingClassName: string) {
        this.exchange = exchange;
        this.directory = join(ROOT, "src", `${exchange}-exchange`);
        this.dest = join(this.directory, "incoming.ts");
        this.schemaFile = join(this.directory, "incoming.schema.json");
        this.incomingClassName = incomingClassName;
        this.outgoingClassName = outgoingClassName;
    }

    /** Generate incoming.ts + incoming.schema.json; return the incoming `type`s. */
    generateIncoming(): DirectionResult {
        const files = readdirSync(this.directory)
            .filter((f) => f.startsWith("_") && f.endsWith(".ts"))
            .sort();

        if (files.length === 0) {
            console.error(`No _*.ts message files found in ${this.directory}`);
            process.exit(1);
        }

        const project = new Project({ skipAddingFilesFromTsConfig: true });

        const errors: string[] = [];
        const entries: { key: string; iface: string; handler: string; module: string }[] = [];

        for (const file of files) {
            const key = file.slice(1, -3); // strip leading "_" and trailing ".ts"
            const interfaceName = `${toPascal(key)}Message`;
            const handlerName = `handle$${key}`;
            const module = `./${file.slice(0, -3)}`; // extensionless import specifier

            const src = project.addSourceFileAtPath(join(this.directory, file));

            const iface = src.getInterface(interfaceName);
            if (!iface) {
                errors.push(`${file}: expected exported interface \`${interfaceName}\``);
            } else {
                if (!iface.isExported()) {
                    errors.push(`${file}: interface \`${interfaceName}\` must be exported`);
                }
                const typeProp = iface.getProperty("type");
                if (!typeProp) {
                    errors.push(
                        `${file}: interface \`${interfaceName}\` is missing a \`type\` field`,
                    );
                } else {
                    const literal = typeProp
                        .getTypeNode()
                        ?.asKind(SyntaxKind.LiteralType)
                        ?.getLiteral()
                        ?.asKind(SyntaxKind.StringLiteral)
                        ?.getLiteralText();
                    if (literal !== key) {
                        errors.push(
                            `${file}: \`${interfaceName}.type\` must be the string literal "${key}" (found ${
                                literal === undefined ? "non-literal" : `"${literal}"`
                            })`,
                        );
                    }
                }
            }

            const fn = src.getFunction(handlerName);
            if (!fn) {
                errors.push(`${file}: expected exported function \`${handlerName}\``);
            } else {
                if (!fn.isExported()) {
                    errors.push(`${file}: function \`${handlerName}\` must be exported`);
                }
                // Handlers must be async (return a Promise).
                if (fn.getReturnType().getSymbol()?.getName() !== "AsyncIterable") {
                    errors.push(
                        `${file}: function \`${handlerName}\` must be async* (return a AsyncIterable)`,
                    );
                }
            }

            entries.push({ key, iface: interfaceName, handler: handlerName, module });
        }

        if (errors.length > 0) {
            console.error(
                `Message file validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
            );
            process.exit(1);
        }

        // ---- Emit incoming.ts -----------------------------------------------------------

        const imports = entries
            .map((e) => `import { ${e.handler}, type ${e.iface} } from "${e.module}.ts";`)
            .join("\n");

        const registry = entries.map((e) => `    ${e.key}: ${e.handler},`).join("\n");
        const union = entries.map((e) => e.iface).join(" | ");

        const allOutput = `// AUTO-GENERATED by scripts/gen-messages.ts — do not edit.
// Run \`bun run gen\` to regenerate.
${imports}

/** Registry of message handlers, keyed by message \`type\`. */
export const handlers = {
${registry}
} as const;

/** Union of every message type. */
export type ${this.incomingClassName} = ${union};
`;

        writeFileSync(this.dest, allOutput);

        // ---- Emit incoming.schema.json ---------------------------------------------

        writeSchema(this.dest, this.incomingClassName, this.schemaFile);

        console.log(
            `Wrote ${this.dest} and ${this.schemaFile} (${entries.length} message${
                entries.length === 1 ? "" : "s"
            })`,
        );

        return { label: `${this.exchange} incoming`, types: entries.map((e) => e.key) };
    }

    /**
     * Generate outgoing.schema.json from the hand-written outgoing.ts, and
     * return the outgoing `type`s discovered in the outgoing union.
     */
    generateOutgoing(): DirectionResult {
        const outgoingTs = join(this.directory, "outgoing.ts");
        const schemaFile = join(this.directory, "outgoing.schema.json");

        // Resolve the outgoing union's member `type` string literals.
        const project = new Project({
            tsConfigFilePath: TSCONFIG,
            skipAddingFilesFromTsConfig: true,
        });
        const src = project.addSourceFileAtPath(outgoingTs);
        const alias = src.getTypeAlias(this.outgoingClassName);
        if (!alias) {
            console.error(
                `${outgoingTs}: expected exported type alias \`${this.outgoingClassName}\``,
            );
            process.exit(1);
        }

        const aliasType = alias.getType();
        const members = aliasType.isUnion() ? aliasType.getUnionTypes() : [aliasType];

        const errors: string[] = [];
        const types: string[] = [];
        for (const member of members) {
            const typeSymbol = member.getProperty("type");
            const name = member.getSymbol()?.getName() ?? member.getText();
            if (!typeSymbol) {
                errors.push(`union member \`${name}\` is missing a \`type\` field`);
                continue;
            }
            const literal = typeSymbol.getTypeAtLocation(alias).getLiteralValue();
            if (typeof literal !== "string") {
                errors.push(`union member \`${name}\` has a non-string-literal \`type\``);
                continue;
            }
            types.push(literal);
        }

        if (errors.length > 0) {
            console.error(
                `Outgoing message validation failed in ${outgoingTs}:\n${errors
                    .map((e) => `  - ${e}`)
                    .join("\n")}`,
            );
            process.exit(1);
        }

        // ---- Emit outgoing.schema.json ---------------------------------------------

        writeSchema(outgoingTs, this.outgoingClassName, schemaFile);

        console.log(
            `Wrote ${schemaFile} (${types.length} message${types.length === 1 ? "" : "s"})`,
        );

        types.sort();
        return { label: `${this.exchange} outgoing`, types };
    }
}

const generators = [
    new Generator("driver", "IncomingDriverMessage", "OutgoingDriverMessage"),
    new Generator("interface", "IncomingInterfaceMessage", "OutgoingInterfaceMessage"),
];

const directions: DirectionResult[] = [];
for (const g of generators) {
    directions.push(g.generateIncoming());
    directions.push(g.generateOutgoing());
}

// ---- Warn about `type`s that appear in more than one set ------------------------

const seenIn = new Map<string, string[]>();
for (const { label, types } of directions) {
    for (const t of types) {
        const labels = seenIn.get(t) ?? [];
        labels.push(label);
        seenIn.set(t, labels);
    }
}
for (const [type, labels] of seenIn) {
    if (labels.length > 1) {
        console.warn(
            `Warning: message type "${type}" appears in multiple sets: ${labels.join(", ")}`,
        );
    }
}

// ---- Emit src/message-directory.ts ----------------------------------------------

/** camelCase set name from a "<exchange> <direction>" label. */
function setName(label: string): string {
    const [exchange, direction] = label.split(" ");
    return `${direction}${toPascal(exchange)}MessageTypes`;
}

const setDecls = directions
    .map(({ label, types }) => {
        const entries = types.map((t) => `    ${JSON.stringify(t)},`).join("\n");
        return `/** Message \`type\` names for ${label} messages. */
export const ${setName(label)} = new Set<string>([
${entries}
]);`;
    })
    .join("\n\n");

const directoryOutput = `// AUTO-GENERATED by scripts/gen-messages.ts — do not edit.
// Run \`bun run gen\` to regenerate.

${setDecls}
`;

const directoryFile = join(ROOT, "src", "message-directory.ts");
writeFileSync(directoryFile, directoryOutput);
console.log(`Wrote ${directoryFile}`);
