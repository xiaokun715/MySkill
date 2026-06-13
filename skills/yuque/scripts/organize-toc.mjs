#!/usr/bin/env node

/**
 * Organize TOC for uploaded documents.
 * This script reads the TOC, finds documents by title prefix, and organizes them into a tree structure.
 *
 * Usage:
 *   node organize-toc.mjs --book-id 76359725 --parent-title "Qt面试题" --child-prefixes "Qt 基础概念,Qt 信号与槽" --execute
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, request, getToken, getBaseUrl, executeFlag, printUsage } from './common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(SKILL_ROOT, '.env');

// Load env file
function loadEnvFile(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) continue;
      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (e) {
    // Ignore if file doesn't exist
  }
}

loadEnvFile(DEFAULT_ENV_PATH);

async function getToc(baseUrl, token, bookId) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const result = await request({ method: 'GET', url, token });
  if (!result.ok) {
    throw new Error(`Failed to get TOC: ${JSON.stringify(result.data)}`);
  }
  return result.data.data;
}

async function moveNode(baseUrl, token, bookId, nodeUuid, targetUuid, actionMode, docId, prepend = false) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const payload = {
    action: prepend ? 'prependNode' : 'editNode',
    action_mode: actionMode,
    node_uuid: nodeUuid,
    target_uuid: targetUuid,
  };
  if (docId) {
    payload.doc_ids = [docId];
  }

  const result = await request({ method: 'PUT', url, token, body: payload });
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args['book-id'] || !args['parent-title']) {
    printUsage([
      'Organize TOC for uploaded documents.',
      '',
      'Usage:',
      '  node organize-toc.mjs --book-id 76359725 --parent-title "Qt面试题" --execute',
      '',
      'Options:',
      '  --book-id        Yuque book ID (required)',
      '  --parent-title   Title of the parent document (required)',
      '  --execute        Actually execute the organization (default: dry run)',
    ]);
    process.exit(0);
  }

  const baseUrl = getBaseUrl(args);
  const token = getToken(args);
  const bookId = args['book-id'];
  const parentTitle = args['parent-title'];
  const execute = executeFlag(args);

  if (!token) {
    console.error('Error: Missing YUQUE_TOKEN');
    process.exit(1);
  }

  console.log('Fetching TOC...');
  const toc = await getToc(baseUrl, token, bookId);

  // Find parent node
  const parentNode = toc.find(item => item.title === parentTitle);
  if (!parentNode) {
    console.error(`Parent document "${parentTitle}" not found in TOC`);
    process.exit(1);
  }
  console.log(`Found parent: "${parentNode.title}" (uuid: ${parentNode.uuid})`);

  // Find child nodes (documents that start with parent title prefix)
  const childPrefix = parentTitle.replace(/面试题$/, '').trim();
  const childNodes = toc.filter(item =>
    item.title !== parentTitle &&
    item.title.startsWith(childPrefix) &&
    item.parent_uuid === '' // Only root-level items
  );

  console.log(`Found ${childNodes.length} child documents to organize:`);
  for (const child of childNodes) {
    console.log(`  - ${child.title}`);
  }

  if (!execute) {
    console.log('\n[DRY RUN] Would organize these documents under parent.');
    console.log('Pass --execute to actually organize.');
    return;
  }

  // Find the last root-level item to place parent after
  const rootItems = toc.filter(item => !item.parent_uuid || item.parent_uuid === '');
  const lastRootItem = rootItems[rootItems.length - 1];

  // Move parent to end of TOC if not already there
  if (parentNode.uuid !== lastRootItem.uuid) {
    console.log(`\nMoving parent to end of TOC...`);
    await moveNode(baseUrl, token, bookId, parentNode.uuid, lastRootItem.uuid, 'sibling', parentNode.id);
    await new Promise(r => setTimeout(r, 500));
  }

  // Move each child under parent
  let prevChildUuid = null;
  for (const child of childNodes) {
    console.log(`Moving child: ${child.title}`);

    if (prevChildUuid) {
      await moveNode(baseUrl, token, bookId, child.uuid, prevChildUuid, 'sibling', child.id);
    } else {
      await moveNode(baseUrl, token, bookId, child.uuid, parentNode.uuid, 'child', child.id);
    }

    prevChildUuid = child.uuid;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nTOC organization complete!');
}

main().catch(console.error);
