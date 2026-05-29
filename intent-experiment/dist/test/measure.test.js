"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const node_test_1 = __importDefault(require("node:test"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const measure_1 = require("../src/measure");
(0, node_test_1.default)("matchPath: exact, star, double-star", () => {
    node_assert_1.default.ok((0, measure_1.matchPath)("src/a.ts", "src/a.ts"));
    node_assert_1.default.ok(!(0, measure_1.matchPath)("src/a.ts", "src/b.ts"));
    node_assert_1.default.ok((0, measure_1.matchPath)("src/*.ts", "src/a.ts"));
    node_assert_1.default.ok(!(0, measure_1.matchPath)("src/*.ts", "src/deep/a.ts"));
    node_assert_1.default.ok((0, measure_1.matchPath)("src/**", "src/deep/a.ts"));
    node_assert_1.default.ok((0, measure_1.matchPath)("**/*.ts", "src/deep/a.ts"));
});
(0, node_test_1.default)("isTestHelper: test paths are helpers", () => {
    node_assert_1.default.ok((0, measure_1.isTestHelper)("test/foo.test.ts"));
    node_assert_1.default.ok((0, measure_1.isTestHelper)("src/__tests__/x.ts"));
    node_assert_1.default.ok((0, measure_1.isTestHelper)("src/x.test.ts"));
    node_assert_1.default.ok(!(0, measure_1.isTestHelper)("src/x.ts"));
});
(0, node_test_1.default)("unintendedChanges: files outside must_change minus test helpers", () => {
    const changed = ["src/slider.ts", "src/export.ts", "test/new.test.ts", "README.md"];
    const out = (0, measure_1.unintendedChanges)(changed, ["src/slider.ts", "README.md"]);
    node_assert_1.default.deepStrictEqual(out, ["src/export.ts"]);
});
(0, node_test_1.default)("runChecks executes shell commands and records exit codes", async () => {
    const dir = await node_fs_1.promises.mkdtemp(node_path_1.default.join((0, node_os_1.tmpdir)(), "checks-"));
    const results = await (0, measure_1.runChecks)(dir, ["exit 0", "exit 3", "echo hi"]);
    node_assert_1.default.strictEqual(results.length, 3);
    node_assert_1.default.strictEqual(results[0].exitCode, 0);
    node_assert_1.default.strictEqual(results[1].exitCode, 3);
    node_assert_1.default.strictEqual(results[2].exitCode, 0);
    node_assert_1.default.ok(results[2].outputTail.includes("hi"));
    node_assert_1.default.strictEqual((0, measure_1.checksPass)(results), false);
    node_assert_1.default.strictEqual((0, measure_1.checksPass)([results[0], results[2]]), true);
    node_assert_1.default.strictEqual((0, measure_1.checksPass)([]), false);
});
(0, node_test_1.default)("mechanicalProxy: checks pass AND zero unintended", () => {
    node_assert_1.default.strictEqual((0, measure_1.mechanicalProxy)([{ command: "x", exitCode: 0, outputTail: "" }], []), true);
    node_assert_1.default.strictEqual((0, measure_1.mechanicalProxy)([{ command: "x", exitCode: 0, outputTail: "" }], ["src/x.ts"]), false);
    node_assert_1.default.strictEqual((0, measure_1.mechanicalProxy)([{ command: "x", exitCode: 1, outputTail: "" }], []), false);
});
