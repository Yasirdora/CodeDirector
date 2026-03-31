import { double, square } from "./math";

export interface Item {
  price: number;
}

export function computeTotal(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += double(item.price);
  }
  return total;
}

export function computeArea(side: number): number {
  return square(side);
}

export class Service {
  run(items: Item[]): number {
    return computeTotal(items);
  }
}
