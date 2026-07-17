import { describe, expect, test } from "vitest";
import type { IncomingDriverMessage } from "../src/driver-exchange/incoming.ts";
import { driverParser } from "../src/parse.ts";
import type { BucheErrorMessage } from "../src/utils.ts";
import { getCases } from "./utils.ts";

function processable(message: unknown) {
    return (
        message &&
        typeof message === "object" &&
        "type" in message &&
        typeof message.type === "string"
    );
}

async function validateMessages(
    messages: AsyncIterable<IncomingDriverMessage | BucheErrorMessage>,
) {
    const errors = [];
    for await (const msg of messages) {
        expect(processable(msg), "Parser output is unprocessable").toBeTruthy();
        if (msg.type === "buche_error") {
            errors.push(msg);
        }
    }
    return { errors };
}

describe("Invalid messages", () => {
    for (const { path, relpath } of getCases("data/invalid")) {
        test(`Errors in '${relpath}'`, async () => {
            const { errors } = await validateMessages(driverParser.streamFromFile(path));
            expect(errors.length, "Expected an error, but none was found").toBeGreaterThan(0);
        });
    }
});

describe("Parse IncomingDriverMessage", () => {
    for (const { path, relpath } of getCases("data/runs")) {
        test(`Can parse '${relpath}'`, async () => {
            const { errors } = await validateMessages(driverParser.streamFromFile(path));
            expect(errors, "Some messages were invalid").toHaveLength(0);
        });
    }
});
