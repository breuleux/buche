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
 * Run with: bun run gen
 */
import { Project, SyntaxKind } from "ts-morph";
import { createGenerator } from "ts-json-schema-generator";
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** snake_case -> PascalCase, e.g. "foo_bar" -> "FooBar" */
function toPascal(name: string): string {
    return name
        .split("_")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
        .join("");
}


class Generator {
    directory: string;
    dest: string;
    schemaFile: string;
    className: string;

    constructor(directory: string, className: string) {
        this.directory = directory;
        this.dest = join(this.directory, "incoming.ts");
        this.schemaFile = join(this.directory, "incoming.schema.json");
        this.className = className;
    }

    run() {
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
                    errors.push(`${file}: interface \`${interfaceName}\` is missing a \`type\` field`);
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
                if (fn.getReturnType().getSymbol()?.getName() !== "Promise") {
                    errors.push(
                        `${file}: function \`${handlerName}\` must be async (return a Promise)`,
                    );
                }
            }

            entries.push({ key, iface: interfaceName, handler: handlerName, module });
        }

        if (errors.length > 0) {
            console.error("Message file validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
            process.exit(1);
        }

        // ---- Emit incoming.ts -----------------------------------------------------------

        const imports = entries
            .map((e) => `import { ${e.handler}, type ${e.iface} } from "${e.module}";`)
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
export type ${this.className} = ${union};
`;

        writeFileSync(this.dest, allOutput);

        // ---- Emit incoming.schema.json ---------------------------------------------

        const generator = createGenerator({
            path: this.dest,
            tsconfig: join(ROOT, "tsconfig.json"),
            type: this.className,
            jsDoc: "extended", // carry JSDoc comments into `description` fields
            additionalProperties: false, // reject unknown properties
            topRef: true,
        });

        const schema = generator.createSchema(this.className);
        writeFileSync(this.schemaFile, JSON.stringify(schema, null, 2) + "\n");

        console.log(
            `Wrote ${this.dest} and ${this.schemaFile} (${entries.length} message${
                entries.length === 1 ? "" : "s"
            })`,
        );
    }
}

const dr = new Generator(
    join(ROOT, "src", "driver-exchange"),
    "IncomingDriverMessage",
)
dr.run();
