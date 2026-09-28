/**
 * A small glob matcher for project-relative POSIX paths. It supports `**`, `*`, `?` and `{a,b}`.
 * `path.matchesGlob` is experimental on the Node versions that this package supports.
 */
const SPECIAL = /[.+^$()|[\]\\]/;

const toRegExpSource = (glob: string): string => {
  let source = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        // `**/` matches zero or more directories; a trailing `**` matches the rest of the path.
        source += slash ? "(?:[^/]*/)*" : ".*";
        index += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      braces += 1;
      source += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (char === "," && braces > 0) source += "|";
    else source += SPECIAL.test(char) ? `\\${char}` : char;
  }
  return source;
};

export const globMatcher = (globs: string | readonly string[]): ((file: string) => boolean) => {
  const patterns = (typeof globs === "string" ? [globs] : globs).map(
    (glob) => new RegExp(`^${toRegExpSource(glob.replace(/^\.\//, ""))}$`),
  );
  return (file) => patterns.some((pattern) => pattern.test(file));
};
