import assert from "node:assert";
import test from "node:test";
import { computeArea, computeTotal } from "../src/service";

test("computeTotal doubles each price", () => {
  assert.strictEqual(computeTotal([{ price: 2 }, { price: 3 }]), 10);
});

test("computeArea squares the side", () => {
  assert.strictEqual(computeArea(4), 16);
});
