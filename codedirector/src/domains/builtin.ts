/**
 * The domains that ship with Code Director, in registration order.
 *
 * The only file outside src/domains/ allowed to know these exist is the
 * registry that composes them (test/domains.test.ts enforces it). Order is
 * observable: where contributions are listed — dependency manifests in a
 * draft's deny list, toolchains in a coverage message — Node's come first.
 */

import type { Domain } from "../domain/types";
import { appleDomain } from "./apple";
import { nodeDomain } from "./node";

export function builtinDomains(): Domain[] {
  return [nodeDomain, appleDomain];
}
