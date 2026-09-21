type Response = { redirect: (destination: string) => void };

/** Navigate to the destination supplied in an HTTP request. */
export const redirect = (request: Request, response: Response): void => {
  response.redirect(new URL(request.url).searchParams.get("next") ?? "/");
};
