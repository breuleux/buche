import { describe, test } from "node:test";
import { getCases } from "./utils.ts"
import { driverParser } from "../src/parse.ts"
import path from "node:path";

describe("Parse IncomingDriverMessage", () => {
    for (const name of getCases(path.join(import.meta.dirname, "data/plays"))) {
        const filename = `${name}.source.jsonl`;
        test(`Can parse '${filename}'`, async () => {
            for await (const _ of driverParser.streamFromFile(filename)) { }
        });
    }
});
