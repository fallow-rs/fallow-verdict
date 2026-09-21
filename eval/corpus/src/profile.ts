type Response = { redirect: (destination: string) => void };

/** Navigate to a local profile using an externally supplied account identifier. */
export const profile = (account: string, response: Response): void => {
  response.redirect(`/profiles/${encodeURIComponent(account)}`);
};
