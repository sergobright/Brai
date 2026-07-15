#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export function pruneCaddySiteBlocks(source, { managedMarker, sites }) {
  const targetSites = new Set(sites);
  const lines = source.split('\n');
  const keep = new Array(lines.length).fill(true);
  const removed = [];
  let inManagedBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(`# BEGIN ${managedMarker}`)) {
      inManagedBlock = true;
    }
    if (!inManagedBlock) {
      const header = parseTopLevelHeader(line);
      if (header.some((address) => targetSites.has(address))) {
        const end = findBlockEnd(lines, index);
        for (let removeIndex = index; removeIndex <= end; removeIndex += 1) {
          keep[removeIndex] = false;
        }
        removed.push(...header.filter((address) => targetSites.has(address)));
        index = end;
        continue;
      }
    }
    if (line.includes(`# END ${managedMarker}`)) {
      inManagedBlock = false;
    }
  }

  const output = removed.length === 0
    ? source
    : compactBlankRuns(lines.filter((_, index) => keep[index]).join('\n'));
  return { changed: output !== source, removed, output };
}

function parseTopLevelHeader(line) {
  const match = line.match(/^([^\s#({][^{]*)\{\s*(?:#.*)?$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function findBlockEnd(lines, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    depth += braceDelta(lines[index]);
    if (depth === 0) return index;
  }
  throw new Error(`Unterminated Caddyfile block at line ${startIndex + 1}`);
}

function braceDelta(line) {
  let delta = 0;
  for (const char of line) {
    if (char === '{') delta += 1;
    if (char === '}') delta -= 1;
  }
  return delta;
}

function compactBlankRuns(source) {
  return source.replace(/\n{3,}/g, '\n\n');
}

const directRun = import.meta.url === `file://${process.argv[1]}`;
if (directRun) {
  try {
    const { values } = parseArgs({
      options: {
        check: { type: 'boolean', default: false },
        file: { type: 'string' },
        'managed-marker': { type: 'string' },
        site: { type: 'string', multiple: true, default: [] }
      }
    });

    if (!values.file || !values['managed-marker'] || values.site.length === 0) {
      console.error('Usage: prune-caddy-site-blocks.mjs --file <Caddyfile> --managed-marker <marker> --site <address> [--site <address>...] [--check]');
      process.exit(2);
    }

    const source = readFileSync(values.file, 'utf8');
    const result = pruneCaddySiteBlocks(source, {
      managedMarker: values['managed-marker'],
      sites: values.site
    });
    if (result.changed && !values.check) {
      writeFileSync(values.file, result.output, 'utf8');
    }
    console.log(JSON.stringify({
      changed: result.changed,
      check: values.check,
      file: values.file,
      removed: result.removed
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
