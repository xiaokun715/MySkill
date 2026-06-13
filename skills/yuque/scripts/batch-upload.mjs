#!/usr/bin/env node

/**
 * Batch upload local markdown files to Yuque as a nested document structure.
 *
 * Usage:
 *   node batch-upload.mjs --book-id 76359725 --parent-title "Qt面试题" --dir "./qt" --execute
 *
 * The script will:
 * 1. Create a parent document with the given title
 * 2. Create all child documents from the directory
 * 3. Arrange child documents under the parent in TOC
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(SKILL_ROOT, '.env');

async function loadEnvFile(envPath) {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(envPath, 'utf8');
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
    console.log('Could not load env file:', e.message);
  }
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

async function createDoc(baseUrl, token, bookId, title, body, slug) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/docs`;
  const payload = {
    title,
    body,
    format: 'markdown',
  };
  // Only set slug if it matches the required format: /^[\w\-\.]{2,190}$/
  if (slug && /^[\w\-\.]{2,190}$/.test(slug)) {
    payload.slug = slug;
  }

  const result = await request({ method: 'POST', url, token, body: payload });
  if (!result.ok) {
    console.error(`Failed to create doc "${title}":`, JSON.stringify(result.data, null, 2));
    return null;
  }
  return result.data.data;
}

async function getToc(baseUrl, token, bookId) {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const result = await request({ method: 'GET', url, token });
  if (!result.ok) {
    console.error('Failed to get TOC:', JSON.stringify(result.data, null, 2));
    return null;
  }
  return result.data.data;
}

async function moveTocNode(baseUrl, token, bookId, nodeUuid, targetUuid, actionMode, docId, prepend = false) {
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
  if (!result.ok) {
    console.error('Failed to move TOC node:', JSON.stringify(result.data, null, 2));
    return false;
  }
  return true;
}

async function getLastTocItem(toc) {
  // Find the last root-level item
  const rootItems = toc.filter(item => !item.parent_uuid || item.parent_uuid === '');
  return rootItems[rootItems.length - 1];
}

async function main() {
  // Load environment variables first
  await loadEnvFile(DEFAULT_ENV_PATH);

  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args['book-id'] || !args['parent-title'] || !args.dir) {
    console.log(`
Usage:
  node batch-upload.mjs --book-id 76359725 --parent-title "Qt面试题" --dir "./qt" [--execute]

Options:
  --book-id        Yuque book ID (required)
  --parent-title   Title for the parent document (required)
  --dir            Directory containing markdown files (required)
  --slug-prefix    Optional slug prefix for all documents
  --execute        Actually execute the upload (default: dry run)
`);
    process.exit(0);
  }

  const baseUrl = process.env.YUQUE_BASE_URL || 'https://www.yuque.com';
  const token = args.token || process.env.YUQUE_TOKEN || process.env.YUQUE_AUTH_TOKEN;
  const bookId = args['book-id'];
  const parentTitle = args['parent-title'];
  const dirPath = path.resolve(args.dir);
  const slugPrefix = args['slug-prefix'] || '';
  const execute = args.execute === true;

  if (!token) {
    console.error('Error: Missing YUQUE_TOKEN');
    process.exit(1);
  }

  // Read all markdown files from the directory
  let files;
  try {
    files = await fs.readdir(dirPath);
  } catch (e) {
    console.error(`Error reading directory ${dirPath}:`, e.message);
    process.exit(1);
  }

  const mdFiles = files
    .filter(f => f.endsWith('.md'))
    .sort((a, b) => {
      // Sort by number prefix if exists
      const numA = parseInt(a.match(/^(\d+)/)?.[1] || '999');
      const numB = parseInt(b.match(/^(\d+)/)?.[1] || '999');
      return numA - numB;
    });

  console.log(`Found ${mdFiles.length} markdown files in ${dirPath}`);

  if (!execute) {
    console.log('\n[DRY RUN] Would create:');
    console.log(`  Parent: ${parentTitle}`);
    for (const f of mdFiles) {
      const title = f.replace('.md', '').replace(/^\d+[_-]?\s*/, '').replace(/_/g, ' ');
      console.log(`    - ${title}`);
    }
    console.log('\nPass --execute to actually upload.');
    return;
  }

  // Step 1: Get current TOC to find where to place the new parent
  console.log('\nFetching current TOC...');
  const toc = await getToc(baseUrl, token, bookId);
  const lastItem = await getLastTocItem(toc);

  // Step 2: Create parent document
  console.log(`\nCreating parent document: ${parentTitle}`);
  const parentDoc = await createDoc(
    baseUrl,
    token,
    bookId,
    parentTitle,
    `# ${parentTitle}\n\n本文档包含以下内容：\n\n${mdFiles.map(f => {
      const title = f.replace('.md', '').replace(/^\d+[_-]?\s*/, '').replace(/_/g, ' ');
      return `- ${title}`;
    }).join('\n')}`,
    slugPrefix + parentTitle.toLowerCase().replace(/\s+/g, '-')
  );

  if (!parentDoc) {
    console.error('Failed to create parent document, aborting.');
    process.exit(1);
  }
  console.log(`Created parent doc: ID=${parentDoc.id}, slug=${parentDoc.slug}`);

  // Wait a bit for Yuque to process
  await new Promise(r => setTimeout(r, 500));

  // Step 3: Move parent to the end of TOC (after last existing item)
  if (lastItem) {
    console.log(`Moving parent to after "${lastItem.title}" in TOC...`);
    await moveTocNode(baseUrl, token, bookId, parentDoc.uuid, lastItem.uuid, 'sibling', parentDoc.id);
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 4: Create child documents
  let prevChildUuid = null;
  for (const f of mdFiles) {
    const filePath = path.join(dirPath, f);
    const content = await fs.readFile(filePath, 'utf8');

    // Generate title from filename
    let title = f.replace('.md', '').replace(/^\d+[_-]?\s*/, '').replace(/_/g, ' ');

    // Extract title from content if it starts with #
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith('# ')) {
      title = firstLine.slice(2).trim();
    }

    console.log(`Creating child document: ${title}`);
    const childDoc = await createDoc(
      baseUrl,
      token,
      bookId,
      title,
      content,
      slugPrefix + f.replace('.md', '').toLowerCase().replace(/_/g, '-')
    );

    if (!childDoc) {
      console.error(`Failed to create child document: ${title}`);
      continue;
    }

    await new Promise(r => setTimeout(r, 300));

    // Move child under parent
    if (prevChildUuid) {
      // Add as sibling after previous child
      await moveTocNode(baseUrl, token, bookId, childDoc.uuid, prevChildUuid, 'sibling', childDoc.id);
    } else {
      // First child - add as child of parent
      await moveTocNode(baseUrl, token, bookId, childDoc.uuid, parentDoc.uuid, 'child', childDoc.id);
    }

    prevChildUuid = childDoc.uuid;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nUpload complete!');
}

main().catch(console.error);