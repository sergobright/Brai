export function tablesToReset(tables, preservedTables) {
  return tables.filter((table) => !preservedTables.has(table));
}

export function expandPreservedTables(preservedTables, dependencies) {
  const expanded = new Set(preservedTables);
  let changed = true;

  while (changed) {
    changed = false;
    for (const { table, referencedTable } of dependencies) {
      if (expanded.has(table) && !expanded.has(referencedTable)) {
        expanded.add(referencedTable);
        changed = true;
      }
    }
  }

  return expanded;
}

export function orderTablesByDependencies(tables, { dependencies = [], fallbackOrder = [] } = {}) {
  const uniqueTables = [...new Set(tables)];
  const tableSet = new Set(uniqueTables);
  const fallbackIndexes = new Map(fallbackOrder.map((table, index) => [table, index]));
  const compare = (left, right) => {
    const leftIndex = fallbackIndexes.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = fallbackIndexes.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.localeCompare(right);
  };
  const referencedTables = new Map(uniqueTables.map((table) => [table, new Set()]));

  for (const { table, referencedTable } of dependencies) {
    if (table !== referencedTable && tableSet.has(table) && tableSet.has(referencedTable)) {
      referencedTables.get(table).add(referencedTable);
    }
  }

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  const stack = [];

  const visit = (table) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      const cycleStart = stack.indexOf(table);
      const cycle = [...stack.slice(cycleStart), table].join(" -> ");
      throw new Error(`Cannot copy schema data with cyclic foreign keys: ${cycle}`);
    }

    visiting.add(table);
    stack.push(table);
    for (const referencedTable of [...referencedTables.get(table)].sort(compare)) {
      visit(referencedTable);
    }
    stack.pop();
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };

  for (const table of uniqueTables.sort(compare)) visit(table);
  return ordered;
}
