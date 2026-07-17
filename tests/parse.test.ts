import { describe, test } from "node:test";
import { getCases } from "./utils.ts"
import { driverParser } from "../src/parse.ts"

describe("Parse IncomingDriverMessage", () => {
    for (const { path, relpath } of getCases("data/plays")) {
        test(`Can parse '${relpath}'`, async () => {
            for await (const _ of driverParser.streamFromFile(path)) { }
        });
    }
});
