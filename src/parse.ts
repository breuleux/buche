import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import driverSchema from "./driver-exchange/incoming.schema.json" with { type: "json" };
import { type IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import { readFileSync } from "node:fs";

export interface ValidationErrorMessage {
    type: "invalid_message";
    code: string;
    reason: string;
    input: any;
}

class BasicParser<T> {
    validate(input: unknown): T | ValidationErrorMessage {
        return input as T;
    }

    parse(input: string): T | ValidationErrorMessage {
        try {
            return this.validate(JSON.parse(input));
        }
        catch (e) {
            return {
                type: "invalid_message",
                code: "notjson",
                reason: "message must be parsable as JSON",
                input: input,
            }
        }
    }

    async* stream(
        source:
            | string
            | Iterable<string | Uint8Array>
            | AsyncIterable<string | Uint8Array>,
    ): AsyncIterable<T | ValidationErrorMessage> {
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

    validate(input: unknown): T | ValidationErrorMessage {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            return {
                type: "invalid_message",
                code: "notobject",
                reason: "message must be a JSON object",
                input: input,
            };
        }
        const type = (input as { type?: unknown }).type;
        if (typeof type !== "string") {
            return {
                type: "invalid_message",
                code: "notype",
                reason: "message is missing a string `type` field",
                input: input,
            };
        }
        const validate = this.validators[type];
        if (!validate) {
            return {
                type: "invalid_message",
                code: "unknowntype",
                reason: `unknown message type: ${JSON.stringify(type)}`,
                input: input,
            };
        }
        if (!validate(input)) {
            return {
                type: "invalid_message",
                code: "invalid",
                reason: this.ajv.errorsText(validate.errors),
                input: input,
            };
        }
        return input as T;
    }
}

export const driverParser = new Parser<IncomingDriverMessage>({
    schema: driverSchema,
});
