type Reply = { redirect: (destination: string) => void };

/** Continue to the page selected in the request. */
export const handle = (request: Request, response: Reply): void => {
  const destination = new URL(request.url).searchParams.get("next") ?? "/";
  if (!destination.startsWith("/")) throw new Error("Unsupported destination");
  response.redirect(destination);
};
