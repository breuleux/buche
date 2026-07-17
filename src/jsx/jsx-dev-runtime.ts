// Development entry point for the automatic runtime.
//
// This forwards to the real DOM factory and ignores the extra debug arguments
// (key, isStaticChildren, source, self).

import { jsx } from "./jsx-runtime.ts";

export type { Child, JSX } from "./jsx-runtime.ts";
export { Fragment } from "./jsx-runtime.ts";

type Props = Parameters<typeof jsx>[1];

export function jsxDEV(
    type: Parameters<typeof jsx>[0],
    props: Props,
    _key?: unknown,
    _isStaticChildren?: boolean,
    _source?: unknown,
    _self?: unknown,
): Node {
    return jsx(type, props);
}
