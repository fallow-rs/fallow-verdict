/** A counter whose read method a caller can pass around as a plain function. */
export class Counter {
  value = 0;

  increment(): void {
    this.value += 1;
  }

  read(): number | undefined {
    return this?.value;
  }
}

/** Reads each counter through a detached method, so `this` is undefined in strict mode. */
export const readAll = (readers: ReadonlyArray<() => number | undefined>): (number | undefined)[] =>
  readers.map((read) => read());
