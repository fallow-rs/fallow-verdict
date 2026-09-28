export type Item = { price: number };

export const sumPrices = (items: readonly Item[]): number => {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
};

export const withinRange = (value: number, min: number, max: number): boolean => {
  if (value < min) return false;
  if (value > max) return false;
  return true;
};

export const formatOrderDate = (order: { placedAt: Date }): string => {
  const day = String(order.placedAt.getDate()).padStart(2, "0");
  const month = String(order.placedAt.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${order.placedAt.getFullYear()}`;
};
