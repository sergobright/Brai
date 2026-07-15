import test from "node:test";
import assert from "node:assert/strict";
import { expandPreservedTables, orderTablesByDependencies, tablesToReset } from "./copy-table-order.mjs";

test("schema copy preserves migration-owned catalogs while resetting runtime data", () => {
  const preservedTables = expandPreservedTables(
    new Set(["agents", "role_contracts", "role_statuses", "table_descriptions", "workflow_definitions"]),
    [
      { table: "role_contracts", referencedTable: "item_role_types" },
      { table: "role_contracts", referencedTable: "workflow_definitions" }
    ]
  );

  assert.deepEqual(
    tablesToReset(
      ["agents", "item_role_types", "item_roles", "role_statuses", "workflow_definitions", "workflow_executions"],
      preservedTables
    ),
    ["item_roles", "workflow_executions"]
  );
});

test("schema copy orders referenced tables before dependent tables", () => {
  const ordered = orderTablesByDependencies(
    ["items", "item_roles", "role_statuses"],
    {
      fallbackOrder: ["items", "item_roles", "role_statuses"],
      dependencies: [
        { table: "item_roles", referencedTable: "items" },
        { table: "item_roles", referencedTable: "role_statuses" }
      ]
    }
  );

  assert.deepEqual(ordered, ["items", "role_statuses", "item_roles"]);
});

test("schema copy rejects foreign-key cycles instead of choosing an invalid order", () => {
  assert.throws(
    () => orderTablesByDependencies(
      ["first", "second"],
      {
        dependencies: [
          { table: "first", referencedTable: "second" },
          { table: "second", referencedTable: "first" }
        ]
      }
    ),
    /cyclic foreign keys: first -> second -> first/
  );
});

test("schema copy orders a cycle through its initially deferred foreign key", () => {
  assert.deepEqual(
    orderTablesByDependencies(
      ["relations", "context_decisions"],
      {
        dependencies: [
          { table: "context_decisions", referencedTable: "relations", deferred: false },
          { table: "relations", referencedTable: "context_decisions", deferred: true }
        ]
      }
    ),
    ["relations", "context_decisions"]
  );
});
