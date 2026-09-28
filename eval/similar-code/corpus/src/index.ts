import { formatOrderDate, sumPrices, withinRange } from "./cart.ts";
import { formatOrderTotal, insideBounds, totalCost } from "./checkout.ts";
import { isEmptyString, parseUserAgent, tidyNames } from "./labels.ts";
import { isBlankText, normalizeTags, parseUserId } from "./text.ts";

export const exercise = (): unknown[] => [
  sumPrices([{ price: 1 }]),
  totalCost([{ price: 1 }]),
  withinRange(1, 0, 2),
  insideBounds(1, 0, 2),
  formatOrderDate({ placedAt: new Date(0) }),
  formatOrderTotal({ total: 1, currency: "eur" }),
  isBlankText(" "),
  isEmptyString(" "),
  normalizeTags([" A "]),
  tidyNames([" B "]),
  parseUserId("7"),
  parseUserAgent("Firefox/1.0"),
];
