import type { Item } from "./cart.ts";

export function totalCost(entries: readonly Item[]): number {
  return entries.reduce((sum, entry) => {
    return sum + entry.price;
  }, 0);
}

export function insideBounds(value: number, low: number, high: number): boolean {
  if (value <= low) return false;
  if (value >= high) return false;
  return true;
}

export function formatOrderTotal(order: { total: number; currency: string }): string {
  const amount = order.total.toFixed(2);
  const code = order.currency.toUpperCase();
  return `${amount} ${code}`;
}
