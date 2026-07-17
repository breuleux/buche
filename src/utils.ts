
var _CURRENT_ID = 0;

export function resetId(n: number = 0) {
    _CURRENT_ID = n;
}

export class IdClass {
    _id: number;

    constructor() {
        this._id = _CURRENT_ID++;
    }

    toJSON() {
        return `#${this._id}`;
    }
}

export interface ErrorMessage {
    type: "error";
    code: string;
    subcode?: string;
    reason: string;
    input?: any;
}

export class BucheError extends Error {
    errorData: ErrorMessage;

    constructor(errorData: ErrorMessage) {
        super(errorData.reason);
        this.errorData = errorData;
    }
}
