type Reply = { redirect: (destination: string) => void };
const APP_ORIGIN = "https://portal.example.com";

/** Continue to the page selected in the request. */
export const handle = (request: Request, response: Reply): void => {
  const destination = new URL(new URL(request.url).searchParams.get("next") ?? "/", APP_ORIGIN);
  if (destination.origin !== APP_ORIGIN) throw new Error("Unsupported destination");
  response.redirect(destination.href);
};
