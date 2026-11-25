/** A greeter object whose method an event system can call without the object. */
export const greeter = {
  name: "guest",
  greet(): string {
    const self: { name: string } = this;
    return `Hello, ${self?.name ?? "stranger"}`;
  },
};

/** Calls each handler the way an event emitter does: as a plain function. */
export const fire = (handlers: ReadonlyArray<() => string>): string[] =>
  handlers.map((handler) => handler());
