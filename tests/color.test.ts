import { describe, expect, test } from "vitest";
import {
    type Anchors,
    calculateColor,
    calculateStyle,
    coordsToCss,
    parseColor,
    styleToCss,
} from "../src/color.ts";

const LIGHT: Anchors = { bg: 0.93, fg: 0.2 };
const DARK: Anchors = { bg: 0.22, fg: 0.95 };

describe("parseColor — channels", () => {
    test("defaults when nothing is specified", () => {
        expect(parseColor("")).toEqual({ h: 0, s: 60, l: 60 });
    });

    test("absolute channels set coordinates", () => {
        expect(parseColor("H120 S40 L80")).toEqual({ h: 120, s: 40, l: 80 });
    });

    test("relative channels nudge from the current value", () => {
        expect(parseColor("L+10")).toMatchObject({ l: 70 });
        expect(parseColor("L-20")).toMatchObject({ l: 40 });
        expect(parseColor("S-30")).toMatchObject({ s: 30 });
    });

    test("channels apply in order (absolute then relative)", () => {
        expect(parseColor("L50 L+5")).toMatchObject({ l: 55 });
        // Absolute after relative wins.
        expect(parseColor("L+5 L50")).toMatchObject({ l: 50 });
    });

    test("hue wraps into [0, 360)", () => {
        expect(parseColor("H400").h).toBeCloseTo(40, 6);
        expect(parseColor("H-30").h).toBeCloseTo(330, 6);
    });

    test("saturation and luminosity clamp to [0, 100]", () => {
        expect(parseColor("S200")).toMatchObject({ s: 100 });
        expect(parseColor("S-200")).toMatchObject({ s: 0 });
        expect(parseColor("L500")).toMatchObject({ l: 100 });
        expect(parseColor("L-500")).toMatchObject({ l: 0 });
    });

    test("decimals are accepted", () => {
        expect(parseColor("H12.5").h).toBeCloseTo(12.5, 6);
    });
});

describe("parseColor — named colors", () => {
    test("a name sets hue and saturation but keeps default luminosity", () => {
        expect(parseColor("red")).toEqual({ h: 29, s: 95, l: 60 });
    });

    test("gray is achromatic and does not skew hue", () => {
        expect(parseColor("gray")).toEqual({ h: 0, s: 0, l: 60 });
        // gray contributes brightness/saturation but no hue direction
        expect(parseColor("blue gray").h).toBeCloseTo(255, 6);
    });

    test("channels override a named color's hue/saturation", () => {
        expect(parseColor("red H200 S10")).toMatchObject({ h: 200, s: 10 });
    });

    test("unknown names throw", () => {
        expect(() => parseColor("chartreuse")).toThrow(/Unknown color name/);
    });
});

describe("parseColor — mixing", () => {
    test("equal-weight midpoint of two hues", () => {
        // blue (255) and indigo (275) share saturation, so the mean is 265.
        expect(parseColor("blue indigo").h).toBeCloseTo(265, 4);
    });

    test("saturation is a weighted mean", () => {
        // blue s88, indigo s88 → 88
        expect(parseColor("blue indigo").s).toBeCloseTo(88, 6);
    });

    test("hue averaging wraps around 360 rather than through 180", () => {
        // red (~29) + pink (~350): the circular mean sits near 0, NOT near 190.
        const h = parseColor("red pink").h;
        expect(h > 340 || h < 40).toBe(true);
    });

    test("numeric suffix weights a color in the mix", () => {
        const even = parseColor("orange red").h;
        const heavy = parseColor("orange4 red").h;
        // Weighting orange more pulls the hue toward orange (60) vs red (29).
        expect(heavy).toBeGreaterThan(even);
        expect(heavy).toBeLessThan(60);
        // Saturation is also weighted: (90*4 + 95*1) / 5 = 91.
        expect(parseColor("orange4 red").s).toBeCloseTo(91, 6);
    });
});

describe("parseColor — case insensitivity", () => {
    test("channel letters are case-insensitive", () => {
        expect(parseColor("h120 s40 l80")).toEqual(parseColor("H120 S40 L80"));
        expect(parseColor("l+10")).toEqual(parseColor("L+10"));
    });

    test("color names are case-insensitive", () => {
        expect(parseColor("RED")).toEqual(parseColor("red"));
        expect(parseColor("Blue Indigo")).toEqual(parseColor("blue indigo"));
    });
});

describe("calculateColor / coordsToCss", () => {
    test("L0 lands on the background anchor, L100 on the foreground", () => {
        expect(calculateColor("S0 L0", LIGHT)).toBe("oklch(0.93 0 0)");
        expect(calculateColor("S0 L100", LIGHT)).toBe("oklch(0.2 0 0)");
        expect(calculateColor("S0 L0", DARK)).toBe("oklch(0.22 0 0)");
        expect(calculateColor("S0 L100", DARK)).toBe("oklch(0.95 0 0)");
    });

    test("luminosity interpolates linearly between the anchors", () => {
        // halfway between 0.2 and 0.9
        expect(calculateColor("S0 L50", { bg: 0.2, fg: 0.9 })).toBe("oklch(0.55 0 0)");
    });

    test("saturation maps to chroma (S100 → MAX_CHROMA 0.35)", () => {
        expect(calculateColor("H0 S100 L0", { bg: 0.5, fg: 0.5 })).toBe("oklch(0.5 0.35 0)");
        expect(calculateColor("H0 S50 L0", { bg: 0.5, fg: 0.5 })).toBe("oklch(0.5 0.175 0)");
    });

    test("the same color reads darker/lighter depending on the surface", () => {
        expect(calculateColor("red L0", { bg: 0.2, fg: 0.9 })).toBe("oklch(0.2 0.3325 29)");
        expect(coordsToCss(parseColor("red"), LIGHT)).toBe(calculateColor("red", LIGHT));
    });
});

describe("calculateStyle", () => {
    test("color is only set when a color token is present", () => {
        expect(calculateStyle("bold", LIGHT)).toEqual({ fontWeight: "bold" });
        expect(calculateStyle("red bold", LIGHT)).toEqual({
            fontWeight: "bold",
            color: calculateColor("red", LIGHT),
        });
    });

    test("single-letter shorthands", () => {
        expect(calculateStyle("b i u", LIGHT)).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
            textDecorationLine: "underline",
        });
    });

    test("decorations accumulate and de-duplicate", () => {
        expect(calculateStyle("underline strike overline", LIGHT).textDecorationLine).toBe(
            "underline line-through overline",
        );
        expect(calculateStyle("u u", LIGHT).textDecorationLine).toBe("underline");
    });

    test("font-family shorthands", () => {
        expect(calculateStyle("mono", LIGHT).fontFamily).toBe("monospace");
        expect(calculateStyle("monospace", LIGHT).fontFamily).toBe("monospace");
        expect(calculateStyle("sans", LIGHT).fontFamily).toBe("sans-serif");
        expect(calculateStyle("serif", LIGHT).fontFamily).toBe("serif");
    });

    test("dim/faint set opacity", () => {
        expect(calculateStyle("dim", LIGHT)).toEqual({ opacity: "0.6" });
        expect(calculateStyle("faint", LIGHT)).toEqual({ opacity: "0.6" });
    });

    test("keywords are case-insensitive", () => {
        expect(calculateStyle("BOLD Italic", LIGHT)).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
        });
    });

    test("combines color grammar with styling", () => {
        const style = calculateStyle("purple bold i mono", LIGHT);
        expect(style).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
            fontFamily: "monospace",
            color: calculateColor("purple", LIGHT),
        });
    });

    test("standalone 's' is strike-through, 'S30' is saturation", () => {
        expect(calculateStyle("s", LIGHT).textDecorationLine).toBe("line-through");
        const withSat = calculateStyle("red S30", LIGHT);
        expect(withSat.textDecorationLine).toBeUndefined();
        expect(withSat.color).toBe(calculateColor("red S30", LIGHT));
    });

    test("unknown tokens still throw via the color parser", () => {
        expect(() => calculateStyle("bold chartreuse", LIGHT)).toThrow(/Unknown color name/);
    });
});

describe("styleToCss", () => {
    test("renders CSS declarations with kebab-case properties", () => {
        const css = styleToCss({
            color: "oklch(0.5 0.1 30)",
            fontWeight: "bold",
            textDecorationLine: "underline",
        });
        expect(css).toContain("color: oklch(0.5 0.1 30)");
        expect(css).toContain("font-weight: bold");
        expect(css).toContain("text-decoration-line: underline");
        expect(css.split("; ")).toHaveLength(3);
    });

    test("empty style renders an empty string", () => {
        expect(styleToCss({})).toBe("");
    });
});
