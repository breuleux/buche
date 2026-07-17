import assert from 'node:assert';
import { describe, test } from "node:test";
import { getCases } from "./utils.ts"
import { driverParser, type ValidationErrorMessage } from "../src/parse.ts"
import { type IncomingDriverMessage } from '../src/driver-exchange/incoming.ts';

function processable(message: unknown) {
    return message
        && (typeof message === "object")
        && ("type" in message)
        && (typeof message.type === "string")
}

async function validateMessages(messages: AsyncIterable<IncomingDriverMessage | ValidationErrorMessage>) {
    let errors = [];
    for await (const msg of messages) {
        assert.ok(processable(msg), "Parser output is unprocessable");
        if (msg.type === "invalid_message") {
            errors.push(msg);
        }
    }
    return { errors };
}

describe("Invalid messages", () => {
    for (const { path, relpath } of getCases("data/invalid")) {
        test(`Errors in '${relpath}'`, async () => {
            const { errors } = await validateMessages(driverParser.streamFromFile(path));
            assert.notStrictEqual(errors.length, 0, "Expected an error, but none was found");
        });
    }
});

describe("Parse IncomingDriverMessage", () => {
    for (const { path, relpath } of getCases("data/plays")) {
        test(`Can parse '${relpath}'`, async () => {
            const { errors } = await validateMessages(driverParser.streamFromFile(path));
            assert.strictEqual(errors.length, 0, `Some messages were invalid:\n${JSON.stringify(errors, null, 2)}`);
        });
    }
});
