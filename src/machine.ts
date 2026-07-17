
export interface MachineInterface<In, Out> {
    process(input: In): AsyncIterable<Out>;
    stream(source: AsyncIterable<In>): AsyncIterable<Out>;
}

export class Machine<In, Out> implements MachineInterface<In, Out> {
    async* process(input: In): AsyncIterable<Out> { }

    async* stream(source: AsyncIterable<In>) {
        for await (const input of source) {
            for await (const output of this.process(input)) {
                yield output as Out;
            }
        }
    }
}
