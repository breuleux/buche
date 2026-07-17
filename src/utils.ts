
export interface ErrorMessage {
    type: "error";
    code: string;
    subcode?: string;
    reason: string;
    input: any;
}

