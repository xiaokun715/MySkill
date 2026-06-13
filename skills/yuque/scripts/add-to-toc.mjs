#!/usr/bin/env node

/**
 * Add documents to TOC and organize them into a tree structure.
 * This script reads the doc list, finds documents by ID range, and organizes them into TOC.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'https://www.yuque.com';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(SKILL_ROOT, '.env');

loadEnvFile(DEFAULT_ENV_PATH);

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
  } catch (e) {}
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

async function request({ method, url, token, body }) {
  const headers = {
    'Accept': 'application/json',
    'X-Auth-Token': token,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, ok: response.ok, data };
}

async function getToc(baseUrl, token, bookId) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const result = await request({ method: 'GET', url, token });
  if (!result.ok) throw new Error(`Failed to get TOC: ${JSON.stringify(result.data)}`);
  return result.data.data;
}

async function listDocs(baseUrl, token, bookId) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/docs`;
  const result = await request({ method: 'GET', url, token });
  if (!result.ok) throw new Error(`Failed to list docs: ${JSON.stringify(result.data)}`);
  return result.data.data;
}

async function addToToc(baseUrl, token, bookId, nodeUuid, targetUuid, actionMode, docIds, prepend = false) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const payload = {
    action: prepend ? 'prependNode' : 'editNode',
    action_mode: actionMode,
    node_uuid: nodeUuid,
    target_uuid: targetUuid,
    doc_ids: docIds,
  };

  const result = await request({ method: 'PUT', url, token, body: payload });
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args['book-id'] || !args['parent-id']) {
    console.log(`
Usage:
  node add-to-toc.mjs --book-id 76359725 --parent-id 266485599 --child-ids "266485601,266485603" [--execute]

Options:
  --book-id      Yuque book ID (required)
  --parent-id    Parent document ID (required)
  --child-ids    Comma-separated child document IDs (required)
  --execute      Actually execute (default: dry run)
`);
    process.exit(0);
  }

  const baseUrl = process.env.YUQUE_BASE_URL || DEFAULT_BASE_URL;
  const token = process.env.YUQUE_TOKEN || process.env.YUQUE_AUTH_TOKEN;
  const bookId = args['book-id'];
  const parentId = parseInt(args['parent-id']);
  const childIds = args['child-ids'].split(',').map(id => parseInt(id.trim()));
  const execute = args.execute === true;

  if (!token) {
    console.error('Error: Missing YUQUE_TOKEN');
    process.exit(1);
  }

  console.log('Fetching TOC...');
  const toc = await getToc(baseUrl, token, bookId);

  // Get parent uuid from TOC
  const parentItem = toc.find(item => item.id === parentId);
  if (!parentItem) {
    console.log(`Parent (ID: ${parentId}) not found in TOC, need to add it first`);

    // Find last root item
    const rootItems = toc.filter(item => !item.parent_uuid || item.parent_uuid === '');
    const lastItem = rootItems[rootItems.length - 1];

    console.log(`Last root item: "${lastItem.title}" (uuid: ${lastItem.uuid})`);

    if (!execute) {
      console.log('\n[DRY RUN] Would add parent to TOC');
      return;
    }

    // Generate a temporary uuid for the new node
    // The API requires a node_uuid, but for new nodes we need to use a specific approach
    console.log('\nAdding parent to TOC...');
    const result = await addToToc(baseUrl, token, bookId, 'new_node', lastItem.uuid, 'sibling', [parentId]);
    console.log('Result:', JSON.stringify(result, null, 2));

    // Wait and re-fetch TOC
    await new Promise(r => setTimeout(r, 1000));
    console.log('\nRe-fetching TOC...');
    const newToc = await getToc(baseUrl, token, bookId);
    const newParent = newToc.find(item => item.id === parentId);
    if (newParent) {
      console.log(`Parent now in TOC: uuid = ${newParent.uuid}`);
    }
    return;
  }

  console.log(`Found parent in TOC: "${parentItem.title}" (uuid: ${parentItem.uuid})`);

  // Find child uuids
  const childItems = childIds.map(id => toc.find(item => item.id === id)).filter(Boolean);
  console.log(`Found ${childItems.length}/${childIds.length} children in TOC`);

  if (!execute) {
    console.log('\n[DRY RUN] Would organize these documents');
    return;
  }

  // Add children to parent
  let prevUuid = null;
  for (const child of childItems) {
    console.log(`Moving "${child.title}" under parent...`);
    if (prevUuid) {
      await addToToc(baseUrl, token, bookId, child.uuid, prevUuid, 'sibling', [child.id]);
    } else {
      await addToToc(baseUrl, token, bookId, child.uuid, parentItem.uuid, 'child', [child.id]);
    }
    prevUuid = child.uuid;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nDone!');
}

main().catch(console.error);
