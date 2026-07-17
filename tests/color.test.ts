import { describe, expect, test } from "vitest";
import {
    // type Anchors,
    // calculateColor,
    // calculateStyle,
    // coordsToCss,
    // parseColor,
    styleToCss,
    Theme,
    defaultTheme as th,
} from "../src/color.ts";

// const LIGHT: Anchors = { bg: 0.93, fg: 0.2 };
// const DARK: Anchors = { bg: 0.22, fg: 0.95 };

const lth = new Theme({ bgLum: 0.93, fgLum: 0.2 });
const dth = new Theme({ bgLum: 0.22, fgLum: 0.95 });
const dth2 = new Theme({ bgLum: 0.2, fgLum: 0.9 });
const eth = new Theme({ bgLum: 0.5, fgLum: 0.5 });

describe("parseColor — channels", () => {
    test("defaults when nothing is specified", () => {
        expect(th.parse("")).toEqual({ h: 0, s: 60, l: 60 });
    });

    test("absolute channels set coordinates", () => {
        expect(th.parse("H120 S40 L80")).toEqual({ h: 120, s: 40, l: 80 });
    });

    test("relative channels nudge from the current value", () => {
        expect(th.parse("L+10")).toMatchObject({ l: 70 });
        expect(th.parse("L-20")).toMatchObject({ l: 40 });
        expect(th.parse("S-30")).toMatchObject({ s: 30 });
    });

    test("channels apply in order (absolute then relative)", () => {
        expect(th.parse("L50 L+5")).toMatchObject({ l: 55 });
        // Absolute after relative wins.
        expect(th.parse("L+5 L50")).toMatchObject({ l: 50 });
    });

    test("hue wraps into [0, 360)", () => {
        expect(th.parse("H400").h).toBeCloseTo(40, 6);
        expect(th.parse("H-30").h).toBeCloseTo(330, 6);
    });

    test("saturation and luminosity clamp to [0, 100]", () => {
        expect(th.parse("S200")).toMatchObject({ s: 100 });
        expect(th.parse("S-200")).toMatchObject({ s: 0 });
        expect(th.parse("L500")).toMatchObject({ l: 100 });
        expect(th.parse("L-500")).toMatchObject({ l: 0 });
    });

    test("decimals are accepted", () => {
        expect(th.parse("H12.5").h).toBeCloseTo(12.5, 6);
    });
});

describe("parseColor — named colors", () => {
    test("a name sets hue and saturation but keeps default luminosity", () => {
        expect(th.parse("red")).toEqual({ h: 29, s: 95, l: 60 });
    });

    test("gray is achromatic and does not skew hue", () => {
        expect(th.parse("gray")).toEqual({ h: 0, s: 0, l: 60 });
        // gray contributes brightness/saturation but no hue direction
        expect(th.parse("blue gray").h).toBeCloseTo(255, 6);
    });

    test("channels override a named color's hue/saturation", () => {
        expect(th.parse("red H200 S10")).toMatchObject({ h: 200, s: 10 });
    });

    test("unknown names throw", () => {
        expect(() => th.parse("chartreuse")).toThrow(/Unknown color name/);
    });
});

describe("parseColor — mixing", () => {
    test("equal-weight midpoint of two hues", () => {
        // blue (255) and indigo (275) share saturation, so the mean is 265.
        expect(th.parse("blue indigo").h).toBeCloseTo(265, 4);
    });

    test("saturation is a weighted mean", () => {
        // blue s88, indigo s88 → 88
        expect(th.parse("blue indigo").s).toBeCloseTo(88, 6);
    });

    test("hue averaging wraps around 360 rather than through 180", () => {
        // red (~29) + pink (~350): the circular mean sits near 0, NOT near 190.
        const h = th.parse("red pink").h;
        expect(h > 340 || h < 40).toBe(true);
    });

    test("numeric suffix weights a color in the mix", () => {
        const even = th.parse("orange red").h;
        const heavy = th.parse("orange4 red").h;
        // Weighting orange more pulls the hue toward orange (60) vs red (29).
        expect(heavy).toBeGreaterThan(even);
        expect(heavy).toBeLessThan(60);
        // Saturation is also weighted: (90*4 + 95*1) / 5 = 91.
        expect(th.parse("orange4 red").s).toBeCloseTo(91, 6);
    });
});

describe("parseColor — case insensitivity", () => {
    test("channel letters are case-insensitive", () => {
        expect(th.parse("h120 s40 l80")).toEqual(th.parse("H120 S40 L80"));
        expect(th.parse("l+10")).toEqual(th.parse("L+10"));
    });

    test("color names are case-insensitive", () => {
        expect(th.parse("RED")).toEqual(th.parse("red"));
        expect(th.parse("Blue Indigo")).toEqual(th.parse("blue indigo"));
    });
});

describe("calculateColor / coordsToCss", () => {
    test("L0 lands on the background anchor, L100 on the foreground", () => {
        expect(lth.calculateColor("S0 L0")).toBe("oklch(0.93 0 0)");
        expect(lth.calculateColor("S0 L100")).toBe("oklch(0.2 0 0)");
        expect(dth.calculateColor("S0 L0")).toBe("oklch(0.22 0 0)");
        expect(dth.calculateColor("S0 L100")).toBe("oklch(0.95 0 0)");
    });

    test("luminosity interpolates linearly between the anchors", () => {
        // halfway between 0.2 and 0.9
        expect(dth2.calculateColor("S0 L50")).toBe("oklch(0.55 0 0)");
    });

    test("saturation maps to chroma (S100 → MAX_CHROMA 0.35)", () => {
        expect(eth.calculateColor("H0 S100 L0")).toBe("oklch(0.5 0.35 0)");
        expect(eth.calculateColor("H0 S50 L0")).toBe("oklch(0.5 0.175 0)");
    });

    test("the same color reads darker/lighter depending on the surface", () => {
        expect(dth2.calculateColor("red L0")).toBe("oklch(0.2 0.3325 29)");
        expect(lth.coordsToCss(th.parse("red"))).toBe(lth.calculateColor("red"));
    });
});

describe("calculateStyle", () => {
    test("color is only set when a color token is present", () => {
        expect(lth.calculateStyle("bold")).toEqual({ fontWeight: "bold" });
        expect(lth.calculateStyle("red bold")).toEqual({
            fontWeight: "bold",
            color: lth.calculateColor("red"),
        });
    });

    test("single-letter shorthands", () => {
        expect(lth.calculateStyle("b i u")).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
            textDecorationLine: "underline",
        });
    });

    test("decorations accumulate and de-duplicate", () => {
        expect(lth.calculateStyle("underline strike overline").textDecorationLine).toBe(
            "underline line-through overline",
        );
        expect(lth.calculateStyle("u u").textDecorationLine).toBe("underline");
    });

    test("font-family shorthands", () => {
        expect(lth.calculateStyle("mono").fontFamily).toBe("monospace");
        expect(lth.calculateStyle("monospace").fontFamily).toBe("monospace");
        expect(lth.calculateStyle("sans").fontFamily).toBe("sans-serif");
        expect(lth.calculateStyle("serif").fontFamily).toBe("serif");
    });

    test("dim/faint set opacity", () => {
        expect(lth.calculateStyle("dim")).toEqual({ opacity: "0.6" });
        expect(lth.calculateStyle("faint")).toEqual({ opacity: "0.6" });
    });

    test("keywords are case-insensitive", () => {
        expect(lth.calculateStyle("BOLD Italic")).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
        });
    });

    test("combines color grammar with styling", () => {
        const style = lth.calculateStyle("purple bold i mono");
        expect(style).toEqual({
            fontWeight: "bold",
            fontStyle: "italic",
            fontFamily: "monospace",
            color: lth.calculateColor("purple"),
        });
    });

    test("standalone 's' is strike-through, 'S30' is saturation", () => {
        expect(lth.calculateStyle("s").textDecorationLine).toBe("line-through");
        const withSat = lth.calculateStyle("red S30");
        expect(withSat.textDecorationLine).toBeUndefined();
        expect(withSat.color).toBe(lth.calculateColor("red S30"));
    });

    test("unknown tokens still throw via the color parser", () => {
        expect(() => lth.calculateStyle("bold chartreuse")).toThrow(/Unknown color name/);
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
