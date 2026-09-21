/** Fetch a record by its externally supplied identifier. */
export const lookup = (identifier: string): Promise<Response> =>
  fetch(`https://api.example.com/records/${encodeURIComponent(identifier)}`, { redirect: "error" });
