const SERVICE_ORIGIN = "https://records.example.com";

/** Retrieve a resource selected by a request parameter. */
export const handle = (request: Request): Promise<Response> => {
  const destination = new URL(
    new URL(request.url).searchParams.get("target") ?? "",
    SERVICE_ORIGIN,
  );
  if (destination.origin !== SERVICE_ORIGIN) throw new Error("Unsupported destination");
  return fetch(destination.href, { redirect: "error" });
};
