import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import driverSchema from "./driver-exchange/incoming.schema.json" with { type: "json" };
import { type IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import { readFileSync } from "node:fs";

export class MessageValidationError extends Error {
    readonly input: unknown;
    constructor(message: string, input: unknown) {
        super(message);
        this.name = "MessageValidationError";
        this.input = input;
    }
}

class BasicParser<T> {
    validate(input: unknown) {
        return input as T;
    }

    parse(input: string): T {
        return this.validate(JSON.parse(input));
    }

    async* stream(
        source:
            | string
            | Iterable<string | Uint8Array>
            | AsyncIterable<string | Uint8Array>,
    ): AsyncIterable<T> {
        if (typeof source === "string") {
            source = [source];
        }
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        for await (const chunk of source) {
            buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line) {
                    yield this.parse(line);
                }
            }
        }
        const last = buf.trim();
        if (last) {
            yield this.parse(last);
        }
    }

    async* streamFromFile(filename: string) {
        yield* this.stream([readFileSync(filename)]);
    }
}

class Parser<T> extends BasicParser<T> {
    validators: Record<string, ValidateFunction>;
    private ajv: Ajv;

    constructor(args: {schema: AnySchema}) {
        super()

        const {schema} = args;

        this.ajv = new Ajv({ allErrors: true });
        this.ajv.addSchema(schema, "messages");

        const validators: Record<string, ValidateFunction> = {};
        for (const [name, def] of Object.entries((schema as any).definitions ?? {})) {
            const literal = (def as any)?.properties?.type?.const;
            if (typeof literal === "string") {
                validators[literal] = this.ajv.compile({ $ref: `messages#/definitions/${name}` });
            }
        }

        this.validators = validators;
    }

    validate(input: unknown): T {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            throw new MessageValidationError("message must be a JSON object", input);
        }
        const type = (input as { type?: unknown }).type;
        if (typeof type !== "string") {
            throw new MessageValidationError("message is missing a string `type` field", input);
        }
        const validate = this.validators[type];
        if (!validate) {
            throw new MessageValidationError(`unknown message type: ${JSON.stringify(type)}`, input);
        }
        if (!validate(input)) {
            throw new MessageValidationError(this.ajv.errorsText(validate.errors), input);
        }
        return input as T;
    }
}

export const driverParser = new Parser<IncomingDriverMessage>({
    schema: driverSchema,
});
