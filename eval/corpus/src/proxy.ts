/** Fetch the destination supplied in an HTTP request. */
export const proxy = (request: Request): Promise<Response> =>
  fetch(new URL(request.url).searchParams.get("destination") ?? "");
