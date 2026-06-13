#!/usr/bin/env node

/**
 * Organize Qt documents in TOC.
 * This script adds the Qt parent document and its children to the TOC.
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

async function addToToc(baseUrl, token, bookId, nodeUuid, targetUuid, actionMode, docIds, action = 'editNode') {
  const url = `${baseUrl}/api/v2/repos/${bookId}/toc`;
  const payload = {
    action,
    action_mode: actionMode,
    node_uuid: nodeUuid,
    target_uuid: targetUuid,
    doc_ids: docIds,
  };

  const result = await request({ method: 'PUT', url, token, body: payload });
  return result;
}

async function main() {
  const baseUrl = process.env.YUQUE_BASE_URL || DEFAULT_BASE_URL;
  const token = process.env.YUQUE_TOKEN || process.env.YUQUE_AUTH_TOKEN;
  const bookId = 76359725;

  // Qt documents - parent and children
  const parentId = 266485599;  // Qt面试题
  const childIds = [
    266485600,  // Qt 基础概念详解
    266485601,  // Qt 信号与槽详解
    266485603,  // Qt 事件系统详解
    266485604,  // Qt 常用控件与布局详解
    266485605,  // Qt 模型/视图架构详解
    266485607,  // Qt 绘图与图形详解
    266485608,  // Qt 多线程详解
    266485609,  // Qt 网络编程详解
    266485610,  // Qt 数据库详解
    266485611,  // Qt 文件与数据详解
    266485612,  // Qt QML 与 Qt Quick 详解
    266485613,  // Qt 性能优化与工程实践详解
    266485614,  // Qt 面试题目大纲
    266485615,  // Qt 面试题详解 - 索引
  ];

  if (!token) {
    console.error('Error: Missing YUQUE_TOKEN');
    process.exit(1);
  }

  console.log('Fetching current TOC...');
  const toc = await getToc(baseUrl, token, bookId);

  // Check if parent is already in TOC
  const parentInToc = toc.find(item => item.id === parentId);
  if (parentInToc) {
    console.log(`Parent "${parentInToc.title}" already in TOC with uuid: ${parentInToc.uuid}`);
  } else {
    console.log(`Parent (ID: ${parentId}) not in TOC, adding it...`);

    // Find last root item
    const rootItems = toc.filter(item => !item.parent_uuid || item.parent_uuid === '');
    const lastItem = rootItems[rootItems.length - 1];
    console.log(`Last root item: "${lastItem.title}" (uuid: ${lastItem.uuid})`);

    // Add parent to TOC after last item
    console.log('\nAdding parent to TOC...');
    const result = await addToToc(baseUrl, token, bookId, 'new_node', lastItem.uuid, 'sibling', [parentId]);
    console.log('Result:', JSON.stringify(result, null, 2));

    if (!result.ok) {
      console.error('Failed to add parent to TOC');
      process.exit(1);
    }

    // Wait and re-fetch TOC
    await new Promise(r => setTimeout(r, 1000));
    console.log('\nRe-fetching TOC...');
    const newToc = await getToc(baseUrl, token, bookId);
    const newParent = newToc.find(item => item.id === parentId);
    if (newParent) {
      console.log(`Parent now in TOC: uuid = ${newParent.uuid}`);
    }

    // Now organize children
    await organizeChildren(baseUrl, token, bookId, newToc, parentId, childIds);
    return;
  }

  // Parent already in TOC, organize children
  await organizeChildren(baseUrl, token, bookId, toc, parentId, childIds);
}

async function organizeChildren(baseUrl, token, bookId, toc, parentId, childIds) {
  const parentItem = toc.find(item => item.id === parentId);
  if (!parentItem) {
    console.error('Parent not found in TOC');
    process.exit(1);
  }

  console.log(`\nOrganizing children under "${parentItem.title}"...`);

  // Find children in TOC
  const childItems = childIds.map(id => toc.find(item => item.id === id)).filter(Boolean);
  console.log(`Found ${childItems.length}/${childIds.length} children in TOC`);

  if (childItems.length === 0) {
    console.log('No children found in TOC, they need to be added first');
    // Add children to TOC
    let prevUuid = null;
    for (const childId of childIds) {
      console.log(`Adding child ${childId} to TOC...`);
      if (prevUuid) {
        const result = await addToToc(baseUrl, token, bookId, 'new_node', prevUuid, 'sibling', [childId]);
        console.log('Result:', JSON.stringify(result, null, 2));
      } else {
        // First child - add as child of parent
        const result = await addToToc(baseUrl, token, bookId, 'new_node', parentItem.uuid, 'child', [childId]);
        console.log('Result:', JSON.stringify(result, null, 2));
      }
      prevUuid = `doc_${childId}`; // Placeholder, we'll re-fetch

      await new Promise(r => setTimeout(r, 500));
    }

    // Re-fetch TOC to get actual UUIDs
    console.log('\nRe-fetching TOC to get child UUIDs...');
    await new Promise(r => setTimeout(r, 500));
    const newToc = await getToc(baseUrl, token, bookId);
    const newChildItems = childIds.map(id => newToc.find(item => item.id === id)).filter(Boolean);
    console.log(`Found ${newChildItems.length} children in updated TOC`);

    // Now move them under parent if needed
    const newParent = newToc.find(item => item.id === parentId);
    let prevChildUuid = null;
    for (const child of newChildItems) {
      console.log(`Moving "${child.title}" under parent...`);
      if (prevChildUuid) {
        await addToToc(baseUrl, token, bookId, child.uuid, prevChildUuid, 'sibling', [child.id]);
      } else {
        await addToToc(baseUrl, token, bookId, child.uuid, newParent.uuid, 'child', [child.id]);
      }
      prevChildUuid = child.uuid;
      await new Promise(r => setTimeout(r, 300));
    }
  } else {
    // Children already in TOC, reorganize them
    console.log('Children already in TOC, reorganizing...');

    let prevChildUuid = null;
    for (const child of childItems) {
      console.log(`Moving "${child.title}" under parent...`);
      if (prevChildUuid) {
        await addToToc(baseUrl, token, bookId, child.uuid, prevChildUuid, 'sibling', [child.id]);
      } else {
        await addToToc(baseUrl, token, bookId, child.uuid, parentItem.uuid, 'child', [child.id]);
      }
      prevChildUuid = child.uuid;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
