import Ajv, { type ValidateFunction } from "ajv";
import { handlers, type IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import schema from "./driver-exchange/incoming.schema.json" with { type: "json" };
import { Buche } from "./core.ts";

export type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";

/** Thrown when an incoming object is not a valid Message. */
export class MessageValidationError extends Error {
    readonly input: unknown;
    constructor(message: string, input: unknown) {
        super(message);
        this.name = "MessageValidationError";
        this.input = input;
    }
}

// Compile one validator per message `type`, resolving $refs against the whole
// schema. Keyed by the `type` discriminant so parsing mirrors dispatch.
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema, "messages");

const validators: Record<string, ValidateFunction> = {};
for (const [name, def] of Object.entries((schema as any).definitions ?? {})) {
    const literal = (def as any)?.properties?.type?.const;
    if (typeof literal === "string") {
        validators[literal] = ajv.compile({ $ref: `messages#/definitions/${name}` });
    }
}

/**
 * Validate an already-JSON-parsed value and narrow it to a Message.
 * Throws MessageValidationError if it is not a valid, known message.
 */
export function parse(input: unknown): IncomingDriverMessage {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new MessageValidationError("message must be a JSON object", input);
    }
    const type = (input as { type?: unknown }).type;
    if (typeof type !== "string") {
        throw new MessageValidationError("message is missing a string `type` field", input);
    }
    const validate = validators[type];
    if (!validate) {
        throw new MessageValidationError(`unknown message type: ${JSON.stringify(type)}`, input);
    }
    if (!validate(input)) {
        throw new MessageValidationError(ajv.errorsText(validate.errors), input);
    }
    return input as IncomingDriverMessage;
}

export class Runner {
    buche: Buche;

    constructor(buche?: Buche) {
        this.buche = buche || new Buche({cellTypes: {}});
    }

    handleMessage(msg: IncomingDriverMessage): Promise<void> {
        return (handlers as Record<IncomingDriverMessage["type"], (b: Buche, m: IncomingDriverMessage) => Promise<void>>)[
            msg.type
        ](this.buche, msg);
    }

    dispatch(input: unknown): Promise<void> {
        return this.handleMessage(parse(input));
    }

    async handleStream(
        source:
            | string
            | Iterable<string | Uint8Array>
            | AsyncIterable<string | Uint8Array>,
    ): Promise<void> {
        if (typeof source === "string") {
            source = [source];
        }
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of source) {
            buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line) {
                    await this.dispatch(JSON.parse(line));
                }
            }
        }
        const last = buf.trim();
        if (last) {
            await this.dispatch(JSON.parse(last));
        }
    }
}
